const { Component, fail } = require("noflo-assembly");
const { Identity, toHex, fromHex } = require("@reticulum/core");
const DatabaseHelper = require("../lib/DbHelper");

/**
 * AuthVerifier - Detects transport type and maps sender to Reticulum Identity Hash
 *
 * Logic:
 * - Detects transport type (Winlink signature vs. Garmin DMARC/SPF)
 * - Sets msg.channel ('inreach' | 'winlink')
 * - Maps verified sender to a Reticulum Identity Hash
 * - Sets msg.confidence ('high', 'medium', 'none')
 * - If verification fails, invokes fail(msg) with Unauthorized error
 * - Assigns identityHash = 'SYS_SAILDOCS' for query@saildocs.com
 */
class AuthVerifier extends Component {
  constructor() {
    super({
      description:
        "Detects transport type, verifies sender, sets identity hash and channel",
      inPorts: {
        in: {
          datatype: "object",
          description: "Email message to verify",
        },
        dbpath: {
          datatype: "string",
          description:
            "Database path (default: :memory:). The cloud graph shares a file DB so device registrations persist.",
          control: true,
          required: false,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Verified assembly message",
        },
      },
    });

    // Lazily initialized from `dbpath` on first message that needs a device
    // lookup. The runners instead inject a pre-populated `this.db` instance
    // post-start (`network.getNode('Verifier').component.db = db`); that path
    // still works — if `this.db` is already set, dbpath is ignored.
    this.db = null;
    this.dbPath = ":memory:";
  }

  handle(input, output) {
    // Read the DB path control port (buffered from an IIP). The DB itself is
    // created lazily in lookupInReachDevice(), so Saildocs/Winlink messages
    // (which never look up a device) don't pay for a connection.
    if (input.hasData("dbpath")) {
      this.dbPath = input.getData("dbpath");
    }

    if (!input.hasData("in")) {
      return;
    }

    const email = input.getData("in");

    // Initialize assembly message. imapUid is carried through the pipeline
    // so ImapAcker can mark the original email as seen after processing.
    const msg = {
      errors: [],
      identityHash: null,
      replyTo: null,
      channel: null,
      intent: null,
      payload: email.body || "",
      confidence: "none",
      imapUid: email.imapUid || null,
      // Carry the raw RFC 5322 message source through the pipeline so
      // downstream components (SaildocsMatcher) can extract binary MIME
      // attachments that aren't in the decoded body text.
      raw: email.raw || null,
    };

    // Extract reply-to address
    msg.replyTo = email.from?.address || email.replyTo?.address || null;

    // Check for Saildocs (special case). Responses come from
    // query-reply@saildocs.com, outbound requests go to query@saildocs.com —
    // match the whole domain so both are recognized as SYS_SAILDOCS.
    if (msg.replyTo && msg.replyTo.endsWith("@saildocs.com")) {
      msg.identityHash = "SYS_SAILDOCS";
      // Saildocs doesn't have a channel of its own - it's restored by SaildocsMatcher
      msg.channel = null;
      msg.confidence = "high";
      return output.sendDone(msg);
    }

    // Detect Winlink (by signature or sender domain)
    if (this.isWinlink(email)) {
      msg.channel = "winlink";
      // Ed25519 verification is async (WebCrypto). Fire-and-forget and let the
      // promise own the output lifecycle — `handle` itself must stay sync (see
      // component-basics.md "Async/Await Trap": a returned Promise is treated
      // as an implicit sendDone()).
      this.verifyWinlinkSignature(email)
        .then((verification) => {
          msg.identityHash = verification.identityHash;
          msg.confidence = verification.confidence;
          if (msg.confidence === "none") {
            return output.sendDone(
              fail(msg, new Error("Unauthorized: Invalid Winlink signature")),
            );
          }
          return output.sendDone(msg);
        })
        .catch((err) => {
          console.error(
            `[AuthVerifier] Winlink verification error: ${err.message}`,
          );
          return output.sendDone(
            fail(msg, new Error(`Unauthorized: Winlink verification error`)),
          );
        });
      return;
    }
    // Detect InReach (by Garmin sender domains)
    else if (this.isInReach(email)) {
      msg.channel = "inreach";
      const verification = this.verifyInReachSender(email);
      msg.identityHash = verification.identityHash;
      msg.confidence = verification.confidence;

      // Extract the Garmin reply URL from the email body so InReachSender
      // knows where to POST the response.
      const replyUrl = this.extractInReachReplyUrl(email);
      if (replyUrl) {
        msg.replyTo = replyUrl;
        console.log(
          `[AuthVerifier] InReach verified, confidence=${msg.confidence}, replyTo=${replyUrl}`,
        );
      } else {
        console.log(`[AuthVerifier] InReach verified but no reply URL found`);
      }

      if (msg.confidence === "none") {
        return output.sendDone(
          fail(msg, new Error("Unauthorized: Invalid InReach sender")),
        );
      }
    }
    // Unknown transport
    else {
      return output.sendDone(
        fail(msg, new Error("Unauthorized: Unknown transport type")),
      );
    }

    return output.sendDone(msg);
  }

