/**
 * GribStore - Server-side GRIB assembly & persistence for the Signal K plugin.
 *
 * The boat receives GRIB files as a sequence of InReach message chunks using
 * the Unified Compact Chunk Header Protocol (work doc #12):
 *
 *   [ID:4][Type:1][Index:2][Total:2][Meta?:4]:[Payload]
 *
 * Type `G` chunks carry base64-encoded slices of a binary GRIB file. This
 * module parses those chunks, reassembles the binary, verifies the `GRIB`
 * magic, and persists the result so any Signal K user on the boat can
 * download it later — not only the person who pasted the chunks.
 *
 * Persisted GRIBs are listed latest-first.
 *
 * Storage layout (under the plugin's data directory):
 *   <dir>/manifest.json     — [{ id, transmissionId, filename, size, ... }]
 *   <dir>/<transmissionId>.grb — the binary GRIB file
 *
 * No third-party dependencies: Node built-ins only.
 */

const fs = require("node:fs").promises;
const path = require("node:path");

// Matches the unified compact header (same regex as MessageReassembler).
// The optional Meta group handles both uplink (T/I with CRC) and downlink
// (G/S, no meta) formats. The `s` flag lets `.` match newlines in payload.
const COMPACT_HEADER_RE =
  /^([a-zA-Z0-9]{4})([A-Za-z])(\d{2})(\d{2})([0-9a-fA-F]{4})?:(.*)$/s;

// Transmission IDs are 4 Base62 chars — URL-safe and traversal-safe, but we
// still validate the shape on lookup to reject anything unexpected.
const ID_RE = /^[a-zA-Z0-9]{4}$/;

/**
 * Parse a single compact-header chunk string.
 *
 * @param {string} raw - The raw chunk as received (header + payload).
 * @returns {{transmissionId:string,typeChar:string,index:number,total:number,meta:string|undefined,data:string}|null}
 */
function parseCompactChunk(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.match(COMPACT_HEADER_RE);
  if (!m) return null;
  return {
    transmissionId: m[1],
    typeChar: m[2].toUpperCase(),
    index: parseInt(m[3], 10),
    total: parseInt(m[4], 10),
    meta: m[5], // undefined for downlink GRIB/sys
    data: m[6],
  };
}

class GribStore {
  /**
   * @param {string} dir - Absolute path to the directory used for storage.
   */
  constructor(dir) {
    this.dir = dir;
    this.manifestPath = path.join(dir, "manifest.json");
  }

  async ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async readManifest() {
    try {
      const data = await fs.readFile(this.manifestPath, "utf-8");
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      // Missing or corrupt manifest — treat as empty.
      return [];
    }
  }

  async writeManifest(entries) {
    await this.ensureDir();
    await fs.writeFile(this.manifestPath, JSON.stringify(entries, null, 2));
  }

