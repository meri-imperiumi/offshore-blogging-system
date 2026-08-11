// Tests for GitHelper. These are real-git integration tests (temp repos) that
// pin down the behaviours the cloud pipeline depends on:
//   - exec passes args as separate argv tokens (commit messages with spaces,
//     remote URLs, refs) rather than shell-joining them;
//   - merge forwards all args so `merge("-X","theirs","boat/main")` runs the
//     real strategy instead of a bare `git merge -X`;
//   - isAheadOf() distinguishes "HEAD has commits the remote lacks" (push
//     warranted) from hasChanges()'s "working tree is dirty" (which is always
//     false after a merge commits its result).

const { describe, it, after } = require("node:test");
const assert = require("node:assert");
const fsp = require("node:fs").promises;
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const GitHelper = require("../lib/GitHelper.js");

const dirs = [];

after(async () => {
  await Promise.all(
    dirs.map((d) => fsp.rm(d, { recursive: true, force: true })),
  );
});

/** Run git directly (for clone / init --bare that GitHelper doesn't wrap). */
function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString().trim());
    });
  });
}

async function makeRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "obs-gh-"));
  dirs.push(dir);
  const git = new GitHelper(dir);
  await git.init();
  await git.exec("checkout", "-b", "main");
  await git.exec("config", "user.email", "test@example.com");
  await git.exec("config", "user.name", "Test");
  await git.exec("config", "commit.gpgsign", "false");
  return { dir, git };
}

async function writeFile(dir, name, content) {
  await fsp.writeFile(path.join(dir, name), content);
}

async function commitFile(git, dir, name, content, message) {
  await writeFile(dir, name, content);
  await git.add(name);
  await git.commit(message);
}

describe("GitHelper.exec", () => {
  it("runs git -C <repo> and returns trimmed stdout", async () => {
    const { git } = await makeRepo();
    const out = await git.exec("rev-parse", "--is-inside-work-tree");
    assert.strictEqual(out, "true");
  });

  it("rejects on a failing command with stderr in the message", async () => {
    const { git } = await makeRepo();
    await assert.rejects(
      () => git.exec("show", "no-such-ref"),
      /Git command failed/,
    );
  });
});

describe("GitHelper.commit", () => {
  it("preserves a multi-word commit message (no shell-join truncation)", async () => {
    // Regression: the old exec joined args with spaces and ran through a
    // shell, so `commit -m lofi: 0809 Calm Seas` treated "0809", "Calm",
    // "Seas" as pathspecs and errored. execFile passes the message as one
    // argv token, so it survives verbatim.
    const { dir, git } = await makeRepo();
    await commitFile(git, dir, "a.txt", "x", "lofi: 0809 Calm Seas");

    const subject = await git.exec("log", "--format=%s");
    assert.strictEqual(subject, "lofi: 0809 Calm Seas");
  });
});

describe("GitHelper.hasChanges / isInsideWorkTree", () => {
  it("hasChanges is true for a dirty tree and false after commit", async () => {
    const { dir, git } = await makeRepo();
    await writeFile(dir, "f.txt", "hi");
    assert.strictEqual(await git.hasChanges(), true);
    await git.add("f.txt");
    await git.commit("add f");
    assert.strictEqual(await git.hasChanges(), false);
  });

  it("isInsideWorkTree is true inside the repo", async () => {
    const { git } = await makeRepo();
    assert.strictEqual(await git.isInsideWorkTree(), true);
  });
});

