# Signal K Offshore Blogging Plugin

A Signal K plugin for encoding blog posts and weather requests for low-bandwidth satellite transmission via InReach or Winlink. Requires a "cloud server" component running somewhere online for catching and responding to the requests.

## Features

- **Blog Post Encoding**: Compress Jekyll markdown blog posts into InReach messages
  - Text compression using zlib with optional custom dictionary
  - Image compression to WebP with auto-tuning for message budget
  - CRC-16 checksums for integrity verification
  - Three transmission modes: Text-only (InReach), Text+Image (InReach), Winlink (signed)

- **Weather Request Generator**: Generate Saildocs-formatted weather requests
  - Presets for common weather scenarios
  - Message count estimation

- **Chunk Reassembly**: Decode received InReach message chunks
  - Verify completeness and CRC integrity
  - Decompress text and display images
  - Support for partial image reception

## Installation

Install as a Signal K server plugin:

```bash
cd /usr/local/lib/node_modules/signalk-server
npm install ../offshore-blogging-system
```

Or in development:

```bash
cd /path/to/offshore-blogging-system
npm link
cd /usr/local/lib/node_modules/signalk-server
npm link @meri-imperiumi/signalk-offshore-blogging
```

## Configuration

Configure the plugin in Signal K Server settings:

- **Enable blog post encoding**: Off by default. Turn on to use the blog post encoding feature (requires a blog directory to be configured). Most users only need the weather/decode tools.
- **Blog sync path**: Path where blog posts are synced from mobile devices (used only when blog encoding is enabled)
- **Custom dictionary path**: Path to custom compression dictionary file (optional)
- **Default image message budget**: Default number of InReach messages for images (1-99)
- **Reticulum identity path**: Path to a stored Reticulum identity file for Winlink signing (optional; falls back to the signalk-reticulum plugin's identity)

### Cloud Server Environment Variables

For the cloud server (ping-pong and Saildocs tests, operational deployments):

```bash
# IMAP connection (for receiving InReach/Saildocs emails)
export IMAP_HOST=imap.mailbox.org
export IMAP_PORT=993
export IMAP_USERNAME=boat@lille-oe.de
export IMAP_PASSWORD={{ YOUR_PASSWORD }}

# SMTP connection (for sending replies and Saildocs requests)
export SMTP_HOST=smtp.mailbox.org
export SMTP_PORT=465
export SMTP_USERNAME=boat@lille-oe.de
export SMTP_PASSWORD={{ YOUR_PASSWORD }}

# InReach reply configuration
export INREACH_REPLY_ADDRESS=cloud@boat.example.com

# Operator alerting (SMTP email for failures)
# Sent via SmtpResponder, NOT through InReachSender (prevents circular failure)
# Fail-open design: alerts on ANY failure that isn't explicitly transient.
#   Known InReach codes: SESSION_EXPIRED, BAD_URL, NOT_CONFIGURED, BAD_RESPONSE → [InReach Alert]
#   Auth/security:       AUTH_DENIED                                        → [AUTH ALERT]
#   Unknown codes:       anything not listed below                          → [UNKNOWN ALERT]
#   No error code:      error with no .code property                        → [ALERT] UNCLASSIFIED
# Suppressed (transient, self-healing): RATE_LIMITED, NETWORK_ERROR, API_FAILURE
# To add a new alert type: set err.code in the source component, wire to AlertComposer
# To suppress a new transient: add its code to TRANSIENT_CODES in AlertComposer.js
# Rate limited: max 1 alert per error code per hour (configurable)
export ALERT_ADDRESS=operator@example.com

# Dacar authorization store (operator bootstraps with the `dacar` CLI)
export DACAR_HOME=~/.dacar
# Optional: explicit path to the `dacar` binary if not on PATH
# export DACAR_BIN=/usr/local/bin/dacar

# Device mapping (for ping-pong testing only)
export TEST_DEVICE_ID={{ DEVICE_ID }}
export TEST_IMEI={{ DEVICE_IMEI }}
export TEST_IDENTITY_HASH={{ IDENTITY_HASH }}
```

Before first boot, the operator must bootstrap the Dacar authorization store
on the cloud host. Dacar is decentralized (see work doc #5 §7 for the full
model), so two things must be shared **out-of-band** across every node that
will `dacar sync` together — they cannot be inferred over the network:

1. **The Privacy Salt** (Dacar spec §3.3). Object and relation labels are
   HMAC-SHA256-hashed with this 32-byte salt before they are stored or
   transmitted, so every node MUST use the same salt or a grant issued on one
   node won't match a `dacar check` on another. (`dacar init` with no `--salt`
   generates a fresh random salt per node — fine for a single isolated node,
   but it makes grants opaque to every other node.) Generate it **once** and
   copy it to every node (USB, QR code, LXMF, …):

   ```bash
   openssl rand -hex 32 > dacar-salt.hex           # run ONCE, then distribute
   ```

