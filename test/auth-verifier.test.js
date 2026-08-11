import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

// Load component + reticulum via createRequire so the test shares the
// component's CJS module instance (same reasoning as the InReachSender /
// AlertComposer tests).
const require = createRequire(import.meta.url);
const { Identity, toHex } = require("@reticulum/core");

const authVerifierModule = require("../components/AuthVerifier.js");

function makeVerifier() {
  return authVerifierModule.getComponent();
}

describe("AuthVerifier", () => {
  it("exists and exports getComponent", () => {
    assert.strictEqual(typeof authVerifierModule.getComponent, "function");
  });

  it("creates a component without crashing", () => {
    const component = authVerifierModule.getComponent();
    assert(component !== null);
    assert.strictEqual(typeof component.handle, "function");
  });
});

/** Run handle() synchronously, returning the output message. */
function runHandle(email) {
  const component = makeVerifier();
  let captured = null;
  const fakeOutput = {
    sendDone: (data) => {
      captured = data;
    },
    done: () => {},
    send: () => {},
  };
  const fakeInput = {
    hasData: () => true,
    getData: () => email,
  };
  component.handle(fakeInput, fakeOutput);
  return captured;
}

describe("AuthVerifier Saildocs sender matching", () => {
  it("recognizes query-reply@saildocs.com as SYS_SAILDOCS", () => {
    // Saildocs responds from query-reply@, not query@. The old exact
    // match rejected every real response as "Unknown transport type".
    const msg = runHandle({
      from: { address: "query-reply@saildocs.com" },
      body: "--boundary\nContent-Type: application/octet-stream\n\nbase64data",
      raw: Buffer.from("raw mime"),
    });
    assert.ok(msg, "should produce output");
    assert.strictEqual(msg.identityHash, "SYS_SAILDOCS");
    assert.strictEqual(msg.confidence, "high");
    assert.strictEqual(msg.channel, null);
    assert.ok(msg.raw, "raw MIME should be carried through");
  });

  it("recognizes query@saildocs.com as SYS_SAILDOCS", () => {
    const msg = runHandle({
      from: { address: "query@saildocs.com" },
      body: "GRIB data",
    });
    assert.strictEqual(msg.identityHash, "SYS_SAILDOCS");
  });

  it("rejects an unrelated @example.com sender as unknown transport", () => {
    const msg = runHandle({
      from: { address: "friend@example.com" },
      body: "Hello",
    });
    assert.ok(msg, "should produce output");
    assert.ok(msg.failed || msg.errors?.length, "should be failed");
    assert.ok(
      msg.errors.some((e) => e.message.includes("Unknown transport type")),
      "should report unknown transport",
    );
  });
});

describe("AuthVerifier.extractInReachReplyUrl", () => {
  it("extracts an inreachlink.com share URL with base64url characters", () => {
    // The real email code contains `_` which the old regex truncated at.
    const v = makeVerifier();
    const email = {
      body: "PING\r\n\r\nView the location or send a reply to Henri Bergius:\r\nhttps://inreachlink.com/gBw0nPHdcVHWpY_iwR4kt6w\r\n\r\nDo not reply directly to this message.",
    };
    assert.strictEqual(
      v.extractInReachReplyUrl(email),
      "https://inreachlink.com/gBw0nPHdcVHWpY_iwR4kt6w",
    );
  });

  it("rejoins a quoted-printable soft-broken URL", () => {
    // Long lines in quoted-printable MIME are soft-broken with trailing `=`.
    const v = makeVerifier();
    const email = {
      body: "View the location:\r\nhttps://inreachlink.com/gBw0nPHdcVHWpY_iwR4kt6w",
    };
    assert.strictEqual(
      v.extractInReachReplyUrl(email),
      "https://inreachlink.com/gBw0nPHdcVHWpY_iwR4kt6w",
    );
  });

  it("prefers a direct explore.garmin.com reply endpoint", () => {
    const v = makeVerifier();
    const email = {
      body: "https://inreachlink.com/abc\r\nhttps://explore.garmin.com/TextMessage/TxtMsg?extId=GUID&adr=x",
    };
    assert.strictEqual(
      v.extractInReachReplyUrl(email),
      "https://explore.garmin.com/TextMessage/TxtMsg?extId=GUID&adr=x",
    );
  });

  it("matches the new eur.explore.garmin.com endpoint", () => {
    const v = makeVerifier();
    const email = {
      body: "https://eur.explore.garmin.com/textmessage/txtmsg?extId=CODE123",
    };
    assert.strictEqual(
      v.extractInReachReplyUrl(email),
      "https://eur.explore.garmin.com/textmessage/txtmsg?extId=CODE123",
    );
  });

  it("returns null when no reply URL is present", () => {
    const v = makeVerifier();
    assert.strictEqual(v.extractInReachReplyUrl({ body: "just text" }), null);
    assert.strictEqual(v.extractInReachReplyUrl({}), null);
  });
});

/**
 * Build a Winlink metadata block + signed blog-post content identical to what
 * the Signal K plugin's `signForWinlink` produces, so the verifier is tested
 * against the real wire format end to end (real Ed25519 key, real WebCrypto
 * signature over the real content bytes).
 */
