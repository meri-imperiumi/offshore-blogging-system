const { execFile } = require("node:child_process");

/**
 * Git operations helper using node:child_process
 *
 * All commands run via execFile (no shell), so arguments with spaces —
 * commit messages, remote URLs, file paths — are passed as separate argv
 * tokens and never need shell quoting.
 */
class GitHelper {
  constructor(repoPath) {
    this.repoPath = repoPath;
  }

  /**
   * Execute a git command and return trimmed stdout.
   * @param {...string} args git subcommand and its arguments
   */
  async exec(...args) {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        ["-C", this.repoPath, ...args],
        { maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`Git command failed: ${stderr || error.message}`));
            return;
          }
          resolve(stdout.trim());
        },
      );
    });
  }

  /**
   * Initialize a git repository
   */
  async init() {
    return this.exec("init");
  }

  /**
   * Add files to staging
   */
  async add(...files) {
    return this.exec("add", ...files);
  }

  /**
   * Commit staged changes
   */
  async commit(message) {
    return this.exec("commit", "-m", message);
  }

  /**
   * Push a branch to a remote
   */
  async push(remote = "origin", branch = "main") {
    return this.exec("push", remote, branch);
  }

  /**
   * Pull a branch from a remote (fetch + merge)
   * @param {string} remote Remote name (default: "origin")
   * @param {string} branch Branch name (default: "main")
   * @param {string} strategy Merge strategy option (e.g., "theirs" for `-X theirs`)
   */
  async pull(remote = "origin", branch = "main", strategy = null) {
    const args = [remote, branch];
    if (strategy) {
      args.push("-X", strategy);
    }
    return this.exec("pull", ...args);
  }

  /**
   * Get current branch name
   */
  async getCurrentBranch() {
    return this.exec("rev-parse", "--abbrev-ref", "HEAD");
  }

  /**
   * Check if there are uncommitted (unstaged or staged) changes.
   * Note: this reflects the *working tree*, not whether HEAD has advanced
   * past a remote — use isAheadOf() for that.
   */
  async hasChanges() {
    try {
      const status = await this.exec("status", "--porcelain");
      return status.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Check whether the configured path is inside a git work tree.
   * Used by GitPublisher to decide whether to commit/push or just write files
   * (e.g. when pointed at a plain output directory in a test runner).
   */
  async isInsideWorkTree() {
    try {
      const out = await this.exec("rev-parse", "--is-inside-work-tree");
      return out.trim() === "true";
    } catch {
      return false;
    }
  }

  /**
   * Merge, forwarding all arguments verbatim (e.g. "-X", "theirs",
   * "boat/main"). On failure, aborts the in-progress merge (if any) so the
   * repo is not left in a conflicted state, then re-throws.
   *
   * @returns {Promise<boolean>} true if the merge command succeeded
   *   (covers both "merged" and "Already up to date.")
   */
  async merge(...args) {
    try {
      await this.exec("merge", ...args);
      return true;
    } catch (err) {
      try {
        await this.exec("merge", "--abort");
      } catch {
        // Ignore abort errors — repo may not have been mid-merge
      }
      throw err;
    }
  }

  /**
   * Check whether the local branch is ahead of a remote-tracking ref, i.e.
   * whether HEAD has commits the remote does not. This is the right gate for
   * "should we push?" after a sync: hasChanges() only sees uncommitted
   * working-tree edits, so after a merge (which commits) it is always false
   * and a push would never fire.
   *
   * If the remote-tracking ref does not exist yet (fresh repo, never
   * pushed), falls back to "does HEAD have any commits?" — the first push
   * has to create the remote branch.
   *
   * @returns {Promise<boolean>}
   */
  async isAheadOf(remote = "origin", branch = "main") {
    const ref = `${remote}/${branch}`;
    try {
      const count = await this.exec("rev-list", "--count", `${ref}..HEAD`);
      return parseInt(count, 10) > 0;
    } catch {
      // No remote-tracking ref yet — ahead if we have any local commits at all.
      try {
        const localCount = await this.exec("rev-list", "--count", "HEAD");
        return parseInt(localCount, 10) > 0;
      } catch {
        return false;
      }
    }
  }
}

module.exports = GitHelper;
