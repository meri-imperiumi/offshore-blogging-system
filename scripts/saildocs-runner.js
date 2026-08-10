#!/usr/bin/env node

/**
 * Saildocs End-to-End Test Runner
 *
 * Sends a real weather-GRIB request to Saildocs via SMTP, then polls IMAP
 * for the response and validates it (GRIB attachment or error text).
 *
 * Flow:
 *   SEND:    GribFetcher → SmtpResponder (SMTP to query@saildocs.com)
 *   RECEIVE: Timer → ImapFetcher → ImapAcker (poll for @saildocs.com reply)
 *
 * The send phase runs at network start (IIPs delivered during createNetwork).
 * The queryId is read back from the shared pending_saildocs DB table. The
 * receive phase polls IMAP; incoming emails are intercepted on the socket
 * between ImapFetcher and ImapAcker for in-script validation.
 *
 * Usage:
 *   Set the required environment variables (see below), then run:
 *     node scripts/saildocs-runner.js
 *
 * Environment:
 *   IMAP_HOST       IMAP server hostname (e.g. imap.gmail.com)
 *   IMAP_USERNAME   IMAP account (also the cloud's sending address)
 *   IMAP_PASSWORD   IMAP password / app-specific password
 *   IMAP_PORT       IMAP port (default 993)
 *   IMAP_MAILBOX    Mailbox to poll (default INBOX)
 *   SMTP_HOST       SMTP server hostname
 *   SMTP_USERNAME   SMTP account (= envelope From, should match IMAP_USERNAME)
 *   SMTP_PASSWORD   SMTP password / app-specific password
 *   SMTP_PORT       SMTP port (465 implicit TLS, 587 STARTTLS)
 *
 *   SAILDOCS_QUERY  Saildocs query string (default: small Baltic wind request)
 *   SAILDOCS_EMAIL  Saildocs query address (default: query@saildocs.com)
 *   POLL_INTERVAL   IMAP poll interval in ms (default 30000)
 *   TIMEOUT         Overall timeout in ms (default 600000 = 10 min)
 */

import { rmSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// 1. Validate environment
// ---------------------------------------------------------------------------
const requiredEnv = [
  "IMAP_HOST",
  "IMAP_USERNAME",
  "IMAP_PASSWORD",
  "SMTP_HOST",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "SMTP_PORT",
];

const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error("Error: Missing required environment variables:");
  missing.forEach((key) => {
    console.error(`  ${key}`);
    return;
  });
  console.error(
    "\nSet these in your shell or .env file:\n  export " +
      missing.join("=...\n  export ") +
      "=...\n",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Configuration
// ---------------------------------------------------------------------------
const SAILDOCS_EMAIL = process.env.SAILDOCS_EMAIL || "query@saildocs.com";
// Small Baltic Sea wind query — fast response, minimal data.
const SAILDOCS_QUERY =
  process.env.SAILDOCS_QUERY || "gfs:58n,60n,018e,022e|2,2|0,12|wind";
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "30000", 10);
const TIMEOUT = parseInt(process.env.TIMEOUT || "600000", 10);
const IMAP_PORT = parseInt(process.env.IMAP_PORT || "993", 10);
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10);
const DB_PATH = "/tmp/saildocs-runner.db";

console.log("=== Saildocs E2E Test Configuration ===");
console.log(`Saildocs query: ${SAILDOCS_QUERY}`);
console.log(`Saildocs email: ${SAILDOCS_EMAIL}`);
console.log(
  `IMAP:  ${process.env.IMAP_USERNAME}@${process.env.IMAP_HOST}:${IMAP_PORT}`,
);
console.log(
  `SMTP:  ${process.env.SMTP_USERNAME}@${process.env.SMTP_HOST}:${SMTP_PORT}`,
);
console.log(
  `Poll interval: ${POLL_INTERVAL / 1000}s, timeout: ${TIMEOUT / 1000}s`,
);
console.log("");

