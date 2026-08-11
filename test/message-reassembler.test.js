import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import Wrapper from "noflo-wrapper";

const require = createRequire(import.meta.url);
const reassemblerModule = require("../components/MessageReassembler.js");

/**
 * Run a MessageReassembler scenario, resolving the first IP emitted on the
 * given port (or null on timeout).
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
    const t = new Wrapper("signalk-offshore-blogging/MessageReassembler");
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

describe("MessageReassembler", () => {
  it("exports getComponent", () => {
    assert.strictEqual(typeof reassemblerModule.getComponent, "function");
  });

  it("passes through headerless messages unchanged", async () => {
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "boat@x.com",
      channel: "inreach",
      intent: "GRIB",
      payload: "send query@saildocs.com:gfs:58n,60n,018e,022e|2,2|0,12|wind",
    };
    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out");
    assert.strictEqual(
      data.payload,
      "send query@saildocs.com:gfs:58n,60n,018e,022e|2,2|0,12|wind",
    );
  });

  it("passes through failed messages unchanged", async () => {
    const msg = {
      errors: [{ message: "upstream failure" }],
      failed: true,
      identityHash: "dev1",
      replyTo: "boat@x.com",
      channel: "inreach",
      intent: null,
      payload: "something",
    };
    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit failed message on out");
  });

  it("parses a compact header with Meta (uplink blog format)", async () => {
    // Blog uplink: [ID:4][Type:1][Index:2][Total:2][Meta:4]:[Payload]
    // e.g. "0715T0205687c:Rg8DqgD9wwcm"
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "boat@x.com",
      channel: "inreach",
      intent: "BLOG",
      payload: "0715T0104687c:Rg8DqgD9wwcm",
    };
    const { data } = await runScenario({
      msg,
      port: "buffered",
    });
    // Single chunk of a 4-part sequence → buffered, not complete
    assert.ok(data, "should emit on buffered (sequence not complete)");
  });

  it("parses a compact header without Meta (downlink GRIB format)", async () => {
    // GRIB downlink: [ID:4][Type:1][Index:2][Total:2]:[Payload]
    // e.g. "rqnnG0312:payload"
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "boat@x.com",
      channel: "inreach",
      intent: "SAILDOCS",
      payload: "rqnnG0103:chunk1data",
    };
    const { data } = await runScenario({
      msg,
      port: "buffered",
    });
    // First of 3 chunks → buffered, not complete
    assert.ok(data, "should emit on buffered (sequence not complete)");
  });

  it("reassembles a complete multi-chunk GRIB sequence", async () => {
    // Send all 3 chunks of a GRIB sequence. The third chunk should trigger
    // reassembly and emit on `out`.
    const baseMsg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "boat@x.com",
      channel: "inreach",
      intent: "SAILDOCS",
    };

    const t = new Wrapper("signalk-offshore-blogging/MessageReassembler");
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => finish(() => resolve(null)), 2000);
      t.start()
        .then(() => {
          t.outs.out.on("data", (data) => {
            if (data && !data.failed) {
              finish(() => resolve(data));
            }
          });
          t.outs.buffered.on("data", () => {
            // Continue receiving buffered chunks
          });
          // Send 3 chunks of a GRIB sequence
          t.ins.in.send({ ...baseMsg, payload: "abcdG0103:AAAA" });
          t.ins.in.send({ ...baseMsg, payload: "abcdG0203:BBBB" });
          t.ins.in.send({ ...baseMsg, payload: "abcdG0303:CCCC" });
        })
        .catch(reject);
    });

    assert.ok(result, "should emit reassembled message on out");
    assert.strictEqual(result.payload, "AAAABBBBCCCC");
    assert.strictEqual(result.partType, "grib");
    assert.strictEqual(result.transmissionId, "abcd");
    assert.strictEqual(result.totalChunks, 3);
  });
});
