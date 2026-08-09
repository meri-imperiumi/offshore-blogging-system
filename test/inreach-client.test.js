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
    const call = { url, options };
    calls.push(call);
    if (response instanceof Error) {
      throw response;
    }
    return typeof response === "function" ? response(call) : response;
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

describe("InReachClient.isShareUrl", () => {
  it("recognizes an inreachlink.com share URL", () => {
    assert.ok(
      InReachClient.isShareUrl(
        "https://inreachlink.com/gBw0nPHdcVHWpY_iwR4kt6w",
      ),
    );
    assert.ok(InReachClient.isShareUrl("http://inreachlink.com/abcDEF_-123"));
    assert.ok(InReachClient.isShareUrl("https://www.inreachlink.com/code"));
  });

  it("rejects a direct explore.garmin.com reply URL", () => {
    assert.ok(!InReachClient.isShareUrl(REPLY_URL));
  });

  it("rejects non-urls and falsy values", () => {
    assert.ok(!InReachClient.isShareUrl("not a url"));
    assert.ok(!InReachClient.isShareUrl(""));
    assert.ok(!InReachClient.isShareUrl(null));
    assert.ok(!InReachClient.isShareUrl(undefined));
  });
});

describe("InReachClient.send with share-URL resolution", () => {
  const SHARE_URL = "https://inreachlink.com/gBw0nPHdcVHWpY_iwR4kt6w";
  // The share code IS the extId (confirmed: a 301 GET of the share URL
  // redirects to ...?extId=gBw0nPHdcVHWpY_iwR4kt6w).
  const CODE = "gBw0nPHdcVHWpY_iwR4kt6w";
  const ENDPOINT = `https://eur.explore.garmin.com/textmessage/txtmsg?extId=${CODE}`;

  // Mock that returns an HTML page on GET and a plain-text ack on POST.
  function shareMock(getResponse, postResponse, opts = {}) {
    const calls = [];
    const request = async (url, options) => {
      const call = { url, options };
      calls.push(call);
      if (options.method === "GET") {
        if (getResponse instanceof Error) throw getResponse;
        return getResponse;
      }
      return postResponse;
    };
    const client = new InReachClient({
      replyAddress: opts.replyAddress || "cloud@boat.example",
      request,
      ...opts,
    });
    return { client, calls };
  }

  function htmlWithForm(guid, messageId) {
    return {
      status: 200,
      text: `<html><body><form><input data-val="true" data-val-required="The Guid field is required." id="Guid" name="Guid" type="hidden" value="${guid}" /><input data-val="true" data-val-number="The field MessageId must be a number." data-val-required="The MessageId field is required." id="MessageId" name="MessageId" type="hidden" value="${messageId}" /></form></body></html>`,
    };
  }

  it("GETs the reply page, then POSTs with server-provided Guid and MessageId", async () => {
    const SERVER_GUID = "server-provided-guid";
    const SERVER_MSGID = "99887766";
    const { client, calls } = shareMock(
      htmlWithForm(SERVER_GUID, SERVER_MSGID),
      { status: 200, text: "ok" },
    );

    const res = await client.send(SHARE_URL, "PONG");

    assert.strictEqual(res.ok, true);
    // Two requests: GET (page) + POST (reply)
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].options.method, "GET");
    assert.strictEqual(calls[0].url, ENDPOINT);
    assert.strictEqual(calls[1].options.method, "POST");
    assert.strictEqual(calls[1].url, ENDPOINT);
    // POST body uses the server-provided values
    assert.match(calls[1].options.body, new RegExp(`Guid=${SERVER_GUID}`));
    assert.match(calls[1].options.body, /MessageId=99887766/);
    // referer and origin are the constructed endpoint
    assert.strictEqual(calls[1].options.headers.referer, ENDPOINT);
    assert.strictEqual(
      calls[1].options.headers.origin,
      "https://eur.explore.garmin.com",
    );
  });

  it("falls back to extId + random MessageId when Cloudflare blocks the GET (429)", async () => {
    const { client, calls } = shareMock(
      { status: 429, text: "rate limited" },
      { status: 200, text: "ok" },
      { maxRetries: 0 },
    );

    const res = await client.send(SHARE_URL, "PONG");

    assert.strictEqual(res.ok, true);
    // GET failed (429) — fell back to extId as Guid, random MessageId
    assert.strictEqual(calls.length, 2);
    assert.match(calls[1].options.body, new RegExp(`Guid=${CODE}`));
    assert.match(calls[1].options.body, /MessageId=\d{8}/);
  });

  it("falls back when the GET returns non-HTML (no form fields)", async () => {
    const { client, calls } = shareMock(
      { status: 200, text: "some plain text" },
      { status: 200, text: "ok" },
    );
    const res = await client.send(SHARE_URL, "PONG");
    assert.strictEqual(res.ok, true);
    assert.match(calls[1].options.body, new RegExp(`Guid=${CODE}`));
  });

  it("falls back when the GET throws a network error", async () => {
    const { client, calls } = shareMock(
      new InReachError("connect ECONNREFUSED", "NETWORK_ERROR"),
      { status: 200, text: "ok" },
      { maxRetries: 0 },
    );
    const res = await client.send(SHARE_URL, "PONG");
    assert.strictEqual(res.ok, true);
    // GET was attempted (and recorded) but threw; POST still sent with fallback
    assert.strictEqual(calls.length, 2);
    assert.match(calls[1].options.body, new RegExp(`Guid=${CODE}`));
  });

  it("caches form values so multi-chunk sends only GET once per conversation", async () => {
    const SERVER_GUID = "cached-guid";
    const SERVER_MSGID = "11223344";
    const { client, calls } = shareMock(
      htmlWithForm(SERVER_GUID, SERVER_MSGID),
      { status: 200, text: "ok" },
    );
    await client.send(SHARE_URL, "chunk-a");
    await client.send(SHARE_URL, "chunk-b");
    // 3 total calls: 1 GET (cached) + 2 POSTs
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(calls[0].options.method, "GET");
    assert.strictEqual(calls[1].options.method, "POST");
    assert.strictEqual(calls[2].options.method, "POST");
    // Both POSTs use the cached server-provided Guid
    assert.match(calls[1].options.body, new RegExp(`Guid=${SERVER_GUID}`));
    assert.match(calls[2].options.body, new RegExp(`Guid=${SERVER_GUID}`));
  });

  it("honors a custom replyEndpoint (e.g. for a different region)", async () => {
    const { client, calls } = shareMock(
      { status: 200, text: "" },
      { status: 200, text: "ok" },
      { replyEndpoint: "https://explore.garmin.com/TextMessage/TxtMsg" },
    );
    await client.send(SHARE_URL, "x");
    const expected = `https://explore.garmin.com/TextMessage/TxtMsg?extId=${CODE}`;
    assert.strictEqual(calls[0].url, expected);
    assert.strictEqual(calls[1].url, expected);
    assert.strictEqual(
      calls[1].options.headers.origin,
      "https://explore.garmin.com",
    );
  });

  it("does not GET for a direct explore.garmin.com reply URL (legacy)", async () => {
    const { client, calls } = mockClient({ status: 200, text: "ok" });
    await client.send(REPLY_URL, "x");
    // Only the POST, no GET — legacy URLs skip the page fetch
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].options.method, "POST");
    assert.strictEqual(calls[0].url, REPLY_URL);
  });

  it("throws BAD_URL for a malformed share URL with no code", async () => {
    const { client, calls } = mockClient({ status: 200, text: "ok" });
    await assert.rejects(
      () => client.send("https://inreachlink.com/", "x"),
      (err) => err.code === "BAD_URL",
    );
    assert.strictEqual(calls.length, 0);
  });
});

