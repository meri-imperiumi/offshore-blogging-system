import assert from "node:assert";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";
import Wrapper from "noflo-wrapper";

// Load the component via createRequire (CJS) rather than a dynamic ESM import.
// noflo's ComponentLoader requires components by absolute path, so to override
// the injectable `di.createClient` factory and have the component actually see
// the override, the test must share the *same* CJS module instance — which
// createRequire guarantees but ESM `import()` of a CJS file does not under
// `node --test`.
const require = createRequire(import.meta.url);
const senderModule = require("../components/InReachSender.js");

const REPLY_URL =
  "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc123guid&adr=someaddr";

// Build a mock client that records successful sends and optionally fails on a
// given (1-based) chunk number. `failOn` receives the chunk number about to be
// sent and may return a thrown error object (checked before the send is
// recorded, so `sends` only contains successful transmissions).
function makeMockClient(behavior = {}) {
  const sends = [];
  const client = {
    replyAddress: behavior.replyAddress ?? "cloud@boat.example",
    sends,
    send: async (url, message) => {
      if (behavior.failOn) {
        const fail = behavior.failOn(sends.length + 1);
        if (fail) {
          throw fail;
        }
      }
      sends.push({ url, message });
      return { ok: true, status: 200 };
    },
  };
  return { client, sends };
}

// Helper to run a component scenario with a given mock client and collect the
// first IP emitted on the requested port, with a timeout.
function runScenario({ client, port, msg, controls = {}, timeout = 3000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const t = new Wrapper("signalk-offshore-blogging/InReachSender");

    t.start()
      .then(() => {
        let received = null;
        t.outs[port].on("data", (data) => {
          // Control-port IIPs (replyaddress, delayms) trigger process
          // activations that flush a null data packet + disconnect on the
          // out/error port before the real result. Ignore nulls and capture
          // only the real payload.
          if (received === null && data != null) {
            received = data;
          }
        });
        t.outs[port].on("disconnect", () => {
          // Only resolve once the real payload's disconnect arrives.
          if (received !== null) {
            finish(() =>
              resolve({ received, sends: client ? client.sends : null }),
            );
          }
        });

        if (controls.replyaddress !== undefined) {
          t.ins.replyaddress.send(controls.replyaddress);
          t.ins.replyaddress.disconnect();
        }
        if (controls.delayms !== undefined) {
          t.ins.delayms.send(controls.delayms);
          t.ins.delayms.disconnect();
        }
        t.ins.in.send(msg);
        t.ins.in.disconnect();
      })
      .catch((err) => finish(() => reject(err)));

    const timer = setTimeout(
      () => finish(() => reject(new Error("timed out"))),
      timeout,
    );
  });
}

