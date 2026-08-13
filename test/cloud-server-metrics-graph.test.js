// Static wiring smoketest for the metric counters in cloud-server.fbp.
//
// The counter LOGIC is unit-tested in metric-counter.test.js, and each
// signal setter (ImapAcker.ackedUids, SmtpResponder/InReachSender.sentCount,
// GitPublisher.published) in its own test. This file pins that the graph
// actually places a MetricCounter at each of those points with the right
// METRIC IIP, so an accidental graph edit can't silently disconnect a
// counter. Loads the .fbp as a graph object — no network is started.

const { describe, it, before } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const noflo = require("noflo");

const GRAPH_PATH = path.join(__dirname, "..", "graphs", "cloud-server.fbp");

let graph;

before(async () => {
  graph = await noflo.graph.loadFile(GRAPH_PATH);
  assert.ok(graph, "cloud-server.fbp should load");
});

function hasEdge(fromNode, fromPort, toNode, toPort) {
  return graph.edges.some(
    (e) =>
      e.from.node === fromNode &&
      e.from.port === fromPort &&
      e.to.node === toNode &&
      e.to.port === toPort,
  );
}

function hasIIP(data, toNode, toPort) {
  return graph.initializers.some(
    (i) => i.from.data === data && i.to.node === toNode && i.to.port === toPort,
  );
}

function componentOf(nodeName) {
  const n = graph.nodes.find((nd) => nd.id === nodeName);
  return n ? n.component : null;
}

describe("cloud-server.fbp metric counters", () => {
  it("places a MetricCounter(msg_in) after ImapAcker", () => {
    assert.strictEqual(componentOf("MsgInCounter"), "MetricCounter");
    assert.ok(
      hasEdge("ImapAcker", "out", "MsgInCounter", "in"),
      "ImapAcker OUT -> MsgInCounter IN",
    );
    assert.ok(hasIIP("msg_in", "MsgInCounter", "metric"));
    assert.ok(
      hasEdge("DbEnv", "out", "MsgInCounter", "dbpath"),
      "DbEnv OUT -> MsgInCounter DBPATH",
    );
  });

  it("places a MetricCounter(msg_out) after SmtpResponder, then to ImapAcker", () => {
    assert.strictEqual(componentOf("MsgOutSmtpCounter"), "MetricCounter");
    assert.ok(
      hasEdge("SmtpResponder", "out", "MsgOutSmtpCounter", "in"),
      "SmtpResponder OUT -> MsgOutSmtpCounter IN",
    );
    assert.ok(
      hasEdge("MsgOutSmtpCounter", "out", "ImapAcker", "in"),
      "MsgOutSmtpCounter OUT -> ImapAcker IN (ack still happens)",
    );
    assert.ok(hasIIP("msg_out", "MsgOutSmtpCounter", "metric"));
    assert.ok(hasEdge("DbEnv", "out", "MsgOutSmtpCounter", "dbpath"));
  });

  it("places a MetricCounter(msg_out) after InReachSender, then to ErrorLogger + AlertComposer", () => {
    assert.strictEqual(componentOf("MsgOutInReachCounter"), "MetricCounter");
    assert.ok(
      hasEdge("InReachSender", "out", "MsgOutInReachCounter", "in"),
      "InReachSender OUT -> MsgOutInReachCounter IN",
    );
    assert.ok(
      hasEdge("MsgOutInReachCounter", "out", "ErrorLogger", "in"),
      "MsgOutInReachCounter OUT -> ErrorLogger IN",
    );
    assert.ok(
      hasEdge("MsgOutInReachCounter", "out", "AlertComposer", "in"),
      "MsgOutInReachCounter OUT -> AlertComposer IN",
    );
    assert.ok(hasIIP("msg_out", "MsgOutInReachCounter", "metric"));
    assert.ok(hasEdge("DbEnv", "out", "MsgOutInReachCounter", "dbpath"));
  });

  it("places a MetricCounter(blog_posts) after GitPublisher, then to ReplyDispatcher", () => {
    assert.strictEqual(componentOf("BlogPostCounter"), "MetricCounter");
    assert.ok(
      hasEdge("GitPublisher", "out", "BlogPostCounter", "in"),
      "GitPublisher OUT -> BlogPostCounter IN",
    );
    assert.ok(
      hasEdge("BlogPostCounter", "out", "ReplyDispatcher", "in"),
      "BlogPostCounter OUT -> ReplyDispatcher IN",
    );
    assert.ok(hasIIP("blog_posts", "BlogPostCounter", "metric"));
    assert.ok(hasEdge("DbEnv", "out", "BlogPostCounter", "dbpath"));
  });

  it("acks the previously-looping MISSED ports into ImapAcker", () => {
    assert.ok(
      hasEdge("SaildocsMatcher", "missed", "ImapAcker", "in"),
      "SaildocsMatcher MISSED -> ImapAcker (was unwired → looped)",
    );
    assert.ok(
      hasEdge("Router", "missed", "ImapAcker", "in"),
      "Router MISSED -> ImapAcker",
    );
    assert.ok(
      hasEdge("CmdRouter", "missed", "ImapAcker", "in"),
      "CmdRouter MISSED -> ImapAcker",
    );
  });
});
