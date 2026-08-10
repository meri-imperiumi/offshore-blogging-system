/**
 * GRIB attachment extraction from raw RFC 5322 MIME messages.
 *
 * Saildocs sends the GRIB file as a base64-encoded MIME attachment. This
 * module finds the attachment, decodes it, and checks for the "GRIB" magic
 * bytes (0x47 0x52 0x49 0x42) at the start of the decoded data.
 *
 * Shared between scripts/saildocs-runner.js (the live E2E runner) and
 * components/SaildocsMatcher.js (the production graph path) so the two
 * can't drift apart.
 */

/**
 * Extract a GRIB attachment from a raw MIME message buffer.
 *
 * Handles both multipart messages (finds the base64 part whose decoded
 * content starts with "GRIB") and non-multipart bodies that are raw GRIB
 * data.
 *
 * @param {Buffer} raw - Full RFC 5322 message source
 * @returns {{ data: Buffer } | null} The decoded GRIB buffer, or null if
 *   no GRIB attachment was found.
 */
function extractGribFromMime(raw) {
  if (!raw || !Buffer.isBuffer(raw)) return null;
  const rawStr = raw.toString("latin1");

  // Find MIME boundary (multipart/mixed or multipart/related)
  const boundaryMatch = rawStr.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i);
  if (!boundaryMatch) {
    // Not multipart — check if the single body is GRIB data.
    const headerEnd = rawStr.indexOf("\r\n\r\n");
    if (headerEnd < 0) return null;
    const body = raw.subarray(headerEnd + 4);
    if (body.subarray(0, 4).toString("ascii") === "GRIB") {
      return { data: body };
    }
    return null;
  }

  const boundary = boundaryMatch[1];
  const parts = rawStr.split(`--${boundary}`);
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "" || trimmed === "--") continue;

    const encodingMatch = part.match(/Content-Transfer-Encoding:\s*base64/i);
    if (!encodingMatch) continue;

    const partHeaderEnd = part.indexOf("\r\n\r\n");
    if (partHeaderEnd < 0) continue;

    const b64Content = part.slice(partHeaderEnd + 4).replace(/[\r\n\s]/g, "");

    try {
      const decoded = Buffer.from(b64Content, "base64");
      if (decoded.subarray(0, 4).toString("ascii") === "GRIB") {
        return { data: decoded };
      }
    } catch {
      // Not valid base64 — skip this part.
    }
  }
  return null;
}

module.exports = { extractGribFromMime };
