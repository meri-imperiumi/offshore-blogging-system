// Smoketest: the cloud-server.fbp graph parses and every local component
// reference resolves to a file in components/. Catches both stale renames
// (e.g. ImapListener -> ImapFetcher) and newly-wired components that don't
// exist (e.g. a typo'd InReachReceiver).

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const noflo = require("noflo");

const GRAPH_PATH = path.join(__dirname, "..", "graphs", "cloud-server.fbp");
const COMPONENTS_DIR = path.join(__dirname, "..", "components");

function localComponentNames() {
  return new Set(
    fs
      .readdirSync(COMPONENTS_DIR)
      .filter((f) => f.endsWith(".js"))
      .map((f) => f.replace(/\.js$/, "")),
  );
}

describe("cloud-server.fbp", () => {
  let graph;

  it("parses without errors", async () => {
    graph = await noflo.graph.loadFile(GRAPH_PATH);
    assert.ok(graph, "graph should parse");
  });

  it("loads as a NoFlo network (every component resolves)", async () => {
    // Structural checks above skip external components (names containing '/'),
    // so a reference to a non-existent component like `core/Ticker` would slip
    // past them. Connecting the network actually instantiates every node — a
    // missing component rejects here. We use `delay: true` so createNetwork
    // does not auto-start (no IIPs sent, no IMAP polling, no DB creation).
    assert.ok(graph, "graph must have parsed first");
    // Load a fresh copy — createNetwork/connect may mutate the graph object,
    // and the structural tests below still need the pristine one.
    const networkGraph = await noflo.graph.loadFile(GRAPH_PATH);
    const network = await noflo.createNetwork(networkGraph, {
      subscribeGraph: false,
      delay: true,
    });
    const errors = [];
    network.on("process-error", (err) => errors.push(err));
    await network.connect();
    await network.stop();
    assert.deepStrictEqual(
      errors,
      [],
      `network connect produced process-errors: ${errors
        .map((e) => e.error?.message || e.message)
        .join(", ")}`,
    );
  });

  it("references only components that exist as files (or external packages)", () => {
    assert.ok(graph, "graph must have parsed first");
    const local = localComponentNames();
    const missing = [];
    for (const node of Object.values(graph.nodes)) {
      const name = node.component;
      // External package components, e.g. core/Ticker
      if (name.includes("/")) {
        continue;
      }
      if (!local.has(name)) {
        missing.push(name);
      }
    }
    assert.deepStrictEqual(
      missing,
      [],
      `graph references components with no file in components/: ${missing.join(", ")}`,
    );
  });

  it("wires InReachReceiver between AuthVerifier and MessageReassembler", () => {
    assert.ok(graph);
    const hasReceiver = Object.values(graph.nodes).some(
      (n) => n.component === "InReachReceiver",
    );
    assert.ok(hasReceiver, "graph should contain an InReachReceiver node");

    // Find an edge Verifier.out -> Receiver.in
    const verifierToReceiver = graph.edges.some(
      (e) => e.from.node === "Verifier" && e.to.node === "Receiver",
    );
    assert.ok(verifierToReceiver, "AuthVerifier should feed InReachReceiver");

    // And Receiver.out -> Reassembler.in
    const receiverToReassembler = graph.edges.some(
      (e) => e.from.node === "Receiver" && e.to.node === "Reassembler",
    );
    assert.ok(
      receiverToReassembler,
      "InReachReceiver should feed MessageReassembler",
    );
  });

  it("wires GitPublisher into the blog pipeline", () => {
    assert.ok(graph);
    const decoderToPublisher = graph.edges.some(
      (e) => e.from.node === "BlogDecoder" && e.to.node === "GitPublisher",
    );
    assert.ok(decoderToPublisher, "BlogDecoder should feed GitPublisher");
  });

  it("acks InReach request emails only after the SMTP send to Saildocs succeeds", () => {
    // The GRIB request email must be marked \Seen only after SmtpResponder
    // successfully sends the request to Saildocs (SmtpResponder OUT →
    // ImapAcker). If SMTP fails, the email stays unseen and is retried on
    // the next poll — for a driving-blind user it is safer to send the
    // request twice than to ack early and silently lose it.
    assert.ok(graph);
    const smtpToAcker = graph.edges.some(
      (e) => e.from.node === "SmtpResponder" && e.to.node === "ImapAcker",
    );
    assert.ok(
      smtpToAcker,
      "SmtpResponder OUT should feed ImapAcker (ack after successful SMTP send)",
    );
    const fetcherToAcker = graph.edges.some(
      (e) => e.from.node === "GribFetcher" && e.to.node === "ImapAcker",
    );
    assert.ok(
      !fetcherToAcker,
      "GribFetcher OUTBOX must NOT feed ImapAcker (don't ack at queue time)",
    );
  });
});
