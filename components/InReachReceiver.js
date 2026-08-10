const { Component, failed, fail } = require("noflo-assembly");

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
      fail(msg, new Error("No valid lo-fi message format found in body"));
      return output.sendDone(msg);
    }

    // Convert to MessageReassembler format:
    // msg <idx>/<total>:<partType>:<transmissionId>\n<payload>
    msg.payload = `msg ${chunk.chunkIndex}/${chunk.totalChunks}:${chunk.partType}:${chunk.transmissionId}\n${chunk.payload}`;

    // A lo-fi chunked InReach message is a blog post (weather requests go as
    // plain text, never in this format). Tag it so ParserRouter routes the
    // reassembled part into the blog pipeline.
    msg.intent = "BLOG";

    return output.sendDone(msg);
  }

  /**
   * Parse a single line of lo-fi format.
   *
   * Format: <postid:4><type:1><idx:2><total:2><crc:4>:<base64 data>
   *
   * @param {string} line - Input line from email body
   * @returns {Object|null} Parsed chunk object or null if invalid
   */
  parseLoFi(line) {
    if (!line) return null;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      return null;
    }

    const header = line.slice(0, colonIndex);
    if (header.length !== 13) {
      return null;
    }

    // Validate header format: index 4 must be T or I (part type)
    const type = header[4];
    if (type !== "T" && type !== "I") {
      return null;
    }

    const postid = header.slice(0, 4);
    const idx = parseInt(header.slice(5, 7), 10);
    const total = parseInt(header.slice(7, 9), 10);
    const crcHex = header.slice(9, 13);
    const payload = line.slice(colonIndex + 1);

    if (Number.isNaN(idx) || idx < 1) {
      return null;
    }
    if (Number.isNaN(total) || total < 1) {
      return null;
    }
    if (!/^[0-9A-Fa-f]{4}$/.test(crcHex)) {
      return null;
    }
    if (!payload || payload.length === 0) {
      return null;
    }

    return {
      transmissionId: postid,
      partType: type,
      chunkIndex: idx,
      totalChunks: total,
      payload: payload,
      crc: parseInt(crcHex, 16),
    };
  }
}

exports.getComponent = () => new InReachReceiver();
