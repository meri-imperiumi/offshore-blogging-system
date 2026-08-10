import assert from "node:assert";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import Wrapper from "noflo-wrapper";

const require = createRequire(import.meta.url);
const _gateModule = require("../components/GribGate.js");

const DB_PATH = "/tmp/grib-gate-test.db";

/**
 * Run a GribGate scenario. Resolves the first IP on the requested port (or
 * null on timeout). Cleans the DB file before each scenario so gates don't
 * leak state between tests.
 */
function runScenario({ msg, controls = {}, port = "out", timeout = 1500 }) {
  rmSync(DB_PATH, { force: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const t = new Wrapper("signalk-offshore-blogging/GribGate");
    const collected = {};
    const errors = [];
    t.start()
      .then(() => {
        // Capture process errors — a bare output.sendDone(msg) on a
        // component with >1 out port throws "Port must be specified for
        // sending output", which we must NOT see.
        t.network.on("process-error", (err) => {
          errors.push(err.error?.message || err.message);
        });
        t.outs[port]?.on("data", (data) => {
          collected[port] = data;
          finish(() => resolve({ data, collected, errors }));
        });
        for (const [key, value] of Object.entries(controls)) {
          t.ins[key].send(value);
        }
        t.ins.in.send(msg);
      })
      .catch(reject);
    const timer = setTimeout(
      () => finish(() => resolve({ data: null, collected, errors })),
      timeout,
    );
  });
}

describe("GribGate", () => {
  it("exists and exports getComponent", () => {
    assert.strictEqual(typeof _gateModule.getComponent, "function");
  });

  it("passes small payloads through on `out` without error", async () => {
    // Reproduces the original bug: a bare output.sendDone(msg) on the
    // pass-through path threw "Port must be specified for sending output"
    // because GribGate has two out ports (out, notify), silently killing
    // every GRIB delivery that was under the threshold.
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://inreachlink.com/abc",
      channel: "inreach",
      intent: "GRIB",
      payload: ["a", "b", "c", "d", "e", "f", "g", "h"], // 8 <= 10 threshold
      partType: "grib",
    };

    const { data, errors } = await runScenario({
      msg,
      controls: { max_chunks: 10, dbpath: DB_PATH },
      port: "out",
    });

    assert.ok(data, "should emit on out port");
    assert.deepStrictEqual(
      data.errors,
      [],
      "pass-through should not fail the message",
    );
    assert.deepStrictEqual(
      errors,
      [],
      `should not throw process errors, got: ${JSON.stringify(errors)}`,
    );
    assert.deepStrictEqual(data.payload, msg.payload, "payload unchanged");
    assert.strictEqual(data.channel, "inreach", "routing context preserved");
  });

  it("gates large payloads and emits a NOTIFY on `notify`", async () => {
    const chunks = Array.from({ length: 12 }, (_, i) => `chunk${i}`);
    const msg = {
      errors: [],
      identityHash: "dev1",
      replyTo: "https://inreachlink.com/abc",
      channel: "inreach",
      intent: "GRIB",
      payload: chunks, // 12 > 10 threshold
      partType: "grib",
    };

    const { data, errors } = await runScenario({
      msg,
      controls: { max_chunks: 10, dbpath: DB_PATH },
      port: "notify",
    });

    assert.ok(data, "should emit a consent notification on notify");
    assert.strictEqual(data.intent, "NOTIFY");
    assert.ok(
      /consent/.test(data.payload),
      "notification should ask for consent",
    );
    assert.deepStrictEqual(
      errors,
      [],
      `should not throw process errors, got: ${JSON.stringify(errors)}`,
    );
  });

  it("forwards failed messages on `out` without throwing", async () => {
    // failed(msg) sets an error; GribGate must still use an explicit port
    // map (not a bare sendDone) so it doesn't throw on the 2-out-port path.
    const msg = {
      errors: [{ message: "upstream failure" }],
      identityHash: "dev1",
      replyTo: "https://inreachlink.com/abc",
      channel: "inreach",
      intent: "GRIB",
      payload: ["a"],
    };

    const { data, errors } = await runScenario({
      msg,
      controls: { max_chunks: 10, dbpath: DB_PATH },
      port: "out",
    });

    assert.ok(data, "failed message should still emit on out");
    assert.deepStrictEqual(
      errors,
      [],
      `should not throw process errors, got: ${JSON.stringify(errors)}`,
    );
  });
});