2. **The Root Trust Anchor**. `dacar init` creates the node's own Reticulum
   identity and records it as a root trust anchor (aliased `self`). On the
   node that issues grants, print the anchor so other nodes can trust it:

   ```bash
   dacar identity show                              # prints this node's identity hash
   ```

   On every *other* node that should honor admin-issued grants, trust the
   anchor before syncing:

   ```bash
   dacar anchor add <admin-identity-hash>
   ```

Then, on the cloud host, initialize with the shared salt and bootstrap the
grants the cloud server evaluates (`DacarAuthorizer` shells out to
`dacar check <identityHash> execute <permission>` per inbound message):

```bash
dacar init --salt "$(cat dacar-salt.hex)"          # create the store + root trust anchor
dacar grant <identityHash> execute blog:publish
dacar grant <identityHash> execute grib:request
dacar grant <identityHash> execute sys:command
```

Grants made this way are picked up on the next inbound message — no server
restart needed. To converge this node's state with other nodes over
Reticulum: `dacar sync` (and `dacar publish --all` to flush locally-granted
deltas).

These can also be set in a `.env` file (not committed to git):

```bash
# .env (NOT committed to git)
IMAP_HOST=imap.mailbox.org
IMAP_PORT=993
IMAP_USERNAME=boat@lille-oe.de
IMAP_PASSWORD=
SMTP_HOST=smtp.mailbox.org
SMTP_PORT=465
SMTP_USERNAME=boat@lille-oe.de
SMTP_PASSWORD=
INREACH_REPLY_ADDRESS=cloud@boat.example.com
DACAR_HOME=/home/boat/.dacar
```

## Usage

### Web Interface

Access the plugin at `http://localhost:3000/plugins/signalk-offshore-blogging/`

#### Blog Post Tab

