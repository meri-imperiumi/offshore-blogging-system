// Graph-level integration test for the SYS PING command in cloud-server.fbp.
//
// Regression test: InReachReceiver.detectIntent() previously did not recognize
// "PING" as a SYS command, so a PING email got intent=null, ParserRouter
// routed it to MISSED→ErrorLogger, and neither a PONG reply was sent nor the
// email acked. This test pins the full PING→PONG round-trip + ACK through the
// real graph.
//
// Lives in its own file (own process) because noflo's network.stop() does not
// reliably resolve mid-suite for this graph — see test/helpers/cloud-graph.js.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const {
  setupEnv,
  teardownEnv,
  setupGraph,
  stopGraph,
  makeEmail,
  waitForReceived,
} = require("./helpers/cloud-graph");

let envCtx;
let graphCtx;

before(async () => {
  envCtx = await setupEnv();
});

after(async () => {
  if (graphCtx) await stopGraph(graphCtx.network);
  await teardownEnv(envCtx);
});

describe("cloud-server.fbp SYS PING", () => {
  it("routes a SYS PING email to a PONG reply and acks the email", async () => {
    graphCtx = await setupGraph();
    const { mocks, errors, trigger } = graphCtx;

    mocks.imap.queue.push(makeEmail("PING", 2002));
    await trigger();

    await waitForReceived(mocks.inreach, 1);

    console.log(
      "PING mock captures: auth",
      mocks.auth.received.length,
      ", smtp",
      mocks.smtp.received.length,
      ", ack",
      mocks.ack.received.length,
      ", inreach",
      mocks.inreach.received.length,
    );
    if (errors.length > 0) {
      console.log("process-errors:", errors.join("; "));
    }

    assert.strictEqual(
      mocks.inreach.received.length,
      1,
      "InReachSender should receive the PONG reply",
    );
    const reply = mocks.inreach.received[0];
    assert.strictEqual(reply.intent, "NOTIFY");
    assert.strictEqual(reply.payload, "PONG");
    assert.strictEqual(reply.channel, "inreach");
    // The PING email must be acked so it isn't re-fetched on the next poll.
    assert.ok(
      mocks.ack.received.length >= 1,
      "ImapAcker should receive the PING message to ack",
    );
    // PONG is an InReach-channel reply; no SMTP traffic expected.
    assert.strictEqual(
      mocks.smtp.received.length,
      0,
      "SmtpResponder should not be used for a PONG reply",
    );
  });
});
