/**
 * Signal K Offshore Blogging Plugin
 *
 * Provides encoding for blog posts and weather requests for transmission
 * via low-bandwidth satellite systems (InReach, Winlink).
 */

const sharp = require("sharp");
const fs = require("node:fs").promises;
const path = require("node:path");
const { toHex } = require("@reticulum/core");

// Core blog codec logic lives in lib/BlogCodec.js so it can be shared
// between this plugin (encode) and the NoFlo cloud pipeline (decode).
const BlogCodec = require("../lib/BlogCodec.js");
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

  // Support both 'date' and 'created' fields (created is used in the log)
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

  // Compress and chunk the text-only variant. The text-only InReach variant
  // carries no images, so the markdown image tags are stripped from the body
  // to save message budget.
  const textOnlyBody = stripImageMarkdown(body);
  const textBlob = compressText(title, postDate, textOnlyBody, dictionary);
  const textMessages = chunkData(textBlob, postIdToUse, "T");

  // Compress and chunk the full body (with image markdown retained). The
  // image variant uses these so the receiving server knows where to place the
  // separately-transmitted image chunks.
  const fullTextBlob = compressText(title, postDate, body, dictionary);
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
  const { Identity } = require("@reticulum/core");

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
async function signForWinlink(content, identity) {
  if (!identity) {
    throw new Error("No identity provided for signing");
  }

  const { toHex } = require("@reticulum/core");

  // Get identity hash (SHA-256 truncated to 16 bytes, hex-encoded)
  const identityHashHex = toHex(identity.identityHash);

  // Sign the content using Ed25519
  const contentBytes = Buffer.from(content, "utf-8");
  const signature = await identity.sign(contentBytes);
  const sigHex = toHex(signature);

  return {
    metadata: `---BEGIN RETICULUM METADATA---\nIdentityHash: ${identityHashHex}\nAlgorithm: Ed25519\nSig: ${sigHex}\n---END RETICULUM METADATA---\n`,
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

  plugin.registerWithRouter = (router) => {
    // Serve static files
    router.get("/", (_req, res) => {
      res.sendFile(path.join(__dirname, "..", "public", "index.html"));
    });

    // API: Feature status (so the UI can show/hide opt-in features)
    router.get("/api/status", (_req, res) => {
      res.json({
        blogEnabled: !!plugin.config?.enableBlogEncoding,
        defaultImageBudget: plugin.config?.defaultImageBudget || 5,
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
            const content = `${title}\n\n${body}`;
            const signed = await signForWinlink(content, plugin.identity);
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
          const { title, date, body } = decompressText(compressed, dictionary);
          res.json({ title, date, body });
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

        // Format as plain text email body
        const content = `${title}\n\n${body}`;

        const result = await signForWinlink(content, plugin.identity);

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
