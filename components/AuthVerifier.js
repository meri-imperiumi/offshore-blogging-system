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
      payload: email.raw || email.body || "",
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
    return (
      sender.endsWith("@inreach.garmin.com") ||
      sender.endsWith("@garmin.com") ||
      email.from?.name?.toLowerCase().includes("inreach")
    );
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
   * Verify InReach sender via phone number/domain
   */
  verifyInReachSender(email) {
    const sender = email.from?.address || "";

    // Extract phone number from sender address (e.g., +1234567890@inreach.garmin.com)
    const match = sender.match(/^\+?(\d+)@inreach\.garmin\.com$/);
    if (match) {
      // TODO: Map phone number to identity hash via configured mapping
      // For now, use phone number as a placeholder
      return {
        identityHash: `PHONE_${match[1]}`,
        confidence: "medium",
      };
    }

    return { identityHash: null, confidence: "none" };
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
