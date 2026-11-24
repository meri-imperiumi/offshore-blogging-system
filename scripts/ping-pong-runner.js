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
  missing.forEach((key) => {
    console.error(`  ${key}`);
    return;
  });
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
import DatabaseHelper from "../lib/DbHelper.js";

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

import path from "node:path";
import { createNodeModulesRegistry } from "@noflo/loader-node";
// Load NoFlo
import { createNetwork, GraphModel } from "@noflo/noflo";

// Create graph programmatically
const graph = new GraphModel({ name: "ping-pong" });

// Add nodes
graph.addNode({ entity_id: "Fetcher", component: "ImapFetcher" });
graph.addNode({ entity_id: "Verifier", component: "AuthVerifier" });
graph.addNode({ entity_id: "PongHandler", component: "PongHandler" });
graph.addNode({ entity_id: "Sender", component: "InReachSender" });
graph.addNode({ entity_id: "Acker", component: "ImapAcker" });

// core/RunInterval: emits a bang every N ms to trigger a fetch cycle
graph.addNode({ entity_id: "Timer", component: "core/RunInterval" });

// core/ReadEnv nodes: each reads one env var and fans out to Fetcher + Acker
graph.addNode({ entity_id: "HostEnv", component: "core/ReadEnv" });
graph.addNode({ entity_id: "PortEnv", component: "core/ReadEnv" });
graph.addNode({ entity_id: "UserEnv", component: "core/ReadEnv" });
graph.addNode({ entity_id: "PassEnv", component: "core/ReadEnv" });
graph.addNode({ entity_id: "MailboxEnv", component: "core/ReadEnv" });

// Add edges
graph.addEdge({
  from: { node: "Timer", port: "out" },
  to: { node: "Fetcher", port: "in" },
});
graph.addEdge({
  from: { node: "Fetcher", port: "out" },
  to: { node: "Verifier", port: "in" },
});
graph.addEdge({
  from: { node: "Verifier", port: "out" },
  to: { node: "PongHandler", port: "in" },
});
graph.addEdge({
  from: { node: "PongHandler", port: "out" },
  to: { node: "Sender", port: "in" },
});
graph.addEdge({
  from: { node: "Sender", port: "out" },
  to: { node: "Acker", port: "in" },
});

// ReadEnv -> Fetcher + Acker (single source, fanned out)
graph.addEdge({
  from: { node: "HostEnv", port: "out" },
  to: { node: "Fetcher", port: "host" },
});
graph.addEdge({
  from: { node: "HostEnv", port: "out" },
  to: { node: "Acker", port: "host" },
});
graph.addEdge({
  from: { node: "PortEnv", port: "out" },
  to: { node: "Fetcher", port: "port" },
});
graph.addEdge({
  from: { node: "PortEnv", port: "out" },
  to: { node: "Acker", port: "port" },
});
graph.addEdge({
  from: { node: "UserEnv", port: "out" },
  to: { node: "Fetcher", port: "username" },
});
graph.addEdge({
  from: { node: "UserEnv", port: "out" },
  to: { node: "Acker", port: "username" },
});
graph.addEdge({
  from: { node: "PassEnv", port: "out" },
  to: { node: "Fetcher", port: "password" },
});
graph.addEdge({
  from: { node: "PassEnv", port: "out" },
  to: { node: "Acker", port: "password" },
});
graph.addEdge({
  from: { node: "MailboxEnv", port: "out" },
  to: { node: "Fetcher", port: "mailbox" },
});
graph.addEdge({
  from: { node: "MailboxEnv", port: "out" },
  to: { node: "Acker", port: "mailbox" },
});

