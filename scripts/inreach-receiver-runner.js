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

// Output directory where decoded blog posts (markdown + watermarked images)
// are written to disk. Plain directory (not a git repo), so GitPublisher
// skips commit/push and just writes files — disk writing only for now.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-blog-out-"));
console.log(`Writing decoded blog posts to: ${outputDir}`);
console.log("");

// Load NoFlo
const noflo = require("noflo");

// Create graph programmatically
const graph = noflo.graph.createGraph("inreach-receiver-e2e");

// Add nodes
graph.addNode("Timer", "core/RunInterval");
graph.addNode("Fetcher", "ImapFetcher");
graph.addNode("Verifier", "AuthVerifier");
graph.addNode("Receiver", "InReachReceiver");
graph.addNode("Reassembler", "MessageReassembler");
graph.addNode("Decoder", "BlogDecoder");
graph.addNode("AckBuilder", "BlogAckBuilder");
graph.addNode("Sender", "InReachSender");
graph.addNode("Publisher", "GitPublisher");
graph.addNode("Acker", "ImapAcker");

// core/ReadEnv nodes for IMAP credentials
graph.addNode("HostEnv", "core/ReadEnv");
graph.addNode("PortEnv", "core/ReadEnv");
graph.addNode("UserEnv", "core/ReadEnv");
graph.addNode("PassEnv", "core/ReadEnv");
graph.addNode("MailboxEnv", "core/ReadEnv");

// Add edges — main pipeline
graph.addEdge("Timer", "out", "Fetcher", "in");
graph.addEdge("Fetcher", "out", "Verifier", "in");
graph.addEdge("Verifier", "out", "Receiver", "in");
graph.addEdge("Receiver", "out", "Reassembler", "in");
graph.addEdge("Reassembler", "out", "Decoder", "in");
// Buffered (incomplete) chunks go straight to ImapAcker so their emails
// are marked as seen — each chunk's delivery job is done once it's buffered.
graph.addEdge("Reassembler", "buffered", "Acker", "in");
// A complete part that BlogDecoder is still holding while waiting for its
// siblings (e.g. text arrived, images not yet) is acked here too — its
// email delivered a valid complete part, so it shouldn't be re-fetched.
graph.addEdge("Decoder", "buffered", "Acker", "in");
graph.addEdge("Decoder", "out", "AckBuilder", "in");
// Decoder also feeds GitPublisher, which writes the post + watermarked
// image(s) to the output directory (disk writing only, no git ops).
graph.addEdge("Decoder", "out", "Publisher", "in");
graph.addEdge("AckBuilder", "out", "Sender", "in");
graph.addEdge("Sender", "out", "Acker", "in");
// GitPublisher's confirmation drains to ImapAcker.
graph.addEdge("Publisher", "out", "Acker", "in");

// ReadEnv -> Fetcher + Acker
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

// Add IIPs
graph.addInitial("IMAP_HOST", "HostEnv", "key");
graph.addInitial("IMAP_PORT", "PortEnv", "key");
graph.addInitial("IMAP_USERNAME", "UserEnv", "key");
graph.addInitial("IMAP_PASSWORD", "PassEnv", "key");
graph.addInitial("IMAP_MAILBOX", "MailboxEnv", "key");
graph.addInitial(15000, "Timer", "interval");
graph.addInitial(true, "Timer", "start");
graph.addInitial(process.env.INREACH_REPLY_ADDRESS, "Sender", "replyaddress");
graph.addInitial(5000, "Sender", "delayms");
graph.addInitial(outputDir, "Publisher", "repo_path");
graph.addInitial(false, "Publisher", "push");

noflo
  .createNetwork(graph, {
    subscribeGraph: false,
  })
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

    // Decoder.out is wired to two consumers (AckBuilder + GitPublisher), so
    // the 'ip' event fires twice with the same message reference. Dedup the
    // log line so "Decoded" isn't printed twice.
    const decodedSeen = new WeakSet();

    // Monitor packet flow via the network 'ip' event
    network.on("ip", (packet) => {
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
