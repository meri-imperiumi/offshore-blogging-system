// Smoketests for the tactical sci-fi UI styling (Signal K plugin visual spec).
// The spec lives in the signalk-visuals context document: semantic neon CSS
// variables, flat geometry, theme classes, day/night modes and 48px touch
// targets. These tests parse the static webapp files to catch regressions.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const htmlPath = path.join(__dirname, "..", "public", "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const appJs = fs.readFileSync(
  path.join(__dirname, "..", "public", "app.js"),
  "utf8",
);

function stylesheet(source) {
  const match = source.match(/<style>([\s\S]*?)<\/style>/);
  return match ? match[1] : "";
}

const css = stylesheet(html);

describe("Signal K tactical sci-fi styling", () => {
  it("defines the semantic color system at :root", () => {
    const requiredVars = [
      "--bg-base: #080a0c",
      "--bg-panel: #111414",
      "--bg-panel-muted: #0a0c0c",
      "--color-green: #6b9e78",
      "--color-teal: #4b8b99",
      "--color-orange: #c77b28",
      "--color-red: #c94b4b",
      "--color-grey: #444444",
      "--text-main: #ffffff",
      "--text-muted: #888899",
    ];
    for (const decl of requiredVars) {
      assert.ok(css.includes(decl), `missing :root variable ${decl}`);
    }
  });

  it("provides theme classes that swap the local theme color", () => {
    for (const theme of [
      "theme-green",
      "theme-teal",
      "theme-orange",
      "theme-red",
      "theme-offline",
    ]) {
      assert.ok(css.includes(`.${theme}`), `missing theme class .${theme}`);
    }
    assert.ok(
      css.includes("--theme-color:"),
      "theme classes must set --theme-color",
    );
  });

  it("uses strictly flat geometry (no non-zero border-radius)", () => {
    const declarations = css.match(/border-radius:\s*[^;]+/g) || [];
    assert.ok(declarations.length > 0, "no border-radius reset found");
    for (const decl of declarations) {
      assert.match(decl, /border-radius:\s*0/, `expected flat radius: ${decl}`);
    }
  });

  it("supports day/night mode via the data-mode attribute", () => {
    assert.ok(
      html.includes('data-mode="night"'),
      "root <html> should default to night mode",
    );
    assert.ok(
      css.includes('[data-mode="day"]'),
      "stylesheet must react to data-mode=day",
    );
  });

  it("enforces 48px touch targets for on-watch (mobile) use", () => {
    assert.match(css, /min-height:\s*48px/);
    assert.match(css, /min-width:\s*48px/);
  });

  it("frames panels with pseudo-element corner brackets", () => {
    assert.match(css, /\.card::before/);
    assert.match(css, /\.card::after/);
    assert.match(css, /border-width:\s*2px/);
  });

  it("uses hardware-style monospace inputs with theme focus color", () => {
    assert.match(css, /appearance:\s*none/);
    assert.match(css, /border-bottom:\s*2px\s+solid\s+var\(--color-grey\)/);
    assert.match(css, /border-bottom-color:\s*var\(--theme-color\)/);
    assert.match(css, /ui-monospace/);
  });

  it("uses tabular numerals for telemetry values", () => {
    assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  });
});

describe("stale style references", () => {
  it("app.js has no references to removed CSS variables", () => {
    for (const stale of [
      "--highlight-color",
      "--border-color",
      "--card-bg",
      "--bg-color",
    ]) {
      assert.ok(!appJs.includes(stale), `stale variable ${stale} in app.js`);
    }
  });

  it("app.js has no legacy hardcoded accent colors or radii", () => {
    for (const stale of ["#ff6b6b", "#2ecc71", 'borderRadius = "5px"']) {
      assert.ok(!appJs.includes(stale), `stale style value ${stale} in app.js`);
    }
  });

  it("index.html has no inline styles using removed variables", () => {
    for (const stale of ["--highlight-color", "--border-color", "--card-bg"]) {
      assert.ok(!html.includes(stale), `stale variable ${stale} in index.html`);
    }
  });
});

describe("semantic color usage", () => {
  it("cards carry distinct theme classes for their operational role", () => {
    const themes = html.match(/class="card theme-(\w+)"/g) || [];
    const distinct = new Set(themes);
    assert.ok(
      distinct.size >= 3,
      `expected at least 3 distinct card themes, got: ${[...distinct].join(", ")}`,
    );
  });

  it("stat readouts are themed per metric", () => {
    const themedStats = html.match(/stat-item theme-\w+/g) || [];
    assert.ok(themedStats.length >= 5, "stats should carry theme classes");
  });

  it("tabs carry their section's semantic color", () => {
    assert.ok(css.includes('.tab[data-tab="weather"]'));
    assert.ok(css.includes('.tab[data-tab="decode"]'));
  });

  it("defines an orange warning panel for incomplete data", () => {
    assert.ok(css.includes(".warning {"));
    assert.ok(css.includes("--color-orange-rgb"));
    assert.ok(
      appJs.includes('missing.length === 0 ? "success" : "warning"'),
      "incomplete chunk groups should use the warning style",
    );
  });

  it("flags the message count when it exceeds the 10-message threshold", () => {
    assert.ok(
      appJs.includes('classList.toggle("theme-orange", estimatedMsgs > 10)'),
      "weather message stat should turn orange above 10 messages",
    );
  });

  it("styles destructive controls in red", () => {
    assert.ok(css.includes(".danger"));
    assert.ok(html.includes('class="danger"'));
  });
});
