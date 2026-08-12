#!/usr/bin/env node

/**
 * List registered InReach devices from cloud database.
 *
 * Usage:
 *   node scripts/list-devices.js
 *
 * Environment variables:
 *   CLOUD_DB_PATH  SQLite database path (required)
 */

const DatabaseHelper = require("../lib/DbHelper");
const fs = require("node:fs");

function main() {
  const dbPath = process.env.CLOUD_DB_PATH;

  if (!dbPath) {
    console.error("Error: CLOUD_DB_PATH environment variable is required");
    process.exit(1);
  }

  if (!fs.existsSync(dbPath)) {
    console.error(`Error: Database file not found: ${dbPath}`);
    process.exit(1);
  }

  try {
    const db = new DatabaseHelper(dbPath);
    db.initialize();

    const devices = db.db.prepare("SELECT * FROM inreach_devices ORDER BY bounce_token").all();

    if (devices.length === 0) {
      console.log("No devices registered.");
    } else {
      console.log("Registered InReach devices:");
      console.log();
      for (const dev of devices) {
        console.log(`  Device ID: ${dev.bounce_token}`);
        console.log(`  IMEI: ${dev.imei}`);
        console.log(`  Identity: ${dev.identity_hash}`);
        console.log(`  Owner: ${dev.owner_name || "N/A"}`);
        console.log(`  Registered: ${new Date(dev.registered_at * 1000).toISOString()}`);
        if (dev.last_seen) {
          console.log(`  Last seen: ${new Date(dev.last_seen * 1000).toISOString()}`);
        }
        console.log();
      }
    }

    db.close();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();