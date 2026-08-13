import assert from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

// Load via createRequire so the test shares the component's CJS module
// instance — needed to mutate the module-level `di` seam (same idiom as the
// StatusBuilder test).
const require = createRequire(import.meta.url);
const counterModule = require("../components/MetricCounter.js");
const DatabaseHelper = require("../lib/DbHelper.js");

/**
 * Build a counter wired to a fresh in-memory DB (via the di seam) and a
 * pre-set metric, so we can read the resulting metrics back directly.
 */
function makeCounter(metric) {
  const component = counterModule.getComponent();
  const db = new DatabaseHelper(":memory:");
  db.initialize();
  counterModule.di.createDatabase = () => db;
  // Simulate the METRIC IIP having been buffered before data arrives.
  component.metric = metric;
  return { component, db };
}

function handle(component, msg) {
  return new Promise((resolve, reject) => {
    component.handle(
      {
        hasData: (p) => p === "in",
        getData: (p) => (p === "in" ? msg : undefined),
      },
      {
        sendDone: (m) => resolve(m),
        done: () => resolve(null),
        send: () => {},
      },
    );
    setTimeout(() => reject(new Error("handle did not resolve")), 2000);
  });
}

describe("MetricCounter component", () => {
  it("increments msg_in by the number of acked uids", async () => {
    const { component, db } = makeCounter("msg_in");
    await handle(component, { errors: [], ackedUids: [101, 102, 103] });
    assert.strictEqual(db.getMetrics().msg_in, 3);
  });

  it("counts a single acked uid", async () => {
    const { component, db } = makeCounter("msg_in");
    // A message with only imapUid (no ackedUids) counts 0 — ImapAcker is what
    // reports ackedUids, not the original message.
    await handle(component, { errors: [], imapUid: 5 });
    assert.strictEqual(db.getMetrics().msg_in, 0);
    await handle(component, { errors: [], ackedUids: [5] });
    assert.strictEqual(db.getMetrics().msg_in, 1);
  });

  it("does not count messages without ackedUids", async () => {
    const { component, db } = makeCounter("msg_in");
    await handle(component, { errors: [], payload: "PONG" });
    assert.strictEqual(db.getMetrics().msg_in, 0);
  });

  it("does not count failed messages but forwards them unchanged", async () => {
    const { component, db } = makeCounter("msg_in");
    const failedMsg = {
      errors: [{ code: "X", message: "boom" }],
      failed: true,
      ackedUids: [1, 2],
    };
    const out = await handle(component, failedMsg);
    assert.strictEqual(db.getMetrics().msg_in, 0, "failed messages not counted");
    assert.strictEqual(out, failedMsg, "failed message forwarded unchanged");
  });

  it("forwards the message unchanged (passthrough)", async () => {
    const { component, db } = makeCounter("msg_in");
    const msg = {
      errors: [],
      ackedUids: [7],
      channel: "inreach",
      payload: "x",
      imapUid: 7,
    };
    const out = await handle(component, msg);
    assert.strictEqual(out, msg, "same message object forwarded");
    assert.strictEqual(out.payload, "x");
    assert.strictEqual(db.getMetrics().msg_in, 1);
  });

  it("accumulates across multiple messages", async () => {
    const { component, db } = makeCounter("msg_in");
    await handle(component, { errors: [], ackedUids: [1] });
    await handle(component, { errors: [], ackedUids: [2, 3] });
    await handle(component, { errors: [], ackedUids: [4, 5, 6] });
    assert.strictEqual(db.getMetrics().msg_in, 6);
  });

  it("increments msg_out by sentCount", async () => {
    const { component, db } = makeCounter("msg_out");
    await handle(component, { errors: [], sentCount: 4 });
    assert.strictEqual(db.getMetrics().msg_out, 4);
  });

  it("msg_out counts 0 when sentCount is absent", async () => {
    const { component, db } = makeCounter("msg_out");
    await handle(component, { errors: [], payload: "x" });
    assert.strictEqual(db.getMetrics().msg_out, 0);
  });

  it("increments blog_posts by 1 when published", async () => {
    const { component, db } = makeCounter("blog_posts");
    await handle(component, { errors: [], published: true });
    assert.strictEqual(db.getMetrics().blog_posts, 1);
  });

  it("blog_posts counts 0 on an idempotent no-op (published false/absent)", async () => {
    const { component, db } = makeCounter("blog_posts");
    await handle(component, { errors: [], published: false });
    assert.strictEqual(db.getMetrics().blog_posts, 0);
    await handle(component, { errors: [], payload: "x" });
    assert.strictEqual(db.getMetrics().blog_posts, 0);
  });
});