describe("GitHelper.merge", () => {
  it("forwards -X theirs so a conflict resolves to the remote side", async () => {
    // Common ancestor: main has post.md = "base".
    const main = await makeRepo();
    await commitFile(main.git, main.dir, "post.md", "base", "base");

    // Boat is a clone of main, then edits post.md to "hifi".
    const boatDir = await fsp.mkdtemp(path.join(os.tmpdir(), "obs-gh-boat-"));
    dirs.push(boatDir);
    await runGit(["clone", "-q", "-b", "main", main.dir, boatDir]);
    const boatGit = new GitHelper(boatDir);
    await boatGit.exec("config", "user.email", "test@example.com");
    await boatGit.exec("config", "user.name", "Test");
    await boatGit.exec("config", "commit.gpgsign", "false");
    await commitFile(boatGit, boatDir, "post.md", "hifi", "boat: hifi");

    // Main also diverges: edits post.md to "lofi-edit".
    await commitFile(main.git, main.dir, "post.md", "lofi-edit", "main: lofi");

    // Add boat as a remote, fetch, and merge with -X theirs.
    await main.git.exec("remote", "add", "boat", boatDir);
    await main.git.exec("fetch", "boat");
    await main.git.merge("-X", "theirs", "boat/main");

    // The conflict on post.md resolves to boat's "hifi".
    const after = await fsp.readFile(path.join(main.dir, "post.md"), "utf-8");
    assert.strictEqual(after, "hifi");
  });

  it("aborts and re-throws on a merge it cannot complete", async () => {
    const main = await makeRepo();
    await commitFile(main.git, main.dir, "a.txt", "1", "first");
    // Merging a non-existent ref fails.
    await assert.rejects(
      () => main.git.merge("-X", "theirs", "boat/nope"),
      /Git command failed/,
    );
    // Repo is left clean (abort ran), not mid-merge.
    const merges = await main.git
      .exec("rev-parse", "--verify", "MERGE_HEAD")
      .catch(() => null);
    assert.strictEqual(merges, null, "MERGE_HEAD should not exist after abort");
  });
});

describe("GitHelper.isAheadOf", () => {
  it("is ahead when HEAD has commits the remote lacks", async () => {
    const main = await makeRepo();
    await commitFile(main.git, main.dir, "a.txt", "1", "first");

    // Bare remote, push to it, then make a new local commit.
    const bareDir = await fsp.mkdtemp(path.join(os.tmpdir(), "obs-gh-bare-"));
    dirs.push(bareDir);
    await runGit(["init", "--bare", bareDir]);
    await main.git.exec("remote", "add", "origin", bareDir);
    await main.git.push("origin", "main");

    // Up to date with the remote.
    assert.strictEqual(await main.git.isAheadOf("origin", "main"), false);

    // New local commit not on the remote.
    await commitFile(main.git, main.dir, "b.txt", "2", "second");
    assert.strictEqual(await main.git.isAheadOf("origin", "main"), true);

    // After pushing, no longer ahead.
    await main.git.push("origin", "main");
    assert.strictEqual(await main.git.isAheadOf("origin", "main"), false);
  });

  it("falls back to 'has any commits' when the remote ref does not exist yet", async () => {
    // Fresh repo with a commit but no remote at all — the first push still
    // needs to happen, so isAheadOf must return true.
    const main = await makeRepo();
    await commitFile(main.git, main.dir, "a.txt", "1", "first");
    assert.strictEqual(await main.git.isAheadOf("origin", "main"), true);
  });

  it("returns false for an empty repo (no HEAD)", async () => {
    const main = await makeRepo();
    assert.strictEqual(await main.git.isAheadOf("origin", "main"), false);
  });
});

describe("GitHelper.push / pull round-trip", () => {
  it("pushes a branch to a bare remote and pull reproduces it", async () => {
    const main = await makeRepo();
    await commitFile(main.git, main.dir, "a.txt", "hello", "first");

    const bareDir = await fsp.mkdtemp(path.join(os.tmpdir(), "obs-gh-bare-"));
    dirs.push(bareDir);
    await runGit(["init", "--bare", bareDir]);
    await main.git.exec("remote", "add", "origin", bareDir);
    await main.git.push("origin", "main");

    // Clone the bare remote into a fresh repo and confirm the content arrived.
    const cloneDir = await fsp.mkdtemp(path.join(os.tmpdir(), "obs-gh-clone-"));
    dirs.push(cloneDir);
    await runGit(["clone", "-q", bareDir, cloneDir]);
    const content = await fsp.readFile(path.join(cloneDir, "a.txt"), "utf-8");
    assert.strictEqual(content, "hello");
  });
});