// Add IIPs (Initial Information Packets)
graph.addIIP({ to: { node: "HostEnv", port: "key" }, data: "IMAP_HOST" });
graph.addIIP({ to: { node: "PortEnv", port: "key" }, data: "IMAP_PORT" });
graph.addIIP({ to: { node: "UserEnv", port: "key" }, data: "IMAP_USERNAME" });
graph.addIIP({ to: { node: "PassEnv", port: "key" }, data: "IMAP_PASSWORD" });
graph.addIIP({ to: { node: "MailboxEnv", port: "key" }, data: "IMAP_MAILBOX" });
// RunInterval: 15s poll cycle (ms). start bang kicks it off.
graph.addIIP({ to: { node: "Timer", port: "interval" }, data: 15000 });
graph.addIIP({ to: { node: "Timer", port: "start" }, data: true });
graph.addIIP({
  to: { node: "Sender", port: "replyaddress" },
  data: process.env.INREACH_REPLY_ADDRESS,
});
graph.addIIP({ to: { node: "Sender", port: "delayms" }, data: 5000 });

// createNetwork already connects and starts the network
const registry = await createNodeModulesRegistry(
  path.resolve(import.meta.dirname, ".."),
);

createNetwork(graph, { registry })
  .then((network) => {
    console.log("=== Network started ===");

    // Subscribe to network-level errors
    network.addEventListener("process-error", (event) => {
      const error = event.detail;
      console.error("[Process Error]:", error.error?.message || error.message);
    });

    // Get process instances (synchronous, available after connect)
    const verifierProc = network.processes.Verifier;

    // Inject database into AuthVerifier for device lookup
    if (verifierProc?.component) {
      verifierProc.component.db = db;
      console.log("[Setup] Injected DB into AuthVerifier");
    }

    // Monitor packet flow via the network 'ip' event.
    //
    // NoFlo's OutPort doesn't forward socket 'data' events to port listeners
    // (only InPort does), so `outPorts.X.on('data')` never fires — the
    // previous per-port listeners were dead code. The network-level 'ip'
    // event fires for every packet on every socket, so we route all
    // monitoring through a single handler that dispatches by source node.
    network.addEventListener("ip", (event) => {
      const packet = event.detail;
      if (packet.type !== "data") return;
      const from = packet.socket.from
        ? `${packet.socket.from.process.id}.${packet.socket.from.port}`
        : "?";
      const _to = packet.socket.to
        ? `${packet.socket.to.process.id}.${packet.socket.to.port}`
        : "?";
      const msg = packet.data;
      if (!msg) return;

      // AuthVerifier -> PongHandler: verified (or failed) InReach message.
      if (from === "Verifier.out") {
        if (msg.failed) {
          console.error("[Verifier ERROR] Verification failed");
          if (msg.errors) {
            msg.errors.forEach((e) => {
              console.error(`  - ${e.code || "error"}: ${e.message}`);
              return;
            });
          }
          return;
        }
        if (msg.channel === "inreach") {
          console.log(
            `[Verifier] Device: ${msg.identityHash}, Payload: ${String(msg.payload).substring(0, 50)}`,
          );
        }
        return;
      }

      // PongHandler -> InReachSender: the PONG reply.
      if (from === "PongHandler.out") {
        if (msg.failed) {
          console.error("[PongHandler ERROR] Could not build PONG");
          if (msg.errors) {
            msg.errors.forEach((e) => {
              console.error(`  - ${e.code || "error"}: ${e.message}`);
              return;
            });
          }
          return;
        }
        console.log(`[PongHandler] Sending: ${msg.payload}`);
        if (msg.payload === "PONG") {
          console.log("");
          console.log("=== PING received, PONG sent! ===");
          console.log("Check your InReach device for the PONG message");
          console.log("");
        }
        return;
      }

      // InReachSender -> ImapAcker: send succeeded.
      if (from === "Sender.out") {
        console.log("[InReachSender] Response sent successfully");
        return;
      }

      // InReachSender.error: send failed.
      if (from === "Sender.error") {
        console.error("[InReachSender ERROR]");
        if (msg.errors) {
          msg.errors.forEach((e) => {
            console.error(`  - ${e.code || "error"}: ${e.message}`);
            return;
          });
        }
        return;
      }
    });

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
process.on("unhandledRejection", (reason, _promise) => {
  console.error("[Unhandled Rejection]:", reason);
});
process.on("exit", (code) => {
  console.log(`[Process exit] code=${code}`);
});
