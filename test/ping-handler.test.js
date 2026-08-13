import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

// Load component via createRequire so the test shares the component's CJS module instance
const require = createRequire(import.meta.url);
const PingHandlerModule = require("../components/PingHandler.js");

describe("PingHandler component", () => {
  it("exists and exports getComponent", () => {
    assert.strictEqual(typeof PingHandlerModule.getComponent, "function");
  });

  it("creates a component without crashing", () => {
    const component = PingHandlerModule.getComponent();
    assert(component !== null);
    assert.strictEqual(typeof component.handle, "function");
  });

  it("responds with PONG for InReach messages", () => {
    const component = PingHandlerModule.getComponent();
    const captured = [];
    // Stub the output to capture the sent message
    const fakeOutput = {
      sendDone: (msg) => {
        captured.push(msg);
      },
      send: () => {},
      done: () => {},
    };

    const msg = {
      channel: "inreach",
      payload: "PING",
      sender: "user@inreach.garmin.com",
    };
    component.handle({ hasData: () => true, getData: () => msg }, fakeOutput);

    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].payload, "PONG");
    assert.strictEqual(captured[0].intent, "NOTIFY");
    assert.strictEqual(captured[0].channel, "inreach");
    assert.strictEqual(captured[0].sender, "user@inreach.garmin.com");
  });

  it("responds with PONG for Winlink messages", () => {
    const component = PingHandlerModule.getComponent();
    const captured = [];
    const fakeOutput = {
      sendDone: (msg) => {
        captured.push(msg);
      },
      send: () => {},
      done: () => {},
    };

    const msg = {
      channel: "winlink",
      payload: "PING",
      sender: "user@winlink.org",
    };
    component.handle({ hasData: () => true, getData: () => msg }, fakeOutput);

    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].payload, "PONG");
    assert.strictEqual(captured[0].intent, "NOTIFY");
    assert.strictEqual(captured[0].channel, "winlink");
  });

  it("preserves all message properties", () => {
    const component = PingHandlerModule.getComponent();
    const captured = [];
    const fakeOutput = {
      sendDone: (msg) => {
        captured.push(msg);
      },
      send: () => {},
      done: () => {},
    };

    const msg = {
      channel: "inreach",
      payload: "PING",
      sender: "test@example.com",
      subject: "Test",
      messageId: "12345",
    };
    component.handle({ hasData: () => true, getData: () => msg }, fakeOutput);

    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].payload, "PONG");
    assert.strictEqual(captured[0].intent, "NOTIFY");
    assert.strictEqual(captured[0].channel, "inreach");
    assert.strictEqual(captured[0].sender, "test@example.com");
    assert.strictEqual(captured[0].subject, "Test");
    assert.strictEqual(captured[0].messageId, "12345");
  });
});
