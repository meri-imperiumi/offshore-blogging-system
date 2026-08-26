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

  it("stores GRIBs in source subdirectory (signalk-grib-weather-provider compatible)", async () => {
    const dir = path.join(tmpDir, "subdir-test");
    const sourceName = "inreach";
    const s = new GribStore(dir, sourceName);
    const grib = gribBytes(200);
    const chunks = makeGribChunks("tst1", grib);
    await s.persist(chunks);

    // GRIB file is in the source subdirectory
    const gribPath = s.getFilePath("tst1");
    assert.ok(
      gribPath.includes(path.join(dir, sourceName, "tst1.grb")),
      `GRIB should be in ${path.join(dir, sourceName)}/, got ${gribPath}`,
    );

    // Verify file exists and has correct content
    const onDisk = await fs.readFile(gribPath);
    assert.strictEqual(onDisk.subarray(0, 4).toString("ascii"), "GRIB");
    assert.strictEqual(onDisk.length, grib.length);

    // Manifest is in the root directory
    const manifestPath = path.join(dir, "manifest.json");
    const manifestExists = await fs
      .access(manifestPath)
      .then(() => true)
      .catch(() => false);
    assert.ok(manifestExists, "manifest.json should be in root directory");
  });
});

describe("GribStore direct binary upload (Winlink/Saildocs path)", () => {
  let tmpDir;
  let store;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grib-store-bin-"));
    store = new GribStore(tmpDir, "inreach");
  });
  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("verifyGrib accepts a GRIB2 buffer and returns the edition", () => {
    const g2 = Buffer.concat([
      Buffer.from("GRIB", "ascii"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from([0x02]),
      Buffer.alloc(40, 0x44),
    ]);
    const r = store.verifyGrib(g2);
    assert.strictEqual(r.magic, "GRIB");
    assert.strictEqual(r.edition, 2);
  });

  it("verifyGrib accepts a GRIB1 buffer", () => {
    const g1 = Buffer.concat([
      Buffer.from("GRIB", "ascii"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from([0x01]),
      Buffer.alloc(40, 0x44),
    ]);
    assert.strictEqual(store.verifyGrib(g1).edition, 1);
  });

  it("verifyGrib rejects bad magic with BAD_MAGIC", () => {
    const bad = Buffer.concat([
      Buffer.from("XXXX", "ascii"),
      Buffer.alloc(40, 0x44),
    ]);
    assert.throws(
      () => store.verifyGrib(bad),
      (err) => err.code === "BAD_MAGIC",
    );
  });

  it("verifyGrib rejects too-short buffers with BAD_FORMAT", () => {
    assert.throws(
      () => store.verifyGrib(Buffer.from("GRIB")),
      (err) => err.code === "BAD_FORMAT",
    );
    assert.throws(
      () => store.verifyGrib(Buffer.alloc(4)),
      (err) => err.code === "BAD_FORMAT",
    );
  });

  it("deriveId is deterministic and 4-char Base62", () => {
    const a = gribBytes(250);
    const b = gribBytes(250);
    assert.strictEqual(store.deriveId(a), store.deriveId(a));
    assert.match(store.deriveId(a), /^[a-zA-Z0-9]{4}$/);
    // Different content yields (very likely) a different id.
    const other = gribBytes(251);
    // Not asserting inequality (collisions are possible) — just that it ran.
    assert.ok(typeof store.deriveId(other) === "string");
  });

  it("persistBinary stores a complete GRIB and records source='upload'", async () => {
    const grib = gribBytes(220);
    const entry = await store.persistBinary(grib, {
      filename: "saildocs.grb",
      requestedBy: "operator",
    });
    assert.match(entry.transmissionId, /^[a-zA-Z0-9]{4}$/);
    assert.strictEqual(entry.size, grib.length);
    assert.strictEqual(entry.source, "upload");
    assert.strictEqual(entry.totalChunks, null);
    assert.strictEqual(entry.originalFilename, "saildocs.grb");
    assert.strictEqual(entry.requestedBy, "operator");

    const onDisk = await fs.readFile(store.getFilePath(entry.transmissionId));
    assert.deepStrictEqual(onDisk, grib);
  });

  it("persistBinary dedups same content (same derived id)", async () => {
    const dir = path.join(tmpDir, "dedup-bin");
    const s = new GribStore(dir, "inreach");
    const grib = gribBytes(180);
    const e1 = await s.persistBinary(grib);
    await new Promise((r) => setTimeout(r, 5));
    const e2 = await s.persistBinary(grib);
    assert.strictEqual(e1.transmissionId, e2.transmissionId);
    assert.strictEqual(e1.createdAt, e2.createdAt);
    assert.ok(e2.updatedAt >= e1.updatedAt);
    const list = await s.list();
    assert.strictEqual(list.length, 1);
  });

  it("persistBinary accepts an explicit id", async () => {
    const dir = path.join(tmpDir, "explicit-id");
    const s = new GribStore(dir, "inreach");
    const entry = await s.persistBinary(gribBytes(120), { id: "wlnk" });
    assert.strictEqual(entry.transmissionId, "wlnk");
  });

  it("persistBinary rejects an invalid explicit id with BAD_ID", async () => {
    await assert.rejects(
      () => store.persistBinary(gribBytes(120), { id: "../x" }),
      (err) => err.code === "BAD_ID",
    );
  });

  it("persistBinary rejects bad magic with BAD_MAGIC", async () => {
    const bad = Buffer.concat([
      Buffer.from("XXXX", "ascii"),
      Buffer.alloc(120, 0x41),
    ]);
    await assert.rejects(
      () => store.persistBinary(bad),
      (err) => err.code === "BAD_MAGIC",
    );
  });

  it("uploaded GRIB lands in the source subdirectory (provider-compatible)", async () => {
    const dir = path.join(tmpDir, "provider-compat");
    const sourceName = "inreach";
    const s = new GribStore(dir, sourceName);
    const entry = await s.persistBinary(gribBytes(140), { id: "pv01" });
    const filepath = s.getFilePath(entry.transmissionId);
    assert.ok(
      filepath.includes(path.join(dir, sourceName, "pv01.grb")),
      `expected under ${path.join(dir, sourceName)}/, got ${filepath}`,
    );
    const onDisk = await fs.readFile(filepath);
    assert.strictEqual(onDisk.subarray(0, 4).toString("ascii"), "GRIB");
  });
});
