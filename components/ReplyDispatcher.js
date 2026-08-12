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
          description:
            "Reply to send via SMTP (Winlink), or failed message on error",
        },
        inreach: {
          datatype: "object",
          description: "Reply to send via InReach, or failed message on error",
        },
      },
    });
  }

  handle(input, output) {
    if (!input.hasData("in")) {
      return null;
    }

    const msg = input.getData("in");

    // Check for failed messages - pass through to appropriate channel
    if (failed(msg)) {
      // Route failed messages based on their channel, defaulting to smtp
      const port = msg.channel === "inreach" ? "inreach" : "smtp";
      output.sendDone({ [port]: msg });
      return;
    }

    // Validate channel is present
    if (!msg.channel) {
      fail(msg, new Error("Missing channel in reply message"));
      // Default to smtp for unknown channel
      output.sendDone({ smtp: msg });
      return;
    }

    // Route based on channel
    switch (msg.channel) {
      case "winlink":
        output.sendDone({ smtp: msg });
        return;

      case "inreach":
        output.sendDone({ inreach: msg });
        return;

      default:
        fail(msg, new Error(`Unrecognized channel: ${msg.channel}`));
        output.sendDone({ smtp: msg });
        return;
    }
  }
}

exports.getComponent = () => new ReplyDispatcher();
