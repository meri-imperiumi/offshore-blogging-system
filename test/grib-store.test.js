// Smoketests for lib/GribStore.js — server-side GRIB assembly & persistence.
//
// The GribStore parses Unified Compact Chunk Header Protocol (work doc #12)
// type-`G` chunks, reassembles the binary, verifies the `GRIB` magic, and
// persists the result so any Signal K user can download it later.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs").promises;
const path = require("node:path");
const os = require("node:os");

const { GribStore, parseCompactChunk } = require("../lib/GribStore.js");

// Helper: build a fake GRIB binary (magic + payload) and chunk it using the
// same compact-header format GribChunker emits: <id>G<idx><total>:<base64>.
function makeGribChunks(transmissionId, binary, maxChunkSize = 96) {
  const b64 = Buffer.from(binary).toString("base64");
  const total = Math.ceil(b64.length / maxChunkSize);
  const out = [];
  for (let i = 0; i < total; i++) {
    const idx = String(i + 1).padStart(2, "0");
    const tot = String(total).padStart(2, "0");
    const piece = b64.slice(i * maxChunkSize, (i + 1) * maxChunkSize);
    out.push(`${transmissionId}G${idx}${tot}:${piece}`);
  }
  return out;
}

function gribBytes(payloadLen) {
  const head = Buffer.from("GRIB", "ascii");
  const body = Buffer.alloc(payloadLen, 0x42); // 'B'
  return Buffer.concat([head, body]);
}

describe("parseCompactChunk", () => {
  it("parses a downlink GRIB chunk (no meta)", () => {
    const p = parseCompactChunk("rqnnG0312:AAAA");
    assert.strictEqual(p.transmissionId, "rqnn");
    assert.strictEqual(p.typeChar, "G");
    assert.strictEqual(p.index, 3);
    assert.strictEqual(p.total, 12);
    assert.strictEqual(p.meta, undefined);
    assert.strictEqual(p.data, "AAAA");
  });

  it("parses an uplink blog chunk (with 4-hex meta/CRC)", () => {
    const p = parseCompactChunk("0715T0102687c:payload");
    assert.strictEqual(p.transmissionId, "0715");
    assert.strictEqual(p.typeChar, "T");
    assert.strictEqual(p.meta, "687c");
    assert.strictEqual(p.data, "payload");
  });

  it("returns null for non-compact input", () => {
    assert.strictEqual(parseCompactChunk("msg 1/3:grib:abc"), null);
    assert.strictEqual(parseCompactChunk("not a chunk"), null);
    assert.strictEqual(parseCompactChunk(undefined), null);
  });
});

