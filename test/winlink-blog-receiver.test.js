// Tests for WinlinkBlogReceiver component

const { test } = require("node:test");
const assert = require("node:assert");
const { getComponent } = require("../components/WinlinkBlogReceiver.js");

test("WinlinkBlogReceiver passes through non-Winlink messages", () => {
  const component = getComponent();
  const input = {
    hasData: (port) => port === "in",
    getData: () => ({
      channel: "inreach",
      payload: "some inreach content",
      identityHash: "test123",
    }),
  };

  let outputSent = null;
  const output = {
    sendDone: (data) => {
      outputSent = data;
    },
  };

  component.handle(input, output);
  assert.ok(outputSent);
  assert.strictEqual(outputSent.channel, "inreach");
});

test("WinlinkBlogReceiver passes through Winlink without BLOG POST marker", () => {
  const component = getComponent();
  const input = {
    hasData: (port) => port === "in",
    getData: () => ({
      channel: "winlink",
      payload: "STATUS",
      identityHash: "test123",
    }),
  };

  let outputSent = null;
  const output = {
    sendDone: (data) => {
      outputSent = data;
    },
  };

  component.handle(input, output);
  assert.ok(outputSent);
  assert.strictEqual(outputSent.channel, "winlink");
  assert.strictEqual(outputSent.payload, "STATUS");
});

test("WinlinkBlogReceiver parses Winlink blog post without images", () => {
  const component = getComponent();

  const content = `Filename: 2024-08-12.md
Date: 2024-08-12
Title: Test Post Title
Images: 0

This is the blog post body.`;

  const input = {
    hasData: (port) => port === "in",
    getData: () => ({
      channel: "winlink",
      payload: `---BEGIN BLOG POST---\n${content}\n---END BLOG POST---`,
      identityHash: "test123",
    }),
  };

  let outputSent = null;
  const output = {
    sendDone: (data) => {
      outputSent = data;
    },
  };

  component.handle(input, output);
  assert.ok(outputSent);
  assert.strictEqual(outputSent.intent, "BLOG");
  assert.ok(outputSent.payload);
  assert.strictEqual(outputSent.payload.filename, "2024-08-12.md");
  assert.strictEqual(outputSent.payload.title, "Test Post Title");
  assert.strictEqual(outputSent.payload.date, "2024-08-12");
  assert.strictEqual(
    outputSent.payload.bodyMarkdown,
    "This is the blog post body.",
  );
  assert.strictEqual(outputSent.payload.imageCount, 0);
  assert.deepStrictEqual(outputSent.payload.imageBuffers, []);
});

test("WinlinkBlogReceiver parses Winlink blog post with images", () => {
  const component = getComponent();

  // Create a fake image buffer
  const fakeImage = Buffer.from("fake webp data");

  const content = `Filename: 2024-08-12.md
Date: 2024-08-12
Title: Test Post Title
Images: 2
Image_0: ../2024/img1.webp|${fakeImage.toString("base64")}
Image_1: ../2024/img2.webp|${fakeImage.toString("base64")}

This is the blog post body with images.`;

  const input = {
    hasData: (port) => port === "in",
    getData: () => ({
      channel: "winlink",
      payload: `---BEGIN BLOG POST---\n${content}\n---END BLOG POST---`,
      identityHash: "test123",
    }),
  };

  let outputSent = null;
  const output = {
    sendDone: (data) => {
      outputSent = data;
    },
  };

  component.handle(input, output);
  assert.ok(outputSent);
  assert.strictEqual(outputSent.intent, "BLOG");
  assert.ok(outputSent.payload);
  assert.strictEqual(outputSent.payload.filename, "2024-08-12.md");
  assert.strictEqual(outputSent.payload.title, "Test Post Title");
  assert.strictEqual(outputSent.payload.date, "2024-08-12");
  assert.strictEqual(outputSent.payload.imageCount, 2);
  assert.strictEqual(outputSent.payload.imageBuffers.length, 2);
  assert.deepStrictEqual(outputSent.payload.imageBuffers[0], fakeImage);
  assert.deepStrictEqual(outputSent.payload.imageBuffers[1], fakeImage);
});

