// Tests for BlogDecoder: combining reassembled text + image parts into a
// complete blog post.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { getComponent } = require("../components/BlogDecoder.js");
const { compressText, SAIL_DICT } = require("../lib/BlogCodec.js");
const sharp = require("sharp");

// Build the assembly message BlogDecoder receives (i.e. MessageReassembler's
// output for one completed partType sequence).
function makePart(partType, transmissionId, payload, totalChunks = 2, uid = 1) {
  return {
    errors: [],
    identityHash: "abc123",
    replyTo: "https://explore.garmin.com/TextMessage/TxtMsg?extId=x",
    channel: "inreach",
    confidence: "medium",
    intent: "BLOG",
    imapUid: uid,
    payload,
    partType,
    transmissionId,
    totalChunks,
  };
}

// Run one handle() call; resolves to the sendDone() argument, which is a
// port map like { out: msg } or { buffered: msg }, or null for done()-only.
function runHandle(component, msg) {
  return new Promise((resolve) => {
    component.handle(
      {
        hasData: (p) => p === "in",
        getData: (p) => (p === "in" ? msg : undefined),
      },
      {
        sendDone: (m) => resolve(m),
        done: () => resolve(null),
      },
    );
  });
}

async function makeImageBuffer(width = 60, height = 40) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 100, g: 150, b: 200 },
    },
  })
    .webp()
    .toBuffer();
}

