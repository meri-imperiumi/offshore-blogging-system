const { Component, failed } = require("noflo-assembly");
const GitHelper = require("../lib/GitHelper");

/**
 * GithubPusher - Pushes updated repository to GitHub
 *
 * Logic:
 * - If the sync produced new commits, pushes to GitHub
 * - Triggers Jekyll CI/Pages build
 * - Does not push if sync was a no-op (avoids empty CI runs)
 */
class GithubPusher extends Component {
  constructor() {
    super({
      description: "Pushes repository to GitHub",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message with sync results",
        },
        repo_path: {
          datatype: "string",
          description: "Path to local git repository",
          control: true,
          required: true,
        },
        github_remote: {
          datatype: "string",
          description: "GitHub remote name (default: origin)",
          control: true,
          required: false,
          default: "origin",
        },
        branch: {
          datatype: "string",
          description: "Branch to push (default: main)",
          control: true,
          required: false,
          default: "main",
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Confirmation message",
        },
        error: {
          datatype: "object",
          description: "Push failure notifications",
        },
      },
    });

    this.repoPath = null;
    this.githubRemote = "origin";
    this.branch = "main";
  }

  handle(input, output) {
    // Process control ports
    if (input.hasData("repo_path")) {
      this.repoPath = input.getData("repo_path");
    }
    if (input.hasData("github_remote")) {
      this.githubRemote = input.getData("github_remote");
    }
    if (input.hasData("branch")) {
      this.branch = input.getData("branch");
    }

    // Sync `return` (not `return null`): in an async handle, `return null`
    // resolves the promise and NoFlo calls output.sendDone(null), forwarding
    // null to the out port. A sync handle's `return` yields undefined, which
    // NoFlo treats as "preconditions not met" without sending anything.
    if (!input.hasData("in")) {
      return;
    }

    const msg = input.getData("in");

    // Check for failed messages (not relevant for RngitSyncer output, but keep for safety)
    if (failed(msg)) {
      return output.send(msg);
    }

    // Validate required settings
    if (!this.repoPath) {
      return;
    }

    // Delegate async work to a helper so handle() returns undefined (not a
    // Promise). If handle() were async, NoFlo would call
    // output.sendDone(resolvedValue) on resolve, causing a duplicate send.
    this._doPush(msg, output);
  }

  async _doPush(msg, output) {
    try {
      const git = new GitHelper(this.repoPath);

      // Check current branch
      const _currentBranch = await git.getCurrentBranch();

      // Fetch from GitHub first, so a push is fast-forward and we don't get
      // rejected if the remote has advanced (e.g. a manual edit). This is
      // best-effort: on a fresh repo the remote branch may not exist yet, so
      // pull errors are ignored — the push below will create the branch.
      try {
        await git.pull(this.githubRemote, this.branch);
      } catch {
        // Remote branch not present yet (first push) or offline — proceed
        // to the ahead check; push will create the branch if needed.
      }

      // Only push when local is genuinely ahead of the remote. Previously
      // this used hasChanges() (working-tree status), which is always false
      // after a merge commits its result — so a push never fired. isAheadOf()
      // counts commits in HEAD not on the remote-tracking ref.
      const shouldPush = await git.isAheadOf(this.githubRemote, this.branch);

      if (shouldPush) {
        // Push to GitHub
        await git.push(this.githubRemote, this.branch);

        output.sendDone({
          errors: [],
          identityHash: "SYSTEM",
          intent: "NOTIFY",
          payload: "GitHub push completed with hi-fi assets",
        });
      } else {
        // No new commits from boat's rngit — no-op (avoid empty CI run)
        output.sendDone(msg);
      }
    } catch (err) {
      // Push errors should be notified
      output.sendDone({
        error: {
          errors: [
            {
              message: `GitHub push failed: ${err.message}`,
            },
          ],
          identityHash: "SYSTEM",
          intent: "NOTIFY",
          payload: `GitHub push failed: ${err.message}`,
        },
      });
    }
  }
}

exports.getComponent = () => new GithubPusher();
