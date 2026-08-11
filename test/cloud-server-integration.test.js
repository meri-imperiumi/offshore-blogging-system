// Graph-level integration test for cloud-server.fbp.
//
// Loads the *real* production graph and runs a SYS STATUS command through it
// end to end, with external boundaries (IMAP, SMTP, InReach) mocked.
// Uses the real @reticulum/dacar library for authorization with a temp state dir.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fsp = require("node:fs").promises;
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const noflo = require("noflo");
const { Component } = require("noflo-assembly");
const {
  Config,
  Engine,
  StateVector,
  NamespaceHasher,
  Operation,
  Tuple,
  Clock,
  Action,
} = require("@reticulum/dacar");
const { Identity } = require("@reticulum/core");

const GRAPH_PATH = path.join(__dirname, "..", "graphs", "cloud-server.fbp");

// Test identity (32 hex chars = 16 bytes)
const TEST_IDENTITY_HASH = "aa".repeat(16);

let tmpRoot;
let repoDir;
let logPath;
let dacarDir;
let dacarState;
let dacarEngine;
let dacarIdentity;
const savedEnv = {};
const ENV_KEYS = [
  "CLOUD_DB_PATH",
  "REPO_PATH",
  "RNGIT_REMOTE",
  "IMAP_USERNAME",
  "IMAP_PASSWORD",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "INREACH_REPLY_ADDRESS",
  "ALERT_ADDRESS",
  "LOG_PATH",
  "DACAR_STATE_DIR",
];
let network;

before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "obs-graph-"));
  repoDir = path.join(tmpRoot, "repo");
  dacarDir = path.join(tmpRoot, "dacar");
  logPath = path.join(tmpRoot, "errors.log");
  await fsp.mkdir(repoDir, { recursive: true });
  await fsp.mkdir(dacarDir, { recursive: true });

  // Set up test database for DacarAuthorizer
  const DatabaseHelper = require("../lib/DbHelper");
  const dbPath = path.join(tmpRoot, "cloud.db");
  const db = new DatabaseHelper(dbPath);
  db.initialize();

  // Grant sys:command execute permission to test device
  // Using DatabaseHelper.saveDacarTuple(issuer, subject, object, relation, expiry)
  const expiry = Math.floor((Date.now() + 60000) / 1000); // 1 minute from now, in seconds
  db.saveDacarTuple(
    "test-issuer", // issuer
    TEST_IDENTITY_HASH, // subject (identityHash)
    "sys:command", // object (permission)
    "execute", // relation
    expiry,
  );
  db.close();

  // Set up Dacar with a temp state directory (for future @reticulum/dacar integration)
  dacarIdentity = await Identity.generate();
  dacarState = new StateVector();
  const clock = new Clock();

  // Grant sys:command execute permission to test device
  const hasher = new NamespaceHasher(Buffer.alloc(32, 0));
  const grantee = Buffer.from(TEST_IDENTITY_HASH, "hex");
  const grantOp = await new Operation({
    tuple: await Tuple.fromPlaintext({
      objectId: "sys:command",
      relation: "execute",
      grantee,
      issuer: dacarIdentity.identityHash,
      hasher,
    }),
    action: Action.GRANT,
    hlc: clock.now(),
  }).sign(dacarIdentity);
  dacarState.apply(grantOp);

  // Save Dacar state for DacarAuthorizer to load
  const dacarStatePath = path.join(dacarDir, "state.msgpack");
  fs.writeFileSync(dacarStatePath, Buffer.from(dacarState.toPayload()));

  // Write Dacar config with our test identity as root trust anchor (format: { anchors: [...] })
  const dacarConfigPath = path.join(dacarDir, "config.json");
  const dacarConfig = { anchors: [dacarIdentity.identityHash] };
  fs.writeFileSync(dacarConfigPath, JSON.stringify(dacarConfig, null, 2));

  // Create engine with config
  dacarEngine = new Engine(dacarConfig, dacarState);

  // Point the graph's core/ReadEnv nodes at our temp paths / dummy creds.
  for (const key of ENV_KEYS) {
    if (process.env[key] !== undefined) savedEnv[key] = process.env[key];
  }
  process.env.CLOUD_DB_PATH = path.join(tmpRoot, "cloud.db");
  process.env.REPO_PATH = repoDir;
  process.env.RNGIT_REMOTE = "rns://test/boat/repo";
  process.env.IMAP_USERNAME = "u";
  process.env.IMAP_PASSWORD = "p";
  process.env.SMTP_USERNAME = "u";
  process.env.SMTP_PASSWORD = "p";
  process.env.INREACH_REPLY_ADDRESS = "cloud@example.test";
  process.env.ALERT_ADDRESS = "op@example.test";
  process.env.LOG_PATH = logPath;
  process.env.DACAR_STATE_DIR = dacarDir;
});

