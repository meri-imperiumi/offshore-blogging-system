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
        out: {
          datatype: "object",
          description: "Assembly message with restored routing context",
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
      // Extract query ID from subject line
      // Saildocs responses typically have subject like: "Your query: <query_id>"
      const subject = email.subject || email.payload?.subject || "";
      const match = subject.match(/Your query:\s*(\S+)/i);

      if (!match) {
        // Not a Saildocs response - pass through to MISSED
        return output.send({ missed: email });
      }

      const queryId = match[1];

      // Look up pending query in database
      const pending = this.db.getPendingSaildocs(queryId);

      if (!pending) {
        // No matching pending query - might be expired or unknown
        return output.send({ missed: email });
      }

      // Extract binary attachment from email
      const attachment = email.payload?.attachment || email.attachment;
      if (!attachment) {
        // Saildocs response without attachment - treat as error
        return output.send({
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
      this.db.deletePendingSaildocs(queryId);

      return output.sendDone(result);
    } catch (err) {
      // On processing error, send to MISSED
      email.errors = email.errors || [];
      email.errors.push({
        message: `Saildocs matching error: ${err.message}`,
      });
      return output.send({ missed: email });
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
