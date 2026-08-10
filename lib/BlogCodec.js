/**
 * BlogCodec - Shared blog post encoding/decoding logic.
 *
 * Used by both the Signal K plugin (encode side: compress → chunk) and the
 * NoFlo cloud pipeline (decode side: reassemble → decompress).
 *
 * This module contains only the pure transmission codec — no filesystem,
 * no image processing, no Signal K lifecycle. Those concerns live in the
 * plugin and components respectively.
 */

const zlib = require("node:zlib");

/**
 * Garmin's confirmed 1-char-safe set (support.garmin.com character-count
 * tables). Every character our chunk format can ever emit — header and
 * base64 payload alike — must be in here.
 */
const GARMIN_SAFE_CHARS = new Set(
  "!\"#$%'()*+,-./:;<=>?@_0123456789" +
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
);

/**
 * Check if a message contains only Garmin-safe characters.
 * Throws if any character would cost double or silently halve the limit.
 */
function checkGarminSafe(msg) {
  const bad = new Set();
  for (const char of msg) {
    if (!GARMIN_SAFE_CHARS.has(char)) {
      bad.add(char);
    }
  }
  if (bad.size > 0) {
    throw new Error(
      `Message contains character(s) ${[...bad].join(", ")} not confirmed safe by ` +
        "Garmin's character-count tables -- this would cost double or " +
        "silently halve the whole message's limit. This is a bug in the encoder.",
    );
  }
}

/** Header format: <postid:4><type:1><idx:2><total:2><crc:4><colon:1> */
const HEADER_LEN = 4 + 1 + 2 + 2 + 4 + 1;

/** Garmin InReach message character limit */
const MSG_LIMIT = 155;

/** Space available for base64 payload after the header */
const DATA_BUDGET = MSG_LIMIT - HEADER_LEN;

/**
 * Default sailing dictionary for deflate preset compression.
 * Shared between encoder and decoder — both sides must use the same
 * dictionary or decompression fails.
 */
const SAIL_DICT = Buffer.from(
  "knots wind speed course heading nautical miles position latitude " +
    "longitude squall reef watch sunrise sunset autopilot sail sails " +
    "mainsail jib genoa spinnaker anchor anchorage landfall passage " +
    "crew galley cockpit engine diesel fuel battery solar generator " +
    "weather forecast grib routing waypoint tack gybe reef swell " +
    "following seas beam reach downwind upwind knots today we we're " +
    "the and to of a in that with for on at is was are it this ",
);

/**
 * CRC-16-CCITT (polynomial 0x1021, init 0xffff).
 * Computed on the raw (pre-base64) compressed data, not per-chunk.
 */
function calculateCRC16(buffer) {
  let crc = 0xffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i] << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc = crc << 1;
      }
    }
  }
  return crc & 0xffff;
}

/**
 * Compress a blog post's text into a single binary blob.
 *
 * The four fields are joined with \x1f (ASCII unit separator) before
 * compression so decompressText can split them back out. The filename is
 * carried so the cloud server writes the post to the exact same path the
 * boat uses (_logs/<filename>.md), letting the hi-fi sync overwrite the
 * lo-fi placeholder cleanly (SPEC.md §Desired blogging flow).
 *
 * @param {string} filename - post filename (without .md), e.g. "2026-08-08"
 * @param {string} title
 * @param {string} date - the post's `created` date value
 * @param {string} body
 * @param {Buffer} [dictionary=SAIL_DICT]
 * @returns {Buffer} compressed blob (to be chunked by chunkData)
 */
function compressText(filename, title, date, body, dictionary = SAIL_DICT) {
  const payload = Buffer.from(
    `${filename}\x1f${title}\x1f${date}\x1f${body}`,
    "utf-8",
  );

  const compressed = zlib.deflateRawSync(payload, {
    level: 9,
    dictionary,
  });

  return compressed;
}

/**
 * Decompress a blog post blob back into { filename, title, date, body }.
 *
 * The body is reconstructed by joining everything after the first three
 * \x1f-separated fields, so a body that itself contains \x1f round-trips
 * intact.
 *
 * The date is the post's `created` value — the front-matter key is
 * hardcoded to "created" on both ends (Obsidian's convention).
 *
 * @param {Buffer} compressed
 * @param {Buffer} [dictionary=SAIL_DICT]
 * @returns {{ filename: string, title: string, date: string, body: string }}
 */
