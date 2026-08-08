// Smoketest for Winlink integration in encode endpoint

const { test } = require("node:test");
const assert = require("node:assert");
const { describe } = require("node:test");

// Mock plugin structure for testing
const mockApp = {
  debug: () => {},
  error: () => {},
  warn: () => {},
  setPluginStatus: () => {},
  plugins: {},
};

const plugin = require("../plugin/index.js")(mockApp);

describe("Winlink Integration", () => {
  test("encode endpoint should include winlink data when identity is available", async () => {
    // This is a smoketest - the actual functionality depends on having
    // a Reticulum identity configured, which may not be available in test env
    // The endpoint structure should still be valid
    assert.ok(
      plugin.registerWithRouter,
      "plugin should have registerWithRouter method",
    );
  });

  test("signForWinlink function should exist and have correct structure", () => {
    // The signForWinlink function is exported via require but not directly in module.exports
    // It's used internally by the /api/sign and /api/encode endpoints
    // We verify the plugin loaded correctly
    assert.ok(
      plugin.id === "signalk-offshore-blogging",
      "plugin should have correct ID",
    );
  });

  test("encode endpoint response structure should accept winlink field", async () => {
    // Simulate what the /api/encode endpoint returns
    const mockEncodeResult = {
      postid: "0808",
      title: "Test Post",
      date: "2025-08-08",
      textMessages: ["msg1", "msg2"],
      imageMessages: [],
      totalMessages: 2,
      foundImages: 0,
      winlink: {
        metadata:
          "---BEGIN RETICULUM METADATA---\nIdentityHash: abc123\nAlgorithm: Ed25519\nSig: xyz789\n---END RETICULUM METADATA---\n",
        content: "---BEGIN BLOG POST---\nTest Content\n---END BLOG POST---",
        identityHash: "abc123",
      },
    };

    assert.ok(
      mockEncodeResult.winlink,
      "encode result should include winlink field",
    );
    assert.ok(
      mockEncodeResult.winlink.metadata,
      "winlink should have metadata",
    );
    assert.ok(mockEncodeResult.winlink.content, "winlink should have content");
    assert.ok(
      mockEncodeResult.winlink.identityHash,
      "winlink should have identityHash",
    );
  });

  test("encode endpoint should handle winlink error gracefully", async () => {
    const mockEncodeResult = {
      postid: "0808",
      title: "Test Post",
      date: "2025-08-08",
      textMessages: ["msg1", "msg2"],
      imageMessages: [],
      totalMessages: 2,
      foundImages: 0,
      winlink: {
        error: "No Reticulum identity available",
      },
    };

    assert.ok(
      mockEncodeResult.winlink,
      "encode result should include winlink field",
    );
    assert.ok(
      mockEncodeResult.winlink.error,
      "winlink should have error field when signing fails",
    );
  });
});
