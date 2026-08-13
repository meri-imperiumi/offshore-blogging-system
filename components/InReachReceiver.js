const { Component, failed } = require("noflo-assembly");

/**
 * InReachReceiver - Parse InReach lo-fi message format from email bodies.
 *
 * Sits between AuthVerifier and MessageReassembler in the pipeline.
 *
 * AuthVerifier outputs an assembly message with `msg.payload` containing
 * the raw email body. InReach emails contain a lo-fi chunk line like:
 *
 *   0805T01047F16:Rg8DqgD9wwcm...
 *
 * This component parses that header and converts it to the format
 * MessageReassembler expects:
 *
 *   msg 1/4:T:0805\nRg8DqgD9wwcm...
 *
 * The CRC in the chunk header is the CRC of the *full original data* (not
 * per-chunk), so it cannot be validated until all chunks are reassembled.
 * We pass it through as metadata for downstream validation.
 *
 * Messages that are NOT lo-fi chunks — plain-text weather requests from an
 * InReach device, Saildocs response emails, Winlink blog posts — pass
 * straight through unchanged. Their `intent` is detected from content so
 * ParserRouter can route them to the correct downstream pipeline:
 *
 *   - Saildocs responses (identityHash === 'SYS_SAILDOCS') → SAILDOCS
 *   - 'send <email>:<query>' or 'GRIB ...'                  → GRIB
 *   - 'STATUS' / 'YES <id>' / 'CANCEL <id>'                → SYS
 *   - anything else                                          → null (MISSED)
 */
