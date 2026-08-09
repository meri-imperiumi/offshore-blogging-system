const { Component, failed, fail } = require("noflo-assembly");
const GitHelper = require("../lib/GitHelper");
const fs = require("node:fs");
const path = require("node:path");

/**
 * GitPublisher - Writes blog posts to git repository
 *
 * Logic:
 * - Computes deterministic file paths from postId/date
 * - Overlays watermark on lo-fi images
 * - Writes markdown and image
 * - Commits with fixed template
 * - Pushes to GitHub immediately
 * - Emits confirmation IP
 */
class GitPublisher extends Component {
  constructor() {
    super({
      description: "Writes blog posts to git repository",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message with decoded blog post data",
        },
        repo_path: {
          datatype: "string",
          description: "Path to git repository",
          control: true,
          required: true,
        },
        github_remote: {
          datatype: "string",
          description: "GitHub remote name (default: origin)",
          control: true,
          required: false,
          default: "origin",
        },
        branch: {
          datatype: "string",
          description: "Branch to commit to (default: main)",
          control: true,
          required: false,
          default: "main",
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
  }

  async handle(input, output) {
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

    // Wait for IN port
    if (!input.hasData("in")) {
      return null;
    }

    const msg = input.getData("in");

    // Check for failed messages
    if (failed(msg)) {
      return output.sendDone(msg);
    }

    // Validate required settings
    if (!this.repoPath) {
      fail(msg, new Error("Repository path not configured"));
      return output.sendDone(msg);
    }

    const blogData = msg.payload;
    if (!blogData || !blogData.postId || !blogData.title) {
      fail(msg, new Error("Invalid blog post data"));
      return output.sendDone(msg);
    }

    try {
      const git = new GitHelper(this.repoPath);

      // Compute file paths
      const markdownPath = this.computeMarkdownPath(blogData);
      const markdownFullPath = path.join(this.repoPath, markdownPath);

      // Ensure directories exist
      const markdownDir = path.dirname(markdownFullPath);
      if (!fs.existsSync(markdownDir)) {
        fs.mkdirSync(markdownDir, { recursive: true });
      }

      // Write markdown file with Jekyll front matter
      const markdownContent = this.buildMarkdown(blogData);
      fs.writeFileSync(markdownFullPath, markdownContent, "utf-8");

      // Handle image if present
      if (blogData.imageBuffer) {
        const imagePath = this.computeImagePath(blogData);
        const imageFullPath = path.join(this.repoPath, imagePath);

        // Ensure assets directory exists
        const assetsDir = path.dirname(imageFullPath);
        if (!fs.existsSync(assetsDir)) {
          fs.mkdirSync(assetsDir, { recursive: true });
        }

        // Add watermark to image
        const watermarkedBuffer = await this.addWatermark(blogData.imageBuffer);

        // Save as WebP
        fs.writeFileSync(imageFullPath, watermarkedBuffer);
      }

      // Stage and commit
      await git.add(markdownPath);
      if (blogData.imageBuffer) {
        await git.add(this.computeImagePath(blogData));
      }

      // Check if there are changes to commit (avoid empty commits)
      const hasChanges = await git.hasChanges();
      if (hasChanges) {
        const commitMessage = `lofi: ${blogData.postId} ${blogData.title}`;
        await git.commit(commitMessage);

        // Push to GitHub immediately
        await git.push(this.githubRemote, this.branch);
      }

      // Build confirmation message
      const confirmMsg = {
        errors: [],
        identityHash: msg.identityHash,
        replyTo: msg.replyTo,
        channel: msg.channel,
        intent: "NOTIFY",
        payload: `Blog post "${blogData.title}" published to GitHub`,
        notifyText: `Published: ${blogData.title}`,
      };

      return output.sendDone(confirmMsg);
    } catch (err) {
      fail(msg, new Error(`Git publish failed: ${err.message}`));
      return output.sendDone(msg);
    }
  }

  computeMarkdownPath(blogData) {
    const date = blogData.date.replace(/-/g, "");
    const slug = this.slugify(blogData.title);
    return `_posts/${date}-${slug}.md`;
  }

  computeImagePath(blogData) {
    return `assets/lofi/${blogData.postId}.webp`;
  }

  buildMarkdown(blogData) {
    let frontMatter = `---\n`;
    frontMatter += `title: ${blogData.title}\n`;
    frontMatter += `date: ${blogData.date}\n`;
    frontMatter += `postid: ${blogData.postId}\n`;
    frontMatter += `---\n\n`;

    return frontMatter + blogData.bodyMarkdown;
  }

  async addWatermark(imageBuffer) {
    // TODO: Implement image watermark using canvas (requires npm install canvas)
    // For now, return the image as-is
    // Future implementation: add "lo-fi preview via radio - replaced at landfall" watermark
    return imageBuffer;
  }

  slugify(title) {
    return title
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .substring(0, 50);
  }
}

exports.getComponent = () => new GitPublisher();
