const { Component, failed } = require("noflo-assembly");

/**
 * BlogAckBuilder - Build a confirmation reply after blog post is decoded.
 *
 * Sits between BlogDecoder and InReachSender in the E2E test pipeline.
 * Takes the decoded blog post data and produces a short confirmation
 * message suitable for sending back via InReach.
 *
 * Example output payload:
 *   Blog OK: "Fish Adventure" (4/4 chunks)
 */
class BlogAckBuilder extends Component {
  constructor() {
    super({
      description:
        "Builds a short InReach confirmation reply after blog post decoding",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message with decoded blog post",
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Assembly message with confirmation reply text",
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

    // BlogDecoder puts the decoded post in msg.payload as an object
    const post = msg.payload;
    const title = post?.title || "(unknown)";
    const parts = msg.totalChunks || "?";

    // Build a short confirmation message for InReach
    msg.payload = `Reassembled blog post "${title}" successfully from ${parts} parts`;
    msg.intent = "NOTIFY";

    console.log(`[BlogAckBuilder] Building confirmation: ${msg.payload}`);

    return output.sendDone(msg);
  }
}

exports.getComponent = () => new BlogAckBuilder();
