#!/usr/bin/env node

/**
 * Register InReach device in cloud database.
 *
 * Usage:
 *   node scripts/register-device.js <device_id> <imei> <identity_hash> [owner_name]
 *
 * Arguments:
 *   device_id      Device ID from Garmin bounce token (e.g. 2565887)
 *   imei           Device IMEI
 *   identity_hash  Reticulum identity hash
 *   owner_name     Optional owner name
 *
 * Environment variables:
 *   CLOUD_DB_PATH  SQLite database path (required)
 *
 * The command is idempotent: running it multiple times with the same
 * device_id will update the entry rather than create duplicates.
 */

const DatabaseHelper = require("../lib/DbHelper");
const fs = require("node:fs");

function usage() {
  console.error(
    "Usage: node scripts/register-device.js <device_id> <imei> <identity_hash> [owner_name]",
  );
  console.error("Arguments:");
  console.error(
    "  device_id      Device ID from Garmin bounce token (e.g. 2565887)",
  );
  console.error("  imei           Device IMEI");
  console.error("  identity_hash  Reticulum identity hash");
  console.error("  owner_name     Optional owner name");
  console.error("Environment variables:");
  console.error("  CLOUD_DB_PATH  SQLite database path (required)");
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 3 || args.length > 4) {
    usage();
  }

  const [deviceId, imei, identityHash, ownerName] = args;
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

    // Check if device already exists
    const existing = db.getInReachDevice(deviceId);

    if (existing) {
      console.log(`Device ${deviceId} already registered.`);
      console.log(`  IMEI: ${existing.imei}`);
      console.log(`  Identity: ${existing.identity_hash}`);
      console.log(`  Owner: ${existing.owner_name || "N/A"}`);
      console.log(
        `  Registered at: ${new Date(existing.registered_at * 1000).toISOString()}`,
      );
    }

    // Save or update device (idempotent via INSERT OR REPLACE)
    db.saveInReachDevice(deviceId, imei, identityHash, ownerName || null);
    db.close();

    if (existing) {
      console.log(`Device ${deviceId} updated.`);
    } else {
      console.log(`Device ${deviceId} registered successfully.`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