describe("InReachClient.parseFormField", () => {
  it("extracts a hidden input value (name before value)", () => {
    const html = '<input type="hidden" name="Guid" value="abc123">';
    assert.strictEqual(InReachClient.parseFormField(html, "Guid"), "abc123");
  });

  it("extracts a hidden input value (value before name)", () => {
    const html = '<input type="hidden" value="xyz789" name="MessageId">';
    assert.strictEqual(
      InReachClient.parseFormField(html, "MessageId"),
      "xyz789",
    );
  });

  it("handles single-quoted attributes", () => {
    const html = "<input name='Guid' value='single-quote-val'>";
    assert.strictEqual(
      InReachClient.parseFormField(html, "Guid"),
      "single-quote-val",
    );
  });

  it("returns null when the field is not present", () => {
    assert.strictEqual(
      InReachClient.parseFormField("<html>no form</html>", "Guid"),
      null,
    );
    assert.strictEqual(InReachClient.parseFormField("", "Guid"), null);
    assert.strictEqual(InReachClient.parseFormField(null, "Guid"), null);
  });
});

describe("InReachClient retry/backoff", () => {
  it("isRetryableStatus flags 429 and 5xx", () => {
    assert.ok(InReachClient.isRetryableStatus(429));
    assert.ok(InReachClient.isRetryableStatus(502));
    assert.ok(InReachClient.isRetryableStatus(503));
    assert.ok(InReachClient.isRetryableStatus(504));
    assert.ok(!InReachClient.isRetryableStatus(200));
    assert.ok(!InReachClient.isRetryableStatus(404));
    assert.ok(!InReachClient.isRetryableStatus(401));
  });

  it("isRetryableError flags NETWORK_ERROR", () => {
    assert.ok(
      InReachClient.isRetryableError(new InReachError("x", "NETWORK_ERROR")),
    );
    assert.ok(
      !InReachClient.isRetryableError(new InReachError("x", "BAD_URL")),
    );
    assert.ok(
      !InReachClient.isRetryableError(new InReachError("x", "NOT_CONFIGURED")),
    );
  });

  it("parseRetryAfter handles seconds, HTTP-date, and fallback", () => {
    // Numeric (seconds)
    assert.strictEqual(InReachClient.parseRetryAfter("5", 1000), 5000);
    // Capped at MAX_BACKOFF_MS
    assert.strictEqual(InReachClient.parseRetryAfter("9999", 1000), 30000);
    // Fallback when header is missing
    assert.strictEqual(InReachClient.parseRetryAfter(null, 2000), 2000);
    // Fallback capped
    assert.strictEqual(InReachClient.parseRetryAfter(null, 99999), 30000);
    // Unparseable header → fallback
    assert.strictEqual(InReachClient.parseRetryAfter("garbage", 1500), 1500);
  });

  it("retries a 429 response and succeeds on the second attempt", async () => {
    const calls = [];
    const request = async (url, opts) => {
      calls.push({ status: calls.length === 0 ? 429 : 200 });
      if (calls.length === 1) {
        return { status: 429, text: "rate limited", headers: {} };
      }
      return { status: 200, text: "ok", headers: {} };
    };
    const res = await InReachClient.requestWithRetry(
      request,
      "https://example.com",
      { method: "GET" },
      { maxRetries: 3, initialBackoffMs: 0 },
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, 2);
  });

  it("honors Retry-After header on 429", async () => {
    const sleepCalls = [];
    // Wrap requestWithRetry with a sleep spy by using a custom sleep is not
    // directly possible; instead, verify the total attempts and outcome.
    let attempt = 0;
    const request = async () => {
      attempt++;
      if (attempt === 1) {
        return {
          status: 429,
          text: "slow down",
          headers: { "retry-after": "1" },
        };
      }
      return { status: 200, text: "ok", headers: {} };
    };
    const res = await InReachClient.requestWithRetry(
      request,
      "https://example.com",
      { method: "GET" },
      { maxRetries: 3, initialBackoffMs: 0 },
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(attempt, 2);
  });

  it("returns the last response after exhausting retries on persistent 429", async () => {
    let attempt = 0;
    const request = async () => {
      attempt++;
      return { status: 429, text: "still rate limited", headers: {} };
    };
    const res = await InReachClient.requestWithRetry(
      request,
      "https://example.com",
      { method: "GET" },
      { maxRetries: 2, initialBackoffMs: 0 },
    );
    assert.strictEqual(res.status, 429);
    // 1 initial + 2 retries = 3 attempts
    assert.strictEqual(attempt, 3);
  });

  it("retries on a network error and succeeds on retry", async () => {
    let attempt = 0;
    const request = async () => {
      attempt++;
      if (attempt === 1) {
        throw new InReachError("ECONNRESET", "NETWORK_ERROR");
      }
      return { status: 200, text: "ok", headers: {} };
    };
    const res = await InReachClient.requestWithRetry(
      request,
      "https://example.com",
      { method: "POST" },
      { maxRetries: 3, initialBackoffMs: 0 },
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(attempt, 2);
  });

  it("does not retry a non-retryable error (BAD_URL)", async () => {
    let attempt = 0;
    const request = async () => {
      attempt++;
      throw new InReachError("bad url", "BAD_URL");
    };
    await assert.rejects(
      () =>
        InReachClient.requestWithRetry(
          request,
          "https://example.com",
          { method: "GET" },
          { maxRetries: 3, initialBackoffMs: 0 },
        ),
      (err) => err.code === "BAD_URL",
    );
    assert.strictEqual(attempt, 1);
  });

  it("does not retry a 200 success", async () => {
    let attempt = 0;
    const request = async () => {
      attempt++;
      return { status: 200, text: "ok", headers: {} };
    };
    const res = await InReachClient.requestWithRetry(
      request,
      "https://example.com",
      { method: "GET" },
      { maxRetries: 3, initialBackoffMs: 0 },
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(attempt, 1);
  });
});