// ---------------------------------------------------------------------------
// 3. Database (file-based so GribFetcher and this script share state)
// ---------------------------------------------------------------------------
rmSync(DB_PATH, { force: true });
const DatabaseHelper = require("../lib/DbHelper.js");
const db = new DatabaseHelper(DB_PATH);
db.initialize();

// The assembly message that GribFetcher will process. `replyTo` is the cloud's
// own address — Saildocs replies to the sender, so we set it to our IMAP/SMTP
// account so the response lands in the mailbox we poll.
const assemblyMsg = {
  errors: [],
  identityHash: "RUNNER_TEST",
  replyTo: process.env.IMAP_USERNAME,
  channel: "test",
  intent: "GRIB",
  payload: `send ${SAILDOCS_EMAIL}:${SAILDOCS_QUERY}`,
};

// ---------------------------------------------------------------------------
// 4. Build NoFlo graph
// ---------------------------------------------------------------------------
const noflo = require("noflo");
const graph = noflo.graph.createGraph("saildocs");

// --- Send path ---
graph.addNode("GribFetcher", "GribFetcher");
graph.addNode("SmtpSender", "SmtpResponder");
// core/Drop absorbs the out/error IPs so the sockets exist and the script
// can listen on them. Without a downstream connection, NoFlo drops the data
// silently and SMTP failures go unnoticed.
graph.addNode("SmtpDrop", "core/Drop");
graph.addNode("SmtpErrDrop", "core/Drop");
graph.addEdge("GribFetcher", "outbox", "SmtpSender", "in");
graph.addEdge("SmtpSender", "out", "SmtpDrop", "in");
graph.addEdge("SmtpSender", "error", "SmtpErrDrop", "in");

// --- Receive path ---
graph.addNode("Timer", "core/RunInterval");
graph.addNode("Fetcher", "ImapFetcher");
graph.addNode("Acker", "ImapAcker");
graph.addEdge("Timer", "out", "Fetcher", "in");
graph.addEdge("Fetcher", "out", "Acker", "in");

// --- IIPs: SmtpSender control ports (MUST be before GribFetcher's data) ---
// SmtpResponder's handle() reads control ports with hasData(), falling back
// to the default port 587 if they haven't arrived. If GribFetcher's OUTBOX
// data reaches SmtpSender.in before the smtp_port IIP, SmtpSender uses the
// wrong port (587 plaintext instead of 465 TLS) and the send fails with 554.
// NoFlo delivers IIPs in addInitial order, so add control ports first.
graph.addInitial(process.env.SMTP_HOST, "SmtpSender", "smtp_host");
graph.addInitial(SMTP_PORT, "SmtpSender", "smtp_port");
graph.addInitial(process.env.SMTP_USERNAME, "SmtpSender", "smtp_user");
graph.addInitial(process.env.SMTP_PASSWORD, "SmtpSender", "smtp_pass");

// --- IIPs: GribFetcher (data IIPs last, so SmtpSender controls arrive first) ---
graph.addInitial(DB_PATH, "GribFetcher", "dbpath");
graph.addInitial(assemblyMsg, "GribFetcher", "in");

// --- IIPs: ImapFetcher ---
graph.addInitial(process.env.IMAP_HOST, "Fetcher", "host");
graph.addInitial(IMAP_PORT, "Fetcher", "port");
graph.addInitial(process.env.IMAP_USERNAME, "Fetcher", "username");
graph.addInitial(process.env.IMAP_PASSWORD, "Fetcher", "password");
graph.addInitial(process.env.IMAP_MAILBOX || "INBOX", "Fetcher", "mailbox");

// --- IIPs: ImapAcker (same IMAP config) ---
graph.addInitial(process.env.IMAP_HOST, "Acker", "host");
graph.addInitial(IMAP_PORT, "Acker", "port");
graph.addInitial(process.env.IMAP_USERNAME, "Acker", "username");
graph.addInitial(process.env.IMAP_PASSWORD, "Acker", "password");
graph.addInitial(process.env.IMAP_MAILBOX || "INBOX", "Acker", "mailbox");

