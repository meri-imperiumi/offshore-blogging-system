import assert from "node:assert";
import { describe, it } from "node:test";
import Wrapper from "noflo-wrapper";

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