class InReachReceiver extends Component {
  constructor() {
    super({
      description:
        "Parse InReach lo-fi message format from email bodies and convert " +
        "to MessageReassembler chunk format.",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message with email body in payload",
          required: true,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Assembly message with converted chunk payload",
        },
        error: {
          datatype: "object",
          description: "Failed assembly message if parsing fails",
        },
      },
    });
  }

  handle(input, output) {
    if (!input.hasData("in")) {
      return;
    }

    const msg = input.getData("in");

    // Pass through failed messages
    if (failed(msg)) {
      return output.sendDone(msg);
    }

    // AuthVerifier puts the email body in msg.payload
    const bodyText = Buffer.isBuffer(msg.payload)
      ? msg.payload.toString("utf-8")
      : String(msg.payload || "");

    const lines = bodyText
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "");

    // Parse each line until we find a valid lo-fi chunk
    let chunk = null;
    for (const line of lines) {
      chunk = this.parseLoFi(line);
      if (chunk) {
        break;
      }
    }

    if (!chunk) {
      // Not a lo-fi chunk — this is a plain-text message (weather request,
      // Saildocs response, Winlink blog post, or a system command). Pass it
      // through unchanged and set the intent so ParserRouter can route it.
      // See cloud-server.fbp §1b: "Winlink blog posts and Saildocs replies
      // carry no lo-fi header and pass straight through InReachReceiver
      // unchanged."
      msg.intent = this.detectIntent(msg);
      return output.sendDone(msg);
    }

    // With the new compact header protocol, the blog chunks already use the
    // unified format. No conversion needed - just set the intent for routing.
    msg.payload = chunk.fullLine;
    msg.intent = "BLOG";

    return output.sendDone(msg);
  }

  /**
   * Parse a single line of the unified compact header format.
   *
   * Format: [ID:4][Type:1][Index:2][Total:2][Meta:4 optional]:[Payload]
   * Example: "0715T0205687c:Rg8DqgD9wwcm" (blog post with CRC as meta)
   *
   * @param {string} line - Input line from email body
   * @returns {Object|null} Parsed chunk object or null if invalid
   */
  parseLoFi(line) {
    if (!line) return null;

    // Unified compact header: [ID:4][Type:1][Index:2][Total:2][Meta:4?]:[Payload]
    const match = line.match(
      /^([a-zA-Z0-9]{4})([TI])(\d{2})(\d{2})([0-9a-fA-F]{4})?:(.*)$/s,
    );
    if (!match) {
      return null;
    }

    const transmissionId = match[1];
    const type = match[2]; // T or I for blog posts
    const chunkIndex = parseInt(match[3], 10);
    const totalChunks = parseInt(match[4], 10);
    const crcHex = match[5]; // Optional 4-char CRC
    const payload = match[6];

    if (chunkIndex < 1 || chunkIndex > 99) {
      return null;
    }
    if (totalChunks < 1 || totalChunks > 99) {
      return null;
    }
    if (crcHex && !/^[0-9A-Fa-f]{4}$/.test(crcHex)) {
      return null;
    }
    if (!payload || payload.length === 0) {
      return null;
    }

    return {
      transmissionId,
      partType: type === "T" ? "text" : "image",
      chunkIndex,
      totalChunks,
      payload,
      crc: crcHex ? parseInt(crcHex, 16) : null,
      fullLine: line, // Carry the full line (header + payload) for MessageReassembler
    };
  }

  /**
   * Detect the intent of a plain-text (non-lo-fi) message so ParserRouter
   * can route it to the correct downstream pipeline.
   *
   * Saildocs responses are identified by the SYS_SAILDOCS identity hash
   * that AuthVerifier assigns (sender === query@saildocs.com). For InReach
   * and Winlink plain-text messages, the intent is inferred from the
   * payload content.
   *
   * InReach appends "View the location..." and other boilerplate to the
   * message body, so intent detection uses only the first non-empty line.
   *
   * @param {Object} msg - Assembly message (payload is a string body)
   * @returns {string|null} Intent label, or null if unrecognized
   */
  detectIntent(msg) {
    // Saildocs responses arrive with identityHash === 'SYS_SAILDOCS' and no
    // channel of their own (SaildocsMatcher restores the original channel).
    if (msg.identityHash === "SYS_SAILDOCS") {
      return "SAILDOCS";
    }

    const body =
      typeof msg.payload === "string"
        ? msg.payload.trim()
        : String(msg.payload || "").trim();

    // InReach appends "View the location..." boilerplate after the user's
    // text. Intent detection uses only the first non-empty line so the
    // appended text doesn't interfere with matching.
    const firstLine = body.split(/\r?\n/).find((l) => l.trim() !== "") || "";
    const lower = firstLine.toLowerCase();

    // Weather requests: our shorthand grammar ("send query@saildocs.com:gfs:...")
    if (lower.startsWith("send ") || lower.startsWith("grib")) {
      return "GRIB";
    }

    // Bare Saildocs query: model:area|grid|hours|params
    // e.g. "gfs:58n,60n,018e,022e|2,2|0,12|wind"
    // This is the common case — the user copies a query from the web UI's
    // preset selector and sends it as-is from the InReach device.
    if (this.isSaildocsQuery(firstLine)) {
      return "GRIB";
    }

    // System commands: PING, STATUS, YES <gateId>, CANCEL <gateId>.
    // PING/STATUS are standalone (no argument); YES/CANCEL take a gate id.
    if (
      lower.startsWith("ping") ||
      lower.startsWith("status") ||
      lower.startsWith("yes ") ||
      lower.startsWith("cancel ")
    ) {
      return "SYS";
    }

    // Unrecognized plain text — let ParserRouter route to MISSED so
    // nothing is silently dropped.
    return null;
  }

  /**
   * Check whether a line looks like a bare Saildocs weather query.
   *
   * Format: model:area|grid|hours|params
   *   model  — letters (gfs, ecmwf, icon, ...)
   *   area   — 4 comma-separated lat/lon values with n/s/e/w suffixes
   *   grid   — 2 comma-separated numbers
   *   hours  — comma-separated numbers
   *   params — comma-separated words (wind, press, ...)
   *
   * We require at least 3 pipe-delimited sections after the model:area
   * prefix to avoid false positives on ordinary text.
   *
   * @param {string} line - First non-empty line of the message body
   * @returns {boolean}
   */
  isSaildocsQuery(line) {
    // model:... — starts with a word, then a colon
    if (!/^[a-z]+:/i.test(line)) return false;
    // Must have at least 3 pipe-delimited sections (area|grid|hours|params)
    const pipes = (line.match(/\|/g) || []).length;
    if (pipes < 3) return false;
    // Area section must contain lat/lon tokens with n/s/e/w suffixes
    if (!/[0-9][nsew]/i.test(line)) return false;
    return true;
  }
}

exports.getComponent = () => new InReachReceiver();
