// Tests for GitPublisher: writing a decoded blog post (markdown + watermarked
// image) to disk. Uses a plain temp directory (no git repo), so no
// commit/push occurs — disk writing only.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const fsp = require("node:fs").promises;
const path = require("node:path");
const os = require("node:os");
const { getComponent } = require("../components/GitPublisher.js");
const sharp = require("sharp");

let tmpDir;

before(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "obs-gitpub-"));
});

after(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// Drive one handle() call with the given data message + control ports.
function runPublish(component, msg, controls = {}) {
  const ports = new Map(Object.entries(controls));
  ports.set("in", msg);
  return new Promise((resolve) => {
    component.handle(
      {
        hasData: (p) => ports.has(p),
        getData: (p) => ports.get(p),
      },
      {
        sendDone: (m) => resolve(m),
        done: () => resolve(null),
      },
    );
  });
}

async function makeImageBuffer(width = 80, height = 50) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 120, g: 80, b: 200 },
    },
  })
    .webp()
    .toBuffer();
}

describe("GitPublisher", () => {
  it("exports getComponent", () => {
    assert.strictEqual(typeof getComponent, "function");
  });

  it("writes a text-only post to _logs/<filename>.md (no git ops)", async () => {
    const component = getComponent();
    const msg = {
      errors: [],
      identityHash: "abc",
      replyTo: "reply",
      channel: "inreach",
      confidence: "medium",
      intent: "BLOG",
      imapUid: 42,
      payload: {
        filename: "2026-08-09",
        title: "Calm Seas",
        date: "2026-08-09",
        postId: "0809",
        bodyMarkdown: "A quiet day with no photos.",
        imageBuffers: [],
        imageCount: 0,
      },
    };

    const out = await runPublish(component, msg, {
      repo_path: tmpDir,
      push: false,
    });

    assert.ok(out, "should emit a confirmation");
    assert.match(out.payload, /written to/);
    assert.strictEqual(out.imageCount, 0);
    assert.strictEqual(out.filename, "2026-08-09");

    // The filename is used unmodified — no slugification, no date prefix.
    const expectedPath = path.join(tmpDir, "_logs", "2026-08-09.md");
    assert.ok(fs.existsSync(expectedPath), "markdown file should exist");

    const content = fs.readFileSync(expectedPath, "utf-8");
    assert.match(content, /^---\n/);
    assert.match(content, /title: Calm Seas/);
    assert.match(content, /created: 2026-08-09/);
    assert.match(content, /postid: 0809/);
    assert.match(content, /lofi: true/);
    assert.match(content, /A quiet day with no photos\./);
  });

  it("writes the image to the body's referenced path (markdown tag + hi-fi overwrite match)", async () => {
    const component = getComponent();
    const img = await makeImageBuffer(120, 80);
    // In production the boat converts the image to .webp and updates the
    // markdown ref before encoding, so the body arrives with a .webp path.
    const bodyMarkdown =
      "We saw a whale!\n\n![whale](../2026/whale(0).webp)\n\nAmazing day.";
    const msg = {
      errors: [],
      identityHash: "abc",
      replyTo: "reply",
      channel: "inreach",
      confidence: "medium",
      intent: "BLOG",
      imapUid: 43,
      payload: {
        filename: "2026-08-10",
        title: "Whale Sighting",
        date: "2026-08-10",
        postId: "0810",
        bodyMarkdown,
        imageBuffers: [img],
        imageCount: 1,
      },
    };

    const out = await runPublish(component, msg, {
      repo_path: tmpDir,
      push: false,
    });

    assert.ok(out, "should emit a confirmation");
    assert.strictEqual(out.imageCount, 1);

    // The markdown body is written VERBATIM — the image ref is not rewritten,
    // so it still points at the path the boat will later overwrite with hi-fi.
    const mdPath = path.join(tmpDir, "_logs", "2026-08-10.md");
    const content = fs.readFileSync(mdPath, "utf-8");
    assert.ok(
      content.includes("![whale](../2026/whale(0).webp)"),
      "image markdown should be preserved verbatim (not rewritten)",
    );

    // The image is written to the path the body references, resolved relative
    // to _logs/ (where the post lives): ../2026/ -> <repo>/2026/. This is
    // the same path the boat stores the hi-fi version at (backup.sh copies
    // <year>/ to the repo root), so git merge overwrites cleanly.
    const imgPath = path.join(tmpDir, "2026", "whale(0).webp");
    assert.ok(fs.existsSync(imgPath), "image should be at the body's path");

    const written = fs.readFileSync(imgPath);
    const meta = await sharp(written).metadata();
    assert.strictEqual(meta.format, "webp");
    assert.strictEqual(meta.width, 120, "width preserved by watermark");
    assert.strictEqual(meta.height, 80, "height preserved by watermark");

    // The watermarked output must differ from the raw input buffer.
    assert.ok(
      !written.equals(img),
      "output image should differ from input (watermark applied)",
    );

    // The top banner strip should be noticeably darker than the original
    // top row (the watermark overlays a semi-transparent black bar).
    const { data: topRow } = await sharp(img)
      .extract({ left: 0, top: 0, width: 120, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { data: writtenTopRow } = await sharp(written)
      .extract({ left: 0, top: 0, width: 120, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const origBright = topRow[0] + topRow[1] + topRow[2];
    const watermarkedBright =
      writtenTopRow[0] + writtenTopRow[1] + writtenTopRow[2];
    assert.ok(
      watermarkedBright < origBright,
      "top row should be darker after watermarking",
    );
  });

  it("writes each image to its own body-referenced path (in order)", async () => {
    const component = getComponent();
    const img1 = await makeImageBuffer(60, 40);
    const img2 = await makeImageBuffer(60, 40);
    const msg = {
      errors: [],
      identityHash: "abc",
      replyTo: "reply",
      channel: "inreach",
      confidence: "medium",
      intent: "BLOG",
      imapUid: 44,
      payload: {
        filename: "2026-08-11-two-photos",
        title: "Two Photos",
        date: "2026-08-11",
        postId: "0811",
        bodyMarkdown: "![a](../2026/photo1.webp)\n\n![b](../2026/photo2.webp)",
        imageBuffers: [img1, img2],
        imageCount: 2,
      },
    };

    const out = await runPublish(component, msg, {
      repo_path: tmpDir,
      push: false,
    });
    assert.strictEqual(out.imageCount, 2);

    // Each image lands at its own body-referenced path, not a synthesized
    // numbered path.
    assert.ok(
      fs.existsSync(path.join(tmpDir, "2026", "photo1.webp")),
      "first image at its referenced path",
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, "2026", "photo2.webp")),
      "second image at its referenced path",
    );

    // The filename stays unmodified — no slugification.
    const content = fs.readFileSync(
      path.join(tmpDir, "_logs", "2026-08-11-two-photos.md"),
      "utf-8",
    );
    assert.ok(content.includes("![a](../2026/photo1.webp)"));
    assert.ok(content.includes("![b](../2026/photo2.webp)"));
  });

  it("resolves absolute (site-root-relative) image paths too", async () => {
    const component = getComponent();
    const img = await makeImageBuffer(50, 50);
    const msg = {
      errors: [],
      identityHash: "abc",
      replyTo: "reply",
      channel: "inreach",
      confidence: "medium",
      intent: "BLOG",
      imapUid: 46,
      payload: {
        filename: "2026-08-13-asset",
        title: "Asset Path",
        date: "2026-08-13",
        postId: "0813",
        bodyMarkdown: "![icon](/assets/photos/icon.webp)",
        imageBuffers: [img],
        imageCount: 1,
      },
    };

    await runPublish(component, msg, { repo_path: tmpDir, push: false });

    // Leading / = Jekyll site-root-relative = repo-root-relative.
    assert.ok(
      fs.existsSync(path.join(tmpDir, "assets", "photos", "icon.webp")),
      "absolute path should resolve repo-root-relative",
    );
    const content = fs.readFileSync(
      path.join(tmpDir, "_logs", "2026-08-13-asset.md"),
      "utf-8",
    );
    assert.ok(content.includes("![icon](/assets/photos/icon.webp)"));
  });

  it("does not create a git repo or commit (disk writing only)", async () => {
    const component = getComponent();
    const msg = {
      errors: [],
      identityHash: "abc",
      replyTo: "reply",
      channel: "inreach",
      confidence: "medium",
      intent: "BLOG",
      imapUid: 45,
      payload: {
        filename: "2026-08-12",
        title: "No Git",
        date: "2026-08-12",
        postId: "0812",
        bodyMarkdown: "Plain directory output.",
        imageBuffers: [],
        imageCount: 0,
      },
    };

    await runPublish(component, msg, { repo_path: tmpDir, push: false });
    assert.ok(
      !fs.existsSync(path.join(tmpDir, ".git")),
      "no git repo should be created",
    );
  });

  it("fails gracefully without a repo_path configured", async () => {
    const component = getComponent();
    const msg = {
      errors: [],
      payload: {
        filename: "2026-08-09",
        title: "x",
        date: "2026-08-09",
        postId: "0813",
        bodyMarkdown: "y",
        imageBuffers: [],
        imageCount: 0,
      },
    };
    const out = await runPublish(component, msg, {});
    assert.ok(out, "should emit the failed message");
    assert.ok(out.errors.length > 0, "should have errors");
    assert.match(out.errors[0].message, /Repository path not configured/);
  });

  it("fails when filename is missing from the payload", async () => {
    const component = getComponent();
    const msg = {
      errors: [],
      payload: {
        // no filename
        title: "x",
        date: "2026-08-09",
        postId: "0813",
        bodyMarkdown: "y",
        imageBuffers: [],
        imageCount: 0,
      },
    };
    const out = await runPublish(component, msg, { repo_path: tmpDir });
    assert.ok(out, "should emit the failed message");
    assert.ok(out.errors.length > 0, "should have errors");
    assert.match(out.errors[0].message, /missing filename/);
  });

  it("rejects a path-traversal filename (transmitted data is untrusted)", async () => {
    const component = getComponent();
    const msg = {
      errors: [],
      payload: {
        filename: "../../../etc/passwd",
        title: "x",
        date: "2026-08-09",
        postId: "0813",
        bodyMarkdown: "y",
        imageBuffers: [],
        imageCount: 0,
      },
    };
    const out = await runPublish(component, msg, { repo_path: tmpDir });
    assert.ok(out, "should emit the failed message");
    assert.ok(out.errors.length > 0, "should have errors");
    assert.match(out.errors[0].message, /Unsafe filename/);
    // Ensure nothing was written outside _logs/.
    assert.ok(
      !fs.existsSync(path.join(tmpDir, "..", "..", "..", "etc", "passwd")),
      "should not have written to a traversed path",
    );
  });

  it("preserves a filename with spaces and hyphens exactly as transmitted", async () => {
    const component = getComponent();
    const msg = {
      errors: [],
      payload: {
        filename: "2026-08-14-my trip",
        title: "My Trip",
        date: "2026-08-14",
        postId: "0814",
        bodyMarkdown: "We went sailing.",
        imageBuffers: [],
        imageCount: 0,
      },
    };
    const out = await runPublish(component, msg, { repo_path: tmpDir });
    assert.ok(out, "should emit a confirmation");
    assert.ok(
      fs.existsSync(path.join(tmpDir, "_logs", "2026-08-14-my trip.md")),
      "filename with spaces should be preserved exactly",
    );
  });
});
