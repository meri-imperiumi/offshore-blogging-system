const tls = require("node:tls");
const net = require("node:net");

/**
 * Node.js connection-level error codes that are transient and worth retrying.
 * These arrive as `err.code` (string), distinct from SmtpError's numeric code.
 *
 * - ECONNREFUSED — server refused the connection (often IP rate-limiting)
 * - ECONNRESET   — connection reset by peer mid-conversation
 * - ETIMEDOUT    — connection or socket timeout
 * - EHOSTUNREACH — no route to host (temporary network partition)
 * - ENETUNREACH  — network unreachable
 * - EAI_AGAIN    — temporary DNS resolution failure
 */
const RETRIABLE_CONNECTION_ERRORS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

/**
 * SmtpError - Distinguishable SMTP failure carrying the server's status code.
 *
 * The first digit of an SMTP status code classifies the outcome (RFC 5321 §4.2):
 *   2xx positive completion, 3xx positive intermediate (e.g. 354 "send data"),
 *   4xx transient negative, 5xx permanent negative. Callers can branch on
 *   `code` (e.g. retry on 4xx, give up on 5xx) rather than string-matching.
 */
class SmtpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SmtpError";
    this.code = code;
  }
}

/**
 * Wait for a socket to be connected (plain or TLS). Resolves on the first of
 * `connect` / `secureConnect`; rejects on `error`. Idempotent if already open.
 */
function onceConnected(socket) {
  if (socket.readyState === "open") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      socket.removeListener("connect", onOpen);
      socket.removeListener("secureConnect", onOpen);
      socket.removeListener("error", onError);
    };
    socket.once("connect", onOpen);
    socket.once("secureConnect", onOpen);
    socket.once("error", onError);
  });
}

/**
 * SmtpReader - line-buffered SMTP response reader.
 *
 * SMTP responses are CRLF-terminated lines. A multiline response uses a `-`
 * continuation on all but the final line (e.g. `250-SIZE`, `250 HELP`). This
 * reader accumulates lines until the final (space-after-code) line, then
 * resolves the pending promise with the full list.
 *
 * Responses are read as latin1 so byte values round-trip; SMTP reply lines are
 * ASCII so this is lossless for status parsing. Message *bodies* are written
 * separately as UTF-8 (see SmtpClient._data).
 */
class SmtpReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.waiters = [];
    this._onData = (chunk) => {
      this.buffer += chunk.toString("latin1");
      let idx = this.buffer.indexOf("\r\n");
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        const head = this.waiters[0];
        if (!head) {
          // Unsolicited line (e.g. a late greeting) — drop it.
          idx = this.buffer.indexOf("\r\n");
          continue;
        }
        head.lines.push(line);
        // Final line: "NNN " (space). Continuation: "NNN-" (dash).
        if (/^\d{3} /.test(line)) {
          this.waiters.shift();
          head.resolve(head.lines);
        }
        idx = this.buffer.indexOf("\r\n");
      }
    };
    this._onError = (err) => {
      const head = this.waiters[0];
      if (!head) {
        return;
      }
      this.waiters.shift();
      head.reject(err);
    };
    socket.on("data", this._onData);
    socket.on("error", this._onError);
  }

  /**
   * Read one full (possibly multiline) SMTP response. `expect` is the expected
   * first digit (2, 3, …) of the final line's status code; a mismatch throws
   * SmtpError with the actual code and last line.
   */
  response(expect) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ lines: [], resolve, reject });
    }).then((lines) => {
      const last = lines[lines.length - 1] || "";
      const code = parseInt(last.slice(0, 3), 10);
      if (Number.isNaN(code) || Math.floor(code / 100) !== expect) {
        throw new SmtpError(
          code,
          `SMTP expected ${expect}xx but got: ${lines.join("\n")}`,
        );
      }
      return { code, lines };
    });
  }

  detach() {
    this.socket.removeListener("data", this._onData);
    this.socket.removeListener("error", this._onError);
  }
}

