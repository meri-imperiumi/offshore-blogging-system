#!/usr/bin/env node

/**
 * Ping-Pong Test Runner
 * 
 * Basic end-to-end test for InReach communication using NoFlo
 *
 * Flow: RunInterval -> ImapFetcher -> AuthVerifier -> PongHandler -> InReachSender -> ImapAcker
 *
 * The boat sends a "PING" message from its InReach device. The cloud
 * receives it via IMAP, verifies the sender, responds with "PONG".
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Validate environment variables
const requiredEnv = [
  "IMAP_HOST",
  "IMAP_USERNAME",
  "IMAP_PASSWORD",
  "INREACH_REPLY_ADDRESS",
];

const missing = requiredEnv.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error("Error: Missing required environment variables:");
  missing.forEach((key) => console.error(`  ${key}`));
  console.error("\nSet these in your shell or .env file:");
  console.error(`  export ${missing.join("=...\n  export ")}=...\n`);
  process.exit(1);
}

// For testing, also check device mapping
if (!process.env.TEST_DEVICE_ID || !process.env.TEST_IDENTITY_HASH) {
  console.warn("Warning: TEST_DEVICE_ID and TEST_IDENTITY_HASH not set");
  console.warn("Incoming InReach messages will be rejected as unknown devices");
  console.log("");
}

console.log("=== Ping-Pong Test Configuration ===");
console.log(`IMAP Host: ${process.env.IMAP_HOST}`);
console.log(`IMAP Port: ${process.env.IMAP_PORT || 993}`);
console.log(`IMAP Username: ${process.env.IMAP_USERNAME}`);
console.log(`IMAP Mailbox: ${process.env.IMAP_MAILBOX || "INBOX"}`);
console.log(`InReach Reply: ${process.env.INREACH_REPLY_ADDRESS}`);

if (process.env.TEST_DEVICE_ID) {
  console.log(`Test Device: ${process.env.TEST_DEVICE_ID}`);
}

console.log("");

// Initialize database
const DatabaseHelper = require("../lib/DbHelper.js");
const db = new DatabaseHelper(":memory:");
db.initialize();

// Register test device
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

// Load NoFlo
const noflo = require("noflo");

// Create graph programmatically
const graph = noflo.graph.createGraph("ping-pong");

// Add nodes
graph.addNode("Fetcher", "ImapFetcher");
graph.addNode("Verifier", "AuthVerifier");
graph.addNode("PongHandler", "PongHandler");
graph.addNode("Sender", "InReachSender");
graph.addNode("Acker", "ImapAcker");

// core/RunInterval: emits a bang every N ms to trigger a fetch cycle
graph.addNode("Timer", "core/RunInterval");

// core/ReadEnv nodes: each reads one env var and fans out to Fetcher + Acker
graph.addNode("HostEnv", "core/ReadEnv");
graph.addNode("PortEnv", "core/ReadEnv");
graph.addNode("UserEnv", "core/ReadEnv");
graph.addNode("PassEnv", "core/ReadEnv");
graph.addNode("MailboxEnv", "core/ReadEnv");

// Add edges
graph.addEdge("Timer", "out", "Fetcher", "in");
graph.addEdge("Fetcher", "out", "Verifier", "in");
graph.addEdge("Verifier", "out", "PongHandler", "in");
graph.addEdge("PongHandler", "out", "Sender", "in");
graph.addEdge("Sender", "out", "Acker", "in");

// ReadEnv -> Fetcher + Acker (single source, fanned out)
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

// Add IIPs (Initial Information Packets)
graph.addInitial("IMAP_HOST", "HostEnv", "key");
graph.addInitial("IMAP_PORT", "PortEnv", "key");
graph.addInitial("IMAP_USERNAME", "UserEnv", "key");
graph.addInitial("IMAP_PASSWORD", "PassEnv", "key");
graph.addInitial("IMAP_MAILBOX", "MailboxEnv", "key");
// RunInterval: 15s poll cycle (ms). start bang kicks it off.
graph.addInitial(15000, "Timer", "interval");
graph.addInitial(true, "Timer", "start");
graph.addInitial(process.env.INREACH_REPLY_ADDRESS, "Sender", "replyaddress");
graph.addInitial(5000, "Sender", "delayms");

// createNetwork already connects and starts the network
noflo
  .createNetwork(graph, {
    subscribeGraph: false,
  })
  .then((network) => {
    console.log("=== Network started ===");

    // Subscribe to network-level errors
    network.on("process-error", (error) => {
      console.error("[Process Error]:", error.error?.message || error.message);
    });

    // Get process instances (synchronous, available after connect)
    const verifierProc = network.getNode("Verifier");
    const pongProc = network.getNode("PongHandler");
    const senderProc = network.getNode("Sender");

    // Inject database into AuthVerifier for device lookup
    if (verifierProc && verifierProc.component) {
      verifierProc.component.db = db;
      console.log("[Setup] Injected DB into AuthVerifier");
    }

    // Listen for verified messages from AuthVerifier
    // AuthVerifier only has an `out` port; failures come through with msg.failed
    if (verifierProc && verifierProc.component) {
      verifierProc.component.outPorts.out.on("data", (msg) => {
        if (msg && msg.failed) {
          console.error("[Verifier ERROR] Verification failed");
          if (msg.errors) {
            msg.errors.forEach((e) =>
              console.error(`  - ${e.code || "error"}: ${e.message}`),
            );
          }
          return;
        }
        if (msg && msg.channel === "inreach") {
          console.log(
            `[Verifier] Device: ${msg.identityHash}, Payload: ${String(msg.payload).substring(0, 50)}`,
          );
        }
      });
    }

    // Listen for PONG responses from PongHandler
    // PongHandler only has an `out` port; failures come through with msg.failed
    if (pongProc && pongProc.component) {
      pongProc.component.outPorts.out.on("data", (msg) => {
        if (msg && msg.failed) {
          console.error("[PongHandler ERROR] Could not build PONG");
          if (msg.errors) {
            msg.errors.forEach((e) =>
              console.error(`  - ${e.code || "error"}: ${e.message}`),
            );
          }
          return;
        }
        console.log(`[PongHandler] Sending: ${msg.payload}`);
        if (msg && msg.payload === "PONG") {
          console.log("");
          console.log("=== PING received, PONG sent! ===");
          console.log("Check your InReach device for the PONG message");
          console.log("");
        }
      });
    }

    // Listen for InReachSender output/errors
    // InReachSender has both `out` and `error` ports
    if (senderProc && senderProc.component) {
      senderProc.component.outPorts.out.on("data", (msg) => {
        console.log("[InReachSender] Response sent successfully");
      });
      senderProc.component.outPorts.error.on("data", (msg) => {
        console.error("[InReachSender ERROR]");
        if (msg && msg.errors) {
          msg.errors.forEach((e) =>
            console.error(`  - ${e.code || "error"}: ${e.message}`),
          );
        }
      });
    }

    console.log("Waiting for PING message...");
    console.log("Send 'PING' from your InReach device");
    console.log("");
  })
  .catch((err) => {
    console.error("[Startup Error]:", err.message);
    console.error(err.stack);
    db.close();
    process.exit(1);
  });

// Graceful shutdown
function shutdown() {
  console.log("\nShutting down...");
  db.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Catch unhandled rejections that might crash the process
process.on("unhandledRejection", (reason, promise) => {
  console.error("[Unhandled Rejection]:", reason);
});
process.on("exit", (code) => {
  console.log(`[Process exit] code=${code}`);
});