test("WinlinkBlogReceiver handles missing required fields", () => {
  const component = getComponent();
  const content = `Filename: 2024-08-12.md
Images: 0

This is the blog post body.`;

  const input = {
    hasData: (port) => port === "in",
    getData: () => ({
      channel: "winlink",
      payload: `---BEGIN BLOG POST---\n${content}\n---END BLOG POST---`,
      identityHash: "test123",
    }),
  };

  let outputSent = null;
  const output = {
    sendDone: (data) => {
      outputSent = data;
    },
  };

  component.handle(input, output);
  assert.ok(outputSent);
  assert.ok(outputSent.errors);
  assert.ok(outputSent.errors.length > 0);
  assert.ok(outputSent.errors[0].message.includes("parse"));
});

test("WinlinkBlogReceiver handles body with multiple lines", () => {
  const component = getComponent();
  const content = `Filename: 2024-08-12.md
Date: 2024-08-12
Title: Test Post Title
Images: 0

First paragraph.

Second paragraph.

Third paragraph.`;

  const input = {
    hasData: (port) => port === "in",
    getData: () => ({
      channel: "winlink",
      payload: `---BEGIN BLOG POST---\n${content}\n---END BLOG POST---`,
      identityHash: "test123",
    }),
  };

  let outputSent = null;
  const output = {
    sendDone: (data) => {
      outputSent = data;
    },
  };

  component.handle(input, output);
  assert.ok(outputSent);
  assert.strictEqual(
    outputSent.payload.bodyMarkdown,
    "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
  );
});

test("WinlinkBlogReceiver normalizes date from ISO timestamp", () => {
  const component = getComponent();
  const content = `Filename: 2024-08-12.md
Date: 2024-08-12T16:35:17-10:00
Title: Test Post
Images: 0

Body here.`;

  const input = {
    hasData: (port) => port === "in",
    getData: () => ({
      channel: "winlink",
      payload: `---BEGIN BLOG POST---\n${content}\n---END BLOG POST---`,
      identityHash: "test123",
    }),
  };

  let outputSent = null;
  const output = {
    sendDone: (data) => {
      outputSent = data;
    },
  };

  component.handle(input, output);
  assert.ok(outputSent);
  assert.strictEqual(outputSent.payload.date, "2024-08-12");
});

test("WinlinkBlogReceiver handles title with special characters", () => {
  const component = getComponent();
  const content = `Filename: 2024-08-12.md
Date: 2024-08-12
Title: Pacific Ocean, 148NM SW of Anse Amyot
Images: 0

Body here.`;

  const input = {
    hasData: (port) => port === "in",
    getData: () => ({
      channel: "winlink",
      payload: `---BEGIN BLOG POST---\n${content}\n---END BLOG POST---`,
      identityHash: "test123",
    }),
  };

  let outputSent = null;
  const output = {
    sendDone: (data) => {
      outputSent = data;
    },
  };

  component.handle(input, output);
  assert.ok(outputSent);
  assert.strictEqual(
    outputSent.payload.title,
    "Pacific Ocean, 148NM SW of Anse Amyot",
  );
});

test("WinlinkBlogReceiver handles empty body", () => {
  const component = getComponent();
  const content = `Filename: 2024-08-12.md
Date: 2024-08-12
Title: Test Post
Images: 0
`;

  const input = {
    hasData: (port) => port === "in",
    getData: () => ({
      channel: "winlink",
      payload: `---BEGIN BLOG POST---\n${content}\n---END BLOG POST---`,
      identityHash: "test123",
    }),
  };

  let outputSent = null;
  const output = {
    sendDone: (data) => {
      outputSent = data;
    },
  };

  component.handle(input, output);
  assert.ok(outputSent);
  assert.strictEqual(outputSent.payload.bodyMarkdown, "");
});
