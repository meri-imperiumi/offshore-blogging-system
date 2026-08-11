// Tests for RngitSyncer: periodic hi-fi merge from the boat's rngit repo.
// Real git repos (temp). Pins down two fixes:
//   - _doSync only fires on an `in` bang, NOT merely because the control
//     IIPs (repo_path / rngit_remote) arrived — otherwise it spurious-fires
//     on startup and on every control update.
//   - merge("-X","theirs","boat/main") forwards all args (the old code ran a
//     bare `git merge -X`, which errored), and -X theirs makes the boat's
//     hi-fi content win conflicts.

const { describe, it, after } = require("node:test");
const assert = require("node:assert");
const fsp = require("node:fs").promises;
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { getComponent } = require("../components/RngitSyncer.js");
const GitHelper = require("../lib/GitHelper.js");

const dirs = [];

after(async () => {
  await Promise.all(
    dirs.map((d) => fsp.rm(d, { recursive: true, force: true })),
  );
});

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString().trim());
    });
  });
}

async function makeRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "obs-rs-"));
  dirs.push(dir);
  const git = new GitHelper(dir);
  await git.init();
  await git.exec("checkout", "-b", "main");
  await git.exec("config", "user.email", "test@example.com");
  await git.exec("config", "user.name", "Test");
  await git.exec("config", "commit.gpgsign", "false");
  return { dir, git };
}

async function commitFile(git, dir, name, content, message) {
  await fsp.writeFile(path.join(dir, name), content);
  await git.add(name);
  await git.commit(message);
}

const SLEEP = 400;

/**
 * Drive one handle() call. `bang` controls whether the `in` port has data.
 * Controls map to control ports. Resolves with whatever sendDone received
 * (or a TIMEOUT sentinel if nothing was sent).
 */
function runSync(component, { bang, controls = {} }) {
  const ports = new Map(Object.entries(controls));
  let resolveFn;
  const sent = [];
  const output = {
    sendDone: (m) => {
      sent.push(m);
      resolveFn(m);
    },
    send: (m) => sent.push(m),
    done: () => resolveFn(null),
  };
  const promise = new Promise((res) => {
    resolveFn = res;
  });
  const input = {
    hasData: (p) => (p === "in" ? bang : ports.has(p)),
    getData: (p) => (p === "in" ? true : ports.get(p)),
  };
  component.handle(input, output);
  return { promise, sent };
}

describe("RngitSyncer", () => {
  it("does NOT sync when control ports are set but no `in` bang arrives", async () => {
    // Regression: the old handle() called _doSync as soon as repo_path +
    // rngit_remote were present, with no `in` gate. That fired a sync on
    // startup (and on every control update) instead of on the 6h timer.
    const main = await makeRepo();
    await commitFile(main.git, main.dir, "post.md", "base", "base");

    const boatDir = await fsp.mkdtemp(path.join(os.tmpdir(), "obs-rs-boat-"));
    dirs.push(boatDir);
    await runGit(["clone", "-q", "-b", "main", main.dir, boatDir]);

    const component = getComponent();
    const { promise } = runSync(component, {
      bang: false,
      controls: { repo_path: main.dir, rngit_remote: boatDir },
    });

    const TIMEOUT = Symbol("timeout");
    const result = await Promise.race([
      promise,
      new Promise((res) => setTimeout(() => res(TIMEOUT), SLEEP)),
    ]);

    assert.strictEqual(result, TIMEOUT, "sendDone should not have fired");
    // No `boat` remote should have been added (no fetch attempted).
    const remotes = await main.git.exec("remote");
    assert.strictEqual(remotes, "", "no remote should have been configured");
  });

  it("merges boat/main with -X theirs on an `in` bang (hi-fi wins)", async () => {
    const main = await makeRepo();
    await commitFile(main.git, main.dir, "post.md", "base", "base");

    // Boat clones main, then edits post.md to "hifi".
    const boatDir = await fsp.mkdtemp(path.join(os.tmpdir(), "obs-rs-boat-"));
    dirs.push(boatDir);
    await runGit(["clone", "-q", "-b", "main", main.dir, boatDir]);
    const boatGit = new GitHelper(boatDir);
    await boatGit.exec("config", "user.email", "test@example.com");
    await boatGit.exec("config", "user.name", "Test");
    await boatGit.exec("config", "commit.gpgsign", "false");
    await commitFile(boatGit, boatDir, "post.md", "hifi", "boat: hifi");

    // Main diverges too, so the merge actually conflicts.
    await commitFile(main.git, main.dir, "post.md", "lofi", "main: lofi");

    const component = getComponent();
    const out = await runSync(component, {
      bang: true,
      controls: { repo_path: main.dir, rngit_remote: boatDir },
    }).promise;

    assert.ok(out, "should emit a confirmation");
    assert.strictEqual(out.intent, "NOTIFY");
    assert.match(out.payload, /Rngit sync completed/);

    // The boat remote was added and the merge resolved the conflict to theirs.
    assert.strictEqual(await main.git.exec("remote"), "boat");
    const after = fs.readFileSync(path.join(main.dir, "post.md"), "utf-8");
    assert.strictEqual(after, "hifi");
  });

  it("reports an error on the error port when the remote is unreachable", async () => {
    const main = await makeRepo();
    await commitFile(main.git, main.dir, "a.txt", "1", "first");

    const component = getComponent();
    const out = await runSync(component, {
      bang: true,
      controls: {
        repo_path: main.dir,
        rngit_remote: path.join(main.dir, "does-not-exist"),
      },
    }).promise;

    assert.ok(out.error, "should send to the error port");
    assert.match(out.error.errors[0].message, /Rngit sync failed/);
    assert.strictEqual(out.error.identityHash, "SYSTEM");
  });

  it("is a no-op (no error) until both repo_path and rngit_remote are set", async () => {
    // Even with a bang, missing config must not throw or fire _doSync.
    const component = getComponent();
    const { promise } = runSync(component, { bang: true, controls: {} });
    const TIMEOUT = Symbol("timeout");
    const result = await Promise.race([
      promise,
      new Promise((res) => setTimeout(() => res(TIMEOUT), SLEEP)),
    ]);
    assert.strictEqual(result, TIMEOUT, "should not emit without config");
  });
});
