const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  PRESETS,
  formatLat,
  formatLon,
  buildArea,
  buildRequest,
} = require("../public/saildocs-area.js");

describe("SaildocsArea", () => {
  describe("formatLat", () => {
    it("formats a positive latitude with 'n' suffix", () => {
      assert.strictEqual(formatLat(59.3), "59n");
    });

    it("formats a negative latitude with 's' suffix", () => {
      assert.strictEqual(formatLat(-33.7), "34s");
    });

    it("formats zero latitude as '0n'", () => {
      assert.strictEqual(formatLat(0), "0n");
    });
  });

  describe("formatLon", () => {
    it("formats a positive longitude with 'e' suffix", () => {
      assert.strictEqual(formatLon(21.4), "21e");
    });

    it("formats a negative longitude with 'w' suffix", () => {
      assert.strictEqual(formatLon(-72.5), "73w");
    });

    it("formats zero longitude as '0e'", () => {
      assert.strictEqual(formatLon(0), "0e");
    });
  });

  describe("buildArea", () => {
    it("builds a correct area string centered on a Northern/Eastern position", () => {
      // Center at 29N, 21E, half-size ±5 lat, ±6 lon
      // → south=24n, north=34n, west=15e, east=27e
      const area = buildArea(29, 21, 5, 6);
      assert.strictEqual(area, "24n,34n,15e,27e");
    });

    it("builds a correct area string for a Southern/Western position", () => {
      // Center at -20S, -150W, half-size ±3 lat, ±4 lon
      // → south=23s, north=17s, west=154w, east=146w
      const area = buildArea(-20, -150, 3, 4);
      assert.strictEqual(area, "23s,17s,154w,146w");
    });

    it("reproduces the old hardcoded preset area from the right position", () => {
      // Old preset: gfs:24n,34n,72w,60w|2,2|12,24,36,48|wind
      // Center = 29N, 66W, halfLat=5, halfLon=6
      const area = buildArea(29, -66, 5, 6);
      assert.strictEqual(area, "24n,34n,72w,60w");
    });
  });

  describe("buildRequest", () => {
    it("builds a full request string from the local-wind preset", () => {
      const req = buildRequest("local-wind", 29, -66);
      assert.strictEqual(req, "gfs:26n,32n,70w,62w|2,2|12,24,36,48|wind");
    });

    it("builds a full request string from the local-wind-pressure preset", () => {
      const req = buildRequest("local-wind-pressure", 29, -66);
      assert.strictEqual(req, "gfs:24n,34n,72w,60w|4,4|12,24,36,48|wind,press");
    });

    it("builds a full request string from the extended preset", () => {
      const req = buildRequest("extended", 0, 0);
      assert.strictEqual(req, "gfs:10s,10n,12w,12e|8,8|12,48|wind,press");
    });

    it("returns null for an unknown preset", () => {
      assert.strictEqual(buildRequest("nonexistent", 29, -66), null);
    });
  });

  describe("PRESETS", () => {
    it("defines three presets", () => {
      const keys = Object.keys(PRESETS);
      assert.strictEqual(keys.length, 3);
      assert.ok(keys.includes("local-wind"));
      assert.ok(keys.includes("local-wind-pressure"));
      assert.ok(keys.includes("extended"));
    });

    it("each preset has all required fields", () => {
      for (const [id, preset] of Object.entries(PRESETS)) {
        assert.ok(preset.label, `${id} should have a label`);
        assert.ok(preset.model, `${id} should have a model`);
        assert.ok(
          typeof preset.halfLat === "number",
          `${id} should have halfLat`,
        );
        assert.ok(
          typeof preset.halfLon === "number",
          `${id} should have halfLon`,
        );
        assert.ok(preset.grid, `${id} should have grid`);
        assert.ok(preset.hours, `${id} should have hours`);
        assert.ok(preset.params, `${id} should have params`);
      }
    });
  });
});
