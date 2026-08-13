import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { fail, failed } from "noflo-assembly";

const require = createRequire(import.meta.url);
const { InReachError } = require("../lib/InReachClient.js");
const { renderAlert } = require("../components/AlertComposer.js");

describe("AlertComposer context extraction", () => {
  it("includes blog post details in SESSION_EXPIRED alert", () => {
    const msg = {
      errors: [],
      identityHash: "test-id",
      replyTo: "https://inreachlink.com/abc123",
      channel: "inreach",
      intent: "NOTIFY",
      notifyText: "Published: My Sailing Adventure",
      filename: "2026-08-11-day-14",
      publishedPath: "_logs/2026-08-11-day-14.md",
    };

    fail(
      msg,
      new InReachError(
        "InReach reply rejected (HTTP 401)",
        "SESSION_EXPIRED",
        401,
      ),
    );

    const text = renderAlert(
      msg.errors[msg.errors.length - 1].code,
      msg.errors[msg.errors.length - 1],
      msg,
    );

    assert.ok(text);
    assert.match(text, /SESSION_EXPIRED/);
    assert.match(text, /What succeeded \(but couldn't confirm\):/);
    assert.match(text, /Published: My Sailing Adventure/);
    assert.match(text, /Blog post: 2026-08-11-day-14/);
  });

  it("includes GRIB transmission ID in SESSION_EXPIRED alert", () => {
    const msg = {
      errors: [],
      identityHash: "test-id",
      replyTo: "https://inreachlink.com/abc123",
      channel: "inreach",
      intent: "NOTIFY",
      transmissionId: "Rq7T",
      partType: "grib",
    };

    fail(
      msg,
      new InReachError(
        "InReach reply rejected (HTTP 401)",
        "SESSION_EXPIRED",
        401,
      ),
    );

    const text = renderAlert(
      msg.errors[msg.errors.length - 1].code,
      msg.errors[msg.errors.length - 1],
      msg,
    );

    assert.ok(text);
    assert.match(text, /GRIB transmission ID: Rq7T/);
  });

  it("includes status payload when available", () => {
    const msg = {
      errors: [],
      identityHash: "test-id",
      replyTo: "https://inreachlink.com/abc123",
      channel: "inreach",
      intent: "NOTIFY",
      notifyText: "Status: OK", // This is the success marker
      payload: "Pending: 3 messages | GRIB gates: 1 | Saildocs: 0",
    };

    fail(msg, new Error("InReach transmission failed"));

    const text = renderAlert(
      msg.errors[msg.errors.length - 1].code,
      msg.errors[msg.errors.length - 1],
      msg,
    );

    assert.ok(text);
    assert.match(text, /What succeeded \(but couldn't confirm\):/);
    assert.match(text, /Status: OK/);
    assert.match(text, /Pending: 3 messages/);
  });

  it("does NOT show context for BAD_URL (no success happened)", () => {
    const msg = {
      errors: [],
      identityHash: "test-id",
      replyTo: "not-a-url",
      channel: "inreach",
      intent: "NOTIFY",
    };

    fail(
      msg,
      new InReachError(
        "InReach reply URL missing or invalid in msg.replyTo: not-a-url",
        "BAD_URL",
        null,
      ),
    );

    const text = renderAlert(
      msg.errors[msg.errors.length - 1].code,
      msg.errors[msg.errors.length - 1],
      msg,
    );

    assert.ok(text);
    assert.match(text, /BAD_URL/);
    assert.doesNotMatch(text, /What succeeded/);
    assert.doesNotMatch(text, /Blog post:/);
  });

  it("does NOT show context for NOT_CONFIGURED (no success happened)", () => {
    const msg = {
      errors: [],
      identityHash: "test-id",
      replyTo: "https://inreachlink.com/abc123",
      channel: "inreach",
      intent: "NOTIFY",
    };

    fail(
      msg,
      new InReachError(
        "InReach replyAddress not configured",
        "NOT_CONFIGURED",
        null,
      ),
    );

    const text = renderAlert(
      msg.errors[msg.errors.length - 1].code,
      msg.errors[msg.errors.length - 1],
      msg,
    );

    assert.ok(text);
    assert.match(text, /NOT_CONFIGURED/);
    assert.doesNotMatch(text, /What succeeded/);
  });
});