describe("InReachSender component", () => {
  let originalCreateClient;
  let originalGenerateTransmissionId;
  beforeEach(() => {
    originalCreateClient = senderModule.di.createClient;
    originalGenerateTransmissionId = senderModule.di.generateTransmissionId;
  });
  afterEach(() => {
    senderModule.di.createClient = originalCreateClient;
    senderModule.di.generateTransmissionId = originalGenerateTransmissionId;
  });

  it("bypasses failed messages to OUT unchanged", async () => {
    const { client } = makeMockClient();
    senderModule.di.createClient = () => client;

    const { received, sends } = await runScenario({
      client,
      port: "out",
      controls: { replyaddress: "cloud@boat.example" },
      msg: {
        errors: [{ message: "upstream failure" }],
        identityHash: "id",
        replyTo: REPLY_URL,
        channel: "inreach",
        intent: "NOTIFY",
        payload: ["x"],
      },
    });

    assert.ok(received, "should bypass the failed msg to OUT");
    assert.strictEqual(received.errors[0].message, "upstream failure");
    assert.strictEqual(sends.length, 0, "must not transmit anything");
  });

  it("fails to ERROR when replyaddress is not configured", async () => {
    const { client } = makeMockClient();
    senderModule.di.createClient = () => client;

    const { received, sends } = await runScenario({
      client,
      port: "out",
      controls: {}, // no replyaddress
      msg: {
        errors: [],
        identityHash: "id",
        replyTo: REPLY_URL,
        channel: "inreach",
        intent: "NOTIFY",
        payload: ["x"],
      },
    });

    assert.ok(received);
    assert.ok(
      received.errors.some((e) => e.code === "NOT_CONFIGURED"),
      `expected NOT_CONFIGURED, got ${JSON.stringify(received.errors)}`,
    );
    assert.strictEqual(sends.length, 0);
  });

  it("fails to ERROR when replyTo is missing or not an http URL", async () => {
    const { client } = makeMockClient();
    senderModule.di.createClient = () => client;

    const { received, sends } = await runScenario({
      client,
      port: "out",
      controls: { replyaddress: "cloud@boat.example" },
      msg: {
        errors: [],
        identityHash: "id",
        replyTo: "not-a-url",
        channel: "inreach",
        intent: "NOTIFY",
        payload: ["x"],
      },
    });

    assert.ok(received);
    assert.ok(
      received.errors.some((e) => e.code === "BAD_URL"),
      `expected BAD_URL, got ${JSON.stringify(received.errors)}`,
    );
    assert.strictEqual(sends.length, 0);
  });

  it("fails to ERROR when payload is not a non-empty array/string", async () => {
    const { client } = makeMockClient();
    senderModule.di.createClient = () => client;

    const { received, sends } = await runScenario({
      client,
      port: "out",
      controls: { replyaddress: "cloud@boat.example" },
      msg: {
        errors: [],
        identityHash: "id",
        replyTo: REPLY_URL,
        channel: "inreach",
        intent: "NOTIFY",
        payload: [],
      },
    });

    assert.ok(received);
    assert.ok(
      received.errors.some((e) =>
        e.message.includes("array of message chunks"),
      ),
    );
    assert.strictEqual(sends.length, 0);
  });

  it("sends a single chunk and emits a confirmation on OUT", async () => {
    const { client, sends } = makeMockClient();
    senderModule.di.createClient = () => client;

    const { received } = await runScenario({
      client,
      port: "out",
      controls: { replyaddress: "cloud@boat.example", delayms: 10 },
      msg: {
        errors: [],
        identityHash: "id",
        replyTo: REPLY_URL,
        channel: "inreach",
        intent: "NOTIFY",
        payload: ["hello inreach"],
      },
    });

    assert.ok(received, "should receive confirmation on OUT");
    assert.strictEqual(received.errors.length, 0);
    assert.strictEqual(received.intent, "NOTIFY");
    assert.match(received.payload, /Sent 1 message\(s\) via InReach/);
    assert.strictEqual(received.channel, "inreach");
    assert.strictEqual(received.identityHash, "id");
    assert.strictEqual(received.replyTo, REPLY_URL);
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].url, REPLY_URL);
    assert.strictEqual(sends[0].message, "hello inreach");
    assert.strictEqual(received.sentCount, 1, "confirm reports chunk count");
  });

  it("accepts a bare string payload (wraps to one chunk)", async () => {
    const { client, sends } = makeMockClient();
    senderModule.di.createClient = () => client;

    const { received } = await runScenario({
      client,
      port: "out",
      controls: { replyaddress: "cloud@boat.example", delayms: 10 },
      msg: {
        errors: [],
        identityHash: "id",
        replyTo: REPLY_URL,
        channel: "inreach",
        intent: "NOTIFY",
        payload: "just-a-string-chunk",
      },
    });

    assert.ok(received);
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].message, "just-a-string-chunk");
  });

  it("sends multiple chunks sequentially with a delay between them", async () => {
    const { client, sends } = makeMockClient();
    senderModule.di.createClient = () => client;
    // Pin the transmission id so the envelope assertions are deterministic.
    senderModule.di.generateTransmissionId = () => "TID1";

    const timestamps = [];
    const origSend = client.send.bind(client);
    client.send = async (url, message) => {
      timestamps.push(Date.now());
      return origSend(url, message);
    };

    const chunks = ["c1", "c2", "c3"];
    const { received } = await runScenario({
      client,
      port: "out",
      controls: { replyaddress: "cloud@boat.example", delayms: 100 },
      msg: {
        errors: [],
        identityHash: "id",
        replyTo: REPLY_URL,
        channel: "inreach",
        intent: "NOTIFY",
        payload: chunks,
      },
    });

    assert.ok(received);
    assert.strictEqual(sends.length, 3);
    assert.strictEqual(received.sentCount, 3, "confirm reports chunk count");
    // Multi-chunk payloads are wrapped in the compact header format:
    // [ID:4][Type:1][Index:2][Total:2]:[Payload]
    assert.strictEqual(sends[0].message, "TID1T0103:c1");
    assert.strictEqual(sends[1].message, "TID1T0203:c2");
    assert.strictEqual(sends[2].message, "TID1T0303:c3");
    // Two inter-chunk gaps, each ~>= 80ms with delayms=100.
    const gaps = [timestamps[1] - timestamps[0], timestamps[2] - timestamps[1]];
    assert.ok(gaps[0] >= 80, `gap0 too small: ${gaps[0]}`);
    assert.ok(gaps[1] >= 80, `gap1 too small: ${gaps[1]}`);
  });

  it("aborts on chunk failure and routes to ERROR with the distinguishable code", async () => {
    const { client, sends } = makeMockClient({
      // Fail on the second chunk with a SESSION_EXPIRED-shaped error.
      failOn: (count) =>
        count === 2
          ? {
              code: "SESSION_EXPIRED",
              status: 401,
              message: "InReach reply rejected (HTTP 401)",
            }
          : null,
    });
    senderModule.di.createClient = () => client;

    const { received } = await runScenario({
      client,
      port: "out",
      controls: { replyaddress: "cloud@boat.example", delayms: 10 },
      msg: {
        errors: [],
        identityHash: "id",
        replyTo: REPLY_URL,
        channel: "inreach",
        intent: "NOTIFY",
        payload: ["c1", "c2", "c3"],
      },
    });

    assert.ok(received);
    assert.ok(received.errors.length > 0);
    const err = received.errors[received.errors.length - 1];
    assert.strictEqual(err.code, "SESSION_EXPIRED");
    assert.strictEqual(err.status, 401);
    assert.match(err.message, /chunk 2\/3/);
    // Only the first chunk should have been transmitted successfully.
    assert.strictEqual(sends.length, 1);
    // First chunk of a multi-chunk payload is wrapped in compact header.
    assert.match(sends[0].message, /^[a-zA-Z0-9]{4}T0103:c1$/);
  });

  it("wraps multi-chunk payloads in compact headers the boat can reassemble", async () => {
    // Pin the id so the produced envelopes are byte-exact and can be
    // checked against the boat's actual MessageReassembler header regex.
    senderModule.di.generateTransmissionId = () => "ABC7";
    const { client, sends } = makeMockClient();
    senderModule.di.createClient = () => client;

    const chunks = ["part-a", "part-b"];
    await runScenario({
      client,
      port: "out",
      controls: { replyaddress: "cloud@boat.example", delayms: 1 },
      msg: {
        errors: [],
        identityHash: "id",
        replyTo: REPLY_URL,
        channel: "inreach",
        intent: "NOTIFY",
        payload: chunks,
      },
    });

    // The boat's MessageReassembler.parseChunkHeaders uses this exact regex
    // (Unified Compact Header Protocol). If the sender ever drifts from it,
    // multi-chunk delivery silently breaks on the boat side.
    const headerRe = /^([a-zA-Z0-9]{4})([A-Za-z])(\d{2})(\d{2}):(.*)$/s;
    const parsed = sends.map((s) => {
      const m = s.message.match(headerRe);
      assert.ok(m, `chunk not in compact header: ${JSON.stringify(s.message)}`);
      return {
        transmissionId: m[1],
        typeChar: m[2].toUpperCase(),
        chunk: parseInt(m[3], 10),
        total: parseInt(m[4], 10),
        body: m[5],
      };
    });
    assert.deepStrictEqual(
      parsed.map((p) => p.body),
      chunks,
      "compact header must not corrupt the payload body",
    );
    assert.deepStrictEqual(
      parsed.map((p) => p.chunk),
      [1, 2],
      "chunks must be 1-based and sequential",
    );
    assert.strictEqual(parsed[0].total, 2);
    assert.ok(
      parsed.every((p) => p.transmissionId === "ABC7"),
      "all chunks of a sequence share one transmissionId",
    );
    assert.ok(
      parsed.every((p) => p.typeChar === "T"),
      "default typeChar is 'T' (text)",
    );
  });

  it("labels GRIB deliveries with the 'G' type character", async () => {
    const { client, sends } = makeMockClient();
    senderModule.di.createClient = () => client;
    senderModule.di.generateTransmissionId = () => "G1id";

    await runScenario({
      client,
      port: "out",
      controls: { replyaddress: "cloud@boat.example", delayms: 1 },
      msg: {
        errors: [],
        identityHash: "id",
        replyTo: REPLY_URL,
        channel: "inreach",
        intent: "GRIB",
        payload: ["Z3JpYjE=", "Z3JpYjI="],
      },
    });

    // Compact header: [ID:4][G][Index:2][Total:2]:[Payload]
    assert.match(sends[0].message, /^G1idG0102:Z3JpYjE=$/);
    assert.match(sends[1].message, /^G1idG0202:Z3JpYjI=$/);
  });

  it("does not envelope a single-chunk payload", async () => {
    const { client, sends } = makeMockClient();
    senderModule.di.createClient = () => client;

    await runScenario({
      client,
      port: "out",
      controls: { replyaddress: "cloud@boat.example", delayms: 1 },
      msg: {
        errors: [],
        identityHash: "id",
        replyTo: REPLY_URL,
        channel: "inreach",
        intent: "GRIB",
        payload: ["Z3JpYjE="],
      },
    });

    // Single chunk: sent as-is, so the boat's reassembler passes it through.
    assert.strictEqual(sends[0].message, "Z3JpYjE=");
  });
});
