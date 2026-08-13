const Database = require("node:sqlite").DatabaseSync;
const fs = require("node:fs");
const path = require("node:path");

class DatabaseHelper {
  constructor(dbPath = ":memory:") {
    this.db = null;
    this.dbPath = dbPath;
  }

  initialize(schemaPath = null) {
    this.db = new Database(this.dbPath);

    // Load and execute schema
    const schema =
      schemaPath || path.join(__dirname, "..", "cloud", "schema.sql");
    if (fs.existsSync(schema)) {
      const schemaSql = fs.readFileSync(schema, "utf-8");
      this.db.exec(schemaSql);
    }

    // CREATE TABLE IF NOT EXISTS won't add columns to an already-deployed
    // table, so apply in-place ALTER migrations for anything added after the
    // original schema. Each is guarded so a fresh DB is a no-op.
    this.migrate();

    return this;
  }

  /**
   * Add columns introduced after the initial schema.sql. Each addition is
   * idempotent (guarded by PRAGMA table_info) so it is safe on both fresh
   * and existing databases.
   */
  migrate() {
    const pendingCols = this.all("PRAGMA table_info(pending_saildocs)");
    if (
      pendingCols.length &&
      !pendingCols.some((c) => c.name === "query_text")
    ) {
      this.db.exec("ALTER TABLE pending_saildocs ADD COLUMN query_text TEXT");
    }

    const bufferCols = this.all("PRAGMA table_info(buffer_chunks)");
    if (bufferCols.length && !bufferCols.some((c) => c.name === "imap_uid")) {
      this.db.exec("ALTER TABLE buffer_chunks ADD COLUMN imap_uid TEXT");
    }
  }

  close() {
    if (!this.db) {
      return;
    }
    this.db.close();
    this.db = null;
  }

  // Generic query runner
  run(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.run(...params);
  }

