import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import Wrapper from "noflo-wrapper";

// Load via createRequire so the test shares the component's CJS module
// instance (same reasoning as the InReachSender/AlertComposer tests).
const require = createRequire(import.meta.url);
const statusModule = require("../components/StatusBuilder.js");
const DatabaseHelper = require("../lib/DbHelper.js");

/**
 * Build a pre-populated in-memory DbHelper with the given pending state, then
 * run a STATUS request through StatusBuilder and resolve the NOTIFY reply.
 */
function runStatus({ gates = 0, saildocs = 0, sequences = [] }) {
  return new Promise((resolve, reject) => {
    // Pre-populate a real in-memory DB; inject it via the di seam.
    const db = new DatabaseHelper(":memory:");
    db.initialize();
    for (let i = 0; i < gates; i++) {
      db.saveGribGate(`id-${i}`, `G${i}`, "r@x.com", "inreach", ["c1"]);
    }
    for (let i = 0; i < saildocs; i++) {
      db.savePendingSaildocs(`q${i}`, `id-${i}`, "r@x.com", "winlink");
    }
    for (const seq of sequences) {
      // One buffered chunk per sequence is enough to count a pending sequence.
      db.saveBufferChunk(
        seq.identityHash,
        seq.transmissionId,
        seq.partType,
        1,
        2,
        "r@x.com",
        "inreach",
        "chunk-data",
      );
    }
    statusModule.di.createDatabase = () => db;

    const t = new Wrapper("signalk-offshore-blogging/StatusBuilder");
    let received = null;
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for STATUS reply")),
      3000,
    );
    t.start()
      .then(() => {
        t.outs.out.on("data", (data) => {
          if (received === null && data != null) {
            received = data;
            clearTimeout(timer);
            resolve({ received });
          }
        });
        t.ins.in.send({
          errors: [],
          identityHash: "boat-status",
          replyTo: "boat@x.com",
          channel: "inreach",
          intent: "SYS",
          payload: "STATUS",
        });
        t.ins.in.disconnect();
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

describe("StatusBuilder component", () => {
  it("reports zero pending gates/saildocs/sequences when DB is empty", async () => {
    const { received } = await runStatus({});
    assert.ok(received);
    assert.strictEqual(received.intent, "NOTIFY");
    assert.strictEqual(received.channel, "inreach", "channel preserved");
    assert.match(received.payload, /Pending gates: 0/);
    assert.match(received.payload, /Pending Saildocs: 0/);
    assert.match(received.payload, /Pending seqs: 0/);
  });

  it("counts pending GRIB gates in the status output", async () => {
    const { received } = await runStatus({ gates: 3 });
    assert.match(received.payload, /Pending gates: 3/);
  });

  it("counts pending Saildocs queries in the status output", async () => {
    const { received } = await runStatus({ saildocs: 2 });
    assert.match(received.payload, /Pending Saildocs: 2/);
  });

  it("counts distinct pending multi-part sequences", async () => {
    const { received } = await runStatus({
      sequences: [
        { identityHash: "a", transmissionId: "T1", partType: "text" },
        { identityHash: "a", transmissionId: "T1", partType: "image" },
        { identityHash: "b", transmissionId: "T9", partType: "text" },
      ],
    });
    // Two distinct (identity, transmission) keys → 2 pending sequences,
    // even though 3 chunk rows exist (text+image under one transmission).
    assert.match(received.payload, /Pending seqs: 2/);
  });

  it("bypasses failed messages unchanged", async () => {
    const t = new Wrapper("signalk-offshore-blogging/StatusBuilder");
    let received = null;
    const timer = setTimeout(
      () => reject(new Error("timed out")),
      3000,
    );
    await new Promise((resolve, reject) => {
      t.start()
        .then(() => {
          t.outs.out.on("data", (data) => {
            if (received === null && data != null) {
              received = data;
              clearTimeout(timer);
              resolve();
            }
          });
          t.ins.in.send({
            errors: [{ message: "upstream failure" }],
            identityHash: "x",
            replyTo: "x",
            channel: "inreach",
            intent: "SYS",
            payload: "STATUS",
          });
          t.ins.in.disconnect();
        })
        .catch(reject);
    });
    assert.ok(received, "failed msg should pass through");
    assert.strictEqual(received.errors[0].message, "upstream failure");
    assert.notStrictEqual(
      received.intent,
      "NOTIFY",
      "must not reformat a bypassed failed msg",
    );
  });
});
