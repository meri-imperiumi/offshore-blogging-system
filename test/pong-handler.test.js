import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

// Load component via createRequire so the test shares the component's CJS module instance
const require = createRequire(import.meta.url);
const PongHandlerModule = require("../components/PongHandler.js");

describe("PongHandler component", () => {
  it("exists and exports getComponent", () => {
    assert.strictEqual(typeof PongHandlerModule.getComponent, "function");
  });

  it("creates a component without crashing", () => {
    const component = PongHandlerModule.getComponent();
    assert(component !== null);
    assert.strictEqual(typeof component.handle, "function");
  });

  it("responds with PONG when payload first line is PING", () => {
    const component = PongHandlerModule.getComponent();
    const captured = [];
    // Stub the output to capture the sent message
    const fakeOutput = {
      sendDone: (msg) => {
        captured.push(msg);
      },
      send: () => {},
      done: () => {},
    };

    // InReach emails have the message in the first line followed by boilerplate
    const msg = {
      channel: "inreach",
      payload: "PING\n\nView the location or send a reply to Henri:",
    };
    component.handle({ hasData: () => true, getData: () => msg }, fakeOutput);

    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].payload, "PONG");
    assert.strictEqual(captured[0].intent, "NOTIFY");
  });

  it("passes through non-PING messages unchanged", () => {
    const component = PongHandlerModule.getComponent();
    const captured = [];
    const fakeOutput = {
      sendDone: (msg) => {
        captured.push(msg);
      },
      send: () => {},
      done: () => {},
    };

    const msg = { channel: "inreach", payload: "hello" };
    component.handle({ hasData: () => true, getData: () => msg }, fakeOutput);

    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].payload, "hello");
  });

  it("ignores non-inreach channels", () => {
    const component = PongHandlerModule.getComponent();
    const captured = [];
    const fakeOutput = {
      sendDone: (msg) => {
        captured.push(msg);
      },
      send: () => {},
      done: () => {},
    };

    const msg = { channel: "winlink", payload: "PING" };
    component.handle({ hasData: () => true, getData: () => msg }, fakeOutput);

    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].payload, "PING");
  });
});
