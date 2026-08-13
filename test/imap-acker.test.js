import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const ImapAckerModule = require("../components/ImapAcker.js");

describe("ImapAcker component", () => {
  it("exists and exports getComponent", () => {
    assert.strictEqual(typeof ImapAckerModule.getComponent, "function");
  });

  it("creates a component without crashing", () => {
    const component = ImapAckerModule.getComponent();
    assert(component !== null);
    assert.strictEqual(typeof component.handle, "function");
  });

  it("has the expected inports (in + IMAP config)", () => {
    const component = ImapAckerModule.getComponent();
    const portNames = Object.keys(component.inPorts.ports);
    assert.ok(portNames.includes("in"), "should have in inport");
    assert.ok(portNames.includes("host"), "should have host inport");
    assert.ok(portNames.includes("username"), "should have username inport");
    assert.ok(portNames.includes("password"), "should have password inport");
    assert.ok(portNames.includes("mailbox"), "should have mailbox inport");
    // Config ports are control (non-triggering)
    assert.strictEqual(
      component.inPorts.ports.host.options.control,
      true,
      "host should be control (non-triggering)",
    );
    // `in` is the triggering data port
    assert.strictEqual(
      component.inPorts.ports.in.options.control,
      false,
      "in should be non-control (triggering)",
    );
  });

  it("has the expected outports", () => {
    const component = ImapAckerModule.getComponent();
    const portNames = Object.keys(component.outPorts.ports);
    assert.ok(portNames.includes("out"), "should have out outport");
  });

  it("passes through messages without imapUid without connecting", async () => {
    // This verifies the no-uid passthrough path without needing a real IMAP
    // server. If the component tried to connect, this would fail/hang.
    const component = ImapAckerModule.getComponent();
    // Set config so the component is "ready" — but we should never connect
    component.imapConfig = {
      host: "localhost",
      port: 999,
      user: "test",
      pass: "test",
      mailbox: "INBOX",
    };

    const msg = { errors: [], payload: "hello", imapUid: null };
    const result = await new Promise((resolve) => {
      component.handle(
        {
          hasData: (port) => port === "in",
          getData: (port) => (port === "in" ? msg : undefined),
        },
        {
          sendDone: (m) => resolve(m),
          done: () => resolve(null),
        },
      );
    });

    assert.ok(result, "should pass through the message");
    assert.strictEqual(result.payload, "hello");
    assert.strictEqual(component.client, null, "should not have connected");
  });

  it("does not forward null messages (from upstream async sendDone)", async () => {
    const component = ImapAckerModule.getComponent();
    component.imapConfig = {
      host: "localhost",
      port: 999,
      user: "test",
      pass: "test",
      mailbox: "INBOX",
    };

    let sentToOut = null;
    let doneCalled = false;
    await new Promise((resolve) => {
      component.handle(
        {
          hasData: (port) => port === "in",
          getData: (port) => (port === "in" ? null : undefined),
        },
        {
          sendDone: (m) => {
            sentToOut = m;
            resolve();
          },
          done: () => {
            doneCalled = true;
            resolve();
          },
        },
      );
    });

    // Null messages should be swallowed with done(), not forwarded to out
    assert.strictEqual(sentToOut, null, "should not send null to out");
    assert.ok(doneCalled, "should call done()");
    assert.strictEqual(component.client, null, "should not have connected");
  });

  it("does not forward failed messages (leaves email unseen for retry)", async () => {
    const component = ImapAckerModule.getComponent();
    component.imapConfig = {
      host: "localhost",
      port: 999,
      user: "test",
      pass: "test",
      mailbox: "INBOX",
    };

    const failedMsg = {
      errors: [{ code: "TEST", message: "simulated failure" }],
      failed: true,
      imapUid: 42,
      payload: "failed message",
    };

    let sentToOut = null;
    let doneCalled = false;
    await new Promise((resolve) => {
      component.handle(
        {
          hasData: (port) => port === "in",
          getData: (port) => (port === "in" ? failedMsg : undefined),
        },
        {
          sendDone: (m) => {
            sentToOut = m;
            resolve();
          },
          done: () => {
            doneCalled = true;
            resolve();
          },
        },
      );
    });

    // Failed messages should not be forwarded (ImapAcker is terminal) and
    // should not connect (leave email unseen so it's retried)
    assert.strictEqual(sentToOut, null, "should not send failed msg to out");
    assert.ok(doneCalled, "should call done()");
    assert.strictEqual(component.client, null, "should not have connected");
  });

  // --- ackedUids reporting (consumed by the downstream MetricCounter / msg_in) ---

  it("records ackedUids for a single imapUid on successful mark-seen", async () => {
    const component = ImapAckerModule.getComponent();
    component.imapConfig = {
      host: "localhost",
      port: 999,
      user: "test",
      pass: "test",
      mailbox: "INBOX",
    };
    // Pre-set the client so ensureConnected() returns it without connecting.
    const marked = [];
    component.client = {
      messageFlagsSet: async (uid) => {
        marked.push(uid);
      },
    };

    const msg = { errors: [], imapUid: 42, payload: "x" };
    const result = await new Promise((resolve) => {
      component.handle(
        {
          hasData: (port) => port === "in",
          getData: (port) => (port === "in" ? msg : undefined),
        },
        {
          sendDone: (m) => resolve(m),
          done: () => resolve(null),
          send: () => {},
        },
      );
    });

    assert.deepStrictEqual(marked, [42], "should mark the uid seen");
    assert.deepStrictEqual(result.ackedUids, [42], "should report ackedUids");
  });

  it("records all ackUids for a multi-chunk message", async () => {
    const component = ImapAckerModule.getComponent();
    component.imapConfig = {
      host: "localhost",
      port: 999,
      user: "test",
      pass: "test",
      mailbox: "INBOX",
    };
    const marked = [];
    component.client = {
      messageFlagsSet: async (uid) => {
        marked.push(uid);
      },
    };

    const msg = { errors: [], ackUids: [10, 20, 30], payload: "x" };
    const result = await new Promise((resolve) => {
      component.handle(
        {
          hasData: (port) => port === "in",
          getData: (port) => (port === "in" ? msg : undefined),
        },
        {
          sendDone: (m) => resolve(m),
          done: () => resolve(null),
          send: () => {},
        },
      );
    });

    assert.deepStrictEqual(marked, [10, 20, 30]);
    assert.deepStrictEqual(result.ackedUids, [10, 20, 30]);
  });

  it("continues past a failing uid and reports only the ones it acked", async () => {
    const component = ImapAckerModule.getComponent();
    component.imapConfig = {
      host: "localhost",
      port: 999,
      user: "test",
      pass: "test",
      mailbox: "INBOX",
    };
    const marked = [];
    component.client = {
      messageFlagsSet: async (uid) => {
        if (uid === 20) throw new Error("boom");
        marked.push(uid);
      },
    };

    const msg = { errors: [], ackUids: [10, 20, 30], payload: "x" };
    const result = await new Promise((resolve) => {
      component.handle(
        {
          hasData: (port) => port === "in",
          getData: (port) => (port === "in" ? msg : undefined),
        },
        {
          sendDone: (m) => resolve(m),
          done: () => resolve(null),
          send: () => {},
        },
      );
    });

    // uid 20 failed; 10 and 30 still attempted (one bad uid no longer aborts
    // the rest of a multi-chunk sequence).
    assert.deepStrictEqual(marked, [10, 30]);
    assert.deepStrictEqual(result.ackedUids, [10, 30]);
  });

  it("sets no ackedUids when every uid fails", async () => {
    const component = ImapAckerModule.getComponent();
    component.imapConfig = {
      host: "localhost",
      port: 999,
      user: "test",
      pass: "test",
      mailbox: "INBOX",
    };
    component.client = {
      messageFlagsSet: async () => {
        throw new Error("connection gone");
      },
    };

    const msg = { errors: [], imapUid: 42, payload: "x" };
    const result = await new Promise((resolve) => {
      component.handle(
        {
          hasData: (port) => port === "in",
          getData: (port) => (port === "in" ? msg : undefined),
        },
        {
          sendDone: (m) => resolve(m),
          done: () => resolve(null),
          send: () => {},
        },
      );
    });

    assert.ok(
      !Array.isArray(result.ackedUids) || result.ackedUids.length === 0,
      "no ackedUids when nothing was marked",
    );
  });
});
