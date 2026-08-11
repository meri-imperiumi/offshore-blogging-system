#!/usr/bin/env node

/**
 * Cloud server entry point.
 *
 * Loads `graphs/cloud-server.fbp` and runs it as a NoFlo network. All
 * deployment config (credentials, paths) is read from environment variables
 * by core/ReadEnv nodes inside the graph — this script carries no secrets.
 *
 * Required environment variables (see cloud-server.fbp header):
 *   IMAP_USERNAME, IMAP_PASSWORD, SMTP_USERNAME, SMTP_PASSWORD,
 *   CLOUD_DB_PATH, REPO_PATH, INREACH_REPLY_ADDRESS,
 *   ALERT_ADDRESS, LOG_PATH
 *
 * Optional:
 *   CLOUD_GRAPH  override the graph path (default: graphs/cloud-server.fbp)
 *
 * Usage:
 *   node scripts/cloud-server.js
 */

const noflo = require("noflo");
const path = require("node:path");

const GRAPH_PATH = process.env.CLOUD_GRAPH
  ? path.resolve(process.env.CLOUD_GRAPH)
  : path.join(__dirname, "..", "graphs", "cloud-server.fbp");

const REQUIRED_ENV = [
  "IMAP_USERNAME",
  "IMAP_PASSWORD",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "CLOUD_DB_PATH",
  "REPO_PATH",
  "INREACH_REPLY_ADDRESS",
  "ALERT_ADDRESS",
  "LOG_PATH",
];

const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error("cloud-server: missing required environment variables:");
  for (const key of missing) {
    console.error(`  ${key}`);
  }
  console.error(
    "\nThese are read by core/ReadEnv nodes in graphs/cloud-server.fbp.",
  );
  process.exit(1);
}

console.log("cloud-server: loading graph %s", GRAPH_PATH);

noflo.graph
  .loadFile(GRAPH_PATH)
  .then((graph) => noflo.createNetwork(graph, { subscribeGraph: false }))
  .then((network) => {
    network.on("process-error", (err) => {
      console.error(
        "[cloud-server] process-error:",
        err.error?.message || err.message,
      );
    });
    network.on("end", () => {
      console.log("[cloud-server] network ended");
    });
    console.log("[cloud-server] network started");
    console.log("[cloud-server] IMAP polling every 60s; NACK sweep every 15m");
  })
  .catch((err) => {
    console.error("[cloud-server] failed to start:", err.message);
    console.error(err.stack);
    process.exit(1);
  });

process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
