import assert from "node:assert";
import fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import DatabaseHelper from "../lib/DbHelper.js";

describe("DatabaseHelper", () => {
  let db;
  const testSchemaPath = "./test/fixtures/test-schema.sql";

  beforeEach(() => {
    // Create a test schema file
    if (!fs.existsSync("./test/fixtures")) {
      fs.mkdirSync("./test/fixtures", { recursive: true });
    }
    fs.writeFileSync(
      testSchemaPath,
      `
      CREATE TABLE IF NOT EXISTS test_table (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
    );
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    if (fs.existsSync(testSchemaPath)) {
      fs.unlinkSync(testSchemaPath);
    }
  });

  it("should initialize with :memory: database", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize(testSchemaPath);

    assert.ok(db.db, "Database should be initialized");
    assert.strictEqual(db.dbPath, ":memory:");
  });

  it("should execute simple queries", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize(testSchemaPath);

    db.run("INSERT INTO test_table (value) VALUES (?)", ["test-value"]);

    const result = db.get("SELECT * FROM test_table WHERE id = ?", [1]);
    assert.strictEqual(result.value, "test-value");
  });

  it("should handle all() queries", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize(testSchemaPath);

    db.run("INSERT INTO test_table (value) VALUES (?)", ["value1"]);
    db.run("INSERT INTO test_table (value) VALUES (?)", ["value2"]);

    const results = db.all("SELECT * FROM test_table ORDER BY id");
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].value, "value1");
    assert.strictEqual(results[1].value, "value2");
  });

  it("should handle buffer chunk operations", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize(); // Initialize without custom schema, will use default

    // Save a chunk
    db.saveBufferChunk(
      "test-identity",
      "test-transmission",
      "text",
      1,
      3,
      "test@example.com",
      "inreach",
      "payload-data",
    );

    // Retrieve chunks
    const chunks = db.getBufferChunks(
      "test-identity",
      "test-transmission",
      "text",
    );
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].chunk_index, 1);
    assert.strictEqual(chunks[0].total_chunks, 3);
    assert.strictEqual(chunks[0].payload, "payload-data");
  });

  it("should handle multiple buffer chunks and reassembly", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize();

    // Save multiple chunks
    db.saveBufferChunk(
      "test-id",
      "test-tx",
      "text",
      1,
      3,
      "reply@test.com",
      "winlink",
      "chunk1",
    );
    db.saveBufferChunk(
      "test-id",
      "test-tx",
      "text",
      2,
      3,
      "reply@test.com",
      "winlink",
      "chunk2",
    );
    db.saveBufferChunk(
      "test-id",
      "test-tx",
      "text",
      3,
      3,
      "reply@test.com",
      "winlink",
      "chunk3",
    );

    // Retrieve in order
    const chunks = db.getBufferChunks("test-id", "test-tx", "text");
    assert.strictEqual(chunks.length, 3);
    assert.strictEqual(chunks[0].chunk_index, 1);
    assert.strictEqual(chunks[1].chunk_index, 2);
    assert.strictEqual(chunks[2].chunk_index, 3);
  });

  it("should handle different part types independently", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize();

    // Save text chunks
    db.saveBufferChunk(
      "test-id",
      "test-tx",
      "text",
      1,
      2,
      "reply@test.com",
      "inreach",
      "text1",
    );
    db.saveBufferChunk(
      "test-id",
      "test-tx",
      "text",
      2,
      2,
      "reply@test.com",
      "inreach",
      "text2",
    );

    // Save image chunks with same transmissionId
    db.saveBufferChunk(
      "test-id",
      "test-tx",
      "image",
      1,
      2,
      "reply@test.com",
      "inreach",
      "image1",
    );
    db.saveBufferChunk(
      "test-id",
      "test-tx",
      "image",
      2,
      2,
      "reply@test.com",
      "inreach",
      "image2",
    );

    // Retrieve text chunks
    const textChunks = db.getBufferChunks("test-id", "test-tx", "text");
    assert.strictEqual(textChunks.length, 2);

    // Retrieve image chunks
    const imageChunks = db.getBufferChunks("test-id", "test-tx", "image");
    assert.strictEqual(imageChunks.length, 2);
  });

  it("should delete buffer chunks", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize();

    // Save chunks
    db.saveBufferChunk(
      "test-id",
      "test-tx",
      "text",
      1,
      2,
      "reply@test.com",
      "inreach",
      "chunk1",
    );
    db.saveBufferChunk(
      "test-id",
      "test-tx",
      "text",
      2,
      2,
      "reply@test.com",
      "inreach",
      "chunk2",
    );

    // Delete all for transmission
    db.deleteBufferChunks("test-id", "test-tx");

    const chunks = db.getBufferChunks("test-id", "test-tx", "text");
    assert.strictEqual(chunks.length, 0);
  });

  it("should delete buffer chunks by part type", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize();

    // Save text and image chunks
    db.saveBufferChunk(
      "test-id",
      "test-tx",
      "text",
      1,
      1,
      "reply@test.com",
      "inreach",
      "text1",
    );
    db.saveBufferChunk(
      "test-id",
      "test-tx",
      "image",
      1,
      1,
      "reply@test.com",
      "inreach",
      "image1",
    );

    // Delete only text chunks
    db.deleteBufferChunks("test-id", "test-tx", "text");

    // Text should be gone, image should remain
    const textChunks = db.getBufferChunks("test-id", "test-tx", "text");
    const imageChunks = db.getBufferChunks("test-id", "test-tx", "image");
    assert.strictEqual(textChunks.length, 0);
    assert.strictEqual(imageChunks.length, 1);
  });

  it("should save and retrieve GRIB gate", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize();

    const chunkPayloads = ["chunk1", "chunk2", "chunk3"];
    db.saveGribGate(
      "test-id",
      "G12",
      "reply@test.com",
      "inreach",
      chunkPayloads,
    );

    const gate = db.getGribGate("test-id", "G12");
    assert.ok(gate);
    assert.strictEqual(gate.gate_id, "G12");
    assert.deepStrictEqual(gate.chunk_payloads, chunkPayloads);
  });

  it("should save and delete GRIB gate", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize();

    db.saveGribGate("test-id", "G12", "reply@test.com", "inreach", ["chunk1"]);
    db.deleteGribGate("test-id", "G12");

    const gate = db.getGribGate("test-id", "G12");
    assert.strictEqual(gate, undefined);
  });

  it("should save and retrieve pending Saildocs", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize();

    db.savePendingSaildocs("query-123", "test-id", "reply@test.com", "winlink");

    const pending = db.getPendingSaildocs("query-123");
    assert.ok(pending);
    assert.strictEqual(pending.query_id, "query-123");
    assert.strictEqual(pending.identity_hash, "test-id");
    assert.strictEqual(pending.channel, "winlink");
  });

  it("should delete pending Saildocs", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize();

    db.savePendingSaildocs("query-123", "test-id", "reply@test.com", "winlink");
    db.deletePendingSaildocs("query-123");

    const pending = db.getPendingSaildocs("query-123");
    assert.strictEqual(pending, undefined);
  });

  it("should count pending GRIB gates", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize();

    assert.strictEqual(db.countGribGates(), 0);
    db.saveGribGate("id-a", "G1", "r@x.com", "inreach", ["c1"]);
    db.saveGribGate("id-b", "G2", "r@x.com", "winlink", ["c1", "c2"]);
    assert.strictEqual(db.countGribGates(), 2);
    // Deleting one drops the count, independent of identity.
    db.deleteGribGate("id-a", "G1");
    assert.strictEqual(db.countGribGates(), 1);
  });

  it("should count pending Saildocs queries", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize();

    assert.strictEqual(db.countPendingSaildocs(), 0);
    db.savePendingSaildocs("q1", "id-a", "r@x.com", "winlink");
    db.savePendingSaildocs("q2", "id-b", "r@x.com", "inreach");
    assert.strictEqual(db.countPendingSaildocs(), 2);
    db.deletePendingSaildocs("q1");
    assert.strictEqual(db.countPendingSaildocs(), 1);
  });

  it("stores query_text and matches a pending Saildocs reply by subject", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize();

    // Saildocs echoes the query's model:area as the reply subject, so we
    // store the exact submitted query and match on its model:area prefix.
    db.savePendingSaildocs(
      "q1",
      "id-a",
      "captain@boat.sea",
      "winlink",
      "gfs:58n,60n,018e,022e|2,2|0,12|wind",
    );

    const pending = db.getPendingSaildocsBySubject("gfs:58n,60n,018e,022e");
    assert.ok(pending, "should match by the model:area prefix");
    assert.strictEqual(pending.query_id, "q1");
    assert.strictEqual(pending.identity_hash, "id-a");
    assert.strictEqual(pending.channel, "winlink");
    assert.strictEqual(
      pending.query_text,
      "gfs:58n,60n,018e,022e|2,2|0,12|wind",
    );
  });

  it("does not cross concurrent requests with different areas", () => {
    // The Buddy Boat (Dacar-grant) case: a second identity has a request in
    // flight. Matching on the echoed subject must NOT deliver the reply to
    // the wrong recipient the way the old "most recent" fallback did.
    db = new DatabaseHelper(":memory:");
    db.initialize();

    db.savePendingSaildocs(
      "q-boat-a",
      "id-a",
      "captain@boat-a.sea",
      "winlink",
      "gfs:58n,60n,018e,022e|2,2|0,12|wind",
    );
    db.savePendingSaildocs(
      "q-boat-b",
      "id-b",
      "skipper@boat-b.sea",
      "inreach",
      "gfs:10n,20n,60w,50w|2,2|0,12|wind",
    );

    const replyA = db.getPendingSaildocsBySubject("gfs:58n,60n,018e,022e");
    assert.ok(replyA);
    assert.strictEqual(replyA.identity_hash, "id-a");
    assert.strictEqual(replyA.reply_to, "captain@boat-a.sea");

    const replyB = db.getPendingSaildocsBySubject("gfs:10n,20n,60w,50w");
    assert.ok(replyB);
    assert.strictEqual(replyB.identity_hash, "id-b");
    assert.strictEqual(replyB.reply_to, "skipper@boat-b.sea");
  });

  it("matches case-insensitively (Saildocs lowercases the subject)", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize();

    db.savePendingSaildocs(
      "q1",
      "id-a",
      "r@x.com",
      "inreach",
      "GFS:58N,60N,018E,022E|2,2|0,12|WIND",
    );
    const pending = db.getPendingSaildocsBySubject("gfs:58n,60n,018e,022e");
    assert.ok(pending);
    assert.strictEqual(pending.query_id, "q1");
  });

  it("returns null from subject match when no query_text matches", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize();
    // A row saved without query_text (legacy caller) must not match by subject.
    db.savePendingSaildocs("q1", "id-a", "r@x.com", "winlink");
    assert.strictEqual(
      db.getPendingSaildocsBySubject("gfs:58n,60n,018e,022e"),
      null,
    );
  });

  it("migrates an existing pending_saildocs table to add query_text", () => {
    // Simulate a pre-migration database: create the table WITHOUT query_text,
    // then migrate() must add it. Idempotent: running twice must not error.
    db = new DatabaseHelper(":memory:");
    db.initialize();
    db.run("DROP TABLE pending_saildocs");
    db.run(`CREATE TABLE pending_saildocs (
      query_id TEXT PRIMARY KEY,
      identity_hash TEXT NOT NULL,
      reply_to TEXT NOT NULL,
      channel TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    db.migrate();
    db.migrate();

    const cols = db.all("PRAGMA table_info(pending_saildocs)");
    assert.ok(cols.some((c) => c.name === "query_text"));

    // Saving with query_text now works on the migrated table.
    db.savePendingSaildocs(
      "q1",
      "id-a",
      "r@x.com",
      "winlink",
      "gfs:1n,2n,3e,4e|x",
    );
    const row = db.getPendingSaildocs("q1");
    assert.strictEqual(row.query_text, "gfs:1n,2n,3e,4e|x");
  });

  it("reports whether buffered chunks exist for a transmission id", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize();
    db.saveBufferChunk("id-a", "tx1", "text", 1, 2, "r@x.com", "winlink", "hi");
    assert.strictEqual(db.hasBufferChunks("id-a", "tx1"), true);
    assert.strictEqual(db.hasBufferChunks("id-a", "tx2"), false);
    assert.strictEqual(db.hasBufferChunks("id-b", "tx1"), false);
    db.deleteBufferChunks("id-a", "tx1");
    assert.strictEqual(db.hasBufferChunks("id-a", "tx1"), false);
  });

  it("should increment metrics", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize();

    db.incrementMetric("blog_posts");
    db.incrementMetric("msg_in");
    db.incrementMetric("msg_in");

    const metrics = db.getMetrics();
    assert.strictEqual(metrics.blog_posts, 1);
    assert.strictEqual(metrics.msg_in, 2);
    assert.strictEqual(metrics.msg_out, 0);
  });

  it("should reject invalid metric type", () => {
    db = new DatabaseHelper(":memory:");
    db.initialize();

    assert.throws(
      () => db.incrementMetric("invalid_type"),
      /Invalid metric type/,
    );
  });
});
