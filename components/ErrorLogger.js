const { Component } = require("noflo-assembly");
const fs = require("node:fs");
const path = require("node:path");

/**
 * ErrorLogger - Appends structured error lines to a rotating log file
 *
 * Logic:
 * - Appends timestamp, identityHash, intent, and error detail to log file
 * - Never a terminal failure point - always resolves
 * - For unknown intents or unparseable commands
 */
class ErrorLogger extends Component {
  constructor() {
    super({
      description: "Logs errors to rotating log file",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message with errors",
        },
        logpath: {
          datatype: "string",
          description:
            "Path to log file (optional, defaults to cloud/errors.log)",
          control: true,
          required: false,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Assembly message passed through after logging",
        },
      },
    });
  }

  handle(input, output) {
    if (!input.hasData("in")) {
      return null;
    }

    const msg = input.getData("in");

    // Determine log path
    let logPath = input.hasData("logpath") ? input.getData("logpath") : null;
    if (!logPath) {
      // Default to cloud/errors.log in project root
      logPath = path.join(__dirname, "..", "cloud", "errors.log");
    }

    // Ensure log directory exists
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) {
      try {
        fs.mkdirSync(logDir, { recursive: true });
      } catch (mkdirErr) {
        // If we can't create log dir, still resolve so graph doesn't stall
        console.error(
          "ErrorLogger: Failed to create log directory:",
          mkdirErr.message,
        );
        return output.sendDone(msg);
      }
    }

    // Build log entry
    const timestamp = new Date().toISOString();
    const identityHash = msg.identityHash || "UNKNOWN";
    const intent = msg.intent || "UNKNOWN";
    const channel = msg.channel || "UNKNOWN";
    const payload = msg.payload || "";

    // Extract error details - log ALL errors, not just the last one
    let errorDetails = "No error details";
    if (Array.isArray(msg.errors) && msg.errors.length > 0) {
      // Format each error with its code (if present) for better traceability
      errorDetails = msg.errors
        .map((err, i) => {
          const prefix = i === msg.errors.length - 1 ? "→ " : "  ";
          return err.code
            ? `${prefix}[${err.code}] ${err.message}`
            : `${prefix}${err.message}`;
        })
        .join("\n");
    } else if (msg.error) {
      errorDetails = msg.error.message || String(msg.error);
    }

    // Include payload if it's not too large
    let payloadSnippet = "";
    if (msg.payload) {
      const payloadStr =
        typeof msg.payload === "string"
          ? msg.payload
          : JSON.stringify(msg.payload);
      payloadSnippet =
        payloadStr.length > 200
          ? `${payloadStr.substring(0, 200)}...`
          : payloadStr;
    }

    const logEntry = `[${timestamp}] identity=${identityHash} channel=${channel} intent=${intent} errors="${errorDetails}" payload="${payloadSnippet}"\n`;

    // Write to log file
    try {
      fs.appendFileSync(logPath, logEntry, "utf-8");
    } catch (writeErr) {
      // If we can't write to log, output to console but still resolve
      console.error(
        "ErrorLogger: Failed to write to log file:",
        writeErr.message,
      );
      console.error("ErrorLogger: Entry was:", logEntry);
    }

    // Always resolve - pass the message through on `out` so downstream
    // (e.g. a future alert forwarder) can react. Never stalls the graph.
    // Send only if the out port is attached.
    if (this.outputPortIsAttached()) {
      return output.sendDone({ out: msg });
    }
    return output.done();
  }

  outputPortIsAttached() {
    return this.outPorts.out && this.outPorts.out.isAttached();
  }
}

exports.getComponent = () => new ErrorLogger();
