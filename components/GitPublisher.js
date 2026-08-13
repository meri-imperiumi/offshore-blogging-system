const { Component, fail, fork } = require("noflo-assembly");
const GitHelper = require("../lib/GitHelper");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

/**
 * GitPublisher - Writes a decoded, complete blog post to a git repository.
 *
 * Input (from BlogDecoder): `msg.payload = { title, date, bodyMarkdown,
 * postId, imageBuffers, imageCount }`. The body still carries its original
 * markdown image references; GitPublisher rewrites each one to point at the
 * lo-fi WebP it writes alongside the post.
 *
 * Logic:
 * - Computes the markdown file path from the transmitted filename
 *   (_logs/<filename>.md) — the same path the boat uses — so a duplicate
 *   delivery produces identical files (no-op commit) and the eventual
 *   hi-fi sync overwrites the lo-fi placeholder cleanly.
 * - Overlays a small "lo-fi preview" banner on every lo-fi image before
 *   writing (SPEC.md: "so a viewer never mistakes a blurry placeholder for
 *   the final photo").
 * - Writes the markdown and watermarked image(s).
 * - If the target is a git work tree: pulls the latest from the configured
 *   remote first (so we're working on the current repo state — the boat
 *   pushes hi-fi replacements for earlier posts to GitHub via `rngit mirror` /
 *   backup.sh), then stages, commits (`lofi: <postId> <title>`), and pushes
 *   (unless the `push` control is false). A non-repo directory just receives
 *   the files (useful for test runners).
 * - Emits a confirmation IP for ReplyDispatcher / BlogAckBuilder.
 */
