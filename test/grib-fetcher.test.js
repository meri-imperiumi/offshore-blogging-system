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
});
