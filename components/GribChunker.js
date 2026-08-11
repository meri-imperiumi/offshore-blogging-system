const { Component, fail } = require("noflo-assembly");

/**
 * GribChunker - Chunks GRIB data for transmission
 *
 * Logic:
 * - Processes binary GRIB data
 * - Splits into appropriately sized chunks for transmission
 * - Returns an array of chunk strings
 */
class GribChunker extends Component {
  constructor() {
    super({
      description: "Chunks GRIB data for transmission",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message with GRIB data",
          required: true,
        },
        max_chunk_size: {
          datatype: "number",
          description:
            "Maximum base64 chars per chunk. Must keep the TOTAL InReach " +
            "message (header `msg i/total:grib:<id>\n` + data) under 120 chars " +
            "— Garmin truncates messages around 130-140 chars (see " +
            "references/garmin-character-counts.txt). Default: 96.",
          control: true,
          required: false,
          default: 96,
        },
      },
    });

    // 96 base64 chars + ~10-char compact header = ~106 chars total,
    // safely under Garmin's 120-char reliable budget. Both reference
    // implementations (references/GRIB-via-inReach,
    // references/MarineGRIB-InReach-Transmitter) independently discovered
    // that messages get truncated around the 130-140 char mark and capped
    // at 120. See references/garmin-character-counts.txt.
    // With the new compact 10-byte header, we gain ~12 chars of payload space.
    this.maxChunkSize = 96;
  }

  /**
   * Generate a 4-char Base62 transmission ID
   */
  generateTransmissionId() {
    const chars =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let id = "";
    for (let i = 0; i < 4; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  }

  handle(input, output) {
    // Process control ports
    if (input.hasData("max_chunk_size")) {
      this.maxChunkSize = input.getData("max_chunk_size");
    }

    // Wait for IN port
    if (!input.hasData("in")) {
      return null;
    }

    const msg = input.getData("in");

    // Validation is explicit for multi-route components
    if (!this.validate(msg)) {
      return output.sendDone(msg);
    }

    try {
      // Payload is validated here rather than via the `validates` option so
      // that a missing payload produces the specific "No GRIB data in
      // payload" error (the generic "payload is false or empty" is less
      // actionable for operators).
      let data = msg.payload;
      if (!data) {
        fail(msg, new Error("No GRIB data in payload"));
        return output.sendDone(msg);
      }

      // Convert to Buffer if string
      if (typeof data === "string") {
        data = Buffer.from(data, "base64");
      }

      // Base64 encode for transmission
      const base64Data = data.toString("base64");

      // Generate 4-char Base62 transmission ID
      const transmissionId = this.generateTransmissionId();

      // Calculate chunk count
      const totalChunks = Math.ceil(base64Data.length / this.maxChunkSize);

      // Build compact header chunks: [ID:4][Type:1][Index:2][Total:2]:[Payload]
      // For downlink GRIBs, no Meta field (4 bytes saved)
      const chunks = [];
      for (let i = 0; i < totalChunks; i++) {
        const index = i + 1; // 1-based
        const piece = base64Data.slice(
          i * this.maxChunkSize,
          (i + 1) * this.maxChunkSize,
        );
        const header = `${transmissionId}G${String(index).padStart(2, "0")}${String(totalChunks).padStart(2, "0")}:`;
        chunks.push(header + piece);
      }

      // Update message with chunked payload
      msg.payload = chunks;
      msg.transmissionId = transmissionId;
      msg.partType = "grib";

      return output.sendDone(msg);
    } catch (err) {
      fail(msg, new Error(`GRIB chunking failed: ${err.message}`));
      return output.sendDone(msg);
    }
  }
}

exports.getComponent = () => new GribChunker();
