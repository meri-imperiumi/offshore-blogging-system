const { Component, failed } = require("noflo-assembly");
const SmtpClient = require("../lib/SmtpClient");

/**
 * SmtpResponder - Sends plaintext responses via SMTP
 *
 * Logic:
 * - Takes a NOTIFY/confirmation-intent IP
 * - Renders a short plaintext body from msg.payload or notifyText field
 * - Sends via the configured SMTP server to msg.replyTo
 * - Used for Winlink replies and Saildocs outbound requests
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
          description: "Confirmation message (passed through)",
        },
        error: {
          datatype: "object",
          description: "Send failures",
        },
      },
    });

    this.smtpHost = "smtp.mailbox.org";
    this.smtpPort = 587;
    this.smtpUser = null;
    this.smtpPass = null;
  }

  async handle(input, output) {
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

    // Wait for IN port
    if (!input.hasData("in")) {
      return null;
    }

    const msg = input.getData("in");

    // Check for failed messages
    if (failed(msg)) {
      return output.sendDone(msg);
    }

    // Build email body
    let body = "";
    if (msg.notifyText) {
      body = msg.notifyText;
    } else if (msg.payload) {
      body =
        typeof msg.payload === "string"
          ? msg.payload
          : JSON.stringify(msg.payload);
    } else {
      body = "(no message)";
    }

    // Build subject
    let subject = "Notification";
    if (msg.notifyText) {
      subject = msg.notifyText.split("\n")[0]; // Use first line as subject
    } else if (msg.payload) {
      const payloadStr =
        typeof msg.payload === "string"
          ? msg.payload
          : JSON.stringify(msg.payload);
      subject = payloadStr.split("\n")[0].substring(0, 50);
    }

    try {
      // Create SMTP client and send
      const client = new SmtpClient(this.smtpHost, this.smtpPort, {
        user: this.smtpUser,
        password: this.smtpPass,
      });

      await client.send(msg.replyTo, subject, body);

      // Pass through the message
      return output.sendDone(msg);
    } catch (err) {
      // Send failed - return on error port
      const errorMsg = {
        errors: [{ message: `SMTP send failed: ${err.message}` }],
        identityHash: msg.identityHash,
        replyTo: msg.replyTo,
        channel: msg.channel,
        intent: msg.intent,
        payload: msg.payload,
      };

      return output.send({ error: errorMsg });
    }
  }
}

exports.getComponent = () => new SmtpResponder();
