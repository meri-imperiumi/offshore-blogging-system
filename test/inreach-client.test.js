import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

// lib/InReachClient.js is CommonJS (required by the NoFlo components). Load it
// via createRequire so we get the real CJS exports including the InReachError
// class (named ESM imports from CJS don't always surface class exports).
const require = createRequire(import.meta.url);
const InReachClient = require("../lib/InReachClient.js");
const { InReachError } = InReachClient;

const REPLY_URL =
  "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc123guid&adr=someaddr";
const GOOD_URL_NO_EXTID =
  "https://explore.garmin.com/TextMessage/TxtMsg?adr=someaddr";

// Build a client whose `request` is a recorder mock.
function mockClient(response, opts = {}) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    if (response instanceof Error) {
      throw response;
    }
    return typeof response === "function" ? response(calls.length) : response;
  };
  const client = new InReachClient({
    replyAddress: opts.replyAddress || "cloud@boat.example",
    request,
    ...opts,
  });
  return { client, calls };
}

describe("InReachClient.extractGuid", () => {
  it("extracts the extId query parameter from a full Garmin URL", () => {
    assert.strictEqual(InReachClient.extractGuid(REPLY_URL), "abc123guid");
  });

  it("returns the extId even when more params follow", () => {
    const url =
      "https://explore.garmin.com/TextMessage/TxtMsg?extId=g7x&adr=foo&other=1";
    assert.strictEqual(InReachClient.extractGuid(url), "g7x");
  });

  it("falls back to the legacy substring split for non-URL inputs", () => {
    assert.strictEqual(
      InReachClient.extractGuid("blah extId=legacyguid&adr=x"),
      "legacyguid",
    );
  });

  it("returns null when there is no extId", () => {
    assert.strictEqual(InReachClient.extractGuid(GOOD_URL_NO_EXTID), null);
    assert.strictEqual(InReachClient.extractGuid("not a url at all"), null);
    assert.strictEqual(InReachClient.extractGuid(null), null);
    assert.strictEqual(InReachClient.extractGuid(undefined), null);
    assert.strictEqual(InReachClient.extractGuid(123), null);
  });
});

describe("InReachClient.randomMessageId", () => {
  it("produces an 8-digit numeric string", () => {
    const id = InReachClient.randomMessageId();
    assert.match(id, /^\d{8}$/);
    const n = Number(id);
    assert.ok(n >= 10000000 && n <= 99999999);
  });

  it("produces different values across calls (probabilistic)", () => {
    const ids = new Set();
    for (let i = 0; i < 50; i++) {
      ids.add(InReachClient.randomMessageId());
    }
    assert.ok(ids.size > 1, "expected more than one distinct id over 50 calls");
  });
});

