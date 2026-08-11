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
// generateTransmissionId synthesizes the sequence id for an outbound
// multi-chunk envelope; it must match the boat's MessageReassembler header
// grammar (\w+) and is injectable so tests can pin it.
const di = {
  createClient: (options) => new InReachClient(options),
  generateTransmissionId: () => `r${Math.random().toString(36).slice(2, 8)}`,
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
          description: "Success confirmation once all chunks transmitted",
        },
        error: {
          datatype: "object",
          description: "Failed assembly message on transmission error",
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
      return output.sendDone({ error: msg });
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
      return output.sendDone({ error: msg });
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
      return output.sendDone({ error: msg });
    }

    // Wrap multi-chunk payloads in the sequence envelope the boat's
    // MessageReassembler expects: "msg <i>/<total>:<partType>:<transmissionId>\n<chunk>"
    // (1-based). Single-chunk payloads are sent as-is — the reassembler passes
    // headerless messages through unchanged, so short confirmations pay no
    // per-message overhead. partType labels the content for the boat (default
    // 'text'; GRIB deliveries get 'grib'). Either field may be supplied on the
    // msg to override the synthesis.
    const partType = msg.partType || (msg.intent === "GRIB" ? "grib" : "text");
    const transmissionId = msg.transmissionId || di.generateTransmissionId();
    const toSend =
      chunks.length > 1
        ? chunks.map(
            (chunk, i) =>
              `msg ${i + 1}/${chunks.length}:${partType}:${transmissionId}\n${chunk}`,
          )
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
      output.sendDone({ error: msg });
      return;
    }

    // Build a confirmation IP, preserving routing fields.
    const confirm = fork(msg, ["payload", "intent", "notifyText"]);
    confirm.intent = "NOTIFY";
    confirm.payload = `Sent ${chunkCount} message(s) via InReach`;
    confirm.notifyText = `InReach: ${chunkCount} messages sent`;
    console.log(`[InReachSender] Successfully sent ${chunkCount} message(s)`);
    output.sendDone(confirm);
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

exports.getComponent = () => new InReachSender();
exports.di = di;
