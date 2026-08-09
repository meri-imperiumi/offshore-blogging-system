const { Component, failed, fail } = require("noflo-assembly");
const DatabaseHelper = require("../lib/DbHelper");

/**
 * DacarAuthorizer - Authorization using Dacar tuple capability store
 *
 * Logic:
 * - Reads the requested permission from the PERMISSION inport
 * - Evaluates msg.identityHash against the local Dacar tuple capability store
 * - Purges expired tuples and checks against tombstones
 * - If valid, passes the IP unchanged (including msg.channel)
 * - If denied, invokes fail(msg), mutates to a NOTIFY intent, emits to DENIED
 */
class DacarAuthorizer extends Component {
  constructor() {
    super({
      description: "Authorization using Dacar tuple capability store",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message to authorize",
        },
        permission: {
          datatype: "string",
          description: "Requested permission (e.g., blog:publish)",
          control: true,
          required: true,
        },
        dbpath: {
          datatype: "string",
          description: "Database path (default: :memory:)",
          control: true,
          required: false,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Authorized assembly message",
        },
        denied: {
          datatype: "object",
          description: "Denied message as NOTIFY intent",
        },
      },
    });

    this.db = null;
    this.dbPath = ":memory:";
    this.currentPermission = null;
  }

  handle(input, output) {
    // Process control ports
    if (input.hasData("dbpath")) {
      this.dbPath = input.getData("dbpath");
    }
    if (input.hasData("permission")) {
      this.currentPermission = input.getData("permission");
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

    // Initialize database if needed
    if (!this.db) {
      this.db = new DatabaseHelper(this.dbPath);
      this.db.initialize();
    }

    // If no permission configured, deny
    if (!this.currentPermission) {
      return this.deny(msg, "No permission configured");
    }

    // Purge expired tuples and tombstones
    this.db.purgeExpiredDacarTuples();
    this.db.purgeExpiredDacarTombstones();

    try {
      // Check if identity is blocked by a tombstone
      const tombstone = this.db.getDacarTombstone(
        msg.identityHash,
        this.currentPermission,
        "execute",
      );
      if (tombstone) {
        return this.deny(msg, "Access revoked");
      }

      // Check for valid tuple
      const tuples = this.db.getDacarTuples(
        msg.identityHash,
        this.currentPermission,
        "execute",
      );

      if (tuples && tuples.length > 0) {
        // Valid tuple found - allow access
        return output.sendDone(msg);
      }

      // No valid tuple - deny access
      return this.deny(msg, `Not authorized for ${this.currentPermission}`);
    } catch (err) {
      // On database error, deny for safety
      return this.deny(msg, `Authorization error: ${err.message}`);
    }
  }

  deny(msg, reason) {
    fail(msg, new Error(reason));
    msg.intent = "NOTIFY";
    msg.payload = `Access denied: ${reason}`;
    return output.send({ denied: msg });
  }

  shutdown() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

exports.getComponent = () => new DacarAuthorizer();
