const { IP } = require("noflo");
const { Component, failed } = require("noflo-assembly");

/**
 * CommandRouter - Routes sys:command payloads to appropriate handlers
 *
 * Logic:
 * - Parses payload text into a verb
 * - Routes via array-port pattern (GATE,STATUS)
 * - "YES <gateId>" or "CANCEL <gateId>" routes to OUT[0] with parsed gateId/action
 * - "STATUS" routes to OUT[1]
 * - Unknown commands route to MISSED
 */
class CommandRouter extends Component {
  constructor() {
    super({
      description: "Routes sys:command payloads",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message with sys:command payload",
        },
        routes: {
          datatype: "string",
          description:
            "Comma-separated list of expected commands (e.g., GATE,STATUS)",
          control: true,
          required: true,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Output array port - route based on command",
          addressable: true,
        },
        missed: {
          datatype: "object",
          description: "Unknown/unrecognized commands",
        },
      },
    });

    this.routes = [];
  }

  handle(input, output) {
    // Process control port
    if (input.hasData("routes")) {
      const routesStr = input.getData("routes");
      this.routes = routesStr.split(",").map((r) => r.trim());
    }

    // Wait for main IN port
    if (!input.hasData("in")) {
      return null;
    }

    // If no routes configured, wait for control port
    if (this.routes.length === 0) {
      return null;
    }

    const msg = input.getData("in");

    // Check for failed messages
    if (failed(msg)) {
      output.send({ missed: msg });
      return output.sendDone();
    }

    // Parse command from payload
    const payload = typeof msg.payload === "string" ? msg.payload.trim() : "";
    const parts = payload.split(/\s+/);
    const verb = parts[0]?.toUpperCase();

    // Check for YES or CANCEL commands
    if (verb === "YES" || verb === "CANCEL") {
      const routeIndex = this.routes.indexOf("GATE");
      if (routeIndex !== -1) {
        const gateId = parts[1] || null;
        msg.commandAction = verb;
        msg.gateId = gateId;
        output.send({ out: new IP("data", msg, { index: routeIndex }) });
        return output.sendDone();
      }
    }

    // Check for STATUS command
    if (verb === "STATUS") {
      const routeIndex = this.routes.indexOf("STATUS");
      if (routeIndex !== -1) {
        output.send({ out: new IP("data", msg, { index: routeIndex }) });
        return output.sendDone();
      }
    }

    // Unknown command - route to MISSED
    output.send({ missed: msg });
    return output.sendDone();
  }
}

exports.getComponent = () => new CommandRouter();
