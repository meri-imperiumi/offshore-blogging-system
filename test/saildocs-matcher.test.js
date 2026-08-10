import assert from "node:assert";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";
import Wrapper from "noflo-wrapper";
import DatabaseHelper from "../lib/DbHelper.js";

const require = createRequire(import.meta.url);
const _matcherModule = require("../components/SaildocsMatcher.js");

const DB_PATH = "/tmp/saildocs-matcher-test.db";

function makeDb() {
  rmSync(DB_PATH, { force: true });
  const db = new DatabaseHelper(DB_PATH);
  db.initialize();
  return db;
}

/**
 * Run a SaildocsMatcher scenario. Sends the email on `in` after the control
 * IIPs, then resolves the first IP on the given port (or null on timeout).
 */
function runScenario({
  email,
  dbpath = DB_PATH,
  port = "out",
  timeout = 1500,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const t = new Wrapper("signalk-offshore-blogging/SaildocsMatcher");
    const collected = {};
    t.start()
      .then(() => {
        t.outs[port].on("data", (data) => {
          collected[port] = data;
          finish(() => resolve({ data, collected }));
        });
        t.ins.dbpath.send(dbpath);
        t.ins.in.send(email);
      })
      .catch(reject);
    const timer = setTimeout(
      () => finish(() => resolve({ data: null, collected })),
      timeout,
    );
  });
}

describe("SaildocsMatcher", () => {
  let db;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    if (db) db.close();
    rmSync(DB_PATH, { force: true });
  });

  it("matches by queryId when subject contains 'Your query: <id>'", async () => {
    db.savePendingSaildocs(
      "deadbeef",
      "hash123",
      "captain@boat.sea",
      "winlink",
    );

    const email = {
      subject: "Your query: deadbeef",
      payload: {
        attachment: Buffer.from("GRIB test data"),
      },
    };

    const { data } = await runScenario({ email, port: "out" });
    assert.ok(data, "should emit on out port");
    assert.strictEqual(data.identityHash, "hash123");
    assert.strictEqual(data.replyTo, "captain@boat.sea");
    assert.strictEqual(data.channel, "winlink");
    assert.ok(data.payload, "should have GRIB attachment");

    // Pending entry should be cleaned up
    const remaining = db.getPendingSaildocs("deadbeef");
    assert.ok(!remaining, "pending entry should be deleted");
  });

  it("falls back to most recent pending when subject has no queryId", async () => {
    // Simulate the real Saildocs behavior: response subject is the query
    // string (e.g. "gfs:58n,60n,018e,022e"), NOT "Your query: <id>".
    db.savePendingSaildocs("aabbccdd", "hash456", "skipper@yacht.sea", "test");

    const email = {
      subject: "gfs:58n,60n,018e,022e",
      from: { address: "query-reply@saildocs.com" },
      payload: {
        attachment: Buffer.from("GRIB weather data"),
      },
    };

    const { data } = await runScenario({ email, port: "out" });
    assert.ok(data, "should emit on out port via fallback");
    assert.strictEqual(data.identityHash, "hash456");
    assert.strictEqual(data.replyTo, "skipper@yacht.sea");
    assert.strictEqual(data.channel, "test");

    // Pending entry should be cleaned up
    const remaining = db.getPendingSaildocs("aabbccdd");
    assert.ok(!remaining, "pending entry should be deleted");
  });

  it("sends to missed port when no pending request exists", async () => {
    const email = {
      subject: "gfs:58n,60n,018e,022e",
      from: { address: "query-reply@saildocs.com" },
      payload: {
        attachment: Buffer.from("GRIB data"),
      },
    };

    const { data } = await runScenario({ email, port: "missed" });
    assert.ok(data, "should emit on missed port");
    assert.strictEqual(data.subject, "gfs:58n,60n,018e,022e");
  });

  it("sends to missed port when response has no attachment", async () => {
    db.savePendingSaildocs("abcdef", "hash", "user@sea", "test");

    const email = {
      subject: "Your query: abcdef",
      from: { address: "query-reply@saildocs.com" },
      payload: {},
    };

    const { data } = await runScenario({ email, port: "missed" });
    assert.ok(data, "should emit on missed port for missing attachment");
    assert.ok(
      data.errors?.some((e) => e.message.includes("missing binary attachment")),
      "should have missing attachment error",
    );

    // Pending entry should NOT be cleaned up (it wasn't matched)
    const remaining = db.getPendingSaildocs("abcdef");
    assert.ok(remaining, "pending entry should still exist");
  });
});
