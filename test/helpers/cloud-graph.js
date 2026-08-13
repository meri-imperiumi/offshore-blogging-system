// Shared harness for cloud-server.fbp graph-level integration tests.
//
// Each test FILE runs in its own process (node --test isolates files), and
// each file builds ONE network. noflo's `network.stop()` does not reliably
// resolve mid-suite for this graph, so we never stop-and-restart within a
// single file — one network per file, stopped best-effort in `after`.
//
// External boundaries (IMAP, SMTP, InReach) are mocked. DacarAuthorizer runs
// for real, but its `dacar check` subprocess is replaced with an in-process
// fake so the test needs no `dacar` binary or on-disk store.

const assert = require("node:assert");
const fsp = require("node:fs").promises;
const path = require("node:path");
const os = require("node:os");
const noflo = require("noflo");
const { Component } = require("noflo-assembly");

const GRAPH_PATH = path.join(
  __dirname,
  "..",
  "..",
  "graphs",
  "cloud-server.fbp",
);

// Test identity (32 hex chars = 16 bytes)
const TEST_IDENTITY_HASH = "aa".repeat(16);

const ENV_KEYS = [
  "CLOUD_DB_PATH",
  "REPO_PATH",
  "IMAP_USERNAME",
  "IMAP_PASSWORD",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "INREACH_REPLY_ADDRESS",
  "ALERT_ADDRESS",
  "LOG_PATH",
];

/**
 * Create a temp dir and point the graph's core/ReadEnv nodes (via process.env)
 * at temp paths / dummy creds. Returns a context to pass to teardownEnv.
 */
async function setupEnv() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "obs-graph-"));
  const repoDir = path.join(tmpRoot, "repo");
  const logPath = path.join(tmpRoot, "errors.log");
  await fsp.mkdir(repoDir, { recursive: true });

  const savedEnv = {};
  for (const key of ENV_KEYS) {
    if (process.env[key] !== undefined) savedEnv[key] = process.env[key];
  }
  process.env.CLOUD_DB_PATH = path.join(tmpRoot, "cloud.db");
  process.env.REPO_PATH = repoDir;
  process.env.IMAP_USERNAME = "u";
  process.env.IMAP_PASSWORD = "p";
  process.env.SMTP_USERNAME = "u";
  process.env.SMTP_PASSWORD = "p";
  process.env.INREACH_REPLY_ADDRESS = "cloud@example.test";
  process.env.ALERT_ADDRESS = "op@example.test";
  process.env.LOG_PATH = logPath;

  return { tmpRoot, savedEnv };
}

async function teardownEnv(ctx) {
  for (const key of ENV_KEYS) {
    if (key in ctx.savedEnv) process.env[key] = ctx.savedEnv[key];
    else delete process.env[key];
  }
  await fsp.rm(ctx.tmpRoot, { recursive: true, force: true });
}

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

/**
 * Load the real production graph with external boundaries mocked and
 * DacarAuthorizer's subprocess faked. PollTimer is lowered so a poll fires
 * quickly. Returns { network, mocks, errors, trigger }.
 *
 * `trigger()` starts the network and manually bangs ImapFetcher.in to drive
 * one fetch cycle. Call it after queueing the inbound email on mocks.imap.
 */
async function setupGraph() {
  const graph = await noflo.graph.loadFile(GRAPH_PATH);
  assert.ok(
    lowerInterval(graph, "PollTimer", 15),
    "PollTimer INTERVAL IIP should exist",
  );

  const network = await noflo.createNetwork(graph, {
    subscribeGraph: false,
    delay: true,
  });

  const errors = [];
  network.on("process-error", (err) => {
    errors.push(`${err.id}: ${err.error?.message}`);
  });

  await network.loader.listComponents();
  const register = (name, factory) => {
    network.loader.components[name] = { getComponent: factory };
  };

  const mocks = {};
  register("ImapFetcher", () => {
    mocks.imap = new MockImapFetcher();
    return mocks.imap;
  });
  register("AuthVerifier", () => {
    mocks.auth = new MockAuthVerifier();
    return mocks.auth;
  });
  register("SmtpResponder", () => {
    mocks.smtp = new MockSmtpResponder();
    return mocks.smtp;
  });
  register("ImapAcker", () => {
    mocks.ack = new MockImapAcker();
    return mocks.ack;
  });
  register("InReachSender", () => {
    mocks.inreach = new MockInReachSender();
    return mocks.inreach;
  });
  // Internal components (CommandRouter, StatusBuilder, PingHandler,
  // ReplyDispatcher, …) are NOT mocked — the test exercises the real routing.

  await network.connect();
  assert.ok(mocks.imap, "MockImapFetcher should be instantiated");

  // Fake DacarAuthorizer checker: allow only the test identity. The real
  // DacarAuthorizer components still run and route allow/deny through the
  // graph; only the subprocess call is faked.
  const grant = (grantee) =>
    Promise.resolve({ allowed: grantee === TEST_IDENTITY_HASH });
  for (const name of ["BlogAuth", "GribAuth", "SysAuth"]) {
    const proc = network.processes[name];
    if (proc && proc.component) proc.component.di = { runCheck: grant };
  }

  const trigger = async () => {
    await network.start();
    const listener = network.processes.Listener;
    if (listener && listener.component && listener.component.inPorts.in) {
      const port = listener.component.inPorts.in;
      const socket = Object.values(port.sockets)[0];
      if (socket) socket.post(new noflo.IP("data", true));
    }
  };

  return { network, mocks, errors, trigger };
}

async function stopGraph(network) {
  if (!network) return;
  try {
    await network.stop();
  } catch {
    // ignore — the process is tearing down anyway
  }
}

/** Build a verified InReach-channel inbound email for the graph. */
function makeEmail(payload, uid) {
  return {
    errors: [],
    identityHash: TEST_IDENTITY_HASH,
    replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=test",
    channel: "inreach",
    confidence: "medium",
    intent: null,
    imapUid: uid,
    payload,
  };
}

/** Wait until `mock.received` has at least `count` entries (5s deadline). */
async function waitForReceived(mock, count, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (mock.received.length < count && Date.now() < deadline) {
    await sleep(20);
  }
}

module.exports = {
  GRAPH_PATH,
  TEST_IDENTITY_HASH,
  ENV_KEYS,
  setupEnv,
  teardownEnv,
  setupGraph,
  stopGraph,
  makeEmail,
  waitForReceived,
  lowerInterval,
  sleep,
};
