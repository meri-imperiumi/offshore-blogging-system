const { Component, fail } = require("noflo-assembly");

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
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Verified assembly message",
        },
      },
    });
  }

  handle(input, output) {
    if (!input.hasData("in")) {
      return null;
    }

    const email = input.getData("in");

    // Initialize assembly message
    const msg = {
      errors: [],
      identityHash: null,
      replyTo: null,
      channel: null,
      intent: null,
      payload: email.body || "",
      confidence: "none",
    };

    // Extract reply-to address
    msg.replyTo = email.from?.address || email.replyTo?.address || null;

    // Check for Saildocs (special case)
    if (msg.replyTo === "query@saildocs.com") {
      msg.identityHash = "SYS_SAILDOCS";
      // Saildocs doesn't have a channel of its own - it's restored by SaildocsMatcher
      msg.channel = null;
      msg.confidence = "high";
      return output.sendDone(msg);
    }

    // Detect Winlink (by signature or sender domain)
    if (this.isWinlink(email)) {
      msg.channel = "winlink";
      const verification = this.verifyWinlinkSignature(email);
      msg.identityHash = verification.identityHash;
      msg.confidence = verification.confidence;

      if (msg.confidence === "none") {
        return output.sendDone(
          fail(msg, new Error("Unauthorized: Invalid Winlink signature")),
        );
      }
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
        console.log(
          `[AuthVerifier] InReach verified but no reply URL found`,
        );
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
   * Verify Winlink Reticulum signature
   */
  verifyWinlinkSignature(email) {
    // Extract Reticulum metadata from email body
    const metadata = this.extractReticulumMetadata(email);
    if (!metadata) {
      return { identityHash: null, confidence: "none" };
    }

    // TODO: Implement actual Ed25519 signature verification
    // For now, extract the identity hash from the metadata
    return {
      identityHash: metadata.identityHash,
      confidence: metadata.identityHash ? "high" : "medium",
    };
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
      confidence: "high",
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

    // Check Dacar tuples (future)
    // TODO: Implement Dacar lookup

    // Check SQLite database
    if (this.db) {
      return this.db.getInReachDevice(deviceId);
    }

    return null;
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
   * Extract Reticulum metadata from email body
   */
  extractReticulumMetadata(email) {
    const body = email.body || email.raw || "";
    const match = body.match(
      /---BEGIN RETICULUM METADATA---\s*IdentityHash:\s*(\S+)/,
    );
    if (match) {
      return { identityHash: match[1] };
    }
    return null;
  }
}

exports.getComponent = () => new AuthVerifier();
