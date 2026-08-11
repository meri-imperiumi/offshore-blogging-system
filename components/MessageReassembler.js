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
        buffered: {
          datatype: "object",
          description:
            "Chunk that was buffered but sequence not yet complete. " +
            "Carries imapUid so ImapAcker can mark the email as seen.",
        },
      },
    });

    this.db = null;
    this.dbPath = ":memory:";
    this.ttl = 900; // 15 minutes default
  }

  handle(input, output) {
    try {
      return this.doHandle(input, output);
    } catch (err) {
      console.error("MessageReassembler error:", err);
      throw err;
    }
  }

  doHandle(input, output) {
    console.log("MessageReassembler.doHandle called");
    // Process control ports
    if (input.hasData("dbpath")) {
      this.dbPath = input.getData("dbpath");
    }

    if (input.hasData("ttl")) {
      this.ttl = input.getData("ttl");
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
      return output.done();
    }

    // Process IN port
    if (!input.hasData("in")) {
      return null;
    }

    const msg = input.getData("in");

    // Check for failed messages (pass through)
    if (failed(msg)) {
      return output.sendDone({ out: msg });
    }

    // Parse chunk headers from payload
    const headers = this.parseChunkHeaders(msg.payload);

    // If no headers found, treat as complete message (pass through)
    if (!headers) {
      console.log("MessageReassembler: no chunk headers, passing through");
      return output.sendDone({ out: msg });
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

    if (chunks.length < headers.total) {
      // Not complete yet - emit on `buffered` so the email can be acked
      // (its job of delivering a valid chunk is done). The reassembled
      // message will be emitted on `out` once all chunks arrive.
      return output.sendDone({ buffered: msg });
    }

    // Sequence complete - reassemble
    return this.emitComplete(msg, headers, chunks, output);
  }

  /**
   * Parse chunk headers from payload
   *
   * Unified Compact Header Protocol:
   * Format: "[ID:4][Type:1][Index:2][Total:2][Meta:4 optional]:[Payload]"
   * Example: "rqnnG0312:payload..." (downlink GRIB, no meta)
   *          "0715T0205687c:payload..." (uplink blog, with 4-byte CRC as meta)
   *
   * @param {string} payload - Raw payload from email
   * @returns {Object|null} Parsed headers or null if no match
   */
  parseChunkHeaders(payload) {
    // Unified compact header: [ID:4][Type:1][Index:2][Total:2][Meta:4?]:[Payload]
    const match = payload.match(
      /^([a-zA-Z0-9]{4})([A-Za-z])(\d{2})(\d{2})([0-9a-fA-F]{4})?:(.*)$/s,
    );
    if (!match) {
      return null;
    }

    const transmissionId = match[1];
    const typeChar = match[2].toUpperCase();
    const chunkIndex = parseInt(match[3], 10);
    const totalChunks = parseInt(match[4], 10);
    const metadata = match[5]; // May be undefined (downlink has no meta)
    const dataPayload = match[6];

    // Map typeChar to full partType string for DB compatibility
    const typeMap = { T: "text", I: "image", G: "grib", S: "sys" };
    const partType = typeMap[typeChar] || typeChar.toLowerCase();

    return {
      chunk: chunkIndex,
      total: totalChunks,
      partType,
      transmissionId,
      metadata, // Carries CRC16 on uplink, undefined on downlink
      payload: dataPayload,
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
      return output.done();
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

    return output.sendDone(msg);
  }

  /**
   * Buffer a chunk to SQLite
   */
  bufferChunk(msg, headers) {
    // Payload already extracted by parseChunkHeaders for unified format
    const payloadOnly = headers.payload;

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
    msg.totalChunks = headers.total;

    // Delete the buffer
    this.db.deleteBufferChunks(
      msg.identityHash,
      headers.transmissionId,
      headers.partType,
    );

    output.sendDone({ out: msg });
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
        output.send({ out: nackMsg });
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
