const { Component, failed } = require("noflo-assembly");

/**
 * AlertComposer - Out-of-band operator alert for unrecoverable failures.
 *
 * Sits on InReachSender's OUT port (and DacarAuthorizer's DENIED port) and
 * composes an operator-facing email (handed to SmtpResponder over SMTP) when
 * a failure looks serious enough to page the operator.
 *
 * Design: fail-open (opt-out, not opt-in). We alert on ANYTHING that isn't
 * explicitly known to be transient. This means a new, unforeseen failure
 * mode produces a [UNKNOWN ALERT] instead of being silently swallowed —
 * the operator can then decide whether it matters and either add the code
 * to TRANSIENT_CODES (if it's benign) or to ALERT_PREFIXES (for a nicer
 * subject line). One rate-limited false positive is far better than
 * silently missing a new failure mode.
 *
 * Why SMTP: cloud.md's "not itself routed through this same component" rule.
 * The alert goes out over SMTP (SmtpResponder), never back through
 * InReachSender, so a dead InReach channel can still notify the operator.
 *
 * Rate limiting: max one alert per error code per `ratelimitms` window
 * (default 1 hour), in-memory per instance. A persistent failure still
 * surfaces (the first one alerts, then repeats hourly); transient flapping
 * doesn't flood the operator's inbox. Per-code (not per-boat) on purpose:
 * the alert is a "wake up, check ErrorLogger" signal, and if SESSION_EXPIRED
 * is hitting multiple boats it's almost certainly a systemic Garmin issue
 * that one alert covers. The full per-incident detail is in ErrorLogger
 * (wired in parallel in the graph), which records every failure unfiltered.
 *
 * Transient codes (dropped — known to self-heal):
 *   RATE_LIMITED     — 429. Retry later.
 *   NETWORK_ERROR    — transport/timeout. Retry later.
 *   API_FAILURE       — other non-200. Treated as transient to avoid paging
 *                      on a Garmin 500 that recovers in minutes. If this
 *                      masks real failures, remove it from this set.
 *
 * Alerted codes (non-exhaustive — anything not transient alerts):
 *   SESSION_EXPIRED  — 401/403. Reply channel/GUID is closed; recovery
 *                      needs a fresh inbound message from the boat.
 *   BAD_URL          — reply URL missing/malformed. Won't self-heal.
 *   NOT_CONFIGURED   — replyaddress control port unset. Config error.
 *   BAD_RESPONSE     — 200 with HTML body: Garmin served a login/error page.
 *   AUTH_DENIED      — Authorization/security event (spoofing attempt).
 *   <unknown>        — Any code not in TRANSIENT_CODES or ALERT_PREFIXES
 *                      gets a [UNKNOWN ALERT] prefix so the operator knows
 *                      to investigate and classify it.
 *   <no code>        — Error with no .code property gets [ALERT] + UNCLASSIFIED
 *                      as the synthetic code.
 */

// Codes we KNOW are transient — retry or drop, don't alert.
// Everything else alerts. Adding a new transient code here suppresses it.
const TRANSIENT_CODES = new Set([
  "RATE_LIMITED", // 429
  "NETWORK_ERROR", // transport/timeout
  "API_FAILURE", // other non-200 (see comment above)
]);

// Alert prefix by code type. Codes not listed here get [UNKNOWN ALERT].
// Adding a new alert type: set err.code in the source component, wire it
// to AlertComposer in the graph, and optionally add a prefix here.
const ALERT_PREFIXES = {
  // InReach transport failures
  SESSION_EXPIRED: "[InReach Alert]",
  BAD_URL: "[InReach Alert]",
  NOT_CONFIGURED: "[InReach Alert]",
  BAD_RESPONSE: "[InReach Alert]",
  // Authorization/security events
  AUTH_DENIED: "[AUTH ALERT]",
  // System errors (future extensions — components that set these codes
  // will automatically alert even without being listed here, but listing
  // them gives a cleaner subject line)
  GIT_PUSH_FAILED: "[SYSTEM ALERT]",
  BLOG_DECODE_CRC_MISMATCH: "[SYSTEM ALERT]",
  GIT_COMMIT_FAILED: "[SYSTEM ALERT]",
  GIT_MERGE_CONFLICT: "[SYSTEM ALERT]",
  // No .code property on the error at all
  UNCLASSIFIED: "[ALERT]",
};

// Prefix for codes we've never seen before (not in ALERT_PREFIXES, not
// in TRANSIENT_CODES). Signals "investigate and classify me."
const UNKNOWN_PREFIX = "[UNKNOWN ALERT]";

class AlertComposer extends Component {
  constructor() {
    super({
      description:
        "Composes operator alerts for unrecoverable InReach failures, rate-limited per error code",
      inPorts: {
        in: {
          datatype: "object",
          description: "Failed assembly message from InReachSender error port",
        },
        alertaddress: {
          datatype: "string",
          description:
            "Operator email address to alert (e.g. captain@phone.example)",
          control: true,
          required: false,
        },
        ratelimitms: {
          datatype: "number",
          description:
            "Min interval between alerts of the same code, in ms (default: 3600000 = 1h)",
          control: true,
          required: false,
          default: 3600000,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Composed alert message (for SmtpResponder)",
        },
      },
    });

    this.alertAddress = null;
    this.rateLimitMs = 3600000;
    // code -> last-alerted timestamp (ms). In-memory; resets on restart, which
    // is acceptable (one extra alert through after a restart).
    this.lastAlert = {};
  }