  get(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.get(...params);
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  // High-level helpers
  saveBufferChunk(
    identityHash,
    transmissionId,
    partType,
    chunkIndex,
    totalChunks,
    replyTo,
    channel,
    payload,
    imapUid = null,
  ) {
    const sql = `
      INSERT OR REPLACE INTO buffer_chunks
      (identity_hash, transmission_id, part_type, chunk_index, total_chunks, reply_to, channel, payload, imap_uid, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    return this.run(sql, [
      identityHash,
      transmissionId,
      partType,
      chunkIndex,
      totalChunks,
      replyTo,
      channel,
      payload,
      imapUid,
      Math.floor(Date.now() / 1000),
    ]);
  }

  getBufferChunks(identityHash, transmissionId, partType) {
    const sql = `
      SELECT * FROM buffer_chunks
      WHERE identity_hash = ? AND transmission_id = ? AND part_type = ?
      ORDER BY chunk_index
    `;
    return this.all(sql, [identityHash, transmissionId, partType]);
  }

  /**
   * Get all imap_uids for a transmission (across all part types).
   * Used to ACK all emails that contributed to a complete message.
   */
  getBufferChunkUids(identityHash, transmissionId) {
    const sql = `
      SELECT imap_uid FROM buffer_chunks
      WHERE identity_hash = ? AND transmission_id = ? AND imap_uid IS NOT NULL
    `;
    return this.all(sql, [identityHash, transmissionId]).map(
      (row) => row.imap_uid,
    );
  }

  /**
   * Whether any buffered chunk exists for a transmission id (across all
   * part types). Used by MessageReassembler to decide whether a
   * "CANCEL <id>" command refers to a sequence we're holding (→ cancel it
   * locally) or should pass through to the gate/status command path.
   */
  hasBufferChunks(identityHash, transmissionId) {
    const sql =
      "SELECT 1 FROM buffer_chunks WHERE identity_hash = ? AND transmission_id = ? LIMIT 1";
    return !!this.get(sql, [identityHash, transmissionId]);
  }

  deleteBufferChunks(identityHash, transmissionId, partType = null) {
    let sql =
      "DELETE FROM buffer_chunks WHERE identity_hash = ? AND transmission_id = ?";
    const params = [identityHash, transmissionId];
    if (partType) {
      sql += " AND part_type = ?";
      params.push(partType);
    }
    return this.run(sql, params);
  }

  getStaleBufferChunks(ttlSeconds) {
    const cutoff = Math.floor(Date.now() / 1000) - ttlSeconds;
    const sql = `
      SELECT identity_hash, transmission_id, part_type, reply_to, channel,
             COUNT(*) as received, MAX(total_chunks) as total
      FROM buffer_chunks
      WHERE created_at < ?
      GROUP BY identity_hash, transmission_id, part_type
    `;
    return this.all(sql, [cutoff]);
  }

  saveGribGate(identityHash, gateId, replyTo, channel, chunkPayloads) {
    const sql = `
      INSERT INTO grib_gates
      (identity_hash, gate_id, reply_to, channel, chunk_payloads, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    return this.run(sql, [
      identityHash,
      gateId,
      replyTo,
      channel,
      JSON.stringify(chunkPayloads),
      Math.floor(Date.now() / 1000),
    ]);
  }

  /**
   * Count all pending (incomplete) multi-part sequences. A row in
   * buffer_chunks represents an incomplete sequence (complete ones are
   * deleted by MessageReassembler.emitComplete), so counting distinct
   * (identity_hash, transmission_id) pairs is the count of pending sequences.
   */
  countPendingSequences() {
    const sql =
      "SELECT COUNT(*) AS n FROM (SELECT DISTINCT identity_hash, transmission_id FROM buffer_chunks)";
    return this.get(sql);
  }

  getGribGate(identityHash, gateId) {
    const sql =
      "SELECT * FROM grib_gates WHERE identity_hash = ? AND gate_id = ?";
    const row = this.get(sql, [identityHash, gateId]);
    if (row) {
      row.chunk_payloads = JSON.parse(row.chunk_payloads);
    }
    return row;
  }

  deleteGribGate(identityHash, gateId) {
    const sql =
      "DELETE FROM grib_gates WHERE identity_hash = ? AND gate_id = ?";
    return this.run(sql, [identityHash, gateId]);
  }

  /**
   * Count all pending (unanswered) GRIB gates. Used by StatusBuilder for the
   * STATUS command. Excludes none by TTL here — pruning is the gate's own
   * concern; STATUS reports what's currently held, including stale ones
   * (a stale gate is itself a signal worth surfacing).
   */
  countGribGates() {
    const sql = "SELECT COUNT(*) AS n FROM grib_gates";
    return this.get(sql).n;
  }

  /**
   * Record a pending Saildocs request.
   *
   * `queryText` is the exact query string submitted to Saildocs (e.g.
   * "gfs:58n,60n,018e,022e|2,2|0,12|wind"). Saildocs discards our custom
   * outbound subject and instead echoes the query's model:area as the reply
   * subject, so inbound replies are correlated against this stored text —
   * NOT against an injected query_id in the subject. Optional (defaults to
   * null) for backward compatibility with callers/tests that predate the
   * column; rows with NULL query_text fall back to the most-recent matcher.
   */
  savePendingSaildocs(
    queryId,
    identityHash,
    replyTo,
    channel,
    queryText = null,
  ) {
    const sql = `
      INSERT INTO pending_saildocs
      (query_id, identity_hash, reply_to, channel, query_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    return this.run(sql, [
      queryId,
      identityHash,
      replyTo,
      channel,
      queryText,
      Math.floor(Date.now() / 1000),
    ]);
  }

  getPendingSaildocs(queryId) {
    const sql = "SELECT * FROM pending_saildocs WHERE query_id = ?";
    return this.get(sql, [queryId]);
  }

  /**
   * Find the most recent pending Saildocs request whose stored query text
   * matches an inbound reply subject.
   *
   * Saildocs generates the reply subject from the query itself (e.g.
   * "gfs:58n,60n,018e,022e") rather than preserving our "Your query:
   * <queryId>" subject. We store the exact submitted query at request time
   * and match the incoming subject against the query's model:area prefix
   * (everything before the first "|"). This keeps two concurrent requests
   * with different areas from being crossed — including the Buddy Boat
   * (Dacar-grant) case where a second identity has a request in flight —
   * which the old "most recent pending" fallback could not.
   *
   * Returns the most recent matching row, or null. Most-recent-within-match
   * is the right tiebreak for a retry (same area re-sent): the newest
   * request is the one the user is waiting on; an older sibling is left as
   * a stale row surfaced by STATUS rather than misdelivered to.
   */
  getPendingSaildocsBySubject(subject) {
    const subj = String(subject || "")
      .trim()
      .toLowerCase();
    if (!subj) {
      return null;
    }
    const rows = this.all(
      "SELECT * FROM pending_saildocs ORDER BY created_at DESC",
    );
    for (const row of rows) {
      if (!row.query_text) {
        continue;
      }
      const queryText = String(row.query_text).trim().toLowerCase();
      // model:area is everything before the first "|" — the portion Saildocs
      // echoes in the reply subject.
      const areaPrefix = queryText.split("|")[0];
      if (subj === areaPrefix) {
        return row;
      }
    }
    return null;
  }

  /**
   * Last-resort fallback: the most recent pending Saildocs request.
   *
   * Primary correlation is now getPendingSaildocsBySubject() (matched on the
   * stored query text). This is retained for rows with no query_text
   * (pre-migration) and as a safety net — NOT as the primary mechanism, since
   * it assumes only one request is in flight and crosses concurrent requests.
   */
  getMostRecentPendingSaildocs() {
    const sql =
      "SELECT * FROM pending_saildocs ORDER BY created_at DESC LIMIT 1";
    return this.get(sql);
  }

  deletePendingSaildocs(queryId) {
    const sql = "DELETE FROM pending_saildocs WHERE query_id = ?";
    return this.run(sql, [queryId]);
  }

  /**
   * Count all pending (unanswered) Saildocs queries. Used by StatusBuilder.
   * A pending query older than a generous TTL is still counted — it's a
   * stuck request worth surfacing in STATUS, not silently hidden.
   */
  countPendingSaildocs() {
    const sql = "SELECT COUNT(*) AS n FROM pending_saildocs";
    return this.get(sql).n;
  }

  incrementMetric(type) {
    const validTypes = ["blog_posts", "msg_in", "msg_out"];
    if (!validTypes.includes(type)) {
      throw new Error(`Invalid metric type: ${type}`);
    }
    const sql = `UPDATE metrics SET ${type} = ${type} + 1, updated_at = ? WHERE id = 1`;
    return this.run(sql, [Math.floor(Date.now() / 1000)]);
  }

  getMetrics() {
    const sql = "SELECT * FROM metrics WHERE id = 1";
    return this.get(sql);
  }

  // Dacar authorization no longer flows through SQLite: DacarAuthorizer now
  // evaluates via the `dacar` CLI file store (see components/DacarAuthorizer.js).
  // The dacar_tuples / dacar_tombstones tables and their helpers were the
  // hand-rolled predecessor and have been removed. Operator grant/sync happens
  // out-of-band with `dacar init` / `dacar grant` / `dacar sync`.

  // InReach device mapping
  saveInReachDevice(bounceToken, imei, identityHash, ownerName) {
    const now = Math.floor(Date.now() / 1000);
    const sql = `
      INSERT OR REPLACE INTO inreach_devices
      (bounce_token, imei, identity_hash, owner_name, registered_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    return this.run(sql, [
      bounceToken,
      imei,
      identityHash,
      ownerName,
      now,
      now,
    ]);
  }

  getInReachDevice(bounceToken) {
    const sql = "SELECT * FROM inreach_devices WHERE bounce_token = ?";
    return this.get(sql, [bounceToken]);
  }

  updateLastSeen(bounceToken) {
    const now = Math.floor(Date.now() / 1000);
    const sql = `
      UPDATE inreach_devices 
      SET last_seen = ? 
      WHERE bounce_token = ?
    `;
    return this.run(sql, [now, bounceToken]);
  }
}

module.exports = DatabaseHelper;
