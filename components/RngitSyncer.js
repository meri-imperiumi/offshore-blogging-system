const { Component, failed } = require("noflo-assembly");
const GitHelper = require("../lib/GitHelper");

/**
 * RngitSyncer - Periodic sync with boat's rngit repository for hi-fi assets
 *
 * Logic:
 * - Attempts rngit sync against boat's repository
 * - Pulls in hi-fi replacements for lo-fi assets
 * - Merges using -X theirs so hi-fi content wins over lo-fi
 * - No-ops quietly if boat unreachable
 */
class RngitSyncer extends Component {
  constructor() {
    super({
      description: "Syncs hi-fi assets via rngit",
      inPorts: {
        in: {
          datatype: "bang",
          description: "Trigger sync (periodic)",
        },
        repo_path: {
          datatype: "string",
          description: "Path to local git repository",
          control: true,
          required: true,
        },
        rngit_remote: {
          datatype: "string",
          description: "Rngit remote URL",
          control: true,
          required: true,
        },
        branch: {
          datatype: "string",
          description: "Branch to sync (default: main)",
          control: true,
          required: false,
          default: "main",
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Confirmation message with sync results",
        },
        error: {
          datatype: "object",
          description: "Sync errors",
        },
      },
    });

    this.repoPath = null;
    this.rngitRemote = null;
    this.branch = "main";
  }

  handle(input, output) {
    // Process control ports
    if (input.hasData("repo_path")) {
      this.repoPath = input.getData("repo_path");
    }
    if (input.hasData("rngit_remote")) {
      this.rngitRemote = input.getData("rngit_remote");
    }
    if (input.hasData("branch")) {
      this.branch = input.getData("branch");
    }

    // Consume trigger if present
    if (input.hasData("in")) {
      input.getData("in");
    }

    // Validate required settings
    // Sync `return` (not `return null`): in an async handle, `return null`
    // resolves the promise and NoFlo calls output.sendDone(null), forwarding
    // null to the out port. A sync handle's `return` yields undefined, which
    // NoFlo treats as "preconditions not met" without sending anything.
    if (!this.repoPath || !this.rngitRemote) {
      return;
    }

    // Delegate async work to a helper so handle() returns undefined (not a
    // Promise). If handle() were async, NoFlo would call
    // output.sendDone(resolvedValue) on resolve, causing a duplicate send.
    this._doSync(output);
  }

  async _doSync(output) {
    try {
      const git = new GitHelper(this.repoPath);

      // Add rngit as remote if not already configured
      try {
        await git.exec("remote", "add", "boat", this.rngitRemote);
      } catch (err) {
        // Remote already exists, that's fine
      }

      // Fetch from boat
      await git.exec("fetch", "boat");

      // Get current branch
      const currentBranch = await git.getCurrentBranch();

      // Merge boat's branch into ours with -X theirs
      // This ensures hi-fi content (from boat) wins over lo-fi (our commits)
      const merged = await git.merge("-X", "theirs", `boat/${this.branch}`);

      if (merged) {
        const result = {
          errors: [],
          identityHash: "SYSTEM",
          intent: "NOTIFY",
          payload: "Rngit sync completed - hi-fi assets merged",
        };

        output.sendDone(result);
      } else {
        // No changes to merge
        output.done();
      }
    } catch (err) {
      // Don't fail the graph for sync errors - just notify
      const errorResult = {
        errors: [
          {
            message: `Rngit sync failed: ${err.message}`,
          },
        ],
        identityHash: "SYSTEM",
        intent: "NOTIFY",
        payload: `Rngit sync failed: ${err.message}`,
      };

      output.send({ error: errorResult });
    }
  }
}

exports.getComponent = () => new RngitSyncer();
