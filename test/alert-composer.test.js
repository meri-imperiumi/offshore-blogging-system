import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import Wrapper from "noflo-wrapper";

// Load the component via createRequire so the test shares the component's CJS
// module instance (noflo's ComponentLoader requires by absolute path).
const require = createRequire(import.meta.url);

// Build a failed assembly message carrying an InReachError-shaped error.
function failedMsg({ code, message, intent = "GRIB", identityHash = "id-1" }) {
  return {
    errors: [
      {
        code,
        message: message || `InReach transmission failed: ${code}`,
        status: code === "SESSION_EXPIRED" ? 401 : undefined,
      },
    ],
    identityHash,
    replyTo:
      "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc123guid&adr=x",
    channel: "inreach",
    intent,
    payload: ["c1", "c2"],
  };
}

/**
 * Run one message through AlertComposer. Resolves with { received } — the
 * first non-null IP on `out`, or null if nothing arrived within `quietMs`.
 *
 * For tests that EXPECT output: leave quietMs at the default (== timeout)
 * so the test resolves early on data and FAILS with a timeout if nothing
 * arrives (catches a broken pass-through). For tests that expect NO output
 * (drop/rate-limit paths), pass a small quietMs (e.g. 300) so the test
 * resolves with null after confirming silence.
 */
function runOnce({ msg, controls = {}, quietMs = 3000, timeout = 3000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(deadTimer);
      fn();
    };
    const t = new Wrapper("signalk-offshore-blogging/AlertComposer");
    let received = null;
    const deadTimer = setTimeout(
      () => finish(() => reject(new Error("timed out waiting for activation"))),
      timeout,
    );
    // If nothing arrives within quietMs, resolve with null (drop-path check).
    const quietTimer = setTimeout(
      () => finish(() => resolve({ received })),
      quietMs,
    );
    t.start()
      .then(() => {
        t.outs.out.on("data", (data) => {
          if (received === null && data != null) {
            received = data;
            finish(() => resolve({ received }));
          }
        });
        if (controls.alertaddress !== undefined) {
          t.ins.alertaddress.send(controls.alertaddress);
          t.ins.alertaddress.disconnect();
        }
        if (controls.ratelimitms !== undefined) {
          t.ins.ratelimitms.send(controls.ratelimitms);
          t.ins.ratelimitms.disconnect();
        }
        t.ins.in.send(msg);
        t.ins.in.disconnect();
      })
      .catch((err) => finish(() => reject(err)));
  });
}

// Fresh component instance per test: noflo-wrapper creates one per Wrapper,
// so rate-limit state doesn't leak across tests within a runOnce. But the
// rate-limit tests below send two messages to the SAME instance, so they use
// a dedicated helper that holds one Wrapper open across both sends.
function runTwice({
  msg1,
  msg2,
  controls = {},
  quietMs = 200,
  sendDelayMs = 80,
  timeout = 4000,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(deadTimer);
      fn();
    };
    const t = new Wrapper("signalk-offshore-blogging/AlertComposer");
    const received = [];
    const deadTimer = setTimeout(
      () => finish(() => reject(new Error("timed out"))),
      timeout,
    );
    const quietTimer = setTimeout(
      () => finish(() => resolve({ received })),
      quietMs * 4, // long enough to observe whether the 2nd send emitted
    );
    t.start()
      .then(() => {
        t.outs.out.on("data", (data) => {
          if (data != null) received.push(data);
        });
        if (controls.alertaddress !== undefined) {
          t.ins.alertaddress.send(controls.alertaddress);
          t.ins.alertaddress.disconnect();
        }
        if (controls.ratelimitms !== undefined) {
          t.ins.ratelimitms.send(controls.ratelimitms);
          t.ins.ratelimitms.disconnect();
        }
        t.ins.in.send(msg1);
        t.ins.in.disconnect();
        // Send the second message after the first has had time to process.
        setTimeout(() => {
          t.ins.in.send(msg2);
          t.ins.in.disconnect();
        }, sendDelayMs);
      })
      .catch((err) => finish(() => reject(err)));
  });
}

