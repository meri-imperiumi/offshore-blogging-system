// Tests for DecoderBypass component

const { test } = require("node:test");
const assert = require("node:assert");
const { getComponent } = require("../components/DecoderBypass.js");

test("DecoderBypass routes encoded messages to OUT", () => {
  const component = getComponent();
  const msg = {
    errors: [],
    identityHash: "abc123",
    channel: "inreach",
    intent: "BLOG",
    payload: "encoded chunk data",
  };

  const input = {
    hasData: (port) => port === "in",
    getData: () => msg,
  };

  let outputSent = null;
  const output = {
    sendDone: (data) => {
      outputSent = data;
    },
  };

  component.handle(input, output);
  assert.ok(outputSent);
  assert.ok(outputSent.out);
  assert.strictEqual(outputSent.out.payload, "encoded chunk data");
  assert.strictEqual(outputSent.bypass, undefined);
});

test("DecoderBypass routes decoded messages to BYPASS", () => {
  const component = getComponent();
  const msg = {
    errors: [],
    identityHash: "abc123",
    channel: "winlink",
    intent: "BLOG",
    payload: {
      filename: "2024-08-12.md",
      title: "Test Post",
      date: "2024-08-12",
      bodyMarkdown: "Test content",
      postId: "abcd",
      imageBuffers: [],
      imageCount: 0,
    },
  };

  const input = {
    hasData: (port) => port === "in",
    getData: () => msg,
  };

  let outputSent = null;
  const output = {
    sendDone: (data) => {
      outputSent = data;
    },
  };

  component.handle(input, output);
  assert.ok(outputSent);
  assert.ok(outputSent.bypass);
  assert.strictEqual(outputSent.bypass.payload.filename, "2024-08-12.md");
  assert.strictEqual(outputSent.out, undefined);
});

test("DecoderBypass routes messages with missing fields to OUT", () => {
  const component = getComponent();
  const msg = {
    errors: [],
    identityHash: "abc123",
    channel: "winlink",
    intent: "BLOG",
    payload: {
      filename: "2024-08-12.md",
      title: "Test Post",
      // Missing other required fields
    },
  };

  const input = {
    hasData: (port) => port === "in",
    getData: () => msg,
  };

  let outputSent = null;
  const output = {
    sendDone: (data) => {
      outputSent = data;
    },
  };

  component.handle(input, output);
  assert.ok(outputSent);
  assert.ok(outputSent.out);
  assert.strictEqual(outputSent.bypass, undefined);
});
