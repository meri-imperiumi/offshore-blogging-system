const { Component, failed, fail } = require("noflo-assembly");

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
          description: "Assembly message with binary GRIB data",
        },
        max_chunk_size: {
          datatype: "number",
          description: "Maximum bytes per chunk (default: 140 for InReach)",
          control: true,
          required: false,
          default: 140,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Assembly message with chunked payload array",
        },
      },
    });

    this.maxChunkSize = 140;
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

    // Check for failed messages
    if (failed(msg)) {
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

      // Chunk the base64 string
      const chunks = [];
      for (let i = 0; i < base64Data.length; i += this.maxChunkSize) {
        chunks.push(base64Data.slice(i, i + this.maxChunkSize));
      }

      // Update message with chunked payload
      msg.payload = chunks;

      return output.sendDone(msg);
    } catch (err) {
      fail(msg, new Error(`GRIB chunking failed: ${err.message}`));
      return output.sendDone(msg);
    }
  }
}

exports.getComponent = () => new GribChunker();
