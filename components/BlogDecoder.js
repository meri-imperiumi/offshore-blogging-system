const { Component, failed, fail } = require("noflo-assembly");
const { SAIL_DICT, decompressText } = require("../lib/BlogCodec.js");

/**
 * BlogDecoder - Decompresses and validates blog posts
 *
 * Takes the reassembled base64 payload from MessageReassembler and reverses
 * the encoding done by the Signal K plugin's `compressText` + `chunkData`:
 *
 *   1. Base64-decode → compressed buffer
 *   2. (CRC already verified per-chunk by the plugin; skipped here)
 *   3. Inflate using the shared SAIL_DICT dictionary
 *   4. Split on \x1f → { title, date, body }
 *
 * Emits msg with `msg.payload` set to `{ title, date, body, postId }`.
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
  }

  handle(input, output) {
    if (!input.hasData("in")) {
      return;
    }

    const msg = input.getData("in");

    if (failed(msg)) {
      return output.sendDone(msg);
    }

    try {
      const decoded = decompressText(
        Buffer.from(msg.payload, "base64"),
        SAIL_DICT,
      );

      const result = {
        title: decoded.title,
        date: decoded.date,
        body: decoded.body,
        postId: msg.transmissionId,
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
}

exports.getComponent = () => new BlogDecoder();
