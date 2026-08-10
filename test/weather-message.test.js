// Smoketests for the weather message builder. The UI lives in public/app.js
// which targets the browser, so we load it into a minimal vm sandbox with
// mocked browser globals (same pattern as copy-clipboard.test.js) and call
// the pure static buildWeatherMessage() method.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const appJsPath = path.join(__dirname, "..", "public", "app.js");
const appSource = fs.readFileSync(appJsPath, "utf8");

function loadUI() {
  const document = { addEventListener() {} };
  const navigator = {};
  const sandbox = { document, navigator, console, localStorage: fakeStorage() };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${appSource}\n;this.OffshoreBloggingUI = OffshoreBloggingUI;`,
    sandbox,
  );
  return sandbox.OffshoreBloggingUI;
}

function fakeStorage() {
  const store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
  };
}

describe("OffshoreBloggingUI.buildWeatherMessage", () => {
  it("wraps a bare Saildocs query with the send command", () => {
    const UI = loadUI();
    const msg = UI.buildWeatherMessage(
      "gfs:20s,14s,155w,147w|2,2|12,24,36,48|wind",
    );
    assert.strictEqual(
      msg,
      "send query@saildocs.com:gfs:20s,14s,155w,147w|2,2|12,24,36,48|wind",
    );
  });

  it("does not double-wrap an explicit send command", () => {
    const UI = loadUI();
    const explicit =
      "send query@saildocs.com:gfs:58n,60n,018e,022e|2,2|0,12|wind";
    assert.strictEqual(UI.buildWeatherMessage(explicit), explicit);
  });

  it("preserves a custom Saildocs address in an explicit send command", () => {
    const UI = loadUI();
    // If the user overrides the address (e.g. a different Saildocs mirror),
    // buildWeatherMessage must leave it alone.
    const custom =
      "send query@saildocs.org:gfs:58n,60n,018e,022e|2,2|0,12|wind";
    assert.strictEqual(UI.buildWeatherMessage(custom), custom);
  });

  it("is case-insensitive about the send prefix", () => {
    const UI = loadUI();
    // "Send ..." (capital S) should also be left unchanged.
    const custom = "Send query@saildocs.com:gfs:58n,60n|2,2|0,12|wind";
    assert.strictEqual(UI.buildWeatherMessage(custom), custom);
  });
});
