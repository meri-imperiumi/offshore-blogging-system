const { Component, fail, fork } = require("noflo-assembly");
const InReachClient = require("../lib/InReachClient");

/**
 * InReachSender - Sends chunked payloads via the Garmin InReach web endpoint.
 *
 * Ports the HTTP-POST reply flow from the two Python reference implementations
 * in `references/GRIB-via-inReach` and `references/MarineGRIB-InReach-Transmitter`.
 *
 * Logic:
 * - Reads the per-message Garmin reply URL from `msg.replyTo` (the design
 *   doc's "target routing context (`replyTo` or session guid)"). For the
 *   InReach channel, AuthVerifier sets this to the Garmin URL extracted from
 *   the inbound email body.
 * - Transmits each entry of `msg.payload` (array of chunk strings; a bare
 *   string is accepted and wrapped). Multi-chunk payloads are wrapped in the
 *   sequence envelope the boat's `MessageReassembler` expects
 *   (`msg <i>/<total>:<partType>:<transmissionId>\n<chunk>`, 1-based) so the
 *   boat can reassemble them; a single chunk is sent as-is, since the
 *   reassembler passes headerless messages through unchanged (no per-message
 *   overhead for the common case of short confirmations).
 * - Enforces a safety delay between chunks to avoid being rate-limited.
 * - On any chunk failure, fails the assembly message with a distinguishable
 *   InReachError code (SESSION_EXPIRED | RATE_LIMITED | API_FAILURE |
 *   NETWORK_ERROR | BAD_URL | NOT_CONFIGURED) and emits on the `error` port.
 *
 * Operational risk (flagged in `cloud.md`, not solved here): this scrapes
 * Garmin's authenticated web session rather than a documented API. It can
 * change without notice and the session cookie will expire on an unspecified
 * timeline.
 */

