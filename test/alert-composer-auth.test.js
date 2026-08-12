import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { fail } from "noflo-assembly";

const require = createRequire(import.meta.url);
const { InReachError } = require("../lib/InReachClient.js");
const { renderAlert } = require("../components/AlertComposer.js");

/** Create an error with a specific code (mimics what DacarAuthorizer.deny does) */
function authError(message) {
  const err = new Error(message);
  err.code = "AUTH_DENIED";
  return err;
}

describe("AlertComposer auth alerting", () => {
  it("shows [AUTH ALERT] prefix for AUTH_DENIED code", () => {
    const msg = {
      errors: [],
      identityHash: "abc123def456",
      permission: "blog:publish",
      replyTo: "winlink.org",
      channel: "winlink",
      intent: "BLOG",
    };

    fail(msg, authError("No matching grant found"));

    const err = msg.errors[msg.errors.length - 1];
    const text = renderAlert(err.code, err, msg);

    assert.ok(text);
    assert.match(text, /\[AUTH ALERT\] AUTH_DENIED/);
    assert.match(text, /Identity: abc123def456/);
    assert.match(text, /Permission requested: blog:publish/);
  });

  it("does NOT show success context for AUTH_DENIED", () => {
    const msg = {
      errors: [],
      identityHash: "xyz789",
      permission: "blog:publish",
      replyTo: "winlink.org",
      channel: "winlink",
      intent: "BLOG",
      // No success markers — auth denial happens before any work succeeds
    };

    fail(msg, authError("No matching grant found"));

    const err = msg.errors[msg.errors.length - 1];
    const text = renderAlert(err.code, err, msg);

    assert.ok(text);
    assert.match(text, /\[AUTH ALERT\]/);
    assert.doesNotMatch(text, /What succeeded/);
  });

  it("shows all errors when multiple auth failures in a message", () => {
    const msg = {
      errors: [],
      identityHash: "xyz789",
      permission: "blog:publish",
      replyTo: "winlink.org",
      channel: "winlink",
      intent: "BLOG",
    };

    fail(msg, authError("First auth attempt failed"));
    fail(msg, authError("Second auth attempt failed"));

    const err = msg.errors[msg.errors.length - 1];
    const text = renderAlert(err.code, err, msg);

    assert.ok(text);
    assert.match(text, /All errors \(2\):/);
    assert.match(text, / {2}\[AUTH_DENIED\] First auth attempt failed/);
    assert.match(text, /→ \[AUTH_DENIED\] Second auth attempt failed/);
  });

  it("keeps [InReach Alert] prefix for InReach codes", () => {
    const msg = {
      errors: [],
      identityHash: "test-id",
      replyTo: "https://inreachlink.com/abc123",
      channel: "inreach",
      intent: "NOTIFY",
      notifyText: "Published: Test Post",
      filename: "2026-08-11",
    };

    fail(
      msg,
      new InReachError(
        "InReach reply rejected (HTTP 401)",
        "SESSION_EXPIRED",
        401,
      ),
    );

    const err = msg.errors[msg.errors.length - 1];
    const text = renderAlert(err.code, err, msg);

    assert.ok(text);
    assert.match(text, /\[InReach Alert\] SESSION_EXPIRED/);
    assert.match(text, /What succeeded \(but couldn't confirm\):/);
  });

  it("does NOT show Identity twice for AUTH_DENIED", () => {
    const msg = {
      errors: [],
      identityHash: "spoofed-id-123",
      permission: "blog:publish",
      replyTo: "winlink.org",
      channel: "winlink",
      intent: "BLOG",
    };

    fail(msg, authError("Identity hash mismatch — possible spoofing"));

    const err = msg.errors[msg.errors.length - 1];
    const text = renderAlert(err.code, err, msg);

    // Identity should appear exactly once (in the auth context section,
    // not again in the footer)
    const matches = text.match(/Identity: spoofed-id-123/g);
    assert.strictEqual(matches?.length, 1);
  });
});
