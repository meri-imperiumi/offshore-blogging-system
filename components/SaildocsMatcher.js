const { Component, failed } = require("noflo-assembly");
const DatabaseHelper = require("../lib/DbHelper");

/**
 * SaildocsMatcher - Receives inbound Saildocs emails and matches to pending requests
 *
 * Logic:
 * - Receives inbound Saildocs emails
 * - Extracts the binary attachment
 * - Restores original user's identityHash, replyTo, and channel from SQLite based on subject line
 * - Passes the IP downstream
 */
class SaildocsMatcher extends Component {
  constructor() {
    super({
      description: "Matches Saildocs responses to pending requests",
      inPorts: {
        in: {
          datatype: "object",
          description: "Incoming Saildocs email message",
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
          description:
            "Assembly message for downstream processing (GRIB chunking, Gate, etc.)",
        },
        out: {
          datatype: "object",
          description:
            "Assembly message restored to original channel (ReplyDispatcher)",
        },
        missed: {
          datatype: "object",
          description: "Unmatched Saildocs responses",
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

    const email = input.getData("in");

    // Check for failed messages
    if (failed(email)) {
      return output.sendDone(email);
    }

    try {
      // Extract query ID from subject line. Saildocs responses typically have
      // subject like: "Your query: <query_id>" — but real Saildocs responses
      // actually use the query string as the subject (e.g.
      // "gfs:58n,60n,018e,022e"), so this match often fails. In that case,
      // fall back to the most recent pending request (see below).
      const subject = email.subject || email.payload?.subject || "";
      const match = subject.match(/Your query:\s*(\S+)/i);

      let pending = null;
      if (match) {
        const queryId = match[1];
        pending = this.db.getPendingSaildocs(queryId);
      }

      if (!pending) {
        // No queryId in subject, or queryId not found. Fall back to the
        // most recent pending request. This works because the offshore
        // use case typically has only one request in flight at a time.
        pending = this.db.getMostRecentPendingSaildocs();
      }

      if (!pending) {
        // No matching pending query - might be expired or unknown
        return output.sendDone({ missed: email });
      }

      // Extract binary attachment from email
      const attachment = email.payload?.attachment || email.attachment;
      if (!attachment) {
        // Saildocs response without attachment - treat as error
        return output.sendDone({
          missed: {
            ...email,
            errors: [
              {
                message: "Saildocs response missing binary attachment",
              },
            ],
          },
        });
      }

      // Build restored assembly message with original routing context
      const result = {
        errors: [],
        identityHash: pending.identity_hash,
        replyTo: pending.reply_to,
        channel: pending.channel, // RESTORED: this is the original requester's channel
        intent: "SAILDOCS",
        payload: attachment,
      };

      // Clean up the pending entry
      this.db.deletePendingSaildocs(pending.query_id);

      // Must specify port: SaildocsMatcher has three non-error out ports
      // (direct, out, missed). sendDone(result) without a port map throws
      // "Port must be specified for sending output".
      return output.sendDone({
        direct: result,
        out: result,
      });
    } catch (err) {
      // On processing error, send to MISSED
      email.errors = email.errors || [];
      email.errors.push({
        message: `Saildocs matching error: ${err.message}`,
      });
      return output.sendDone({ missed: email });
    }
  }

  shutdown() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

exports.getComponent = () => new SaildocsMatcher();
