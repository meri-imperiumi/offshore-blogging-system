// Smoketests for the blog encoding being opt-in (disabled by default)

const { test } = require("node:test");
const assert = require("node:assert");

const mockApp = {
  debug: () => {},
  error: () => {},
  warn: () => {},
  setPluginStatus: () => {},
  plugins: {},
};

function mockRouter() {
  const handlers = {};
  const router = {
    get: (p, h) => {
      handlers[`GET ${p}`] = h;
    },
    post: (p, h) => {
      handlers[`POST ${p}`] = h;
    },
  };
  return { router, handlers };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    sendFile() {},
  };
}

async function setupPlugin(config) {
  // Require a fresh module instance per test so plugin config doesn't leak
  const path = require("node:path");
  delete require.cache[path.resolve(__dirname, "..", "plugin", "index.js")];
  const factory = require("../plugin/index.js");
  const plugin = factory(mockApp);
  await plugin.start(config);
  const { router, handlers } = mockRouter();
  plugin.registerWithRouter(router);
  return { plugin, handlers };
}

test("status endpoint reports blog disabled by default", async () => {
  const { handlers } = await setupPlugin({});
  const res = mockRes();
  await handlers["GET /api/status"]({}, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.blogEnabled, false);
});

test("status endpoint reports blog enabled when configured", async () => {
  const { handlers } = await setupPlugin({ enableBlogEncoding: true });
  const res = mockRes();
  await handlers["GET /api/status"]({}, res);
  assert.strictEqual(res.body.blogEnabled, true);
});

test("encode endpoint is rejected (403) when blog not enabled", async () => {
  const { handlers } = await setupPlugin({});
  const res = mockRes();
  await handlers["POST /api/encode"]({ body: { filename: "2026-08-08" } }, res);
  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.error, /not enabled/i);
});

test("preview-images endpoint is rejected (403) when blog not enabled", async () => {
  const { handlers } = await setupPlugin({});
  const res = mockRes();
  await handlers["POST /api/preview-images"](
    { body: { filename: "2026-08-08" } },
    res,
  );
  assert.strictEqual(res.statusCode, 403);
});

test("sign endpoint is rejected (403) when blog not enabled", async () => {
  const { handlers } = await setupPlugin({});
  const res = mockRes();
  await handlers["POST /api/sign"]({ body: { filename: "2026-08-08" } }, res);
  assert.strictEqual(res.statusCode, 403);
});

test("encode endpoint does not 403 when blog is enabled", async () => {
  const { handlers } = await setupPlugin({ enableBlogEncoding: true });
  const res = mockRes();
  await handlers["POST /api/encode"]({ body: { filename: "2026-08-08" } }, res);
  // With blog enabled it proceeds to read the (nonexistent) markdown file,
  // so it should fail with 500, not the opt-in 403.
  assert.notStrictEqual(res.statusCode, 403);
});

// --- GRIB store endpoints (server-side assembly + persistence) ---

// A richer res mock that records sendFile + headers (download path needs them).
function mockResFull() {
  return {
    statusCode: 200,
    body: null,
    sentFile: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
    sendFile(p) {
      this.sentFile = p;
    },
  };
}

// Build compact-header type-G chunks for a fake GRIB binary.
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

test("status endpoint reports gribStoreEnabled", async () => {
  const { handlers } = await setupPlugin({});
  const res = mockRes();
  await handlers["GET /api/status"]({}, res);
  assert.strictEqual(res.body.gribStoreEnabled, true);
});

test("assemble endpoint rejects missing chunks array with 400", async () => {
  const { handlers } = await setupPlugin({});
  const res = mockRes();
  await handlers["POST /api/grib/assemble"]({ body: {} }, res);
  assert.strictEqual(res.statusCode, 400);
});

