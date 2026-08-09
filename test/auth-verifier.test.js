import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

// Load component via createRequire so the test shares the component's CJS module
// instance (same reasoning as the InReachSender/AlertComposer tests).
const require = createRequire(import.meta.url);

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
