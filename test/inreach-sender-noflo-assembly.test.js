import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import Wrapper from "noflo-wrapper";

const require = createRequire(import.meta.url);
const senderModule = require("../components/InReachSender.js");

const REPLY_URL =
  "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc123guid&adr=someaddr";

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

function runScenario({ client, port, msg, controls = {}, timeout = 3000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const t = new Wrapper("signalk-offshore-blogging/InReachSender");

    t.start()
      .then(() => {
        let received = null;
        t.outs[port].on("data", (data) => {
          if (received === null && data != null) {
            received = data;
          }
        });
        t.outs[port].on("disconnect", () => {
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
      .catch(reject);

    const timer = setTimeout(() => {
      finish(() => reject(new Error("timeout")));
    }, timeout);
  });
}

describe("InReachSender noflo-assembly pattern (no error port)", () => {
  it("sends failed message on OUT when replyaddress not configured", async () => {
    const { client } = makeMockClient();
    senderModule.di.createClient = () => client;

    const { received, sends } = await runScenario({
      client,
      port: "out",
      controls: {},
      msg: {
        errors: [],
        identityHash: "id",
        replyTo: REPLY_URL,
        channel: "inreach",
        intent: "NOTIFY",
        payload: ["x"],
      },
    });

    assert.ok(received, "should receive a message on OUT");
    assert.ok(
      received.errors.some((e) => e.code === "NOT_CONFIGURED"),
      `expected NOT_CONFIGURED in errors, got ${JSON.stringify(received.errors)}`,
    );
    assert.strictEqual(sends.length, 0, "should not attempt any sends");
  });

  it("sends failed message on OUT when replyTo is missing or not an http URL", async () => {
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

  it("sends failed message on OUT when payload is not a non-empty array/string", async () => {
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

  it("sends failed message on OUT when chunk fails with SESSION_EXPIRED", async () => {
    const { client, sends } = makeMockClient({
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
    assert.ok(received.errors.length > 0, "should have errors");
    const err = received.errors[received.errors.length - 1];
    assert.strictEqual(err.code, "SESSION_EXPIRED");
    assert.strictEqual(err.status, 401);
    assert.match(err.message, /chunk 2\/3/);
    assert.strictEqual(sends.length, 1);
    assert.match(sends[0].message, /^[a-zA-Z0-9]{4}T0103:c1$/);
  });
});
