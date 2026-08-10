const { Component, failed } = require("noflo-assembly");

/**
 * BlogAckBuilder - Build a confirmation reply after blog post is decoded.
 *
 * Sits between BlogDecoder and InReachSender in the E2E test pipeline.
 * Takes the decoded blog post data and produces a short confirmation
 * message suitable for sending back via InReach.
 *
 * Example output payload:
 *   Blog OK: 2026-08-09.md (4 parts)
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
    const filename = post?.filename || "(unknown)";
    const parts = msg.totalChunks || "?";

    // Build a NEW message rather than mutating the input. Decoder.out is
    // forked to both this component and GitPublisher, which both receive
    // the *same* object reference. This component is synchronous and would
    // run before GitPublisher's async handler captures msg.payload — so
    // mutating it here would overwrite the blog data object with a string
    // and make GitPublisher fail validation. Emitting a fresh object leaves
    // the original msg intact for the parallel branch.
    const reply = {
      ...msg,
      errors: [],
      payload: `Blog OK: ${filename}.md (${parts} parts)`,
      intent: "NOTIFY",
    };

    console.log(`[BlogAckBuilder] Building confirmation: ${reply.payload}`);

    return output.sendDone(reply);
  }
}

exports.getComponent = () => new BlogAckBuilder();
