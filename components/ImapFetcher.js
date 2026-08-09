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
 * ImapFetcher - One-shot IMAP fetcher component.
 *
 * Triggered by a bang on `in` (typically from `core/RunInterval`). On each
 * trigger it opens a fresh IMAP connection, fetches all unseen messages,
 * emits the relevant ones on `out`, then disconnects and calls `done()`.
 *
 * This is the standard NoFlo request-response pattern: each bang is one
 * activation that completes when the fetch cycle finishes. No persistent
 * connection or generator context to manage — `core/RunInterval` keeps the
 * network alive between triggers.
 *
 * Only InReach (Garmin), Winlink, and Saildocs messages are emitted; unrelated
 * emails are skipped and left unread. Marking as seen is NOT done here — a
 * separate `ImapAcker` component at the end of the flow marks messages as
 * seen only after the pipeline has successfully processed them (using the
 * `imapUid` carried on each emitted email).
 *
 * Config (host, port, username, password, mailbox) arrives as IIPs on control
 * ports; they are buffered and read when the `in` bang triggers handle().
 */
class ImapFetcher extends Component {
  constructor() {
    super({
      description:
        "Fetches unseen emails from IMAP on each trigger bang (one-shot)",
      inPorts: {
        in: {
          datatype: "bang",
          description: "Trigger a fetch cycle",
          required: true,
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
          description: "Incoming email message",
        },
      },
    });

    this.imapConfig = {};
  }

  handle(input, output, context) {
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

    // Wait for the trigger bang. Sync `return` (not `return null`): in an
    // async handle, `return null` resolves the promise and NoFlo calls
    // output.sendDone(null), forwarding null downstream. A sync handle's
    // `return` yields undefined, which NoFlo treats as "preconditions not
    // met" without sending anything. See noflo-webserver Server.coffee.
    if (!input.hasData("in")) {
      return;
    }
    input.getData("in"); // consume the bang

    // Activate so NoFlo tracks the in-flight work; the fire-and-forget
    // fetchCycle() resolves the activation via output.done(). done() is
    // idempotent w.r.t. activation (activate is a no-op if already active).
    context.activate();
    this.fetchCycle(output);
  }

  async fetchCycle(output) {
    let client = null;
    try {
      client = new ImapFlow({
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
      console.log(
        `[ImapFetcher] Connected to ${this.imapConfig.host}, mailbox: ${this.imapConfig.mailbox || "INBOX"}`,
      );

      const uids = await client.search({ seen: false }, { uid: true });
      if (uids.length === 0) {
        console.log("[ImapFetcher] No unseen messages, cycle complete");
        return;
      }

      console.log(`[ImapFetcher] ${uids.length} unseen messages`);

      let fetched = 0;
      let emitted = 0;
      for await (const message of client.fetch(
        uids,
        {
          envelope: true,
          source: true,
          headers: ["return-path", "message-id"],
        },
        { uid: true },
      )) {
        fetched++;
        const email = this.parseMessage(message);
        if (email && this.isSystemMessage(email)) {
          output.send({ out: email });
          emitted++;
        } else if (email) {
          console.log(
            `[ImapFetcher] Skipping unrelated message uid=${email.imapUid} from: ${email.from.address}`,
          );
        }
      }
      console.log(
        `[ImapFetcher] Fetch complete: ${fetched} fetched, ${emitted} emitted`,
      );
    } catch (err) {
      console.error("[ImapFetcher] Fetch cycle failed:", err.message);
    } finally {
      if (client) {
        try {
          await client.logout();
        } catch {
          // Ignore close errors — the cycle is done regardless.
        }
      }
      // Resolve the activation. This activates (no-op, already active) then
      // deactivates, releasing the load so NoFlo can end if nothing else
      // holds the network alive (core/RunInterval does, between bangs).
      output.done();
    }
  }

  parseMessage(message) {
    if (!message.envelope || !message.source) {
      return null;
    }

    const envelope = message.envelope;
    const headers = parseHeaders(message.headers);
    const returnPath = headers.get("return-path") || "";

    let body = "";
    const sourceStr = message.source.toString("utf-8");
    const headerEnd = sourceStr.indexOf("\r\n\r\n");
    body = headerEnd >= 0 ? sourceStr.slice(headerEnd + 4) : sourceStr;
    body = body.trim();

    console.log(
      `[ImapFetcher] Message uid=${message.uid}: from=${envelope.from?.[0]?.address}, body preview=${body.substring(0, 40)}`,
    );

    return {
      imapUid: message.uid,
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
  }

  /**
   * Check if an email message is relevant to the offshore blogging system.
   *
   * Only InReach (Garmin), Winlink, and Saildocs messages are processed.
   * Unrelated emails (personal, spam, mailing lists) are left unread in the
   * mailbox and never enter the pipeline. See work doc #7.
   *
   * @param {Object} email - Parsed email object
   * @returns {boolean} true if message should be processed
   */
  isSystemMessage(email) {
    const sender = (email.from?.address || "").toLowerCase();

    // Fast path: sender domain whitelist
    if (
      sender.endsWith("@inreach.garmin.com") ||
      sender.endsWith("@garmin.com") ||
      sender.endsWith("@winlink.org") ||
      sender.includes("@wl2k") ||
      // Saildocs responds from query-reply@saildocs.com (and
      // query@saildocs.com for acknowledgements), so match the domain.
      sender.endsWith("@saildocs.com")
    ) {
      return true;
    }

    // Fallback: content inspection for messages whose envelope sender
    // doesn't match the whitelist but whose body carries a known marker.
    const body = (email.body || "").toLowerCase();
    if (body.includes("---begin reticulum metadata---")) {
      return true;
    }
    if (
      body.includes("explore.garmin.com/textmessage/") ||
      body.includes("inreachlink.com/")
    ) {
      return true;
    }

    return false;
  }
}

exports.getComponent = () => new ImapFetcher();
