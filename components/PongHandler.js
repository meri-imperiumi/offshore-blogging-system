const { Component, failed } = require("noflo-assembly");

/**
 * PongHandler - Simple PING/PONG response handler
 *
 * Logic:
 * - Checks if incoming message is "PING"
 * - If yes, responds with "PONG"
 * - Otherwise passes through unchanged
 * - Only handles InReach messages
 */
class PongHandler extends Component {
  constructor() {
    super({
      description: "Responds to PING with PONG for testing",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message with payload",
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Assembly message with PONG response",
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
      return output.sendDone(msg);
    }

    // Only handle InReach messages for ping-pong test
    if (msg.channel !== "inreach") {
      return output.sendDone(msg);
    }

    // InReach emails have the message in the first line, followed by
    // boilerplate (location link, reply instructions). Match the first line.
    const message = (msg.payload || "").trim().split(/\r?\n/)[0].trim();

    if (message === "PING") {
      // Generate PONG response
      msg.payload = "PONG";
      msg.intent = "NOTIFY";
      // replyTo should already be set by upstream component
      return output.sendDone(msg);
    }

    // Not a PING, pass through unchanged
    return output.sendDone(msg);
  }
}

exports.getComponent = () => new PongHandler();