async function buildSignedWinlinkEmail(content, opts = {}) {
  const identity = await Identity.generate();
  const contentBytes = Buffer.from(content, "utf-8");
  const signature = await identity.sign(contentBytes);
  const publicKey = await identity.getPublicKey();
  const metadata =
    "---BEGIN RETICULUM METADATA---\n" +
    `IdentityHash: ${toHex(identity.identityHash)}\n` +
    `PublicKey: ${toHex(publicKey)}\n` +
    "Algorithm: Ed25519\n" +
    `Sig: ${toHex(signature)}\n` +
    "---END RETICULUM METADATA---\n";
  const body =
    metadata + "\n---BEGIN BLOG POST---\n" + content + "\n---END BLOG POST---";
  const email = {
    from: { address: "call@winlink.org" },
    subject: "Blog Post via Vara HF",
    body,
    ...opts,
  };
  return { email, identity };
}

/**
 * Run the Winlink verification path (async, fire-and-forget in the component)
 * and resolve the first sendDone payload. Mirrors the sync `runHandle` helper
 * but awaits the async branch.
 */
function runHandleAsync(email) {
  const component = makeVerifier();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const fakeOutput = {
      sendDone: (data) => finish(data),
      done: () => {},
      send: () => {},
    };
    const fakeInput = {
      hasData: () => true,
      getData: () => email,
    };
    component.handle(fakeInput, fakeOutput);
    setTimeout(() => finish(null), 2000);
  });
}

describe("AuthVerifier Winlink Ed25519 signature verification", () => {
  it("verifies a validly-signed Winlink message as confidence=high", async () => {
    const content =
      "Sailing downwind, testing the node-based editor updates over the air.";
    const { email, identity } = await buildSignedWinlinkEmail(content);
    const msg = await runHandleAsync(email);
    assert.ok(msg, "should produce output");
    assert.strictEqual(msg.channel, "winlink");
    assert.strictEqual(msg.confidence, "high");
    assert.strictEqual(
      msg.identityHash,
      toHex(identity.identityHash),
      "identityHash must match the signer's real hash",
    );
    assert.ok(!msg.failed, "should not be failed");
  });

  it("rejects a tampered message body (signature no longer matches)", async () => {
    const { email } = await buildSignedWinlinkEmail("Original content here.");
    // Flip a byte in the signed content — signature won't verify.
    email.body = email.body.replace(
      "Original content here.",
      "Tampered content here!",
    );
    const msg = await runHandleAsync(email);
    assert.ok(msg, "should produce output (a failed/denied message)");
    assert.strictEqual(msg.confidence, "none");
    assert.strictEqual(msg.identityHash, null);
    assert.ok(
      msg.failed || (msg.errors && msg.errors.length > 0),
      "should be marked failed",
    );
  });

  it("rejects a forged IdentityHash that doesn't match the embedded pubkey", async () => {
    // Attacker signs with their own key but claims a victim's IdentityHash.
    // The recompute check must catch the mismatch.
    const { email } = await buildSignedWinlinkEmail("Forged identity.");
    email.body = email.body.replace(
      /IdentityHash: [0-9a-f]+/,
      "IdentityHash: " + "ff".repeat(16),
    );
    const msg = await runHandleAsync(email);
    assert.strictEqual(msg.confidence, "none");
    assert.strictEqual(msg.identityHash, null);
    assert.ok(
      msg.failed || (msg.errors && msg.errors.length > 0),
      "should be marked failed",
    );
  });

  it("rejects when the signature field is missing", async () => {
    const content = "Missing signature field.";
    const identity = await Identity.generate();
    const publicKey = await identity.getPublicKey();
    const metadata =
      "---BEGIN RETICULUM METADATA---\n" +
      `IdentityHash: ${toHex(identity.identityHash)}\n` +
      `PublicKey: ${toHex(publicKey)}\n` +
      "Algorithm: Ed25519\n" +
      "---END RETICULUM METADATA---\n";
    const email = {
      from: { address: "call@winlink.org" },
      body:
        metadata +
        "\n---BEGIN BLOG POST---\n" +
        content +
        "\n---END BLOG POST---",
    };
    const msg = await runHandleAsync(email);
    assert.strictEqual(msg.confidence, "none");
    assert.strictEqual(msg.identityHash, null);
    assert.ok(
      msg.failed || (msg.errors && msg.errors.length > 0),
      "missing sig should fail",
    );
  });

  it("rejects when no signed-content block is present", async () => {
    const { email } = await buildSignedWinlinkEmail("should be stripped");
    // Strip the BLOG POST block, leaving only the metadata.
    email.body = email.body.replace(
      /\n---BEGIN BLOG POST---[\s\S]*?---END BLOG POST---/,
      "",
    );
    const msg = await runHandleAsync(email);
    assert.strictEqual(msg.confidence, "none");
    assert.strictEqual(msg.identityHash, null);
    assert.ok(
      msg.failed || (msg.errors && msg.errors.length > 0),
      "no signed content should fail",
    );
  });
});

describe("AuthVerifier.extractReticulumMetadata", () => {
  it("parses all fields order-independently", () => {
    const v = makeVerifier();
    const meta = v.extractReticulumMetadata({
      body:
        "---BEGIN RETICULUM METADATA---\n" +
        "Algorithm: Ed25519\n" +
        "Sig: deadbeef\n" +
        "IdentityHash: abc123\n" +
        "PublicKey: 0123456789abcdef\n" +
        "---END RETICULUM METADATA---",
    });
    assert.strictEqual(meta.identityHash, "abc123");
    assert.strictEqual(meta.publicKey, "0123456789abcdef");
    assert.strictEqual(meta.algorithm, "Ed25519");
    assert.strictEqual(meta.sig, "deadbeef");
  });

  it("returns null when no metadata block is present", () => {
    const v = makeVerifier();
    assert.strictEqual(
      v.extractReticulumMetadata({ body: "plain email" }),
      null,
    );
  });
});
