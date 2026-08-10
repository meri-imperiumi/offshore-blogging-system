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

    const { data } = await runScenario({ email, port: "direct" });
    assert.ok(data, "should emit on direct port");
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

    const { data } = await runScenario({ email, port: "direct" });
    assert.ok(data, "should emit on direct port via fallback");
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

  it("forwards error responses (no attachment) to the user on `out`", async () => {
    // Saildocs error replies (e.g. "HTTP 405", "command error") have no
    // GRIB attachment. Instead of dropping to `missed` (which would loop
    // forever as an unseen email), forward the error text to the user as a
    // NOTIFY message so they know their request failed. The pending entry
    // IS cleaned up — the request has been answered (with an error).
    db.savePendingSaildocs(
      "abcdef",
      "hash",
      "https://inreachlink.com/x",
      "inreach",
    );

    const email = {
      subject: "Your query: abcdef",
      from: { address: "query-reply@saildocs.com" },
      payload: "There was an error in the following command line: bad stuff",
      imapUid: 907,
    };

    const { data } = await runScenario({ email, port: "out" });
    assert.ok(data, "should emit on out port for error response");
    assert.strictEqual(data.identityHash, "hash");
    assert.strictEqual(data.channel, "inreach");
    assert.strictEqual(data.intent, "NOTIFY");
    assert.strictEqual(data.partType, "text");
    assert.ok(
      String(data.payload).startsWith("Saildocs error:"),
      "payload should be prefixed with 'Saildocs error:'",
    );
    assert.ok(
      String(data.payload).includes("bad stuff"),
      "error text should be included",
    );
    // imapUid must be carried so ImapAcker can mark the email as \Seen
    // AFTER delivery to the InReach device succeeds.
    assert.strictEqual(
      data.imapUid,
      907,
      "should carry imapUid so the email can be acked after delivery",
    );

    // Pending entry IS cleaned up — the request has been answered
    const remaining = db.getPendingSaildocs("abcdef");
    assert.ok(
      !remaining,
      "pending entry should be deleted (answered w/ error)",
    );
  });

  it("extracts the GRIB attachment from raw MIME (production path)", async () => {
    // In the production graph, AuthVerifier carries the raw RFC 5322
    // message source through on `msg.raw` (the decoded body text doesn't
    // contain the base64 attachment). SaildocsMatcher must extract the
    // GRIB from `raw`, not from a pre-parsed `attachment` field.
    db.savePendingSaildocs("raw123", "hash789", "captain@boat.sea", "inreach");

    const gribPayload = Buffer.concat([
      Buffer.from("GRIB", "ascii"),
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
      Buffer.from("weather data"),
    ]);
    const gribB64 = gribPayload.toString("base64");
    const boundary = "----=_prod";
    const rawMime = Buffer.from(
      [
        `From: query-reply@saildocs.com`,
        `Subject: gfs:58n,60n,018e,022e`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain`,
        ``,
        `Here is your GRIB file.`,
        `--${boundary}`,
        `Content-Type: application/octet-stream`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="grib.grb"`,
        ``,
        `${gribB64}`,
        `--${boundary}--`,
        ``,
      ].join("\r\n"),
      "latin1",
    );

    const email = {
      subject: "gfs:58n,60n,018e,022e",
      from: { address: "query-reply@saildocs.com" },
      payload: "Here is your GRIB file.",
      raw: rawMime,
      imapUid: 908,
    };

    const { data } = await runScenario({ email, port: "direct" });
    assert.ok(data, "should emit on direct port");
    assert.strictEqual(data.identityHash, "hash789");
    assert.strictEqual(data.channel, "inreach");
    assert.ok(
      Buffer.isBuffer(data.payload),
      "payload should be the GRIB buffer",
    );
    assert.strictEqual(
      data.payload.subarray(0, 4).toString("ascii"),
      "GRIB",
      "extracted data should start with GRIB magic bytes",
    );
    assert.strictEqual(data.intent, "SAILDOCS");
    // imapUid MUST be carried through so ImapAcker (wired downstream of
    // InReachSender) can mark the Saildocs response email as \Seen AFTER
    // delivery. Without it the response is never acked and gets re-fetched
    // on every poll (the re-fetch loop).
    assert.strictEqual(
      data.imapUid,
      908,
      "should carry imapUid so the Saildocs response email can be acked",
    );
  });
});
