/**
 * SaildocsArea - Build Saildocs weather request strings from a boat position.
 *
 * Saildocs format:  model:area|grid|hours|params
 * Area:             minLat,maxLat,minLon,maxLon  (e.g. "24n,34n,72w,60w")
 *
 * The area is a bounding box: south,north,west,east — with cardinal
 * suffixes (n/s for latitude, e/w for longitude).
 *
 * Works in both Node (require) and browser (window.SaildocsArea global).
 */

// Preset definitions. halfLat/halfLon define the half-size of the bounding
// box in degrees, centered on the boat's position. The grid resolution
// (gridLat,gridLon) is in degrees between data points — smaller = denser.
const PRESETS = {
  "local-wind": {
    label: "Local wind forecast (4 timepoints)",
    model: "gfs",
    halfLat: 3,
    halfLon: 4,
    grid: "2,2",
    hours: "12,24,36,48",
    params: "wind",
  },
  "local-wind-pressure": {
    label: "Local wind + pressure (4 timepoints)",
    model: "gfs",
    halfLat: 5,
    halfLon: 6,
    grid: "4,4",
    hours: "12,24,36,48",
    params: "wind,press",
  },
  extended: {
    label: "Extended forecast (2 timepoints, wide area)",
    model: "gfs",
    halfLat: 10,
    halfLon: 12,
    grid: "8,8",
    hours: "12,48",
    params: "wind,press",
  },
};

/**
 * Format a latitude value as a Saildocs latitude token.
 * 59.3 → "59n", -33.7 → "34s"
 */
function formatLat(lat) {
  const rounded = Math.round(Math.abs(lat));
  return `${rounded}${lat >= 0 ? "n" : "s"}`;
}

/**
 * Format a longitude value as a Saildocs longitude token.
 * 21.4 → "21e", -72.5 → "73w"
 */
function formatLon(lon) {
  const rounded = Math.round(Math.abs(lon));
  return `${rounded}${lon >= 0 ? "e" : "w"}`;
}

/**
 * Build a Saildocs area string (south,north,west,east) from a center
 * position and half-sizes in degrees.
 *
 * Example: buildArea(29, -66, 5, 6) → "24n,34n,72w,60w"
 */
function buildArea(lat, lon, halfLat, halfLon) {
  const south = lat - halfLat;
  const north = lat + halfLat;
  const west = lon - halfLon;
  const east = lon + halfLon;
  return `${formatLat(south)},${formatLat(north)},${formatLon(west)},${formatLon(east)}`;
}

/**
 * Build a complete Saildocs request string from a preset ID and position.
 * Returns null if the preset ID is not recognized.
 */
function buildRequest(presetId, lat, lon) {
  const preset = PRESETS[presetId];
  if (!preset) return null;
  const area = buildArea(lat, lon, preset.halfLat, preset.halfLon);
  return `${preset.model}:${area}|${preset.grid}|${preset.hours}|${preset.params}`;
}

/**
 * Build a Saildocs area string (south,north,west,east) that covers two
 * positions — the boat's current position and a destination — plus a
 * uniform margin (in degrees) around the whole bounding box.
 *
 * Unlike buildArea (a box centered on one point), this is a route variant:
 * the box hugs both endpoints and the route between them, expanded by the
 * margin so forecast data extends past either end.
 *
 * Example: buildRouteArea(29, -66, 35, -70, 2)
 *   → south = min(29,35) - 2 = 27  → 27n
 *   → north = max(29,35) + 2 = 37  → 37n
 *   → west  = min(-66,-70) - 2 = -72 → 72w
 *   → east  = max(-66,-70) + 2 = -64 → 64w
 *   → "27n,37n,72w,64w"
 *
 * Note: like buildArea, this does not handle antimeridian crossing
 * (lonitudes near ±180); the simple min/max would wrap the wrong way.
 * Most cruising routes don't cross it, and matching buildArea's simplicity
 * keeps the two variants consistent.
 */
function buildRouteArea(lat, lon, destLat, destLon, margin) {
  const south = Math.min(lat, destLat) - margin;
  const north = Math.max(lat, destLat) + margin;
  const west = Math.min(lon, destLon) - margin;
  const east = Math.max(lon, destLon) + margin;
  return `${formatLat(south)},${formatLat(north)},${formatLon(west)},${formatLon(east)}`;
}

/**
 * Build a complete Saildocs request string for a route: current position
 * to destination, with a margin (in degrees) around the bounding box.
 *
 * The model/grid/hours/params come from the given preset (same as the
 * centered buildRequest); only the area differs. Returns null if the
 * preset ID is not recognized.
 */
function buildRouteRequest(presetId, lat, lon, destLat, destLon, margin) {
  const preset = PRESETS[presetId];
  if (!preset) return null;
  const area = buildRouteArea(lat, lon, destLat, destLon, margin);
  return `${preset.model}:${area}|${preset.grid}|${preset.hours}|${preset.params}`;
}

const SaildocsArea = {
  PRESETS,
  formatLat,
  formatLon,
  buildArea,
  buildRequest,
  buildRouteArea,
  buildRouteRequest,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = SaildocsArea;
}
if (typeof window !== "undefined") {
  window.SaildocsArea = SaildocsArea;
}