describe("BlogDecoder", () => {
  it("exports getComponent", () => {
    assert.strictEqual(typeof getComponent, "function");
  });

  it("has a 'buffered' outport for acking parts waiting on siblings", () => {
    const component = getComponent();
    const portNames = Object.keys(component.outPorts.ports);
    assert.ok(portNames.includes("out"), "should have out outport");
    assert.ok(portNames.includes("buffered"), "should have buffered outport");
  });

  it("decodes a text-only post (no image refs) immediately on 'out'", async () => {
    const component = getComponent();
    const body = "Just a calm day at sea. No photos.";
    const blob = compressText(
      "2026-08-09",
      "Calm Day",
      "2026-08-09",
      body,
      SAIL_DICT,
    );

    const result = await runHandle(
      component,
      makePart("T", "0809", blob.toString("base64"), 2, 10),
    );

    assert.ok(result?.out, "should emit on 'out' immediately");
    assert.ok(!result.buffered, "should not emit on 'buffered'");
    const out = result.out;
    assert.strictEqual(out.payload.filename, "2026-08-09");
    assert.strictEqual(out.payload.title, "Calm Day");
    assert.strictEqual(out.payload.date, "2026-08-09");
    assert.strictEqual(out.payload.bodyMarkdown, body);
    assert.strictEqual(out.payload.postId, "0809");
    assert.strictEqual(out.payload.imageCount, 0);
    assert.deepStrictEqual(out.payload.imageBuffers, []);
    assert.strictEqual(out.intent, "BLOG");
    // The text-only post carries the text part's imapUid for acking.
    assert.strictEqual(out.imapUid, 10);
  });

  it("buffers the text part on 'buffered' (acking it) until the image arrives", async () => {
    const component = getComponent();
    const body = "Saw a whale! ![whale](../2026/whale.webp) Amazing.";
    const blob = compressText(
      "2026-08-10",
      "Whale Day",
      "2026-08-09",
      body,
      SAIL_DICT,
    );

    const textResult = await runHandle(
      component,
      makePart("T", "0810", blob.toString("base64"), 2, 20),
    );
    // Text part is buffered (waiting for the image), and emitted on
    // 'buffered' so ImapAcker can mark its email as seen right away.
    assert.ok(textResult?.buffered, "text part should go to 'buffered'");
    assert.ok(!textResult.out, "should not emit on 'out' yet");
    assert.strictEqual(
      textResult.buffered.imapUid,
      20,
      "buffered part carries its imapUid for acking",
    );

    const img = await makeImageBuffer();
    const imgResult = await runHandle(
      component,
      makePart("I", "0810", img.toString("base64"), 3, 21),
    );

    assert.ok(imgResult?.out, "should emit on 'out' once the image arrives");
    assert.strictEqual(imgResult.out.payload.filename, "2026-08-10");
    assert.strictEqual(imgResult.out.payload.title, "Whale Day");
    assert.strictEqual(imgResult.out.payload.imageCount, 1);
    assert.strictEqual(imgResult.out.payload.imageBuffers.length, 1);
    // The image buffer round-trips exactly (BlogDecoder base64-decodes it).
    assert.deepStrictEqual(imgResult.out.payload.imageBuffers[0], img);
    // Body retains the image markdown so GitPublisher writes to its path.
    assert.ok(imgResult.out.payload.bodyMarkdown.includes("![whale]"));
    // The combined message carries the LAST-arriving part's imapUid.
    assert.strictEqual(imgResult.out.imapUid, 21);
  });

  it("buffers an image arriving before the text, then emits on text", async () => {
    const component = getComponent();
    const img = await makeImageBuffer();
    const imgResult = await runHandle(
      component,
      makePart("I", "0811", img.toString("base64"), 3, 30),
    );
    assert.ok(imgResult?.buffered, "image without text should buffer");

    const body = "![sunset](sun.webp) Glorious sunset.";
    const blob = compressText(
      "2026-08-11",
      "Sunset",
      "2026-08-09",
      body,
      SAIL_DICT,
    );
    const result = await runHandle(
      component,
      makePart("T", "0811", blob.toString("base64"), 2, 31),
    );

    assert.ok(result?.out, "should emit on 'out' once text arrives");
    assert.strictEqual(result.out.payload.filename, "2026-08-11");
    assert.strictEqual(result.out.payload.imageCount, 1);
  });

  it("waits for all images when the body references several", async () => {
    const component = getComponent();
    const body = "![one](a.webp)\n\ntext\n\n![two](b.webp)\n\nmore";
    const blob = compressText(
      "2026-08-12",
      "Two Pics",
      "2026-08-09",
      body,
      SAIL_DICT,
    );

    const textResult = await runHandle(
      component,
      makePart("T", "0812", blob.toString("base64"), 2, 40),
    );
    assert.ok(textResult?.buffered, "text buffered waiting for images");

    const img1 = await makeImageBuffer();
    const img1Result = await runHandle(
      component,
      makePart("I", "0812", img1.toString("base64"), 2, 41),
    );
    assert.ok(img1Result?.buffered, "still waiting for the second image");

    const img2 = await makeImageBuffer();
    const result = await runHandle(
      component,
      makePart("J", "0812", img2.toString("base64"), 2, 42),
    );
    assert.ok(result?.out, "should emit on 'out' once both images arrive");
    assert.strictEqual(result.out.payload.filename, "2026-08-12");
    assert.strictEqual(result.out.payload.imageCount, 2);
    // Images are ordered by part-type letter: I then J.
    assert.deepStrictEqual(result.out.payload.imageBuffers[0], img1);
    assert.deepStrictEqual(result.out.payload.imageBuffers[1], img2);
  });

  it("passes failed messages through on 'out' unchanged", async () => {
    const component = getComponent();
    const failedMsg = {
      errors: [new Error("upstream failure")],
      failed: true,
      payload: "garbage",
      partType: "T",
      transmissionId: "0813",
    };
    const result = await runHandle(component, failedMsg);
    assert.ok(result?.out, "failed messages pass through on 'out'");
    assert.strictEqual(result.out, failedMsg);
  });

  it("fails on a part missing transmissionId/partType", async () => {
    const component = getComponent();
    const msg = {
      errors: [],
      payload: "ABC",
      // no partType / transmissionId
    };
    const result = await runHandle(component, msg);
    assert.ok(result?.out, "should emit the failed message on 'out'");
    assert.ok(result.out.errors.length > 0, "should have errors");
    assert.match(result.out.errors[0].message, /transmissionId\/partType/);
  });
});