1. Enter a filename (e.g., "2026-08-07" for `2026-08-07.md`)
2. Optionally set a Post ID (4 characters like MMDD, defaults to today's date)
3. Set the image message budget (how many messages to spend on each photo)
4. Click "Encode Post"
5. The plugin will automatically find images referenced in the markdown
6. Choose the transmission version:
   - **Text Only (InReach)**: Copy messages to Garmin Messenger. Markdown image tags are stripped from the body to save message budget.
   - **Text + Image (InReach)**: Includes compressed photo(s). The full body (with image markdown retained so the server knows where to place images) is sent alongside the image chunks.
   - **Winlink (Signed)**: Attach markdown to Winlink message

Copied chunks are marked with a green accent and a ✓ so you can keep track of what you have already sent. You can still copy an already-copied chunk again (e.g. if the server requests it again), and a "Reset copied markers" button clears the markers for the visible messages.

Images are automatically detected from markdown `![alt](path)` syntax and resolved relative to the blog directory.

#### Weather Request Tab

1. Select a preset or enter a custom Saildocs request
2. Click "Generate Request"
3. Copy and send via InReach

Format: `model:lat1,lat2,lon1,lon2|grid|hours|parameters`

Example: `gfs:24n,34n,72w,60w|2,2|12,24,36,48|wind`

#### Decode GRIB Tab

1. Paste received InReach messages one at a time
2. Click "Add Chunk" for each message
3. Click "Reassemble" to decode the complete transmission

## Message Format

The plugin uses the same message format as the Python reference implementation:

```
<postid:4><type:1><idx:2><total:2><crc:4>:<base64 data>
```

- `postid`: 4-character post identifier (e.g., "0805")
- `type`: "T" for text, "I" for image
- `idx`: Chunk index (01-99)
- `total`: Total chunks (01-99)
- `crc`: 16-bit CRC of the original data (hex)
- `data`: Base64-encoded compressed data

Message limit: 155 characters (to stay under Garmin's ~160 char limit)

**Note on Encoding**: The plugin uses base64 encoding instead of the denser base85. This is because Garmin's character counting rules penalize certain characters (backtick, ^, {, |, }, ~) that appear in base85's alphabet. Using base64 (A-Za-z0-9+/=) ensures all characters are confirmed 1-char-safe by Garmin's published tables, avoiding unpredictable message costs.

## Development

### Running Tests

```bash
npm test
```

### Live E2E Test Scripts

The `scripts/` directory contains end-to-end test runners that communicate
with real services over IMAP/SMTP. They require the cloud-server
environment variables (see above) and should be run from the project root.

#### Ping-Pong Runner (InReach)

```bash
node scripts/ping-pong-runner.js
```

Polls IMAP for a `PING` message from an InReach device and replies with
`PONG` via the InReach HTTP API.

#### Saildocs Runner (Weather GRIB)

```bash
node scripts/saildocs-runner.js
```

Sends a real weather-GRIB request to Saildocs (`query@saildocs.com`) via
SMTP, then polls IMAP for the response. Validates the reply — a GRIB file
attachment (binary, magic bytes `GRIB`) or an error/text message. Override
the default query and timing with environment variables:

```bash
# Small Baltic wind request (default)
SAILDOCS_QUERY="gfs:58n,60n,018e,022e|2,2|0,12|wind" \
  POLL_INTERVAL=30000 TIMEOUT=600000 \
  node scripts/saildocs-runner.js
```

| Variable         | Default                              | Description                          |
|------------------|--------------------------------------|--------------------------------------|
| `SAILDOCS_QUERY` | `gfs:58n,60n,018e,022e\|2,2\|0,12\|wind` | Saildocs query string               |
| `SAILDOCS_EMAIL` | `query@saildocs.com`                 | Saildocs query address               |
| `POLL_INTERVAL`  | `30000`                              | IMAP poll interval (ms)              |
| `TIMEOUT`        | `600000`                             | Overall timeout (ms, default 10 min) |

### Project Structure

```
.
├── plugin/
│   └── index.js          # Main plugin code with encoding/decoding
├── public/
│   ├── index.html        # Web interface
│   └── app.js            # Frontend logic
├── components/            # NoFlo flow-based components
│   ├── GribFetcher.js     # Saildocs GRIB request builder
│   ├── ImapFetcher.js     # IMAP polling for incoming emails
│   ├── SmtpResponder.js   # SMTP sender for replies & Saildocs requests
│   └── ...                # Auth, routing, InReach, etc.
├── lib/
│   ├── SmtpClient.js      # Minimal SMTP client (TLS, STARTTLS, AUTH PLAIN)
│   └── DbHelper.js        # SQLite state management
├── scripts/
│   ├── ping-pong-runner.js  # InReach PING→PONG live test
│   └── saildocs-runner.js   # Saildocs GRIB live test
├── test/                  # Unit and integration tests
└── package.json
```

### Dependencies

- `@reticulum/core`: Reticulum Ed25519 signing (for Winlink)
- `sharp`: Image compression to WebP
- `node:zlib`: Built-in zlib for compression
- `base64`: Built-in Node.js base64 encoding (Garmin-safe)

## License

EUPL-1.2

## References

- [SPEC.md](../SPEC.md) - Full system specification
- [references/lofi/](../references/lofi/) - Python reference implementation
- [references/garmin-character-counts.txt](../references/garmin-character-counts.txt) - Garmin character counting rules
## Scripts

### generate-dictionary

Generate a zlib dictionary from Markdown blog posts:

```bash
node scripts/generate-dictionary.js <blog-directory> [output-file]
```

Examples:
- Output to stdout: `node scripts/generate-dictionary.js ./blogposts`
- Write to file: `node scripts/generate-dictionary.js ./blogposts custom-dict.txt`

This script creates a dictionary containing:
- Front matter from all posts (title, date, tags, slug, etc.)
- Body content from all posts
- Common sailing/weather vocabulary

The dictionary is optional for BlogDecoder - it only improves compression when used.
