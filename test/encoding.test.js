// Tests for offshore blogging encoding/decoding

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  calculateCRC16,
  parseFrontMatter,
  compressText,
  decompressText,
  chunkData,
  reassembleChunks,
  SAIL_DICT
} = require('../plugin/index.js');

describe('calculateCRC16', () => {
  it('should calculate CRC-16 correctly for empty buffer', () => {
    const result = calculateCRC16(Buffer.from(''));
    assert.strictEqual(result, 0xFFFF);
  });

  it('should calculate CRC-16 consistently for same data', () => {
    const data = Buffer.from('hello world');
    const result1 = calculateCRC16(data);
    const result2 = calculateCRC16(data);
    assert.strictEqual(result1, result2);
  });

  it('should produce different CRCs for different data', () => {
    const crc1 = calculateCRC16(Buffer.from('hello'));
    const crc2 = calculateCRC16(Buffer.from('world'));
    assert.notStrictEqual(crc1, crc2);
  });
});

describe('parseFrontMatter', () => {
  it('should parse basic front matter', () => {
    const text = `---
title: Test Post
date: 2026-08-05
---
This is the body content.`;

    const result = parseFrontMatter(text);
    assert.strictEqual(result.title, 'Test Post');
    assert.strictEqual(result.date, '2026-08-05');
    assert.strictEqual(result.body, 'This is the body content.');
  });

  it('should parse front matter with extra fields', () => {
    const text = `---
title: Another Post
date: 2026-08-06
author: Captain
tags: [sailing, offshore]
---
Body text here.`;

    const result = parseFrontMatter(text);
    assert.strictEqual(result.title, 'Another Post');
    assert.strictEqual(result.date, '2026-08-06');
    // Extra fields are not included in return value, only title, date, and body
    assert.strictEqual(result.body, 'Body text here.');
  });

  it('should throw error for missing front matter', () => {
    const text = 'No front matter here';
    assert.throws(() => parseFrontMatter(text), /no YAML front matter/i);
  });

  it('should throw error for missing required fields', () => {
    const text = `---
title: Missing Date
---
Body`;

    assert.throws(() => parseFrontMatter(text), /must include at least date: or created:/i);
  });
});

describe('compressText and decompressText', () => {
  it('should compress and decompress simple text', () => {
    const title = 'Test Post';
    const date = '2026-08-05';
    const body = 'This is a test post.';

    const compressed = compressText(title, date, body, SAIL_DICT);
    const decompressed = decompressText(compressed, SAIL_DICT);

    assert.strictEqual(decompressed.title, title);
    assert.strictEqual(decompressed.date, date);
    assert.strictEqual(decompressed.body, body);
  });

  it('should compress and decompress longer text', () => {
    const title = 'Day 14 at Sea';
    const date = '2026-08-14';
    const body = 'We had a wonderful day sailing downwind. The wind was steady at 15 knots from the northeast. ' +
                 'Crew is doing well and we expect to make landfall in two days.';

    const compressed = compressText(title, date, body, SAIL_DICT);
    const decompressed = decompressText(compressed, SAIL_DICT);

    assert.strictEqual(decompressed.title, title);
    assert.strictEqual(decompressed.date, date);
    assert.strictEqual(decompressed.body, body);
  });

  it('should handle special characters', () => {
    const title = 'Test with émojis';
    const date = '2026-08-05';
    const body = 'Wind: 12 knots 🌊. Position: 24.5°N, 72.3°W';

    const compressed = compressText(title, date, body, SAIL_DICT);
    const decompressed = decompressText(compressed, SAIL_DICT);

    assert.strictEqual(decompressed.title, title);
    assert.strictEqual(decompressed.date, date);
    assert.strictEqual(decompressed.body, body);
  });

  it('should produce smaller output than input', () => {
    const title = 'Day at Sea';
    const date = '2026-08-05';
    const body = 'We sailed all day with good winds. The autopilot handled everything well. ' +
                 'We caught a fish for dinner and are enjoying the sunset.';

    const inputSize = Buffer.from(`${title}\x1f${date}\x1f${body}`).length;
    const compressed = compressText(title, date, body, SAIL_DICT);

    assert.ok(compressed.length < inputSize, 'Compression should reduce size');
  });
});

