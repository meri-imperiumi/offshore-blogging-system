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
 * URL formats:
 *   - Legacy:  https://explore.garmin.com/TextMessage/TxtMsg?extId=<GUID>&adr=...
 *   - Current: https://inreachlink.com/<code>   (a 301 share link)
 *
 * The `inreachlink.com` share code IS the `extId` (a 301 GET redirects to
 * `https://eur.explore.garmin.com/textmessage/txtmsg?extId=<code>`), so we
 * can construct the reply-page URL directly without hitting inreachlink.com
 * (avoiding its Cloudflare rate-limiting).
 *
 * Reply flow:
 *   1. GET the reply-page URL → HTML form with server-populated Guid and
 *      MessageId hidden inputs.
 *   2. POST the form with ReplyAddress, ReplyMessage, and the extracted
 *      Guid + MessageId.
 *
 * The server-provided Guid/MessageId are preferred over guessing: Garmin's
 * page generates them, and using the form's values mirrors what a browser
 * submits. If the GET or parse fails, we fall back to the extId as Guid and a
 * random MessageId (the Python references' approach).
 *
 * No third-party dependencies: uses the built-in `node:https` module.
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
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  // Browser-client hints and fetch metadata. The Python references send
  // these and Cloudflare's bot detection expects them on XHR/fetch POSTs.
  "sec-ch-ua":
    '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

// Headers used when GETting the reply page (a navigation, not XHR).
// Cloudflare fronts the host and is hostile to bare/non-browser clients, so
// present as a browser doing a normal navigation GET.
const BROWSER_HEADERS = {
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "sec-ch-ua":
    '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

const DEFAULT_COOKIES = {
  // The references set this; Garmin renders the desktop reply page for it.
  BrowsingMode: "Desktop",
};

/**
 * Default reply-page endpoint that InReach share URLs redirect to. A plain
 * GET of `https://inreachlink.com/<code>` returns a 301 to
 * `https://eur.explore.garmin.com/textmessage/txtmsg?extId=<code>`. We GET/POST
 * this base URL with `?extId=<code>` appended. Override per instance via
 * `options.replyEndpoint` if a different region is required.
 */
const DEFAULT_REPLY_ENDPOINT =
  "https://eur.explore.garmin.com/textmessage/txtmsg";

const MAX_REDIRECTS = 5;

/**
 * Retry settings for Cloudflare-protected requests. The Garmin Explore
 * endpoint sits behind Cloudflare, which may temporarily rate-limit (429) or
 * return transient 5xx errors. We retry with exponential backoff, honoring
 * the `Retry-After` header when present.
 */
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
// Cap a single backoff so a huge Retry-After can't stall the system for long.
const MAX_BACKOFF_MS = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HTTP status codes worth retrying: Cloudflare rate-limit (429) and the
 * transient 5xx errors it can emit during maintenance/overload.
 */
function isRetryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Whether a thrown error is transient enough to retry. Raw network errors
 * (ECONNRESET, ETIMEDOUT, …) and InReachError NETWORK_ERROR qualify.
 * A BAD_URL or NOT_CONFIGURED error does not — retrying won't fix it.
 */
function isRetryableError(err) {
  if (!err) {
    return false;
  }
  if (err instanceof InReachError) {
    return err.code === "NETWORK_ERROR";
  }
  return true;
}

/**
 * Parse a `Retry-After` header (seconds or HTTP-date) into a delay in ms.
 * Falls back to `fallbackMs` when absent or unparseable, capped at
 * MAX_BACKOFF_MS so a hostile value can't stall the pipeline.
 */
function parseRetryAfter(header, fallbackMs) {
  if (header && typeof header === "string") {
    const trimmed = header.trim();
    // Numeric form: seconds
    if (/^\d+$/.test(trimmed)) {
      return Math.min(parseInt(trimmed, 10) * 1000, MAX_BACKOFF_MS);
    }
    // HTTP-date form
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) {
      return Math.min(Math.max(0, date.getTime() - Date.now()), MAX_BACKOFF_MS);
    }
  }
  return Math.min(fallbackMs, MAX_BACKOFF_MS);
}

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
 * Used only as a fallback when the server-provided MessageId can't be read.
 */
function randomMessageId() {
  return String(Math.floor(Math.random() * 90000000) + 10000000);
}

/**
 * Whether a reply URL is a new-format `inreachlink.com/<code>` share URL.
 * The share code uses base64url characters (A-Za-z0-9_-) and is the extId.
 */
function isShareUrl(url) {
  return /^https?:\/\/(www\.)?inreachlink\.com\//i.test(url || "");
}

/**
 * Extract the share code from an `inreachlink.com/<code>` URL — the path
 * segment after the host. This code is the conversation `extId`.
 */
function extractShareCode(replyUrl) {
  if (!replyUrl || typeof replyUrl !== "string") {
    return null;
  }
  const match = replyUrl.match(/inreachlink\.com\/([A-Za-z0-9_-]+)/i);
  return match ? match[1] : null;
}

/**
 * Extract the InReach conversation Guid from a Garmin reply URL.
 *
 * Handles both formats:
 *   - Legacy:  `https://explore.garmin.com/TextMessage/TxtMsg?extId=<GUID>&adr=...`
 *   - Current: `https://inreachlink.com/<code>`  (the code IS the extId)
 *
 * For the legacy URL we parse the `extId` query parameter (with a substring
 * fallback matching the Python references). For the share URL we return the
 * path code directly. This is a fallback used only when the server-provided
 * Guid can't be read from the reply page's HTML form.
 */
function extractGuid(replyUrl) {
  if (!replyUrl || typeof replyUrl !== "string") {
    return null;
  }
  // New format: the share code is the extId.
  const shareCode = extractShareCode(replyUrl);
  if (shareCode) {
    return shareCode;
  }
  // Legacy format: extId query parameter.
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
 * Extract the value of a named form field from an HTML page.
 *
 * Handles `<input name="Guid" value="...">` in either attribute order,
 * with single or double quotes. Returns null if not found. This is a
 * conservative regex parse (no DOM dependency) sufficient for Garmin's
 * hidden-input form fields.
 */
function parseFormField(html, name) {
  if (!html) {
    return null;
  }
  // name="X" ... value="Y"
  const re1 = new RegExp(
    `<input[^>]*\\bname=["']${name}["'][^>]*\\bvalue=["']([^"']*)["']`,
    "i",
  );
  const m1 = html.match(re1);
  if (m1) {
    return m1[1];
  }
  // value="Y" ... name="X"
  const re2 = new RegExp(
    `<input[^>]*\\bvalue=["']([^"']*)["'][^>]*\\bname=["']${name}["']`,
    "i",
  );
  const m2 = html.match(re2);
  return m2 ? m2[1] : null;
}

/**
 * Default transport using node:https. Resolves to { status, text }.
 * Injectable via options.request for tests. Used for both GET (fetch page)
 * and POST (send reply).
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
      // Follow 3xx redirects (for GETs that may bounce between hosts).
      if (
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location &&
        (options.method || "POST") === "GET"
      ) {
        const next = new URL(res.headers.location, url).toString();
        res.resume(); // drain
        const depth = (options._redirectDepth || 0) + 1;
        if (depth > MAX_REDIRECTS) {
          reject(
            new InReachError(
              "Too many redirects fetching reply page",
              "BAD_URL",
            ),
          );
          return;
        }
        resolve(httpRequest(next, { ...options, _redirectDepth: depth }));
        return;
      }
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          text: Buffer.concat(chunks).toString("utf8"),
          headers: res.headers,
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

/**
 * Retry a transport call on transient Cloudflare/network failures, with
 * exponential backoff. Honors the `Retry-After` header on 429 responses.
 *
 * - On success or a non-retryable status (e.g. 200, 404): returns the
 *   response immediately.
 * - On a retryable status (429/502/503/504): waits and retries; after
 *   exhausting retries returns the last response so the caller can decide
 *   (e.g. treat 429 as RATE_LIMITED, or fall back for a best-effort GET).
 * - On a retryable network error: waits and retries; after exhausting
 *   retries re-throws the last error.
 * - On a non-retryable error (BAD_URL etc.): re-throws immediately.
 */
async function requestWithRetry(request, url, options, settings = {}) {
  const maxRetries = settings.maxRetries ?? DEFAULT_MAX_RETRIES;
  const initialBackoff =
    settings.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  let lastResponse;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      lastError = null;
      lastResponse = await request(url, options);
      if (isRetryableStatus(lastResponse.status) && attempt < maxRetries) {
        const retryAfter = parseRetryAfter(
          lastResponse.headers && lastResponse.headers["retry-after"],
          initialBackoff * 2 ** attempt,
        );
        await sleep(retryAfter);
        continue;
      }
      return lastResponse;
    } catch (err) {
      lastError = err;
      lastResponse = null;
      if (isRetryableError(err) && attempt < maxRetries) {
        await sleep(initialBackoff * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  // Retries exhausted.
  if (lastError) {
    throw lastError;
  }
  return lastResponse;
}

class InReachClient {
  constructor(options = {}) {
    this.replyAddress = options.replyAddress || "";
    this.cookies = Object.assign({}, DEFAULT_COOKIES, options.cookies || {});
    this.headers = Object.assign({}, DEFAULT_HEADERS, options.headers || {});
    this.timeout = options.timeout || 30000;
    // Base URL to GET/POST when the replyUrl is an inreachlink.com share URL.
    // The extId is appended as a query parameter.
    this.replyEndpoint = options.replyEndpoint || DEFAULT_REPLY_ENDPOINT;
    // Injectable transport for testing; defaults to the node:https impl.
    this.request = options.request || httpRequest;
    // Cache of server-provided form values per reply URL, so multi-chunk
    // sends to the same conversation only fetch the reply page once
    // (minimizing Cloudflare-protected requests).
    this.formCache = options.formCache || new Map();
    // Retry/backoff for Cloudflare-protected requests.
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.initialBackoffMs =
      options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  }

  /**
   * Retry settings object for requestWithRetry, derived from instance config.
   */
  get retrySettings() {
    return {
      maxRetries: this.maxRetries,
      initialBackoffMs: this.initialBackoffMs,
    };
  }

  /**
   * Run a transport call with retry/backoff.
   */
  retry(url, options) {
    return requestWithRetry(this.request, url, options, this.retrySettings);
  }

  /**
   * Resolve the URL to GET (and then POST to) for a given reply URL.
   *
   * - Direct `explore.garmin.com` URL → used as-is.
   * - `inreachlink.com/<code>` share URL → the code is the extId; we build
   *   `${replyEndpoint}?extId=<code>` so no HTTP round-trip to
   *   inreachlink.com (and no Cloudflare dependency) is needed.
   */
  resolvePageUrl(replyUrl) {
    if (isShareUrl(replyUrl)) {
      const code = extractShareCode(replyUrl);
      if (!code) {
        return null;
      }
      return `${this.replyEndpoint}?extId=${encodeURIComponent(code)}`;
    }
    return replyUrl;
  }

  /**
   * GET the reply page and parse the server-provided Guid and MessageId
   * from its HTML form. These are the values a browser would submit.
   *
   * Returns { guid, messageId } or null if the page can't be fetched/parsed
   * (the caller falls back to the extId + a random MessageId).
   */
  async fetchFormValues(pageUrl) {
    let response;
    try {
      response = await this.retry(pageUrl, {
        method: "GET",
        headers: {
          ...BROWSER_HEADERS,
          cookie: cookieHeader(this.cookies),
        },
        timeout: this.timeout,
      });
    } catch (err) {
      // Network/transport error fetching the page — fall back to extId.
      return null;
    }
    if (response.status < 200 || response.status >= 300) {
      return null;
    }
    const html = response.text || "";
    const guid = parseFormField(html, "Guid");
    const messageId = parseFormField(html, "MessageId");
    if (!guid && !messageId) {
      return null;
    }
    return { guid, messageId };
  }

  /**
   * Send a single message to an InReach conversation by replying to the
   * Garmin URL that accompanied the original inbound message.
   *
   * @param {string} replyUrl - The Garmin Explore TextMessage URL, or an
   *   `inreachlink.com` share URL whose path code is the extId.
   * @param {string} message - The message text to send.
   * @returns {Promise<{ ok: true, status: number }>}
   * @throws {InReachError} on failure, with a distinguishable `code`.
   */
  async send(replyUrl, message) {
    const pageUrl = this.resolvePageUrl(replyUrl);
    if (!pageUrl) {
      throw new InReachError(
        `Could not resolve InReach reply URL: ${replyUrl}`,
        "BAD_URL",
      );
    }

    if (!this.replyAddress) {
      throw new InReachError(
        "InReach reply address not configured",
        "NOT_CONFIGURED",
      );
    }

    // For share URLs (new format), try to read the server-provided Guid and
    // MessageId from the reply page's HTML form. This is a best-effort GET
    // to a Cloudflare-protected host: if it fails (rate-limited, network
    // error, non-HTML response), we fall back to the extId + a random
    // MessageId so the reply still goes through. Results are cached per
    // reply URL so multi-chunk sends only fetch once per conversation.
    //
    // For legacy explore.garmin.com URLs we skip the fetch entirely — the
    // extId is in the URL and the Python references use a random MessageId.
    const fallbackGuid = extractGuid(replyUrl);
    if (!fallbackGuid) {
      throw new InReachError(
        `Could not extract InReach Guid from reply URL: ${replyUrl}`,
        "BAD_URL",
      );
    }
    let formValues = null;
    if (isShareUrl(replyUrl)) {
      const cached = this.formCache.get(replyUrl);
      if (cached) {
        formValues = cached;
      } else {
        formValues = await this.fetchFormValues(pageUrl);
        if (formValues) {
          this.formCache.set(replyUrl, formValues);
        }
      }
    }
    const guid = (formValues && formValues.guid) || fallbackGuid;
    const messageId = (formValues && formValues.messageId) || randomMessageId();

    // Origin must match the reply endpoint's host or Garmin may reject the
    // cross-origin POST (the new endpoint lives on eur.explore.garmin.com).
    const origin = (() => {
      try {
        const u = new URL(pageUrl);
        return `${u.protocol}//${u.host}`;
      } catch {
        return this.headers.origin;
      }
    })();

    const body = new URLSearchParams({
      ReplyAddress: this.replyAddress,
      ReplyMessage: message,
      MessageId: messageId,
      Guid: guid,
    }).toString();

    const response = await this.retry(pageUrl, {
      method: "POST",
      headers: {
        ...this.headers,
        origin,
        cookie: cookieHeader(this.cookies),
        referer: pageUrl,
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
InReachClient.extractShareCode = extractShareCode;
InReachClient.isShareUrl = isShareUrl;
InReachClient.isRetryableStatus = isRetryableStatus;
InReachClient.isRetryableError = isRetryableError;
InReachClient.parseRetryAfter = parseRetryAfter;
InReachClient.requestWithRetry = requestWithRetry;
InReachClient.parseFormField = parseFormField;
InReachClient.randomMessageId = randomMessageId;
InReachClient.InReachError = InReachError;

module.exports = InReachClient;
