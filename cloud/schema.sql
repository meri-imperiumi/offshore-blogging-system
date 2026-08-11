-- SQLite schema for cloud server state persistence
-- All timestamp columns are stored as UNIX epoch (INTEGER)

-- Buffer chunks for reassembling multi-part messages
CREATE TABLE IF NOT EXISTS buffer_chunks (
  identity_hash TEXT NOT NULL,
  transmission_id TEXT NOT NULL,
  part_type TEXT NOT NULL,       -- 'text' | 'image' | 'grib' etc.
  chunk_index INTEGER NOT NULL,
  total_chunks INTEGER NOT NULL,
  reply_to TEXT NOT NULL,
  channel TEXT NOT NULL,         -- 'inreach' | 'winlink'
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,

  PRIMARY KEY (identity_hash, transmission_id, part_type, chunk_index)
);

-- GRIB gatekeeper - holds large payloads pending user consent
CREATE TABLE IF NOT EXISTS grib_gates (
  identity_hash TEXT NOT NULL,
  gate_id TEXT NOT NULL,
  reply_to TEXT NOT NULL,
  channel TEXT NOT NULL,
  chunk_payloads TEXT NOT NULL,   -- JSON array of encoded strings
  created_at INTEGER NOT NULL,

  PRIMARY KEY (identity_hash, gate_id)
);

-- Pending Saildocs queries - bridges outbound request to inbound response
CREATE TABLE IF NOT EXISTS pending_saildocs (
  query_id TEXT PRIMARY KEY,
  identity_hash TEXT NOT NULL,
  reply_to TEXT NOT NULL,
  channel TEXT NOT NULL,
  -- The exact submitted query string. Saildocs discards our custom outbound
  -- subject and echoes the query's model:area as the reply subject, so we
  -- correlate replies against this (see DbHelper.getPendingSaildocsBySubject).
  -- Nullable for backward compatibility; NULL rows fall back to most-recent.
  query_text TEXT,
  created_at INTEGER NOT NULL
);

-- Metrics for telemetry
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  blog_posts INTEGER DEFAULT 0,
  msg_in INTEGER DEFAULT 0,
  msg_out INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Initialize metrics row
INSERT OR IGNORE INTO metrics (id, blog_posts, msg_in, msg_out, updated_at)
VALUES (1, 0, 0, 0, strftime('%s', 'now'));

-- Dacar authorization tuples live in the `dacar` CLI file store
-- ($DACAR_HOME, default ~/.dacar), NOT in this SQLite file. An operator
-- bootstraps/syncs them out-of-band with `dacar init` / `dacar grant` /
-- `dacar sync`; DacarAuthorizer reads the same store. See
-- components/DacarAuthorizer.js and cloud.md §7.

-- InReach device mapping for authorization
CREATE TABLE IF NOT EXISTS inreach_devices (
  bounce_token TEXT PRIMARY KEY,
  imei TEXT NOT NULL UNIQUE,
  identity_hash TEXT NOT NULL,
  owner_name TEXT,
  registered_at INTEGER NOT NULL,
  last_seen INTEGER
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_buffer_chunks_created ON buffer_chunks(created_at);
CREATE INDEX IF NOT EXISTS idx_buffer_chunks_transmission ON buffer_chunks(identity_hash, transmission_id);
CREATE INDEX IF NOT EXISTS idx_grib_gates_created ON grib_gates(created_at);
CREATE INDEX IF NOT EXISTS idx_pending_saildocs_created ON pending_saildocs(created_at);
CREATE INDEX IF NOT EXISTS idx_inreach_devices_identity ON inreach_devices(identity_hash);