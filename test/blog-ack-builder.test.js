// Tests for BlogAckBuilder: builds the InReach confirmation reply.
//
// The critical invariant tested here is that BlogAckBuilder does NOT mutate
// its input message. Decoder.out is forked to both BlogAckBuilder and
// GitPublisher (same object reference); mutating msg.payload here would
// corrupt GitPublisher's async read of the blog data object.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { getComponent } = require("../components/BlogAckBuilder.js");

function runHandle(component, msg) {
  return new Promise((resolve) => {
    component.handle(
      {
        hasData: (p) => p === "in",
        getData: (p) => (p === "in" ? msg : undefined),
      },
      {
        sendDone: (m) => resolve(m),
        done: () => resolve(null),
      },
    );
  });
}

describe("BlogAckBuilder", () => {
  it("exports getComponent", () => {
    assert.strictEqual(typeof getComponent, "function");
  });

  it("builds a reply naming the filename and part count", async () => {
    const component = getComponent();
    const blogData = {
      filename: "2026-07-15",
      title: "Pacific Ocean, 48NM SW of Anse Amyot",
      postId: "0715",
    };
    const msg = {
      errors: [],
      identityHash: "abc",
      replyTo: "https://inreachlink.com/x",
      channel: "inreach",
      confidence: "medium",
      intent: "BLOG",
      imapUid: 897,
      totalChunks: 5,
      payload: blogData,
    };

    const out = await runHandle(component, msg);

    assert.ok(out, "should emit a reply");
    assert.strictEqual(out.payload, "Blog OK: 2026-07-15.md (5 parts)");
    assert.strictEqual(out.intent, "NOTIFY");
    // Routing fields preserved for InReachSender / ImapAcker.
    assert.strictEqual(out.replyTo, msg.replyTo);
    assert.strictEqual(out.imapUid, 897);
  });

  it("does NOT mutate the input message (shared with GitPublisher)", async () => {
    // This is the regression test for the fork-corruption bug: if AckBuilder
    // mutates msg.payload to a string, GitPublisher's async handler (which
    // reads the same object) sees a string instead of the blog data and
    // fails validation — so the post never gets written to disk.
    const component = getComponent();
    const blogData = {
      filename: "2026-08-09",
      title: "Calm Day",
      postId: "0809",
    };
    const msg = {
      errors: [],
      identityHash: "abc",
      replyTo: "reply",
      channel: "inreach",
      confidence: "medium",
      intent: "BLOG",
      imapUid: 1,
      totalChunks: 2,
      payload: blogData,
    };
    const originalPayload = msg.payload;

    await runHandle(component, msg);

    // The input message must be untouched — its payload is still the blog
    // data object, not the confirmation string.
    assert.strictEqual(
      msg.payload,
      originalPayload,
      "must not mutate the shared input's payload (GitPublisher reads it too)",
    );
    assert.strictEqual(msg.intent, "BLOG", "must not mutate input intent");
    assert.strictEqual(
      msg.payload.filename,
      "2026-08-09",
      "blog data object intact for the parallel GitPublisher branch",
    );
  });

  it("passes failed messages through unchanged", async () => {
    const component = getComponent();
    const failedMsg = {
      errors: [new Error("upstream failure")],
      payload: "garbage",
      intent: "BLOG",
    };
    const out = await runHandle(component, failedMsg);
    assert.strictEqual(out, failedMsg, "failed messages pass through as-is");
  });

  it("handles a missing filename gracefully", async () => {
    const component = getComponent();
    const msg = {
      errors: [],
      totalChunks: 1,
      payload: { title: "x", postId: "0001" }, // no filename
    };
    const out = await runHandle(component, msg);
    assert.match(out.payload, /\(unknown\)\.md/);
  });
});
