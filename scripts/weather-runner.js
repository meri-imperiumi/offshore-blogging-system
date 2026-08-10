#!/usr/bin/env node

/**
 * InReach Weather E2E Test Runner
 *
 * Real end-to-end test for the InReach weather fetch round-trip:
 *
 *   1. User sends a weather request from InReach (e.g.
 *      "send query@saildocs.com:gfs:58n,60n,018e,022e|2,2|0,12|wind")
 *   2. Cloud receives it via IMAP, forwards the request to Saildocs via SMTP
 *   3. Cloud receives the Saildocs response (GRIB attachment) via IMAP
 *   4. Cloud chunks the GRIB and sends it back to the InReach device
 *   5. User combines the chunks in the Signal K web UI to get a .grb file
 *
 * NoFlo network:
 *
 *   Timer → ImapFetcher → AuthVerifier → InReachReceiver
 *        → MessageReassembler → ParserRouter
 *
 *   ParserRouter OUT[1] (GRIB)     → GribFetcher → SmtpResponder (→ Saildocs)
 *   ParserRouter OUT[2] (SAILDOCS) → SaildocsMatcher → GribChunker → GribGate
 *                                  → ReplyDispatcher → InReachSender (→ device)
 *
 * The same IMAP polling loop handles both the initial InReach request
 * (intent=GRIB) and the asynchronous Saildocs response (intent=SAILDOCS),
 * routed by ParserRouter based on the intent InReachReceiver detects.
 *
 * GribFetcher and SaildocsMatcher share a file-based SQLite database so
 * the pending_saildocs mapping (queryId → original requester's replyTo +
 * channel) survives across the async Saildocs round-trip.
 *
 * Usage:
 *   Set the required environment variables (see below), then run:
 *     node scripts/weather-runner.js
 *
 * Then send a weather request from your InReach device, e.g.:
 *   send query@saildocs.com:gfs:58n,60n,018e,022e|2,2|0,12|wind
 *
 * Environment:
 *   IMAP_HOST, IMAP_USERNAME, IMAP_PASSWORD (IMAP_PORT, IMAP_MAILBOX)
 *   SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD, SMTP_PORT
 *   INREACH_REPLY_ADDRESS  cloud's address shown to the InReach recipient
 *   TEST_DEVICE_ID, TEST_IDENTITY_HASH  (register the test device)
 *   SAILDOCS_QUERY  (optional, override the default query)
 *   POLL_INTERVAL   IMAP poll interval ms (default 15000)
 *   CHUNK_DELAY     delay between InReach chunks ms (default 2000)
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
  "INREACH_REPLY_ADDRESS",
];

const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error("Error: Missing required environment variables:");
  missing.forEach((key) => {
    console.error(`  ${key}`);
  });
  console.error(
    "\nSet these in your shell or .env file:\n  export " +
      missing.join("=...\n  export ") +
      "=...\n",
  );
  process.exit(1);
}

if (!process.env.TEST_DEVICE_ID || !process.env.TEST_IDENTITY_HASH) {
  console.warn("Warning: TEST_DEVICE_ID and TEST_IDENTITY_HASH not set");
  console.warn("Incoming InReach messages will be rejected as unknown devices");
  console.log("");
}

// ---------------------------------------------------------------------------
// 2. Configuration
// ---------------------------------------------------------------------------
const IMAP_PORT = parseInt(process.env.IMAP_PORT || "993", 10);
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10);
const SAILDOCS_EMAIL = process.env.SAILDOCS_EMAIL || "query@saildocs.com";
// Small Baltic Sea wind query — fast response, minimal data, fits in a few
// InReach messages so GribGate passes it through without consent.
const SAILDOCS_QUERY =
  process.env.SAILDOCS_QUERY || "gfs:58n,60n,018e,022e|2,2|0,12|wind";
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "15000", 10);
const CHUNK_DELAY = parseInt(process.env.CHUNK_DELAY || "2000", 10);
const DB_PATH = "/tmp/weather-runner.db";

console.log("=== InReach Weather E2E Test Configuration ===");
console.log(
  `IMAP: ${process.env.IMAP_USERNAME}@${process.env.IMAP_HOST}:${IMAP_PORT}`,
);
console.log(
  `SMTP: ${process.env.SMTP_USERNAME}@${process.env.SMTP_HOST}:${SMTP_PORT}`,
);
console.log(`InReach Reply: ${process.env.INREACH_REPLY_ADDRESS}`);
console.log(`Saildocs query: ${SAILDOCS_QUERY}`);
console.log(
  `Poll interval: ${POLL_INTERVAL / 1000}s, chunk delay: ${CHUNK_DELAY}ms`,
);
if (process.env.TEST_DEVICE_ID) {
  console.log(`Test Device: ${process.env.TEST_DEVICE_ID}`);
}
console.log("");

// ---------------------------------------------------------------------------
// 3. Database (file-based so GribFetcher and SaildocsMatcher share state)
// ---------------------------------------------------------------------------
rmSync(DB_PATH, { force: true });
const DatabaseHelper = require("../lib/DbHelper.js");
const db = new DatabaseHelper(DB_PATH);
db.initialize();

// Register test device so AuthVerifier accepts InReach messages.
if (process.env.TEST_DEVICE_ID && process.env.TEST_IDENTITY_HASH) {
  db.saveInReachDevice(
    process.env.TEST_DEVICE_ID,
    process.env.TEST_IMEI || "test",
    process.env.TEST_IDENTITY_HASH,
    "Test User",
  );
  console.log(`Registered test device: ${process.env.TEST_DEVICE_ID}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// 4. Build NoFlo graph
// ---------------------------------------------------------------------------
const noflo = require("noflo");
const graph = noflo.graph.createGraph("weather-e2e");

// Define ALL nodes first. NoFlo silently drops edges whose endpoints don't
// exist yet, so adding an edge to a not-yet-created node loses it. This bit us
// on the ack path (Reassembler.buffered → Acker was dropped because Acker was
// defined later), causing unacked emails to be re-fetched every poll.
graph.addNode("Timer", "core/RunInterval");
graph.addNode("Fetcher", "ImapFetcher");
graph.addNode("Verifier", "AuthVerifier");
graph.addNode("Receiver", "InReachReceiver");
graph.addNode("Reassembler", "MessageReassembler");
graph.addNode("Router", "ParserRouter");
graph.addNode("GribFetcher", "GribFetcher");
graph.addNode("SmtpSender", "SmtpResponder");
graph.addNode("SaildocsMatcher", "SaildocsMatcher");
graph.addNode("GribChunker", "GribChunker");
graph.addNode("Gate", "GribGate");
graph.addNode("Dispatcher", "ReplyDispatcher");
graph.addNode("InReachSender", "InReachSender");
graph.addNode("Acker", "ImapAcker");
graph.addNode("MissedDrop", "core/Drop");
graph.addNode("ErrorDrop", "core/Drop");
graph.addNode("HostEnv", "core/ReadEnv");
graph.addNode("PortEnv", "core/ReadEnv");
graph.addNode("UserEnv", "core/ReadEnv");
graph.addNode("PassEnv", "core/ReadEnv");
graph.addNode("MailboxEnv", "core/ReadEnv");

// --- Receive path (shared for InReach requests and Saildocs responses) ---
graph.addEdge("Timer", "out", "Fetcher", "in");
graph.addEdge("Fetcher", "out", "Verifier", "in");
graph.addEdge("Verifier", "out", "Receiver", "in");
graph.addEdge("Receiver", "out", "Reassembler", "in");
graph.addEdge("Reassembler", "out", "Router", "in");
// Buffered (incomplete) chunks acked immediately so their emails aren't
// re-fetched on every poll. (Weather requests are plain text and pass
// straight through, but this keeps the graph correct for blog chunks too.)
graph.addEdge("Reassembler", "buffered", "Acker", "in");

// --- GRIB request path: forward to Saildocs via SMTP ---
// ParserRouter's `out` port is addressable (array). OUT[1] = GRIB.
graph.addEdgeIndex("Router", "out", 1, "GribFetcher", "in", null);
// GribFetcher emits the Saildocs outbound email on OUTBOX → SmtpSender
// (which sends it via SMTP). The original InReach request email is acked
// only AFTER the SMTP send succeeds (SmtpSender.out → Acker), not at queue
// time: if SMTP fails, the request email stays unseen and is re-fetched
// on the next poll, retrying the whole request. For a driving-blind user
// it is safer to send the request twice than to ack early and silently
// lose it when SMTP fails. The pending_saildocs DB entry preserves
// request context for the async Saildocs round-trip.
graph.addEdge("GribFetcher", "outbox", "SmtpSender", "in");
graph.addEdge("SmtpSender", "out", "Acker", "in");
// SMTP send failures are dropped here — the request email is NOT acked
// (SmtpSender.out didn't fire), so it stays unseen and is retried next poll.
graph.addEdge("SmtpSender", "error", "ErrorDrop", "in");

// --- SAILDOCS response path: extract GRIB, chunk, send back ---
// Router OUT[2] = SAILDOCS. The `out` port is addressable (array).
graph.addEdgeIndex("Router", "out", 2, "SaildocsMatcher", "in", null);
// SaildocsMatcher.direct → GribChunker (GRIB data path)
graph.addEdge("SaildocsMatcher", "direct", "GribChunker", "in");
// SaildocsMatcher.out → Dispatcher: error responses (no GRIB attachment,
// e.g. Saildocs "HTTP 405" / "command error" replies) carry the error
// text as a NOTIFY payload straight to the user. They bypass GribChunker
// (which is for binary GRIB only). GRIB responses go on `direct` only, so
// there is no double-delivery.
graph.addEdge("SaildocsMatcher", "out", "Dispatcher", "in");
graph.addEdge("GribChunker", "out", "Gate", "in");
graph.addEdge("Gate", "out", "Dispatcher", "in");
graph.addEdge("Gate", "notify", "Dispatcher", "in");
graph.addEdge("Dispatcher", "inreach", "InReachSender", "in");
// InReachSender.out → Acker: the Saildocs response email is acked only
// AFTER the content (GRIB chunks or error text) has been successfully
// delivered to the InReach device. If delivery fails, the email stays
// unseen and is re-fetched on the next poll, retrying the delivery. This
// is the only ack path for Saildocs response emails — we do NOT ack at
// extraction time.
graph.addEdge("InReachSender", "out", "Acker", "in");

// --- NOTIFY path (gate consent prompts, etc.) → ReplyDispatcher ---
// ParserRouter OUT[4] = NOTIFY. Drop into Dispatcher so consent prompts
// reach the user. (Small GRIBs won't trigger this, but keep it correct.)
graph.addEdgeIndex("Router", "out", 4, "Dispatcher", "in", null);

// --- Router error/missed → Drop (logged via ip event) ---
graph.addEdge("Router", "missed", "MissedDrop", "in");
graph.addEdge("Router", "error", "ErrorDrop", "in");

// --- core/ReadEnv nodes for IMAP credentials (fan out to Fetcher + Acker) ---
graph.addEdge("HostEnv", "out", "Fetcher", "host");
graph.addEdge("HostEnv", "out", "Acker", "host");
graph.addEdge("PortEnv", "out", "Fetcher", "port");
graph.addEdge("PortEnv", "out", "Acker", "port");
graph.addEdge("UserEnv", "out", "Fetcher", "username");
graph.addEdge("UserEnv", "out", "Acker", "username");
graph.addEdge("PassEnv", "out", "Fetcher", "password");
graph.addEdge("PassEnv", "out", "Acker", "password");
graph.addEdge("MailboxEnv", "out", "Fetcher", "mailbox");
graph.addEdge("MailboxEnv", "out", "Acker", "mailbox");

// --- IIPs ---
// IMAP config keys
graph.addInitial("IMAP_HOST", "HostEnv", "key");
graph.addInitial("IMAP_PORT", "PortEnv", "key");
graph.addInitial("IMAP_USERNAME", "UserEnv", "key");
graph.addInitial("IMAP_PASSWORD", "PassEnv", "key");
graph.addInitial("IMAP_MAILBOX", "MailboxEnv", "key");

// Timer
graph.addInitial(POLL_INTERVAL, "Timer", "interval");
graph.addInitial(true, "Timer", "start");

// ParserRouter routes
graph.addInitial("BLOG,GRIB,SAILDOCS,SYS,NOTIFY", "Router", "routes");

// SmtpResponder control ports (MUST be before GribFetcher's data — see
// saildocs-runner.js: SmtpResponder falls back to port 587 if the port IIP
// hasn't arrived before the OUTBOX data).
graph.addInitial(process.env.SMTP_HOST, "SmtpSender", "smtp_host");
graph.addInitial(SMTP_PORT, "SmtpSender", "smtp_port");
graph.addInitial(process.env.SMTP_USERNAME, "SmtpSender", "smtp_user");
graph.addInitial(process.env.SMTP_PASSWORD, "SmtpSender", "smtp_pass");

// GribFetcher + SaildocsMatcher + GribGate share the DB
graph.addInitial(DB_PATH, "GribFetcher", "dbpath");
graph.addInitial(DB_PATH, "SaildocsMatcher", "dbpath");
graph.addInitial(DB_PATH, "Gate", "dbpath");

// InReachSender config
graph.addInitial(
  process.env.INREACH_REPLY_ADDRESS,
  "InReachSender",
  "replyaddress",
);
graph.addInitial(CHUNK_DELAY, "InReachSender", "delayms");

// GribChunker chunk size (base64 chars). Must keep the TOTAL InReach
// message (envelope header `msg i/total:grib:<id>\n` + data) under ~120
// chars — Garmin truncates messages around 130-140 chars and splits at the
// 160 hard limit, which corrupts the base64 and breaks reassembly (the
// `atob: invalid character` error). Both reference implementations capped
// at 120 total. 96 + ~23-char header = ~119, safely under budget.
graph.addInitial(96, "GribChunker", "max_chunk_size");
// GribGate threshold: 15 chunks × 96 base64 ≈ 1KB of GRIB before consent is
// required (matches the original 10×140 ≈ 1KB gating point). Lets the test
// GRIB (~800 bytes → 12 chunks at 96) pass through while still gating
// larger, expensive deliveries.
graph.addInitial(15, "Gate", "max_chunks");

// ---------------------------------------------------------------------------
// 5. State tracking
// ---------------------------------------------------------------------------
let requestForwarded = false;
const sendTime = Date.now();

// ---------------------------------------------------------------------------
// 6. Start network
// ---------------------------------------------------------------------------
noflo
  .createNetwork(graph, { subscribeGraph: false })
  .then((network) => {
    console.log("=== Network started ===");
    console.log("");

    network.on("process-error", (error) => {
      console.error("[Process Error]:", error.error?.message || error.message);
    });

    // Inject database into AuthVerifier for device lookup
    const verifierProc = network.getNode("Verifier");
    if (verifierProc?.component) {
      verifierProc.component.db = db;
      console.log("[Setup] Injected DB into AuthVerifier");
    }

    // Monitor packet flow via the network 'ip' event (the only reliable way
    // to observe NoFlo packet flow — see ping-pong-runner.js comment).
    network.on("ip", (packet) => {
      if (packet.type !== "data") return;
      const from = packet.socket.from
        ? `${packet.socket.from.process.id}.${packet.socket.from.port}`
        : "?";
      const msg = packet.data;
      if (!msg) return;

      // AuthVerifier → InReachReceiver: verified email
      if (from === "Verifier.out") {
        if (msg.errors?.length) {
          console.error("[Verifier] Verification failed:");
          msg.errors.forEach((e) => {
            console.error(`  - ${e.code || "error"}: ${e.message}`);
          });
          return;
        }
        if (msg.identityHash === "SYS_SAILDOCS") {
          console.log("[Verifier] Saildocs response received");
        } else {
          console.log(
            `[Verifier] InReach device: ${msg.identityHash}, channel: ${msg.channel}`,
          );
        }
        return;
      }

      // InReachReceiver → MessageReassembler
      if (from === "Receiver.out") {
        console.log(
          `[Receiver] intent=${msg.intent}, payload: ${String(msg.payload).substring(0, 60)}...`,
        );
        return;
      }

      // GribFetcher OUTBOX → SmtpResponder: request queued for Saildocs.
      // The original InReach email is NOT acked here — it's acked only after
      // SmtpSender.out fires (successful SMTP send). If SMTP fails, the
      // email stays unseen and is re-fetched on the next poll (retry).
      if (from === "GribFetcher.outbox") {
        console.log(`[GribFetcher] Request queued for Saildocs: ${msg.to}`);
        const pending = db.all(
          "SELECT * FROM pending_saildocs ORDER BY created_at DESC LIMIT 1",
        );
        if (pending.length > 0) {
          console.log(`[GribFetcher] queryId: ${pending[0].query_id}`);
          console.log(
            `  reply_to=${pending[0].reply_to}, channel=${pending[0].channel}`,
          );
        }
        return;
      }

      // SmtpSender OUT → ImapAcker: SMTP send to Saildocs succeeded. NOW
      // the original InReach request email is acked (marked \Seen). If SMTP
      // had failed, SmtpSender.error would fire instead and the email would
      // stay unseen, triggering a retry on the next poll.
      if (from === "SmtpSender.out") {
        if (msg.imapUid) {
          console.log(
            `[SmtpSender] Sent to Saildocs ✓ — acking request email uid=${msg.imapUid}`,
          );
        }
        if (requestForwarded) return;
        requestForwarded = true;
        console.log("[SmtpSender] Weather request sent to Saildocs ✓");
        console.log("[SmtpSender] Waiting for Saildocs response...");
        console.log("");
        return;
      }

      // SmtpSender error
      if (from === "SmtpSender.error") {
        console.error("[SmtpSender] SMTP send FAILED:");
        msg.errors?.forEach((e) => {
          console.error(`  - ${e.message}`);
        });
        return;
      }

      // SaildocsMatcher.direct → GribChunker: GRIB extracted from response
      if (from === "SaildocsMatcher.direct") {
        const size = Buffer.isBuffer(msg.payload)
          ? msg.payload.length
          : Buffer.byteLength(String(msg.payload || ""));
        console.log(
          `[SaildocsMatcher] GRIB extracted (${size} bytes), ` +
            `restored channel=${msg.channel}, replyTo=${String(msg.replyTo).substring(0, 50)}...`,
        );
        return;
      }

      // SaildocsMatcher.out → Dispatcher: error response (no GRIB
      // attachment). Forwarded to the user as NOTIFY text so they know
      // their request failed, rather than silently dropping it.
      if (from === "SaildocsMatcher.out") {
        console.log(
          `[SaildocsMatcher] Error response forwarded to user: ${String(msg.payload).substring(0, 80)}`,
        );
        return;
      }

      // GribChunker → GribGate: GRIB chunked
      if (from === "GribChunker.out") {
        const n = Array.isArray(msg.payload) ? msg.payload.length : 1;
        console.log(
          `[GribChunker] Split into ${n} chunk(s), partType=${msg.partType}`,
        );
        return;
      }

      // GribGate OUT → ReplyDispatcher: passed through (small enough)
      if (from === "Gate.out") {
        const n = Array.isArray(msg.payload) ? msg.payload.length : 1;
        console.log(`[GribGate] Passed through (${n} chunks, ≤ threshold)`);
        return;
      }

      // GribGate NOTIFY → ReplyDispatcher: consent required
      if (from === "Gate.notify") {
        console.log(`[GribGate] Consent required: ${msg.payload}`);
        return;
      }

      // InReachSender OUT → ImapAcker: content delivered to device.
      // This is the ack point for Saildocs response emails (GRIB chunks OR
      // error text) — the email is marked \Seen only after successful
      // delivery. If delivery fails, it stays unseen and is retried.
      if (from === "InReachSender.out") {
        const elapsed = ((Date.now() - sendTime) / 1000).toFixed(1);
        const n = Array.isArray(msg.payload) ? msg.payload.length : 1;
        console.log(
          `[InReachSender] Delivered ${n} message(s) to InReach device ✓`,
        );
        if (msg.imapUid) {
          console.log(`  Acking Saildocs response email uid=${msg.imapUid}`);
        }
        console.log("");
        console.log("╔══════════════════════════════════════════════╗");
        console.log("║  ✅  INREACH WEATHER E2E ROUND-TRIP COMPLETE  ║");
        console.log("╚══════════════════════════════════════════════╝");
        console.log(`Round-trip time: ${elapsed}s`);
        console.log("");
        console.log("Check your InReach device for the GRIB chunks,");
        console.log("then combine them in the Signal K web UI to get");
        console.log("a downloadable .grb file.");
        console.log("");
        return;
      }

      // InReachSender error
      if (from === "InReachSender.error") {
        console.error("[InReachSender] Send FAILED:");
        msg.errors?.forEach((e) => {
          console.error(`  - ${e.code || "error"}: ${e.message}`);
        });
        return;
      }

      // ImapAcker → done
      if (from === "Acker.out") {
        console.log("[ImapAcker] Email marked as read");
        return;
      }
    });

    console.log("Waiting for InReach weather request...");
    console.log(
      `Send from your InReach device, e.g.: send ${SAILDOCS_EMAIL}:${SAILDOCS_QUERY}`,
    );
    console.log("");
  })
  .catch((err) => {
    console.error("[Startup Error]:", err.message);
    console.error(err.stack);
    shutdown(1);
  });

// ---------------------------------------------------------------------------
// 7. Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(code) {
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
