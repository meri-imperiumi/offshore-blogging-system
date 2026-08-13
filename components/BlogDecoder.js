const { Component, failed, fail } = require("noflo-assembly");
const { SAIL_DICT, decompressText } = require("../lib/BlogCodec.js");

/**
 * BlogDecoder - Decompresses, verifies, and *combines* blog post parts.
 *
 * MessageReassembler emits one completed IP per `partType` (a post's text
 * "T" sequence and its image "I", "J", ... sequences are reassembled and
 * emitted independently). BlogDecoder is the component that reunites them:
 *
 *   - partType "T": base64-decode → zlib-inflate (shared SAIL_DICT) →
 *     { title, date, body }. The body of the text+image variant *retains*
 *     its markdown image references, so the count of `![alt](path)` markers
 *     tells us how many image parts to expect.
 *   - partType "I"/"J"/...: base64-decode → raw WebP image buffer (images
 *     are chunked straight from the WebP bytes, no extra zlib layer).
 *
 * Parts are buffered in memory keyed by `transmissionId` until the set is
 * complete: text present AND one image buffer for every image reference in
 * the body. A text-only post (image markdown was stripped by the encoder,
 * or the post simply has no pictures) has zero image references, so it
 * completes immediately on the text part.
 *
 * Only a fully-verified, complete post is emitted on `out` — this is the
 * enforcement point for "never publish a partially/corruptly reassembled
 * post" (SPEC.md §Desired blogging flow). The emitted IP carries
 * `{ title, date, bodyMarkdown, imageBuffers, imageCount, postId }` plus the
 * original routing fields, ready for GitPublisher.
 *
 * A part that is complete on its own but is still waiting for its siblings
 * (e.g. the text part arrived, images not yet) is emitted on `buffered`
 * carrying its `imapUid`, so ImapAcker can mark its email as seen. Without
 * this, that email would be re-fetched on every poll and eventually trigger
 * a spurious NACK ("missing chunks") after the post was already published.
 */