// --- IIPs: Timer ---
graph.addInitial(POLL_INTERVAL, "Timer", "interval");
graph.addInitial(true, "Timer", "start");

// ---------------------------------------------------------------------------
// 5. State
// ---------------------------------------------------------------------------
let queryId = null;
let sendConfirmed = false;
const sendTime = Date.now();
const processedUids = new Set();
let finished = false;

// ---------------------------------------------------------------------------
// 6. MIME / GRIB validation helpers
// ---------------------------------------------------------------------------
//
// The GRIB-from-MIME extraction logic lives in lib/GribMime.js and is shared
// with components/SaildocsMatcher.js (the production graph path) so the two
// can't drift apart.
const { extractGribFromMime } = require("../lib/GribMime.js");

/**
 * Validate a Saildocs response email.
 *
 * @param {Object} email - Parsed email from ImapFetcher
 * @returns {{ valid: boolean, type: string, details: string, gribSize?: number }}
 */
function validateSaildocsResponse(email) {
  const sender = (email.from?.address || "").toLowerCase();
  if (!sender.endsWith("@saildocs.com")) {
    return { valid: false, type: "ignore", details: "not from saildocs" };
  }

  // Try to extract GRIB attachment from raw MIME.
  if (email.raw) {
    const grib = extractGribFromMime(email.raw);
    if (grib) {
      return {
        valid: true,
        type: "grib",
        details: `GRIB data (${grib.data.length} bytes)`,
        gribSize: grib.data.length,
      };
    }
  }

  // No GRIB attachment — check body for error/info text.
  const body = (email.body || "").trim();
  if (body.length > 0) {
    const lower = body.toLowerCase();
    if (
      lower.includes("error") ||
      lower.includes("invalid") ||
      lower.includes("no data") ||
      lower.includes("not available") ||
      lower.includes("sorry")
    ) {
      return {
        valid: true,
        type: "error",
        details: body.substring(0, 200),
      };
    }
    // Got a text response that isn't clearly an error — still valid,
    // Saildocs may send acknowledgements or usage info.
    return {
      valid: true,
      type: "text",
      details: body.substring(0, 200),
    };
  }

  return { valid: false, type: "empty", details: "empty body, no attachment" };
}

