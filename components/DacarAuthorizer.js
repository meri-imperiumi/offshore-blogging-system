const { Component, failed, fail } = require("noflo-assembly");
const { execFile } = require("node:child_process");

/**
 * DacarAuthorizer - Authorization via the `dacar` CLI's local file store.
 *
 * The cloud does NOT own Dacar state. An operator bootstraps and later syncs
 * it out-of-band using the `dacar` CLI:
 *
 *   dacar init                          # creates the store + root trust anchor
 *   dacar grant <grantee> execute blog:publish
 *   dacar sync                          # converge with other nodes over RNS
 *
 * The store path is read from the `STORE` inport, fed by a `core/ReadEnv`
 * node reading `$DACAR_HOME` (default `~/.dacar`) — the SAME env var and
 * default the `dacar` CLI itself uses, so the operator's `dacar grant` and
 * the cloud's `dacar check` can never disagree. When no `STORE` IIP arrives
 * (env var unset), `--store` is omitted entirely and the CLI resolves its own
 * default, so the component carries no store-path knowledge of its own.
 *
 * Each authorization is evaluated by shelling out to
 * `dacar check <grantee> execute <permission>`, so the CLI is the single
 * reader of its own store: the cloud can never drift from the grant format the
 * CLI writes, and a `dacar grant` / `dacar sync` made after the server started
 * is picked up on the very next message (no restart, no cache to invalidate).
 *
 * `dacar check` exit codes: 0 = ALLOW, 1 = DENY. Anything else (binary
 * missing, store uninitialized, timeout) is an infrastructure failure: the
 * component fails CLOSED (deny) but surfaces the cause to the operator log so
 * a fixable misconfiguration is not hidden behind a generic "not authorized".
 *
 * Why shell out rather than load the store in-process? It avoids coupling the
 * cloud to @reticulum/dacar's internal JS API (Engine/DacarStore), needs no
 * extra dependency, and keeps one code path that understands Dacar state. The
 * exit-code contract is the CLI's stable public interface; the JS API is
 * still pre-1.0.
 *
 * The `dacar` binary is located via `$DACAR_BIN` (default: lookup on PATH).
 * Unlike the store path, the binary location is an infrastructure/PATH
 * concern rather than authorization state, so it stays env-only.
 */

/**
 * Default `runCheck`: shells out to `dacar check`.
 *
 * Resolves to `{ allowed: boolean }`. Rejects on infrastructure failure
 * (binary missing, non-{0,1} exit, timeout) so the component can fail closed
 * with an actionable error rather than a silent misclassification.
 *
 * @param {string} grantee Identity hash (hex) of the requester.
 * @param {string} permission Permission/object to check, e.g. `blog:publish`.
 * @param {string} [store] Optional store path; when given, passed as
 *   `--store <path>`. When omitted, the `dacar` CLI resolves its own default
 *   (`$DACAR_HOME || ~/.dacar`) — the same resolution the operator's
 *   `dacar grant` uses.
 * @returns {Promise<{ allowed: boolean }>}
 */
async function runCheck(grantee, permission, store) {
  const bin = process.env.DACAR_BIN || "dacar";
  const args = ["check"];
  if (store) {
    args.push("--store", store);
  }
  args.push(String(grantee), "execute", permission);
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: 15000, maxBuffer: 1 << 20 },
      (err, _stdout, stderr) => {
        if (err) {
          const stderrText = String(stderr || "").trim();
          // `dacar check` exits 1 for a clean DENY — that is its documented
          // contract, not an error. Distinguish it from a fatal exit-1
          // (e.g. an uninitialized store throws inside cmdCheck and the CLI's
          // top-level catch also exits 1): a clean DENY prints the "✘ DENY"
          // marker (or nothing) to stderr, whereas a fatal prints
          // "fatal:" / "error:". Absent the DENY marker, treat exit-1 as an
          // infrastructure failure so the operator sees the real cause.
          if (err.code === 1) {
            if (stderrText === "" || /DENY/i.test(stderrText)) {
              return resolve({ allowed: false });
            }
            return reject(
              new Error(`dacar check failed: ${stderrText || err.message}`),
            );
          }
          if (err.code === "ENOENT") {
            return reject(
              new Error(
                `dacar CLI not found at '${bin}' ` +
                  "(install @reticulum/dacar or set DACAR_BIN)",
              ),
            );
          }
          if (err.signal) {
            return reject(
              new Error(`dacar check killed by signal ${err.signal}`),
            );
          }
          return reject(
            new Error(
              `dacar check exited ${err.code}: ${stderrText || err.message}`,
            ),
          );
        }
        resolve({ allowed: true });
      },
    );
  });
}

