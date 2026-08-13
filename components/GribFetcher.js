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

      // InReach appends "View the location or send a reply..." boilerplate
      // after the user's text. Use only the first non-empty line for BOTH
      // the "send <email>:<query>" shorthand and the bare query; otherwise
      // the boilerplate leaks into the Saildocs email body and Saildocs
      // replies with "There was an error in the following command line:
      // View the location...".
      const firstLine =
        payload.split(/\r?\n/).find((l) => l.trim() !== "") || "";

      // Shorthand grammar: "send <email>:<query>" (explicit Saildocs address)
      if (firstLine.startsWith("send ")) {
        return this.handleSaildocsRequest(msg, firstLine, output);
      }

      // Bare Saildocs query: model:area|grid|hours|params
      // This is what the web UI's preset selector generates and what a user
      // sends from their InReach device.
      if (this.isSaildocsQuery(firstLine)) {
        return this.handleBareQuery(msg, firstLine, output);
      }

      // Try to fetch from local API
      return this.handleLocalFetch(msg, payload, output);
    } catch (err) {
      fail(msg, new Error(`GRIB fetch failed: ${err.message}`));
      return output.done();
    }
  }

  /**
   * Check whether a line looks like a bare Saildocs weather query.
   *
   * Format: model:area|grid|hours|params
   *   model  — letters (gfs, ecmwf, icon, ...)
   *   area   — 4 comma-separated lat/lon values with n/s/e/w suffixes
   *   grid   — 2 comma-separated numbers
   *   hours  — comma-separated numbers
   *   params — comma-separated words (wind, press, ...)
   *
   * Must have at least 3 pipe-delimited sections and a lat/lon token.
   *
   * Note: Does NOT match "local:" prefixed queries, which are reserved for
   * future local API handling (e.g., "local:ecmwf:...").
   */
  isSaildocsQuery(line) {
    // "local:" prefix is reserved for future local API handling
    if (/^local:/i.test(line)) return false;
    if (!/^[a-z]+:/i.test(line)) return false;
    const pipes = (line.match(/\|/g) || []).length;
    if (pipes < 3) return false;
    if (!/[0-9][nsew]/i.test(line)) return false;
    return true;
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
    return this.sendSaildocsRequest(msg, query, email, output);
  }

  /**
   * Handle a bare Saildocs query (no "send" prefix, no explicit email).
   * Defaults to query@saildocs.com.
   */
  handleBareQuery(msg, query, output) {
    return this.sendSaildocsRequest(msg, query, "query@saildocs.com", output);
  }

  /**
   * Shared Saildocs request builder: save the pending mapping, build the
   * outbound email, and emit on OUTBOX.
   */
  sendSaildocsRequest(msg, query, email, output) {
    // Generate unique query ID
    const queryId = crypto.randomBytes(8).toString("hex");

    // Save pending request to database with channel. Store the exact query
    // text: Saildocs discards our outbound subject and echoes the query's
    // model:area as the reply subject, so the inbound reply is correlated
    // against this stored text, NOT against the queryId in the subject.
    this.db.savePendingSaildocs(
      queryId,
      msg.identityHash,
      msg.replyTo,
      msg.channel, // PERSIST: for eventual reply routing
      query, // STORE: for reply correlation (see SaildocsMatcher)
    );

    // Saildocs silently ignores emails whose body isn't terminated by a line
    // of five or more dashes (an anti-spam measure; see cloud.md §4). Append
    // the terminator on every outbound request, not just translated ones.
    const terminatedBody = `${query}\n-----`;

    // Build outbound email message. `replyTo` carries the Saildocs address so
    // SmtpResponder (which reads msg.replyTo) addresses the request there;
    // this is a new outbound request, not a reply to the original sender.
    //
    // The "Your query: <queryId>" subject is now vestigial for correlation —
    // Saildocs replaces it with the query string — but kept so the legacy
    // subject-match path in SaildocsMatcher still works for any in-flight
    // rows from before the query_text correlation shipped.
    const outboundMsg = {
      to: email,
      replyTo: email,
      subject: `Your query: ${queryId}`,
      body: terminatedBody,
      text: terminatedBody,
      // Mark as Saildocs outbound (not a reply to sender)
      isOutboundRequest: true,
      // Carry the original email's imapUid so that ImapAcker (wired after
      // SmtpResponder in the graph) can mark the incoming InReach/Winalert
      // request email as \Seen once the Saildocs request has been sent.
      // Without this the request email stays unseen and is re-fetched on
      // every poll, sending duplicate Saildocs requests.
      imapUid: msg.imapUid,
    };

    return output.sendDone({ outbox: outboundMsg });
  }

  handleLocalFetch(msg, _payload, output) {
    // TODO: Implement actual local GRIB API call
    //
    // Expected format: "local:<model>:area|grid|hours|params"
    // e.g., "local:ecmwf:19N,35N,123W,102W|0.25,0.25|0,3..72|PRMSL,WIND"
    //
    // For now, all local requests fail with a clear error message directing
    // users to use Saildocs queries instead.

    fail(
      msg,
      new Error(
        "Local GRIB API not yet implemented - use Saildocs (bare queries default to query@saildocs.com)",
      ),
    );
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
