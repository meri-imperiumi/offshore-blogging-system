# Offshore blogging system specification

On sailing vessel [Lille Ø](https://lille-oe.de) we have three layers of offshore communications systems, in decreasing level of bandwidth and fidelity:
1. Starlink Mini
2. Amateur HF radio with Vara HF modem and Pat/Winlink
3. InReach Mini 2

Our [daily offshore routine](https://handbook.lille-oe.de/checklists/02_daily_checks/) includes making a blog post and downloading the latest weather information via Grib. Until now we have done this mostly over Starlink, but as Starlink is making their service prohibitively expensive for cruisers starting in August 2026, we need to look for alternatives. Idea is a two-level system where radically compressed / lo-fi version happens offshore either over InReach or Garmin, and then the transfer of the hi-fi assets (like full-color pictures) can happen when we have access to shorebound LTE.

## Current blogging flow

- Blog posts are written in Markdown on personal mobile devices using Obsidian
  - User must rescale the images using the Obsidian convert/compress to prevent repository bloat
- Blog posts sync from mobile device to the boat server using Syncthing
- Boat server has an hourly cronjob (see `references/backup.sh`) that enriches blog posts with Signal K metadata (like the day's GPS track) and then pushes the post to the configured git remote (currently GitHub)
- GitHub runs a CI action to convert the site to HTML using Jekyll and publishes it on Github Pages

We additionally have a cloud VPS that can be used to automate things that require constant internet connection.

## Desired blogging flow

- Blog posts are written in Markdown on personal mobile devices using Obsidian
- Blog posts sync from mobile device to the boat server using Syncthing
- Boat server enriches blog posts with Signal K metadata (like the day's GPS track) and downscales images and converts them to WebP (updating Markdown reference accordingly)
- Boat server commits the blog post and associated files to a git repository for eventual sync when on full internet connectivity via the configured git remote(s)
- User can access a web page (hosted via a Signal K plugin) where there are severalversions of the blog post available for copy-paste. Each of these should show thee required transmit resources (InReach message count or estimated Winlink transmit time):
  1. Blog post without images, encoded and prepared for transmission via InReach
  2. Blog post with image(s), encoded and prepared for transmission via InReach
  3. Blog post with images, signed and prepared for transmission via Winlink/pat
- User can then send the encoded blog post via either InReach or Winlink
  - For InReach we need to field-test whether one message that InReach Messenger splits into chunks, or pre-producing message chunks and copying individually is more reliable
- Our cloud server receives the blog post via email (IMAP Idle?)
  - Client needs to issue a periodic `NOOP` or refresh the `IDLE` command every 15–20 minutes, with automatic exponential backoff reconnection logic on socket drop
- Cloud server verifies the sender identity (verifying Winlink email signature or Garmin email sender phone number and DMARC). If this doesn't match expectation, the email is dropped (and user notified of the spoofing attempt)
- For chunked InReach messages, if a chunk is missing within 15 minutes of transmission start, the server process sends a message to notify user of the missing chunk(s) and to request them
  - Chunks should be persisted on server so that reassembly is possible even after a server crash or restart
  - Never publish a partially/corruptly reassembled post, only a fully verified one
- The server then writes the blog post and attachments to the git repository. This needs consistent file naming to ensure multiple email reads don't end up with duplicate posts (as well as to ensure the hi-fi version eventually overrides the files)
- The server overlays a small watermark/banner on lo-fi images before committing (e.g. 'lo-fi preview via radio') so a viewer never mistakes a blurry placeholder for the final photo
- The cloud server also periodically tries to sync the repository via the configured git remote(s) (works when boat has full internet) to get the hi-fi assets
  - This needs to be done so that the hi-fi assets override the lo-fi versions (likely `-X theirs` merge strategy)
  - The specific transport mechanism (e.g., rngit) is an implementation detail
- When there is new content to push, the cloud server pushes it to the configured git remote (currently GitHub)
- GitHub runs a CI action to convert the site to HTML using Jekyll and publishes it on Github Pages
- Cloud server sends a confirmation message back to user telling that the blog post has been published (including post name and metadata to identify it)

There is an initial Python sketch for parts of this flow in `references/lofi` that can be used for inspiration.

## Desired weather flow

Winlink has a good built-in weather fetching flow using [Saildocs](http://www.saildocs.com/) so we don't need to work on that here. However, we need a system that works over InReach.

- User sends a weather request over InReach message
- Cloud server receives this and verifies sender identity similarly to blog posts
- For simple requests, we utilize user's current location (received via InReach tracking, AIS, or Winlink position report), fetch latest ECMWF grib data and produce the requested subset and send it to user directly
- For more complex requests, we send it onwards to Saildocs and then send to user
- For requests that produce over 10 messages, we first send user a message telling the transmit size and wait for a YES/NO response before transmitting
- User copy-pastes the individual messages into a web interface in the Signal K plugin to construct the full Grib transmission. This is then made available to other Signal K plugins, as well as for the user to download (for visualization in programs like LuckGrib)

There are pre-existing tools for this flow that we can use as reference/inspiration. See `references/GRIB-via-inReach/` and the more advanced `references/MarineGRIB-InReach-Transmitter/`.

## Technology stack

Client devices do not need any additonal software. Obsidian, Syncthing, Garmin Messenger, and LuckGrib should be enough.

Boat server software can be written as shell script, or alternatively using NoFlo like the Cloud server software.

Signal K plugin will be written in JavaScript. The server-side will run on Node.js, and the user interface in browser.

Cloud server software should be implemented in NoFlo using the noflo-assembly library.

All parts of the system should reside in this repository.

### License compatibility

All components or libraries used for this system need to be compatible with EUPL-1.2.
In general we should aim to reduce 3rd party dependencies.

### Test automation

We aim for good test coverage. Tests should be written using the `node:test` framework and executed in Node.js.

### Email access

Since both Winlink and InReach require email usage, we will utilize an IMAP mailbox hosted on mailbox.org for this purpose. Mailbox also offers an SMTP server.

### Email signatures

Emails sent via Winlink need to contain a cryptographic signature (produced in the Signal K plugin and checked by the cloud server process). We will use Reticulum Ed25519 identities for this signature:

```
Subject: Blog Post via Vara HF

---BEGIN RETICULUM METADATA---
IdentityHash: 4a3fbc912d...
Algorithm: Ed25519
Sig: MEQCID9h...[base64-bytes]...==
---END RETICULUM METADATA---

---BEGIN BLOG POST---
Sailing downwind, testing the node-based editor updates over the air. Packet integrity looks solid.
---END BLOG POST---
```

Identity hash should be also compared to [Dacar](https://github.com/bergie/dacar) grants to verify user has permission to publish blogs.

### Garmin character counts

Garmin InReach uses a somewhat peculiar way to count characters in message lengths. See `references/garmin-character-counts.txt`
