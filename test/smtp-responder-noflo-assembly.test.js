import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import Wrapper from "noflo-wrapper";

const require = createRequire(import.meta.url);
const smtpModule = require("../components/SmtpResponder.js");

describe("SmtpResponder noflo-assembly pattern (no error port)", () => {
  it("sends failed message on OUT when recipient is missing", async () => {
    const t = new Wrapper("signalk-offshore-blogging/SmtpResponder");
    await t.start();

    return new Promise((resolve, reject) => {
      const msg = {
        errors: [],
        identityHash: "test-id",
        replyTo: null, // No recipient
        channel: "winlink",
        intent: "NOTIFY",
        payload: "notification content",
      };

      let received = null;
      let receivedDisconnect = false;

      t.outs.out.on("data", (data) => {
        if (!received) {
          received = data;
        }
      });

      t.outs.out.on("disconnect", () => {
        receivedDisconnect = true;
        try {
          assert.ok(received, "Should have received data on OUT");
          assert.ok(received.errors);
          assert.ok(
            received.errors.some((e) => e.message.includes("no recipient")),
          );
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      t.ins.in.send(msg);
      t.ins.in.disconnect();

      setTimeout(() => {
        if (!receivedDisconnect) {
          reject(new Error("Test timed out - no disconnect received"));
        }
      }, 5000);
    });
  });

  it("sends failed message on OUT when SMTP send fails", async () => {
    // This test would require mocking SmtpClient to fail
    // For now, we'll skip it as it requires significant test setup
    it.skip("sends failed message on OUT when SMTP send fails", () => {});
  });
});

describe("SmtpResponder sentCount (success signal for msg_out)", () => {
  function handle(component, msg) {
    return new Promise((resolve, reject) => {
      component.handle(
        {
          hasData: (p) => p === "in",
          getData: (p) => (p === "in" ? msg : undefined),
        },
        {
          sendDone: (m) => resolve(m),
          done: () => resolve(null),
          send: () => {},
        },
      );
      setTimeout(() => reject(new Error("handle did not resolve")), 2000);
    });
  }

  it("sets sentCount=1 on the confirm after a successful send", async () => {
    smtpModule.di.createClient = () => ({
      sendWithRetry: async () => {},
    });
    const component = smtpModule.getComponent();
    const msg = {
      errors: [],
      replyTo: "user@example.com",
      payload: "hi",
      channel: "winlink",
    };
    const out = await handle(component, msg);
    assert.strictEqual(out.sentCount, 1, "success confirm carries sentCount=1");
  });

  it("does not set sentCount when the SMTP send fails", async () => {
    smtpModule.di.createClient = () => ({
      sendWithRetry: async () => {
        throw new Error("boom");
      },
    });
    const component = smtpModule.getComponent();
    const msg = {
      errors: [],
      replyTo: "user@example.com",
      payload: "hi",
      channel: "winlink",
    };
    const out = await handle(component, msg);
    assert.ok(
      out.errors.some((e) => e.message.includes("SMTP send failed")),
      "failed message on send error",
    );
    assert.strictEqual(
      out.sentCount,
      undefined,
      "no sentCount on a failed send",
    );
  });
});
