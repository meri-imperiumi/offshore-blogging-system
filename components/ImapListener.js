const { Component, failed, fail } = require("noflo-assembly");

/**
 * ImapListener - Listens on IMAP mailbox for incoming emails
 *
 * Logic:
 * - Connects to IMAP mailbox
 * - Uses IDLE for real-time notification
 * - Emits incoming emails as assembly messages
 *
 * Note: IMAP connection would use node:imap for EUPL-1.2 compliance
 */
class ImapListener extends Component {
  constructor() {
    super({
      description: "Listens on IMAP mailbox for incoming emails",
      inPorts: {
        host: {
          datatype: "string",
          description: "IMAP server host",
          control: true,
          required: true,
        },
        port: {
          datatype: "number",
          description: "IMAP server port",
          control: true,
          required: true,
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
          default: "INBOX",
        },
      },
      outPorts: {
        out: {
          datatype: "object",
          description: "Incoming email message",
        },
      },
    });

    this.imapConfig = null;
  }

  async handle(input, output) {
    // Collect IMAP configuration
    if (input.hasData("host")) {
      const config = {
        host: input.getData("host"),
      };
      if (input.hasData("port")) {
        config.port = input.getData("port");
      }
      if (input.hasData("username")) {
        config.user = input.getData("username");
      }
      if (input.hasData("password")) {
        config.password = input.getData("password");
      }
      if (input.hasData("mailbox")) {
        config.mailbox = input.getData("mailbox");
      }
      this.imapConfig = config;
    }

    if (!this.imapConfig) {
      return null;
    }

    try {
      // TODO: Implement actual IMAP connection with node:imap
      // This would require:
      // - node:imap for EUPL-1.2 compliance
      // - IDLE handling for real-time notification
      // - Proper connection management with exponential backoff
      // - NOOP keep-alive every 15-20 minutes
      // - Extract email headers, body, attachments

      console.log(
        `[ImapListener] Would connect to IMAP at ${this.imapConfig.host}:${this.imapConfig.port}`,
      );

      // Mock: just wait and return null (no messages)
      await new Promise((resolve) => setTimeout(resolve, 100));
      return null;
    } catch (err) {
      console.error("[ImapListener] Connection failed:", err.message);

      // Schedule reconnection after delay
      await new Promise((resolve) => setTimeout(resolve, 5000));

      return null;
    }
  }
}

exports.getComponent = () => new ImapListener();