  /**
   * Reassemble raw compact chunks into the binary GRIB, validating type,
   * completeness, and the `GRIB` magic. Does NOT persist.
   *
   * @param {string[]} rawChunks
   * @returns {Promise<{binary:Buffer,magic:string,transmissionId:string,total:number}>}
   * @throws {Error} with `.code` of `MISSING_CHUNKS`, `BAD_MAGIC`, or
   *   `BAD_FORMAT` / `NOT_GRIB` for other validation failures.
   */
  async assemble(rawChunks) {
    if (!Array.isArray(rawChunks) || rawChunks.length === 0) {
      const err = new Error("No chunks provided");
      err.code = "BAD_FORMAT";
      throw err;
    }

    const parsed = [];
    for (const raw of rawChunks) {
      const p = parseCompactChunk(raw);
      if (!p) {
        const err = new Error(
          `Unrecognized chunk format: ${String(raw).slice(0, 40)}`,
        );
        err.code = "BAD_FORMAT";
        throw err;
      }
      if (p.typeChar !== "G") {
        const err = new Error(
          `Not a GRIB chunk (type '${p.typeChar}'); GribStore only handles type 'G'`,
        );
        err.code = "NOT_GRIB";
        throw err;
      }
      parsed.push(p);
    }

    // All chunks must agree on transmissionId and total.
    const transmissionId = parsed[0].transmissionId;
    const total = parsed[0].total;
    for (const p of parsed) {
      if (p.transmissionId !== transmissionId || p.total !== total) {
        const err = new Error(
          "Chunks disagree on transmissionId or total count — mixed sequences?",
        );
        err.code = "BAD_FORMAT";
        throw err;
      }
    }

    // Check completeness (1-based indices).
    const byIndex = new Map();
    for (const p of parsed) {
      byIndex.set(p.index, p);
    }
    const missing = [];
    for (let i = 1; i <= total; i++) {
      if (!byIndex.has(i)) missing.push(i);
    }
    if (missing.length > 0) {
      const err = new Error(
        `Missing chunks: ${missing.join(", ")} of ${total}`,
      );
      err.code = "MISSING_CHUNKS";
      err.missing = missing;
      err.total = total;
      throw err;
    }

    // Concatenate base64 payloads in order and decode.
    let base64 = "";
    for (let i = 1; i <= total; i++) {
      base64 += byIndex.get(i).data;
    }
    base64 = base64.replace(/\s+/g, "");
    const binary = Buffer.from(base64, "base64");

    const magic = binary.subarray(0, 4).toString("ascii");
    if (magic !== "GRIB") {
      const err = new Error(
        `Invalid GRIB magic: expected 'GRIB', got '${magic}'`,
      );
      err.code = "BAD_MAGIC";
      err.magic = magic;
      throw err;
    }

    return { binary, magic, transmissionId, total };
  }

  /**
   * Assemble, validate, and persist a GRIB to disk + manifest.
   *
   * Re-assembling the same transmissionId overwrites the file and keeps the
   * original `createdAt` (so the list stays ordered by first receipt) while
   * bumping `updatedAt`.
   *
   * @param {string[]} rawChunks
   * @param {string} [requestedBy] - Optional identity hash / user label.
   * @returns {Promise<object>} The manifest entry.
   */
  async persist(rawChunks, requestedBy) {
    const { binary, transmissionId, total } = await this.assemble(rawChunks);

    await this.ensureDir();
    const filename = `${transmissionId}.grb`;
    const filepath = path.join(this.dir, filename);
    await fs.writeFile(filepath, binary);

    const entries = await this.readManifest();
    const existingIdx = entries.findIndex(
      (e) => e.transmissionId === transmissionId,
    );
    const now = Date.now();
    const existing = existingIdx >= 0 ? entries[existingIdx] : null;

    const entry = {
      id: transmissionId,
      transmissionId,
      filename,
      size: binary.length,
      totalChunks: total,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      requestedBy: requestedBy || existing?.requestedBy || null,
    };

    if (existingIdx >= 0) {
      entries[existingIdx] = entry;
    } else {
      entries.push(entry);
    }
    await this.writeManifest(entries);
    return entry;
  }

  /**
   * List persisted GRIBs, latest-first (by createdAt descending).
   *
   * @returns {Promise<object[]>}
   */
  async list() {
    const entries = await this.readManifest();
    return entries.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Resolve the on-disk path for a stored GRIB id, with a path-traversal
   * guard. Does not check existence.
   *
   * @param {string} id - transmissionId / manifest entry id.
   * @returns {string} Absolute file path.
   * @throws {Error} if id is not a valid 4-char Base62 id.
   */
  getFilePath(id) {
    if (!ID_RE.test(id)) {
      const err = new Error(`Invalid GRIB id: ${id}`);
      err.code = "BAD_ID";
      throw err;
    }
    return path.join(this.dir, `${id}.grb`);
  }
}

module.exports = { GribStore, parseCompactChunk, COMPACT_HEADER_RE };
