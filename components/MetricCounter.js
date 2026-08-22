const { Component, failed } = require("noflo-assembly");
const DatabaseHelper = require("../lib/DbHelper");

// Injectable DB factory (same seam as StatusBuilder) so tests can share an
// in-memory DB and assert the resulting metric values without touching disk.
const di = {
  createDatabase: (dbPath) => {
    const db = new DatabaseHelper(dbPath);
    db.initialize();
    return db;
  },
};

/**
 * MetricCounter - bumps a metrics-table counter for each message, then
 * forwards the message unchanged. Pure passthrough; the increment count is
 * derived from the message so the components doing the real work (ImapAcker,
 * the senders, GitPublisher) stay free of metric concerns.
 *
 * Count derivation per metric:
 *
 *   msg_in  → number of IMAP uids actually acked (msg.ackedUids, set by
 *             ImapAcker). A failed/partial ack reports fewer/no acked uids,
 *             so a retried message isn't double-counted.
 *
 *   msg_out → number of outbound messages sent (msg.sentCount, set by
 *             SmtpResponder=1 / InReachSender=<chunk count> on success).
 *
 *   blog_posts → 1 when msg.published (GitPublisher sets it only on a real
 *                commit, not the idempotent re-publish no-op).
 *
 * Sits downstream of the component that does the real work, e.g.:
 *   ImapAcker OUT → MetricCounter(metric=msg_in)
 */
class MetricCounter extends Component {
  constructor() {
    super({
      description:
        "Counts processed messages into the metrics table (passthrough)",
      inPorts: {
        in: {
          datatype: "object",
          required: true,
        },
        metric: {
          datatype: "string",
          control: true,
          required: true,
          description:
            "Which metric to increment: msg_in | msg_out | blog_posts",
        },
        dbpath: {
          datatype: "string",
          control: true,
          required: false,
          description: "SQLite path (default :memory:)",
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Input message, unchanged",
        },
      },
    });

    this.db = null;
    this.dbPath = ":memory:";
    this.metric = null;
  }

  /**
   * How many to add to the metric for this message. See class doc.
   */
  deriveCount(msg) {
    if (this.metric === "msg_in") {
      const acked = Array.isArray(msg.ackedUids) ? msg.ackedUids : [];
      return acked.length;
    }
    if (this.metric === "msg_out") {
      // Number of outbound messages actually sent (SmtpResponder=1,
      // InReachSender=<chunk count> on their success confirms).
      const n = Math.trunc(Number(msg.sentCount));
      return Number.isFinite(n) && n > 0 ? n : 0;
    }
    if (this.metric === "blog_posts") {
      // +1 per real publish; GitPublisher leaves `published` unset/false on
      // its idempotent re-publish no-op so duplicates don't inflate it.
      return msg.published ? 1 : 0;
    }
    return 0;
  }

  handle(input, output) {
    // Read control ports (buffered from IIPs)
    if (input.hasData("metric")) {
      this.metric = input.getData("metric");
    }
    if (input.hasData("dbpath")) {
      this.dbPath = input.getData("dbpath");
    }

    if (!input.hasData("in")) {
      return;
    }

    const msg = input.getData("in");

    // Don't count failed messages — they didn't complete.
    if (failed(msg)) {
      return output.sendDone(msg);
    }

    const count = this.deriveCount(msg);
    if (count > 0) {
      if (!this.db) {
        this.db = di.createDatabase(this.dbPath);
      }
      this.db.incrementMetric(this.metric, count);
    }

    return output.sendDone(msg);
  }

  shutdown() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

exports.getComponent = () => new MetricCounter();
exports.di = di;
