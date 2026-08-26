/**
 * Signal K Offshore Blogging Plugin
 *
 * Provides encoding for blog posts and weather requests for transmission
 * via low-bandwidth satellite systems (InReach, Winlink).
 */

const sharp = require("sharp");
const fs = require("node:fs").promises;
const path = require("node:path");
const { toHex, fromHex, Identity } = require("@reticulum/core");

// Core blog codec logic lives in lib/BlogCodec.js so it can be shared
// between this plugin (encode) and the NoFlo cloud pipeline (decode).
const BlogCodec = require("../lib/BlogCodec.js");
// Server-side GRIB assembly & persistence (decode/download path).
const { GribStore } = require("../lib/GribStore.js");
const {
  DATA_BUDGET,
  SAIL_DICT,
  calculateCRC16,
  compressText,
  decompressText,
  chunkData,
  reassembleChunks,
} = BlogCodec;

// Find images referenced in markdown content
function findImagesFromMarkdown(body, _postDate, blogPath) {
  const images = [];

  // Split the body and find image markers
  const lines = body.split("\n");
  for (const line of lines) {
    const imageMatch = line.match(/!\[([^\]]*)\]\(([^)]+)/);
    if (imageMatch) {
      const alt = imageMatch[1];
      // Find the full image path by scanning from the opening paren
      const parenStart = line.indexOf("(");
      let parenCount = 1;
      let i = parenStart + 1;
      let imagePath = "";

      while (i < line.length && parenCount > 0) {
        if (line[i] === "(") {
          parenCount++;
          imagePath += line[i];
        } else if (line[i] === ")") {
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
      if (imagePath.startsWith("../")) {
        // Path like ../2026/20260716_113823(0).jpg - resolve from blogPath
        const parts = imagePath.split("/");
        const yearDir = parts[1]; // extract '2026'
        const imageName = parts.slice(2).join("/"); // '20260716_113823(0).jpg'
        resolvedPath = path.join(blogPath, yearDir, imageName);
      } else if (path.isAbsolute(imagePath)) {
        resolvedPath = imagePath;
      } else {
        // Relative path, resolve from _logs directory
        resolvedPath = path.resolve(blogPath, "_logs", imagePath);
      }
      images.push({ alt, path: imagePath, resolvedPath });
    }
  }
  return images;
}

// Remove markdown image tags from body text.
// Used for the text-only InReach variant, where no images are transmitted
// and the image references would only waste precious message budget.
// Handles image paths that themselves contain parentheses (e.g. foo(0).jpg)
// by matching one level of balanced nested parentheses inside the URL.
function stripImageMarkdown(body) {
  return body
    .replace(/!\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Get today's date in MMDD format
function getTodayPostid() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${month}${day}`;
}

// Extract postid from filename (handles YYYY-MM-DD.md and YYYY-MM-DD_001.md)
function extractPostidFromFilename(filename) {
  // Extract the date part and any suffix
  const match = filename.match(/(\d{4}-\d{2}-\d{2})(?:_(\d{3}))?/);
  if (match) {
    const datePart = match[1]; // YYYY-MM-DD
    const suffix = match[2]; // 001, 002, etc.
    const monthDay = datePart.slice(5).replace(/-/g, ""); // MMDD
    return suffix ? monthDay + suffix.slice(-1) : monthDay; // MMDD or MMDDN
  }
  return null;
}

// Parse Jekyll front matter from markdown
function parseFrontMatter(text) {
  const match = text.match(/^---\n(.*?)\n---\n(.*)$/s);
  if (!match) {
    throw new Error("Post has no YAML front matter (--- ... ---) block");
  }
  const fmRaw = match[1];
  const body = match[2].trim();

  const frontMatter = {};
  for (const line of fmRaw.split("\n")) {
    if (line.includes(":")) {
      const colonIdx = line.indexOf(":");
      const key = line.slice(0, colonIdx).trim();
      const value = line
        .slice(colonIdx + 1)
        .trim()
        .replace(/^"|"$/g, "");
      frontMatter[key] = value;
    }
  }

  // Support both 'date' and 'created' fields (created is used in the log).
  // The key is hardcoded to 'created' on the cloud side, so we only need
  // the value here.
  if (!frontMatter.title) {
    throw new Error("Front matter must include at least title:");
  }
  if (!frontMatter.date && !frontMatter.created) {
    throw new Error("Front matter must include at least date: or created:");
  }

  return {
    title: frontMatter.title,
    date: frontMatter.date || frontMatter.created,
    body,
  };
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

      const b64Len = Buffer.byteLength(data.toString("base64"));
      const nMsgs = Math.ceil(b64Len / DATA_BUDGET);

      if (nMsgs <= budgetMsgs) {
        if (!best || w * h > best.width * best.height) {
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
        "raise --image-budget or shrink the source photo.",
    );
  }

  return best;
}

// Encode a complete blog post
async function encodeBlogPost(
  filename,
  postid,
  imageBudget,
  dictionaryPath,
  blogPath,
  includeImages = null,
) {
  // Auto-extract postid from filename if not provided
  const postIdToUse =
    postid || extractPostidFromFilename(filename) || getTodayPostid();

  // Validate postid
  if (postIdToUse.length !== 4) {
    throw new Error("postid must be exactly 4 characters, e.g. 0805");
  }

  // Load dictionary
  const dictionary = dictionaryPath
    ? await fs.readFile(dictionaryPath)
    : SAIL_DICT;

  // Construct the full path to the markdown file
  // Default to blogPath/_logs/filename.md
  const markdownPath = filename.endsWith(".md")
    ? path.join(blogPath, "_logs", filename)
    : path.join(blogPath, "_logs", `${filename}.md`);

  // Read and parse markdown
  const markdown = await fs.readFile(markdownPath, "utf-8");
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

  // The filename is transmitted inside the compressed blob so the cloud
  // server writes the post to the exact same _logs/<filename>.md path the
  // boat uses — no reconstruction, no slugification, the name stays
  // unmodified. Strip .md and any directory components; only the base name
  // matters for the remote path.
  const baseFilename = path.basename(filename).replace(/\.md$/, "");

  // Compress and chunk the text-only variant. The text-only InReach variant
  // carries no images, so the markdown image tags are stripped from the body
  // to save message budget.
  const textOnlyBody = stripImageMarkdown(body);
  const textBlob = compressText(
    baseFilename,
    title,
    postDate,
    textOnlyBody,
    dictionary,
  );
  const textMessages = chunkData(textBlob, postIdToUse, "T");

  // Compress and chunk the full body (with image markdown retained). The
  // image variant uses these so the receiving server knows where to place the
  // separately-transmitted image chunks.
  const fullTextBlob = compressText(
    baseFilename,
    title,
    postDate,
    body,
    dictionary,
  );
  const fullTextMessages = chunkData(fullTextBlob, postIdToUse, "T");

  // Compress and chunk images (filter by includeImages if provided)
  const imageMessages = [];
  const imageInfos = [];
  const imagesToEncode =
    includeImages != null
      ? images.filter((_img, idx) => includeImages.includes(idx))
      : images;

  if (imagesToEncode.length > 0) {
    for (const image of imagesToEncode) {
      try {
        await fs.access(image.resolvedPath);
        const imgResult = await compressImage(image.resolvedPath, imageBudget);
        imageInfos.push({
          alt: image.alt,
          originalPath: image.path,
          ...imgResult,
        });
        const imgBlob = imgResult.data;
        // Use different type suffix for multiple images (I, J, K...)
        const typeSuffix = String.fromCharCode(73 + imageMessages.length); // I=73, J=74, etc.
        imageMessages.push(...chunkData(imgBlob, postIdToUse, typeSuffix));
      } catch (_error) {
        // Image access error - skip silently, will be reported in preview
      }
    }
  }

  return {
    postid: postIdToUse,
    filename: baseFilename,
    title,
    date: postDate,
    textMessages,
    fullTextMessages,
    imageMessages,
    imageInfos,
    totalMessages: fullTextMessages.length + imageMessages.length,
    foundImages: images.length,
    selectedImages: imagesToEncode.length,
  };
}

// Load Reticulum identity from signalk-reticulum plugin config or file path
async function loadReticulumIdentity(app, identityPath) {
  // Try file path first (explicit configuration)
  if (identityPath) {
    try {
      await fs.access(identityPath, fs.constants.R_OK);
      const keyData = await fs.readFile(identityPath, "utf-8");
      const privateKeyHex = keyData.trim();
      const privateKey = fromHex(privateKeyHex);
      const identity = await Identity.fromBytes(privateKey);
      app.debug(`Loaded identity from file: ${identityPath}`);
      return identity;
    } catch (error) {
      app.debug(
        `Could not load identity from file ${identityPath}: ${error.message}`,
      );
    }
  }

  // Try to read from signalk-reticulum plugin configuration file
  const skConfigPaths = [];

  // Use app.getDataDirPath() if available to get the Signal K data directory
  if (typeof app.getDataDirPath === "function") {
    try {
      const dataDir = app.getDataDirPath();
      skConfigPaths.push(
        path.join(dataDir, "plugin-config-data", "signalk-reticulum.json"),
        path.join(dataDir, "plugin-config-data", "signalk-reticulum"),
      );
    } catch (error) {
      app.debug(`Could not get data directory path: ${error.message}`);
    }
  }

  // Fallback to common locations
  skConfigPaths.push(
    path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".signalk",
      "plugin-config-data",
      "signalk-reticulum.json",
    ),
    path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".signalk",
      "plugin-config-data",
      "signalk-reticulum",
    ),
    path.join(process.cwd(), "plugin-config-data", "signalk-reticulum.json"),
  );

  for (const configPath of skConfigPaths) {
    try {
      await fs.access(configPath, fs.constants.R_OK);
      const configData = await fs.readFile(configPath, "utf-8");
      const config = JSON.parse(configData);

      if (config.configuration?.identity?.privateKey) {
        const privateKeyHex = config.configuration.identity.privateKey.trim();
        const privateKey = fromHex(privateKeyHex);
        const identity = await Identity.fromBytes(privateKey);
        app.debug(
          `Loaded identity from signalk-reticulum config: ${configPath}`,
        );
        return identity;
      }
    } catch (error) {
      app.debug(
        `Could not load identity from signalk-reticulum config ${configPath}: ${error.message}`,
      );
    }
  }

  // Try to get from signalk-reticulum plugin instance
  // Signal K stores loaded plugins in different ways depending on version
  try {
    if (app.plugins?.["signalk-reticulum"]) {
      const reticulumPlugin = app.plugins["signalk-reticulum"];
      if (reticulumPlugin.identity) {
        app.debug("Using identity from signalk-reticulum plugin (app.plugins)");
        return reticulumPlugin.identity;
      }
    }
  } catch (error) {
    app.debug(
      `Could not access signalk-reticulum via app.plugins: ${error.message}`,
    );
  }

  try {
    if (app.pluginManager?.plugins) {
      const reticulumPlugin =
        app.pluginManager.plugins.get("signalk-reticulum");
      if (reticulumPlugin?.identity) {
        app.debug(
          "Using identity from signalk-reticulum plugin (app.pluginManager)",
        );
        return reticulumPlugin.identity;
      }
    }
  } catch (error) {
    app.debug(
      `Could not access signalk-reticulum via pluginManager: ${error.message}`,
    );
  }

  // Try to read from common Reticulum identity locations
  const commonPaths = [
    path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".reticulum",
      "identity",
    ),
    path.join("/", "var", "lib", "reticulum", "identity"),
    path.join(process.cwd(), ".reticulum", "identity"),
  ];

  for (const testPath of commonPaths) {
    try {
      await fs.access(testPath, fs.constants.R_OK);
      const keyData = await fs.readFile(testPath, "utf-8");
      const privateKeyHex = keyData.trim();
      const privateKey = fromHex(privateKeyHex);
      const identity = await Identity.fromBytes(privateKey);
      app.debug(`Loaded identity from common location: ${testPath}`);
      return identity;
    } catch (_error) {
      // Continue to next path
    }
  }

  app.debug(
    "No Reticulum identity found - Winlink signing will be unavailable",
  );
  return null;
}

// Sign message for Winlink transmission using Reticulum Ed25519
// Formats the blog post with filename, date, and images for cloud server processing
//
// Winlink email format:
//   Filename: <filename> - where to write the .md file (_logs/filename.md)
//   Date: <date> - Jekyll front matter 'created:' field
//   Images: <count> - number of images
//   Image_0: <path>|<base64> - path from markdown (e.g., ../2026/img.webp) and image data
//   Image_1: <path>|<base64>
//   ...
//   (blank line)
//   <title> - Jekyll front matter 'title:' field (single line)
//   (blank line)
//   <body> - markdown with original image paths
async function signForWinlink(
  filename,
  title,
  date,
  body,
  imageInfos,
  identity,
) {
  if (!identity) {
    throw new Error("No identity provided for signing");
  }

  const { toHex } = require("@reticulum/core");

  // Get identity hash (SHA-256 truncated to 16 bytes, hex-encoded)
  const identityHashHex = toHex(identity.identityHash);

  // Normalize date to ISO format (YYYY-MM-DD) for Jekyll front matter
  // Accepts both simple dates (2026-07-16) and ISO timestamps (2026-07-16T16:35:17-10:00)
  let normalizedDate = date;
  const dateMatch = date.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    normalizedDate = dateMatch[1];
  }

  // Build content header with structured fields
  let contentHeader = `Filename: ${filename}\n`;
  contentHeader += `Date: ${normalizedDate}\n`;
  contentHeader += `Title: ${title}\n`;
  contentHeader += `Images: ${imageInfos.length}\n`;

  // Add images with their markdown paths (same order as body references)
  for (let i = 0; i < imageInfos.length; i++) {
    const imgInfo = imageInfos[i];
    const path = imgInfo.originalPath; // Path as it appears in markdown
    const base64Data = imgInfo.data.toString("base64");
    contentHeader += `Image_${i}: ${path}|${base64Data}\n`;
  }

  // Blank line separates header from post content (body only)
  const content = `${contentHeader}\n${body}`;

  // Sign the content using Ed25519
  const contentBytes = Buffer.from(content, "utf-8");
  const signature = await identity.sign(contentBytes);
  const sigHex = toHex(signature);

  // Include the 64-byte public key (X25519 ‖ Ed25519) so the cloud can verify
  // the signature AND recompute the identityHash to confirm the key matches
  // the claimed IdentityHash — without it the cloud would need an out-of-band
  // identity directory to resolve hash→pubkey (see components/AuthVerifier.js).
  const publicKey = await identity.getPublicKey();
  const publicKeyHex = toHex(publicKey);

  return {
    metadata: `---BEGIN RETICULUM METADATA---\nIdentityHash: ${identityHashHex}\nPublicKey: ${publicKeyHex}\nAlgorithm: Ed25519\nSig: ${sigHex}\n---END RETICULUM METADATA---\n`,
    content: `---BEGIN BLOG POST---\n${content}\n---END BLOG POST---`,
  };
}

module.exports = (app) => {
  const plugin = {};

  plugin.id = "signalk-offshore-blogging";
  plugin.name = "Offshore Blogging";
  plugin.description =
    "Encode blog posts and weather requests for low-bandwidth satellite transmission";

  plugin.start = async (options) => {
    // Store configuration for later use
    plugin.config = options || {};

    // Load Reticulum identity for Winlink signing
    plugin.identity = await loadReticulumIdentity(
      app,
      options.reticulumIdentityPath,
    );
    if (plugin.identity) {
      app.debug("Reticulum identity loaded for Winlink signing");
    } else {
      app.debug("No Reticulum identity available - Winlink signing disabled");
    }

    app.debug("Offshore Blogging plugin started");
    app.setPluginStatus("Ready");
  };

  // Lazy GRIB store (server-side assembly + persistence). Created on first
  // use so tests can inject a temp dir via config.gribStoragePath without
  // touching the real Signal K data directory. Assembled GRIBs are persisted
  // here so any Signal K user can download them, not only the originator.
  //
  // GRIB files are stored in <dir>/<sourceName>/ (default: "inreach") to be
  // compatible with signalk-grib-weather-provider, which can discover and
  // ingest them for querying via the Signal K weather API.
  plugin.getGribStore = function getGribStore() {
    if (!plugin._gribStore) {
      const base =
        typeof app.getDataDirPath === "function"
          ? app.getDataDirPath()
          : path.join(
              process.env.HOME || process.env.USERPROFILE || process.cwd(),
              ".signalk",
            );
      const dir =
        plugin.config?.gribStoragePath ||
        path.join(base, "signalk-offshore-blogging", "gribs");
      const sourceName = plugin.config?.gribSourceName || "inreach";
      plugin._gribStore = new GribStore(dir, sourceName);
    }
    return plugin._gribStore;
  };

  plugin.registerWithRouter = (router) => {
    // Static webapp files are served by the Signal K server itself: this
    // package has the `signalk-webapp` keyword, so the server auto-mounts
    // the public/ directory at /plugins/signalk-offshore-blogging/.
    // Only the JSON API routes are registered here.

    // API: Feature status (so the UI can show/hide opt-in features)
    router.get("/api/status", (_req, res) => {
      res.json({
        blogEnabled: !!plugin.config?.enableBlogEncoding,
        defaultImageBudget: plugin.config?.defaultImageBudget || 5,
        // GRIB store is always available (decode/download, no opt-in needed):
        gribStoreEnabled: true,
      });
    });

    // API: Preview compressed images (without chunking)
    router.post("/api/preview-images", async (req, res) => {
      if (!plugin.config?.enableBlogEncoding) {
        return res.status(403).json({
          error:
            "Blog encoding is not enabled. Enable it in the plugin configuration.",
        });
      }
      try {
        const { filename, imageBudget } = req.body;

        if (!filename) {
          return res.status(400).json({ error: "filename is required" });
        }

        // Get blog path from plugin configuration
        const blogPath = plugin.config?.blogSyncPath || "/home/pi/log";

        // Construct the full path to the markdown file
        const markdownPath = filename.endsWith(".md")
          ? path.join(blogPath, "_logs", filename)
          : path.join(blogPath, "_logs", `${filename}.md`);

        // Read and parse markdown
        const markdown = await fs.readFile(markdownPath, "utf-8");
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
            const imgResult = await compressImage(
              image.resolvedPath,
              imageBudget,
            );
            previews.push({
              alt: image.alt,
              originalPath: image.path,
              resolvedPath: image.resolvedPath,
              width: imgResult.width,
              height: imgResult.height,
              quality: imgResult.quality,
              compressedSize: imgResult.data.length,
              base64: imgResult.data.toString("base64"),
            });
          } catch (error) {
            app.error(
              `Could not access image ${image.resolvedPath}: ${error.message}`,
            );
            previews.push({
              alt: image.alt,
              originalPath: image.path,
              resolvedPath: image.resolvedPath,
              error: `File not found: ${error.message}`,
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
    router.post("/api/encode", async (req, res) => {
      if (!plugin.config?.enableBlogEncoding) {
        return res.status(403).json({
          error:
            "Blog encoding is not enabled. Enable it in the plugin configuration.",
        });
      }
      try {
        const { filename, postid, imageBudget, includeImages } = req.body;

        if (!filename) {
          return res
            .status(400)
            .json({ error: "filename is required (e.g., 2026-08-07)" });
        }

        // Get blog path from plugin configuration
        const blogPath = plugin.config?.blogSyncPath || "/home/pi/log";
        const dictPath = plugin.config?.dictionaryPath || null;

        app.debug(`Encoding post: filename=${filename}, blogPath=${blogPath}`);

        const result = await encodeBlogPost(
          filename,
          postid,
          imageBudget,
          dictPath,
          blogPath,
          includeImages, // Pass list of images to include
        );

        // Also generate Winlink signed content if identity is available
        let winlinkData = null;
        if (plugin.identity) {
          try {
            const markdownPath = filename.endsWith(".md")
              ? path.join(blogPath, "_logs", filename)
              : path.join(blogPath, "_logs", `${filename}.md`);
            const markdown = await fs.readFile(markdownPath, "utf-8");
            const { title, date: _date, body } = parseFrontMatter(markdown);

            // Use the date from front matter, or extract from filename
            let postDate = _date;
            if (!postDate) {
              const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
              if (dateMatch) {
                postDate = dateMatch[1];
              } else {
                postDate = getTodayPostid(); // Fallback to today
              }
            }

            // Collect image infos for Winlink (using already-compressed lo-fi images)
            const winlinkImages = [];
            if (result.selectedImages > 0 && result.imageInfos) {
              winlinkImages.push(...result.imageInfos);
            }

            const signed = await signForWinlink(
              result.filename,
              title,
              postDate,
              body,
              winlinkImages,
              plugin.identity,
            );
            winlinkData = {
              metadata: signed.metadata,
              content: signed.content,
              identityHash: toHex(plugin.identity.identityHash),
            };
          } catch (error) {
            app.warn(`Could not generate Winlink content: ${error.message}`);
            winlinkData = { error: error.message };
          }
        } else {
          winlinkData = { error: "No Reticulum identity available" };
        }

        res.json({ ...result, winlink: winlinkData });
      } catch (error) {
        app.error(`Encode error: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Reassemble chunks
    router.post("/api/reassemble", async (req, res) => {
      try {
        const { chunks, type, dictionaryPath } = req.body;

        if (!chunks || !type) {
          return res
            .status(400)
            .json({ error: "chunks and type are required" });
        }

        const dictionary = dictionaryPath
          ? await fs.readFile(dictionaryPath)
          : SAIL_DICT;

        const compressed = reassembleChunks(chunks);

        if (type === "T") {
          const { filename, title, date, body } = decompressText(
            compressed,
            dictionary,
          );
          res.json({ filename, title, date, body });
        } else if (type === "I") {
          // Return base64-encoded image
          const base64 = compressed.toString("base64");
          res.json({ image: `data:image/webp;base64,${base64}` });
        } else {
          res.status(400).json({ error: "Invalid type, must be T or I" });
        }
      } catch (error) {
        app.error(`Reassemble error: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Assemble GRIB chunks server-side and persist for shared download.
    // Accepts raw compact-header chunks (type 'G'); the server parses,
    // validates, and stores the binary so any Signal K user can download it
    // later. Listed latest-first via GET /api/gribs.
    router.post("/api/grib/assemble", async (req, res) => {
      try {
        const { chunks, requestedBy } = req.body || {};
        if (!Array.isArray(chunks) || chunks.length === 0) {
          return res.status(400).json({
            error:
              "chunks (non-empty array of compact-header strings) is required",
          });
        }
        const store = plugin.getGribStore();
        const entry = await store.persist(chunks, requestedBy);
        app.debug(
          `Persisted GRIB ${entry.transmissionId} (${entry.size} bytes)`,
        );
        res.json({ ok: true, grib: entry });
      } catch (error) {
        if (error.code === "MISSING_CHUNKS") {
          return res.status(409).json({
            error: error.message,
            missing: error.missing,
            total: error.total,
          });
        }
        if (error.code === "BAD_MAGIC") {
          return res.status(422).json({
            error: error.message,
            magic: error.magic,
          });
        }
        if (error.code === "NOT_GRIB" || error.code === "BAD_FORMAT") {
          return res.status(400).json({ error: error.message });
        }
        app.error(`GRIB assemble error: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // API: List persisted GRIBs, latest-first.
    router.get("/api/gribs", async (_req, res) => {
      try {
        const store = plugin.getGribStore();
        const gribs = await store.list();
        res.json({ gribs });
      } catch (error) {
        app.error(`GRIB list error: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Download a persisted GRIB by id (transmissionId).
    router.get("/api/gribs/:id/download", async (req, res) => {
      try {
        const store = plugin.getGribStore();
        const filepath = store.getFilePath(req.params.id);
        await fs.access(filepath);
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${req.params.id}.grb"`,
        );
        // Determine GRIB edition to set correct MIME type
        // GRIB edition is at byte 8 (0-indexed), with values 1 or 2
        const gribData = await fs.readFile(filepath);
        const edition = gribData.length >= 9 ? gribData[8] : 1;
        const contentType =
          edition === 2 ? "application/x-grib2" : "application/x-grib";
        res.setHeader("Content-Type", contentType);
        res.sendFile(filepath);
      } catch (error) {
        if (error.code === "BAD_ID") {
          return res.status(400).json({ error: error.message });
        }
        res.status(404).json({ error: "GRIB not found" });
      }
    });

    // API: Upload a complete GRIB file (Winlink/Saildocs path).
    //
    // When a GRIB is received via Winlink/Pat as an email attachment from
    // query@saildocs.com, the user already has the whole file on a device.
    // This endpoint accepts the raw GRIB bytes (either as the request body
    // with Content-Type application/octet-stream, or as JSON
    // `{ "gribBase64": "..." }` for browsers that can't easily send raw
    // bodies) and persists it through the same GribStore so it lands in the
    // signalk-grib-weather-provider source directory — making it queryable
    // via the Signal K weather API and downloadable by any Signal K user.
    //
    // Optional metadata via query string or headers:
    //   ?id=<4-char>      — explicit id (default: hash of the binary)
    //   ?filename=<name>  — original filename (e.g. the email attachment name)
    //   ?requestedBy=<id> — originator identity hash / label
    router.post("/api/grib/upload", async (req, res) => {
      try {
        let binary;
        const contentType = (req.headers["content-type"] || "").toLowerCase();

        if (contentType.includes("application/json")) {
          // JSON form: { gribBase64: "..." }
          const body = req.body || {};
          const b64 = body.gribBase64;
          if (typeof b64 !== "string" || b64.length === 0) {
            return res
              .status(400)
              .json({ error: "gribBase64 is required for JSON uploads" });
          }
          binary = Buffer.from(b64.replace(/\s+/g, ""), "base64");
        } else {
          // Raw body: the request body IS the GRIB bytes.
          // Express exposes the body on req.body; for unknown content types it
          // may be a Buffer, a string, or empty depending on body parsing.
          const raw = req.body;
          if (Buffer.isBuffer(raw)) {
            binary = raw;
          } else if (typeof raw === "string") {
            binary = Buffer.from(raw, "binary");
          } else if (raw && typeof raw === "object" && raw.type === "Buffer") {
            // Parsed JSON { type:'Buffer', data:[...] } fallback.
            binary = Buffer.from(raw.data);
          } else {
            return res.status(400).json({
              error:
                "Send the raw GRIB bytes as the body (Content-Type: " +
                "application/octet-stream), or JSON { gribBase64 }.",
            });
          }
        }

        // Pull optional metadata from query (or headers) so the raw-body
        // path doesn't need JSON.
        const id = req.query.id || req.headers["x-grib-id"];
        const filename = req.query.filename || req.headers["x-grib-filename"];
        const requestedBy =
          req.query.requestedBy || req.headers["x-grib-requested-by"];

        const store = plugin.getGribStore();
        const entry = await store.persistBinary(binary, {
          id: id || undefined,
          filename: filename || undefined,
          requestedBy: requestedBy || undefined,
        });
        app.debug(
          `Uploaded GRIB ${entry.transmissionId} (${entry.size} bytes)`,
        );
        res.status(201).json({ ok: true, grib: entry });
      } catch (error) {
        if (error.code === "BAD_MAGIC") {
          return res.status(422).json({
            error: error.message,
            magic: error.magic,
          });
        }
        if (error.code === "BAD_FORMAT") {
          return res.status(400).json({ error: error.message });
        }
        if (error.code === "BAD_ID") {
          return res.status(400).json({ error: error.message });
        }
        app.error(`GRIB upload error: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Sign for Winlink
    router.post("/api/sign", async (req, res) => {
      if (!plugin.config?.enableBlogEncoding) {
        return res.status(403).json({
          error:
            "Blog encoding is not enabled. Enable it in the plugin configuration.",
        });
      }
      try {
        const { filename } = req.body;

        if (!filename) {
          return res.status(400).json({ error: "filename is required" });
        }

        if (!plugin.identity) {
          return res.status(503).json({
            error:
              "No Reticulum identity available for signing. Configure reticulumIdentityPath or ensure signalk-reticulum plugin is installed.",
          });
        }

        // Get blog path and read the post
        const blogPath = plugin.config?.blogSyncPath || "/home/pi/log";
        const _dictPath = plugin.config?.dictionaryPath || null;
        const markdownPath = filename.endsWith(".md")
          ? path.join(blogPath, "_logs", filename)
          : path.join(blogPath, "_logs", `${filename}.md`);

        const markdown = await fs.readFile(markdownPath, "utf-8");
        const { title, date: _date, body } = parseFrontMatter(markdown);

        // Use the date from front matter, or extract from filename
        let postDate = _date;
        if (!postDate) {
          const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
          if (dateMatch) {
            postDate = dateMatch[1];
          } else {
            postDate = getTodayPostid(); // Fallback to today
          }
        }

        // Find and compress all images for Winlink
        const winlinkImages = [];
        const images = findImagesFromMarkdown(body, postDate, blogPath);
        for (const image of images) {
          try {
            await fs.access(image.resolvedPath);
            // Use a generous budget for manual Winlink signing
            const imgResult = await compressImage(image.resolvedPath, 20);
            winlinkImages.push({
              alt: image.alt,
              originalPath: image.path,
              ...imgResult,
            });
          } catch (_error) {
            // Image access error - skip
            app.debug(
              `Could not read image ${image.resolvedPath} for Winlink signing`,
            );
          }
        }

        const baseFilename = path.basename(filename).replace(/\.md$/, "");
        const result = await signForWinlink(
          baseFilename,
          title,
          postDate,
          body,
          winlinkImages,
          plugin.identity,
        );

        res.json({
          metadata: result.metadata,
          content: result.content,
          identityHash: toHex(plugin.identity.identityHash),
        });
      } catch (error) {
        app.error(`Sign error: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });
  };

  plugin.stop = () => {
    app.debug("Offshore Blogging plugin stopped");
  };

  plugin.schema = {
    type: "object",
    properties: {
      enableBlogEncoding: {
        type: "boolean",
        title: "Enable blog post encoding",
        description:
          "Enable the blog post encoding feature. Off by default since it requires a blog directory to be configured via 'Blog sync path' and most users only need the weather/decode tools.",
        default: false,
      },
      blogSyncPath: {
        type: "string",
        title: "Blog sync path",
        description:
          "Path to the blog directory (e.g., /home/pi/log). Posts should be in _logs/ subdirectory",
        default: "/home/pi/log",
      },
      dictionaryPath: {
        type: "string",
        title: "Custom dictionary path",
        description: "Path to custom compression dictionary file (optional)",
      },
      defaultImageBudget: {
        type: "number",
        title: "Default image message budget",
        description: "Default number of InReach messages for images",
        default: 5,
        minimum: 1,
        maximum: 99,
      },
      reticulumIdentityPath: {
        type: "string",
        title: "Reticulum identity path",
        description:
          "Path to stored Reticulum identity file for Winlink signing. If not provided, will try to use signalk-reticulum plugin's identity.",
        default: "",
      },
      gribStoragePath: {
        type: "string",
        title: "GRIB storage path (optional)",
        description:
          "Where to persist assembled GRIB files so any Signal K user can download them. Defaults to <Signal K data dir>/signalk-offshore-blogging/gribs.",
        default: "",
      },
      gribSourceName: {
        type: "string",
        title: "GRIB source name",
        description:
          "Subdirectory where GRIB files are stored (e.g., 'inreach'). This becomes the source name for signalk-grib-weather-provider. Configure the weather plugin's rootDirectory to this same path to enable GRIB querying. Both InReach-assembled and directly-uploaded (Winlink/Saildocs) GRIBs land here.",
        default: "inreach",
      },
    },
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
module.exports.stripImageMarkdown = stripImageMarkdown;
module.exports.encodeBlogPost = encodeBlogPost;
module.exports.getTodayPostid = getTodayPostid;
module.exports.extractPostidFromFilename = extractPostidFromFilename;
module.exports.SAIL_DICT = SAIL_DICT;
