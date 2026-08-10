const { Component, failed } = require("noflo-assembly");
const DatabaseHelper = require("../lib/DbHelper");

// Injectable database factory so tests can supply a pre-populated in-memory DB
// and assert what STATUS reports. Production uses the real DbHelper.
const di = {
  createDatabase: (dbPath) => {
    const db = new DatabaseHelper(dbPath);
    db.initialize();
    return db;
  },
};

/**
 * StatusBuilder - Queries database tables and formats status string
 *
 * Logic:
 * - Queries all SQLite tables (buffer_chunks, grib_gates, pending_saildocs, metrics)
 * - Formats a hyper-condensed string summarizing pending multi-part messages and system health
 * - Mutates IP to a NOTIFY intent and emits
 * - Preserves channel from original STATUS request
 */
class StatusBuilder extends Component {
  constructor() {
    super({
      description: "Queries database and formats status string",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message with STATUS intent",
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
          description:
            "Assembly message with formatted status as NOTIFY intent",
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
      this.db = di.createDatabase(this.dbPath);
    }

    try {
      // Query metrics
      const metrics = this.db.getMetrics();
      const blogPosts = metrics?.blog_posts || 0;
      const msgIn = metrics?.msg_in || 0;
      const msgOut = metrics?.msg_out || 0;

      // Count pending buffer chunks
      const pendingSequences = this.db.countPendingSequences().n || 0;

      // Count pending GRIB gates (unanswered consent prompts)
      const pendingGates = this.db.countGribGates();

      // Count pending Saildocs (outbound queries awaiting a reply)
      const pendingSaildocs = this.db.countPendingSaildocs();

      // Format status string
      const statusLines = [
        `Status:`,
        `  Posts: ${blogPosts}`,
        `  Msg In: ${msgIn}`,
        `  Msg Out: ${msgOut}`,
        `  Pending seqs: ${pendingSequences}`,
        `  Pending gates: ${pendingGates}`,
        `  Pending Saildocs: ${pendingSaildocs}`,
      ];

      // Update message to NOTIFY intent
      msg.intent = "NOTIFY";
      msg.payload = statusLines.join("\n");

      return output.sendDone(msg);
    } catch (_err) {
      // On database error, return a minimal status
      msg.intent = "NOTIFY";
      msg.payload = "Status: Error retrieving system status";
      return output.sendDone(msg);
    }
  }

  shutdown() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

exports.getComponent = () => new StatusBuilder();
exports.di = di;