// Injectable seam: production shells out; tests substitute a fake checker
// without touching the filesystem or requiring the `dacar` binary on PATH.
const di = { runCheck };

class DacarAuthorizer extends Component {
  constructor() {
    super({
      description:
        "Authorization via the dacar CLI file store " +
        "(operator bootstraps/syncs with `dacar init` / `dacar grant` / `dacar sync`)",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message to authorize",
        },
        permission: {
          datatype: "string",
          description: "Requested permission (e.g., blog:publish)",
          control: true,
          required: true,
        },
        store: {
          datatype: "string",
          description:
            "Optional dacar store path (defaults to $DACAR_HOME || ~/.dacar " +
            "via the dacar CLI itself when unset). Fed by a core/ReadEnv node.",
          control: true,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Authorized assembly message (channel preserved)",
        },
        denied: {
          datatype: "object",
          description: "Denied message as NOTIFY intent",
        },
      },
    });
    this.currentPermission = null;
    this.currentStore = null;
    this.di = di;
  }

  handle(input, output) {
    if (input.hasData("permission")) {
      this.currentPermission = input.getData("permission");
    }
    if (input.hasData("store")) {
      this.currentStore = input.getData("store");
    }

    if (!input.hasData("in")) {
      return;
    }

    const msg = input.getData("in");

    // Failed assemblies (auth, reassembly, …) bypass authorization and go
    // straight to the denied channel so the sender is told why.
    if (failed(msg)) {
      return output.sendDone({ denied: msg });
    }

    if (!this.currentPermission) {
      return this.deny(msg, "No permission configured", output);
    }

    // Fire-and-forget the async check; authorize() owns the output lifecycle.
    // The sync handle must not be async — NoFlo treats a returned Promise as
    // an implicit sendDone() (see component-basics.md "Async/Await Trap").
    this.authorize(msg, output);
  }

  async authorize(msg, output) {
    const grantee = msg.identityHash;
    if (!grantee) {
      return this.deny(msg, "No identity hash on message", output);
    }
    try {
      const { allowed } = await this.di.runCheck(
        grantee,
        this.currentPermission,
        this.currentStore,
      );
      if (allowed) {
        // Allow: pass the IP through unchanged (incl. msg.channel) so
        // ReplyDispatcher can route the eventual reply correctly.
        return output.sendDone({ out: msg });
      }
      return this.deny(
        msg,
        `Not authorized for ${this.currentPermission}`,
        output,
      );
    } catch (err) {
      // Infrastructure failure (binary missing, store uninitialized, timeout).
      // Fail CLOSED — a silent allow here would be a security hole — but log
      // the cause so a fixable misconfiguration isn't hidden behind a generic
      // "not authorized" reply to the (driving-blind) sender.
      console.error(`[DacarAuthorizer] ${err.message}`);
      return this.deny(msg, `Authorization error: ${err.message}`, output);
    }
  }

  deny(msg, reason, output) {
    const err = new Error(reason);
    err.code = "AUTH_DENIED";
    fail(msg, err);
    msg.intent = "NOTIFY";
    msg.payload = `Access denied: ${reason}`;
    return output.sendDone({ denied: msg });
  }

  shutdown() {
    // No long-lived resources: each check spawns a short-lived subprocess.
  }
}

exports.getComponent = () => new DacarAuthorizer();
exports.di = di;
