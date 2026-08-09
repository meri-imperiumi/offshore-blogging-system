// Integration tests for encodeBlogPost text/image variant splitting

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs").promises;
const path = require("node:path");
const os = require("node:os");
const {
  encodeBlogPost,
  reassembleChunks,
  decompressText,
  SAIL_DICT,
} = require("../plugin/index.js");

const POST = `---
title: Day at Sea
date: 2026-08-08
---
We had a wonderful day sailing. The wind was steady.

![Afternoon cruise](../2026/20260716_113823(0).jpg)

Sunset was beautiful over the horizon.`;

let tmpDir;
let blogPath;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "obs-blog-"));
  blogPath = tmpDir;
  await fs.mkdir(path.join(tmpDir, "_logs"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "_logs", "2026-08-08.md"),
    POST,
    "utf-8",
  );
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// Reassemble a list of chunk strings back into the original compressed bytes
function reassemble(messages) {
  const entries = {};
  for (const chunk of messages) {
    const match = chunk.match(/^.{4}T(\d{2})(\d{2})([0-9a-f]{4}):(.*)$/);
    assert.ok(match, `chunk didn't match: ${chunk}`);
    const [, idx, total, crc, data] = match;
    entries[parseInt(idx, 10)] = {
      total: parseInt(total, 10),
      crc,
      data,
    };
  }
  return reassembleChunks(entries);
}

describe("encodeBlogPost text variants", () => {
  it("produces both textMessages and fullTextMessages", async () => {
    const result = await encodeBlogPost(
      "2026-08-08",
      "0808",
      5,
      null,
      blogPath,
      [], // don't try to encode the (nonexistent) image files
    );

    assert.ok(Array.isArray(result.textMessages));
    assert.ok(Array.isArray(result.fullTextMessages));
    assert.ok(result.textMessages.length > 0);
    assert.ok(result.fullTextMessages.length > 0);
    assert.deepStrictEqual(result.imageMessages, []);
  });

  it("text-only body has image markdown stripped", async () => {
    const result = await encodeBlogPost(
      "2026-08-08",
      "0808",
      5,
      null,
      blogPath,
      [],
    );

    const compressed = reassemble(result.textMessages);
    const { body } = decompressText(compressed, SAIL_DICT);
    assert.ok(!body.includes("!["), "text-only body should have no image tag");
    assert.ok(!body.includes("20260716_113823"), "image path should be gone");
    assert.ok(body.includes("wonderful day sailing"));
    assert.ok(body.includes("Sunset was beautiful"));
  });

  it("full body retains image markdown for the image variant", async () => {
    const result = await encodeBlogPost(
      "2026-08-08",
      "0808",
      5,
      null,
      blogPath,
      [],
    );

    const compressed = reassemble(result.fullTextMessages);
    const { body } = decompressText(compressed, SAIL_DICT);
    assert.ok(body.includes("!["), "full body should keep image tag");
    assert.ok(
      body.includes("20260716_113823(0).jpg"),
      "full body should keep image path",
    );
  });

  it("stripping reduces or equals the text-only message count", async () => {
    const result = await encodeBlogPost(
      "2026-08-08",
      "0808",
      5,
      null,
      blogPath,
      [],
    );
    assert.ok(
      result.textMessages.length <= result.fullTextMessages.length,
      "text-only should need <= messages of full body",
    );
  });

  it("totalMessages reflects the image variant (full text + images)", async () => {
    const result = await encodeBlogPost(
      "2026-08-08",
      "0808",
      5,
      null,
      blogPath,
      [],
    );
    assert.strictEqual(
      result.totalMessages,
      result.fullTextMessages.length + result.imageMessages.length,
    );
  });
});
