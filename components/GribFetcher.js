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

    // Check for failed messages. GribFetcher has no `out` port, so failed
    // assemblies are dropped here rather than forwarded.
    if (failed(msg)) {
      return output.done();
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
      return output.done();
    }
  }

  handleSaildocsRequest(msg, payload, output) {
    // Format: "send <email>:<query>". Split on the FIRST colon only — the
    // query itself contains colons (e.g. "gfs:10N,20N,...|..."), so a naive
    // split(":") would over-split and reject every real request.
    const rest = payload.substring(5);
    const colonIdx = rest.indexOf(":");
    if (colonIdx === -1) {
      fail(msg, new Error("Invalid Saildocs request format"));
      return output.done();
    }
    const email = rest.substring(0, colonIdx);
    const query = rest.substring(colonIdx + 1);

    // Generate unique query ID
    const queryId = crypto.randomBytes(8).toString("hex");

    // Save pending request to database with channel
    this.db.savePendingSaildocs(
      queryId,
      msg.identityHash,
      msg.replyTo,
      msg.channel, // PERSIST: for eventual reply routing
    );

    // Saildocs silently ignores emails whose body isn't terminated by a line
    // of five or more dashes (an anti-spam measure; see cloud.md §4). Append
    // the terminator on every outbound request, not just translated ones.
    const terminatedBody = `${query}\n-----`;

    // Build outbound email message. `replyTo` carries the Saildocs address so
    // SmtpResponder (which reads msg.replyTo) addresses the request there;
    // this is a new outbound request, not a reply to the original sender.
    const outboundMsg = {
      to: email,
      replyTo: email,
      subject: `Your query: ${queryId}`,
      body: terminatedBody,
      text: terminatedBody,
      // Mark as Saildocs outbound (not a reply to sender)
      isOutboundRequest: true,
    };

    return output.sendDone({ outbox: outboundMsg });
  }

  handleLocalFetch(msg, _payload, output) {
    // TODO: Implement actual local GRIB API call
    // For now, return a mock response

    fail(msg, new Error("Local GRIB API not yet implemented - use Saildocs"));
    // GribFetcher has no `out`/error port (the production graph drops
    // failures), so just deactivate without forwarding.
    return output.done();
  }

  shutdown() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

exports.getComponent = () => new GribFetcher();
