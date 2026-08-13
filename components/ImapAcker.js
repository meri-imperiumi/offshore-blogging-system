const { Component, failed } = require("noflo-assembly");
const { ImapFlow } = require("imapflow");

/**
 * ImapAcker - Marks emails as seen after the pipeline has processed them.
 *
 * Sits at the end of the flow (e.g. after InReachSender) and uses the
 * `imapUid` carried on the assembly message to mark the original email as
 * \Seen via a separate IMAP connection. This decouples ingestion from
 * acknowledgement:
 *
 *   ImapFetcher → ... → InReachSender → ImapAcker
 *
 * - Messages that fail downstream (send error, etc.) never reach ImapAcker
 *   (they go to the error port), so the email stays unseen and is retried
 *   on the next poll.
 * - Messages without an `imapUid` (not from IMAP, e.g. test-injected) pass
 *   through unchanged.
 *
 * The IMAP connection is opened lazily on the first message and kept alive
 * until tearDown. Config ports are control (non-triggering).
 */
class ImapAcker extends Component {
  constructor() {
    super({
      description:
        "Marks emails as seen via IMAP after the pipeline has processed them",
      inPorts: {
        in: {
          datatype: "object",
          description: "Processed assembly message carrying imapUid",
        },
        host: {
          datatype: "string",
          description: "IMAP server host",
          control: true,
          required: true,
        },
        port: {
          datatype: "number",
          description: "IMAP server port (default: 993)",
          control: true,
          required: false,
        },
        username: {
          datatype: "string",
          description: "IMAP username",
          control: true,
          required: true,
        },
        password: {
          datatype: "string",
          description: "IMAP password",
          control: true,
          required: true,
        },
        mailbox: {
          datatype: "string",
          description: "IMAP mailbox name (default: INBOX)",
          control: true,
          required: false,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Pass-through of the input message",
        },
      },
    });

    this.imapConfig = {};
    this.client = null;
    this.connecting = null;
  }

  async ensureConnected() {
    if (this.client) {
      return this.client;
    }
    // Avoid double-connect if multiple messages arrive concurrently
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.connect();
    return this.connecting;
  }

  async connect() {
    const client = new ImapFlow({
      host: this.imapConfig.host,
      port: this.imapConfig.port || 993,
      secure: true,
      auth: {
        user: this.imapConfig.user,
        pass: this.imapConfig.pass,
      },
      logger: false,
    });

    await client.connect();
    await client.mailboxOpen(this.imapConfig.mailbox || "INBOX");
    this.client = client;
    this.connecting = null;
    console.log(
      `[ImapAcker] Connected to ${this.imapConfig.host}, mailbox: ${this.imapConfig.mailbox || "INBOX"}`,
    );
    return client;
  }

  handle(input, output) {
    // Read config from control ports (buffered from IIPs)
    if (input.hasData("host")) {
      this.imapConfig.host = input.getData("host");
    }
    if (input.hasData("port")) {
      const port = input.getData("port");
      this.imapConfig.port =
        typeof port === "string" ? parseInt(port, 10) : port;
    }
    if (input.hasData("username")) {
      this.imapConfig.user = input.getData("username");
    }
    if (input.hasData("password")) {
      this.imapConfig.pass = input.getData("password");
    }
    if (input.hasData("mailbox")) {
      this.imapConfig.mailbox = input.getData("mailbox");
    }

    // Sync `return` (not `return null`): in an async handle, `return null`
    // resolves the promise and NoFlo calls output.sendDone(null), forwarding
    // null to the out port. A sync handle's `return` yields undefined, which
    // NoFlo treats as "preconditions not met" without sending anything.
    // See the noflo-webserver Server.coffee lifecycle pattern.
    if (!input.hasData("in")) {
      return;
    }

    const msg = input.getData("in");

    // Guard against null/undefined (e.g. upstream forwarded a null) and
    // failed messages. Leave the email unread so it's retried; ImapAcker is
    // terminal, so just finish without forwarding.
    if (!msg || failed(msg)) {
      output.done();
      return;
    }

    // No imapUid or ackUids means this message didn't come from IMAP
    // (e.g. test-injected)
    if (!msg.imapUid && !msg.ackUids) {
      return output.sendDone(msg);
    }

    // Fire-and-forget the async IMAP STORE. The sync handle returns
    // undefined (no auto-sendDone); markSeen() resolves the output itself.
    // This mirrors the noflo-webserver Server.coffee pattern: sync process
    // function, async work in a callback that owns output lifecycle.
    this.markSeen(msg, output);
  }

  async markSeen(msg, output) {
    try {
      const client = await this.ensureConnected();

      // Support both single imapUid (legacy/simple cases) and ackUids array
      // (multi-part reassembled messages where all chunks contributed)
      const uids =
        msg.ackUids && Array.isArray(msg.ackUids) ? msg.ackUids : [msg.imapUid];

      for (const uid of uids) {
        if (!uid) continue;
        await client.messageFlagsSet(uid, ["\\Seen"], {
          uid: true,
        });
        console.log(`[ImapAcker] Marked as seen: uid=${uid}`);
      }
    } catch (err) {
      console.error(
        `[ImapAcker] Failed to mark as seen: ${
          msg.ackUids ? JSON.stringify(msg.ackUids) : msg.imapUid
        }: ${err.message}`,
      );
      // Still pass through — the message was processed; the ack failure
      // just means it'll be reprocessed on the next poll (idempotent ops
      // like PONG are safe to resend).
    }

    output.sendDone(msg);
  }

  tearDown(callback) {
    if (this.client) {
      console.log("[ImapAcker] Shutting down IMAP connection");
      this.client.close();
      this.client = null;
    }
    this.connecting = null;
    if (callback) {
      callback(null);
    }
    return Promise.resolve();
  }
}

exports.getComponent = () => new ImapAcker();
