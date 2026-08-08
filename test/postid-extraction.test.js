// Tests for extractPostidFromFilename

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  extractPostidFromFilename
} = require('../plugin/index.js');

describe('extractPostidFromFilename', () => {
  it('should extract MMDD from simple date filename', () => {
    const result = extractPostidFromFilename('2026-08-07');
    assert.strictEqual(result, '0807');
  });

  it('should extract MMDD from date with .md extension', () => {
    const result = extractPostidFromFilename('2026-08-07.md');
    assert.strictEqual(result, '0807');
  });

  it('should extract MMDDN from date with suffix', () => {
    const result = extractPostidFromFilename('2026-08-07_001');
    assert.strictEqual(result, '08071');
  });

  it('should extract MMDDN from date with suffix and .md', () => {
    const result = extractPostidFromFilename('2026-08-07_001.md');
    assert.strictEqual(result, '08071');
  });

  it('should return null for invalid filename format', () => {
    const result = extractPostidFromFilename('some-other-name');
    assert.strictEqual(result, null);
  });

  it('should handle three-digit suffix correctly', () => {
    const result = extractPostidFromFilename('2026-06-18_002');
    assert.strictEqual(result, '06182');
  });
});