/**
 * Simple SMTP client supporting implicit TLS (port 465), STARTTLS (port 587),
 * AUTH PLAIN, and a single message send per connection. Minimal by design —
 * no pipelining, no connection reuse — to match the project's "reduce
 * dependencies" stance (RFC 5321/5322 implemented inline, no nodemailer).
 *
 * @param {string} host - SMTP server host
 * @param {number} port - SMTP server port (465 implicit TLS, 587 STARTTLS)
 * @param {Object} options
 * @param {string} [options.user] - AUTH PLAIN username
 * @param {string} [options.password] - AUTH PLAIN password
 * @param {string} [options.from] - envelope sender / From header (defaults to user)
 * @param {number} [options.timeout=30000] - overall send timeout in ms
 * @param {boolean|'auto'} [options.secure='auto'] - true: implicit TLS;
 *   false: plaintext, no STARTTLS; 'auto': implicit TLS on 465, STARTTLS on
 *   other ports when the server advertises it
 */
class SmtpClient {
  constructor(host, port, options = {}) {
    this.host = host;
    this.port = port;
    this.user = options.user || null;
    this.password = options.password || null;
    this.from = options.from || options.user || null;
    this.timeout = options.timeout || 30000;
    this.secure = options.secure === undefined ? "auto" : options.secure;
    // Extra options forwarded to tls.connect (e.g. { rejectUnauthorized: false }
    // for opportunistic STARTTLS against a self-signed test cert). Production
    // leaves this unset so real server certificates are verified.
    this.tlsOptions = options.tls || {};
    // Base delay for sendWithRetry backoff. Connection-level errors (ECONNREFUSED)
    // use a longer base than protocol-level 4xx because they typically indicate
    // a server-side rate-limit window that lasts several seconds. Tests can
    // override to make the backoff near-instant.
    this.retryBaseDelay = options.retryBaseDelay || 2000;
    this.retryConnBaseDelay = options.retryConnBaseDelay || 5000;
  }

