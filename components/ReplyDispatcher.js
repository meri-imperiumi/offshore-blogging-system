const { Component, failed, fail } = require("noflo-assembly");

/**
 * ReplyDispatcher - Routes replies based on channel
 *
 * Logic:
 * - Reads msg.channel
 * - If 'winlink', emits unchanged to SMTP
 * - If 'inreach', emits unchanged to INREACH
 * - If missing or unrecognized, fails and routes to ErrorLogger
 */
class ReplyDispatcher extends Component {
  constructor() {
    super({
      description: "Routes replies based on channel (inreach/winlink)",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message to route as reply",
        },
      },
      outPorts: {
        smtp: {
          datatype: "object",
          description: "Reply to send via SMTP (Winlink)",
        },
        inreach: {
          datatype: "object",
          description: "Reply to send via InReach",
        },
        error: {
          datatype: "object",
          description: "Failed messages (e.g., missing channel)",
        },
      },
    });
  }

  handle(input, output) {
    if (!input.hasData("in")) {
      return null;
    }

    const msg = input.getData("in");

    // Check for failed messages
    if (failed(msg)) {
      output.send({ error: msg });
      return output.sendDone();
    }

    // Validate channel is present
    if (!msg.channel) {
      fail(msg, new Error("Missing channel in reply message"));
      output.send({ error: msg });
      return output.sendDone();
    }

    // Route based on channel
    switch (msg.channel) {
      case "winlink":
        output.send({ smtp: msg });
        break;

      case "inreach":
        output.send({ inreach: msg });
        break;

      default:
        fail(msg, new Error(`Unrecognized channel: ${msg.channel}`));
        output.send({ error: msg });
        break;
    }

    return output.sendDone();
  }
}

exports.getComponent = () => new ReplyDispatcher();
