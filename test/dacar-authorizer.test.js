import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

// Load component via createRequire so the test shares the component's CJS
// module instance (same reasoning as the AuthVerifier/InReachSender tests).
const require = createRequire(import.meta.url);
const mod = require("../components/DacarAuthorizer.js");
const { failed, fail } = require("noflo-assembly");

// Resolve the bundled `dacar` CLI for the real shell-out test. The package
// restricts its `exports` map, so resolve the package root via package.json
// (which IS exported) and reach the bin symlink on the filesystem directly.
const pkgDir = path.dirname(require.resolve("@reticulum/dacar/package.json"));
const dacarBin = path.join(pkgDir, "..", "..", ".bin", "dacar");
const dacarAvailable = existsSync(dacarBin);

/**
 * Drive DacarAuthorizer.handle() once and resolve the first sendDone payload.
 *
 * `handle()` is sync but fire-and-forgets an async authorize() (see
 * component-basics.md "Async/Await Trap"), so the output may land on a later
 * microtask. We resolve as soon as sendDone fires (or after a timeout).
 *
 * @param {object} opts
 * @param {object} [opts.msg] Message on the `in` port.
 * @param {object} [opts.controls] Control-port values, e.g. { permission }.
 * @param {object} [opts.di] Injectable seam to set on the instance.
 * @returns {Promise<object|null>} The `{ portName: msg }` sendDone payload.
 */
function runHandle({ msg, controls = {}, di } = {}) {
  const component = mod.getComponent();
  if (di) component.di = di;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const fakeOutput = {
      sendDone: (data) => finish(data),
      done: () => {},
      send: () => {},
    };
    const store = { ...controls, in: msg };
    const fakeInput = {
      hasData: (p) => p in store,
      getData: (p) => store[p],
    };
    component.handle(fakeInput, fakeOutput);
    // Fallback in case sendDone never fires (shouldn't happen for these
    // inputs, but keeps a hung test from blocking the whole suite).
    setTimeout(() => finish(null), 1500);
  });
}

const baseMsg = () => ({
  errors: [],
  identityHash: "cc".repeat(16),
  replyTo: "https://inreachlink.com/abc",
  channel: "inreach",
  intent: "SYS",
  payload: "STATUS",
});

describe("DacarAuthorizer", () => {
  it("exists and exports getComponent", () => {
    assert.strictEqual(typeof mod.getComponent, "function");
  });

  it("creates a component without crashing", () => {
    const component = mod.getComponent();
    assert(component !== null);
    assert.strictEqual(typeof component.handle, "function");
  });

  it("allows and passes the message through unchanged when the checker allows", async () => {
    const msg = baseMsg();
    const out = await runHandle({
      msg,
      controls: { permission: "blog:publish" },
      di: { runCheck: async () => ({ allowed: true }) },
    });
    assert.ok(out, "should produce output");
    assert.ok(out.out, "should go to the `out` port");
    assert.strictEqual(out.out, msg, "should pass the same message object");
    assert.strictEqual(
      out.out.channel,
      "inreach",
      "channel preserved for reply routing",
    );
    assert.strictEqual(out.out.intent, "SYS");
  });

  it("denies (NOTIFY) and fails the message when the checker denies", async () => {
    const msg = baseMsg();
    const out = await runHandle({
      msg,
      controls: { permission: "blog:publish" },
      di: { runCheck: async () => ({ allowed: false }) },
    });
    assert.ok(out, "should produce output");
    assert.ok(out.denied, "should go to the `denied` port");
    assert.ok(failed(out.denied), "denied message should be marked failed");
    assert.strictEqual(out.denied.intent, "NOTIFY");
    assert.match(
      out.denied.payload,
      /Access denied: Not authorized for blog:publish/,
    );
  });

  it("passes the grantee identity hash and permission to the checker", async () => {
    const msg = baseMsg();
    let seen = null;
    const out = await runHandle({
      msg,
      controls: { permission: "grib:request" },
      di: {
        runCheck: async (grantee, permission) => {
          seen = { grantee, permission };
          return { allowed: true };
        },
      },
    });
    assert.ok(out.out, "should allow");
    assert.deepEqual(seen, {
      grantee: msg.identityHash,
      permission: "grib:request",
    });
  });

  it("passes the configured store path through to the checker", async () => {
    // The STORE inport (fed by the DacarEnv core/ReadEnv node in the graph)
    // must reach runCheck so the CLI evaluates against the operator's store.
    const msg = baseMsg();
    let seenStore = "UNSET";
    const out = await runHandle({
      msg,
      controls: { permission: "blog:publish", store: "/custom/dacar" },
      di: {
        runCheck: async (_grantee, _perm, store) => {
          seenStore = store;
          return { allowed: true };
        },
      },
    });
    assert.ok(out.out, "should allow");
    assert.strictEqual(
      seenStore,
      "/custom/dacar",
      "store IIP must be forwarded",
    );
  });

  it("forwards an undefined store when no STORE IIP is received (CLI resolves default)", async () => {
    // When DACAR_HOME is unset, core/ReadEnv sends nothing on OUT, so no STORE
    // IIP reaches the component. runCheck then omits `--store` and lets the
    // `dacar` CLI resolve its own default (~/.dacar) — same path the
    // operator's `dacar grant` uses.
    const msg = baseMsg();
    let seenStore = "UNSET";
    const out = await runHandle({
      msg,
      controls: { permission: "blog:publish" },
      di: {
        runCheck: async (_grantee, _perm, store) => {
          seenStore = store;
          return { allowed: true };
        },
      },
    });
    assert.ok(out.out, "should allow");
    assert.ok(
      !seenStore,
      "no store IIP → falsy store → runCheck omits --store (CLI default)",
    );
  });

  it("fails closed with an Authorization error when the checker rejects (infrastructure failure)", async () => {
    const msg = baseMsg();
    const out = await runHandle({
      msg,
      controls: { permission: "blog:publish" },
      di: {
        runCheck: async () => {
          throw new Error("dacar CLI not found at 'dacar'");
        },
      },
    });
    assert.ok(
      out.denied,
      "infrastructure failure should still deny (fail closed)",
    );
    assert.ok(failed(out.denied));
    assert.match(
      out.denied.payload,
      /Authorization error: dacar CLI not found/,
    );
  });

  it("passes a pre-failed message straight to denied without calling the checker", async () => {
    const msg = baseMsg();
    fail(msg, new Error("upstream reassembly failure"));
    let called = false;
    const out = await runHandle({
      msg,
      controls: { permission: "blog:publish" },
      di: {
        runCheck: async () => {
          called = true;
          return { allowed: true };
        },
      },
    });
    assert.ok(out.denied, "failed assembly should go straight to denied");
    assert.ok(!called, "checker must not be consulted for pre-failed messages");
  });

  it("denies when no permission is configured", async () => {
    const msg = baseMsg();
    const out = await runHandle({
      msg,
      controls: {},
      di: { runCheck: async () => ({ allowed: true }) },
    });
    assert.ok(out.denied);
    assert.match(out.denied.payload, /No permission configured/);
  });

  it("denies when the message carries no identity hash", async () => {
    const msg = baseMsg();
    delete msg.identityHash;
    const out = await runHandle({
      msg,
      controls: { permission: "blog:publish" },
      di: { runCheck: async () => ({ allowed: true }) },
    });
    assert.ok(out.denied);
    assert.match(out.denied.payload, /No identity hash on message/);
  });
});

