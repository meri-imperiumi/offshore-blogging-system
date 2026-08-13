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

  it("wires WinlinkBlogReceiver and InReachReceiver after AuthVerifier", () => {
    assert.ok(graph);
    const hasWinlinkReceiver = Object.values(graph.nodes).some(
      (n) => n.component === "WinlinkBlogReceiver",
    );
    assert.ok(
      hasWinlinkReceiver,
      "graph should contain a WinlinkBlogReceiver node",
    );

    const hasReceiver = Object.values(graph.nodes).some(
      (n) => n.component === "InReachReceiver",
    );
    assert.ok(hasReceiver, "graph should contain an InReachReceiver node");

    // Find an edge Verifier.out -> WinlinkBlogReceiver.in
    const verifierToWinlink = graph.edges.some(
      (e) => e.from.node === "Verifier" && e.to.node === "WinlinkBlogReceiver",
    );
    assert.ok(
      verifierToWinlink,
      "AuthVerifier should feed WinlinkBlogReceiver",
    );

    // And WinlinkBlogReceiver.out -> Receiver.in
    const winlinkToReceiver = graph.edges.some(
      (e) => e.from.node === "WinlinkBlogReceiver" && e.to.node === "Receiver",
    );
    assert.ok(
      winlinkToReceiver,
      "WinlinkBlogReceiver should feed InReachReceiver",
    );

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
    // BlogDecoder goes to GitPublisher (both success and failed messages)
    const decoderToPublisher = graph.edges.some(
      (e) => e.from.node === "BlogDecoder" && e.to.node === "GitPublisher",
    );
    assert.ok(decoderToPublisher, "BlogDecoder should feed GitPublisher");

    // GitPublisher sends confirmation (or failed message) to ReplyDispatcher,
    // via the BlogPostCounter (a passthrough that counts real publishes).
    const publisherToCounter = graph.edges.some(
      (e) => e.from.node === "GitPublisher" && e.to.node === "BlogPostCounter",
    );
    assert.ok(publisherToCounter, "GitPublisher should feed BlogPostCounter");

    const counterToDispatcher = graph.edges.some(
      (e) => e.from.node === "BlogPostCounter" && e.to.node === "ReplyDispatcher",
    );
    assert.ok(
      counterToDispatcher,
      "BlogPostCounter should feed ReplyDispatcher (confirmation still reaches it)",
    );

    // DecoderBypass should be wired between BlogAuth and BlogDecoder
    const authToBypass = graph.edges.some(
      (e) => e.from.node === "BlogAuth" && e.to.node === "DecoderBypass",
    );
    assert.ok(authToBypass, "BlogAuth should feed DecoderBypass");

    const bypassToDecoder = graph.edges.some(
      (e) => e.from.node === "DecoderBypass" && e.to.node === "BlogDecoder",
    );
    assert.ok(bypassToDecoder, "DecoderBypass OUT should feed BlogDecoder");

    const bypassToPublisher = graph.edges.some(
      (e) => e.from.node === "DecoderBypass" && e.to.node === "GitPublisher",
    );
    assert.ok(
      bypassToPublisher,
      "DecoderBypass BYPASS should feed GitPublisher",
    );
  });

  it("acks InReach request emails only after the SMTP send to Saildocs succeeds", () => {
    // The GRIB request email must be marked \Seen only after SmtpResponder
    // successfully sends the request to Saildocs. SmtpResponder feeds
    // ImapAcker via the MsgOutSmtpCounter (a passthrough that counts
    // outbound SMTP messages), so the ack still happens only after a
    // successful send. If SMTP fails, the email stays unseen and is retried
    // on the next poll — for a driving-blind user it is safer to send the
    // request twice than to ack early and silently lose it.
    assert.ok(graph);
    const smtpToCounter = graph.edges.some(
      (e) => e.from.node === "SmtpResponder" && e.to.node === "MsgOutSmtpCounter",
    );
    assert.ok(
      smtpToCounter,
      "SmtpResponder OUT should feed MsgOutSmtpCounter",
    );
    const counterToAcker = graph.edges.some(
      (e) => e.from.node === "MsgOutSmtpCounter" && e.to.node === "ImapAcker",
    );
    assert.ok(
      counterToAcker,
      "MsgOutSmtpCounter OUT should feed ImapAcker (ack after successful SMTP send)",
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
