/**
 * Signal K Offshore Blogging Plugin
 *
 * Provides encoding for blog posts and weather requests for transmission
 * via low-bandwidth satellite systems (InReach, Winlink).
 */

const zlib = require('node:zlib');
const sharp = require('sharp');
const fs = require('fs').
promises;
const path = require('path');
const { Identity, toHex } = require('@reticulum/core');
const { Reticulum } = require('@reticulum/core');

// Garmin's confirmed 1-char-safe set (support.garmin.com character-count
// tables). Every character our chunk format can ever emit -- header and
// base64 payload alike -- must be in here.
const GARMIN_SAFE_CHARS = new Set(
  '!"#$%\'()*+,-./:;<=>?@_0123456789' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
);

// Check if a message contains only Garmin-safe characters
function checkGarminSafe(msg) {
  const bad = new Set();
  for (const char of msg) {
    if (!GARMIN_SAFE_CHARS.has(char)) {
      bad.add(char);
    }
  }
  if (bad.size > 0) {
    throw new Error(
      `Message contains character(s) ${[...bad].join(', ')} not confirmed safe by ` +
      "Garmin's character-count tables -- this would cost double or " +
      'silently halve the whole message\'s limit. This is a bug in the encoder.'
    );
  }
}

// Constants from Python reference
const HEADER_LEN = 4 + 1 + 2 + 2 + 4 + 1; // postid+type+idx+total+crc+':'
const MSG_LIMIT = 155;
const DATA_BUDGET = MSG_LIMIT - HEADER_LEN;

// Default sailing dictionary for compression
const SAIL_DICT = Buffer.from(
  'knots wind speed course heading nautical miles position latitude ' +
  'longitude squall reef watch sunrise sunset autopilot sail sails ' +
  'mainsail jib genoa spinnaker anchor anchorage landfall passage ' +
  'crew galley cockpit engine diesel fuel battery solar generator ' +
  'weather forecast grib routing waypoint tack gybe reef swell ' +
  'following seas beam reach downwind upwind knots today we we\'re ' +
  'the and to of a in that with for on at is was are it this '
);

// CRC-16 calculation (CRC-16-CCITT)
function calculateCRC16(buffer) {
  let crc = 0xFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i] << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc = crc << 1;
      }
    }
  }
  return crc & 0xFFFF;
}

// Find images referenced in markdown content
function findImagesFromMarkdown(body, postDate, blogPath) {
  const images = [];
  
  // Split the body and find image markers
  const lines = body.split('\n');
  for (const line of lines) {
    const imageMatch = line.match(/!\[([^\]]*)\]\(([^\)]+)/);
    if (imageMatch) {
      const alt = imageMatch[1];
      // Find the full image path by scanning from the opening paren
      const parenStart = line.indexOf('(');
      let parenCount = 1;
      let i = parenStart + 1;
      let imagePath = '';
      
      while (i < line.length && parenCount > 0) {
        if (line[i] === '(') {
          parenCount++;
          imagePath += line[i];
        } else if (line[i] === ')') {
          parenCount--;
          if (parenCount === 0) {
            // Found the closing paren - stop
            break;
          }
          imagePath += line[i];
        } else {
          imagePath += line[i];
        }
        i++;
      }
      
      imagePath = imagePath.trim();
      
      // Remove trailing title if present ("text")
      const titleMatch = imagePath.match(/^(.+?)\s+"[^"]*"$/);
      if (titleMatch) {
        imagePath = titleMatch[1];
      }
      
      // Resolve relative paths - handle both absolute paths and ../YYYY/ style
      let resolvedPath;
      if (imagePath.startsWith('../')) {
        // Path like ../2026/20260716_113823(0).jpg - resolve from blogPath
        const parts = imagePath.split('/');
        const yearDir = parts[1]; // extract '2026'
        const imageName = parts.slice(2).join('/'); // '20260716_113823(0).jpg'
        resolvedPath = path.join(blogPath, yearDir, imageName);
      } else if (path.isAbsolute(imagePath)) {
        resolvedPath = imagePath;
      } else {
        // Relative path, resolve from _logs directory
        resolvedPath = path.resolve(blogPath, '_logs', imagePath);
      }
      images.push({ alt, path: imagePath, resolvedPath });
    }
  }
  return images;
}

