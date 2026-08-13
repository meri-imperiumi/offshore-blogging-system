import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

// Load component via createRequire so the test shares the component's CJS module instance
const require = createRequire(import.meta.url);
const CommandRouterModule = require("../components/CommandRouter.js");

describe("CommandRouter component with PING", () => {
  it("routes PING command to correct output index", () => {
    const component = CommandRouterModule.getComponent();
    const captured = [];

    const fakeOutput = {
      sendDone: (msg) => {
        captured.push(msg);
      },
    };

    const msg = {
      channel: "inreach",
      payload: "PING",
      intent: "SYS",
      sender: "test@example.com",
    };

    // Set routes control value first
    const input = {
      hasData: (port) => {
        if (port === "routes") return true;
        if (port === "in") return true;
        return false;
      },
      getData: (port) => {
        if (port === "routes") return "GATE,STATUS,PING";
        if (port === "in") return msg;
        return undefined;
      },
    };

    component.handle(input, fakeOutput);

    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].out.index, 2); // PING should be at index 2
    assert.strictEqual(captured[0].out.data.channel, "inreach");
    assert.strictEqual(captured[0].out.data.payload, "PING");
  });

  it("routes STATUS command to index 1", () => {
    const component = CommandRouterModule.getComponent();
    const captured = [];

    const fakeOutput = {
      sendDone: (msg) => {
        captured.push(msg);
      },
    };

    const msg = {
      channel: "inreach",
      payload: "STATUS",
      intent: "SYS",
    };

    const input = {
      hasData: (port) => {
        if (port === "routes") return true;
        if (port === "in") return true;
        return false;
      },
      getData: (port) => {
        if (port === "routes") return "GATE,STATUS,PING";
        if (port === "in") return msg;
        return undefined;
      },
    };

    component.handle(input, fakeOutput);

    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].out.index, 1);
  });

  it("routes YES command to index 0 with commandAction and gateId", () => {
    const component = CommandRouterModule.getComponent();
    const captured = [];

    const fakeOutput = {
      sendDone: (msg) => {
        captured.push(msg);
      },
    };

    const msg = {
      channel: "inreach",
      payload: "YES abc123",
      intent: "SYS",
    };

    const input = {
      hasData: (port) => {
        if (port === "routes") return true;
        if (port === "in") return true;
        return false;
      },
      getData: (port) => {
        if (port === "routes") return "GATE,STATUS,PING";
        if (port === "in") return msg;
        return undefined;
      },
    };

    component.handle(input, fakeOutput);

    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].out.index, 0);
    assert.strictEqual(captured[0].out.data.commandAction, "YES");
    assert.strictEqual(captured[0].out.data.gateId, "abc123");
  });

  it("routes CANCEL command to index 0 with commandAction and gateId", () => {
    const component = CommandRouterModule.getComponent();
    const captured = [];

    const fakeOutput = {
      sendDone: (msg) => {
        captured.push(msg);
      },
    };

    const msg = {
      channel: "inreach",
      payload: "CANCEL xyz789",
      intent: "SYS",
    };

    const input = {
      hasData: (port) => {
        if (port === "routes") return true;
        if (port === "in") return true;
        return false;
      },
      getData: (port) => {
        if (port === "routes") return "GATE,STATUS,PING";
        if (port === "in") return msg;
        return undefined;
      },
    };

    component.handle(input, fakeOutput);

    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].out.index, 0);
    assert.strictEqual(captured[0].out.data.commandAction, "CANCEL");
    assert.strictEqual(captured[0].out.data.gateId, "xyz789");
  });

  it("routes unknown commands to MISSED", () => {
    const component = CommandRouterModule.getComponent();
    const captured = [];

    const fakeOutput = {
      sendDone: (msg) => {
        captured.push(msg);
      },
    };

    const msg = {
      channel: "inreach",
      payload: "UNKNOWN",
      intent: "SYS",
    };

    const input = {
      hasData: (port) => {
        if (port === "routes") return true;
        if (port === "in") return true;
        return false;
      },
      getData: (port) => {
        if (port === "routes") return "GATE,STATUS,PING";
        if (port === "in") return msg;
        return undefined;
      },
    };

    component.handle(input, fakeOutput);

    assert.strictEqual(captured.length, 1);
    assert(captured[0].missed !== undefined);
    assert.strictEqual(captured[0].missed.payload, "UNKNOWN");
  });

  it("routes failed messages to MISSED", () => {
    const component = CommandRouterModule.getComponent();
    const captured = [];

    const fakeOutput = {
      sendDone: (msg) => {
        captured.push(msg);
      },
    };

    const msg = {
      channel: "inreach",
      payload: "PING",
      intent: "SYS",
      errors: [new Error("Test error")],
    };

    const input = {
      hasData: (port) => {
        if (port === "routes") return true;
        if (port === "in") return true;
        return false;
      },
      getData: (port) => {
        if (port === "routes") return "GATE,STATUS,PING";
        if (port === "in") return msg;
        return undefined;
      },
    };

    component.handle(input, fakeOutput);

    assert.strictEqual(captured.length, 1);
    assert(captured[0].missed !== undefined);
    assert.strictEqual(captured[0].missed.errors.length, 1);
  });
});