describe('chunkData', () => {
  it('should chunk data correctly', () => {
    const data = Buffer.from('hello world this is test data');
    const chunks = chunkData(data, '0805', 'T');

    assert.ok(chunks.length > 0);
    assert.ok(chunks.length <= 99);

    chunks.forEach((chunk, i) => {
      assert.match(chunk, /^0805T/);
      assert.match(chunk, /^0805T\d{2}\d{2}[0-9a-f]{4}:/);
    });
  });

  it('should respect message limit', () => {
    const data = Buffer.alloc(500, 'x');
    const chunks = chunkData(data, '0805', 'T');

    chunks.forEach(chunk => {
      assert.ok(chunk.length <= 155, `Chunk ${chunk.length} exceeds limit of 155`);
    });
  });

  it('should throw error for data requiring too many messages', () => {
    // Create very large data that would need >99 chunks
    const data = Buffer.alloc(100000, 'x');

    assert.throws(() => chunkData(data, '0805', 'T'), /needs \d+ messages.*99/i);
  });

  it('should include correct postid and type in header', () => {
    const data = Buffer.from('test');
    const chunks = chunkData(data, '1234', 'I');

    chunks.forEach(chunk => {
      assert.ok(chunk.startsWith('1234I'));
    });
  });
});

describe('reassembleChunks', () => {
  it('should reassemble chunks correctly', () => {
    const data = Buffer.from('hello world test data');
    const chunks = chunkData(data, '0805', 'T');

    // Parse chunks into entries format
    const entries = {};
    const chunkRegex = /^0805T(\d{2})(\d{2})([0-9a-f]{4}):(.*)$/;
    chunks.forEach((chunk, i) => {
      const match = chunk.match(chunkRegex);
      if (match) {
        const [, idx, total, crc, dataPiece] = match;
        entries[parseInt(idx, 10)] = {
          total: parseInt(total, 10),
          crc,
          data: dataPiece
        };
      }
    });

    const reassembled = reassembleChunks(entries);
    assert.deepStrictEqual(reassembled, data);
  });

  it('should throw error for conflicting totals', () => {
    const entries = {
      1: { total: 5, crc: '1234', data: 'abc' },
      2: { total: 3, crc: '1234', data: 'def' }
    };

    assert.throws(() => reassembleChunks(entries), /conflicting total counts/i);
  });

  it('should throw error for conflicting CRCs', () => {
    const entries = {
      1: { total: 2, crc: '1234', data: 'abc' },
      2: { total: 2, crc: '5678', data: 'def' }
    };

    assert.throws(() => reassembleChunks(entries), /disagree on checksum/i);
  });

  it('should throw error for missing chunks', () => {
    const entries = {
      1: { total: 3, crc: '1234', data: 'abc' },
      3: { total: 3, crc: '1234', data: 'def' }
    };

    assert.throws(() => reassembleChunks(entries), /missing chunk\(s\): 2/i);
  });

  it('should throw error for CRC mismatch', () => {
    const data = Buffer.from('test data');
    const chunks = chunkData(data, '0805', 'T');

    // Parse chunks but corrupt the CRC in entries
    const entries = {};
    const chunkRegex = /^0805T(\d{2})(\d{2})([0-9a-f]{4}):(.*)$/;
    chunks.forEach((chunk) => {
      const match = chunk.match(chunkRegex);
      if (match) {
        const [, idx, total, , dataPiece] = match;
        entries[parseInt(idx, 10)] = {
          total: parseInt(total, 10),
          crc: 'ffff', // Wrong CRC
          data: dataPiece
        };
      }
    });

    assert.throws(() => reassembleChunks(entries), /CRC mismatch/i);
  });
});

describe('Encoding round-trip', () => {
  it('should encode and decode a complete blog post', () => {
    const title = 'Day 15 - Beautiful Sunrise';
    const date = '2026-08-15';
    const body = 'Woke up to an amazing sunrise over the horizon. The sea was calm and we made good progress. ' +
                 'Had breakfast of porridge and coffee. Wind shifted to the south around noon.';

    // Compress
    const compressed = compressText(title, date, body, SAIL_DICT);

    // Chunk
    const chunks = chunkData(compressed, '0815', 'T');

    // Parse chunks
    const entries = {};
    const chunkRegex = /^0815T(\d{2})(\d{2})([0-9a-f]{4}):(.*)$/;
    chunks.forEach((chunk) => {
      const match = chunk.match(chunkRegex);
      if (match) {
        const [, idx, total, crc, dataPiece] = match;
        entries[parseInt(idx, 10)] = {
          total: parseInt(total, 10),
          crc,
          data: dataPiece
        };
      }
    });

    // Reassemble
    const reassembled = reassembleChunks(entries);

    // Decompress
    const decompressed = decompressText(reassembled, SAIL_DICT);

    // Verify
    assert.strictEqual(decompressed.title, title);
    assert.strictEqual(decompressed.date, date);
    assert.strictEqual(decompressed.body, body);
  });
});