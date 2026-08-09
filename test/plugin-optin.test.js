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