class BlogDecoder extends Component {
  constructor() {
    super({
      description: "Decompresses, verifies, and combines blog post parts",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message with a reassembled part payload",
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Complete, decoded blog post (post + images)",
        },
        buffered: {
          datatype: "object",
          description:
            "A complete part that is buffered waiting for its siblings " +
            "(carries imapUid, for ImapAcker)",
        },
      },
    });

    /** @type {Map<string, PendingEntry>} keyed by transmissionId */
    this.pending = new Map();
  }

  handle(input, output) {
    if (!input.hasData("in")) {
      return;
    }

    const msg = input.getData("in");

    // Failed messages (auth, reassembly, etc.) pass straight through — never
    // buffered, so a corrupt part can't poison a future complete post.
    if (failed(msg)) {
      return output.sendDone({ out: msg });
    }

    const partType = msg.partType;
    const transmissionId = msg.transmissionId;

    if (!transmissionId || !partType) {
      fail(
        msg,
        new Error(
          "BlogDecoder received a part without transmissionId/partType " +
            "(is InReachReceiver wired in front of MessageReassembler?)",
        ),
      );
      return output.sendDone({ out: msg });
    }

    let entry = this.pending.get(transmissionId);
    if (!entry) {
      entry = {
        text: null,
        images: new Map(),
        textChunks: 0,
        imageChunks: 0,
        ackUids: [],
      };
      this.pending.set(transmissionId, entry);
    }

    // Handle both single letters (T, I) and full words (text, image)
    // for consistency
    if (partType === "T" || partType === "text") {
      // Text part: base64-decode + zlib-inflate.
      let decoded;
      try {
        decoded = decompressText(Buffer.from(msg.payload, "base64"), SAIL_DICT);
      } catch (err) {
        this.pending.delete(transmissionId);
        fail(msg, new Error(`Blog text decoding failed: ${err.message}`));
        return output.sendDone({ out: msg });
      }
      entry.text = decoded;
      entry.textChunks = msg.totalChunks || 0;
      // Collect IMAP UIDs from this part for ACKing
      if (msg.ackUids && Array.isArray(msg.ackUids)) {
        entry.ackUids.push(...msg.ackUids);
      } else if (msg.imapUid) {
        entry.ackUids.push(msg.imapUid);
      }
    } else if (/^[A-Z]$/.test(partType)) {
      // Image part: base64-decode to the raw (WebP) buffer.
      // Single letter types: I, J, K for different images
      entry.images.set(partType, Buffer.from(msg.payload, "base64"));
      entry.imageChunks += msg.totalChunks || 0;
      // Collect IMAP UIDs from this part for ACKing
      if (msg.ackUids && Array.isArray(msg.ackUids)) {
        entry.ackUids.push(...msg.ackUids);
      } else if (msg.imapUid) {
        entry.ackUids.push(msg.imapUid);
      }
    } else {
      // Unknown part type reaching the blog pipeline — fail it so
      // ReplyDispatcher can send an error back to the sender.
      fail(msg, new Error(`Unknown blog part type: ${partType}`));
      return output.sendDone({ out: msg });
    }

    // Not complete until we have the text part (it tells us how many images
    // to expect). An image that arrives before the text just waits here.
    if (!entry.text) {
      return output.sendDone({ buffered: msg });
    }

    const expected = this.countImageRefs(entry.text.body);
    if (expected === 0) {
      // Text-only variant: no images, publish immediately.
      return this.emitPost(msg, entry, [], transmissionId, output);
    }

    const present = this.expectedImageTypes(expected).filter((t) =>
      entry.images.has(t),
    ).length;
    if (present < expected) {
      // Still waiting for one or more image parts. Ack this part's email —
      // it delivered a valid complete part, its job is done.
      return output.sendDone({ buffered: msg });
    }

    // Complete: order image buffers by their part-type letter (I, J, K, ...).
    const imageBuffers = this.expectedImageTypes(expected).map((t) =>
      entry.images.get(t),
    );
    return this.emitPost(msg, entry, imageBuffers, transmissionId, output);
  }

  /**
   * Build and send the combined, complete blog post IP.
   */
  /**
   * Build and send the combined, complete blog post IP.
   *
   * Named `emitPost` (not `emit`) to avoid colliding with Node's
   * `EventEmitter.emit`, which NoFlo's Component base class uses for
   * lifecycle events like 'icon' / 'start' / 'end'. Shadowing it crashes
   * ComponentLoader.setIcon.
   */
  emitPost(msg, entry, imageBuffers, transmissionId, output) {
    this.pending.delete(transmissionId);

    msg.payload = {
      filename: entry.text.filename,
      title: entry.text.title,
      date: entry.text.date,
      bodyMarkdown: entry.text.body,
      postId: transmissionId,
      imageBuffers,
      imageCount: imageBuffers.length,
    };
    // Preserve routing + accounting fields for downstream (GitPublisher,
    // BlogAckBuilder, ReplyDispatcher).
    msg.intent = msg.intent || "BLOG";
    msg.totalChunks = entry.textChunks + entry.imageChunks;

    // Pass through all IMAP UIDs from contributing parts for ACKing
    if (entry.ackUids.length > 0) {
      msg.ackUids = entry.ackUids;
    }

    return output.sendDone({ out: msg });
  }

  /**
   * Count markdown image references in a body. Matches `![alt]( ... )`
   * markers; used to determine how many image parts a post carries.
   */
  countImageRefs(body) {
    if (!body) return 0;
    return (body.match(/!\[[^\]]*\]\(/g) || []).length;
  }

  /**
   * The expected image part-type letters for a given image count.
   * Returns ["I"] for single-image posts (the encoder uses I for the first image),
   * or I, J, K... for multiple images.
   */
  expectedImageTypes(count) {
    if (count === 1) {
      return ["I"];
    }
    const types = [];
    for (let i = 0; i < count; i++) {
      types.push(String.fromCharCode(73 + i)); // I=73, J=74, ...
    }
    return types;
  }

  shutdown() {
    this.pending.clear();
  }
}

exports.getComponent = () => new BlogDecoder();
