// Smoketest: the weather-runner.js programmatic graph builds correctly and
// every component reference resolves. Catches stale renames, missing
// components, and addressable-port wiring mistakes (ParserRouter's array
// `out` port must use addEdgeIndex, not addEdge).
//
// This mirrors the cloud-graph.test.js approach but for the programmatic
// graph built in scripts/weather-runner.js. The graph is rebuilt here (not
// imported from the runner, which starts a live network on load) so the
// test has no IMAP/SMTP/network side-effects.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const noflo = require("noflo");

const COMPONENTS_DIR = path.join(__dirname, "..", "components");

function localComponentNames() {
  return new Set(
    fs
      .readdirSync(COMPONENTS_DIR)
      .filter((f) => f.endsWith(".js"))
      .map((f) => f.replace(/\.js$/, "")),
  );
}

/**
 * Build the same graph structure as scripts/weather-runner.js (receive path
 * + GRIB forward + SAILDOCS response path), without the IIPs that would
 * start a live network (Timer start, etc.).
 */
function buildGraph() {
  const graph = noflo.graph.createGraph("weather-e2e-test");

  // Define ALL nodes first. NoFlo silently drops edges whose endpoints
  // don't exist yet, so adding an edge to a not-yet-created node loses it.
  graph.addNode("Timer", "core/RunInterval");
  graph.addNode("Fetcher", "ImapFetcher");
  graph.addNode("Verifier", "AuthVerifier");
  graph.addNode("Receiver", "InReachReceiver");
  graph.addNode("Reassembler", "MessageReassembler");
  graph.addNode("Router", "ParserRouter");
  graph.addNode("GribFetcher", "GribFetcher");
  graph.addNode("SmtpSender", "SmtpResponder");
  graph.addNode("SaildocsMatcher", "SaildocsMatcher");
  graph.addNode("GribChunker", "GribChunker");
  graph.addNode("Gate", "GribGate");
  graph.addNode("Dispatcher", "ReplyDispatcher");
  graph.addNode("InReachSender", "InReachSender");
  graph.addNode("Acker", "ImapAcker");
  graph.addNode("MissedDrop", "core/Drop");
  graph.addNode("ErrorDrop", "core/Drop");

  // Receive path
  graph.addEdge("Timer", "out", "Fetcher", "in");
  graph.addEdge("Fetcher", "out", "Verifier", "in");
  graph.addEdge("Verifier", "out", "Receiver", "in");
  graph.addEdge("Receiver", "out", "Reassembler", "in");
  graph.addEdge("Reassembler", "out", "Router", "in");
  graph.addEdge("Reassembler", "buffered", "Acker", "in");

  // GRIB request path: ack AFTER SMTP send succeeds (SmtpSender.out →
  // Acker), not at queue time. If SMTP fails the request email stays
  // unseen and is retried on the next poll — for a driving-blind user it
  // is safer to send twice than to ack early and silently lose the request.
  graph.addEdgeIndex("Router", "out", 1, "GribFetcher", "in", null);
  graph.addEdge("GribFetcher", "outbox", "SmtpSender", "in");
  graph.addEdge("SmtpSender", "out", "Acker", "in");

  // SAILDOCS response path: GRIB on `direct` (→ chunker → delivery),
  // error text on `out` (→ Dispatcher → user, bypasses chunker).
  graph.addEdgeIndex("Router", "out", 2, "SaildocsMatcher", "in", null);
  graph.addEdge("SaildocsMatcher", "direct", "GribChunker", "in");
  graph.addEdge("SaildocsMatcher", "out", "Dispatcher", "in");
  graph.addEdge("GribChunker", "out", "Gate", "in");
  graph.addEdge("Gate", "out", "Dispatcher", "in");
  graph.addEdge("Gate", "notify", "Dispatcher", "in");
  graph.addEdge("Dispatcher", "inreach", "InReachSender", "in");
  // The Saildocs response email is acked only AFTER delivery to the InReach
  // device succeeds (InReachSender.out → Acker). If delivery fails, the
  // email stays unseen and is retried.
  graph.addEdge("InReachSender", "out", "Acker", "in");

  // NOTIFY path
  graph.addEdgeIndex("Router", "out", 4, "Dispatcher", "in", null);

  // Error / missed drops. SMTP send failures are consumed (the request
  // email is NOT acked — SmtpSender.out didn't fire — so it retries).
  graph.addEdge("Router", "missed", "MissedDrop", "in");
  graph.addEdge("Router", "error", "ErrorDrop", "in");
  graph.addEdge("SmtpSender", "error", "ErrorDrop", "in");

  // Static config IIPs (safe to include — they don't start a live network
  // like the Timer would). Mirrors scripts/weather-runner.js so the
  // chunk-size / gate-threshold safety assertions below hold.
  graph.addInitial(96, "GribChunker", "max_chunk_size");
  graph.addInitial(15, "Gate", "max_chunks");

  return graph;
}

