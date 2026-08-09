const { exec } = require('node:child_process');

/**
 * Git operations helper using node:child_process
 */
class GitHelper {
  constructor(repoPath) {
    this.repoPath = repoPath;
  }

  /**
   * Execute a git command and return the result
   */
  async exec(...args) {
    return new Promise((resolve, reject) => {
      exec(
        `git -C "${this.repoPath}" ${args.join(' ')}`,
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`Git command failed: ${stderr || error.message}`));
            return;
          }
          resolve(stdout.trim());
        }
      );
    });
  }

  /**
   * Initialize a git repository
   */
  async init() {
    return this.exec('init');
  }

  /**
   * Add files to staging
   */
  async add(...files) {
    return this.exec('add', ...files);
  }

  /**
   * Commit changes
   */
  async commit(message) {
    return this.exec('commit', '-m', message);
  }

  /**
   * Push to remote
   */
  async push(remote = 'origin', branch = 'main') {
    return this.exec('push', `${remote} ${branch}`);
  }

  /**
   * Pull from remote
   */
  async pull(remote = 'origin', branch = 'main') {
    return this.exec('pull', `${remote} ${branch}`);
  }

  /**
   * Get current branch
   */
  async getCurrentBranch() {
    return this.exec('rev-parse', '--abbrev-ref', 'HEAD');
  }

  /**
   * Check if there are uncommitted changes
   */
  async hasChanges() {
    try {
      const status = await this.exec('status', '--porcelain');
      return status.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Merge with strategy
   */
  async merge(strategy, commitMessage) {
    try {
      // Try merge
      await this.exec('merge', strategy);
      return true;
    } catch (err) {
      // If merge failed, try aborting and return false
      try {
        await this.exec('merge', '--abort');
      } catch (abortErr) {
        // Ignore abort errors
      }
      throw err;
    }
  }
}

module.exports = GitHelper;