class GitPublisher extends Component {
  constructor() {
    super({
      description: "Writes blog posts to a git repository",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message with decoded blog post",
          required: true,
        },
        repo_path: {
          datatype: "string",
          description: "Path to git repository (or output directory)",
          control: true,
          required: true,
        },
        github_remote: {
          datatype: "string",
          description: "GitHub remote name (default: origin)",
          control: true,
          required: false,
        },
        branch: {
          datatype: "string",
          description: "Branch to commit to (default: main)",
          control: true,
          required: false,
        },
        push: {
          datatype: "boolean",
          description:
            "Whether to push to the remote after committing (default: true). " +
            "Set false for local-only / test runs.",
          control: true,
          required: false,
        },
        watermark_text: {
          datatype: "string",
          description:
            'Banner text overlaid on lo-fi images (default: "lo-fi preview via satellite")',
          control: true,
          required: false,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Confirmation message",
        },
      },
    });

    this.repoPath = null;
    this.githubRemote = "origin";
    this.branch = "main";
    this.push = true;
    this.watermarkText = "lo-fi preview via satellite";
  }

  handle(input, output) {
    // Process control ports
    if (input.hasData("repo_path")) {
      this.repoPath = input.getData("repo_path");
    }
    if (input.hasData("github_remote")) {
      this.githubRemote = input.getData("github_remote");
    }
    if (input.hasData("branch")) {
      this.branch = input.getData("branch");
    }
    if (input.hasData("push")) {
      this.push = input.getData("push");
    }
    if (input.hasData("watermark_text")) {
      this.watermarkText = input.getData("watermark_text");
    }

    // Sync `return` (not `return null`): in an async handle, `return null`
    // resolves the promise and NoFlo calls output.sendDone(null), forwarding
    // null to the out port. A sync handle's `return` yields undefined, which
    // NoFlo treats as "preconditions not met" without sending anything.
    if (!input.hasData("in")) {
      return;
    }

    const msg = input.getData("in");

    // Validation is explicit for multi-route components
    if (!this.validate(msg)) {
      return output.sendDone(msg);
    }

    // Validate required settings
    if (!this.repoPath) {
      fail(msg, new Error("Repository path not configured"));
      return output.sendDone(msg);
    }

    const blogData = msg.payload;

    // Validate required fields with a clear, operator-readable message. We
    // don't use noflo-assembly `validates` here because its generic "X is
    // false or empty" errors are less actionable, and the tests assert the
    // specific "missing filename" wording.
    if (!blogData?.filename || !blogData?.postId || !blogData.title) {
      fail(
        msg,
        new Error("Invalid blog post data (missing filename/postId/title)"),
      );
      return output.sendDone(msg);
    }

    // Guard against path traversal: the filename is transmitted data, so a
    // spoofed sender could try "../etc/passwd". Reject any filename that
    // contains path separators or parent-directory references.
    if (/[/\\]|\.\./.test(blogData.filename)) {
      fail(msg, new Error(`Unsafe filename received: ${blogData.filename}`));
      return output.sendDone(msg);
    }

    // Delegate async work to a helper so handle() returns undefined (not a
    // Promise). If handle() were async, NoFlo would call
    // output.sendDone(resolvedValue) on resolve, causing a duplicate send.
    this._doPublish(msg, blogData, output);
  }

  async _doPublish(msg, blogData, output) {
    try {
      const git = new GitHelper(this.repoPath);
      const isRepo = await git.isInsideWorkTree();

      // Pull latest from the configured remote before writing, so we're
      // working on the current repo state — the boat pushes hi-fi
      // replacements for earlier posts to GitHub (via `rngit mirror` /
      // backup.sh) and we need them in local HEAD before adding a new lo-fi
      // post, or our push would be rejected as non-fast-forward. Best-effort:
      // a fresh repo with no remote ref yet, or an offline window, just means
      // we write against local HEAD and the push below reconciles. Skipped in
      // local-only (push=false) mode — there's no remote to pull from there.
      if (isRepo && this.push) {
        try {
          await git.pull(this.githubRemote, this.branch, "theirs");
        } catch {
          // Remote not present yet (first publish) or offline — proceed.
        }
      }

      // --- Images: resolve + validate paths BEFORE writing anything ---
      // Each image buffer is written to the *exact path the body's markdown
      // references* (resolved relative to _logs/, where the post lives), not
      // a synthesized lo-fi path. This is deliberate: the boat will later sync
      // the hi-fi WebP to that same path, and `git merge` overwrites cleanly.
      // If we wrote to a different path we'd orphan the placeholder forever.
      //
      // Image paths are parsed out of the sender-controlled post body, so a
      // "![x](../../etc/passwd)" reference must not escape the repo — same
      // threat model the filename guard above already handles.
      // path.posix.normalize (in resolveImageRepoPath) does NOT stop a
      // "../../" reference from resolving above the root, so we resolve to
      // absolute and verify it stays inside the repo. Validating up front
      // means a bad reference fails the publish atomically, before any file
      // (markdown or image) is written.
      const imageBuffers = Array.isArray(blogData.imageBuffers)
        ? blogData.imageBuffers
        : [];
      const imageRefs = this.extractImagePaths(blogData.bodyMarkdown || "");
      const imagePaths = [];
      for (let i = 0; i < imageBuffers.length; i++) {
        const refPath = imageRefs[i] || `${blogData.postId}-${i + 1}.webp`;
        const relPath = this.resolveImageRepoPath(refPath);
        const fullImagePath = path.join(this.repoPath, relPath);
        if (!this.isPathContained(fullImagePath, this.repoPath)) {
          fail(msg, new Error(`Unsafe image path received: ${refPath}`));
          return output.sendDone(msg);
        }
        imagePaths.push({ relPath, fullImagePath });
      }

      // --- Markdown ---
      const markdownPath = this.computeMarkdownPath(blogData);
      const markdownFullPath = path.join(this.repoPath, markdownPath);
      const markdownDir = path.dirname(markdownFullPath);
      if (!fs.existsSync(markdownDir)) {
        fs.mkdirSync(markdownDir, { recursive: true });
      }
      const markdownContent = this.buildMarkdown(blogData);
      fs.writeFileSync(markdownFullPath, markdownContent, "utf-8");

      // --- Write images ---
      const writtenImagePaths = [];
      for (let i = 0; i < imageBuffers.length; i++) {
        const { relPath, fullImagePath } = imagePaths[i];
        const imageDir = path.dirname(fullImagePath);
        if (!fs.existsSync(imageDir)) {
          fs.mkdirSync(imageDir, { recursive: true });
        }
        const watermarked = await this.addWatermark(imageBuffers[i]);
        fs.writeFileSync(fullImagePath, watermarked);
        writtenImagePaths.push(relPath);
      }

      // --- Git (only if we're inside a work tree) ---
      let committed = false;
      let pushed = false;
      if (isRepo) {
        await git.add(markdownPath);
        for (const imgPath of writtenImagePaths) {
          await git.add(imgPath);
        }
        if (await git.hasChanges()) {
          await git.commit(`lofi: ${blogData.postId} ${blogData.title}`);
          committed = true;
          if (this.push) {
            await git.push(this.githubRemote, this.branch);
            pushed = true;
          }
        }
      }

      const confirmMsg = fork(msg, [
        "payload",
        "intent",
        "notifyText",
        "partType",
        "replyTo",
        "channel",
        "identityHash",
      ]);
      confirmMsg.intent = "NOTIFY";
      confirmMsg.payload = `Blog post "${blogData.title}" written to disk${
        pushed ? " and pushed to GitHub" : committed ? " (committed)" : ""
      }`;
      confirmMsg.notifyText = `Published: ${blogData.title}`;
      confirmMsg.filename = blogData.filename;
      confirmMsg.publishedPath = markdownPath;
      confirmMsg.imageCount = imageBuffers.length;

      // Pass through ackUids so ImapAcker can ACK all contributing emails
      if (msg.ackUids && Array.isArray(msg.ackUids)) {
        confirmMsg.ackUids = msg.ackUids;
      }

      output.sendDone(confirmMsg);
    } catch (err) {
      fail(msg, new Error(`Git publish failed: ${err.message}`));
      output.sendDone(msg);
    }
  }

  computeMarkdownPath(blogData) {
    return `_logs/${blogData.filename}.md`;
  }

  buildMarkdown(blogData) {
    let frontMatter = `---\n`;
    frontMatter += `title: ${blogData.title}\n`;
    // Posts use the 'created' key (Obsidian's convention) — hardcoded on both
    // ends so the key doesn't bloat the compressed transmission.
    frontMatter += `created: ${blogData.date}\n`;
    frontMatter += `postid: ${blogData.postId}\n`;
    frontMatter += `lofi: true\n`;
    frontMatter += `---\n\n`;

    // The body is written verbatim — its image references already point at
    // the paths where the lo-fi images (and later the hi-fi replacements)
    // live. Rewriting them would break both the rendered tag and the
    // hi-fi overwrite (two different paths = orphaned placeholder).
    return frontMatter + (blogData.bodyMarkdown || "");
  }

  /**
   * Extract the image URL/path from every `![alt](path)` reference in the
   * body, in order. The encoder assigns image parts I, J, K, ... to images
   * in this same order, so imageBuffers[i] corresponds to refs[i].
   *
   * Handles one level of nested parentheses in paths (camera filenames like
   * `photo(0).webp`) and strips an optional Markdown title (`path "title"`).
   */
  extractImagePaths(bodyMarkdown) {
    const re = /!\[([^\]]*)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
    const paths = [];
    let m = re.exec(bodyMarkdown);
    while (m !== null) {
      let p = m[2].trim();
      const titleMatch = p.match(/^(.+?)\s+"[^"]*"$/);
      if (titleMatch) {
        p = titleMatch[1];
      }
      paths.push(p);
      m = re.exec(bodyMarkdown);
    }
    return paths;
  }

  /**
   * Resolve a markdown image path to a repo-relative filesystem path.
   *
   * The published post lives in `_logs/`, so relative image references
   * (e.g. `../2026/photo.webp`) resolve against `_logs/` — landing at the
   * repo root's `<year>/photo.webp`, exactly where the boat stores the
   * hi-fi version (backup.sh copies `<year>/` to the repo root). Absolute
   * paths (leading `/`) are Jekyll site-root-relative, i.e. repo-root-relative.
   */
  resolveImageRepoPath(imagePath) {
    let p = imagePath.trim();
    const titleMatch = p.match(/^(.+?)\s+"[^"]*"$/);
    if (titleMatch) {
      p = titleMatch[1];
    }
    if (p.startsWith("/")) {
      return path.posix.normalize(p.slice(1));
    }
    return path.posix.normalize(path.posix.join("_logs", p));
  }

  /**
   * Whether `target` resolves to a path inside `base` (or equals it).
   *
   * Used to contain sender-controlled image paths within the repo root.
   * Resolving both to absolute and taking path.relative is the standard
   * containment check: if target is under base the result won't start with
   * ".." and won't be absolute; a "../../" escape yields a ".." prefix, and a
   * cross-drive path yields an absolute relative on Windows. This catches
   * escapes that path.posix.normalize alone leaves through (normalize keeps
   * leading "..").
   */
  isPathContained(target, base) {
    const resolvedTarget = path.resolve(target);
    const resolvedBase = path.resolve(base);
    const rel = path.relative(resolvedBase, resolvedTarget);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  /**
   * Overlay a "lo-fi preview" banner across the top of the image.
   *
   * The encoder ships tiny grayscale WebPs (48–200px wide), so the banner
   * text is scaled to fit: a long message on a wide image, "lo-fi preview"
   * on a medium one, and just "lo-fi" on the smallest. The banner is a
   * semi-transparent black strip with white text — visible even when the
   * text itself is too small to read, which is enough to signal "this is a
   * placeholder, not the final photo".
   */
  async addWatermark(imageBuffer) {
    const image = sharp(imageBuffer);
    const meta = await image.metadata();
    const width = meta.width || 200;

    const bannerHeight = Math.max(10, Math.min(40, Math.round(width * 0.14)));
    const fontSize = Math.max(7, Math.round(bannerHeight * 0.62));
    const charWidth = fontSize * 0.55;
    const maxChars = Math.max(4, Math.floor((width * 0.9) / charWidth));
    const label = this.fitLabel(this.watermarkText, maxChars);

    const escaped = label
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${bannerHeight}" viewBox="0 0 ${width} ${bannerHeight}"><rect width="${width}" height="${bannerHeight}" fill="rgba(0,0,0,0.55)"/><text x="${width / 2}" y="${bannerHeight / 2}" fill="#ffffff" font-family="sans-serif" font-size="${fontSize}" font-weight="bold" text-anchor="middle" dominant-baseline="middle">${escaped}</text></svg>`;

    return image
      .composite([{ input: Buffer.from(svg), gravity: "north" }])
      .webp({ quality: 80 })
      .toBuffer();
  }

  /**
   * Shorten the watermark text to fit `maxChars` by taking whole-word
   * prefixes. Falls back to "lo-fi" if nothing reasonable fits.
   */
  fitLabel(text, maxChars) {
    if (text.length <= maxChars) return text;
    const words = text.split(/\s+/);
    let label = "";
    for (const w of words) {
      const candidate = label ? `${label} ${w}` : w;
      if (candidate.length > maxChars) break;
      label = candidate;
    }
    if (label.length >= 4) return label;
    return "lo-fi".slice(0, Math.max(4, maxChars));
  }
}

exports.getComponent = () => new GitPublisher();