describe("InReachClient.send", () => {
  it("POSTs the form-encoded body with guid, reply address and a MessageId on success", async () => {
    const { client, calls } = mockClient({ status: 200, text: "ok" });

    const res = await client.send(REPLY_URL, "hello world");

    assert.deepStrictEqual(res, { ok: true, status: 200 });
    assert.strictEqual(calls.length, 1);
    const { url, options } = calls[0];
    assert.strictEqual(url, REPLY_URL);
    assert.strictEqual(options.method, "POST");
    assert.match(options.body, /ReplyAddress=cloud%40boat\.example/);
    assert.match(options.body, /ReplyMessage=hello\+world/);
    assert.match(options.body, /Guid=abc123guid/);
    assert.match(options.body, /MessageId=\d{8}/);
    assert.strictEqual(options.headers.cookie, "BrowsingMode=Desktop");
    assert.strictEqual(options.headers.referer, REPLY_URL);
    assert.strictEqual(options.headers.origin, "https://explore.garmin.com");
    assert.match(
      options.headers["content-type"],
      /application\/x-www-form-urlencoded/,
    );
  });

  it("includes the BrowsingMode cookie by default", async () => {
    const { client, calls } = mockClient({ status: 200, text: "" });
    await client.send(REPLY_URL, "x");
    assert.strictEqual(calls[0].options.headers.cookie, "BrowsingMode=Desktop");
  });

  it("throws SESSION_EXPIRED on 401", async () => {
    const { client } = mockClient({ status: 401, text: "unauthorized" });
    await assert.rejects(
      () => client.send(REPLY_URL, "x"),
      (err) => err.code === "SESSION_EXPIRED" && err.status === 401,
    );
  });

  it("throws SESSION_EXPIRED on 403", async () => {
    const { client } = mockClient({ status: 403, text: "forbidden" });
    await assert.rejects(
      () => client.send(REPLY_URL, "x"),
      (err) => err.code === "SESSION_EXPIRED" && err.status === 403,
    );
  });

  it("throws RATE_LIMITED on 429", async () => {
    const { client } = mockClient({ status: 429, text: "slow down" });
    await assert.rejects(
      () => client.send(REPLY_URL, "x"),
      (err) => err.code === "RATE_LIMITED" && err.status === 429,
    );
  });

  it("throws API_FAILURE on other non-200 status", async () => {
    const { client } = mockClient({ status: 500, text: "boom" });
    await assert.rejects(
      () => client.send(REPLY_URL, "x"),
      (err) => err.code === "API_FAILURE" && err.status === 500,
    );
  });

  it("includes the response detail (truncated) in the failure message", async () => {
    const long = "x".repeat(500);
    const { client } = mockClient({ status: 500, text: long });
    await assert.rejects(
      () => client.send(REPLY_URL, "x"),
      (err) => {
        assert.strictEqual(err.code, "API_FAILURE");
        assert.ok(err.message.includes("HTTP 500"));
        // detail is trimmed to 200 chars
        assert.ok(!err.message.includes("x".repeat(500)));
        assert.ok(err.message.length < 500 + 100);
        return true;
      },
    );
  });

  it("throws BAD_URL when no Guid can be extracted", async () => {
    const { client, calls } = mockClient({ status: 200, text: "" });
    await assert.rejects(
      () => client.send(GOOD_URL_NO_EXTID, "x"),
      (err) => err.code === "BAD_URL",
    );
    assert.strictEqual(calls.length, 0, "should not have called the transport");
  });

  it("throws BAD_URL for a non-http reply URL", async () => {
    const { client, calls } = mockClient({ status: 200, text: "" });
    await assert.rejects(
      () => client.send("not a url", "x"),
      (err) => err.code === "BAD_URL",
    );
    assert.strictEqual(calls.length, 0);
  });

  it("throws NOT_CONFIGURED when no reply address is set", async () => {
    const { client, calls } = mockClient(
      { status: 200, text: "" },
      { replyAddress: "" },
    );
    await assert.rejects(
      () => client.send(REPLY_URL, "x"),
      (err) => err.code === "NOT_CONFIGURED",
    );
    assert.strictEqual(calls.length, 0);
  });

  it("propagates transport errors as-is (so the component can read .code)", async () => {
    const transportErr = new InReachError("boom", "NETWORK_ERROR");
    const { client } = mockClient(transportErr);
    await assert.rejects(
      () => client.send(REPLY_URL, "x"),
      (err) => err.code === "NETWORK_ERROR",
    );
  });

  it("generates a fresh MessageId per send", async () => {
    const { client, calls } = mockClient({ status: 200, text: "" });
    await client.send(REPLY_URL, "a");
    await client.send(REPLY_URL, "b");
    assert.strictEqual(calls.length, 2);
    const ids = calls.map((c) => c.options.body.match(/MessageId=(\d{8})/)[1]);
    assert.notStrictEqual(ids[0], ids[1]);
  });

  it("honors a custom cookies/headers merge", async () => {
    const { client, calls } = mockClient(
      { status: 200, text: "" },
      {
        cookies: { Extra: "1" },
        headers: { "x-custom": "yes" },
      },
    );
    await client.send(REPLY_URL, "x");
    const h = calls[0].options.headers;
    assert.match(h.cookie, /BrowsingMode=Desktop/);
    assert.match(h.cookie, /Extra=1/);
    assert.strictEqual(h["x-custom"], "yes");
  });

  it("throws BAD_RESPONSE on 200 with an HTML body (the scraper blind spot)", async () => {
    // cloud.md explicitly elevates error handling beyond the Python references,
    // both of which only check == 200. A 200 carrying an HTML login/error page
    // must not be logged as success.
    const { client } = mockClient({
      status: 200,
      text: "<!DOCTYPE html><html><body>Please sign in</body></html>",
    });
    await assert.rejects(
      () => client.send(REPLY_URL, "x"),
      (err) =>
        err.code === "BAD_RESPONSE" &&
        err.status === 200 &&
        /HTML body/.test(err.message),
    );
  });

  it("detects an HTML error page with leading whitespace", async () => {
    const { client } = mockClient({
      status: 200,
      text: "\n  \n<html><head><title>Error</title></head></html>",
    });
    await assert.rejects(
      () => client.send(REPLY_URL, "x"),
      (err) => err.code === "BAD_RESPONSE",
    );
  });

  it("still treats a 200 with a stray '<' deep in the text as success", async () => {
    // Conservative sniff: only an HTML doctype/<html> at the head counts.
    // A legitimate plain-text reply containing '<' elsewhere must not trip.
    const { client, calls } = mockClient({
      status: 200,
      text: "Reply queued. See <https://garmin.com> for details.",
    });
    const res = await client.send(REPLY_URL, "x");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(calls.length, 1);
  });

  it("treats a 204 No Content as success", async () => {
    const { client } = mockClient({ status: 204, text: "" });
    const res = await client.send(REPLY_URL, "x");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 204);
  });
});
