const { Component, failed } = require("noflo-assembly");

/**
 * AlertComposer - Out-of-band operator alert for unrecoverable InReach failures
 *
 * Sits on InReachSender's error port and composes an operator-facing email
 * (handed to SmtpResponder over SMTP) when the InReach reply channel is
 * genuinely dead — NOT on transient failures (rate limits, network blips),
 * which the system can retry or drop without paging the operator.
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
 * Unrecoverable codes (alerted):
 *   SESSION_EXPIRED  — 401/403. Under "no auth session" (treat the Python
 *                      references as canonical: the capability is the per-
 *                      message extId GUID, not a login), this means the
 *                      reply channel/GUID is closed; recovery needs a fresh
 *                      inbound message from the boat.
 *   BAD_URL          — reply URL missing/malformed. Config or upstream bug;
 *                      won't self-heal.
 *   NOT_CONFIGURED   — replyaddress control port unset. Deployment config
 *                      error; needs operator action.
 *
 * Transient codes (dropped silently):
 *   RATE_LIMITED     — 429. Retry later.
 *   NETWORK_ERROR    — transport/timeout. Retry later.
 *   API_FAILURE       — other non-200. Can't cleanly separate 5xx-transient
 *                      from 4xx-permanent without finer status mapping, so
 *                      treated as transient to avoid paging on a Garmin 500
 *                      that recovers in minutes. If this proves to mask real
 *                      failures, promote it to the unrecoverable set.
 */

// Error codes that represent a genuinely dead channel, not a transient blip.
const UNRECOVERABLE_CODES = new Set([
  "SESSION_EXPIRED",
  "BAD_URL",
  "NOT_CONFIGURED",
  // 200 with an HTML body: Garmin served a login/error page instead of
  // honouring the POST. Under the no-session model this is the same class of
  // "reply channel dead" as a 401 — the GUID is no longer usable.
  "BAD_RESPONSE",
]);

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

    // Find the InReachError code. The last error is the most recent (fail()
    // appends). If it lacks a code, this isn't an InReach failure we can
    // classify — drop it (ErrorLogger still records it).
    const err = msg.errors?.[msg.errors.length - 1];
    const code = err?.code;
    if (!code) {
      return output.done();
    }

    // Only alert on unrecoverable codes. Transient failures are dropped.
    if (!UNRECOVERABLE_CODES.has(code)) {
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
 */
function renderAlert(code, err, msg) {
  const lines = [
    `[InReach Alert] ${code}`,
    "",
    err.message || "(no detail)",
    "",
    `Original request: intent=${msg.intent || "UNKNOWN"}, identity=${msg.identityHash || "UNKNOWN"}`,
  ];
  if (msg.replyTo) {
    lines.push(`Original reply URL: ${msg.replyTo}`);
  }
  return lines.join("\n");
}

exports.getComponent = () => new AlertComposer();