  handle(input, output) {
    // Process control ports
    if (input.hasData("alertaddress")) {
      this.alertAddress = input.getData("alertaddress");
    }
    if (input.hasData("ratelimitms")) {
      this.rateLimitMs = input.getData("ratelimitms");
    }

    // Sync `return` (not `return null`): in an async handle, `return null`
    // resolves the promise and NoFlo calls output.sendDone(null), forwarding
    // null to the out port. A sync handle's `return` yields undefined, which
    // NoFlo treats as "preconditions not met" without sending anything.
    if (!input.hasData("in")) {
      return;
    }

    const msg = input.getData("in");

    // Non-failed messages shouldn't arrive on an error path, but pass them
    // through so the graph never stalls (defensive — matches ErrorLogger).
    if (!failed(msg)) {
      return output.sendDone(msg);
    }

    // No alert address configured: can't alert. Drop silently (the failure
    // is still recorded via the parallel ErrorLogger wire). Don't re-fail —
    // the msg is already failed.
    if (!this.alertAddress) {
      return output.done();
    }

    // Find the error code. The last error is the most recent (fail()
    // appends). If it lacks a code, we use a synthetic "UNCLASSIFIED" code
    // so we still alert — an error with no code is itself unexpected.
    const err = msg.errors?.[msg.errors.length - 1];
    const rawCode = err?.code;
    const code = rawCode || "UNCLASSIFIED";

    // Only suppress known-transient codes. Everything else alerts —
    // fail-open so unforeseen failure modes are visible.
    if (TRANSIENT_CODES.has(code)) {
      return output.done();
    }

    // Rate limit: max one alert per code per window.
    const now = Date.now();
    if (this.lastAlert[code] && now - this.lastAlert[code] < this.rateLimitMs) {
      return output.done();
    }
    this.lastAlert[code] = now;

    // Compose the alert. replyTo is the operator so SmtpResponder addresses
    // it correctly; channel 'winlink' means "route via SMTP" (defensive: if
    // this wire were ever rewired through ReplyDispatcher, it could not loop
    // back through InReachSender).
    const text = renderAlert(code, err, msg);
    const alertMsg = {
      errors: [],
      identityHash: msg.identityHash,
      replyTo: this.alertAddress,
      channel: "winlink",
      intent: "NOTIFY",
      // SmtpResponder uses notifyText for both subject (first line) and body.
      notifyText: text,
      payload: text,
    };

    return output.sendDone(alertMsg);
  }
}

/**
 * Render a human-readable, actionable alert body. First line is the subject
 * (SmtpResponder takes notifyText.split("\n")[0]); the rest is the body.
 *
 * Distinguish between:
 * 1. Failures AFTER success (blog published, GRIB saved, status built) - show context
 * 2. Failures BEFORE success (bad URL, no config, auth denied, CRC mismatch) - no context
 */
function renderAlert(code, err, msg) {
  const prefix = ALERT_PREFIXES[code] || UNKNOWN_PREFIX;
  const lines = [`${prefix} ${code}`, "", err.message || "(no detail)"];

  // Show all errors in the message, not just the last one
  if (msg.errors && msg.errors.length > 1) {
    lines.push("");
    lines.push(`All errors (${msg.errors.length}):`);
    for (let i = 0; i < msg.errors.length; i++) {
      const e = msg.errors[i];
      const prefix = i === msg.errors.length - 1 ? "→ " : "  ";
      const errorLine = e.code
        ? `${prefix}[${e.code}] ${e.message}`
        : `${prefix}${e.message}`;
      lines.push(errorLine);
    }
  }

  // Check if this message has evidence of prior success
  // Success markers: notifyText, transmissionId, filename from upstream components
  const hasSuccessContext =
    msg.notifyText ||
    msg.transmissionId ||
    (msg.filename && !code.includes("BAD_URL"));

  // Add context based on alert type
  if (code === "AUTH_DENIED") {
    lines.push("");
    lines.push(`Identity: ${msg.identityHash || "UNKNOWN"}`);
    if (msg.permission) {
      lines.push(`Permission requested: ${msg.permission}`);
    }
  } else if (hasSuccessContext) {
    lines.push("");
    lines.push(`What succeeded (but couldn't confirm):`);
    if (msg.notifyText) {
      lines.push(msg.notifyText);
    }
    if (msg.filename) {
      lines.push(`Blog post: ${msg.filename}`);
    }
    if (msg.transmissionId) {
      lines.push(`Transmission ID: ${msg.transmissionId}`);
    }
    if (msg.payload && !String(msg.payload).startsWith("InReach:")) {
      // For status replies, show the full payload
      lines.push(`\nStatus info:\n${String(msg.payload)}`);
    }
  }

  lines.push("");
  lines.push(`Original intent: ${msg.intent || "UNKNOWN"}`);
  if (code !== "AUTH_DENIED") {
    // Already shown above for auth alerts
    lines.push(`Identity: ${msg.identityHash || "UNKNOWN"}`);
  }
  if (msg.replyTo) {
    lines.push(`Reply URL: ${msg.replyTo}`);
  }
  return lines.join("\n");
}

exports.getComponent = () => new AlertComposer();
exports.renderAlert = renderAlert;
