import assert from "node:assert";
import { describe, it } from "node:test";
import Wrapper from "noflo-wrapper";

/**
 * Run an InReachReceiver scenario, resolving the first IP emitted on `out`
 * (or null on timeout). InReachReceiver has a single `in` port and an `out`
 * + `error` out port.
 */
function runScenario({ msg, port = "out", timeout = 1500 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const t = new Wrapper("signalk-offshore-blogging/InReachReceiver");
    const collected = {};
    t.start()
      .then(() => {
        t.outs[port].on("data", (data) => {
          collected[port] = data;
          finish(() => resolve({ data, collected }));
        });
        t.ins.in.send(msg);
      })
      .catch(reject);
    const timer = setTimeout(
      () => finish(() => resolve({ data: null, collected })),
      timeout,
    );
  });
}

describe("InReachReceiver", () => {
  // --- lo-fi chunk parsing (existing behavior) ---

  it("parses a compact header chunk and sets intent BLOG", async () => {
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc",
      channel: "inreach",
      intent: null,
      payload: "0805T01047F16:Rg8DqgD9wwcm",
    };
    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out");
    assert.strictEqual(data.intent, "BLOG");
    assert.strictEqual(
      data.payload,
      "0805T01047F16:Rg8DqgD9wwcm",
      "payload should use unified compact header format",
    );
  });

  // --- plain-text pass-through + intent detection ---

  it("passes through a Saildocs-syntax weather request as intent GRIB", async () => {
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc",
      channel: "inreach",
      intent: null,
      payload: "send query@saildocs.com:gfs:58n,60n,018e,022e|2,2|0,12|wind",
    };
    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out");
    assert.strictEqual(data.intent, "GRIB");
    // Payload passes through unchanged (MessageReassembler will treat it as
    // a complete, unchunked message).
    assert.strictEqual(
      data.payload,
      "send query@saildocs.com:gfs:58n,60n,018e,022e|2,2|0,12|wind",
    );
  });

  it("passes through a GRIB shorthand request as intent GRIB", async () => {
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc",
      channel: "inreach",
      intent: null,
      payload: "GRIB d=3",
    };
    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out");
    assert.strictEqual(data.intent, "GRIB");
  });

  it("passes through a Saildocs response as intent SAILDOCS", async () => {
    // AuthVerifier sets identityHash='SYS_SAILDOCS' for query@saildocs.com.
    const msg = {
      errors: [],
      identityHash: "SYS_SAILDOCS",
      replyTo: "query-reply@saildocs.com",
      channel: null,
      intent: null,
      payload: "Here is your GRIB file.",
      raw: Buffer.from("raw mime bytes"),
    };
    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out");
    assert.strictEqual(data.intent, "SAILDOCS");
    // The raw email must be carried through so SaildocsMatcher can extract
    // the binary attachment.
    assert.ok(data.raw, "raw email should be carried through unchanged");
  });

  it("passes through a PING command as intent SYS", async () => {
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc",
      channel: "inreach",
      intent: null,
      payload: "PING",
    };
    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out");
    assert.strictEqual(data.intent, "SYS");
    // Payload passes through unchanged so CommandRouter can route on it.
    assert.strictEqual(data.payload, "PING");
  });

  it("detects PING despite InReach boilerplate", async () => {
    // InReach appends "View the location..." after the user's text. Intent
    // detection must use the first line only, same as for GRIB queries.
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc",
      channel: "inreach",
      intent: null,
      payload: "PING\n\nView the location or send a reply to the boat:",
    };
    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out");
    assert.strictEqual(data.intent, "SYS");
  });

  it("passes through a STATUS command as intent SYS", async () => {
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc",
      channel: "inreach",
      intent: null,
      payload: "STATUS",
    };
    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out");
    assert.strictEqual(data.intent, "SYS");
  });

  it("passes through a YES gate command as intent SYS", async () => {
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc",
      channel: "inreach",
      intent: null,
      payload: "YES G1",
    };
    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out");
    assert.strictEqual(data.intent, "SYS");
  });

  it("passes through a CANCEL gate command as intent SYS", async () => {
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc",
      channel: "inreach",
      intent: null,
      payload: "CANCEL G1",
    };
    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out");
    assert.strictEqual(data.intent, "SYS");
  });

  it("passes through unrecognized text with intent null (routes to MISSED)", async () => {
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc",
      channel: "inreach",
      intent: null,
      payload: "Hello from the boat",
    };
    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out (pass-through, not failed)");
    assert.strictEqual(data.intent, null);
  });

  it("detects a bare Saildocs query as intent GRIB (web UI preset)", async () => {
    // The web UI's preset selector generates a bare query (no 'send'
    // prefix) and the user sends it as-is from InReach.
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc",
      channel: "inreach",
      intent: null,
      payload: "gfs:20s,14s,155w,147w|2,2|12,24,36,48|wind",
    };
    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out");
    assert.strictEqual(data.intent, "GRIB");
    // Payload passes through unchanged
    assert.strictEqual(
      data.payload,
      "gfs:20s,14s,155w,147w|2,2|12,24,36,48|wind",
    );
  });

  it("detects a bare Saildocs query despite InReach boilerplate", async () => {
    // InReach appends "View the location..." after the user's text. Intent
    // detection must use the first line only.
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc",
      channel: "inreach",
      intent: null,
      payload:
        "gfs:20s,14s,155w,147w|2,2|12,24,36,48|wind\n\nView the location...",
    };
    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out");
    assert.strictEqual(
      data.intent,
      "GRIB",
      "bare query on first line should be detected despite boilerplate",
    );
  });

  it("does not misclassify ordinary text as a Saildocs query", async () => {
    // Must have model:area|grid|hours|params structure — plain text with a
    // colon and a couple pipes shouldn't match.
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc",
      channel: "inreach",
      intent: null,
      payload: "hello: world | something",
    };
    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out");
    assert.strictEqual(
      data.intent,
      null,
      "ordinary text should not be detected as a GRIB query",
    );
  });

  it("passes through failed messages unchanged", async () => {
    const msg = {
      errors: [{ message: "Unauthorized" }],
      failed: true,
      identityHash: "dev1",
      replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc",
      channel: "inreach",
      intent: null,
      payload: "PING",
    };
    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit failed messages on out");
    assert.strictEqual(data.intent, null, "failed messages keep their intent");
  });
});
