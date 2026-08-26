import assert from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import tls from "node:tls";

const require = createRequire(import.meta.url);
const SmtpClient = require("../lib/SmtpClient.js");

// Self-signed cert for localhost, used to exercise the STARTTLS upgrade.
// Generated on the fly into a per-run temp dir so the suite is self-contained
// (no external `openssl ...` prerequisite, no shared /tmp files that race
// with parallel runs). Falls back to /tmp/smtp-test-*.pem if present so the
// previous manual workflow still works.
let KEY;
let CERT;
let certDir;

before(() => {
  const fallbackKey = "/tmp/smtp-test-key.pem";
  const fallbackCert = "/tmp/smtp-test-cert.pem";
  if (existsSync(fallbackKey) && existsSync(fallbackCert)) {
    KEY = readFileSync(fallbackKey);
    CERT = readFileSync(fallbackCert);
    return;
  }
  certDir = mkdtempSync(path.join(os.tmpdir(), "smtp-test-"));
  const keyPath = path.join(certDir, "key.pem");
  const certPath = path.join(certDir, "cert.pem");
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes ` +
      `-keyout "${keyPath}" -out "${certPath}" ` +
      `-days 1 -subj "/CN=localhost"`,
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  KEY = readFileSync(keyPath);
  CERT = readFileSync(certPath);
});

after(() => {
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

/**
 * Minimal mock SMTP server. Captures the full conversation and the message
 * body so tests can assert what SmtpClient actually sent. Supports optional
 * STARTTLS upgrade.
 *
 * Commands are answered with fixed success codes; STARTTLS and DATA are the
 * only stateful commands. The server records every line it receives.
 */
function startMockServer({ starttls = false, authRequired = true } = {}) {
  const received = [];
  let dataBody = null;
  let collectingData = false;
  const server = net.createServer((socket) => {
    socket.write("220 mock.example ESMTP ready\r\n");
    // After STARTTLS, responses must go to the TLS socket (writing to the raw
    // socket would send plaintext that the client reads as garbage TLS records).
    let writeTarget = socket;
    const handleLine = (line) => {
      if (collectingData) {
        dataBody.push(line);
        if (line === ".") {
          collectingData = false;
          writeTarget.write("250 OK: queued\r\n");
        }
        return;
      }
      received.push(line);
      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO")) {
        const caps = ["250-mock.example", "250-SIZE 52428800"];
        if (starttls) caps.push("250-STARTTLS");
        if (authRequired) caps.push("250-AUTH PLAIN LOGIN");
        caps.push("250 HELP");
        writeTarget.write(`${caps.join("\r\n")}\r\n`);
        return;
      }
      if (upper.startsWith("STARTTLS")) {
        writeTarget.write("220 Ready to start TLS\r\n");
        return;
      }
      if (upper.startsWith("AUTH PLAIN")) {
        writeTarget.write("235 2.7.0 Authentication successful\r\n");
        return;
      }
      if (upper.startsWith("MAIL FROM") || upper.startsWith("RCPT TO")) {
        writeTarget.write("250 OK\r\n");
        return;
      }
      if (upper.startsWith("DATA")) {
        writeTarget.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        collectingData = true;
        dataBody = [];
        return;
      }
      if (upper.startsWith("QUIT")) {
        writeTarget.write("221 Bye\r\n");
        writeTarget.end();
        return;
      }
      // Acknowledge anything else positively.
      writeTarget.write("250 OK\r\n");
    };

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      let idx = buffer.indexOf("\r\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        // STARTTLS: wrap the raw socket in TLS; TLSSocket takes over the
        // readable side, and all subsequent responses go to it.
        if (line.toUpperCase().startsWith("STARTTLS") && starttls) {
          handleLine(line);
          const secure = new tls.TLSSocket(socket, {
            isServer: true,
            key: KEY,
            cert: CERT,
            rejectUnauthorized: false,
          });
          writeTarget = secure;
          let sbuf = "";
          secure.on("data", (c) => {
            sbuf += c.toString("latin1");
            let i = sbuf.indexOf("\r\n");
            while (i !== -1) {
              handleLine(sbuf.slice(0, i));
              sbuf = sbuf.slice(i + 2);
              i = sbuf.indexOf("\r\n");
            }
          });
          secure.on("end", () => {});
          return;
        }

        handleLine(line);
        idx = buffer.indexOf("\r\n");
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        received,
        getDataBody: () => (dataBody ? [...dataBody] : null),
      });
    });
  });
}

describe("SmtpClient", () => {
  let mock;
  afterEach(async () => {
    if (mock) {
      await new Promise((r) => mock.server.close(r));
      mock = null;
    }
  });

  it("sends a message over a plaintext connection (AUTH, MAIL, RCPT, DATA, QUIT)", async () => {
    mock = await startMockServer({ starttls: false });
    const client = new SmtpClient("127.0.0.1", mock.port, {
      user: "boat@example.com",
      password: "secret",
      secure: false,
    });

    await client.send(
      "query@saildocs.com",
      "Your query: abc123",
      "send gfs:10N,20N|WIND\n-----",
    );

    // Verify the conversation order.
    assert.ok(mock.received[0].startsWith("EHLO"), "should start with EHLO");
    assert.match(mock.received.join("\n"), /AUTH PLAIN/);
    assert.ok(
      mock.received.some((l) => l.startsWith("MAIL FROM:<boat@example.com>")),
      "envelope sender should be the authenticated user",
    );
    assert.ok(
      mock.received.some((l) => l.startsWith("RCPT TO:<query@saildocs.com>")),
      "recipient should be the saildocs address",
    );
    assert.ok(mock.received.includes("QUIT"), "should end with QUIT");

    // The captured DATA body includes the From/To/Subject headers and the body.
    const body = mock.getDataBody();
    assert.ok(body, "should have captured a DATA payload");
    const text = body.join("\r\n");
    assert.match(text, /From: <boat@example\.com>/);
    assert.match(text, /To: <query@saildocs\.com>/);
    assert.match(text, /Subject: Your query: abc123/);
    assert.ok(
      text.includes("send gfs:10N,20N|WIND"),
      "body should be sent verbatim",
    );
    assert.ok(text.includes("-----"), "five-dash terminator preserved");
    assert.equal(
      body[body.length - 1],
      ".",
      "DATA should be terminated with a lone dot",
    );
  });

  it("upgrades to TLS via STARTTLS when advertised", async () => {
    mock = await startMockServer({ starttls: true });
    const client = new SmtpClient("127.0.0.1", mock.port, {
      user: "boat@example.com",
      password: "secret",
      // secure 'auto' on a non-465 port => STARTTLS when advertised.
      secure: "auto",
      timeout: 5000,
      tls: { rejectUnauthorized: false },
    });

    await client.send("query@saildocs.com", "Test", "hello world");

    assert.ok(
      mock.received.includes("STARTTLS"),
      "should issue STARTTLS when the server advertises it",
    );
    // After the upgrade, AUTH/MAIL/RCPT/DATA arrive over the TLS connection.
    assert.match(mock.received.join("\n"), /AUTH PLAIN/);
    assert.ok(
      mock.received.some((l) => l.startsWith("RCPT TO:<query@saildocs.com>")),
      "should complete the send after STARTTLS",
    );
  });

  it("omits AUTH when no credentials are configured", async () => {
    mock = await startMockServer({ starttls: false, authRequired: false });
    const client = new SmtpClient("127.0.0.1", mock.port, {
      from: "noreply@example.com",
      secure: false,
    });

    await client.send("query@saildocs.com", "No auth", "body");

    const convo = mock.received.join("\n");
    assert.doesNotMatch(
      convo,
      /AUTH PLAIN/,
      "should not attempt AUTH without creds",
    );
    assert.ok(
      mock.received.some((l) =>
        l.startsWith("MAIL FROM:<noreply@example.com>"),
      ),
      "should use the configured From as envelope sender",
    );
  });

  it("dot-stuffs a body line that begins with a dot", async () => {
    mock = await startMockServer({ starttls: false, authRequired: false });
    const client = new SmtpClient("127.0.0.1", mock.port, {
      from: "a@example.com",
      secure: false,
    });

    await client.send("b@example.com", "dots", ".secret\n.next");

    const body = mock.getDataBody();
    const text = body.join("\n");
    // A leading dot on a line must be doubled so it isn't read as the DATA end.
    assert.match(text, /\.\.secret/);
    assert.match(text, /\.\.next/);
  });

  it("throws SmtpError on a permanent (5xx) failure", async () => {
    // A server that rejects MAIL FROM with a 550.
    const server = net.createServer((socket) => {
      socket.write("220 rejector ESMTP\r\n");
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        let idx = buf.indexOf("\r\n");
        while (idx !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (line.toUpperCase().startsWith("EHLO")) {
            socket.write("250 rejector\r\n");
          } else if (line.toUpperCase().startsWith("MAIL FROM")) {
            socket.write("550 No such user\r\n");
          } else {
            socket.write("250 OK\r\n");
          }
          idx = buf.indexOf("\r\n");
        }
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const client = new SmtpClient("127.0.0.1", port, {
      from: "a@example.com",
      secure: false,
    });
    await assert.rejects(
      () => client.send("b@example.com", "x", "y"),
      (err) => {
        assert.ok(
          err instanceof SmtpClient.SmtpError,
          "should be an SmtpError",
        );
        assert.equal(err.code, 550, "should carry the server's 5xx code");
        return true;
      },
    );
    await new Promise((r) => server.close(r));
  });

  it("does not retry on permanent SMTP 535 auth failure", async () => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      socket.write("220 mock ESMTP ready\r\n");
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        let idx = buf.indexOf("\r\n");
        while (idx !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (line.toUpperCase().startsWith("EHLO")) {
            socket.write("250-AUTH PLAIN\r\n250 OK\r\n");
          } else if (line.toUpperCase().startsWith("AUTH")) {
            socket.write("535 5.7.8 Error: authentication failed\r\n");
          } else {
            socket.write("250 OK\r\n");
          }
          idx = buf.indexOf("\r\n");
        }
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const client = new SmtpClient("127.0.0.1", port, {
      user: "boat@example.com",
      password: "wrong",
      from: "a@example.com",
      secure: false,
      retryBaseDelay: 10,
    });

    await assert.rejects(
      () => client.sendWithRetry("b@example.com", "test", "body", 3),
      (err) => {
        assert.equal(err.code, 535, "should carry the 535 code");
        return true;
      },
    );
    assert.equal(connections, 1, "should not retry on auth failure");
    await new Promise((r) => server.close(r));
  });
});
