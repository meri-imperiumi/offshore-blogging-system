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
      validates: {
        payload: "ok",
      },
    });

    // 96 base64 chars + ~23-char envelope header = ~119 chars total,
    // safely under Garmin's 120-char reliable budget. Both reference
    // implementations (references/GRIB-via-inReach,
    // references/MarineGRIB-InReach-Transmitter) independently discovered
    // that messages get truncated around the 130-140 char mark and capped
    // at 120. See references/garmin-character-counts.txt.
    this.maxChunkSize = 96;
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
      // Get binary data
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

      // Chunk the base64 string. Each chunk will be wrapped by InReachSender
      // in a `msg i/total:grib:<id>\n` envelope (~21-23 chars), so the chunk
      // size must be small enough that header + data stays under Garmin's
      // ~120-char truncation threshold (see this.maxChunkSize note above).
      const chunks = [];
      for (let i = 0; i < base64Data.length; i += this.maxChunkSize) {
        chunks.push(base64Data.slice(i, i + this.maxChunkSize));
      }

      // Update message with chunked payload
      msg.payload = chunks;
      // Label the partType so InReachSender wraps each chunk in a
      // `msg i/total:grib:<transmissionId>` envelope. Without this the
      // sender falls back to partType 'text' (it checks msg.partType
      // before msg.intent), and the boat's web UI couldn't tell GRIB
      // chunks apart from text replies.
      msg.partType = "grib";

      return output.sendDone(msg);
    } catch (err) {
      fail(msg, new Error(`GRIB chunking failed: ${err.message}`));
      return output.sendDone(msg);
    }
  }
}

exports.getComponent = () => new GribChunker();
