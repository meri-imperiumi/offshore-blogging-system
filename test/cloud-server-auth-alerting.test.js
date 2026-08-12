// Verify that DacarAuthorizer's DENIED outport is wired to AlertComposer
// for operator alerting on auth failures (spoofing attempts etc).
//
// In the graph, the DacarAuthorizer instance is named "BlogAuth". When auth
// is denied, the message goes both to ReplyDispatcher (user notification) and
// to AlertComposer (operator alert).

import assert from "node:assert";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const noflo = require("noflo");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GRAPH_PATH = path.join(__dirname, "..", "graphs", "cloud-server.fbp");

describe("cloud-server graph: auth alerting", () => {
  let graph;

  it("parses the graph", async () => {
    graph = await noflo.graph.loadFile(GRAPH_PATH);
    assert.ok(graph, "graph should parse");
  });

  it("wires DacarAuthorizer DENIED to AlertComposer", () => {
    assert.ok(graph, "graph must have parsed first");

    // Find all DacarAuthorizer nodes (BlogAuth, GribAuth, SysAuth)
    const dacarNodes = Object.values(graph.nodes).filter(
      (n) => n.component === "DacarAuthorizer",
    );
    assert.ok(
      dacarNodes.length > 0,
      "graph should contain at least one DacarAuthorizer",
    );

    // Find all AlertComposer nodes
    const alertNodes = Object.values(graph.nodes).filter(
      (n) => n.component === "AlertComposer",
    );
    assert.ok(
      alertNodes.length > 0,
      "graph should contain at least one AlertComposer",
    );

    // Check that at least one DacarAuthorizer DENIED port is wired to an
    // AlertComposer IN port.
    const alertNodeIds = new Set(alertNodes.map((n) => n.id));

    const hasDeniedToAlert = graph.edges.some(
      (e) =>
        e.from.port === "denied" &&
        dacarNodes.some((n) => n.id === e.from.node) &&
        alertNodeIds.has(e.to.node) &&
        e.to.port === "in",
    );

    assert.ok(
      hasDeniedToAlert,
      "No edge from any DacarAuthorizer.denied to AlertComposer.in",
    );
  });

  it("still wires DacarAuthorizer DENIED to ReplyDispatcher (user notification)", () => {
    assert.ok(graph, "graph must have parsed first");

    const dacarNodes = Object.values(graph.nodes).filter(
      (n) => n.component === "DacarAuthorizer",
    );
    const replyNodes = Object.values(graph.nodes).filter(
      (n) => n.component === "ReplyDispatcher",
    );

    const replyNodeIds = new Set(replyNodes.map((n) => n.id));

    const hasDeniedToReply = graph.edges.some(
      (e) =>
        e.from.port === "denied" &&
        dacarNodes.some((n) => n.id === e.from.node) &&
        replyNodeIds.has(e.to.node),
    );

    assert.ok(
      hasDeniedToReply,
      "DacarAuthorizer.denied should still be wired to ReplyDispatcher for user notification",
    );
  });
});
