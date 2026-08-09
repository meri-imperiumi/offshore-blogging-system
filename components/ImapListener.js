const { Component } = require("noflo-assembly");
const { ImapFlow } = require("imapflow");

/**
 * Parse a raw email headers Buffer into a Map of lowercased header name -> value.
 *
 * ImapFlow returns requested headers as a raw Buffer of `Key: Value\r\n` lines
 * (RFC 5322). It does not bundle a structured parser. We only need a few
 * headers (return-path, message-id) for the ping-pong flow, so a minimal
 * line-based parser is sufficient. Handles header folding (continuation lines
 * beginning with whitespace) by joining them to the previous header.
 *
 * @param {Buffer|string} raw - Raw headers
 * @returns {Map<string, string>}
 */
function parseHeaders(raw) {
  const map = new Map();
  if (!raw) {
    return map;
  }
  const text = Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw);
  const lines = text.split(/\r?\n/);
  let currentKey = null;
  for (const line of lines) {
    if (!line) {
      continue;
    }
    // Folded continuation line (starts with whitespace)
    if (/^\s/.test(line) && currentKey) {
      const existing = map.get(currentKey) || "";
      map.set(currentKey, `${existing} ${line.trim()}`);
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      continue;
    }
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    if (key) {
      map.set(key, value);
      currentKey = key;
    }
  }
  return map;
}

/**
 * ImapListener - Generator component that listens on IMAP for incoming emails
 *
 * Uses ImapFlow (MIT licensed, compatible with EUPL-1.2 for linking)
 * Connects to IMAP mailbox, uses IDLE for real-time notification
 * Emits incoming emails as assembly messages
 *
 * This is a NoFlo "generator component": it self-activates a processing
 * context and sends packets asynchronously whenever new emails arrive,
 * independent of input packets. See NoFlo generator component docs.
 *
 * Config (host, port, username, password, mailbox) arrives as IIPs on
 * non-control inports. Since NoFlo control ports are non-triggering and
 * this component has no `in` data port, the config ports themselves trigger
 * handle(). Once all required fields are present, the generator starts.
 */
class ImapListener extends Component {
  constructor() {
    super({
      description: "Listens on IMAP mailbox for incoming emails",
      inPorts: {
        // Config ports are control (non-triggering). They buffer IIPs
        // but don't call handle(). The `start` bang port triggers the
        // generator once config is in place.
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
        interval: {
          datatype: "number",
          description:
            "Start the IMAP listener with the given polling interval in seconds (activates the generator)",
          required: true,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Incoming email message",
        },
      },
    });

    // Generators want to send data immediately, not buffer
    this.autoOrdering = false;

    this.imapConfig = {};
    this.client = null;
    this.imapStarted = false;
    // The activated generator context — kept alive until tearDown
    this.generatorContext = null;
    this.generatorOutput = null;
    // Polling state
    this.polling = false;
    this.pollInterval = null;
    this.pollIntervalMs = 15000; // 15s poll cycle for InReach traffic
  }

