const { Component, failed } = require("noflo-assembly");
const DatabaseHelper = require("../lib/DbHelper");
const { extractGribFromMime } = require("../lib/GribMime");

/**
 * SaildocsMatcher - Receives inbound Saildocs emails and matches to pending requests
 *
 * Logic:
 * - Receives inbound Saildocs emails
 * - Extracts the binary GRIB attachment (if any)
 * - Restores original user's identityHash, replyTo, and channel from SQLite based on subject line
 * - GRIB responses go on `direct` (→ GribChunker → delivery path)
 * - Error responses (no attachment) go on `out` as NOTIFY text (→ delivery
 *   path), so the user is told what went wrong instead of being silently
 *   dropped
 * - Both carry imapUid so the email is acked only after successful delivery
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

    // Check for failed messages. SaildocsMatcher has three non-error out
    // ports (direct, out, missed), so a bare sendDone would throw
    // "Port must be specified for sending output". Route failed messages
    // to `missed` (NOT `out`): a failed message was not successfully
    // processed, so acking it (via `out` → ImapAcker) would silently drop
    // it. For a driving-blind user it is safer to leave it unseen and retry
    // than to lose it.
    if (failed(email)) {
      return output.sendDone({ missed: email });
    }

    try {
      // Correlate the inbound reply to a pending request.
      //
      // Saildocs generates the reply subject from the query itself (e.g.
      // "gfs:58n,60n,018e,022e") — it does NOT preserve our "Your query:
      // <queryId>" subject, so the old queryId-in-subject match usually
      // fails. We now store the exact submitted query at request time and
      // match the incoming subject against its model:area prefix (primary).
      // This survives concurrent requests with different areas (including
      // the Buddy Boat / Dacar-grant case) and out-of-order replies.
      const subject = email.subject || email.payload?.subject || "";

      let pending = this.db.getPendingSaildocsBySubject(subject);

      if (!pending) {
        // Legacy path: an outbound request whose subject still carried
        // "Your query: <id>" (older code / pre-migration rows). Harmless on
        // new rows, which never carry it.
        const match = subject.match(/Your query:\s*(\S+)/i);
        if (match) {
          const queryId = match[1];
          pending = this.db.getPendingSaildocs(queryId);
        }
      }

      if (!pending) {
        // Last resort: most recent pending request. Retained for rows with
        // no query_text (pre-migration) and as a safety net — NOT as the
        // primary mechanism, since it crosses concurrent requests.
        pending = this.db.getMostRecentPendingSaildocs();
      }

      if (!pending) {
        // No matching pending query - might be expired or unknown
        return output.sendDone({ missed: email });
      }

      // Extract the binary GRIB attachment. AuthVerifier carries the raw
      // RFC 5322 message source through on `msg.raw` so we can parse the
      // base64-encoded MIME attachment that isn't present in the decoded
      // body text. Fall back to a pre-extracted `attachment` field for
      // backward compatibility with the unit tests.
      let attachment = null;
      if (email.raw) {
        const grib = extractGribFromMime(email.raw);
        if (grib) {
          attachment = grib.data;
        }
      }
      if (!attachment) {
        attachment = email.payload?.attachment || email.attachment;
      }

      // imapUid is carried on every result so ImapAcker (wired downstream
      // of InReachSender) can mark the Saildocs response email as \Seen
      // *after* the content has been delivered to the user. We ack on
      // successful delivery, not at extraction — for a driving-blind user
      // it is safer to re-fetch and retry than to ack early and silently
      // lose the data if delivery fails.
      const baseResult = {
        errors: [],
        identityHash: pending.identity_hash,
        replyTo: pending.reply_to,
        channel: pending.channel, // RESTORED: original requester's channel
        imapUid: email.imapUid || null,
      };

      // Clean up the pending entry — the request has been answered.
      this.db.deletePendingSaildocs(pending.query_id);

      if (attachment) {
        // GRIB response: route via `direct` only (→ GribChunker → Gate →
        // ReplyDispatcher → InReachSender). Sending on `out` too would
        // double-deliver the raw GRIB buffer alongside the chunked version.
        const result = {
          ...baseResult,
          intent: "SAILDOCS",
          payload: attachment,
        };
        return output.sendDone({ direct: result });
      }

      // No GRIB attachment — Saildocs replied with an error (e.g. "HTTP
      // Protocol Exception: 405", "There was an error in the following
      // command line: ..."). Forward the error text to the user via `out`
      // (→ ReplyDispatcher → InReachSender), bypassing GribChunker (which
      // is for binary GRIB only). The user is driving blind — an error
      // message is far better than a silent drop, and this also prevents
      // the response email from looping unseen forever on `missed`.
      const errorText = String(email.payload || email.body || "").trim();
      const truncated = errorText.substring(0, 150);
      const errorResult = {
        ...baseResult,
        intent: "NOTIFY",
        partType: "text",
        payload: `Saildocs error: ${truncated}`,
      };
      return output.sendDone({ out: errorResult });
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
