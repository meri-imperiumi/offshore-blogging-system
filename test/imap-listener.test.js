import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

// Load component via createRequire so the test shares the component's CJS module instance
const require = createRequire(import.meta.url);
const ImapListenerModule = require("../components/ImapListener.js");

describe("ImapListener component", () => {
  it("exists and exports getComponent", () => {
    assert.strictEqual(typeof ImapListenerModule.getComponent, "function");
  });

  it("creates a component without crashing", () => {
    const component = ImapListenerModule.getComponent();
    assert(component !== null);
    assert.strictEqual(typeof component.handle, "function");
  });

  it("has the expected inports (config + interval)", () => {
    const component = ImapListenerModule.getComponent();
    const portNames = Object.keys(component.inPorts.ports);
    assert.ok(portNames.includes("host"), "should have host inport");
    assert.ok(portNames.includes("port"), "should have port inport");
    assert.ok(portNames.includes("username"), "should have username inport");
    assert.ok(portNames.includes("password"), "should have password inport");
    assert.ok(portNames.includes("mailbox"), "should have mailbox inport");
    assert.ok(portNames.includes("interval"), "should have interval inport");
    // Config ports are control (non-triggering); interval triggers
    assert.strictEqual(
      component.inPorts.ports.host.options.control,
      true,
      "host should be control (non-triggering)",
    );
    assert.strictEqual(
      component.inPorts.ports.interval.options.control,
      false,
      "interval should be non-control (triggering)",
    );
  });

  it("has the expected outports", () => {
    const component = ImapListenerModule.getComponent();
    const portNames = Object.keys(component.outPorts.ports);
    assert.ok(portNames.includes("out"), "should have out outport");
  });

  it("is a generator component (autoOrdering disabled)", () => {
    const component = ImapListenerModule.getComponent();
    assert.strictEqual(component.autoOrdering, false);
  });

  it("parses an ImapFlow message into an email object", async () => {
    const component = ImapListenerModule.getComponent();

    // Mock the generator output to capture what would be sent
    const sent = [];
    component.generatorOutput = {
      send: (map) => {
        sent.push(map);
      },
    };

    // Mock client for messageFlagsSet
    component.client = {
      messageFlagsSet: async () => {},
    };

    // Build a mock ImapFlow message that resembles an InReach email.
    // ImapFlow returns requested headers as a raw Buffer of "Key: Value" lines.
    const rawHeaders = Buffer.from(
      [
        "Return-Path: <bounces+testdevice123-boat@inreacheml.garmin.com>",
        "Message-ID: <msg123@garmin.com>",
        "",
      ].join("\r\n"),
    );

    const mockMessage = {
      uid: 1,
      envelope: {
        from: [{ address: "no.reply.inreach@garmin.com", name: "Garmin InReach" }],
        to: [{ address: "boat@example.com", name: "Boat" }],
        subject: "Test message from Garmin inReach",
        date: new Date("2024-01-15T12:00:00Z"),
      },
      source: Buffer.from(
        [
          "Return-Path: <bounces+testdevice123-boat@inreacheml.garmin.com>",
          "Message-ID: <msg123@garmin.com>",
          "",
          "PING",
        ].join("\r\n"),
      ),
      headers: rawHeaders,
    };

    await component.processMessage(mockMessage);

    assert.strictEqual(sent.length, 1, "should have sent one email");
    const email = sent[0].out;
    assert.ok(email, "email should be defined");
    assert.strictEqual(email.from.address, "no.reply.inreach@garmin.com");
    assert.strictEqual(email.subject, "Test message from Garmin inReach");
    assert.strictEqual(email.body, "PING");
    assert.ok(
      email.returnPath.includes("testdevice123"),
      "returnPath should contain device ID",
    );
  });
});
