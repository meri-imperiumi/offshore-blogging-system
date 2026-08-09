const { Component, failed, fail } = require("noflo-assembly");
const DatabaseHelper = require("../lib/DbHelper");
const crypto = require("node:crypto");

/**
 * GribFetcher - Fetches weather GRIB data
 *
 * Logic:
 * - Processes weather text payload
 * - If fulfilled via local API, emits binary .grb to DIRECT
 * - If using Saildocs, creates mapping in SQLite with channel, formats outbound request, emits to OUTBOX
 */
class GribFetcher extends Component {
  constructor() {
    super({
      description: "Fetches weather GRIB data",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message with weather request",
        },
        dbpath: {
          datatype: "string",
          description: "Database path (default: :memory:)",
          control: true,
          required: false,
        },
      },
      outPorts: {
        direct: {
          datatype: "object",
          description: "Binary .grb data from local API",
        },
        outbox: {
          datatype: "object",
          description: "Formatted email request for Saildocs",
        },
      },
    });

    this.db = null;
    this.dbPath = ":memory:";
  }

  handle(input, output) {
    // Process control ports
    if (input.hasData("dbpath")) {
      this.dbPath = input.getData("dbpath");
    }

    // Initialize database if needed
    if (!this.db) {
      this.db = new DatabaseHelper(this.dbPath);
      this.db.initialize();
    }

    // Wait for IN port
    if (!input.hasData("in")) {
      return null;
    }

    const msg = input.getData("in");

    // Check for failed messages
    if (failed(msg)) {
      return output.sendDone(msg);
    }

    try {
      const payload = typeof msg.payload === "string" ? msg.payload.trim() : "";

      // Parse Saildocs-style request
      // Format: "send <email>:<query>"
      if (payload.startsWith("send ")) {
        return this.handleSaildocsRequest(msg, payload, output);
      }

      // Try to fetch from local API
      return this.handleLocalFetch(msg, payload, output);
    } catch (err) {
      fail(msg, new Error(`GRIB fetch failed: ${err.message}`));
      return output.sendDone(msg);
    }
  }

  handleSaildocsRequest(msg, payload, output) {
    const parts = payload.substring(5).split(":");
    if (parts.length !== 2) {
      fail(msg, new Error("Invalid Saildocs request format"));
      return output.sendDone(msg);
    }

    const [email, query] = parts;

    // Generate unique query ID
    const queryId = crypto.randomBytes(8).toString("hex");

    // Save pending request to database with channel
    this.db.savePendingSaildocs(
      queryId,
      msg.identityHash,
      msg.replyTo,
      msg.channel, // PERSIST: for eventual reply routing
    );

    // Build outbound email message
    const outboundMsg = {
      to: email,
      subject: `Your query: ${queryId}`,
      body: query,
      text: query,
      // Mark as Saildocs outbound (not a reply to sender)
      isOutboundRequest: true,
    };

    return output.send({ outbox: outboundMsg });
  }

  handleLocalFetch(msg, payload, output) {
    // TODO: Implement actual local GRIB API call
    // For now, return a mock response

    fail(msg, new Error("Local GRIB API not yet implemented - use Saildocs"));
    return output.sendDone(msg);
  }

  shutdown() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

exports.getComponent = () => new GribFetcher();
