// Graph-level integration test for cloud-server.fbp.
//
// Loads the *real* production graph and runs a SYS STATUS command through it
// end to end. External boundaries are mocked via the shared helper
// (test/helpers/cloud-graph.js); see that module for why one file = one
// network.

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import {
  makeEmail,
  setupEnv,
  setupGraph,
  stopGraph,
  teardownEnv,
  waitForReceived,
} from "./helpers/cloud-graph.js";

let envCtx;
let graphCtx;

before(async () => {
  envCtx = await setupEnv();
});

after(async () => {
  if (graphCtx) await stopGraph(graphCtx.network);
  await teardownEnv(envCtx);
});

describe("cloud-server.fbp graph integration", () => {
  it("routes a SYS STATUS email to a status reply via the real graph", async () => {
    graphCtx = await setupGraph();
    const { mocks, errors, trigger } = graphCtx;

    // Queue the inbound email the mock IMAP fetcher will emit on the next poll.
    mocks.imap.queue.push(makeEmail("STATUS", 1001));
    await trigger();

    await waitForReceived(mocks.inreach, 1);

    console.log(
      "STATUS mock captures: auth",
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
      "InReachSender should receive the status reply",
    );
    const reply = mocks.inreach.received[0];
    assert.strictEqual(reply.intent, "NOTIFY");
    assert.match(reply.payload, /^Status:/);
    assert.ok(
      reply.payload.includes("Posts:"),
      "status should list post count",
    );
    // The original email is acked regardless of reply channel.
    assert.ok(
      mocks.ack.received.length >= 1,
      "ImapAcker should receive the message to ack",
    );
    // Nothing was sent over SMTP for an inreach-channel reply.
    assert.strictEqual(
      mocks.smtp.received.length,
      0,
      "SmtpResponder should not be used for an inreach reply",
    );
    assert.strictEqual(reply.channel, "inreach");
  });
});
