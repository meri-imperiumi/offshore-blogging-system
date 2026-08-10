import assert from "node:assert";
import { describe, it } from "node:test";
import { extractGribFromMime } from "../lib/GribMime.js";

/**
 * Build a minimal multipart MIME message with a GRIB attachment.
 */
function buildGribMime(gribPayload, opts = {}) {
  const boundary = opts.boundary || "----=_boundary";
  const gribB64 = Buffer.from(gribPayload).toString("base64");
  const textPart = opts.textPart || "Here is your GRIB file.";
  return Buffer.from(
    [
      `From: query-reply@saildocs.com`,
      `To: boat@example.com`,
      `Subject: Your query: abc123def456`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain`,
      ``,
      `${textPart}`,
      `--${boundary}`,
      `Content-Type: application/octet-stream`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="grib.grb"`,
      ``,
      `${gribB64}`,
      `--${boundary}--`,
      ``,
    ].join("\r\n"),
    "latin1",
  );
}

describe("GribMime (shared GRIB attachment extraction)", () => {
  it("extracts a base64 GRIB attachment from a multipart MIME", () => {
    const gribPayload = Buffer.concat([
      Buffer.from("GRIB", "ascii"),
      Buffer.from([0x00, 0x00, 0x02, 0x00]),
      Buffer.from("...rest of grib data..."),
    ]);
    const raw = buildGribMime(gribPayload);

    const result = extractGribFromMime(raw);
    assert.ok(result, "should find the GRIB attachment");
    assert.strictEqual(
      result.data.subarray(0, 4).toString("ascii"),
      "GRIB",
      "decoded data should start with GRIB magic bytes",
    );
    assert.ok(
      result.data.length > 4,
      "should include data after the magic bytes",
    );
  });

  it("returns null for a text-only error response (no attachment)", () => {
    const raw = Buffer.from(
      [
        `From: query-reply@saildocs.com`,
        `Subject: Re: your query`,
        `Content-Type: text/plain`,
        ``,
        `Error: invalid area specification`,
      ].join("\r\n"),
      "latin1",
    );
    const result = extractGribFromMime(raw);
    assert.strictEqual(result, null);
  });

  it("handles a non-multipart body that is raw GRIB data", () => {
    const gribPayload = Buffer.concat([
      Buffer.from("GRIB", "ascii"),
      Buffer.from([0x01, 0x02, 0x03, 0x04]),
    ]);
    const raw = Buffer.from(
      `${[
        `From: query-reply@saildocs.com`,
        `Content-Type: application/octet-stream`,
        ``,
      ].join("\r\n")}\r\n`,
      "latin1",
    );
    const fullRaw = Buffer.concat([raw, gribPayload]);
    const result = extractGribFromMime(fullRaw);
    assert.ok(result, "should find GRIB in a non-multipart body");
    assert.strictEqual(result.data.subarray(0, 4).toString("ascii"), "GRIB");
  });

  it("returns null when no base64 part decodes to GRIB", () => {
    const raw = Buffer.from(
      [
        `From: query-reply@saildocs.com`,
        `Content-Type: multipart/mixed; boundary="----=_b"`,
        ``,
        `--=----=_b`,
        `Content-Type: text/plain`,
        `Content-Transfer-Encoding: base64`,
        ``,
        `${Buffer.from("just text, not grib").toString("base64")}`,
        `--=----=_b--`,
      ].join("\r\n"),
      "latin1",
    );
    const result = extractGribFromMime(raw);
    assert.strictEqual(result, null);
  });

  it("returns null for undefined / non-Buffer input", () => {
    assert.strictEqual(extractGribFromMime(undefined), null);
    assert.strictEqual(extractGribFromMime(null), null);
    assert.strictEqual(extractGribFromMime("not a buffer"), null);
  });
});
