import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

// Load component via createRequire so the test shares the component's CJS module instance
const require = createRequire(import.meta.url);
const ImapFetcherModule = require("../components/ImapFetcher.js");

describe("ImapFetcher component", () => {
  it("exists and exports getComponent", () => {
    assert.strictEqual(typeof ImapFetcherModule.getComponent, "function");
  });

  it("creates a component without crashing", () => {
    const component = ImapFetcherModule.getComponent();
    assert(component !== null);
    assert.strictEqual(typeof component.handle, "function");
  });

  it("has the expected inports (bang trigger + IMAP config)", () => {
    const component = ImapFetcherModule.getComponent();
    const portNames = Object.keys(component.inPorts.ports);
    assert.ok(portNames.includes("in"), "should have in inport (bang trigger)");
    assert.ok(portNames.includes("host"), "should have host inport");
    assert.ok(portNames.includes("port"), "should have port inport");
    assert.ok(portNames.includes("username"), "should have username inport");
    assert.ok(portNames.includes("password"), "should have password inport");
    assert.ok(portNames.includes("mailbox"), "should have mailbox inport");
    // Config ports are control (non-triggering); `in` triggers
    assert.strictEqual(
      component.inPorts.ports.host.options.control,
      true,
      "host should be control (non-triggering)",
    );
    assert.strictEqual(
      component.inPorts.ports.in.options.control,
      false,
      "in should be non-control (triggering)",
    );
  });

  it("has the expected outports", () => {
    const component = ImapFetcherModule.getComponent();
    const portNames = Object.keys(component.outPorts.ports);
    assert.ok(portNames.includes("out"), "should have out outport");
  });

  it("parses an ImapFlow message into an email object", () => {
    const component = ImapFetcherModule.getComponent();

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

    const email = component.parseMessage(mockMessage);

    assert.ok(email, "email should be defined");
    assert.strictEqual(email.imapUid, 1, "email should carry imapUid");
    assert.strictEqual(email.from.address, "no.reply.inreach@garmin.com");
    assert.strictEqual(email.subject, "Test message from Garmin inReach");
    assert.strictEqual(email.body, "PING");
    assert.ok(
      email.returnPath.includes("testdevice123"),
      "returnPath should contain device ID",
    );
  });

  it("emits InReach, Winlink, and Saildocs messages", () => {
    const component = ImapFetcherModule.getComponent();

    const makeEmail = (fromAddr, body) => ({
      imapUid: Math.floor(Math.random() * 1000),
      from: { address: fromAddr, name: "" },
      to: { address: "boat@example.com", name: "" },
      subject: "test",
      body,
    });

    assert.ok(component.isSystemMessage(makeEmail("no.reply.inreach@garmin.com", "PING")));
    assert.ok(
      component.isSystemMessage(makeEmail("call@winlink.org", "---BEGIN RETICULUM METADATA---")),
    );
    assert.ok(component.isSystemMessage(makeEmail("query@saildocs.com", "GRIB data")));
  });

  it("skips unrelated messages (leaves them unread)", () => {
    const component = ImapFetcherModule.getComponent();

    const makeEmail = (fromAddr, body) => ({
      imapUid: 999,
      from: { address: fromAddr, name: "" },
      to: { address: "boat@example.com", name: "" },
      subject: "test",
      body,
    });

    assert.ok(
      !component.isSystemMessage(makeEmail("friend@gmail.com", "Hey, how's it going?")),
      "personal email should be skipped",
    );
    assert.ok(
      !component.isSystemMessage(makeEmail("newsletter@medium.com", "Check out these articles")),
      "newsletter should be skipped",
    );
  });
});
