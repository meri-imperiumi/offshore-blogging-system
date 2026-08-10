// Smoketests for the clipboard copy logic, including the non-secure context
// fallback. The UI lives in public/app.js which targets the browser, so we
// load it into a minimal vm sandbox with mocked DOM/navigator rather than
// pulling in a full DOM implementation (which would add a dependency).

const { describe, it } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const appJsPath = path.join(__dirname, "..", "public", "app.js");
const appSource = fs.readFileSync(appJsPath, "utf8");

// Load app.js into a fresh sandbox with mocked browser globals and return
// helpers for inspecting what happened on the (mock) clipboard / DOM.
function loadUI({
  clipboardAvailable = true,
  writeTextRejects = false,
  execCommandThrows = false,
  execCommandOk = true,
} = {}) {
  let copiedValue = null;
  const execCommandCalls = [];
  const writeTextCalls = [];

  const body = {
    appendChild(el) {
      this._el = el;
    },
    removeChild(_el) {
      this._el = null;
    },
  };

  const document = {
    addEventListener() {
      // No-op for DOMContentLoaded during load.
    },
    body,
    createElement(tag) {
      return {
        tag,
        value: "",
        style: {},
        setAttribute() {},
        select() {
          // Mirror a real selection so execCommand("copy") can read it.
          document._selectedValue = this.value;
        },
      };
    },
    execCommand(cmd) {
      execCommandCalls.push(cmd);
      if (execCommandThrows) {
        throw new Error("execCommand failed");
      }
      if (execCommandOk && cmd === "copy" && document._selectedValue != null) {
        copiedValue = document._selectedValue;
      }
      return execCommandOk;
    },
  };

  const navigator = clipboardAvailable
    ? {
        clipboard: {
          writeText(text) {
            writeTextCalls.push(text);
            return writeTextRejects
              ? Promise.reject(new Error("writeText failed"))
              : Promise.resolve();
          },
        },
      }
    : {};

  const sandbox = { document, navigator, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // Expose the class on the sandbox global so the tests can reach it.
  vm.runInContext(
    `${appSource}\n;this.OffshoreBloggingUI = OffshoreBloggingUI;`,
    sandbox,
  );

  return {
    OffshoreBloggingUI: sandbox.OffshoreBloggingUI,
    getCopiedValue: () => copiedValue,
    getExecCommandCalls: () => execCommandCalls,
    getWriteTextCalls: () => writeTextCalls,
  };
}

describe("OffshoreBloggingUI.copyText", () => {
  it("uses the async Clipboard API in a secure context", async () => {
    const {
      OffshoreBloggingUI,
      getWriteTextCalls,
      getExecCommandCalls,
      getCopiedValue,
    } = loadUI({ clipboardAvailable: true });

    const ok = await OffshoreBloggingUI.copyText("hello offshore");

    assert.strictEqual(ok, true);
    assert.deepStrictEqual(getWriteTextCalls(), ["hello offshore"]);
    // Should not fall back to the legacy execCommand path.
    assert.deepStrictEqual(getExecCommandCalls(), []);
    assert.strictEqual(getCopiedValue(), null);
  });

  it("falls back to the legacy textarea path in a non-secure context", async () => {
    const {
      OffshoreBloggingUI,
      getCopiedValue,
      getExecCommandCalls,
      getWriteTextCalls,
    } = loadUI({ clipboardAvailable: false });

    const ok = await OffshoreBloggingUI.copyText("weather chunk 1");

    assert.strictEqual(ok, true);
    // navigator.clipboard was unavailable, so the async API is never used.
    assert.deepStrictEqual(getWriteTextCalls(), []);
    // The legacy path uses execCommand("copy").
    assert.deepStrictEqual(getExecCommandCalls(), ["copy"]);
    // And the text actually reached the clipboard via the textarea value.
    assert.strictEqual(getCopiedValue(), "weather chunk 1");
  });

  it("falls back to the legacy path when writeText rejects", async () => {
    const {
      OffshoreBloggingUI,
      getCopiedValue,
      getExecCommandCalls,
      getWriteTextCalls,
    } = loadUI({ clipboardAvailable: true, writeTextRejects: true });

    const ok = await OffshoreBloggingUI.copyText("retry via legacy");

    assert.strictEqual(ok, true);
    // It tried the async API first...
    assert.deepStrictEqual(getWriteTextCalls(), ["retry via legacy"]);
    // ...then fell back to execCommand after the rejection.
    assert.deepStrictEqual(getExecCommandCalls(), ["copy"]);
    assert.strictEqual(getCopiedValue(), "retry via legacy");
  });
});

describe("OffshoreBloggingUI.copyTextLegacy", () => {
  it("copies via a hidden textarea and returns true", () => {
    const { OffshoreBloggingUI, getCopiedValue, getExecCommandCalls } =
      loadUI();

    const ok = OffshoreBloggingUI.copyTextLegacy("manual fallback text");

    assert.strictEqual(ok, true);
    assert.deepStrictEqual(getExecCommandCalls(), ["copy"]);
    assert.strictEqual(getCopiedValue(), "manual fallback text");
  });

  it("returns false when execCommand returns false", () => {
    const { OffshoreBloggingUI, getCopiedValue } = loadUI({
      execCommandOk: false,
    });

    const ok = OffshoreBloggingUI.copyTextLegacy("will not copy");

    assert.strictEqual(ok, false);
    assert.strictEqual(getCopiedValue(), null);
  });

  it("returns false when execCommand throws", () => {
    const { OffshoreBloggingUI, getCopiedValue } = loadUI({
      execCommandThrows: true,
    });

    const ok = OffshoreBloggingUI.copyTextLegacy("will throw");

    assert.strictEqual(ok, false);
    assert.strictEqual(getCopiedValue(), null);
  });
});