// Injectable client factory so tests can substitute a mock client without
// touching the network. Production uses the real InReachClient.
// generateTransmissionId synthesizes the 4-char Base62 sequence id for an
// outbound compact header; it must match the unified protocol's ID field
// ([a-zA-Z0-9]{4}) and is injectable so tests can pin it.
const di = {
  createClient: (options) => new InReachClient(options),
  generateTransmissionId: () => {
    const chars =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let id = "";
    for (let i = 0; i < 4; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  },
};

class InReachSender extends Component {
  constructor() {
    super({
      description: "Sends chunked payloads via the Garmin InReach web endpoint",
      inPorts: {
        in: {
          datatype: "object",
          required: true,
        },
        replyaddress: {
          datatype: "string",
          description:
            "Email address shown to the InReach recipient as the reply sender (ReplyAddress)",
          control: true,
          required: false,
        },
        delayms: {
          datatype: "number",
          description:
            "Delay between chunks in milliseconds (default: 5000, matching the references)",
          control: true,
          required: false,
          default: 5000,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description:
            "Success confirmation once all chunks transmitted, or failed message on error",
        },
      },
      validates: {
        replyTo: "str",
      },
    });

    this.replyAddress = null;
    this.delayMs = 5000;
    this.client = null;
  }

  ensureClient() {
    if (!this.client || this.client.replyAddress !== this.replyAddress) {
      this.client = di.createClient({ replyAddress: this.replyAddress });
    }
  }

  /**
   * Wrap raw multi-chunk payloads in the Unified Compact Header Protocol
   * format: [ID:4][Type:1][Index:2][Total:2]:[Payload]
   *
   * The type character is derived from msg.partType or msg.intent:
   *   grib → 'G', text → 'T', sys → 'S'
   */
  wrapChunks(chunks, msg) {
    const transmissionId = msg.transmissionId || di.generateTransmissionId();
    const partType = msg.partType || (msg.intent === "GRIB" ? "grib" : "text");
    const typeChar =
      { grib: "G", text: "T", sys: "S", image: "I" }[partType] || "T";
    const total = chunks.length;

    return chunks.map((chunk, i) => {
      const index = String(i + 1).padStart(2, "0");
      const totalStr = String(total).padStart(2, "0");
      return `${transmissionId}${typeChar}${index}${totalStr}:${chunk}`;
    });
  }

  handle(input, output) {
    // Process control ports
    if (input.hasData("replyaddress")) {
      this.replyAddress = input.getData("replyaddress");
    }
    if (input.hasData("delayms")) {
      this.delayMs = input.getData("delayms");
    }

    // Wait for IN port. Sync `return` (not `return null`): in an async
    // handle, `return null` resolves the promise and NoFlo calls
    // output.sendDone(null), forwarding null to the out port. A sync
    // handle's `return` yields undefined, which NoFlo treats as
    // "preconditions not met" without sending anything. See the
    // noflo-webserver Server.coffee lifecycle pattern.
    if (!input.hasData("in")) {
      return;
    }

    const msg = input.getData("in");

    // Validation is explicit for multi-route components
    if (!this.validate(msg)) {
      return output.sendDone(msg);
    }

    if (!this.replyAddress) {
      fail(
        msg,
        new InReachClient.InReachError(
          "InReach replyAddress not configured",
          "NOT_CONFIGURED",
        ),
      );
      return output.sendDone(msg);
    }

    // The Garmin reply URL is carried per-message in replyTo.
    const replyUrl = msg.replyTo;
    // URL format validation (not covered by validates)
    if (!/^https?:\/\//.test(replyUrl)) {
      fail(
        msg,
        new InReachClient.InReachError(
          `InReach reply URL missing or invalid in msg.replyTo: ${replyUrl}`,
          "BAD_URL",
        ),
      );
      return output.sendDone(msg);
    }

    // Normalize payload: accept a single string or an array of chunks.
    let chunks = msg.payload;
    if (typeof chunks === "string") {
      chunks = [chunks];
    }
    if (!Array.isArray(chunks) || chunks.length === 0) {
      fail(
        msg,
        new Error("Payload must be a non-empty array of message chunks"),
      );
      return output.sendDone(msg);
    }

    // With the Unified Compact Header Protocol, multi-chunk payloads from
    // GribChunker and StatusBuilder already carry compact headers
    // ([ID:4][Type:1][Index:2][Total:2]:[Payload]). Single-chunk notifications
    // (e.g. "Blog OK: 2026-08-09.md") are sent headerless — the reassembler
    // passes headerless messages through unchanged.
    //
    // If raw multi-chunk payloads arrive without compact headers (no component
    // in the production graph does this, but tests may), wrap them using the
    // compact format so they can still be reassembled on the boat.
    const hasCompactHeaders = chunks[0].match(
      /^[a-zA-Z0-9]{4}[A-Za-z]\d{2}\d{2}:/,
    );
    const toSend = hasCompactHeaders
      ? chunks
      : chunks.length > 1
        ? this.wrapChunks(chunks, msg)
        : chunks;

    this.ensureClient();

    // Fire-and-forget the async transmission. The sync handle returns
    // undefined (no auto-sendDone); transmit() resolves the output itself
    // via output.sendDone() on success or error. This mirrors the
    // noflo-webserver Server.coffee pattern: sync process function, async
    // work in a callback that owns output lifecycle.
    this.transmit(msg, replyUrl, toSend, chunks.length, output);
  }

  async transmit(msg, replyUrl, toSend, chunkCount, output) {
    let sent = 0;
    try {
      for (let i = 0; i < toSend.length; i++) {
        await this.client.send(replyUrl, toSend[i]);
        sent = i + 1;
        // Safety delay between chunks (skip after the last one).
        if (i < toSend.length - 1) {
          await this.delay(this.delayMs);
        }
      }
    } catch (err) {
      const code = err.code || "API_FAILURE";
      console.error(
        `[InReachSender] Send failed at chunk ${sent + 1}/${chunkCount}: ${code} - ${err.message}`,
      );
      const wrapped = new InReachClient.InReachError(
        `InReach transmission failed at chunk ${sent + 1}/${chunkCount}: ${err.message}`,
        code,
        err.status,
      );
      fail(msg, wrapped);
      output.sendDone(msg);
      return;
    }

    // Build a confirmation IP, preserving routing fields.
    const confirm = fork(msg, ["payload", "intent", "notifyText"]);
    confirm.intent = "NOTIFY";
    confirm.payload = `Sent ${chunkCount} message(s) via InReach`;
    confirm.notifyText = `InReach: ${chunkCount} messages sent`;
    // Report the number of outbound messages sent so a downstream
    // MetricCounter(metric=msg_out) can count them (one per chunk).
    confirm.sentCount = chunkCount;
    console.log(`[InReachSender] Successfully sent ${chunkCount} message(s)`);
    output.sendDone(confirm);
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

exports.getComponent = () => new InReachSender();
exports.di = di;