// Get today's date in MMDD format
function getTodayPostid() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${month}${day}`;
}

// Extract postid from filename (handles YYYY-MM-DD.md and YYYY-MM-DD_001.md)
function extractPostidFromFilename(filename) {
  // Extract the date part and any suffix
  const match = filename.match(/(\d{4}-\d{2}-\d{2})(?:_(\d{3}))?/);
  if (match) {
    const datePart = match[1]; // YYYY-MM-DD
    const suffix = match[2]; // 001, 002, etc.
    const monthDay = datePart.slice(5).replace(/-/g, ''); // MMDD
    return suffix ? (monthDay + suffix.slice(-1)) : monthDay; // MMDD or MMDDN
  }
  return null;
}

// Parse Jekyll front matter from markdown
function parseFrontMatter(text) {
  const match = text.match(/^---\n(.*?)\n---\n(.*)$/s);
  if (!match) {
    throw new Error('Post has no YAML front matter (--- ... ---) block');
  }
  const fmRaw = match[1];
  const body = match[2].trim();

  const frontMatter = {};
  for (const line of fmRaw.split('\n')) {
    if (line.includes(':')) {
      const colonIdx = line.indexOf(':');
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^"|"$/g, '');
      frontMatter[key] = value;
    }
  }

  // Support both 'date' and 'created' fields (created is used in the log)
  if (!frontMatter.title) {
    throw new Error('Front matter must include at least title:');
  }
  if (!frontMatter.date && !frontMatter.created) {
    throw new Error('Front matter must include at least date: or created:');
  }

  return {
    title: frontMatter.title,
    date: frontMatter.date || frontMatter.created,
    body
  };
}

// Compress text payload using deflate with optional dictionary
function compressText(title, date, body, dictionary = SAIL_DICT) {
  const payload = Buffer.from(`${title}\x1f${date}\x1f${body}`, 'utf-8');

  const compressed = zlib.deflateRawSync(payload, {
    level: 9,
    dictionary
  });

  return compressed;
}

// Decompress text payload
function decompressText(compressed, dictionary = SAIL_DICT) {
  const decompressed = zlib.inflateRawSync(compressed, {
    dictionary
  });

  const text = decompressed.toString('utf-8');
  const [title, date, body] = text.split('\x1f', 3);

  return { title, date, body };
}

// Chunk data into InReach messages
function chunkData(data, postid, type) {
  const b64 = data.toString('base64');
  const total = Math.ceil(b64.length / DATA_BUDGET);

  if (total > 99) {
    throw new Error(`${type} needs ${total} messages, header only allows 99. Compress more.`);
  }

  const crc = calculateCRC16(data);
  const messages = [];

  for (let i = 0; i < total; i++) {
    const piece = b64.slice(i * DATA_BUDGET, (i + 1) * DATA_BUDGET);
    const header = `${postid}${type}${String(i + 1).padStart(2, '0')}${String(total).padStart(2, '0')}${crc.toString(16).padStart(4, '0')}:`;
    const msg = header + piece;
    checkGarminSafe(msg);
    messages.push(msg);
  }

  return messages;
}

// Reassemble chunks into original data
function reassembleChunks(entries) {
  const totals = new Set();
  const crcs = new Set();

  for (const entry of Object.values(entries)) {
    totals.add(entry.total);
    crcs.add(entry.crc);
  }

  if (totals.size !== 1) {
    throw new Error(`conflicting total counts seen: ${[...totals]}`);
  }
  if (crcs.size !== 1) {
    throw new Error(`chunks disagree on checksum -- likely a mistyped message: ${[...crcs]}`);
  }

  const total = totals.values().next().value;
  const expectedCrc = parseInt(crcs.values().next().value, 16);

  // Check for missing chunks
  const missing = [];
  for (let i = 1; i <= total; i++) {
    if (!entries[i]) {
      missing.push(i);
    }
  }
  if (missing.length > 0) {
    throw new Error(`missing chunk(s): ${missing} (have ${Object.keys(entries).sort()}/${total})`);
  }

  // Reassemble base64 data
  const b64 = [];
  for (let i = 1; i <= total; i++) {
    b64.push(entries[i].data);
  }
  const b64String = b64.join('');

  // Decode and verify CRC
  const compressed = Buffer.from(b64String, 'base64');
  const gotCrc = calculateCRC16(compressed);

  if (gotCrc !== expectedCrc) {
    throw new Error(
      `CRC mismatch: expected ${expectedCrc.toString(16).padStart(4, '0')} ` +
      `got ${gotCrc.toString(16).padStart(4, '0')} -- a chunk was corrupted or mistyped`
    );
  }

  return compressed;
}

// Compress image to fit message budget
async function compressImage(imagePath, budgetMsgs) {
  const img = sharp(imagePath);
  const metadata = await img.metadata();
  const aspect = metadata.height / metadata.width;

  let best = null;

  // Search grid (from Python reference, expanded for WebP)
  const widths = [200, 180, 160, 140, 120, 100, 96, 80, 64, 48];
  const qualities = [50, 40, 35, 30, 25, 20, 15, 10, 5];

  for (const w of widths) {
    const h = Math.max(1, Math.round(w * aspect));

    for (const q of qualities) {
      const data = await img
        .resize(w, h)
        .grayscale()
        .webp({ quality: q, effort: 6 })
        .toBuffer();

      const b64Len = Buffer.byteLength(data.toString('base64'));
      const nMsgs = Math.ceil(b64Len / DATA_BUDGET);

      if (nMsgs <= budgetMsgs) {
        if (!best || (w * h) > (best.width * best.height)) {
          best = { width: w, height: h, quality: q, data };
        }
      }
    }

    if (best) {
      break; // Got a fit at this width, stop searching smaller
    }
  }

  if (!best) {
    throw new Error(
      `Could not fit any usable image into ${budgetMsgs} messages; ` +
      'raise --image-budget or shrink the source photo.'
    );
  }

  return best;
}

// Encode a complete blog post
async function encodeBlogPost(filename, postid, imageBudget, dictionaryPath, blogPath, includeImages = null) {
  // Auto-extract postid from filename if not provided
  const postIdToUse = postid || extractPostidFromFilename(filename) || getTodayPostid();
  
  // Validate postid
  if (postIdToUse.length !== 4) {
    throw new Error('postid must be exactly 4 characters, e.g. 0805');
  }

  // Load dictionary
  const dictionary = dictionaryPath
    ? await fs.readFile(dictionaryPath)
    : SAIL_DICT;

  // Construct the full path to the markdown file
  // Default to blogPath/_logs/filename.md
  const markdownPath = filename.endsWith('.md')
    ? path.join(blogPath, '_logs', filename)
    : path.join(blogPath, '_logs', `${filename}.md`);

  // Read and parse markdown
  const markdown = await fs.readFile(markdownPath, 'utf-8');
  const { title, date, body } = parseFrontMatter(markdown);

  // Use the date from front matter, or extract from filename
  let postDate = date;
  if (!postDate) {
    const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      postDate = dateMatch[1];
    } else {
      postDate = getTodayPostid(); // Fallback to today
    }
  }

  // Find images in markdown content
  const images = findImagesFromMarkdown(body, postDate, blogPath);

  // Compress and chunk text
  const textBlob = compressText(title, postDate, body, dictionary);
  const textMessages = chunkData(textBlob, postIdToUse, 'T');

  // Compress and chunk images (filter by includeImages if provided)
  const imageMessages = [];
  const imageInfos = [];
  const imagesToEncode = includeImages !== null
    ? images.filter((img, idx) => includeImages.includes(idx))
    : images;

  if (imagesToEncode.length > 0) {
    for (const image of imagesToEncode) {
      try {
        await fs.access(image.resolvedPath);
        const imgResult = await compressImage(image.resolvedPath, imageBudget);
        imageInfos.push({
          alt: image.alt,
          originalPath: image.path,
          ...imgResult
        });
        const imgBlob = imgResult.data;
        // Use different type suffix for multiple images (I, J, K...)
        const typeSuffix = String.fromCharCode(73 + imageMessages.length); // I=73, J=74, etc.
        imageMessages.push(...chunkData(imgBlob, postIdToUse, typeSuffix));
      } catch (error) {
        // Image access error - skip silently, will be reported in preview
      }
    }
  }

  return {
    postid: postIdToUse,
    title,
    date: postDate,
    textMessages,
    imageMessages,
    imageInfos,
    totalMessages: textMessages.length + imageMessages.length,
    foundImages: images.length,
    selectedImages: imagesToEncode.length
  };
}

// Sign message for Winlink transmission using Reticulum Ed25519
async function signForWinlink(content, identityHash) {
  // This will be implemented when we integrate Reticulum identities
  // For now, return a placeholder
  return {
    metadata: `---BEGIN RETICULUM METADATA---\nIdentityHash: ${identityHash}\nAlgorithm: Ed25519\nSig: PLACEHOLDER\n---END RETICULUM METADATA---\n`,
    content: `---BEGIN BLOG POST---\n${content}\n---END BLOG POST---`
  };
}

module.exports = (app) => {
  const plugin = {};

  plugin.id = 'signalk-offshore-blogging';
  plugin.name = 'Offshore Blogging';
  plugin.description = 'Encode blog posts and weather requests for low-bandwidth satellite transmission';

  plugin.start = (options) => {
    // Store configuration for later use
    plugin.config = options || {};
    app.debug('Offshore Blogging plugin started');
    app.setPluginStatus('Ready');
  };

  plugin.registerWithRouter = (router) => {
    // Serve static files
    router.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    });

    // API: Preview compressed images (without chunking)
    router.post('/api/preview-images', async (req, res) => {
      try {
        const { filename, imageBudget } = req.body;

        if (!filename) {
          return res.status(400).json({ error: 'filename is required' });
        }

        // Get blog path from plugin configuration
        const blogPath = plugin.config?.blogSyncPath || '/home/pi/log';

        // Construct the full path to the markdown file
        const markdownPath = filename.endsWith('.md')
          ? path.join(blogPath, '_logs', filename)
          : path.join(blogPath, '_logs', `${filename}.md`);

        // Read and parse markdown
        const markdown = await fs.readFile(markdownPath, 'utf-8');
        const { body } = parseFrontMatter(markdown);

        // Extract date from filename
        const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
        const postDate = dateMatch ? dateMatch[1] : getTodayPostid();

        // Find images in markdown content
        const images = findImagesFromMarkdown(body, postDate, blogPath);

        // Compress images for preview
        const previews = [];
        for (const image of images) {
          try {
            await fs.access(image.resolvedPath);
            const imgResult = await compressImage(image.resolvedPath, imageBudget);
            previews.push({
              alt: image.alt,
              originalPath: image.path,
              resolvedPath: image.resolvedPath,
              width: imgResult.width,
              height: imgResult.height,
              quality: imgResult.quality,
              compressedSize: imgResult.data.length,
              base64: imgResult.data.toString('base64')
            });
          } catch (error) {
            app.error(`Could not access image ${image.resolvedPath}: ${error.message}`);
            previews.push({
              alt: image.alt,
              originalPath: image.path,
              resolvedPath: image.resolvedPath,
              error: `File not found: ${error.message}`
            });
          }
        }

        res.json({ previews, foundImages: images.length });
      } catch (error) {
        app.error(`Preview error: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Encode a blog post for InReach
    router.post('/api/encode', async (req, res) => {
      try {
        const { filename, postid, imageBudget, includeImages } = req.body;

        if (!filename) {
          return res.status(400).json({ error: 'filename is required (e.g., 2026-08-07)' });
        }

        // Get blog path from plugin configuration
        const blogPath = plugin.config?.blogSyncPath || '/home/pi/log';
        const dictPath = plugin.config?.dictionaryPath || null;

        app.debug(`Encoding post: filename=${filename}, blogPath=${blogPath}`);

        const result = await encodeBlogPost(
          filename,
          postid,
          imageBudget,
          dictPath,
          blogPath,
          includeImages // Pass list of images to include
        );

        res.json(result);
      } catch (error) {
        app.error(`Encode error: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Reassemble chunks
    router.post('/api/reassemble', async (req, res) => {
      try {
        const { chunks, type, dictionaryPath } = req.body;

        if (!chunks || !type) {
          return res.status(400).json({ error: 'chunks and type are required' });
        }

        const dictionary = dictionaryPath
          ? await fs.readFile(dictionaryPath)
          : SAIL_DICT;

        const compressed = reassembleChunks(chunks);

        if (type === 'T') {
          const { title, date, body } = decompressText(compressed, dictionary);
          res.json({ title, date, body });
        } else if (type === 'I') {
          // Return base64-encoded image
          const base64 = compressed.toString('base64');
          res.json({ image: `data:image/webp;base64,${base64}` });
        } else {
          res.status(400).json({ error: 'Invalid type, must be T or I' });
        }
      } catch (error) {
        app.error(`Reassemble error: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Sign for Winlink
    router.post('/api/sign', async (req, res) => {
      try {
        const { content, identityHash } = req.body;

        if (!content || !identityHash) {
          return res.status(400).json({ error: 'content and identityHash are required' });
        }

        const result = await signForWinlink(content, identityHash);
        res.json(result);
      } catch (error) {
        app.error(`Sign error: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });
  };

  plugin.stop = () => {
    app.debug('Offshore Blogging plugin stopped');
  };

  plugin.schema = {
    type: 'object',
    properties: {
      blogSyncPath: {
        type: 'string',
        title: 'Blog sync path',
        description: 'Path to the blog directory (e.g., /home/pi/log). Posts should be in _logs/ subdirectory',
        default: '/home/pi/log'
      },
      dictionaryPath: {
        type: 'string',
        title: 'Custom dictionary path',
        description: 'Path to custom compression dictionary file (optional)'
      },
      defaultImageBudget: {
        type: 'number',
        title: 'Default image message budget',
        description: 'Default number of InReach messages for images',
        default: 5,
        minimum: 1,
        maximum: 99
      },
      reticulumIdentityPath: {
        type: 'string',
        title: 'Reticulum identity path',
        description: 'Path to stored Reticulum identity file for Winlink signing. If not provided, will try to use signalk-reticulum plugin\'s identity.',
        default: ''
      }
    }
  };

  return plugin;
};

// Export utility functions for testing
module.exports.calculateCRC16 = calculateCRC16;
module.exports.parseFrontMatter = parseFrontMatter;
module.exports.compressText = compressText;
module.exports.decompressText = decompressText;
module.exports.chunkData = chunkData;
module.exports.reassembleChunks = reassembleChunks;
module.exports.findImagesFromMarkdown = findImagesFromMarkdown;
module.exports.getTodayPostid = getTodayPostid;
module.exports.extractPostidFromFilename = extractPostidFromFilename;
module.exports.SAIL_DICT = SAIL_DICT;