describe("DacarAuthorizer.runCheck against the real dacar binary", {
  skip: !dacarAvailable && "dacar CLI not installed in node_modules/.bin",
}, () => {
  it("allows a granted permission and denies an ungranted one", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "dacar-auth-"));
    const grantee = "dd".repeat(16);
    try {
      // Bootstrap the store offline (init is offline; grant without
      // --publish writes locally and never boots RNS).
      execFileSync(dacarBin, ["init", "--store", tmp], { stdio: "pipe" });
      execFileSync(
        dacarBin,
        ["grant", "--store", tmp, grantee, "execute", "blog:publish"],
        { stdio: "pipe" },
      );

      const savedBin = process.env.DACAR_BIN;
      process.env.DACAR_BIN = dacarBin;
      try {
        // `di.runCheck` is the production default (shells out). The store path
        // is now passed explicitly (third arg) rather than read from DACAR_HOME
        // env — mirroring how the graph feeds STORE via core/ReadEnv. With no
        // store arg, runCheck would omit `--store` and the CLI would resolve
        // its own default; here we point it at the temp store we just bootstrapped.
        const allow = await mod.di.runCheck(grantee, "blog:publish", tmp);
        assert.ok(allow.allowed, "granted permission should be allowed");

        const deny = await mod.di.runCheck(grantee, "grib:request", tmp);
        assert.ok(!deny.allowed, "ungranted permission should be denied");
      } finally {
        if (savedBin === undefined) delete process.env.DACAR_BIN;
        else process.env.DACAR_BIN = savedBin;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolves the store via $DACAR_HOME when no store arg is passed", async () => {
    // Mirrors the graph's unset-IIP path: core/ReadEnv sends nothing when
    // DACAR_HOME is set, DacarAuthorizer omits `--store`, and the `dacar` CLI
    // resolves $DACAR_HOME itself. Verifies the cloud and the operator's
    // `dacar grant` agree on the store without the component carrying any
    // store-path knowledge.
    const tmp = mkdtempSync(path.join(tmpdir(), "dacar-env-"));
    const grantee = "ee".repeat(16);
    try {
      execFileSync(dacarBin, ["init", "--store", tmp], { stdio: "pipe" });
      // Grant via DACAR_HOME (the operator's path), not --store.
      const savedHome = process.env.DACAR_HOME;
      const savedBin = process.env.DACAR_BIN;
      process.env.DACAR_HOME = tmp;
      process.env.DACAR_BIN = dacarBin;
      try {
        execFileSync(dacarBin, ["grant", grantee, "execute", "blog:publish"], {
          stdio: "pipe",
        });
        // No third arg → runCheck omits `--store` → CLI reads $DACAR_HOME.
        const allow = await mod.di.runCheck(grantee, "blog:publish");
        assert.ok(
          allow.allowed,
          "CLI should resolve $DACAR_HOME with no --store",
        );
      } finally {
        if (savedHome === undefined) delete process.env.DACAR_HOME;
        else process.env.DACAR_HOME = savedHome;
        if (savedBin === undefined) delete process.env.DACAR_BIN;
        else process.env.DACAR_BIN = savedBin;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
