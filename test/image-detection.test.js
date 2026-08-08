// Tests for image detection from markdown

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  findImagesFromMarkdown
} = require('../plugin/index.js');

describe('findImagesFromMarkdown', () => {
  it('should find no images in text without images', () => {
    const body = 'This is just some text without any images.';
    const images = findImagesFromMarkdown(body, '2021-08-24', '/home/pi/log');
    assert.strictEqual(images.length, 0);
  });

  it('should find a single image with alt text', () => {
    const body = 'Here is a photo: ![Afternoon cruise](../2021/8ac846b5893d81618f57d0ab08744b0a.jpg)';
    const images = findImagesFromMarkdown(body, '2021-08-24', '/home/pi/log');
    assert.strictEqual(images.length, 1);
    assert.strictEqual(images[0].alt, 'Afternoon cruise');
    assert.strictEqual(images[0].path, '../2021/8ac846b5893d81618f57d0ab08744b0a.jpg');
    assert.strictEqual(images[0].resolvedPath, '/home/pi/log/2021/8ac846b5893d81618f57d0ab08744b0a.jpg');
  });

  it('should find multiple images', () => {
    const body = `
![First photo](../2021/abc123.jpg)
Some text in between
![Second photo](../2021/def456.jpg)
    `;
    const images = findImagesFromMarkdown(body, '2021-08-24', '/home/pi/log');
    assert.strictEqual(images.length, 2);
    assert.strictEqual(images[0].alt, 'First photo');
    assert.strictEqual(images[1].alt, 'Second photo');
  });

  it('should handle images with title attribute', () => {
    const body = '![Photo](../2021/test.jpg "A nice photo")';
    const images = findImagesFromMarkdown(body, '2021-08-24', '/home/pi/log');
    assert.strictEqual(images.length, 1);
    assert.strictEqual(images[0].alt, 'Photo');
    assert.strictEqual(images[0].path, '../2021/test.jpg');
  });

  it('should handle images without alt text', () => {
    const body = '![](../2021/no-alt.jpg)';
    const images = findImagesFromMarkdown(body, '2021-08-24', '/home/pi/log');
    assert.strictEqual(images.length, 1);
    assert.strictEqual(images[0].alt, '');
  });

  it('should handle images with nested directory paths', () => {
    const body = '![Nested](../2021/subdir/nested.jpg)';
    const images = findImagesFromMarkdown(body, '2021-08-24', '/home/pi/log');
    assert.strictEqual(images.length, 1);
    assert.strictEqual(images[0].resolvedPath, '/home/pi/log/2021/subdir/nested.jpg');
  });

  it('should handle images with parentheses in filename', () => {
    const body = '![](../2026/20260716_113823(0).jpg)';
    const images = findImagesFromMarkdown(body, '2026-07-16', '/home/pi/log');
    assert.strictEqual(images.length, 1);
    assert.strictEqual(images[0].path, '../2026/20260716_113823(0).jpg');
    assert.strictEqual(images[0].resolvedPath, '/home/pi/log/2026/20260716_113823(0).jpg');
  });
});