  /**
   * Check if email is from Winlink
   */
  isWinlink(email) {
    const sender = email.from?.address || "";
    return (
      sender.endsWith("@winlink.org") ||
      sender.includes("wl2k") ||
      email.subject?.includes("Reticulum Metadata")
    );
  }

  /**
   * Check if email is from InReach (Garmin)
   */
  isInReach(email) {
    const sender = email.from?.address || "";
    return sender === "no.reply.inreach@garmin.com";
  }

  /**
   * Verify the Winlink Reticulum Ed25519 signature.
   *
   * The metadata block (produced by the Signal K plugin's `signForWinlink`)
   * carries IdentityHash, the 64-byte PublicKey (X25519 ‖ Ed25519), Algorithm,
   * and Sig — so the email is self-contained: no out-of-band identity directory
   * is needed to resolve hash→pubkey. The signature is over the blog-post
   * content (the text between the `---BEGIN BLOG POST---` / `---END BLOG
   * POST---` delimiters), matching exactly what the plugin signed.
   *
   * Verification:
   *   1. Reconstruct the Identity from the embedded public key.
   *   2. Recompute its identityHash and confirm it equals the claimed
   *      IdentityHash — otherwise an attacker could supply a victim's
   *      IdentityHash with their own key and the signature would still verify.
   *   3. Validate the Ed25519 signature over the signed content.
   *
   * Any failure (missing/ malformed fields, hash mismatch, bad signature) →
   * `{ identityHash: null, confidence: "none" }` so the caller fails closed.
   *
   * @returns {Promise<{ identityHash: string|null, confidence: string }>}
   */
  async verifyWinlinkSignature(email) {
    const metadata = this.extractReticulumMetadata(email);
    if (
      !metadata ||
      !metadata.identityHash ||
      !metadata.publicKey ||
      !metadata.sig
    ) {
      return { identityHash: null, confidence: "none" };
    }

    const content = this.extractSignedContent(email);
    if (content === null) {
      // No verifiable signed-content block. Winlink signatures currently cover
      // blog-post content only; a Winlink message without that block cannot be
      // authenticated and is denied (see cloud.md / SPEC.md §Email signatures).
      return { identityHash: null, confidence: "none" };
    }

    try {
      const publicKey = fromHex(metadata.publicKey);
      if (publicKey.length !== 64) {
        return { identityHash: null, confidence: "none" };
      }
      const identity = await Identity.fromPublicKey(publicKey);

      // Confirm the reconstructed key hashes to the claimed IdentityHash. This
      // binds the pubkey to the identity — without it, a forged email could
      // carry a victim's IdentityHash alongside the attacker's own key.
      if (
        toHex(identity.identityHash) !== metadata.identityHash.toLowerCase()
      ) {
        return { identityHash: null, confidence: "none" };
      }

      const signature = fromHex(metadata.sig);
      const messageBytes = Buffer.from(content, "utf-8");
      const valid = await identity.validate(signature, messageBytes);
      if (!valid) {
        return { identityHash: null, confidence: "none" };
      }

      return { identityHash: metadata.identityHash, confidence: "high" };
    } catch (err) {
      console.error(
        `[AuthVerifier] Winlink signature verification failed: ${err.message}`,
      );
      return { identityHash: null, confidence: "none" };
    }
  }

  /**
   * Extract the signed blog-post content from the email — the text between the
   * `---BEGIN BLOG POST---` and `---END BLOG POST---` delimiters. This is
   * exactly the byte range `signForWinlink` signed (the raw content, without
   * the delimiters), so the signature verifies over identical bytes.
   *
   * @param {object} email
   * @returns {string|null}
   */
  extractSignedContent(email) {
    const body = email.body || email.raw || "";
    const text = Buffer.isBuffer(body) ? body.toString("utf-8") : String(body);
    const m = text.match(
      /---BEGIN BLOG POST---\r?\n([\s\S]*?)\r?\n---END BLOG POST---/,
    );
    return m ? m[1] : null;
  }

  /**
   * Verify InReach sender via device ID from bounce token
   */
  verifyInReachSender(email) {
    // Extract device ID from bounce token (cryptographically signed by Garmin)
    // Format: bounces+{{ device_id }}-{{ recipient }}@inreacheml.garmin.com
    const deviceId = this.extractInReachDeviceId(email);

    if (!deviceId) {
      return { identityHash: null, confidence: "none" };
    }

    // Lookup device mapping
    const device = this.lookupInReachDevice(deviceId);

    if (!device) {
      console.log(
        `[AuthVerifier] Unknown InReach device: ${deviceId}. Please register it.`,
      );
      return { identityHash: null, confidence: "none" };
    }

    return {
      identityHash: device.identity_hash,
      // Medium, not high: the bounce token identifies the device, but the
      // message body is not cryptographically signed (unlike Winlink's
      // Ed25519 signature). See SPEC.md §Email signatures.
      confidence: "medium",
    };
  }

