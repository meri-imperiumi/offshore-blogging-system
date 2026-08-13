const { Component } = require("noflo-assembly");

/**
 * PingHandler - Responds to PING system command with PONG
 *
 * Logic:
 * - Receives assembly messages from CommandRouter for PING commands
 * - Sets payload to "PONG"
 * - Sets intent to "NOTIFY" so ReplyDispatcher sends it back on same channel
 * - Preserves all other message properties (channel, sender, etc.)
 */
class PingHandler extends Component {
  constructor() {
    super({
      description: "Responds to PING system command with PONG",
      validates: {
        channel: "str",
        payload: "ok",
      },
    });
  }

  relay(msg, output) {
    console.log(
      "[PingHandler] PING received, sending PONG on channel:",
      msg.channel,
    );
    // Transform message to PONG response
    msg.payload = "PONG";
    msg.intent = "NOTIFY";
    return output.sendDone(msg);
  }
}

exports.getComponent = () => new PingHandler();