// ---------------------------------------------------------------------------
// 7. Start network
// ---------------------------------------------------------------------------
noflo
  .createNetwork(graph, { subscribeGraph: false })
  .then((network) => {
    console.log("=== Network started ===");

    network.on("process-error", (error) => {
      console.error("[Process Error]:", error.error?.message || error.message);
    });

    // --- Read queryId from the shared DB ---
    // GribFetcher processes its IIPs during createNetwork (before this .then()
    // runs), so by the time we attach the 'ip' listener the GribFetcher→SmtpSender
    // packet has already flowed. We read the queryId from the DB instead.
    const pending = db.all(
      "SELECT * FROM pending_saildocs ORDER BY created_at DESC LIMIT 1",
    );
    if (pending.length > 0) {
      queryId = pending[0].query_id;
      console.log(`[GribFetcher] Request queued, queryId: ${queryId}`);
      console.log(
        `  DB: reply_to=${pending[0].reply_to}, channel=${pending[0].channel}`,
      );
    }

    // --- Monitor all packet flow via the network 'ip' event ---
    // NoFlo's OutPort doesn't forward socket 'data' events to port listeners
    // (only InPort does), so `outPorts.X.on('data')` is dead code. The
    // network-level 'ip' event fires for every packet on every socket,
    // regardless of direction — this is the reliable way to observe flow.
    // The same fix should be applied to ping-pong-runner.js.
    network.on("ip", (packet) => {
      if (finished || packet.type !== "data") return;
      const from = packet.socket.from
        ? `${packet.socket.from.process.id}.${packet.socket.from.port}`
        : "?";
      const to = packet.socket.to
        ? `${packet.socket.to.process.id}.${packet.socket.to.port}`
        : "?";
      const data = packet.data;

      // SmtpSender -> Drop: send confirmed (pass-through of the original msg).
      // Guard against duplicate: with the old async handle, NoFlo called
      // sendDone twice (explicit + Promise resolution), causing a null packet
      // on 'out'. The sync handle fix eliminates this, but keep the guard
      // so a regression is immediately visible (only one “Request sent”).
      if (from === "SmtpSender.out") {
        if (sendConfirmed) return; // duplicate — ignore
        sendConfirmed = true;
        console.log("[SmtpSender] Request sent to Saildocs ✓");
        console.log("[SmtpSender] Waiting for response...");
        return;
      }

      // SmtpSender.error -> Drop: send failed.
      if (from === "SmtpSender.error") {
        console.error("[SmtpSender] SMTP send FAILED:");
        if (data?.errors) {
          data.errors.forEach((e) => {
            console.error(`  - ${e.message}`);
            return;
          });
        }
        shutdown(1);
        return;
      }

      // Fetcher -> Acker: an incoming email from IMAP.
      if (from === "Fetcher.out" && to === "Acker.in") {
        const email = data;
        if (!email || processedUids.has(email.imapUid)) return;
        processedUids.add(email.imapUid);

        const sender = (email.from?.address || "").toLowerCase();
        if (!sender.endsWith("@saildocs.com")) return;

        console.log(
          `[ImapFetcher] Saildocs response: uid=${email.imapUid}, subject="${email.subject}"`,
        );

        // Try to match by queryId in subject.
        if (queryId && email.subject?.includes(queryId)) {
          console.log(`[Validate] Subject matches queryId: ${queryId}`);
        } else if (queryId) {
          console.log(
            "[Validate] Subject doesn't contain queryId — accepting by sender+time",
          );
        }

        const result = validateSaildocsResponse(email);
        if (result.valid) {
          finished = true;
          console.log("");
          console.log("╔══════════════════════════════════════════╗");
          console.log("║     ✅  SAILDOCS E2E TEST PASSED          ║");
          console.log("╚══════════════════════════════════════════╝");
          console.log(`Response type: ${result.type}`);
          console.log(`Details: ${result.details}`);
          if (result.gribSize) {
            console.log(`GRIB size: ${result.gribSize} bytes`);
          }
          const elapsed = ((Date.now() - sendTime) / 1000).toFixed(1);
          console.log(`Round-trip time: ${elapsed}s`);

          if (queryId) {
            db.deletePendingSaildocs(queryId);
            console.log(
              `[Cleanup] Deleted pending_saildocs entry for ${queryId}`,
            );
          }
          shutdown(0);
        } else if (result.type !== "ignore") {
          console.log(`[Validate] Not yet a valid response (${result.type})`);
        }
      }
    });

    console.log("");
    console.log("Waiting for Saildocs response...");
    console.log(
      `(timeout: ${TIMEOUT / 1000}s, poll: every ${POLL_INTERVAL / 1000}s)`,
    );
    console.log("");

    // --- Timeout ---
    setTimeout(() => {
      if (!finished) {
        console.error("");
        console.error("╔══════════════════════════════════════════╗");
        console.error("║     ❌  SAILDOCS E2E TEST TIMED OUT       ║");
        console.error("╚══════════════════════════════════════════╝");
        console.error(`No valid response after ${TIMEOUT / 1000}s`);
        if (queryId) {
          console.error(`queryId: ${queryId}`);
        } else {
          console.error(
            "No queryId was generated — GribFetcher may have failed.",
          );
        }
        console.error(
          "Check your IMAP mailbox manually for @saildocs.com messages.",
        );
        shutdown(1);
      }
    }, TIMEOUT);
  })
  .catch((err) => {
    console.error("[Startup Error]:", err.message);
    console.error(err.stack);
    shutdown(1);
  });

// ---------------------------------------------------------------------------
// 8. Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(code) {
  finished = true;
  console.log("\nShutting down...");
  try {
    db.close();
  } catch {
    // Ignore close errors.
  }
  rmSync(DB_PATH, { force: true });
  process.exit(code);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
process.on("unhandledRejection", (reason) => {
  console.error("[Unhandled Rejection]:", reason);
});