function decompressText(compressed, dictionary = SAIL_DICT) {
  const decompressed = zlib.inflateRawSync(compressed, {
    dictionary,
  });

  const parts = decompressed.toString("utf-8").split("\x1f");
  const filename = parts[0] || "";
  const title = parts[1] || "";
  const date = parts[2] || "";
  const body = parts.slice(3).join("\x1f");

  return { filename, title, date, body };
}

/**
 * Split compressed data into InReach-sized chunks.
 *
 * Each chunk has a 13-char header:
 *   <postid:4><type:1><idx:2><total:2><crc:4>:<base64 payload>
 *
 * The CRC covers the full original data (not per-chunk), so it is
 * identical in every chunk header and verified once after reassembly.
 *
 * @param {Buffer} data - compressed blob from compressText
 * @param {string} postid - 4-char post identifier (e.g. "0716")
 * @param {string} type - single-char part type ("T"=text, "I"=image, ...)
 * @returns {string[]} array of chunk strings ready to send
 */
function chunkData(data, postid, type) {
  const b64 = data.toString("base64");
  const total = Math.ceil(b64.length / DATA_BUDGET);

  if (total > 99) {
    throw new Error(
      `${type} needs ${total} messages, header only allows 99. Compress more.`,
    );
  }

  const crc = calculateCRC16(data);
  const messages = [];

  for (let i = 0; i < total; i++) {
    const piece = b64.slice(i * DATA_BUDGET, (i + 1) * DATA_BUDGET);
    const header = `${postid}${type}${String(i + 1).padStart(2, "0")}${String(total).padStart(2, "0")}${crc.toString(16).padStart(4, "0")}:`;
    const msg = header + piece;
    checkGarminSafe(msg);
    messages.push(msg);
  }

  return messages;
}

/**
 * Reassemble chunk payloads back into the original compressed blob.
 *
 * Each entry should have { idx, total, crc, data } where `data` is the
 * base64 payload (without header).
 *
 * Verifies that all chunks agree on total count and CRC, and that the
 * reassembled data's CRC matches.
 *
 * @param {Object} entries - keyed by chunk index (1-based)
 * @returns {Buffer} compressed blob (to be decompressed by decompressText)
 */
function reassembleChunks(entries) {
  const totals = new Set();
  const crcs = new Set();

  for (const entry of Object.values(entries)) {
    totals.add(entry.total);
    crcs.add(entry.crc);
  }

  if (totals.size !== 1) {
    throw new Error(`conflicting total counts seen: ${[...totals]}`);
  }
  if (crcs.size !== 1) {
    throw new Error(
      `chunks disagree on checksum -- likely a mistyped message: ${[...crcs]}`,
    );
  }

  const total = totals.values().next().value;
  const expectedCrc = parseInt(crcs.values().next().value, 16);

  // Check for missing chunks
  const missing = [];
  for (let i = 1; i <= total; i++) {
    if (!entries[i]) {
      missing.push(i);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `missing chunk(s): ${missing} (have ${Object.keys(entries).sort()}/${total})`,
    );
  }

  // Reassemble base64 data
  const b64 = [];
  for (let i = 1; i <= total; i++) {
    b64.push(entries[i].data);
  }
  const b64String = b64.join("");

  // Decode and verify CRC
  const compressed = Buffer.from(b64String, "base64");
  const gotCrc = calculateCRC16(compressed);

  if (gotCrc !== expectedCrc) {
    throw new Error(
      `CRC mismatch: expected ${expectedCrc.toString(16).padStart(4, "0")} ` +
        `got ${gotCrc.toString(16).padStart(4, "0")} -- a chunk was corrupted or mistyped`,
    );
  }

  return compressed;
}

module.exports = {
  // Constants
  GARMIN_SAFE_CHARS,
  HEADER_LEN,
  MSG_LIMIT,
  DATA_BUDGET,
  SAIL_DICT,
  // Validation
  checkGarminSafe,
  // CRC
  calculateCRC16,
  // Compression
  compressText,
  decompressText,
  // Chunking
  chunkData,
  reassembleChunks,
};
