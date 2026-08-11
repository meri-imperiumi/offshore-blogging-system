const { Component } = require("noflo-assembly");

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
      validates: {
        channel: "str",
        payload: "ok",
      },
    });
  }

  relay(msg, output) {
    // Only handle InReach messages for ping-pong test
    if (msg.channel !== "inreach") {
      return output.sendDone(msg);
    }

    // InReach emails have the message in the first line, followed by
    // boilerplate (location link, reply instructions). Match the first line.
    const message = (msg.payload || "").trim().split(/\r?\n/)[0].trim();

    if (message === "PING") {
      console.log("[PongHandler] PING received, sending PONG");
      // Generate PONG response
      msg.payload = "PONG";
      msg.intent = "NOTIFY";
    }
    return output.sendDone(msg);
  }
}

exports.getComponent = () => new PongHandler();