test("assemble persists a GRIB and list returns it latest-first", async () => {
  const fs = require("node:fs").promises;
  const os = require("node:os");
  const path = require("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-grib-"));
  try {
    const { handlers } = await setupPlugin({ gribStoragePath: dir });

    const grib = Buffer.concat([
      Buffer.from("GRIB", "ascii"),
      Buffer.alloc(200, 0x41),
    ]);
    const chunks = makeGribChunks("plug", grib);

    const assembleRes = mockRes();
    await handlers["POST /api/grib/assemble"](
      { body: { chunks } },
      assembleRes,
    );
    assert.strictEqual(assembleRes.statusCode, 200, assembleRes.body?.error);
    assert.strictEqual(assembleRes.body.grib.transmissionId, "plug");
    assert.strictEqual(assembleRes.body.grib.size, grib.length);

    const listRes = mockRes();
    await handlers["GET /api/gribs"]({}, listRes);
    assert.strictEqual(listRes.statusCode, 200);
    assert.ok(listRes.body.gribs.some((g) => g.transmissionId === "plug"));
    assert.strictEqual(listRes.body.gribs[0].transmissionId, "plug");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("assemble reports missing chunks with 409", async () => {
  const { handlers } = await setupPlugin({});
  const grib = Buffer.concat([
    Buffer.from("GRIB", "ascii"),
    Buffer.alloc(300, 0x41),
  ]);
  const chunks = makeGribChunks("miss", grib);
  const incomplete = [chunks[0], ...chunks.slice(2)];
  const res = mockRes();
  await handlers["POST /api/grib/assemble"](
    { body: { chunks: incomplete } },
    res,
  );
  assert.strictEqual(res.statusCode, 409);
  assert.ok(Array.isArray(res.body.missing));
});

test("assemble rejects bad GRIB magic with 422", async () => {
  const { handlers } = await setupPlugin({});
  const bad = Buffer.concat([
    Buffer.from("XXXX", "ascii"),
    Buffer.alloc(100, 0x41),
  ]);
  const res = mockRes();
  await handlers["POST /api/grib/assemble"](
    { body: { chunks: makeGribChunks("badm", bad) } },
    res,
  );
  assert.strictEqual(res.statusCode, 422);
});

test("download sends the persisted .grb file", async () => {
  const fs = require("node:fs").promises;
  const os = require("node:os");
  const path = require("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-grib-dl-"));
  try {
    const { handlers } = await setupPlugin({ gribStoragePath: dir });
    const grib = Buffer.concat([
      Buffer.from("GRIB", "ascii"),
      Buffer.alloc(50, 0x42),
    ]);
    await handlers["POST /api/grib/assemble"](
      { body: { chunks: makeGribChunks("dl01", grib) } },
      mockRes(),
    );

    const dlRes = mockResFull();
    await handlers["GET /api/gribs/:id/download"](
      { params: { id: "dl01" } },
      dlRes,
    );
    assert.strictEqual(dlRes.statusCode, 200);
    assert.ok(dlRes.sentFile.endsWith("dl01.grb"));
    assert.strictEqual(
      dlRes.headers["Content-Disposition"],
      'attachment; filename="dl01.grb"',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("download 404s for an unknown id", async () => {
  const { handlers } = await setupPlugin({});
  const res = mockRes();
  await handlers["GET /api/gribs/:id/download"](
    { params: { id: "nope" } },
    res,
  );
  assert.strictEqual(res.statusCode, 404);
});

test("download rejects an invalid id with 400", async () => {
  const { handlers } = await setupPlugin({});
  const res = mockRes();
  await handlers["GET /api/gribs/:id/download"](
    { params: { id: "../etc" } },
    res,
  );
  assert.strictEqual(res.statusCode, 400);
});

test("download sets application/x-grib Content-Type for GRIB1", async () => {
  const fs = require("node:fs").promises;
  const os = require("node:os");
  const path = require("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-grib-mime-"));
  try {
    const { handlers } = await setupPlugin({ gribStoragePath: dir });
    // Build a minimal GRIB1 file (edition = 1 at byte 8)
    // GRIB format: "GRIB" + length (4 bytes) + edition (1 byte)
    const grib1 = Buffer.concat([
      Buffer.from("GRIB", "ascii"),
      Buffer.from([0x00, 0x00, 0x00, 59]), // total length
      Buffer.from([0x01]), // edition 1
      Buffer.alloc(50, 0x42),
    ]);
    await handlers["POST /api/grib/assemble"](
      { body: { chunks: makeGribChunks("g1mt", grib1) } },
      mockRes(),
    );

    const dlRes = mockResFull();
    await handlers["GET /api/gribs/:id/download"](
      { params: { id: "g1mt" } },
      dlRes,
    );
    assert.strictEqual(dlRes.statusCode, 200);
    assert.strictEqual(dlRes.headers["Content-Type"], "application/x-grib");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("download sets application/x-grib2 Content-Type for GRIB2", async () => {
  const fs = require("node:fs").promises;
  const os = require("node:os");
  const path = require("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-grib-mime2-"));
  try {
    const { handlers } = await setupPlugin({ gribStoragePath: dir });
    // Build a minimal GRIB2 file (edition = 2 at byte 8)
    // GRIB format: "GRIB" + length (4 bytes) + edition (1 byte)
    const grib2 = Buffer.concat([
      Buffer.from("GRIB", "ascii"),
      Buffer.from([0x00, 0x00, 0x00, 59]), // total length
      Buffer.from([0x02]), // edition 2
      Buffer.alloc(50, 0x42),
    ]);
    await handlers["POST /api/grib/assemble"](
      { body: { chunks: makeGribChunks("g2mt", grib2) } },
      mockRes(),
    );

    const dlRes = mockResFull();
    await handlers["GET /api/gribs/:id/download"](
      { params: { id: "g2mt" } },
      dlRes,
    );
    assert.strictEqual(dlRes.statusCode, 200);
    assert.strictEqual(dlRes.headers["Content-Type"], "application/x-grib2");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- Direct GRIB upload (Winlink/Saildocs path) ---

function makeGribBinary(payloadLen, edition = 2) {
  return Buffer.concat([
    Buffer.from("GRIB", "ascii"),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from([edition]), // edition byte at offset 7
    Buffer.alloc(payloadLen, 0x43), // 'C'
  ]);
}

test("upload via JSON gribBase64 persists and lists a GRIB", async () => {
  const fs = require("node:fs").promises;
  const os = require("node:os");
  const path = require("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-grib-up1-"));
  try {
    const { handlers } = await setupPlugin({ gribStoragePath: dir });
    const grib = makeGribBinary(200);
    const req = {
      headers: { "content-type": "application/json" },
      body: { gribBase64: grib.toString("base64") },
      query: { filename: "saildocs-wind.grb" },
    };
    const res = mockRes();
    await handlers["POST /api/grib/upload"](req, res);
    assert.strictEqual(res.statusCode, 201, res.body?.error);
    assert.strictEqual(res.body.ok, true);
    const g = res.body.grib;
    assert.strictEqual(g.size, grib.length);
    assert.strictEqual(g.source, "upload");
    assert.strictEqual(g.totalChunks, null);
    assert.strictEqual(g.originalFilename, "saildocs-wind.grb");
    assert.match(g.transmissionId, /^[a-zA-Z0-9]{4}$/);

    // File exists on disk in the source subdirectory.
    const filepath = path.join(dir, "inreach", `${g.transmissionId}.grb`);
    const onDisk = await fs.readFile(filepath);
    assert.strictEqual(onDisk.subarray(0, 4).toString("ascii"), "GRIB");

    // Listing includes it.
    const listRes = mockRes();
    await handlers["GET /api/gribs"]({}, listRes);
    assert.ok(
      listRes.body.gribs.some((e) => e.transmissionId === g.transmissionId),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("upload via raw octet-stream body persists a GRIB", async () => {
  const fs = require("node:fs").promises;
  const os = require("node:os");
  const path = require("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-grib-up2-"));
  try {
    const { handlers } = await setupPlugin({ gribStoragePath: dir });
    const grib = makeGribBinary(150, 1);
    const req = {
      headers: { "content-type": "application/octet-stream" },
      body: grib, // raw Buffer as body
      query: { id: "up01", filename: "gfs.grb" },
    };
    const res = mockRes();
    await handlers["POST /api/grib/upload"](req, res);
    assert.strictEqual(res.statusCode, 201, res.body?.error);
    assert.strictEqual(res.body.grib.transmissionId, "up01");
    assert.strictEqual(res.body.grib.originalFilename, "gfs.grb");

    const onDisk = await fs.readFile(path.join(dir, "inreach", "up01.grb"));
    assert.deepStrictEqual(onDisk, grib);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("upload dedups the same GRIB (same derived id)", async () => {
  const fs = require("node:fs").promises;
  const os = require("node:os");
  const path = require("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-grib-up3-"));
  try {
    const { handlers } = await setupPlugin({ gribStoragePath: dir });
    const grib = makeGribBinary(300);
    const req = {
      headers: { "content-type": "application/json" },
      body: { gribBase64: grib.toString("base64") },
      query: {},
    };
    const r1 = mockRes();
    await handlers["POST /api/grib/upload"](req, r1);
    assert.strictEqual(r1.statusCode, 201);
    await new Promise((r) => setTimeout(r, 5));
    const r2 = mockRes();
    await handlers["POST /api/grib/upload"](req, r2);
    assert.strictEqual(r2.statusCode, 201);
    assert.strictEqual(
      r1.body.grib.transmissionId,
      r2.body.grib.transmissionId,
    );
    const listRes = mockRes();
    await handlers["GET /api/gribs"]({}, listRes);
    assert.strictEqual(listRes.body.gribs.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("upload rejects non-GRIB bytes with 422", async () => {
  const { handlers } = await setupPlugin({});
  const bad = Buffer.concat([
    Buffer.from("XXXX", "ascii"),
    Buffer.alloc(100, 0x41),
  ]);
  const req = {
    headers: { "content-type": "application/json" },
    body: { gribBase64: bad.toString("base64") },
    query: {},
  };
  const res = mockRes();
  await handlers["POST /api/grib/upload"](req, res);
  assert.strictEqual(res.statusCode, 422);
});

test("upload rejects empty JSON body with 400", async () => {
  const { handlers } = await setupPlugin({});
  const req = {
    headers: { "content-type": "application/json" },
    body: {},
    query: {},
  };
  const res = mockRes();
  await handlers["POST /api/grib/upload"](req, res);
  assert.strictEqual(res.statusCode, 400);
});

test("upload rejects invalid explicit id with 400", async () => {
  const { handlers } = await setupPlugin({});
  const grib = makeGribBinary(100);
  const req = {
    headers: { "content-type": "application/json" },
    body: { gribBase64: grib.toString("base64") },
    query: { id: "../etc" },
  };
  const res = mockRes();
  await handlers["POST /api/grib/upload"](req, res);
  assert.strictEqual(res.statusCode, 400);
});
