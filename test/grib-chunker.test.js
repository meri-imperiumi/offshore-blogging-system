import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import Wrapper from "noflo-wrapper";

const require = createRequire(import.meta.url);
const chunkerModule = require("../components/GribChunker.js");

/**
 * Run a GribChunker scenario, resolving the first IP emitted on `out`.
 */
function runScenario({ msg, controls = {}, port = "out", timeout = 1500 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const t = new Wrapper("signalk-offshore-blogging/GribChunker");
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

describe("GribChunker", () => {
  it("exists and exports getComponent", () => {
    assert.strictEqual(typeof chunkerModule.getComponent, "function");
  });

  it("chunks binary GRIB data into base64 chunks", async () => {
    const grib = Buffer.concat([
      Buffer.from("GRIB", "ascii"),
      Buffer.alloc(200, 0x41), // 200 bytes of 'A' → 268 bytes of base64
    ]);
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc",
      channel: "inreach",
      intent: "SAILDOCS",
      payload: grib,
    };

    const { data } = await runScenario({
      msg,
      controls: { max_chunk_size: 140 },
    });

    assert.ok(data, "should emit on out");
    assert.ok(Array.isArray(data.payload), "payload should be an array");
    assert.ok(
      data.payload.length > 1,
      "200-byte GRIB should produce more than one 140-char chunk",
    );
    // Each chunk must be <= max_chunk_size
    for (const chunk of data.payload) {
      assert.ok(
        chunk.length <= 140,
        `chunk length ${chunk.length} exceeds 140`,
      );
    }
    // Reassembled base64 decodes back to the original GRIB
    const reassembled = Buffer.from(data.payload.join(""), "base64");
    assert.strictEqual(
      reassembled.subarray(0, 4).toString("ascii"),
      "GRIB",
      "reassembled data should start with GRIB magic",
    );
    assert.strictEqual(reassembled.length, grib.length);
  });

  it("sets partType='grib' so InReachSender labels chunks correctly", async () => {
    // InReachSender uses `msg.partType || (msg.intent === 'GRIB' ? 'grib' :
    // 'text')`. Since the Saildocs path sets intent='SAILDOCS' (not 'GRIB'),
    // GribChunker MUST set partType='grib' explicitly, or the boat would
    // receive chunks labeled 'text' and couldn't tell them apart from
    // ordinary replies.
    const grib = Buffer.concat([
      Buffer.from("GRIB", "ascii"),
      Buffer.alloc(50, 0x42),
    ]);
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc",
      channel: "inreach",
      intent: "SAILDOCS",
      payload: grib,
    };

    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out");
    assert.strictEqual(
      data.partType,
      "grib",
      "GribChunker must set partType='grib'",
    );
  });

  it("accepts a base64 string payload and chunks it", async () => {
    const grib = Buffer.concat([
      Buffer.from("GRIB", "ascii"),
      Buffer.alloc(100, 0x43),
    ]);
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "boat@sea",
      channel: "winlink",
      intent: "SAILDOCS",
      payload: grib.toString("base64"),
    };

    const { data } = await runScenario({
      msg,
      controls: { max_chunk_size: 80 },
    });
    assert.ok(data, "should emit on out");
    assert.ok(Array.isArray(data.payload));
    assert.ok(data.payload.length > 1);
    for (const chunk of data.payload) {
      assert.ok(chunk.length <= 80);
    }
  });

  it("passes through failed messages unchanged", async () => {
    const msg = {
      errors: [{ message: "upstream failure" }],
      failed: true,
      identityHash: "dev1",
      replyTo: "boat@sea",
      channel: "inreach",
      intent: "SAILDOCS",
      payload: Buffer.from("not grib"),
    };

    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit failed message on out");
  });

  it("fails when payload is missing", async () => {
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "boat@sea",
      channel: "inreach",
      intent: "SAILDOCS",
      payload: null,
    };

    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out");
    assert.ok(data.errors?.length, "should have an error");
    assert.ok(
      data.errors.some((e) => e.message.includes("No GRIB data")),
      "should report missing GRIB data",
    );
  });

  it("uses a safe default chunk size for InReach (header + data ≤ 120 chars)", async () => {
    // Regression test: the default chunk size must keep the TOTAL InReach
    // message (envelope `msg i/total:grib:<id>\n` + base64 data) under ~120
    // chars. Garmin truncates messages around 130-140 chars (see
    // references/garmin-character-counts.txt), which corrupts the base64
    // and breaks reassembly. No `max_chunk_size` control is sent here, so
    // this tests the component's built-in default.
    const grib = Buffer.alloc(300, 0x41); // 300 bytes → 400 base64 chars
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://inreachlink.com/abc",
      channel: "inreach",
      intent: "SAILDOCS",
      payload: grib,
    };

    const { data } = await runScenario({ msg });
    assert.ok(data, "should emit on out");
    // Worst-case envelope header for double-digit chunk counts:
    // `msg 12/12:grib:rXXXXXX\n` = 23 chars.
    const maxHeader = 23;
    for (const chunk of data.payload) {
      assert.ok(
        chunk.length + maxHeader <= 120,
        `default chunk ${chunk.length} + ${maxHeader}-char header = ` +
          `${chunk.length + maxHeader} chars exceeds Garmin's ~120-char budget`,
      );
    }
  });
});
