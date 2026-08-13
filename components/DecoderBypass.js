const { Component } = require("noflo-assembly");

/**
 * DecoderBypass - Routes already-decoded messages directly to GitPublisher
 *
 * Checks if msg.payload already contains GitPublisher-format data
 * (filename, title, date, bodyMarkdown, postId, imageBuffers, imageCount).
 * If so, routes to BYPASS port (skipping BlogDecoder).
 * Otherwise routes to OUT port (goes to BlogDecoder for decompression).
 *
 * This is used for Winlink blog posts which are already decoded by
 * WinlinkBlogReceiver, allowing them to bypass BlogDecoder's decompression.
 */
class DecoderBypass extends Component {
  constructor() {
    super({
      description:
        "Routes already-decoded messages directly to GitPublisher, bypassing BlogDecoder",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message",
          required: true,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Message needs decoding (goes to BlogDecoder)",
        },
        bypass: {
          datatype: "object",
          description: "Message already decoded (goes to GitPublisher)",
        },
      },
    });
  }

  handle(input, output) {
    if (!input.hasData("in")) {
      return;
    }

    const msg = input.getData("in");

    // Check if payload is already in GitPublisher format
    const isDecoded =
      msg.payload &&
      typeof msg.payload === "object" &&
      msg.payload.filename !== undefined &&
      msg.payload.title !== undefined &&
      msg.payload.date !== undefined &&
      msg.payload.bodyMarkdown !== undefined &&
      msg.payload.postId !== undefined &&
      msg.payload.imageBuffers !== undefined &&
      msg.payload.imageCount !== undefined;

    if (isDecoded) {
      return output.sendDone({ bypass: msg });
    }

    return output.sendDone({ out: msg });
  }
}

exports.getComponent = () => new DecoderBypass();
