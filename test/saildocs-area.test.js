const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  PRESETS,
  formatLat,
  formatLon,
  buildArea,
  buildRequest,
  buildRouteArea,
  buildRouteRequest,
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
      // Old preset: ecmwf:24n,34n,72w,60w|4,4|12,24,36,48|WIND,PRMSL
      // Center = 29N, 66W, halfLat=5, halfLon=6
      const area = buildArea(29, -66, 5, 6);
      assert.strictEqual(area, "24n,34n,72w,60w");
    });
  });

  describe("buildRequest", () => {
    it("builds a full request string from the local-wind preset", () => {
      const req = buildRequest("local-wind", 29, -66);
      assert.strictEqual(req, "ecmwf:26n,32n,70w,62w|2,2|12,24,36,48|WIND");
    });

    it("builds a full request string from the local-wind-pressure preset", () => {
      const req = buildRequest("local-wind-pressure", 29, -66);
      assert.strictEqual(
        req,
        "ecmwf:24n,34n,72w,60w|4,4|12,24,36,48|WIND,PRMSL",
      );
    });

    it("builds a full request string from the extended preset", () => {
      const req = buildRequest("extended", 0, 0);
      assert.strictEqual(req, "ecmwf:10s,10n,12w,12e|8,8|12,48|WIND,PRMSL");
    });

    it("returns null for an unknown preset", () => {
      assert.strictEqual(buildRequest("nonexistent", 29, -66), null);
    });
  });

  describe("buildRouteArea", () => {
    it("builds a box covering both points plus margin (boat NE of dest)", () => {
      // Boat at 29N,66W heading to 35N,70W, margin 2
      // south = min(29,35) - 2 = 27  → 27n
      // north = max(29,35) + 2 = 37  → 37n
      // west  = min(-66,-70) - 2 = -72 → 72w
      // east  = max(-66,-70) + 2 = -64 → 64w
      const area = buildRouteArea(29, -66, 35, -70, 2);
      assert.strictEqual(area, "27n,37n,72w,64w");
    });

    it("is order-independent (destination south of boat)", () => {
      // Boat at 29N,66W heading to 20N,60W, margin 2
      // south = min(29,20) - 2 = 18  → 18n
      // north = max(29,20) + 2 = 31  → 31n
      // west  = min(-66,-60) - 2 = -68 → 68w
      // east  = max(-66,-60) + 2 = -58 → 58w
      const area = buildRouteArea(29, -66, 20, -60, 2);
      assert.strictEqual(area, "18n,31n,68w,58w");
    });

    it("handles a route crossing the equator", () => {
      // From 5S to 5N, margin 1
      // south = -6 → 6s, north = 6 → 6n
      // west  = 0 - 1 = -1 → 1w, east = 0 + 1 = 1 → 1e
      const area = buildRouteArea(-5, 0, 5, 0, 1);
      assert.strictEqual(area, "6s,6n,1w,1e");
    });

    it("collapses to a centered box when margin is 0 and points coincide", () => {
      const area = buildRouteArea(29, -66, 29, -66, 0);
      assert.strictEqual(area, "29n,29n,66w,66w");
    });
  });

  describe("buildRouteRequest", () => {
    it("builds a full route request string from the local-wind preset", () => {
      // Boat 29N,66W → dest 35N,70W, margin 2 → area 27n,37n,72w,64w
      const req = buildRouteRequest("local-wind", 29, -66, 35, -70, 2);
      assert.strictEqual(req, "ecmwf:27n,37n,72w,64w|2,2|12,24,36,48|WIND");
    });

    it("reuses the preset's grid/hours/params (extended preset)", () => {
      // Boat 0,0 → dest 10N,20E, margin 3
      // south = -3 → 3s, north = 13 → 13n
      // west  = -3 → 3w, east = 23 → 23e
      const req = buildRouteRequest("extended", 0, 0, 10, 20, 3);
      assert.strictEqual(req, "ecmwf:3s,13n,3w,23e|8,8|12,48|WIND,PRMSL");
    });

    it("returns null for an unknown preset", () => {
      assert.strictEqual(buildRouteRequest("nonexistent", 0, 0, 1, 1, 1), null);
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
