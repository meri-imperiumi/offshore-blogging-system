/**
 * InReachClient - Sends message replies via Garmin's InReach web endpoint.
 *
 * This ports the HTTP-POST reply flow from the two Python reference
 * implementations in `references/GRIB-via-inReach/main.py` (`inreachReply`)
 * and `references/MarineGRIB-InReach-Transmitter/src/inreach_functions.py`
 * (`_post_request_to_inreach`).
 *
 * Operational risk (flagged in `cloud.md` §InReachSender, not solved here):
 * Garmin does not publish this endpoint. It is the same authenticated web
 * session used by the Explore "reply" page and can change without notice, may
 * run against Garmin's terms of service, and the session cookie will expire on
 * an unspecified timeline. This client only makes the resulting failures
 * distinguishable; re-authentication / out-of-band alerting is a separate
 * concern.
 *
 * No third-party dependencies: uses the built-in `node:https` module, mirroring
 * the `lib/SmtpClient.js` over `node:net` pattern.
 */

const https = require("node:https");
const { URL } = require("node:url");

const DEFAULT_HEADERS = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
  origin: "https://explore.garmin.com",
  "x-requested-with": "XMLHttpRequest",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36",
};

const DEFAULT_COOKIES = {
  // The references set this; Garmin renders the desktop reply page for it.
  BrowsingMode: "Desktop",
};

/**
 * Distinguishable error type for InReach transmission failures.
 * `code` is one of: SESSION_EXPIRED | RATE_LIMITED | API_FAILURE |
 * NETWORK_ERROR | BAD_URL | NOT_CONFIGURED.
 */
class InReachError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "InReachError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Fresh 8-digit numeric MessageId per chunk, matching the newer reference
 * (MarineGRIB-InReach-Transmitter). Safer than reusing one id across chunks.
 */
function randomMessageId() {
  return String(Math.floor(Math.random() * 90000000) + 10000000);
}

/**
 * Extract the InReach conversation Guid from a Garmin reply URL.
 *
 * Garmin embeds it as the `extId` query parameter, e.g.
 * `https://explore.garmin.com/TextMessage/TxtMsg?extId=<GUID>&adr=...`.
 * Both Python references parse it via `url.split('extId=')[1].split('&adr')[0]`;
 * we prefer a real URL parse and fall back to that substring split for safety.
 */
function extractGuid(replyUrl) {
  if (!replyUrl || typeof replyUrl !== "string") {
    return null;
  }
  try {
    const parsed = new URL(replyUrl);
    const extId = parsed.searchParams.get("extId");
    if (extId) {
      return extId;
    }
  } catch {
    // Not a fully-qualified URL; fall through to legacy substring parse.
  }
  const match = replyUrl.match(/extId=([^&]+)/);
  return match ? match[1] : null;
}

function cookieHeader(cookies) {
  return Object.keys(cookies)
    .map((k) => `${k}=${cookies[k]}`)
    .join("; ");
}

/**
 * Heuristic for the scraper failure mode cloud.md explicitly calls out:
 * a 200 response carrying an HTML login/error page instead of the expected
 * plain-text acknowledgement. Garmin's real success response is a short
 * plain-text body; any HTML doctype or tag at the start of a trimmed body
 * is treated as a BAD_RESPONSE. Kept conservative (leading-whitespace
 * tolerant, not a full HTML parser) so a legitimate reply that happens to
 * contain a stray '<' deep in the text isn't misread as an error.
 */
function looksLikeHtmlErrorPage(text) {
  if (!text) {
    return false;
  }
  const head = text.slice(0, 500).toLowerCase();
  return /^\s*<!doctype html/.test(head) || /^\s*<html/.test(head);
}

/**
 * Default transport using node:https. Resolves to { status, text }.
 * Injectable via options.request for tests.
 */
function httpRequest(url, options) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new InReachError(`Invalid InReach URL: ${url}`, "BAD_URL"));
      return;
    }

    const body = options.body || "";
    const headers = Object.assign({}, options.headers || {});
    if (body) {
      headers["content-length"] = Buffer.byteLength(body);
    }

    const reqOptions = {
      method: options.method || "POST",
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      headers,
    };

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.setTimeout(options.timeout || 30000, () => {
      req.destroy(new Error("InReach request timed out"));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

class InReachClient {
  constructor(options = {}) {
    this.replyAddress = options.replyAddress || "";
    this.cookies = Object.assign({}, DEFAULT_COOKIES, options.cookies || {});
    this.headers = Object.assign({}, DEFAULT_HEADERS, options.headers || {});
    this.timeout = options.timeout || 30000;
    // Injectable transport for testing; defaults to the node:https impl.
    this.request = options.request || httpRequest;
  }

  /**
   * Send a single message to an InReach conversation by replying to the
   * Garmin URL that accompanied the original inbound message.
   *
   * @param {string} replyUrl - The Garmin Explore TextMessage URL.
   * @param {string} message - The message text to send.
   * @returns {Promise<{ ok: true, status: number }>}
   * @throws {InReachError} on failure, with a distinguishable `code`.
   */
  async send(replyUrl, message) {
    const guid = extractGuid(replyUrl);
    if (!guid) {
      throw new InReachError(
        `Could not extract InReach Guid from reply URL: ${replyUrl}`,
        "BAD_URL",
      );
    }

    if (!this.replyAddress) {
      throw new InReachError(
        "InReach reply address not configured",
        "NOT_CONFIGURED",
      );
    }

    const body = new URLSearchParams({
      ReplyAddress: this.replyAddress,
      ReplyMessage: message,
      MessageId: randomMessageId(),
      Guid: guid,
    }).toString();

    const response = await this.request(replyUrl, {
      method: "POST",
      headers: {
        ...this.headers,
        cookie: cookieHeader(this.cookies),
        referer: replyUrl,
      },
      body,
      timeout: this.timeout,
    });

    // A 200 alone is not success: scrapers' classic failure mode is 200
    // carrying an HTML login/error page. cloud.md explicitly elevates error
    // handling beyond what the Python references do (both only check == 200),
    // and a 200+HTML would otherwise be logged as success — the reply
    // vanishes silently, ErrorLogger records nothing, AlertComposer never
    // fires. Sniff the body for an HTML marker and reject if found.
    if (response.status >= 200 && response.status < 300) {
      const text = (response.text || "").trim();
      if (looksLikeHtmlErrorPage(text)) {
        throw new InReachError(
          `InReach reply rejected: 200 response with HTML body (likely a login/error page)`,
          "BAD_RESPONSE",
          response.status,
        );
      }
      return { ok: true, status: response.status };
    }

    // Distinguish failure modes per cloud.md InReachSender spec so the
    // eventual ErrorLogger output is actionable.
    let code;
    if (response.status === 401 || response.status === 403) {
      code = "SESSION_EXPIRED";
    } else if (response.status === 429) {
      code = "RATE_LIMITED";
    } else {
      code = "API_FAILURE";
    }

    const detail = (response.text || "").trim().slice(0, 200);
    throw new InReachError(
      `InReach reply rejected (HTTP ${response.status})${
        detail ? `: ${detail}` : ""
      }`,
      code,
      response.status,
    );
  }
}

InReachClient.extractGuid = extractGuid;
InReachClient.randomMessageId = randomMessageId;
InReachClient.InReachError = InReachError;

module.exports = InReachClient;