  /**
   * Extract InReach device ID from bounce token
   */
  extractInReachDeviceId(email) {
    const returnPath =
      email.returnPath ||
      email.headers?.returnPath ||
      email.headers?.["return-path"] ||
      "";
    // Format: bounces+<deviceId>-<recipient>@inreacheml.garmin.com
    // deviceId is numeric; recipient may contain dashes (e.g. boat=lille-oe.de)
    const match = returnPath.match(/bounces\+(\d+)-/);
    return match ? match[1] : null;
  }

  lookupInReachDevice(deviceId) {
    // For testing, check environment variable first
    if (process.env.TEST_DEVICE_ID && process.env.TEST_IDENTITY_HASH) {
      if (deviceId === process.env.TEST_DEVICE_ID) {
        return {
          bounce_token: deviceId,
          imei: process.env.TEST_IMEI || "test",
          identity_hash: process.env.TEST_IDENTITY_HASH,
          owner_name: "Test User",
        };
      }
    }

    // Device → identity mapping comes from the `inreach_devices` SQLite table
    // (or TEST_* env vars in tests). Capability checking (e.g. blog:publish) is
    // NOT done here — that's DacarAuthorizer's job, downstream of this
    // component, once the identity hash is known.

    // Lazily open the SQLite DB from the configured dbpath so the graph is
    // self-contained (no post-start property injection needed).
    if (!this.db && this.dbPath) {
      this.db = new DatabaseHelper(this.dbPath);
      this.db.initialize();
    }
    if (this.db) {
      return this.db.getInReachDevice(deviceId);
    }

    return null;
  }

  shutdown() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Extract the Garmin InReach reply URL from the email.
   *
   * InReach emails contain a reply link. Historically this was the direct
   * reply endpoint:
   *   https://explore.garmin.com/TextMessage/TxtMsg?extId=<GUID>&adr=...
   * Newer emails use a share link that redirects to it:
   *   https://inreachlink.com/<CODE>
   *     -> https://eur.explore.garmin.com/textmessage/txtmsg?extId=<GUID>
   *
   * The share code uses base64url characters (A-Za-z0-9_-), so the regex
   * must include `_` and `-` or the URL is silently truncated at the first
   * such character (a real bug that produced a short, unusable URL).
   *
   * The raw MIME body is quoted-printable encoded: long lines are soft-broken
   * with a trailing `=` + CRLF. We strip those soft breaks first so a URL
   * split across lines is rejoined before matching.
   */
  extractInReachReplyUrl(email) {
    const sources = [email.raw, email.body].filter(Boolean);
    for (const src of sources) {
      const raw = Buffer.isBuffer(src) ? src.toString("utf-8") : String(src);
      // Remove quoted-printable soft line breaks (trailing '=' + CRLF) so a
      // URL split across wrapped lines is rejoined.
      const text = raw.replace(/=\r?\n/g, "");
      // Prefer a direct reply endpoint (any region subdomain, either case).
      const exploreMatch = text.match(
        /https:\/\/(?:[a-z]+\.)?explore\.garmin\.com\/[Tt]ext[Mm]essage\/[Tt]xt[Mm]sg\?[^\s"<>]+/,
      );
      if (exploreMatch) {
        return exploreMatch[0];
      }
      // Fall back to the inreachlink.com share URL; InReachClient follows
      // its redirect to resolve the reply endpoint.
      const linkMatch = text.match(
        /https:\/\/inreachlink\.com\/[A-Za-z0-9_-]+/,
      );
      if (linkMatch) {
        return linkMatch[0];
      }
    }
    return null;
  }

  /**
   * Extract the Reticulum metadata block from the email body. Parses each
   * field by name so the block is order-independent. Returns null when no
   * metadata block is present.
   *
   * @param {object} email
   * @returns {{ identityHash: string|null, publicKey: string|null, algorithm: string|null, sig: string|null }|null}
   */
  extractReticulumMetadata(email) {
    const body = email.body || email.raw || "";
    const text = Buffer.isBuffer(body) ? body.toString("utf-8") : String(body);
    const block = text.match(
      /---BEGIN RETICULUM METADATA---\s*([\s\S]*?)---END RETICULUM METADATA---/,
    );
    if (!block) return null;
    const meta = block[1];
    const field = (key) => {
      const m = meta.match(new RegExp(`^${key}:\\s*(\\S+)`, "m"));
      return m ? m[1].trim() : null;
    };
    return {
      identityHash: field("IdentityHash"),
      publicKey: field("PublicKey"),
      algorithm: field("Algorithm"),
      sig: field("Sig"),
    };
  }
}

exports.getComponent = () => new AuthVerifier();