describe("weather-runner graph", () => {
  let graph;

  it("builds without errors", () => {
    graph = buildGraph();
    assert.ok(graph, "graph should build");
  });

  it("references only components that exist as files (or external packages)", () => {
    assert.ok(graph, "graph must have built first");
    const local = localComponentNames();
    const missing = [];
    for (const node of Object.values(graph.nodes)) {
      const name = node.component;
      if (name.includes("/")) {
        continue; // external package, e.g. core/RunInterval
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

  it("wires the receive path: Fetcher → Verifier → Receiver → Reassembler → Router", () => {
    assert.ok(graph);
    const has = (from, to) =>
      graph.edges.some((e) => e.from.node === from && e.to.node === to);
    assert.ok(has("Fetcher", "Verifier"));
    assert.ok(has("Verifier", "Receiver"));
    assert.ok(has("Receiver", "Reassembler"));
    assert.ok(has("Reassembler", "Router"));
  });

  it("wires GRIB request path: Router[1] → GribFetcher → SmtpSender, acks after SMTP send", () => {
    assert.ok(graph);
    // The addressable edges carry the index in edge.from.index
    const routerToFetcher = graph.edges.find(
      (e) =>
        e.from.node === "Router" &&
        e.to.node === "GribFetcher" &&
        e.from.index === 1,
    );
    assert.ok(
      routerToFetcher,
      "Router OUT[1] (GRIB) should feed GribFetcher via addEdgeIndex",
    );
    const fetcherToSmtp = graph.edges.some(
      (e) => e.from.node === "GribFetcher" && e.to.node === "SmtpSender",
    );
    assert.ok(fetcherToSmtp, "GribFetcher.outbox should feed SmtpSender");
    // The ack must happen AFTER the SMTP send succeeds (SmtpSender.out →
    // Acker), NOT at queue time (GribFetcher.outbox → Acker). If SMTP fails,
    // the request email stays unseen and is retried — for a driving-blind
    // user it is safer to send twice than to ack early and silently lose it.
    const smtpToAcker = graph.edges.some(
      (e) => e.from.node === "SmtpSender" && e.to.node === "Acker",
    );
    assert.ok(
      smtpToAcker,
      "SmtpSender.out should feed ImapAcker (ack after successful SMTP send)",
    );
    const fetcherToAcker = graph.edges.some(
      (e) => e.from.node === "GribFetcher" && e.to.node === "Acker",
    );
    assert.ok(
      !fetcherToAcker,
      "GribFetcher.outbox must NOT feed ImapAcker (don't ack at queue time)",
    );
  });

  it("wires SAILDOCS response path: Router[2] → SaildocsMatcher → (direct→GribChunker→Gate, out→Dispatcher)", () => {
    assert.ok(graph);
    const routerToMatcher = graph.edges.find(
      (e) =>
        e.from.node === "Router" &&
        e.to.node === "SaildocsMatcher" &&
        e.from.index === 2,
    );
    assert.ok(
      routerToMatcher,
      "Router OUT[2] (SAILDOCS) should feed SaildocsMatcher",
    );
    const matcherToChunker = graph.edges.some(
      (e) => e.from.node === "SaildocsMatcher" && e.to.node === "GribChunker",
    );
    assert.ok(
      matcherToChunker,
      "SaildocsMatcher.direct should feed GribChunker (GRIB path)",
    );
    // Error responses (no GRIB) go on `out` → Dispatcher, bypassing
    // GribChunker, so the error text reaches the user as NOTIFY.
    const matcherToDispatcher = graph.edges.some(
      (e) =>
        e.from.node === "SaildocsMatcher" &&
        e.to.node === "Dispatcher" &&
        e.from.port === "out",
    );
    assert.ok(
      matcherToDispatcher,
      "SaildocsMatcher.out should feed Dispatcher (error text path)",
    );
    const chunkerToGate = graph.edges.some(
      (e) => e.from.node === "GribChunker" && e.to.node === "Gate",
    );
    assert.ok(chunkerToGate, "GribChunker should feed GribGate");
  });

  it("wires GRIB delivery back to user: Gate → Dispatcher → InReachSender", () => {
    assert.ok(graph);
    const gateToDispatcher = graph.edges.some(
      (e) => e.from.node === "Gate" && e.to.node === "Dispatcher",
    );
    assert.ok(gateToDispatcher, "GribGate.out should feed ReplyDispatcher");
    const dispatcherToSender = graph.edges.some(
      (e) =>
        e.from.node === "Dispatcher" &&
        e.to.node === "InReachSender" &&
        e.from.port === "inreach",
    );
    assert.ok(
      dispatcherToSender,
      "ReplyDispatcher.inreach should feed InReachSender",
    );
  });

  it("acks Saildocs response emails only after delivery to InReach (InReachSender.out → Acker)", () => {
    assert.ok(graph);
    // The response email is acked only after InReachSender delivers it
    // (GRIB chunks OR error text). NOT at extraction time.
    const senderToAcker = graph.edges.some(
      (e) => e.from.node === "InReachSender" && e.to.node === "Acker",
    );
    assert.ok(
      senderToAcker,
      "InReachSender.out should feed ImapAcker (ack after delivery)",
    );
    // SaildocsMatcher.out must NOT go to Acker — it goes to Dispatcher
    // (error text → user). Acking at extraction would silently drop the
    // email if delivery then failed.
    const matcherOutToAcker = graph.edges.some(
      (e) =>
        e.from.node === "SaildocsMatcher" &&
        e.to.node === "Acker" &&
        e.from.port === "out",
    );
    assert.ok(
      !matcherOutToAcker,
      "SaildocsMatcher.out must NOT feed ImapAcker (don't ack at extraction)",
    );
  });

  it("wires NOTIFY path: Router[4] → ReplyDispatcher", () => {
    assert.ok(graph);
    const routerToDispatcher = graph.edges.find(
      (e) =>
        e.from.node === "Router" &&
        e.to.node === "Dispatcher" &&
        e.from.index === 4,
    );
    assert.ok(
      routerToDispatcher,
      "Router OUT[4] (NOTIFY) should feed ReplyDispatcher",
    );
  });

  it("uses a GRIB chunk size that keeps each InReach message under Garmin's 120-char truncation threshold", () => {
    // Regression test: with chunk size 140, each InReach message was
    // `msg i/total:grib:<id>\n` (~21-23 chars) + 140 base64 = 161-163
    // chars. Garmin truncates messages around the 130-140 char mark (see
    // references/garmin-character-counts.txt and both reference
    // implementations), chopping ~20-30 base64 chars off every chunk and
    // corrupting reassembly (`atob: invalid character`). The chunk size
    // must be small enough that header + data stays under ~120.
    assert.ok(graph);
    const iip = graph.initializers.find(
      (i) => i.to.node === "GribChunker" && i.to.port === "max_chunk_size",
    );
    assert.ok(iip, "GribChunker max_chunk_size IIP should be set");
    const chunkSize = Number(iip.from.data);
    // Worst-case envelope header for double-digit chunk counts:
    // `msg 12/12:grib:rXXXXXX\n` = 23 chars.
    const maxHeader = 23;
    const total = chunkSize + maxHeader;
    assert.ok(
      total <= 120,
      `chunk size ${chunkSize} + ${maxHeader}-char header = ${total} chars, ` +
        `exceeds Garmin's ~120-char safe budget (truncation at 130-140)`,
    );
  });

  it("gates GRIB payloads only above ~1KB (max_chunks IIP scaled to the chunk size)", () => {
    // The gate threshold (max_chunks) must be scaled to the chunk size so
    // that the gating byte-point stays ~1KB (the original 10×140).
    // At chunk size 96, 15 chunks × 96 = 1440 base64 ≈ 1KB of GRIB.
    assert.ok(graph);
    const iip = graph.initializers.find(
      (i) => i.to.node === "Gate" && i.to.port === "max_chunks",
    );
    assert.ok(iip, "Gate max_chunks IIP should be set");
    const maxChunks = Number(iip.from.data);
    assert.ok(
      maxChunks >= 15,
      `max_chunks ${maxChunks} is too low — at 96-char chunks this would ` +
        `gate even small (~800B → 12-chunk) GRIBs`,
    );
  });
});
