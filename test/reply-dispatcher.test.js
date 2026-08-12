import assert from "node:assert";
import { describe, it } from "node:test";
import Wrapper from "noflo-wrapper";

describe("ReplyDispatcher component", () => {
  it("routes winlink channel to SMTP port", async () => {
    const t = new Wrapper("signalk-offshore-blogging/ReplyDispatcher");
    await t.start();

    return new Promise((resolve, reject) => {
      const msg = {
        errors: [],
        identityHash: "test-id",
        replyTo: "test@winlink.org",
        channel: "winlink",
        intent: "NOTIFY",
        payload: "notification content",
      };

      let received = null;
      let receivedDisconnect = false;

      t.outs.smtp.on("data", (data) => {
        if (!received) {
          received = data;
        }
      });

      t.outs.smtp.on("disconnect", () => {
        receivedDisconnect = true;
        try {
          assert.ok(received, "Should have received data");
          assert.strictEqual(received.channel, "winlink");
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

  it("routes inreach channel to INREACH port", async () => {
    const t = new Wrapper("signalk-offshore-blogging/ReplyDispatcher");
    await t.start();

    return new Promise((resolve, reject) => {
      const msg = {
        errors: [],
        identityHash: "test-id",
        replyTo: "test@inreach.garmin.com",
        channel: "inreach",
        intent: "NOTIFY",
        payload: "notification content",
      };

      let received = null;
      let receivedDisconnect = false;

      t.outs.inreach.on("data", (data) => {
        if (!received) {
          received = data;
        }
      });

      t.outs.inreach.on("disconnect", () => {
        receivedDisconnect = true;
        try {
          assert.ok(received, "Should have received data");
          assert.strictEqual(received.channel, "inreach");
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

  it("routes messages with missing channel to SMTP port as failed", async () => {
    const t = new Wrapper("signalk-offshore-blogging/ReplyDispatcher");
    await t.start();

    return new Promise((resolve, reject) => {
      const msg = {
        errors: [],
        identityHash: "test-id",
        replyTo: "test@example.com",
        intent: "NOTIFY",
        payload: "notification content",
      };

      let received = null;
      let receivedDisconnect = false;

      t.outs.smtp.on("data", (data) => {
        if (!received) {
          received = data;
        }
      });

      t.outs.smtp.on("disconnect", () => {
        receivedDisconnect = true;
        try {
          assert.ok(received, "Should have received data");
          assert.ok(received.errors);
          assert.ok(
            received.errors.some((e) => e.message.includes("Missing channel")),
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

  it("routes messages with unknown channel to SMTP port as failed", async () => {
    const t = new Wrapper("signalk-offshore-blogging/ReplyDispatcher");
    await t.start();

    return new Promise((resolve, reject) => {
      const msg = {
        errors: [],
        identityHash: "test-id",
        replyTo: "test@example.com",
        channel: "unknown_channel",
        intent: "NOTIFY",
        payload: "notification content",
      };

      let received = null;
      let receivedDisconnect = false;

      t.outs.smtp.on("data", (data) => {
        if (!received) {
          received = data;
        }
      });

      t.outs.smtp.on("disconnect", () => {
        receivedDisconnect = true;
        try {
          assert.ok(received, "Should have received data");
          assert.ok(received.errors);
          assert.ok(
            received.errors.some((e) =>
              e.message.includes("Unrecognized channel"),
            ),
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

  it("routes failed messages to SMTP port as failed", async () => {
    const t = new Wrapper("signalk-offshore-blogging/ReplyDispatcher");
    await t.start();

    return new Promise((resolve, reject) => {
      const msg = {
        errors: [{ message: "upstream error" }],
        identityHash: "test-id",
        replyTo: "test@example.com",
        channel: "winlink",
        intent: "NOTIFY",
        payload: "notification content",
      };

      let received = null;
      let receivedDisconnect = false;

      t.outs.smtp.on("data", (data) => {
        if (!received) {
          received = data;
        }
      });

      t.outs.smtp.on("disconnect", () => {
        receivedDisconnect = true;
        try {
          assert.ok(received, "Should have received data");
          assert.ok(received.errors);
          assert.strictEqual(received.errors[0].message, "upstream error");
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

  it("routes failed inreach messages to INREACH port", async () => {
    const t = new Wrapper("signalk-offshore-blogging/ReplyDispatcher");
    await t.start();

    return new Promise((resolve, reject) => {
      const msg = {
        errors: [{ message: "upstream error" }],
        identityHash: "test-id",
        replyTo: "test@inreach.garmin.com",
        channel: "inreach",
        intent: "NOTIFY",
        payload: "notification content",
      };

      let received = null;
      let receivedDisconnect = false;

      t.outs.inreach.on("data", (data) => {
        if (!received) {
          received = data;
        }
      });

      t.outs.inreach.on("disconnect", () => {
        receivedDisconnect = true;
        try {
          assert.ok(received, "Should have received data");
          assert.ok(received.errors);
          assert.strictEqual(received.errors[0].message, "upstream error");
          assert.strictEqual(received.channel, "inreach");
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
});
