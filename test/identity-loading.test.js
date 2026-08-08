// Test loading Reticulum identity from signalk-reticulum config
// This is an environment-specific smoketest - it will pass if signalk-reticulum
// is configured on the system, but won't fail if it's not.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs").promises;

test("should load identity from signalk-reticulum config file (environment-specific)", async (t) => {
  const { Identity, fromHex } = require("@reticulum/core");

  // Try multiple possible config paths (matching the plugin's logic)
  const configPaths = [
    path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".signalk",
      "plugin-config-data",
      "signalk-reticulum.json",
    ),
    path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".signalk",
      "plugin-config-data",
      "signalk-reticulum",
    ),
  ];

  let configData = null;
  let foundPath = null;

  for (const configPath of configPaths) {
    try {
      await fs.access(configPath, fs.constants.R_OK);
      configData = await fs.readFile(configPath, "utf-8");
      foundPath = configPath;
      break;
    } catch {
      // Try next path
    }
  }

  if (!configData) {
    t.skip(
      "signalk-reticulum config not found - skipping environment-specific test",
    );
    return;
  }

  const config = JSON.parse(configData);

  assert.ok(
    config.configuration?.identity?.privateKey,
    "Config should have identity.privateKey",
  );

  const privateKeyHex = config.configuration.identity.privateKey.trim();
  const privateKey = fromHex(privateKeyHex);
  const identity = await Identity.fromBytes(privateKey);

  const publicKeyHex = Buffer.from(await identity.getPublicKey()).toString(
    "hex",
  );

  assert.ok(identity, "Identity should be loaded");
  assert.strictEqual(
    publicKeyHex,
    config.configuration.identity.publicKey,
    "Public key should match config",
  );
});
