const { IP } = require("noflo");
const { Component, failed } = require("noflo-assembly");

/**
 * ParserRouter - Routes messages based on intent using array ports
 *
 * Logic:
 * - Receives an Array of expected intents on initialization
 * - Compares msg.intent to the array index and emits the IP out the matching OUT[x]
 * - Failed messages route to ERROR
 * - Unknown/unrecognized intents route to MISSED
 */
class ParserRouter extends Component {
  constructor() {
    super({
      description: "Routes messages based on intent using array ports",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message with intent",
        },
        routes: {
          datatype: "string",
          description:
            "Comma-separated list of expected intents (e.g., BLOG,GRIB,SAILDOCS,SYS,NOTIFY)",
          control: true,
          required: true,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Output array port - route based on intent",
          addressable: true,
        },
        error: {
          datatype: "object",
          description:
            "Failed messages (sent to ReplyDispatcher for error replies)",
        },
        missed: {
          datatype: "object",
          description: "Unknown/unrecognized intents",
        },
      },
    });

    this.routes = [];
  }

  handle(input, output) {
    // Process control port data
    if (input.hasData("routes")) {
      const routesStr = input.getData("routes");
      this.routes = routesStr.split(",").map((r) => r.trim());
    }

    // Wait for main IN port data
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
      output.send({ error: msg });
      return output.done();
    }

    // Check if intent is set
    if (!msg.intent) {
      // No intent - route to MISSED
      output.send({ missed: msg });
      return output.done();
    }

    // Find the matching route index
    const routeIndex = this.routes.indexOf(msg.intent);

    if (routeIndex === -1) {
      // Unknown intent - route to MISSED
      output.send({ missed: msg });
      return output.done();
    }

    // Route to the correct output port
    output.send({ out: new IP("data", msg, { index: routeIndex }) });
    return output.done();
  }
}

exports.getComponent = () => new ParserRouter();