  /**
   * Send a message, retrying on transient (4xx/554) failures with
   * exponential backoff. 5xx errors that aren't 554 (auth failures, invalid
   * recipients, etc.) are permanent and not retried.
   *
   * @param {string} to - recipient address
   * @param {string} subject - subject line
   * @param {string} body - message body
   * @param {number} [retries=3] - max retry attempts
   * @returns {Promise<void>}
   */
  async sendWithRetry(to, subject, body, retries = 3) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.send(to, subject, body);
      } catch (err) {
        lastErr = err;
        if (!this._isTransient(err) || attempt === retries) {
          throw err;
        }
        // Connection-level errors (ECONNREFUSED, etc.) indicate rate-limiting
        // or a temporary block that can last longer than a protocol-level 4xx.
        // Use a longer base delay so we don't burn all retries inside the
        // server's block window.
        const isConnectionError = typeof err.code === "string";
        const base = isConnectionError
          ? this.retryConnBaseDelay
          : this.retryBaseDelay;
        const delay = base * 2 ** attempt;
        const label =
          typeof err.code === "string" ? err.code : `SMTP ${err.code}`;
        console.log(
          `[SmtpClient] Transient error ${label}, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${retries})...`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  /**
   * Determine whether an error is transient and worth retrying.
   *
   * Two categories:
   * 1. SMTP protocol errors (SmtpError, numeric code): retry on 554
   *    (connection-level rejection, often rate-limiting) and 4xx (transient
   *    negative completion).
   * 2. Connection-level errors (Node.js system errors, string code): retry on
   *    ECONNREFUSED (rate-limiting / temporary block), ETIMEDOUT,
   *    ECONNRESET, EHOSTUNREACH, ENETUNREACH, EAI_AGAIN (temporary DNS).
   *
   * Don't retry on permanent SMTP failures (535 auth failed, 550 mailbox
   * unavailable) or other errors.
   */
  _isTransient(err) {
    const code = err.code;
    // SMTP protocol error (numeric code from SmtpError)
    if (typeof code === "number") {
      return code === 554 || (code >= 400 && code < 500);
    }
    // Connection-level error (string code from Node.js)
    if (typeof code === "string") {
      return RETRIABLE_CONNECTION_ERRORS.has(code);
    }
    return false;
  }

  async send(to, subject, body) {
    const port = Number(this.port);
    const implicitTls =
      this.secure === true || (this.secure === "auto" && port === 465);

    // SNI servername must be a hostname, not an IP literal — Node (>= 22)
    // rejects `tls.connect({ servername: '127.0.0.1' })` with
    // ERR_INVALID_ARG_VALUE. Omit the option for IP hosts; SNI isn't
    // meaningful for an IP address anyway.
    const servername = net.isIP(this.host) ? undefined : this.host;
    const socket = implicitTls
      ? tls.connect({
          host: this.host,
          port,
          servername,
          ...this.tlsOptions,
        })
      : net.createConnection({ host: this.host, port });

    const timer = setTimeout(() => {
      socket.destroy(new Error("SMTP connection timeout"));
    }, this.timeout);

    try {
      await onceConnected(socket);
      const reader = new SmtpReader(socket);

      // Server greeting
      await reader.response(2);

      // EHLO
      await this._ehlo(reader, socket);

      // Opportunistic STARTTLS on non-implicit-TLS connections.
      if (
        !implicitTls &&
        this.secure === "auto" &&
        reader.capabilities.has("STARTTLS")
      ) {
        socket.write("STARTTLS\r\n");
        await reader.response(2);
        reader.detach();
        const tlsSocket = tls.connect({
          socket,
          servername,
          ...this.tlsOptions,
        });
        await onceConnected(tlsSocket);
        const secureReader = new SmtpReader(tlsSocket);
        await this._ehlo(secureReader, tlsSocket);
        await this._authAndSend(secureReader, to, subject, body);
        return;
      }

      await this._authAndSend(reader, to, subject, body);
    } finally {
      clearTimeout(timer);
      // Allow any in-flight QUIT response to flush, then close.
      try {
        socket.end();
      } catch {
        // Already closed.
      }
    }
  }

  async _ehlo(reader, socket) {
    socket.write(`EHLO ${this._ehloHostname()}\r\n`);
    const { lines } = await reader.response(2);
    reader.capabilities = new Set();
    for (const line of lines) {
      // Strip "NNN-" / "NNN " prefix, take the first token as the capability.
      const rest = line.replace(/^\d{3}[- ]/, "");
      const cap = rest.split(/\s/)[0].toUpperCase();
      if (cap) {
        reader.capabilities.add(cap);
      }
    }
  }

  async _authAndSend(reader, to, subject, body) {
    if (this.user && this.password) {
      if (!reader.capabilities.has("AUTH")) {
        throw new SmtpError(0, "Server did not advertise AUTH");
      }
      const token = Buffer.from(`\0${this.user}\0${this.password}`).toString(
        "base64",
      );
      const socket = reader.socket;
      socket.write(`AUTH PLAIN ${token}\r\n`);
      await reader.response(2);
    }

    const socket = reader.socket;
    socket.write(`MAIL FROM:<${this.from || ""}>\r\n`);
    await reader.response(2);
    socket.write(`RCPT TO:<${to}>\r\n`);
    await reader.response(2);
    await this._data(reader, to, subject, body);
  }

  async _data(reader, to, subject, body) {
    const socket = reader.socket;
    socket.write("DATA\r\n");
    await reader.response(3); // 354 End data with <CR><LF>.<CR><LF>

    const headers = this._headers(to, subject);
    socket.write(headers);
    socket.write(this._stuffBody(body));
    socket.write("\r\n.\r\n");
    await reader.response(2);

    socket.write("QUIT\r\n");
    // Await the 221 closing response so the server has recorded QUIT (and any
    // final state) before we tear the socket down. Errors here (server hung
    // up first) are non-fatal.
    await reader.response(2).catch(() => {});
  }

  _headers(to, subject) {
    const date = new Date().toUTCString();
    const lines = [
      `Date: ${date}`,
      `From: <${this.from || ""}>`,
      `To: <${to}>`,
      `Subject: ${this._encodeHeader(subject)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      "",
    ];
    return lines.join("\r\n");
  }

  /**
   * Dot-stuffing (RFC 5321 §4.5.2): any line beginning with "." must be
   * prefixed with an extra "." so the DATA terminator is unambiguous.
   */
  _stuffBody(body) {
    const str = typeof body === "string" ? body : String(body);
    return str
      .replace(/\r\n/g, "\n")
      .replace(/\n/g, "\r\n")
      .replace(/^(?:\.)/gm, "..");
  }

  /**
   * Minimal RFC 2047-style header encoding for non-ASCII subjects. Pure-ASCII
   * subjects pass through verbatim (the common Saildocs case).
   */
  _encodeHeader(value) {
    const str = String(value);
    if (/^[\x20-\x7E]*$/.test(str)) {
      return str;
    }
    const encoded = Buffer.from(str, "utf-8").toString("base64");
    return `=?utf-8?B?${encoded}?=`;
  }

  _ehloHostname() {
    // A valid domain label; the literal is fine since SMTP servers only use it
    // for logging/identification, not delivery.
    return "localhost";
  }
}

SmtpClient.SmtpError = SmtpError;

module.exports = SmtpClient;
