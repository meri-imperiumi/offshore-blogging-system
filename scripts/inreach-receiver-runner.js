#!/usr/bin/env node

/**
 * InReachReceiver E2E Test Runner
 *
 * Real NoFlo network test for the chunked blog post round-trip:
 *
 *   Timer → ImapFetcher → AuthVerifier → InReachReceiver
 *        → MessageReassembler → BlogDecoder → ┬ BlogAckBuilder → InReachSender → ImapAcker
 *                                            └ GitPublisher (writes post + watermarked image to disk)
 *
 * What it verifies:
 *   a) Chunks sent from InReach (copy-paste from the Signal K webapp)
 *      are received as separate emails via IMAP
 *   b) InReachReceiver parses the lo-fi chunk header and
 *      MessageReassembler reassembles the full blog post
 *   c) BlogDecoder combines text + image parts and GitPublisher writes
 *      the markdown and the watermarked image(s) to an output directory
 *   d) BlogAckBuilder sends a confirmation reply back to the InReach device
 *
 * Disk writing only — GitPublisher is pointed at a plain temp directory
 * (not a git work tree), so no commit/push happens. Blog posts without
 * pictures (text-only variant, no image markdown) complete immediately and
 * write just the markdown file.
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
  });
  console.error("\nSet these in your shell or .env file:");
  console.error(`  export ${missing.join("=...\n  export ")}=...\n`);
  process.exit(1);
}

if (!process.env.TEST_DEVICE_ID || !process.env.TEST_IDENTITY_HASH) {
  console.warn("Warning: TEST_DEVICE_ID and TEST_IDENTITY_HASH not set");
  console.warn("Incoming InReach messages will be rejected as unknown devices");
  console.log("");
}

console.log("=== InReachReceiver E2E Test Configuration ===");
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

// Output directory where decoded blog posts (markdown + watermarked images)
// are written to disk. Plain directory (not a git repo), so GitPublisher
// skips commit/push and just writes files — disk writing only for now.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-blog-out-"));
console.log(`Writing decoded blog posts to: ${outputDir}`);
console.log("");

import { createNodeModulesRegistry } from "@noflo/loader-node";
// Load NoFlo
import { createNetwork, GraphModel } from "@noflo/noflo";

// Create graph programmatically
const graph = new GraphModel({ name: "inreach-receiver-e2e" });

// Add nodes
graph.addNode({ entity_id: "Timer", component: "core/RunInterval" });
graph.addNode({ entity_id: "Fetcher", component: "ImapFetcher" });
graph.addNode({ entity_id: "Verifier", component: "AuthVerifier" });
graph.addNode({ entity_id: "Receiver", component: "InReachReceiver" });
graph.addNode({ entity_id: "Reassembler", component: "MessageReassembler" });
graph.addNode({ entity_id: "Decoder", component: "BlogDecoder" });
graph.addNode({ entity_id: "AckBuilder", component: "BlogAckBuilder" });
graph.addNode({ entity_id: "Sender", component: "InReachSender" });
graph.addNode({ entity_id: "Publisher", component: "GitPublisher" });
graph.addNode({ entity_id: "Acker", component: "ImapAcker" });

// core/ReadEnv nodes for IMAP credentials
graph.addNode({ entity_id: "HostEnv", component: "core/ReadEnv" });
graph.addNode({ entity_id: "PortEnv", component: "core/ReadEnv" });
graph.addNode({ entity_id: "UserEnv", component: "core/ReadEnv" });
graph.addNode({ entity_id: "PassEnv", component: "core/ReadEnv" });
graph.addNode({ entity_id: "MailboxEnv", component: "core/ReadEnv" });

// Add edges — main pipeline
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
  to: { node: "Receiver", port: "in" },
});
graph.addEdge({
  from: { node: "Receiver", port: "out" },
  to: { node: "Reassembler", port: "in" },
});
graph.addEdge({
  from: { node: "Reassembler", port: "out" },
  to: { node: "Decoder", port: "in" },
});
// Buffered (incomplete) chunks go straight to ImapAcker so their emails
// are marked as seen — each chunk's delivery job is done once it's buffered.
graph.addEdge({
  from: { node: "Reassembler", port: "buffered" },
  to: { node: "Acker", port: "in" },
});
// A complete part that BlogDecoder is still holding while waiting for its
// siblings (e.g. text arrived, images not yet) is acked here too — its
// email delivered a valid complete part, so it shouldn't be re-fetched.
graph.addEdge({
  from: { node: "Decoder", port: "buffered" },
  to: { node: "Acker", port: "in" },
});
graph.addEdge({
  from: { node: "Decoder", port: "out" },
  to: { node: "AckBuilder", port: "in" },
});
// Decoder also feeds GitPublisher, which writes the post + watermarked
// image(s) to the output directory (disk writing only, no git ops).
graph.addEdge({
  from: { node: "Decoder", port: "out" },
  to: { node: "Publisher", port: "in" },
});
graph.addEdge({
  from: { node: "AckBuilder", port: "out" },
  to: { node: "Sender", port: "in" },
});
graph.addEdge({
  from: { node: "Sender", port: "out" },
  to: { node: "Acker", port: "in" },
});
// GitPublisher's confirmation drains to ImapAcker.
graph.addEdge({
  from: { node: "Publisher", port: "out" },
  to: { node: "Acker", port: "in" },
});

// ReadEnv -> Fetcher + Acker
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

// Add IIPs
graph.addIIP({ to: { node: "HostEnv", port: "key" }, data: "IMAP_HOST" });
graph.addIIP({ to: { node: "PortEnv", port: "key" }, data: "IMAP_PORT" });
graph.addIIP({ to: { node: "UserEnv", port: "key" }, data: "IMAP_USERNAME" });
graph.addIIP({ to: { node: "PassEnv", port: "key" }, data: "IMAP_PASSWORD" });
graph.addIIP({ to: { node: "MailboxEnv", port: "key" }, data: "IMAP_MAILBOX" });
graph.addIIP({ to: { node: "Timer", port: "interval" }, data: 15000 });
graph.addIIP({ to: { node: "Timer", port: "start" }, data: true });
graph.addIIP({
  to: { node: "Sender", port: "replyaddress" },
  data: process.env.INREACH_REPLY_ADDRESS,
});
graph.addIIP({ to: { node: "Sender", port: "delayms" }, data: 5000 });
graph.addIIP({ to: { node: "Publisher", port: "repo_path" }, data: outputDir });
graph.addIIP({ to: { node: "Publisher", port: "push" }, data: false });

const registry = await createNodeModulesRegistry(
  path.resolve(import.meta.dirname, ".."),
);

createNetwork(graph, { registry })
  .then((network) => {
    console.log("=== Network started ===");
    console.log("");

    network.addEventListener("process-error", (event) => {
      const error = event.detail;
      console.error("[Process Error]:", error.error?.message || error.message);
    });

    // Inject database into AuthVerifier for device lookup
    const verifierProc = network.processes.Verifier;
    if (verifierProc?.component) {
      verifierProc.component.db = db;
      console.log("[Setup] Injected DB into AuthVerifier");
    }

    // Decoder.out is wired to two consumers (AckBuilder + GitPublisher), so
    // the 'ip' event fires twice with the same message reference. Dedup the
    // log line so "Decoded" isn't printed twice.
    const decodedSeen = new WeakSet();

    // Monitor packet flow via the network 'ip' event
    network.addEventListener("ip", (event) => {
      const packet = event.detail;
      if (packet.type !== "data") return;
      const from = packet.socket.from
        ? `${packet.socket.from.process.id}.${packet.socket.from.port}`
        : "?";
      const msg = packet.data;
      if (!msg) return;

      // AuthVerifier -> InReachReceiver: verified email
      if (from === "Verifier.out") {
        if (msg.failed) {
          console.error("[Verifier ERROR] Verification failed");
          if (msg.errors) {
            msg.errors.forEach((e) => {
              console.error(`  - ${e.code || "error"}: ${e.message}`);
            });
          }
          return;
        }
        console.log(
          `[Verifier] Device: ${msg.identityHash}, channel: ${msg.channel}`,
        );
        return;
      }

      // InReachReceiver -> MessageReassembler: parsed chunk
      if (from === "Receiver.out") {
        if (msg.failed) {
          console.error("[Receiver ERROR]", msg.errors?.[0]?.message);
          return;
        }
        console.log(
          `[Receiver] Parsed chunk, payload: ${String(msg.payload).substring(0, 60)}...`,
        );
        return;
      }

      // MessageReassembler -> BlogDecoder: reassembled message (only when complete)
      if (from === "Reassembler.out") {
        if (msg.failed) {
          console.error("[Reassembler ERROR]", msg.errors?.[0]?.message);
          return;
        }
        console.log(
          `[Reassembler] Complete! Reassembled payload: ${String(msg.payload).substring(0, 60)}...`,
        );
        return;
      }

      // MessageReassembler.buffered -> ImapAcker: incomplete chunk acked
      if (from === "Reassembler.buffered") {
        console.log(
          `[Reassembler] Chunk buffered (uid=${msg.imapUid}), acking email`,
        );
        return;
      }

      // BlogDecoder -> ImapAcker (buffered): a complete part that is still
      // waiting for its siblings. Its email can be acked now.
      if (from === "Decoder.buffered") {
        console.log(
          `[Decoder] Part buffered waiting for siblings (uid=${msg.imapUid}), acking email`,
        );
        return;
      }

      // BlogDecoder -> BlogAckBuilder + GitPublisher: decoded blog post
      if (from === "Decoder.out") {
        if (msg.failed) {
          console.error("[Decoder ERROR]", msg.errors?.[0]?.message);
          return;
        }
        if (decodedSeen.has(msg)) return;
        decodedSeen.add(msg);
        const post = msg.payload;
        console.log(
          `[Decoder] Decoded: ${post?.filename}.md ("${post?.title}", postId=${post?.postId})`,
        );
        return;
      }

      // GitPublisher -> ImapAcker: blog post written to disk
      if (from === "Publisher.out") {
        if (msg.errors?.length) {
          console.error(
            "[GitPublisher ERROR]",
            msg.errors[0]?.message || "publish failed",
          );
          return;
        }
        const fullPath = path.join(outputDir, msg.publishedPath || "");
        console.log(
          `[GitPublisher] Wrote ${msg.publishedPath}` +
            (msg.imageCount ? ` + ${msg.imageCount} image(s)` : "") +
            ` -> ${fullPath}`,
        );
        return;
      }

      // BlogAckBuilder -> InReachSender: confirmation reply
      if (from === "AckBuilder.out") {
        console.log(`[AckBuilder] Reply: ${msg.payload}`);
        return;
      }

      // InReachSender -> ImapAcker: reply sent
      if (from === "Sender.out") {
        console.log("[InReachSender] Confirmation sent successfully!");
        console.log("");
        console.log("=== Blog post round-trip complete! ===");
        console.log("Check your InReach device for the confirmation message");
        console.log("");
        return;
      }

      // InReachSender error
      if (from === "Sender.error") {
        console.error("[InReachSender ERROR]");
        if (msg.errors) {
          msg.errors.forEach((e) => {
            console.error(`  - ${e.code || "error"}: ${e.message}`);
          });
        }
        return;
      }

      // ImapAcker -> done
      if (from === "Acker.out") {
        console.log("[ImapAcker] Email marked as read");
        return;
      }
    });

    console.log("Waiting for InReach messages with lo-fi chunks...");
    console.log(
      "Send chunks from your InReach device (copy-paste from webapp)",
    );
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

process.on("unhandledRejection", (reason, _promise) => {
  console.error("[Unhandled Rejection]:", reason);
});
