// Tests for stripping markdown image tags from the text-only variant body

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { stripImageMarkdown } = require("../plugin/index.js");

describe("stripImageMarkdown", () => {
  it("should leave text without images unchanged", () => {
    const body = "We had a calm day sailing downwind.";
    assert.strictEqual(stripImageMarkdown(body), body);
  });

  it("should remove a single image with alt text", () => {
    const body = "Here is a photo: ![Afternoon cruise](../2021/abc.jpg)";
    assert.strictEqual(stripImageMarkdown(body), "Here is a photo:");
  });

  it("should remove multiple images and keep surrounding text", () => {
    const body =
      "![First](../2021/a.jpg)\nText in between\n![Second](../2021/b.jpg)";
    assert.strictEqual(stripImageMarkdown(body), "Text in between");
  });

  it("should handle images with parentheses in the filename", () => {
    const body = "![](../2026/20260716_113823(0).jpg)";
    assert.strictEqual(stripImageMarkdown(body), "");
  });

  it("should handle images with a title attribute", () => {
    const body = '![Photo](../2021/test.jpg "A nice photo")';
    assert.strictEqual(stripImageMarkdown(body), "");
  });

  it("should keep text around an inline image", () => {
    const body = "Text before ![alt](path.jpg) text after";
    assert.strictEqual(stripImageMarkdown(body), "Text before  text after");
  });

  it("should not mistake a regular link for an image", () => {
    const body = "A [link](https://example.com) stays";
    assert.strictEqual(stripImageMarkdown(body), body);
  });

  it("should collapse blank lines left behind by removed images", () => {
    const body = "Intro\n\n![img](a.jpg)\n\n\n\nOutro";
    assert.strictEqual(stripImageMarkdown(body), "Intro\n\nOutro");
  });
});