  handle(input, output, context) {
    // The `interval` port (polling interval in seconds) activates the
    // generator. Control ports are read from their buffered values
    // (control ports are non-triggering).
    if (!input.hasData("interval")) {
      return;
    }
    const pollSeconds = input.getData("interval");
    if (typeof pollSeconds === "number" && pollSeconds > 0) {
      this.pollIntervalMs = pollSeconds * 1000;
    }

    // Read config from control ports (buffered from IIPs)
    if (input.hasData("host")) {
      this.imapConfig.host = input.getData("host");
    }
    if (input.hasData("port")) {
      this.imapConfig.port = input.getData("port");
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

    // Check if we have all required config
    const ready =
      this.imapConfig.host && this.imapConfig.user && this.imapConfig.pass;

    if (ready && !this.imapStarted) {
      // Activate the generator: store the processing context and output
      // so we can send packets asynchronously as emails arrive.
      // We call context.activate() to tell NoFlo this context is still
      // alive — without it, NoFlo sees load=0 and ends the network.
      // We intentionally do NOT call output.done() — that would both
      // activate and immediately deactivate, killing the generator.
      this.imapStarted = true;
      this.generatorContext = context;
      this.generatorOutput = output;
      context.activate();
      this.startImapConnection();
      return;
    }

    output.done();
  }

  async startImapConnection() {
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

    this.client = client;

    try {
      await client.connect();
      await client.mailboxOpen(this.imapConfig.mailbox || "INBOX");

      console.log(`[ImapListener] Connected to ${this.imapConfig.host}`);
      console.log(
        `[ImapListener] Watching mailbox: ${this.imapConfig.mailbox || "INBOX"}`,
      );

      // Process any unread messages already in the mailbox at startup
      // (e.g. PINGs that arrived while we were offline)
      await this.fetchNewMessages();

      // Polling loop: check for new unseen messages every N seconds.
      // We use polling instead of IDLE because ImapFlow's manual idle()
      // blocks and conflicts with the search/fetch/store commands the
      // exists handler runs (IDLE must stop to run them, stalling the
      // pending idle() promise). Polling is simpler and more robust for
      // our low-frequency InReach traffic (minutes between messages).
      this.polling = true;
      this.pollInterval = setInterval(
        () => {
          this.fetchNewMessages().catch((err) => {
            console.error(
              "[ImapListener] Error during poll:",
              err.message,
            );
          });
        },
        this.pollIntervalMs,
      );
      console.log(
        `[ImapListener] Polling every ${this.pollIntervalMs / 1000}s`,
      );
    } catch (err) {
      console.error("[ImapListener] Connection failed:", err.message);
      this.client = null;
      this.imapStarted = false;
      // Retry after delay
      setTimeout(() => this.startImapConnection(), 5000);
    }
  }

  async fetchNewMessages() {
    if (!this.client) {
      return;
    }

    try {
      const searchResult = await this.client.search({ seen: false }, {
        uid: true,
      });

      if (searchResult.length === 0) {
        return;
      }

      console.log(
        `[ImapListener] Fetching ${searchResult.length} unseen messages`,
      );

      let fetched = 0;
      for await (const message of this.client.fetch(searchResult, {
        envelope: true,
        source: true,
        headers: ["return-path", "message-id"],
      })) {
        fetched++;
        console.log(
          `[ImapListener] Fetched message ${fetched}/${searchResult.length}: uid=${message.uid}`,
        );
        await this.processMessage(message);
      }
      console.log(
        `[ImapListener] Fetch complete, processed ${fetched} messages`,
      );
    } catch (err) {
      console.error("[ImapListener] Fetch failed:", err.message);
    }
  }

  async processMessage(message) {
    if (!message.envelope || !message.source) {
      return;
    }

    const envelope = message.envelope;
    const headers = parseHeaders(message.headers);

    // Get Return-Path for device ID extraction
    const returnPath = headers.get("return-path") || "";

    // Parse body
    let body = "";
    if (message.source) {
      const sourceStr = message.source.toString("utf-8");
      // Extract the text body after the blank line separating headers from body
      const headerEnd = sourceStr.indexOf("\r\n\r\n");
      body =
        headerEnd >= 0 ? sourceStr.slice(headerEnd + 4) : sourceStr;
      // Trim trailing whitespace/quoted reply markers
      body = body.trim();
    }
    console.log(
      `[ImapListener] Message uid=${message.uid}: from=${envelope.from?.[0]?.address}, body preview=${body.substring(0, 40)}`,
    );

    // Build email object
    const email = {
      from: {
        address: envelope.from?.[0]?.address || "",
        name: envelope.from?.[0]?.name || "",
      },
      to: {
        address: envelope.to?.[0]?.address || "",
        name: envelope.to?.[0]?.name || "",
      },
      subject: envelope.subject || "",
      body: body,
      raw: message.source,
      headers: {
        "return-path": returnPath,
        "message-id": headers.get("message-id") || "",
      },
      messageId: headers.get("message-id") || "",
      returnPath: returnPath,
      date: new Date(envelope.date),
    };

    // Send the email through the activated generator context's output FIRST,
    // before marking as seen. This way processing isn't blocked by the flag
    // operation, and if flag-setting fails we've already processed the message.
    if (this.generatorOutput) {
      this.generatorOutput.send({ out: email });
      console.log(
        `[ImapListener] Processed message from: ${email.from.address}`,
      );
    } else {
      console.warn("[ImapListener] No generator output available");
    }

    console.log(`[ImapListener] marking as seen: uid=${message.uid}`);
    // Mark as seen so we don't reprocess this message on next fetch.
    // Use the message-id search to avoid UID/sequence number confusion.
    try {
      await this.client.messageFlagsSet(message.uid, ["\\Seen"], {
        uid: true,
      });
      console.log(`[ImapListener] Marked as seen: uid=${message.uid}`);
    } catch (err) {
      console.warn("[ImapListener] Failed to mark as seen:", err.message);
    }
  }

  // Called at network shutdown — clean up IMAP connection and deactivate
  tearDown(callback) {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.polling = false;
    if (this.client) {
      console.log("[ImapListener] Shutting down IMAP connection");
      this.client.close();
      this.client = null;
    }
    if (this.generatorContext) {
      this.generatorContext.deactivate();
      this.generatorContext = null;
      this.generatorOutput = null;
    }
    if (callback) {
      callback(null);
    }
    return Promise.resolve();
  }
}

exports.getComponent = () => new ImapListener();