describe("AlertComposer component", () => {
  it("passes non-failed messages through to OUT unchanged", async () => {
    const t = require("../components/AlertComposer.js");
    // sanity: component exports getComponent
    assert.strictEqual(typeof t.getComponent, "function");

    const msg = {
      errors: [],
      identityHash: "id",
      replyTo: "someone@example.com",
      channel: "winlink",
      intent: "NOTIFY",
      payload: "not an error",
    };
    const { received } = await runOnce({
      msg,
      controls: { alertaddress: "ops@example.com" },
    });
    assert.ok(received, "non-failed msg should pass through");
    assert.strictEqual(received.payload, "not an error");
  });

  it("alerts on SESSION_EXPIRED (unrecoverable)", async () => {
    const { received } = await runOnce({
      msg: failedMsg({ code: "SESSION_EXPIRED" }),
      controls: { alertaddress: "ops@example.com" },
    });
    assert.ok(received, "should emit an alert");
    assert.strictEqual(received.replyTo, "ops@example.com");
    assert.strictEqual(received.channel, "winlink");
    assert.strictEqual(received.intent, "NOTIFY");
    assert.match(received.notifyText, /\[InReach Alert\] SESSION_EXPIRED/);
    // First line becomes the email subject.
    assert.strictEqual(
      received.notifyText.split("\n")[0],
      "[InReach Alert] SESSION_EXPIRED",
    );
  });

  it("alerts on BAD_URL (unrecoverable)", async () => {
    const { received } = await runOnce({
      msg: failedMsg({ code: "BAD_URL" }),
      controls: { alertaddress: "ops@example.com" },
    });
    assert.ok(received);
    assert.match(received.notifyText, /\[InReach Alert\] BAD_URL/);
  });

  it("alerts on NOT_CONFIGURED (unrecoverable)", async () => {
    const { received } = await runOnce({
      msg: failedMsg({ code: "NOT_CONFIGURED" }),
      controls: { alertaddress: "ops@example.com" },
    });
    assert.ok(received);
    assert.match(received.notifyText, /\[InReach Alert\] NOT_CONFIGURED/);
  });

  it("alerts on BAD_RESPONSE (200+HTML — channel looks dead)", async () => {
    const { received } = await runOnce({
      msg: failedMsg({ code: "BAD_RESPONSE" }),
      controls: { alertaddress: "ops@example.com" },
    });
    assert.ok(received);
    assert.match(received.notifyText, /\[InReach Alert\] BAD_RESPONSE/);
  });

  it("drops RATE_LIMITED (transient) — no alert", async () => {
    const { received } = await runOnce({
      msg: failedMsg({ code: "RATE_LIMITED" }),
      controls: { alertaddress: "ops@example.com" },
      quietMs: 300,
    });
    assert.strictEqual(received, null, "transient failures must not alert");
  });

  it("drops NETWORK_ERROR (transient) — no alert", async () => {
    const { received } = await runOnce({
      msg: failedMsg({ code: "NETWORK_ERROR" }),
      controls: { alertaddress: "ops@example.com" },
      quietMs: 300,
    });
    assert.strictEqual(received, null);
  });

  it("drops API_FAILURE (transient by default) — no alert", async () => {
    const { received } = await runOnce({
      msg: failedMsg({ code: "API_FAILURE" }),
      controls: { alertaddress: "ops@example.com" },
      quietMs: 300,
    });
    assert.strictEqual(received, null);
  });

  it("alerts on a failed msg whose error has no code (UNCLASSIFIED)", async () => {
    const msg = {
      errors: [{ message: "something broke" }], // no .code
      identityHash: "id",
      replyTo: "x",
      channel: "inreach",
      intent: "GRIB",
      payload: ["c1"],
    };
    const { received } = await runOnce({
      msg,
      controls: { alertaddress: "ops@example.com" },
    });
    assert.ok(received, "no-code errors should alert (fail-open)");
    assert.match(received.notifyText, /\[ALERT\] UNCLASSIFIED/);
    assert.match(received.notifyText, /something broke/);
  });

  it("alerts on an unknown error code (fail-open)", async () => {
    const { received } = await runOnce({
      msg: failedMsg({ code: "SOMETHING_NEW" }),
      controls: { alertaddress: "ops@example.com" },
    });
    assert.ok(received, "unknown codes should alert (fail-open)");
    assert.match(received.notifyText, /\[UNKNOWN ALERT\] SOMETHING_NEW/);
  });

  it("drops everything when alertaddress is not configured", async () => {
    const { received } = await runOnce({
      msg: failedMsg({ code: "SESSION_EXPIRED" }),
      controls: {}, // no alertaddress
      quietMs: 300,
    });
    assert.strictEqual(received, null);
  });

  it("rate-limits: second alert of the same code within the window is dropped", async () => {
    const { received } = await runTwice({
      msg1: failedMsg({ code: "SESSION_EXPIRED", identityHash: "boat-A" }),
      msg2: failedMsg({ code: "SESSION_EXPIRED", identityHash: "boat-B" }),
      controls: { alertaddress: "ops@example.com", ratelimitms: 60000 },
    });
    // First alerts, second is rate-limited out.
    assert.strictEqual(received.length, 1, "only the first should alert");
    assert.match(received[0].notifyText, /SESSION_EXPIRED/);
  });

  it("rate limit is per-code: a different code within the window still alerts", async () => {
    const { received } = await runTwice({
      msg1: failedMsg({ code: "SESSION_EXPIRED" }),
      msg2: failedMsg({ code: "BAD_URL" }),
      controls: { alertaddress: "ops@example.com", ratelimitms: 60000 },
    });
    assert.strictEqual(received.length, 2, "different codes each alert");
    assert.match(received[0].notifyText, /SESSION_EXPIRED/);
    assert.match(received[1].notifyText, /BAD_URL/);
  });

  it("rate limit expires: same code alerts again after the window passes", async () => {
    // Use a tiny window so the test doesn't wait a real hour, but leave a
    // generous gap between the two sends so noflo's processing delay can't
    // make the 2nd land inside the window by accident.
    const { received } = await runTwice({
      msg1: failedMsg({ code: "SESSION_EXPIRED" }),
      msg2: failedMsg({ code: "SESSION_EXPIRED" }),
      controls: { alertaddress: "ops@example.com", ratelimitms: 50 },
      quietMs: 100,
      sendDelayMs: 250,
    });
    // With a 50ms window and the 2nd send at ~250ms, the 2nd should alert.
    assert.strictEqual(
      received.length,
      2,
      "same code should alert again after the window expires",
    );
  });

  it("alert body includes original intent, identity and reply URL for traceability", async () => {
    const { received } = await runOnce({
      msg: failedMsg({
        code: "SESSION_EXPIRED",
        intent: "GRIB",
        identityHash: "boat-123",
        replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=abc",
      }),
      controls: { alertaddress: "ops@example.com" },
    });
    assert.ok(received);
    const body = received.notifyText;
    assert.match(body, /Original intent: GRIB/);
    assert.match(body, /Identity: boat-123/);
    assert.match(body, /explore\.garmin\.com/);
  });
});
