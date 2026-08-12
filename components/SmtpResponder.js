const { Component, failed, fail } = require("noflo-assembly");
const SmtpClient = require("../lib/SmtpClient");

/**
 * SmtpResponder - Sends plaintext responses via SMTP
 *
 * Logic:
 * - Takes a NOTIFY/confirmation-intent IP
 * - Renders a short plaintext body from msg.payload or notifyText field
 * - Sends via the configured SMTP server to msg.replyTo
 * - Used for Winlink replies and Saildocs outbound requests
 *
 * NOTE: handle() is intentionally NOT async. NoFlo's handleIP wraps async
 * process functions so that when the returned Promise resolves, it calls
 * output.sendDone(resolvedValue). If the handle already called sendDone()
 * internally, this causes a duplicate send on the out port. Using a sync
 * handle with .then()/.catch() callbacks avoids this.
 */
class SmtpResponder extends Component {
  constructor() {
    super({
      description: "Sends plaintext responses via SMTP",
      inPorts: {
        in: {
          datatype: "object",
          description: "Assembly message to send as email",
        },
        smtp_host: {
          datatype: "string",
          description: "SMTP server host",
          control: true,
          required: false,
          default: "smtp.mailbox.org",
        },
        smtp_port: {
          datatype: "number",
          description: "SMTP server port",
          control: true,
          required: false,
          default: 587,
        },
        smtp_user: {
          datatype: "string",
          description: "SMTP username",
          control: true,
          required: false,
        },
        smtp_pass: {
          datatype: "string",
          description: "SMTP password",
          control: true,
          required: false,
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description:
            "Confirmation message (passed through), or failed message on error",
        },
      },
    });

    this.smtpHost = "smtp.mailbox.org";
    this.smtpPort = 587;
    this.smtpUser = null;
    this.smtpPass = null;
  }

  handle(input, output) {
    // Process control ports
    if (input.hasData("smtp_host")) {
      this.smtpHost = input.getData("smtp_host");
    }
    if (input.hasData("smtp_port")) {
      this.smtpPort = input.getData("smtp_port");
    }
    if (input.hasData("smtp_user")) {
      this.smtpUser = input.getData("smtp_user");
    }
    if (input.hasData("smtp_pass")) {
      this.smtpPass = input.getData("smtp_pass");
    }

    // Sync `return` (not `return null`): in an async handle, `return null`
    // resolves the promise and NoFlo calls output.sendDone(null), forwarding
    // null to the out port. A sync handle's `return` yields undefined, which
    // NoFlo treats as "preconditions not met" without sending anything.
    if (!input.hasData("in")) {
      return;
    }

    const msg = input.getData("in");

    // Check for failed messages
    if (failed(msg)) {
      return output.sendDone(msg);
    }

    // Determine the envelope recipient. GribFetcher's Saildocs OUTBOX sets
    // `to` (and `replyTo`) explicitly; notification replies set only `replyTo`.
    const recipient = msg.to || msg.replyTo;
    if (!recipient) {
      fail(
        msg,
        new Error("SMTP send failed: no recipient (msg.to/msg.replyTo)"),
      );
      return output.sendDone(msg);
    }

    // Body: honor an explicit `body` (Saildocs request, pre-terminated), then
    // notifyText, then payload, then a placeholder.
    let body = "";
    if (msg.body) {
      body = msg.body;
    } else if (msg.notifyText) {
      body = msg.notifyText;
    } else if (msg.payload) {
      body =
        typeof msg.payload === "string"
          ? msg.payload
          : JSON.stringify(msg.payload);
    } else {
      body = "(no message)";
    }

    // Subject: honor an explicit `subject` (Saildocs request), else derive from
    // notifyText/payload, else "Notification".
    let subject = "Notification";
    if (msg.subject) {
      subject = msg.subject;
    } else if (msg.notifyText) {
      subject = msg.notifyText.split("\n")[0];
    } else if (msg.payload) {
      const payloadStr =
        typeof msg.payload === "string"
          ? msg.payload
          : JSON.stringify(msg.payload);
      subject = payloadStr.split("\n")[0].substring(0, 50);
    }

    // Create SMTP client and send asynchronously. Using .then()/.catch()
    // instead of async/await so that handle() returns undefined (not a
    // Promise). If it returned a Promise, NoFlo would call
    // output.sendDone(resolvedValue) on resolve, causing a duplicate send.
    const client = new SmtpClient(this.smtpHost, this.smtpPort, {
      user: this.smtpUser,
      password: this.smtpPass,
    });

    client
      .sendWithRetry(recipient, subject, body)
      .then(() => {
        // Pass through the message on success
        output.sendDone(msg);
      })
      .catch((err) => {
        // Send failed - mark as failed and pass through.
        // sendDone (not just send) so the activation resolves cleanly.
        fail(msg, new Error(`SMTP send failed: ${err.message}`));
        output.sendDone(msg);
      });
  }
}

exports.getComponent = () => new SmtpResponder();
