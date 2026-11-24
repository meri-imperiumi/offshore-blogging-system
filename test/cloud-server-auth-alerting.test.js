// Verify that DacarAuthorizer's DENIED outport is wired to AlertComposer
// for operator alerting on auth failures (spoofing attempts etc).
//
// In the graph, the DacarAuthorizer instance is named "BlogAuth". When auth
// is denied, the message goes both to ReplyDispatcher (user notification) and
// to AlertComposer (operator alert).

import assert from "node:assert";
import path from "node:path";
import { describe, it } from "node:test";
import { loadGraphFile } from "@noflo/loader-node";
import * as noflo from "@noflo/noflo";

const GRAPH_PATH = path.join(
  import.meta.dirname,
  "..",
  "graphs",
  "cloud-server.fbp",
);

describe("cloud-server graph: auth alerting", () => {
  let graph;

  it("parses the graph", async () => {
    graph = await loadGraphFile(GRAPH_PATH);
    assert.ok(graph, "graph should parse");
  });

  it("wires DacarAuthorizer DENIED to AlertComposer", () => {
    assert.ok(graph, "graph must have parsed first");

    // Find all DacarAuthorizer nodes (BlogAuth, GribAuth, SysAuth)
    const dacarNodes = graph
      .nodes()
      .filter((n) => n.component === "DacarAuthorizer");
    assert.ok(
      dacarNodes.length > 0,
      "graph should contain at least one DacarAuthorizer",
    );

    // Find all AlertComposer nodes
    const alertNodes = graph
      .nodes()
      .filter((n) => n.component === "AlertComposer");
    assert.ok(
      alertNodes.length > 0,
      "graph should contain at least one AlertComposer",
    );

    // Check that at least one DacarAuthorizer DENIED port is wired to an
    // AlertComposer IN port.
    const alertNodeIds = new Set(alertNodes.map((n) => n.entity_id));

    const hasDeniedToAlert = graph
      .edges()
      .some(
        (e) =>
          e.from.port === "denied" &&
          dacarNodes.some((n) => n.entity_id === e.from.node) &&
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

    const dacarNodes = graph
      .nodes()
      .filter((n) => n.component === "DacarAuthorizer");
    const replyNodes = graph
      .nodes()
      .filter((n) => n.component === "ReplyDispatcher");

    const replyNodeIds = new Set(replyNodes.map((n) => n.entity_id));

    const hasDeniedToReply = graph
      .edges()
      .some(
        (e) =>
          e.from.port === "denied" &&
          dacarNodes.some((n) => n.entity_id === e.from.node) &&
          replyNodeIds.has(e.to.node),
      );

    assert.ok(
      hasDeniedToReply,
      "DacarAuthorizer.denied should still be wired to ReplyDispatcher for user notification",
    );
  });
});
