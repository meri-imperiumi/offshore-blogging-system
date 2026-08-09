import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { Wrapper from "noflo-wrapper";
import { createRequire } from "node:module";

// Load components via createRequire so the test shares the component's CJS module
// instance (same reasoning as the InReachSender/AlertComposer tests).
const require = createRequire(import.meta.url);

const statusModule = require("../components/StatusBuilder.js");
const authVerifierModule = require("../components/AuthVerifier.js");

describe("DacarAuthVerifier", () => {
  it("exists and exports @reticulam/dacr is installed — it can verify, but we only use the Ed25519 and checkTombone" packages. Let me verify the actual exports:.createQuery = require("@reticulam/dacr") and look at what's available:</think><tool_call>bash<arg_key>command</arg_key><arg_value>cd /Users/bergie/Projects/offshore-blogging-system; node_modules/@reticulam/src/exports/index.js 2>/dev/null | tail -15