describe("GribStore", () => {
  let tmpDir;
  let store;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grib-store-"));
    store = new GribStore(tmpDir);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("assembles a complete multi-chunk GRIB into the original binary", async () => {
    const grib = gribBytes(300); // >1 chunk at size 96
    const chunks = makeGribChunks("abcd", grib);
    assert.ok(chunks.length > 1, "should produce multiple chunks");

    const { binary, magic, transmissionId, total } =
      await store.assemble(chunks);
    assert.strictEqual(magic, "GRIB");
    assert.strictEqual(transmissionId, "abcd");
    assert.strictEqual(total, chunks.length);
    assert.deepStrictEqual(
      Buffer.from(binary.subarray(0, 4)).toString("ascii"),
      "GRIB",
    );
    assert.strictEqual(binary.length, grib.length);
  });

  it("persists a GRIB and lists it latest-first", async () => {
    const grib = gribBytes(200);
    const chunks = makeGribChunks("lst1", grib);
    const entry = await store.persist(chunks);
    assert.strictEqual(entry.transmissionId, "lst1");
    assert.strictEqual(entry.size, grib.length);

    const listed = await store.list();
    assert.ok(listed.some((e) => e.transmissionId === "lst1"));

    // The .grb file exists on disk.
    const filepath = store.getFilePath("lst1");
    const onDisk = await fs.readFile(filepath);
    assert.strictEqual(onDisk.subarray(0, 4).toString("ascii"), "GRIB");
  });

  it("lists multiple persisted GRIBs latest-first (by createdAt desc)", async () => {
    // Use a fresh store so ordering is deterministic.
    const dir = path.join(tmpDir, "ordering");
    const s = new GribStore(dir);
    const a = await s.persist(makeGribChunks("ord1", gribBytes(100)));
    // createdAt resolution is ms; nudge time forward to guarantee ordering.
    await new Promise((r) => setTimeout(r, 5));
    const b = await s.persist(makeGribChunks("ord2", gribBytes(100)));
    const list = await s.list();
    assert.strictEqual(list[0].transmissionId, "ord2");
    assert.strictEqual(list[1].transmissionId, "ord1");
    assert.ok(b.createdAt > a.createdAt);
  });

  it("dedups by transmissionId (re-assembly overwrites, keeps createdAt)", async () => {
    const dir = path.join(tmpDir, "dedup");
    const s = new GribStore(dir);
    const first = await s.persist(makeGribChunks("dup1", gribBytes(120)));
    await new Promise((r) => setTimeout(r, 5));
    const second = await s.persist(makeGribChunks("dup1", gribBytes(120)));
    const list = await s.list();
    assert.strictEqual(list.length, 1, "should not duplicate on re-assembly");
    assert.strictEqual(list[0].transmissionId, "dup1");
    assert.strictEqual(
      list[0].createdAt,
      first.createdAt,
      "createdAt preserved",
    );
    assert.ok(second.updatedAt > first.updatedAt, "updatedAt bumped");
  });

  it("rejects missing chunks with MISSING_CHUNKS and the missing list", async () => {
    const chunks = makeGribChunks("miss", gribBytes(300));
    // Drop the middle chunk.
    const incomplete = [chunks[0], ...chunks.slice(2)];
    await assert.rejects(
      () => store.assemble(incomplete),
      (err) => err.code === "MISSING_CHUNKS" && err.missing.length > 0,
    );
  });

  it("rejects bad GRIB magic with BAD_MAGIC", async () => {
    const bad = Buffer.concat([
      Buffer.from("XXXX", "ascii"),
      Buffer.alloc(100, 0x41),
    ]);
    const chunks = makeGribChunks("badm", bad);
    await assert.rejects(
      () => store.assemble(chunks),
      (err) => err.code === "BAD_MAGIC",
    );
  });

  it("rejects non-GRIB compact chunks with NOT_GRIB", async () => {
    // A type-T (text) chunk using the compact format.
    const textChunk = "1234T0101000a:hello";
    await assert.rejects(
      () => store.assemble([textChunk]),
      (err) => err.code === "NOT_GRIB",
    );
  });

  it("rejects unrecognized chunk format with BAD_FORMAT", async () => {
    await assert.rejects(
      () => store.assemble(["msg 1/2:grib:abc\ndata"]), // deprecated lo-fi
      (err) => err.code === "BAD_FORMAT",
    );
  });

  it("rejects empty input with BAD_FORMAT", async () => {
    await assert.rejects(
      () => store.assemble([]),
      (err) => err.code === "BAD_FORMAT",
    );
  });

  it("getFilePath rejects invalid ids (path-traversal guard)", () => {
    assert.throws(
      () => store.getFilePath("../etc"),
      (err) => err.code === "BAD_ID",
    );
    assert.throws(
      () => store.getFilePath("ab"),
      (err) => err.code === "BAD_ID",
    );
    // A valid 4-char id resolves cleanly.
    assert.ok(store.getFilePath("ab12").endsWith("ab12.grb"));
  });

  it("survives a missing/corrupt manifest (treats as empty)", async () => {
    const dir = path.join(tmpDir, "corrupt");
    const s = new GribStore(dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), "{ not json");
    const list = await s.list();
    assert.deepStrictEqual(list, []);
  });
});
