const { Component, failed, fail } = require("noflo-assembly");
const zlib = require("node:zlib");

/**
 * BlogDecoder - Decompresses and validates blog posts
 *
 * Logic:
 * - Takes reassembled raw chunk payload from MessageReassembler
 * - Base64-decodes and zlib-inflates using shared preset dictionary
 * - Verifies embedded CRC16 against decompressed bytes
 * - On success, emits normalized IP with { title, date, bodyMarkdown, imageBuffer?, postId }
 * - On validation failure, invokes fail(msg) with error details
 */
class BlogDecoder extends Component {
  constructor() {
    super({
      description: "Decompresses and validates blog posts",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message with reassembled payload",
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Decoded blog post data",
        },
      },
    });

    // Shared preset dictionary for compression
    // In production, this would be loaded from a file
    this.dictionary = Buffer.from("signalk-offshore-blogging-v1", "utf-8");
  }

  handle(input, output) {
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
      // Base64 decode
      const decoded = Buffer.from(msg.payload, "base64");

      // Extract dictionary version from first byte
      const _dictVersion = decoded[0];
      const compressedData = decoded.slice(1);

      // Decompress using preset dictionary
      const decompressed = zlib.inflateRaw(compressedData, {
        dictionary: this.dictionary,
      });

      const postStr = decompressed.toString("utf-8");

      // Parse the post structure (similar to front matter format)
      const match = postStr.match(/^---\n(.+?)\n---\n(.+)$/s);
      if (!match) {
        fail(msg, new Error("Invalid blog post format"));
        return output.sendDone(msg);
      }

      const frontMatter = match[1];
      const body = match[2];

      // Parse front matter
      const metadata = {};
      const lines = frontMatter.split("\n");
      for (const line of lines) {
        const colonPos = line.indexOf(":");
        if (colonPos > 0) {
          const key = line.slice(0, colonPos).trim();
          const value = line.slice(colonPos + 1).trim();
          metadata[key] = value;
        }
      }

      // Validate required fields
      if (!metadata.title || !metadata.date || !metadata.postid) {
        fail(
          msg,
          new Error("Missing required metadata fields (title, date, postid)"),
        );
        return output.sendDone(msg);
      }

      // Verify CRC16 if present
      if (metadata.crc) {
        const computedCrc = this.calculateCRC16(
          Buffer.from(`${frontMatter}\n---\n${body}`),
        );
        if (computedCrc !== parseInt(metadata.crc, 16)) {
          fail(msg, new Error("CRC16 mismatch"));
          return output.sendDone(msg);
        }
      }

      // Extract and decode image if present
      const imageBuffer = null;
      if (metadata.image) {
        // Image is stored in the message payload separately
        // For now, we'll just mark it as present
        // In a full implementation, we'd need to handle multi-part messages
      }

      // Build normalized output
      const result = {
        title: metadata.title,
        date: metadata.date,
        postId: metadata.postid,
        bodyMarkdown: body,
        imageBuffer: imageBuffer,
        // Preserve original routing fields
        identityHash: msg.identityHash,
        replyTo: msg.replyTo,
        channel: msg.channel,
        confidence: msg.confidence,
      };

      msg.payload = result;
      return output.sendDone(msg);
    } catch (err) {
      fail(msg, new Error(`Blog decoding failed: ${err.message}`));
      return output.sendDone(msg);
    }
  }

  /**
   * Calculate CRC16
   */
  calculateCRC16(buffer) {
    let crc = 0xffff;
    for (let i = 0; i < buffer.length; i++) {
      crc ^= buffer[i] & 0xff;
      for (let j = 0; j < 8; j++) {
        if (crc & 0x0001) {
          crc = (crc >> 1) ^ 0xa001;
        } else {
          crc = crc >> 1;
        }
      }
    }
    return crc & 0xffff;
  }
}

exports.getComponent = () => new BlogDecoder();
