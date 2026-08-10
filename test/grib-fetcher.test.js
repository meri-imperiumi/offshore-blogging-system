import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import Wrapper from "noflo-wrapper";

const require = createRequire(import.meta.url);
const fetcherModule = require("../components/GribFetcher.js");

// Run a GribFetcher scenario, collecting the first IP emitted on `port`.
// Resolves {data, collected} on emission, or {data: null, collected} on
// timeout — GribFetcher has no `out`/error port, so failed(msg) IPs are
// dropped; callers assert the *absence* of an OUTBOX emission for bad input.
function runScenario({ msg, controls = {}, port = "outbox", timeout = 1500 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const t = new Wrapper("signalk-offshore-blogging/GribFetcher");
    const collected = {};
    t.start()
      .then(() => {
        t.outs[port].on("data", (data) => {
          collected[port] = data;
          finish(() => resolve({ data, collected }));
        });
        for (const [key, value] of Object.entries(controls)) {
          t.ins[key].send(value);
        }
        t.ins.in.send(msg);
      })
      .catch(reject);
    const timer = setTimeout(
      () => finish(() => resolve({ data: null, collected })),
      timeout,
    );
  });
}

describe("GribFetcher", () => {
  it("exists and exports getComponent", () => {
    assert.strictEqual(typeof fetcherModule.getComponent, "function");
  });

  it("parses a Saildocs request with a colon in the query and emits OUTBOX", async () => {
    // The query "gfs:10N,20N,60W,50W|2,2|0,12|WIND" itself contains a colon.
    // The old split(\":\") over-split this and rejected every real request.
    const msg = {
      errors: [],
      identityHash: "TEST_IDENTITY",
      replyTo: "boat@example.com",
      channel: "winlink",
      intent: "GRIB",
      payload: "send query@saildocs.com:gfs:10N,20N,60W,50W|2,2|0,12|WIND",
    };

    const { data, collected } = await runScenario({ msg });

    assert.ok(data, "should emit on OUTBOX");
    assert.strictEqual(data.to, "query@saildocs.com");
    // replyTo carries the Saildocs address so SmtpResponder addresses it there.
    assert.strictEqual(data.replyTo, "query@saildocs.com");
    assert.match(data.subject, /^Your query: [0-9a-f]+$/);
    // The five-dash terminator must be appended (Saildocs anti-spam measure).
    assert.ok(
      data.body.endsWith("\n-----"),
      "body must end with the dash terminator",
    );
    assert.ok(
      data.body.includes("gfs:10N,20N,60W,50W|2,2|0,12|WIND"),
      "query should be preserved verbatim before the terminator",
    );
    assert.strictEqual(data.isOutboundRequest, true);
    assert.ok(!collected.error, "should not emit on error");
  });

  it("carries imapUid on the outbound message so ImapAcker can mark the request email as read", async () => {
    // Without imapUid, ImapAcker skips the ack and the incoming InReach
    // email stays unseen — re-fetched on every poll, sending duplicate
    // Saildocs requests for one user request.
    const msg = {
      errors: [],
      identityHash: "TEST_IDENTITY",
      replyTo: "https://inreachlink.com/abc",
      channel: "inreach",
      intent: "GRIB",
      imapUid: 898,
      payload: "send query@saildocs.com:gfs:10N,20N,60W,50W|2,2|0,12|WIND",
    };

    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on OUTBOX");
    assert.strictEqual(
      data.imapUid,
      898,
      "imapUid must be carried so ImapAcker can ack the original email",
    );
  });

  it("carries imapUid for bare queries too", async () => {
    const msg = {
      errors: [],
      identityHash: "TEST_IDENTITY",
      replyTo: "https://inreachlink.com/abc",
      channel: "inreach",
      intent: "GRIB",
      imapUid: 898,
      payload: "gfs:20s,14s,155w,147w|2,2|12,24,36,48|wind",
    };

    const { data } = await runScenario({ msg });
    assert.ok(data);
    assert.strictEqual(data.imapUid, 898);
  });

  it("rejects a malformed request (no colon): emits nothing on OUTBOX", async () => {
    const msg = {
      errors: [],
      identityHash: "TEST_IDENTITY",
      replyTo: "boat@example.com",
      channel: "winlink",
      intent: "GRIB",
      payload: "send query@saildocs.com-without-colon",
    };

    const { data } = await runScenario({ msg, port: "outbox", timeout: 1000 });
    assert.strictEqual(
      data,
      null,
      "malformed request should not produce an OUTBOX emission",
    );
  });

  it("routes non-Saildocs payloads to the local fetch path (no OUTBOX)", async () => {
    const msg = {
      errors: [],
      identityHash: "TEST_IDENTITY",
      replyTo: "boat@example.com",
      channel: "winlink",
      intent: "GRIB",
      payload: "GRIB d=3",
    };

    const { data } = await runScenario({ msg, port: "outbox", timeout: 1000 });
    assert.strictEqual(
      data,
      null,
      "local-fetch path should not emit on OUTBOX (it fails internally)",
    );
  });

  it("handles a bare Saildocs query (no 'send' prefix) and emits OUTBOX to query@saildocs.com", async () => {
    // This is what the web UI's preset selector generates — a bare query
    // the user sends as-is from their InReach device.
    const msg = {
      errors: [],
      identityHash: "TEST_IDENTITY",
      replyTo: "https://inreachlink.com/abc123",
      channel: "inreach",
      intent: "GRIB",
      payload: "gfs:20s,14s,155w,147w|2,2|12,24,36,48|wind",
    };

    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on OUTBOX for bare query");
    assert.strictEqual(
      data.to,
      "query@saildocs.com",
      "bare query should default to query@saildocs.com",
    );
    assert.strictEqual(data.replyTo, "query@saildocs.com");
    assert.match(data.subject, /^Your query: [0-9a-f]+$/);
    assert.ok(data.body.endsWith("\n-----"));
    assert.ok(
      data.body.includes("gfs:20s,14s,155w,147w|2,2|12,24,36,48|wind"),
      "bare query should be preserved verbatim",
    );
  });

  it("strips InReach 'View the location' boilerplate from a bare query", async () => {
    // InReach appends "View the location..." after the user's text. The
    // query must be extracted from the first line only, or the boilerplate
    // would leak into the Saildocs email body.
    const msg = {
      errors: [],
      identityHash: "TEST_IDENTITY",
      replyTo: "https://inreachlink.com/abc123",
      channel: "inreach",
      intent: "GRIB",
      payload:
        "gfs:20s,14s,155w,147w|2,2|12,24,36,48|wind\n\nView the location...",
    };

    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on OUTBOX");
    assert.ok(
      !data.body.includes("View the location"),
      "InReach boilerplate must not leak into the Saildocs email body",
    );
    assert.ok(
      data.body.includes("gfs:20s,14s,155w,147w|2,2|12,24,36,48|wind"),
      "query should be preserved",
    );
  });

  it("strips InReach boilerplate from a 'send <email>:<query>' request", async () => {
    // The `send` shorthand path must also use only the first line. Without
    // this, the InReach "View the location or send a reply..." boilerplate
    // is appended to the Saildocs query body, and Saildocs replies with
    // "There was an error in the following command line: View the location...".
    const msg = {
      errors: [],
      identityHash: "TEST_IDENTITY",
      replyTo: "https://inreachlink.com/abc123",
      channel: "inreach",
      intent: "GRIB",
      payload:
        "send query@saildocs.com:gfs:20s,14s,155w,147w|2,2|12,24,36,48|wind\n\nView the location or send a reply to Bergiu...",
    };

    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on OUTBOX");
    assert.strictEqual(data.to, "query@saildocs.com");
    assert.ok(
      !data.body.includes("View the location"),
      "InReach boilerplate must not leak into the Saildocs email body",
    );
    assert.ok(
      !data.body.includes("Bergiu"),
      "recipient name from the boilerplate must not leak into the body",
    );
    assert.ok(
      data.body.includes("gfs:20s,14s,155w,147w|2,2|12,24,36,48|wind"),
      "query should be preserved verbatim before the terminator",
    );
    assert.ok(
      data.body.endsWith("\n-----"),
      "body must end with the dash terminator (and nothing after it)",
    );
  });
});
