const net = require('node:net');

/**
 * Simple SMTP client for sending emails
 * Basic implementation supporting PLAIN authentication
 */
class SmtpClient {
  constructor(host, port, options = {}) {
    this.host = host;
    this.port = port;
    this.user = options.user || null;
    this.password = options.password || null;
    this.timeout = options.timeout || 30000;
  }

  async send(to, subject, body) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.port, this.host);
      let buffer = '';
      let step = 0;
      const stages = {
        connect: 'connect',
        ehlo: 'ehlo',
        starttls: 'starttls',
        auth: 'auth',
        mail: 'mail',
        rcpt: 'rcpt',
        data: 'data',
        data_content: 'data_content',
        quit: 'quit',
      };

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('SMTP connection timeout'));
      }, this.timeout);

      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\r\n');

        // Only process if we have a complete response (line ending with space and more data)
        const lastLine = lines[lines.length - 1];
        if (lastLine.includes(' \r\n')) {
          // Multiline response, wait for more data
          return;
        }

        if (lastLine.startsWith('2')) {
          // Success - proceed to next step
          buffer = '';
          this.processStage(socket, to, subject, body, stages, step++, resolve, reject, timeout);
        } else if (lastLine.startsWith('3') && !lastLine.startsWith('354')) {
          // Error
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error(`SMTP error: ${lastLine}`));
        } else if (lastLine.startsWith('4')) {
          // Transient error
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error(`SMTP transient error: ${lastLine}`));
        } else if (lastLine.startsWith('5')) {
          // Permanent error
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error(`SMTP permanent error: ${lastLine}`));
        }
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      socket.on('close', () => {
        clearTimeout(timeout);
      });

      socket.on('connect', () => {
        this.processStage(socket, to, subject, body, stages, step++, resolve, reject, timeout);
      });
    });
  }

  processStage(socket, to, subject, body, stages, step, resolve, reject, timeout) {
    switch (step) {
      case stages.connect:
        socket.write('EHLO localhost\r\n');
        break;

      case stages.ehlo:
        if (this.user && this.password) {
          socket.write(`AUTH PLAIN ${this.base64Encode(`\0${this.user}\0${this.password}`)}\r\n`);
        } else {
          socket.write('MAIL FROM:<>\r\n');
        }
        break;

      case stages.auth:
        socket.write('MAIL FROM:<>\r\n');
        break;

      case stages.mail:
        socket.write(`RCPT TO:<${to}>\r\n`);
        break;

      case stages.rcpt:
        socket.write('DATA\r\n');
        break;

      case stages.data:
        socket.write(`Subject: ${subject}\r\n`);
        socket.write(`To: ${to}\r\n`);
        socket.write('Content-Type: text/plain; charset=utf-8\r\n\r\n');
        socket.write(body);
        socket.write('\r\n.\r\n');
        break;

      case stages.data_content:
        socket.write('QUIT\r\n');
        break;

      case stages.quit:
        clearTimeout(timeout);
        socket.end();
        resolve();
        break;
    }
  }

  base64Encode(str) {
    return Buffer.from(str).toString('base64');
  }
}

module.exports = SmtpClient;