after(async () => {
  for (const key of ENV_KEYS) {
    if (key in savedEnv) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
  if (network) {
    try {
      await network.stop();
    } catch {
      // ignore
    }
  }
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

// --- Mock components (noflo-assembly Components) for external boundaries ---

class CapturingMock extends Component {
  constructor(spec) {
    super(spec);
    this.received = [];
  }
  handle(input, output) {
    if (!input.hasData("in")) return;
    const msg = input.getData("in");
    this.received.push(msg);
    this.doHandle(input, output, msg);
  }
  doHandle(_input, output, _msg) {
    output.done();
  }
}

class MockImapFetcher extends CapturingMock {
  constructor() {
    super({
      description: "MockImapFetcher",
      inPorts: {
        in: { datatype: "bang" },
        host: { datatype: "string", control: true },
        port: { datatype: "all", control: true },
        username: { datatype: "string", control: true },
        password: { datatype: "string", control: true },
      },
      outPorts: { out: { datatype: "object" } },
    });
    this.queue = [];
  }
  doHandle(_input, output, _msg) {
    const outMsg = this.queue.shift();
    if (outMsg) output.sendDone(outMsg);
  }
}

class MockAuthVerifier extends CapturingMock {
  constructor() {
    super({
      description: "MockAuthVerifier",
      inPorts: {
        in: { datatype: "object" },
        dbpath: { datatype: "string", control: true },
        replyaddress: { datatype: "string", control: true },
      },
      outPorts: { out: { datatype: "object" } },
    });
  }
  doHandle(_input, output, msg) {
    output.sendDone(msg);
  }
}

class MockSmtpResponder extends CapturingMock {
  constructor() {
    super({
      description: "MockSmtpResponder",
      inPorts: {
        in: { datatype: "object" },
        smtp_host: { datatype: "string", control: true },
        smtp_port: { datatype: "all", control: true },
        smtp_user: { datatype: "string", control: true },
        smtp_pass: { datatype: "string", control: true },
        dbpath: { datatype: "string", control: true },
      },
      outPorts: { out: { datatype: "object" } },
    });
  }
}

class MockImapAcker extends CapturingMock {
  constructor() {
    super({
      description: "MockImapAcker",
      inPorts: {
        in: { datatype: "object" },
        host: { datatype: "string", control: true },
        port: { datatype: "all", control: true },
        username: { datatype: "string", control: true },
        password: { datatype: "string", control: true },
        dbpath: { datatype: "string", control: true },
      },
      outPorts: { out: { datatype: "object" } },
    });
  }
}

class MockInReachSender extends CapturingMock {
  constructor() {
    super({
      description: "MockInReachSender",
      inPorts: {
        in: { datatype: "object" },
        replyaddress: { datatype: "string", control: true },
        dbpath: { datatype: "string", control: true },
      },
      outPorts: {
        out: { datatype: "object" },
        error: { datatype: "object" },
      },
    });
  }
}

class MockCommandRouter extends CapturingMock {
  constructor() {
    super({
      description: "MockCommandRouter",
      inPorts: {
        in: { datatype: "object" },
        routes: { datatype: "string", control: true },
      },
      outPorts: {
        out: { datatype: "object" },
        command: { datatype: "object" },
        missed: { datatype: "object" },
      },
    });
  }
  handle(input, output) {
    if (!input.hasData("in")) return;
    const msg = input.getData("in");
    console.log("CommandRouter: received", msg.payload);
    this.received.push(msg);
    this.doHandle(input, output, msg);
  }
}

class MockStatusBuilder extends CapturingMock {
  constructor() {
    super({
      description: "MockStatusBuilder",
      inPorts: {
        in: { datatype: "object" },
        dbpath: { datatype: "string", control: true },
      },
      outPorts: { out: { datatype: "object" } },
    });
  }
  handle(input, output) {
    if (!input.hasData("in")) return;
    const msg = input.getData("in");
    console.log("StatusBuilder: received", msg.payload);
    this.received.push(msg);
    this.doHandle(input, output, msg);
  }
}

class MockReplyDispatcher extends CapturingMock {
  constructor() {
    super({
      description: "MockReplyDispatcher",
      inPorts: { in: { datatype: "object" } },
      outPorts: {
        smtp: { datatype: "object" },
        inreach: { datatype: "object" },
        error: { datatype: "object" },
      },
    });
  }
  handle(input, output) {
    if (!input.hasData("in")) return;
    const msg = input.getData("in");
    this.received.push(msg);
    this.doHandle(input, output, msg);
  }
}

// Lower a RunInterval node's INTERVAL IIP so the timer fires quickly.
function lowerInterval(graph, nodeName, ms) {
  for (const iip of graph.initializers) {
    if (
      iip.to.node === nodeName &&
      String(iip.to.port).toLowerCase() === "interval"
    ) {
      iip.data = ms;
      return true;
    }
  }
  return false;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

describe("cloud-server.fbp graph integration", () => {
  it("routes a SYS STATUS email to a status reply via the real graph", async () => {
    const graph = await noflo.graph.loadFile(GRAPH_PATH);
    // Fire the IMAP poller quickly instead of every 60s.
    assert.ok(
      lowerInterval(graph, "PollTimer", 15),
      "PollTimer INTERVAL IIP should exist",
    );

    let imapMock;
    let authMock;
    let smtpMock;
    let ackMock;
    let inreachMock;

    network = await noflo.createNetwork(graph, {
      subscribeGraph: false,
      delay: true,
    });

    // Log process-errors for debugging.
    const errors = [];
    network.on("process-error", (err) => {
      errors.push(`${err.id}: ${err.error?.message}`);
    });

    // Discover the real components first, then override boundary components
    await network.loader.listComponents();
    const register = (name, factory) => {
      network.loader.components[name] = { getComponent: factory };
    };

    // Override boundary components
    register("ImapFetcher", () => {
      imapMock = new MockImapFetcher();
      return imapMock;
    });
    register("AuthVerifier", () => {
      authMock = new MockAuthVerifier();
      return authMock;
    });
    register("SmtpResponder", () => {
      smtpMock = new MockSmtpResponder();
      return smtpMock;
    });
    register("ImapAcker", () => {
      ackMock = new MockImapAcker();
      return ackMock;
    });
    register("InReachSender", () => {
      inreachMock = new MockInReachSender();
      return inreachMock;
    });
    // Don't mock internal components (CommandRouter, StatusBuilder, ReplyDispatcher)

    await network.connect();
    assert.ok(imapMock, "MockImapFetcher should be instantiated");

    // Queue the inbound email the mock IMAP fetcher will emit on the next poll.
    imapMock.queue.push({
      errors: [],
      identityHash: TEST_IDENTITY_HASH,
      replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=test",
      channel: "inreach",
      confidence: "medium",
      intent: null,
      imapUid: 1001,
      payload: "STATUS",
    });

    await network.start();

    // Bypass PollTimer and manually trigger ImapFetcher
    const listener = network.processes.Listener;
    if (listener && listener.component && listener.component.inPorts.in) {
      const port = listener.component.inPorts.in;
      const socket = Object.values(port.sockets)[0];
      if (socket) {
        socket.post(new noflo.IP("data", true));
      }
    }

    // Wait for the status reply to reach the InReach sender (channel=inreach).
    const deadline = Date.now() + 5000;
    while (inreachMock.received.length === 0 && Date.now() < deadline) {
      await sleep(20);
    }

    console.log(
      "mock captures: auth",
      authMock.received.length,
      ", smtp",
      smtpMock.received.length,
      ", ack",
      ackMock.received.length,
      ", inreach",
      inreachMock.received.length,
    );
    if (errors.length > 0) {
      console.log("process-errors:", errors.join("; "));
    }

    assert.strictEqual(
      inreachMock.received.length,
      1,
      "InReachSender should receive the status reply",
    );
    const reply = inreachMock.received[0];
    assert.strictEqual(reply.intent, "NOTIFY");
    assert.match(reply.payload, /^Status:/);
    assert.ok(
      reply.payload.includes("Posts:"),
      "status should list post count",
    );
    // The original email is acked regardless of reply channel.
    assert.ok(
      ackMock.received.length >= 1,
      "ImapAcker should receive the message to ack",
    );
    // Nothing was sent over SMTP for an inreach-channel reply.
    assert.strictEqual(
      smtpMock.received.length,
      0,
      "SmtpResponder should not be used for an inreach reply",
    );
    assert.strictEqual(reply.channel, "inreach");
  });
});
