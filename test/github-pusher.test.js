// Tests for GithubPusher. Real git repos (temp). Pins down the inverted-
// predicate fix: after RngitSyncer's merge commits its result, the working
// tree is clean, so the old hasChanges() gate was always false and a push
// never fired. isAheadOf() counts commits HEAD has over the remote instead.

const { describe, it, after } = require("node:test");
const assert = require("node:assert");
const fsp = require("node:fs").promises;
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { getComponent } = require("../components/GithubPusher.js");
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "obs-gp-"));
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

function makeMsg(payload = "synced") {
  return { errors: [], identityHash: "SYSTEM", intent: "NOTIFY", payload };
}

/** Drive one handle() call with a message + control ports. */
function runPush(component, msg, controls = {}) {
  const ports = new Map(Object.entries(controls));
  ports.set("in", msg);
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
    hasData: (p) => ports.has(p),
    getData: (p) => ports.get(p),
  };
  component.handle(input, output);
  return { promise, sent };
}

async function bareCommitCount(bareDir) {
  const out = await runGit(
    ["--git-dir", bareDir, "rev-list", "--count", "main"],
    bareDir,
  ).catch(() => "0");
  return parseInt(out, 10);
}

describe("GithubPusher", () => {
  it("pushes when local is ahead of origin (the merge-committed regression)", async () => {
    // This is the exact scenario the old code failed: a merge has just
    // committed hi-fi content, so hasChanges() is false, but local is
    // ahead of origin and MUST push.
    const main = await makeRepo();
    await commitFile(main.git, main.dir, "post.md", "base", "base");

    // Bare origin, push the base.
    const bareDir = await fsp.mkdtemp(path.join(os.tmpdir(), "obs-gp-bare-"));
    dirs.push(bareDir);
    await runGit(["init", "--bare", bareDir]);
    await main.git.exec("remote", "add", "origin", bareDir);
    await main.git.push("origin", "main");
    assert.strictEqual(await bareCommitCount(bareDir), 1);

    // Simulate the boat merge landing a new commit (committed → clean tree).
    await commitFile(main.git, main.dir, "post.md", "hifi", "merge: hifi");
    assert.strictEqual(await main.git.hasChanges(), false); // tree is clean
    assert.strictEqual(await main.git.isAheadOf("origin", "main"), true);

    const component = getComponent();
    const out = await runPush(component, makeMsg(), {
      repo_path: main.dir,
    }).promise;

    assert.match(out.payload, /GitHub push completed/);

    // The bare remote now has the new commit.
    assert.strictEqual(await bareCommitCount(bareDir), 2);
    // And local is no longer ahead.
    assert.strictEqual(await main.git.isAheadOf("origin", "main"), false);
  });

  it("is a no-op (no push) when local is up to date with origin", async () => {
    const main = await makeRepo();
    await commitFile(main.git, main.dir, "a.txt", "1", "first");
    const bareDir = await fsp.mkdtemp(path.join(os.tmpdir(), "obs-gp-bare-"));
    dirs.push(bareDir);
    await runGit(["init", "--bare", bareDir]);
    await main.git.exec("remote", "add", "origin", bareDir);
    await main.git.push("origin", "main");

    const msg = makeMsg();
    const component = getComponent();
    const out = await runPush(component, msg, { repo_path: main.dir }).promise;

    // No new commits → pass the message through unchanged, no push.
    assert.strictEqual(out, msg);
    assert.strictEqual(await bareCommitCount(bareDir), 1);
  });

  it("creates the remote branch on the first push (pull is best-effort)", async () => {
    // Fresh repo that has never pushed: `git pull origin main` fails (no
    // remote ref yet) but must not abort the push. The push then creates it.
    const main = await makeRepo();
    await commitFile(main.git, main.dir, "a.txt", "1", "first");
    const bareDir = await fsp.mkdtemp(path.join(os.tmpdir(), "obs-gp-bare-"));
    dirs.push(bareDir);
    await runGit(["init", "--bare", bareDir]);
    await main.git.exec("remote", "add", "origin", bareDir);

    const component = getComponent();
    const out = await runPush(component, makeMsg(), {
      repo_path: main.dir,
    }).promise;

    assert.match(out.payload, /GitHub push completed/);
    assert.strictEqual(await bareCommitCount(bareDir), 1);
  });

  it("reports push errors on the error port", async () => {
    const main = await makeRepo();
    await commitFile(main.git, main.dir, "a.txt", "1", "first");
    // Point at a nonexistent remote path — push will fail.
    const bareDir = await fsp.mkdtemp(path.join(os.tmpdir(), "obs-gp-bare-"));
    dirs.push(bareDir);
    await runGit(["init", "--bare", bareDir]);
    await main.git.exec("remote", "add", "origin", path.join(bareDir, "nope"));

    const component = getComponent();
    const out = await runPush(component, makeMsg(), {
      repo_path: main.dir,
    }).promise;

    assert.ok(out.error, "should send to the error port");
    assert.match(out.error.errors[0].message, /GitHub push failed/);
  });
});
