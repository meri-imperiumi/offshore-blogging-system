const { Component } = require("noflo-assembly");

/**
 * WinlinkBlogReceiver - Parses Winlink blog post emails and converts to GitPublisher format
 *
 * Sits after AuthVerifier in the pipeline. Detects Winlink blog posts by checking:
 * - msg.channel === 'winlink'
 * - msg.payload contains '---BEGIN BLOG POST---' marker
 *
 * Winlink blog posts have this structure within the signed content:
 *   Filename: <filename>
 *   Date: <date>
 *   Images: <count>
 *   Image_0: <base64 data>
 *   Image_1: <base64 data>
 *   ...
 *   (blank line)
 *   Title
 *   (blank line)
 *   Body
 *
 * Converts to GitPublisher format:
 *   msg.payload = {
 *     filename,
 *     title,
 *     date,
 *     bodyMarkdown,
 *     postId: <generated from identityHash or timestamp>,
 *     imageBuffers,
 *     imageCount
 *   }
 *
 * Sets msg.intent = 'BLOG' for proper routing by ParserRouter.
 *
 * Non-Winlink messages pass through unchanged.
 */
class WinlinkBlogReceiver extends Component {
  constructor() {
    super({
      description:
        "Parses Winlink blog post emails and converts to GitPublisher format",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message from AuthVerifier",
          required: true,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description:
            "Assembly message (Winlink blogs converted, others passed through)",
        },
      },
    });
  }

  handle(input, output) {
    if (!input.hasData("in")) {
      return;
    }

    const msg = input.getData("in");

    // Check if this is a Winlink blog post
    if (msg.channel !== "winlink") {
      // Not Winlink - pass through unchanged
      return output.sendDone(msg);
    }

    const bodyText = Buffer.isBuffer(msg.payload)
      ? msg.payload.toString("utf-8")
      : String(msg.payload || "");

    // Check for Winlink blog post marker
    const blogMatch = bodyText.match(
      /---BEGIN BLOG POST---\r?\n([\s\S]*?)\r?\n---END BLOG POST---/,
    );

    if (!blogMatch) {
      // Winlink message but not a blog post - pass through
      return output.sendDone(msg);
    }

    const content = blogMatch[1];
    const parsed = this.parseWinlinkBlogContent(content);

    if (!parsed) {
      // Failed to parse - pass through with error
      msg.errors = msg.errors || [];
      msg.errors.push(new Error("Failed to parse Winlink blog post content"));
      return output.sendDone(msg);
    }

    // Convert to GitPublisher format
    msg.payload = {
      filename: parsed.filename,
      title: parsed.title,
      date: parsed.date,
      bodyMarkdown: parsed.body,
      postId: this.generatePostId(msg),
      imageBuffers: parsed.images,
      imageCount: parsed.images.length,
    };
    msg.intent = "BLOG";

    return output.sendDone(msg);
  }

  /**
   * Parse Winlink blog post content
   *
   * Format:
   *   Filename: <filename>
   *   Date: <date>
   *   Images: <count>
   *   Image_0: <path>|<base64>
   *   Image_1: <path>|<base64>
   *   ...
   *   (blank line)
   *   Title
   *   (blank line)
   *   Body
   *
   * The path is the image reference as it appears in the markdown body
   * (e.g., "../2026/20260716_123456.webp"), so imageBuffers[i]
   * matches the i-th markdown image reference, matching GitPublisher's
   * expectation.
   *
   * @param {string} content - Content between BEGIN/END BLOG POST markers
   * @returns {Object|null} Parsed blog post or null on failure
   */
  parseWinlinkBlogContent(content) {
    const lines = content.split(/\r?\n/);

    let filename = null;
    let date = null;
    let imageCount = 0;
    const images = [];

    // Parse header fields
    let headerLineIdx = 0;
    for (; headerLineIdx < lines.length; headerLineIdx++) {
      const line = lines[headerLineIdx].trim();

      // Blank line marks end of header
      if (line === "") {
        headerLineIdx++;
        break;
      }

      // Filename: <value>
      const filenameMatch = line.match(/^Filename:\s*(.+)$/);
      if (filenameMatch) {
        filename = filenameMatch[1].trim();
        continue;
      }

      // Date: <value>
      const dateMatch = line.match(/^Date:\s*(.+)$/);
      if (dateMatch) {
        date = dateMatch[1].trim();
        // Normalize to ISO date (YYYY-MM-DD) - strip time if present
        const simpleDate = date.match(/^(\d{4}-\d{2}-\d{2})/);
        if (simpleDate) {
          date = simpleDate[1];
        }
        continue;
      }

      // Images: <count>
      const imagesMatch = line.match(/^Images:\s*(\d+)$/);
      if (imagesMatch) {
        imageCount = parseInt(imagesMatch[1], 10);
        continue;
      }

      // Image_N: <path>|<base64>
      const imgMatch = line.match(/^Image_(\d+):\s*(.+)$/);
      if (imgMatch) {
        const idx = parseInt(imgMatch[1], 10);
        const fullPath = imgMatch[2].trim();
        const pipeIdx = fullPath.indexOf("|");
        if (pipeIdx !== -1) {
          const path = fullPath.slice(0, pipeIdx);
          const base64 = fullPath.slice(pipeIdx + 1);
          try {
            images[idx] = Buffer.from(base64, "base64");
          } catch (_err) {
            // Invalid base64 - skip
          }
        }
      }
    }

    // Validate required fields
    if (!filename || !date) {
      return null;
    }

    // Extract title (first non-empty line after header)
    let title = "";
    for (; headerLineIdx < lines.length; headerLineIdx++) {
      const line = lines[headerLineIdx];
      if (line.trim() !== "") {
        title = line;
        headerLineIdx++; // Move past title line
        break;
      }
    }

    // Skip blank line after title
    if (headerLineIdx < lines.length && lines[headerLineIdx].trim() === "") {
      headerLineIdx++;
    }

    // Extract body (remaining lines)
    const body = lines.slice(headerLineIdx).join("\n");

    // Validate images count matches parsed images
    if (imageCount !== images.length) {
      console.warn(
        `[WinlinkBlogReceiver] Images count (${imageCount}) does not match parsed images (${images.length})`,
      );
    }

    return {
      filename,
      date,
      title,
      body,
      images,
    };
  }

  /**
   * Generate a postId for the Winlink blog post.
   *
   * Since Winlink posts don't have transmission IDs (they're not chunked),
   * we generate one from the identity hash and current time.
   *
   * @param {Object} msg - Assembly message
   * @returns {string} 4-character postId
   */
  generatePostId(msg) {
    // Use identity hash + timestamp to generate consistent-ish ID
    const hash = msg.identityHash || "unknown";
    const time = Date.now().toString();
    const combined = hash + time;

    // Take last 4 characters, convert to hex if needed
    let postId = combined.slice(-4);

    // Ensure only alphanumeric characters (postid format)
    postId = postId.replace(/[^a-zA-Z0-9]/g, "");

    // Pad if too short
    while (postId.length < 4) {
      postId += "0";
    }

    // Truncate if too long
    postId = postId.slice(0, 4);

    return postId;
  }
}

exports.getComponent = () => new WinlinkBlogReceiver();
