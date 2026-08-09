const { Component, failed, fail } = require("noflo-assembly");
const DatabaseHelper = require("../lib/DbHelper");

/**
 * GribGate - Size consent mechanism for GRIB payloads
 *
 * Logic on IN:
 * - Checks length of chunk array from GribChunker
 * - If length <= N, passes immediately
 * - If length > N, saves chunks to SQLite under a new gateId along with channel
 * - Mutates IP to a NOTIFY intent asking for user confirmation
 *
 * Logic on COMMAND:
 * - Reads YES or CANCEL payloads
 * - Restores and emits chunks (with persisted channel) on YES
 * - Deletes chunks and emits confirmation on CANCEL
 */
class GribGate extends Component {
  constructor() {
    super({
      description: "Size consent mechanism for GRIB payloads",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message with GRIB chunk array",
        },
        command: {
          datatype: "object",
          description: "User command (YES/CANCEL)",
        },
        max_chunks: {
          datatype: "number",
          description: "Maximum chunks before requiring consent (default: 10)",
          control: true,
          required: false,
          default: 10,
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
          description: "Passed-through or restored assembly message",
        },
        notify: {
          datatype: "object",
          description: "Consent request notification",
        },
      },
    });

    this.db = null;
    this.dbPath = ":memory:";
    this.maxChunks = 10;
    this.gateCounter = 0;
  }

  handle(input, output) {
    // Process control ports
    if (input.hasData("max_chunks")) {
      this.maxChunks = input.getData("max_chunks");
    }
    if (input.hasData("dbpath")) {
      this.dbPath = input.getData("dbpath");
    }

    // Initialize database if needed
    if (!this.db) {
      this.db = new DatabaseHelper(this.dbPath);
      this.db.initialize();
    }

    // Handle command port (YES/CANCEL responses)
    if (input.hasData("command")) {
      const cmdMsg = input.getData("command");
      return this.handleCommand(cmdMsg, output);
    }

    // Handle IN port (GRIB data)
    if (!input.hasData("in")) {
      return null;
    }

    const msg = input.getData("in");

    // Check for failed messages
    if (failed(msg)) {
      return output.sendDone(msg);
    }

    // Get chunk array from message
    const chunks = msg.payload;
    if (!Array.isArray(chunks)) {
      fail(msg, new Error("GRIB payload must be an array of chunks"));
      return output.sendDone(msg);
    }

    // Check size against threshold
    if (chunks.length <= this.maxChunks) {
      // Small payload - pass through immediately
      return output.sendDone(msg);
    }

    // Large payload - gate it and request consent
    this.gateCounter += 1;
    const gateId = `G${this.gateCounter}`;

    // Save to database
    this.db.saveGribGate(
      msg.identityHash,
      gateId,
      msg.replyTo,
      msg.channel,
      chunks,
    );

    // Build consent request notification
    const notifyMsg = {
      errors: [],
      identityHash: msg.identityHash,
      replyTo: msg.replyTo,
      channel: msg.channel,
      intent: "NOTIFY",
      payload: `GRIB request requires consent: ${chunks.length} chunks (${this.maxChunks} threshold)\nSend "YES ${gateId}" to proceed or "CANCEL ${gateId}" to cancel`,
      notifyText: `GRIB: ${chunks.length} chunks. Reply YES ${gateId} or CANCEL ${gateId}`,
    };

    return output.send({ notify: notifyMsg });
  }

  handleCommand(cmdMsg, output) {
    // Check for failed messages
    if (failed(cmdMsg)) {
      return output.sendDone(cmdMsg);
    }

    const payload =
      typeof cmdMsg.payload === "string" ? cmdMsg.payload.trim() : "";
    const parts = payload.split(/\s+/);
    const action = parts[0]?.toUpperCase();
    const gateId = parts[1];

    if (!gateId) {
      fail(cmdMsg, new Error("Gate ID required for YES/CANCEL commands"));
      return output.sendDone(cmdMsg);
    }

    if (action === "YES") {
      // Retrieve and restore chunks
      const gate = this.db.getGribGate(cmdMsg.identityHash, gateId);
      if (!gate) {
        fail(cmdMsg, new Error(`Gate ${gateId} not found or expired`));
        return output.sendDone(cmdMsg);
      }

      // Build restored message
      const restoredMsg = {
        errors: [],
        identityHash: gate.identity_hash,
        replyTo: gate.reply_to,
        channel: gate.channel,
        intent: "GRIB", // Original intent
        payload: gate.chunk_payloads,
      };

      // Delete the gate
      this.db.deleteGribGate(cmdMsg.identityHash, gateId);

      // Send confirmation
      const confirmMsg = {
        errors: [],
        identityHash: cmdMsg.identityHash,
        replyTo: cmdMsg.replyTo,
        channel: cmdMsg.channel,
        intent: "NOTIFY",
        payload: `Gate ${gateId} confirmed - ${gate.chunk_payloads.length} chunks will be sent`,
        notifyText: `GRIB gate ${gateId} approved`,
      };

      return output.sendDone({ out: restoredMsg, notify: confirmMsg });
    } else if (action === "CANCEL") {
      // Delete the gate
      this.db.deleteGribGate(cmdMsg.identityHash, gateId);

      // Send cancellation confirmation
      const cancelMsg = {
        errors: [],
        identityHash: cmdMsg.identityHash,
        replyTo: cmdMsg.replyTo,
        channel: cmdMsg.channel,
        intent: "NOTIFY",
        payload: `Gate ${gateId} cancelled - chunks discarded`,
        notifyText: `GRIB gate ${gateId} cancelled`,
      };

      return output.sendDone({ notify: cancelMsg });
    } else {
      fail(cmdMsg, new Error(`Unknown command action: ${action}`));
      return output.sendDone(cmdMsg);
    }
  }

  shutdown() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

exports.getComponent = () => new GribGate();
