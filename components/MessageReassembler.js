const { IP } = require("noflo");
const { Component, failed, fail } = require("noflo-assembly");
const DatabaseHelper = require("../lib/DbHelper");

/**
 * MessageReassembler - Reassembles multi-part messages from buffer_chunks
 *
 * Logic on IN:
 * - Extracts sequence headers if present
 * - If none found (e.g., Saildocs binary reply), treats IP as complete and passes through
 * - Detects CANCEL <transmissionId> commands (transmissionId is mandatory)
 * - Otherwise buffers partial chunks to SQLite keyed by identityHash:transmissionId:partType
 * - If complete, concatenates, drops DB record, and emits unified IP
 *
 * Logic on CHECK:
 * - Sweeps SQLite for stale sequences (time > TTL)
 * - Constructs NACK message defining missing chunks
 * - Invokes fail(msg) and emits downstream for ReplyDispatcher
 */
class MessageReassembler extends Component {
  constructor() {
    super({
      description: "Reassembles multi-part messages from buffer_chunks",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message with potential chunk headers",
        },
        check: {
          datatype: "bang",
          description: "Trigger stale chunk sweep",
        },
        ttl: {
          datatype: "number",
          description: "TTL for stale chunks in seconds (default: 900)",
          control: true,
          required: false,
        },
        dbpath: {
          datatype: "string",
          description: "Database path (default: :memory:)",
          control: true,
          required: false,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Reassembled assembly message",
        },
      },
    });

    this.db = null;
    this.dbPath = ":memory:";
    this.ttl = 900; // 15 minutes default
  }

  handle(input, output) {
    // Process control ports
    if (input.hasData("dbpath")) {
      this.dbPath = input.getData("dbpath");
      input.buffer.get("dbpath").clear();
    }

    if (input.hasData("ttl")) {
      this.ttl = input.getData("ttl");
      input.buffer.get("ttl").clear();
    }

    // Initialize database on first use
    if (!this.db) {
      this.db = new DatabaseHelper(this.dbPath);
      this.db.initialize();
    }

    // Process CHECK port (stale chunk sweep)
    if (input.hasData("check")) {
      input.getData("check"); // consume the bang
      this.handleStaleSweep(output);
      return output.sendDone();
    }

    // Process IN port
    if (!input.hasData("in")) {
      return null;
    }

    const msg = input.getData("in");

    // Check for failed messages (pass through)
    if (failed(msg)) {
      return output.sendDone(new IP("data", msg));
    }

    // Parse chunk headers from payload
    const headers = this.parseChunkHeaders(msg.payload);

    // If no headers found, treat as complete message (pass through)
    if (!headers) {
      return output.sendDone(new IP("data", msg));
    }

    // Check for CANCEL command
    if (msg.intent === "SYS" && msg.payload.trim().startsWith("CANCEL ")) {
      return this.handleCancel(msg, headers, output);
    }

    // Buffer the chunk
    this.bufferChunk(msg, headers);

    // Check if sequence is complete
    const chunks = this.db.getBufferChunks(
      msg.identityHash,
      headers.transmissionId,
      headers.partType,
    );

    if (chunks.length < headers.totalChunks) {
      // Not complete yet - don't emit anything
      return output.sendDone();
    }

    // Sequence complete - reassemble
    return this.emitComplete(msg, headers, chunks, output);
  }

  /**
   * Parse chunk headers from payload
   * Format: "msg <part>/<total>:<partType>:<transmissionId>\n<payload>"
   */
  parseChunkHeaders(payload) {
    const match = payload.match(/^msg\s+(\d+)\/(\d+):(\w+):(\w+)\n/);
    if (!match) {
      return null;
    }

    return {
      chunk: parseInt(match[1], 10),
      total: parseInt(match[2], 10),
      partType: match[3],
      transmissionId: match[4],
    };
  }

  /**
   * Handle CANCEL command
   */
  handleCancel(msg, headers, output) {
    const cancelMatch = msg.payload.match(/^CANCEL\s+(\S+)/);
    if (!cancelMatch) {
      // Malformed CANCEL - no transmissionId specified
      // Route to ErrorLogger instead
      fail(
        msg,
        new Error("Malformed CANCEL command: transmissionId is required"),
      );
      // Don't emit anything - ErrorLogger will handle it
      return output.sendDone();
    }

    const cancelTransmissionId = cancelMatch[1];

    // Delete the matching buffered sequence
    if (headers.transmissionId) {
      this.db.deleteBufferChunks(
        msg.identityHash,
        headers.transmissionId,
        headers.partType,
      );
    } else {
      this.db.deleteBufferChunks(msg.identityHash, cancelTransmissionId);
    }

    // Mutate msg to NOTIFY intent confirming cancellation
    msg.intent = "NOTIFY";
    msg.payload = `Cancelled transmission: ${cancelTransmissionId}`;

    return output.sendDone(new IP("data", msg));
  }

  /**
   * Buffer a chunk to SQLite
   */
  bufferChunk(msg, headers) {
    const payloadOnly = msg.payload.replace(/^msg\s+\d+\/\d+:\w+:\w+\n/, "");
    this.db.saveBufferChunk(
      msg.identityHash,
      headers.transmissionId,
      headers.partType,
      headers.chunk,
      headers.total,
      msg.replyTo,
      msg.channel,
      payloadOnly,
    );
  }

  /**
   * Emit complete reassembled message
   */
  emitComplete(msg, headers, chunks, output) {
    // Concatenate chunks in order
    const reassembledPayload = chunks.map((c) => c.payload).join("");

    // Update msg with reassembled payload
    msg.payload = reassembledPayload;

    // Store part type and transmissionId for downstream use
    msg.partType = headers.partType;
    msg.transmissionId = headers.transmissionId;

    // Delete the buffer
    this.db.deleteBufferChunks(
      msg.identityHash,
      headers.transmissionId,
      headers.partType,
    );

    return output.sendDone(new IP("data", msg));
  }

  /**
   * Handle stale chunk sweep
   */
  handleStaleSweep(output) {
    const stale = this.db.getStaleBufferChunks(this.ttl);

    for (const entry of stale) {
      // Construct NACK message
      const nackMsg = {
        errors: [],
        identityHash: entry.identity_hash,
        replyTo: entry.reply_to,
        channel: entry.channel,
        intent: "NOTIFY",
        payload: `NACK: Missing chunks for ${entry.transmission_id}/${entry.part_type}. Received ${entry.received}/${entry.total}.`,
      };

      fail(
        nackMsg,
        new Error(
          `Incomplete sequence: ${entry.received}/${entry.total} chunks`,
        ),
      );

      // Emit NACK for ReplyDispatcher
      if (output.isAttached("out")) {
        output.send(new IP("data", nackMsg));
      }
    }
  }

  shutdown() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

exports.getComponent = () => new MessageReassembler();
