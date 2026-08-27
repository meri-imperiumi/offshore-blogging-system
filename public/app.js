// Offshore Blogging UI

class OffshoreBloggingUI {
  constructor() {
    this.currentEncodeResult = null;
    this.currentPreviews = null;
    this.chunks = [];
    this.modeBackoff = 1000;
    // Messages the user has already copied, so we can mark them and make it
    // easier to keep track of what has been sent. Persisted in localStorage so
    // the markers survive page reloads (e.g. if the server requests a chunk
    // again later). Keyed by the exact message string.
    this.copiedMessages = this.loadCopiedMessages();
    this.initTabs();
    this.initBlogTab();
    this.initWeatherTab();
    this.initDecodeTab();
    this.initEnvironmentMode();
    this.checkStatus();
  }

  loadCopiedMessages() {
    try {
      const stored = localStorage.getItem("offshore-blogging:copied");
      return new Set(stored ? JSON.parse(stored) : []);
    } catch {
      return new Set();
    }
  }

  saveCopiedMessages() {
    try {
      localStorage.setItem(
        "offshore-blogging:copied",
        JSON.stringify([...this.copiedMessages]),
      );
    } catch {
      // localStorage may be unavailable (private mode, etc.) - keep in-memory
    }
  }

  /**
   * Load persisted weather-route settings (destination + margin + whether
   * route mode is enabled). The boat's own position isn't persisted — it's
   * read fresh from Signal K on each rebuild.
   */
  loadWeatherRoute() {
    try {
      const stored = localStorage.getItem("offshore-blogging:weather-route");
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  }

  /**
   * Persist the current weather-route settings so they survive a page
   * reload. Reads the live DOM values rather than taking args so callers
   * can fire it on any input event without building the object themselves.
   */
  saveWeatherRoute() {
    try {
      const routeToggle = document.getElementById("weatherRouteToggle");
      const destLat = document.getElementById("weatherDestLat");
      const destLon = document.getElementById("weatherDestLon");
      const margin = document.getElementById("weatherMargin");
      localStorage.setItem(
        "offshore-blogging:weather-route",
        JSON.stringify({
          enabled: routeToggle ? routeToggle.checked : false,
          destLat: destLat ? destLat.value : "",
          destLon: destLon ? destLon.value : "",
          margin: margin ? margin.value : "",
        }),
      );
    } catch {
      // localStorage may be unavailable (private mode, etc.) - skip
    }
  }

  markCopied(text) {
    this.copiedMessages.add(text);
    this.saveCopiedMessages();
  }

  initTabs() {
    const tabs = document.querySelectorAll(".tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        document
          .querySelectorAll(".tab")
          .forEach((t) => void t.classList.remove("active"));
        document
          .querySelectorAll(".tab-content")
          .forEach((c) => void c.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById(tab.dataset.tab).classList.add("active");
      });
    });
  }

  initBlogTab() {
    // Set filename and postid to today's date
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const todayStr = `${yyyy}-${mm}-${dd}`;
    const todayPostid = `${mm}${dd}`;

    const filenameInput = document.getElementById("filename");
    const postidInput = document.getElementById("postid");
    const imageBudgetInput = document.getElementById("imageBudget");

    if (filenameInput) {
      filenameInput.value = todayStr;
    }
    if (postidInput) {
      postidInput.value = todayPostid;
    }
    // Apply default image budget from plugin config (fetched via /api/status)
    if (imageBudgetInput && this.status?.defaultImageBudget) {
      imageBudgetInput.value = this.status.defaultImageBudget;
    }

    // Update postid when filename changes
    if (filenameInput && postidInput) {
      filenameInput.addEventListener("input", () => {
        const filename = filenameInput.value.trim();
        const match = filename.match(/(\d{4}-\d{2}-\d{2})(?:_(\d{3}))?/);
        if (match) {
          const datePart = match[1];
          const suffix = match[2];
          const monthDay = datePart.slice(5).replace(/-/g, "");
          postidInput.value = suffix ? monthDay + suffix.slice(-1) : monthDay;
        }
      });
    }

    document
      .getElementById("encodeBtn")
      .addEventListener("click", () => this.encodeBlogPost());
  }

  initWeatherTab() {
    const preset = document.getElementById("weatherPreset");
    const routeToggle = document.getElementById("weatherRouteToggle");
    const routeFields = document.getElementById("weatherRouteFields");
    const destLat = document.getElementById("weatherDestLat");
    const destLon = document.getElementById("weatherDestLon");
    const margin = document.getElementById("weatherMargin");

    // Restore persisted route settings (destination + margin + toggle) so a
    // page reload doesn't lose the destination the user already entered.
    // The boat's own position isn't persisted — it's read fresh from Signal K.
    const saved = this.loadWeatherRoute();
    if (saved.destLat != null && destLat) destLat.value = saved.destLat;
    if (saved.destLon != null && destLon) destLon.value = saved.destLon;
    if (saved.margin != null && margin) margin.value = saved.margin;
    if (routeToggle) {
      routeToggle.checked = !!saved.enabled;
      if (routeFields) {
        routeFields.style.display = routeToggle.checked ? "block" : "none";
      }
    }

    // Rebuild the Saildocs request whenever any input that affects it
    // changes: the preset (always), or the destination/margin (only in
    // route mode). getBoatPosition() caches, so calling on every keystroke
    // is cheap.
    preset.addEventListener("change", () => this.rebuildWeatherRequest());

    if (routeToggle) {
      routeToggle.addEventListener("change", () => {
        if (routeFields) {
          routeFields.style.display = routeToggle.checked ? "block" : "none";
        }
        this.saveWeatherRoute();
        this.rebuildWeatherRequest();
      });
    }
    [destLat, destLon, margin].forEach((el) => {
      if (el) {
        el.addEventListener("input", () => {
          this.saveWeatherRoute();
          this.rebuildWeatherRequest();
        });
      }
    });

    document
      .getElementById("weatherBtn")
      .addEventListener("click", () => this.generateWeatherRequest());
  }

  initDecodeTab() {
    document
      .getElementById("addChunkBtn")
      .addEventListener("click", () => this.addChunk());
    document.getElementById("chunkInput").addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        this.addChunk();
      }
    });
    document
      .getElementById("reassembleBtn")
      .addEventListener("click", () => this.reassembleChunks());
    document
      .getElementById("clearChunksBtn")
      .addEventListener("click", () => this.clearChunks());

    // Upload a complete GRIB file (Winlink/Saildocs path) directly to the
    // server-side store so signalk-grib-weather-provider can ingest it.
    document
      .getElementById("uploadGribBtn")
      .addEventListener("click", () => this.uploadGrib());

    // Populate the shared, latest-first list of persisted GRIBs.
    this.loadStoredGribs();
  }

  /**
   * Keep the day/night theme in sync with the vessel's environment mode.
   * The stylesheet reacts to data-mode on the root <html> element (night is
   * the hardcoded safe default for page load and for servers without the
   * path). Plugin webapps are standalone pages, so the "host" applying the
   * attribute is this page itself: read the initial mode via REST, then
   * passively follow the vessels.self.environment.mode delta over a
   * throttled WebSocket subscription (the mode flips at most a couple of
   * times a day, so a high minRate keeps the client quiet).
   */
  initEnvironmentMode() {
    // Only meaningful in a real browser (guards the vm sandbox used by the
    // smoketests, where WebSocket/location don't exist).
    if (typeof WebSocket === "undefined" || typeof location === "undefined") {
      return;
    }
    this.fetchInitialEnvironmentMode();
    this.connectModeStream();
  }

  /**
   * Apply a mode value to the root element. Unknown values (null, missing
   * path, twilight...) leave the current mode untouched.
   */
  applyEnvironmentMode(mode) {
    if (mode !== "day" && mode !== "night") return;
    document.documentElement.dataset.mode = mode;
  }

  async fetchInitialEnvironmentMode() {
    try {
      const response = await fetch(
        "/signalk/v1/api/vessels/self/environment/mode",
      );
      if (!response.ok) return;
      const data = await response.json();
      this.applyEnvironmentMode((data && data.value) || data);
    } catch {
      // Server unreachable or path absent - keep the night default
    }
  }

  connectModeStream() {
    let socket;
    try {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(
        `${scheme}://${location.host}/signalk/v1/stream?subscribe=none`,
      );
    } catch {
      this.scheduleModeReconnect();
      return;
    }
    socket.addEventListener("open", () => {
      // Connection established - reset the reconnect backoff.
      this.modeBackoff = 1000;
      socket.send(
        JSON.stringify({
          context: "vessels.self",
          subscribe: [{ path: "environment.mode", minRate: 60000 }],
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      let delta;
      try {
        delta = JSON.parse(event.data);
      } catch {
        return;
      }
      for (const update of delta.updates || []) {
        for (const value of update.values || []) {
          if (value.path === "environment.mode") {
            this.applyEnvironmentMode(value.value);
          }
        }
      }
    });
    socket.addEventListener("close", () => this.scheduleModeReconnect());
    socket.addEventListener("error", () => socket.close());
  }

  /**
   * Reconnect with exponential backoff (1s doubling, capped at 30s) so a
   * server restart or network dropout doesn't hammer the connection. The
   * last applied mode simply stays in effect while offline.
   */
  scheduleModeReconnect() {
    if (this.modeReconnectTimer) return;
    const delay = this.modeBackoff;
    this.modeBackoff = Math.min(delay * 2, 30000);
    this.modeReconnectTimer = setTimeout(() => {
      this.modeReconnectTimer = null;
      this.connectModeStream();
    }, delay);
  }

  // Fetch feature flags from the plugin so opt-in features (like blog
  // encoding) can be hidden when not enabled.
  async checkStatus() {
    try {
      const response = await fetch(
        "/plugins/signalk-offshore-blogging/api/status",
      );
      this.status = await response.json();
    } catch {
      this.status = {};
    }

    // Apply default image budget if the blog tab is present
    const imageBudgetInput = document.getElementById("imageBudget");
    if (imageBudgetInput && this.status.defaultImageBudget) {
      imageBudgetInput.value = this.status.defaultImageBudget;
    }

    if (!this.status.blogEnabled) {
      this.disableBlogTab();
    }
  }

  disableBlogTab() {
    const blogTab = document.querySelector('.tab[data-tab="blog"]');
    const blogContent = document.getElementById("blog");
    if (blogTab) {
      blogTab.style.display = "none";
    }
    if (blogContent) {
      blogContent.classList.remove("active");
    }
    // Blog is the default active tab - switch to weather so the user isn't
    // left looking at an empty page.
    if (blogTab?.classList.contains("active")) {
      blogTab.classList.remove("active");
      const weatherTab = document.querySelector('.tab[data-tab="weather"]');
      const weatherContent = document.getElementById("weather");
      weatherTab?.classList.add("active");
      weatherContent?.classList.add("active");
    }
  }

  showError(message) {
    const results = document.getElementById("encodeResults");
    let errorDiv = results.querySelector(".error");
    if (errorDiv) {
      errorDiv.textContent = message;
    } else {
      errorDiv = document.createElement("div");
      errorDiv.className = "error";
      errorDiv.textContent = message;
      results.insertBefore(errorDiv, results.firstChild);
    }
    results.style.display = "block";
  }

  showSuccess(message) {
    const results = document.getElementById("encodeResults");
    let successDiv = results.querySelector(".success");
    if (successDiv) {
      successDiv.textContent = message;
    } else {
      successDiv = document.createElement("div");
      successDiv.className = "success";
      successDiv.textContent = message;
      results.insertBefore(successDiv, results.firstChild);
    }
    results.style.display = "block";
  }

  async encodeBlogPost() {
    const filename = document.getElementById("filename").value.trim();
    const postid = document.getElementById("postid").value.trim() || null;
    const imageBudget = parseInt(
      document.getElementById("imageBudget").value,
      10,
    );

    if (!filename) {
      this.showError("Filename is required");
      return;
    }

    const btn = document.getElementById("encodeBtn");
    btn.disabled = true;
    btn.textContent = "Encoding...";

    try {
      // First, get image previews
      const previewResponse = await fetch(
        "/plugins/signalk-offshore-blogging/api/preview-images",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename, imageBudget }),
        },
      );

      const previewData = await previewResponse.json();

      // Then encode full post (with all images)
      const encodeResponse = await fetch(
        "/plugins/signalk-offshore-blogging/api/encode",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename,
            postid: postid || undefined,
            imageBudget,
          }),
        },
      );

      const data = await encodeResponse.json();

      if (!encodeResponse.ok) {
        throw new Error(data.error || "Encoding failed");
      }

      this.currentEncodeResult = data;
      this.currentPreviews = previewData.previews;
      this.showEncodeResults(data, previewData);
    } catch (error) {
      this.showError(error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Encode Post";
    }
  }

  escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  escapeForAttribute(str) {
    return str.replace(/'/g, "\\'").replace(/\\/g, "\\\\");
  }

  /**
   * Build the InReach message the user sends to the cloud for a weather
   * request. Pure (no DOM) so it's testable in a vm sandbox.
   *
   * Wraps a bare Saildocs query as `send query@saildocs.com:<query>` so the
   * message is a complete, self-documenting command (matching cloud.md
   * §GribFetcher and the runner example). Leaves an explicit `send ...`
   * command unchanged so the user can override the Saildocs address.
   */
  static buildWeatherMessage(request) {
    if (/^send\s/i.test(request)) {
      return request;
    }
    return `send query@saildocs.com:${request}`;
  }

  showEncodeResults(data, previewData) {
    const resultsDiv = document.getElementById("encodeResults");
    resultsDiv.style.display = "block";
    document.getElementById("statMessages").textContent = data.totalMessages;
    document.getElementById("statTextMessages").textContent =
      data.textMessages.length;
    document.getElementById("statImageMessages").textContent =
      data.imageMessages.length;

    // Remove any existing messages, method sections, and image preview sections
    resultsDiv
      .querySelectorAll(
        ".info, .error, .success, .image-preview-section, .method-section",
      )
      .forEach((el) => void el.remove());

    // Show image previews if available
    if (previewData?.previews && previewData.previews.length > 0) {
      const section = document.createElement("div");
      section.className = "card image-preview-section";
      section.innerHTML = "<h3>Compressed Image Previews</h3>";

      previewData.previews.forEach((preview, idx) => {
        const wrapper = document.createElement("div");
        wrapper.className = "preview-item";

        const isError = preview.error !== undefined;

        wrapper.innerHTML = `
          <p class="preview-title">
            <strong>Image ${idx + 1}: ${preview.alt || "(no alt text)"}</strong>
            ${isError ? ` <span class="preview-error">(Error: ${preview.error})</span>` : ""}
          </p>
          ${
            !isError
              ? `
            <img src="data:image/webp;base64,${preview.base64}"
                 alt="Compressed preview">
            <p class="preview-meta">
              <strong>Size:</strong> ${preview.width}x${preview.height}px |
              <strong>Quality:</strong> ${preview.quality}% |
              <strong>Compressed:</strong> ${preview.compressedSize} bytes
            </p>
          `
              : ""
          }
        `;
        section.appendChild(wrapper);
      });

      resultsDiv.appendChild(section);
    }

    // Show summary
    const summary = document.createElement("div");
    summary.className = "info";
    if (data.foundImages > 0) {
      summary.textContent = `Found ${data.foundImages} image(s). Choose transmission method below:`;
    } else {
      summary.textContent =
        "No images found in this post. Choose transmission method below:";
    }
    resultsDiv.insertBefore(summary, resultsDiv.firstChild);

    // Create transmission method selector
    const methodSection = document.createElement("div");
    methodSection.className = "card method-section";
    methodSection.innerHTML = "<h3>Transmission Method</h3>";

    const methodsDiv = document.createElement("div");
    methodsDiv.innerHTML = `
      <div class="version-selector">
        <button class="version-btn active" data-version="text">Text Only (InReach)</button>
        <button class="version-btn" data-version="image">Text + Image (InReach)</button>
        <button class="version-btn" data-version="winlink">Winlink (Signed)</button>
      </div>
      <div id="messagesContainer" class="message-list"></div>
    `;

    resultsDiv.appendChild(methodsDiv);

    // Set up version buttons
    const versionBtns = methodsDiv.querySelectorAll(".version-btn");
    versionBtns.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        versionBtns.forEach((b) => void b.classList.remove("active"));
        btn.classList.add("active");
        this.renderMessages(btn.dataset.version);
        e.stopPropagation();
      });
    });

    // Render with default (text-only) version
    this.renderMessages("text");
  }

  renderMessages(version) {
    const list = document.getElementById("messagesContainer");
    if (!list) return;
    list.innerHTML = "";

    if (version === "winlink") {
      if (!this.currentEncodeResult.winlink) {
        list.innerHTML = '<div class="error">Winlink data not available</div>';
        return;
      }
      if (this.currentEncodeResult.winlink.error) {
        list.innerHTML = `<div class="error">Winlink unavailable: ${this.escapeHtml(this.currentEncodeResult.winlink.error)}</div>`;
        return;
      }
      const winlinkData = this.currentEncodeResult.winlink;
      const metaCopied = this.copiedMessages.has(winlinkData.metadata);
      const contentCopied = this.copiedMessages.has(winlinkData.content);
      list.innerHTML = `
        <p style="margin-bottom: 10px; color: var(--color-teal);">
          <strong>Subject:</strong> Blog Post via Vara HF
        </p>
        <p style="margin-bottom: 10px;">Copy the following and paste into a new Winlink email:</p>
        <div class="message-item${metaCopied ? " message-copied" : ""}">
          <div class="message-content">${this.escapeHtml(winlinkData.metadata)}</div>
          <button class="copy-btn${metaCopied ? " copied" : ""}" onclick="OffshoreBloggingUI.copyToClipboard('${this.escapeForAttribute(winlinkData.metadata)}', this)">${metaCopied ? "Copied ✓" : "Copy Metadata"}</button>
        </div>
        <div class="message-item${contentCopied ? " message-copied" : ""}">
          <div class="message-content">${this.escapeHtml(winlinkData.content)}</div>
          <button class="copy-btn${contentCopied ? " copied" : ""}" onclick="OffshoreBloggingUI.copyToClipboard('${this.escapeForAttribute(winlinkData.content)}', this)">${contentCopied ? "Copied ✓" : "Copy Content"}</button>
        </div>
        <p style="color: var(--text-muted); font-size: 0.85rem; margin-top: 10px;">
          <strong>Identity Hash:</strong> ${winlinkData.identityHash}
        </p>
      `;
      return;
    }

    let messages = [];
    let messageText = "";

    if (version === "text") {
      messages = this.currentEncodeResult.textMessages;
      messageText = `${this.currentEncodeResult.textMessages.length} message(s) - copy each to Garmin Messenger`;
    } else if (version === "image") {
      // The image variant sends the full body (with image markdown retained
      // so the server knows where to place images) plus the image chunks.
      messages = [
        ...(this.currentEncodeResult.fullTextMessages ||
          this.currentEncodeResult.textMessages),
        ...this.currentEncodeResult.imageMessages,
      ];
      messageText = `${this.currentEncodeResult.totalMessages} message(s) - copy each to Garmin Messenger`;
    }

    const info = document.createElement("div");
    info.className = "info";
    info.textContent = messageText;
    list.appendChild(info);

    // If any of the currently-visible chunks have been copied, offer a way to
    // reset the markers (e.g. if the server asks for a chunk again and the
    // user wants a clean slate).
    if (messages.some((m) => this.copiedMessages.has(m))) {
      const resetBtn = document.createElement("button");
      resetBtn.className = "copy-btn";
      resetBtn.style.marginBottom = "10px";
      resetBtn.textContent = "Reset copied markers";
      resetBtn.addEventListener("click", () => {
        for (const m of messages) {
          this.copiedMessages.delete(m);
        }
        this.saveCopiedMessages();
        this.renderMessages(version);
      });
      list.appendChild(resetBtn);
    }

    messages.forEach((msg, i) => {
      const isCopied = this.copiedMessages.has(msg);
      const item = document.createElement("div");
      item.className = `message-item${isCopied ? " message-copied" : ""}`;
      item.innerHTML = `
        <div class="message-number">${i + 1}/${messages.length}</div>
        <div class="message-content">${this.escapeHtml(msg)}</div>
        <button class="copy-btn${isCopied ? " copied" : ""}" onclick="OffshoreBloggingUI.copyToClipboard('${this.escapeForAttribute(msg)}', this)">${isCopied ? "Copied ✓" : "Copy"}</button>
      `;
      list.appendChild(item);
    });
  }

  static copyToClipboard(text, btn) {
    const onCopied = () => {
      const instance = window.OffshoreBloggingUI;
      instance.markCopied(text);
      // Mark this chunk as copied persistently (don't auto-revert). The
      // user can still click Copy again to re-copy in case a chunk got
      // missed and the server requests it.
      btn.textContent = "Copied ✓";
      btn.classList.add("copied");
      const item = btn.closest(".message-item");
      if (item) {
        item.classList.add("message-copied");
      }
    };
    OffshoreBloggingUI.copyText(text).then((ok) => {
      if (ok) {
        onCopied();
      } else {
        alert(
          "Unable to copy automatically. Please select the text and copy manually.",
        );
      }
    });
  }

  // Copy text to the clipboard, resolving to true on success or false on
  // failure. Prefers the async Clipboard API but falls back to a legacy
  // hidden-textarea + execCommand approach so it also works in non-secure
  // contexts (e.g. a Signal K server served over plain HTTP) where
  // navigator.clipboard is unavailable.
  static copyText(text) {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard
        .writeText(text)
        .then(() => true)
        .catch(() => OffshoreBloggingUI.copyTextLegacy(text));
    }
    return Promise.resolve(OffshoreBloggingUI.copyTextLegacy(text));
  }

  static copyTextLegacy(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // Place the textarea off-screen so it doesn't scroll the page or flash.
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    textarea.setAttribute("readonly", "");
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(textarea);
    return ok;
  }

  /**
   * Rebuild the Saildocs request in the weather tab from the current UI
   * state. Picks the route variant (current position → destination +
   * margin) when the route toggle is on and a valid destination is given,
   * otherwise the centered-on-boat variant.
   */
  async rebuildWeatherRequest() {
    const presetId = document.getElementById("weatherPreset").value;
    if (!presetId) return;

    const pos = await this.getBoatPosition();
    if (!pos) {
      this.showPositionError(
        "Unable to read boat position from Signal K. " +
          "Enter the Saildocs request manually.",
      );
      return;
    }
    this.showPosition(pos);

    const routeToggle = document.getElementById("weatherRouteToggle");
    let request;
    if (routeToggle?.checked) {
      const destLat = parseFloat(
        document.getElementById("weatherDestLat").value,
      );
      const destLon = parseFloat(
        document.getElementById("weatherDestLon").value,
      );
      const margin = parseFloat(document.getElementById("weatherMargin").value);
      // While the user is still typing the destination, don't clobber the
      // field with a half-built request — just leave it empty until both
      // coordinates are valid numbers.
      if (Number.isNaN(destLat) || Number.isNaN(destLon)) {
        document.getElementById("weatherRequest").value = "";
        return;
      }
      const marginVal = Number.isNaN(margin) ? 0 : margin;
      request = window.SaildocsArea.buildRouteRequest(
        presetId,
        pos.lat,
        pos.lon,
        destLat,
        destLon,
        marginVal,
      );
    } else {
      request = window.SaildocsArea.buildRequest(presetId, pos.lat, pos.lon);
    }

    document.getElementById("weatherRequest").value = request ?? "";
  }

  /**
   * Fetch the boat's current position from the Signal K REST API.
   * Caches the result so switching between presets doesn't re-fetch.
   * Returns { lat, lon } or null on error / no fix.
   */
  async getBoatPosition() {
    if (this.cachedPosition) return this.cachedPosition;
    try {
      const response = await fetch(
        "/signalk/v1/api/vessels/self/navigation/position",
      );
      if (!response.ok) return null;
      const data = await response.json();
      // Handle both wrapped { value: { latitude, longitude } } and
      // direct { latitude, longitude } response shapes.
      const pos = data.value || data;
      if (
        typeof pos.latitude !== "number" ||
        typeof pos.longitude !== "number"
      ) {
        return null;
      }
      this.cachedPosition = { lat: pos.latitude, lon: pos.longitude };
      return this.cachedPosition;
    } catch {
      return null;
    }
  }

  /**
   * Show the boat position used for the weather request.
   */
  showPosition(pos) {
    const el = document.getElementById("weatherPosition");
    if (!el) return;
    el.style.display = "block";
    el.className = "info";
    const latDir = pos.lat >= 0 ? "N" : "S";
    const lonDir = pos.lon >= 0 ? "E" : "W";
    document.getElementById("weatherPositionText").textContent =
      `${Math.abs(pos.lat).toFixed(4)}°${latDir}, ${Math.abs(pos.lon).toFixed(4)}°${lonDir}`;
  }

  /**
   * Show an error message in the position display area.
   */
  showPositionError(message) {
    const el = document.getElementById("weatherPosition");
    if (!el) return;
    el.style.display = "block";
    el.className = "error";
    document.getElementById("weatherPositionText").textContent = message;
  }

  async generateWeatherRequest() {
    const request = document.getElementById("weatherRequest").value.trim();

    if (!request) {
      alert("Please enter a Saildocs weather request");
      return;
    }

    // Build the message the user sends from InReach to the cloud. The
    // cloud's GribFetcher understands two forms:
    //   send <email>:<query>   (explicit Saildocs address)
    //   <bare query>           (defaults to query@saildocs.com)
    // We emit the explicit `send` form so the message is self-documenting
    // and unambiguous about where it's going — matching the runner example
    // and cloud.md §GribFetcher. (buildWeatherMessage avoids double-wrapping
    // if the user already typed a `send ...` command.)
    const message = OffshoreBloggingUI.buildWeatherMessage(request);

    // Parse the request to estimate message count
    const parts = request.split("|");
    const model = parts[0].split(":")[0];
    const _timepoints = parts[2] ? parts[2].split(",").length : 1;

    // Simple estimation: each message ~120 chars, weather requests vary
    const estimatedMsgs = Math.ceil(message.length / 120);

    document.getElementById("weatherResults").style.display = "block";
    document.getElementById("weatherMessages").textContent = estimatedMsgs;
    document.getElementById("weatherModel").textContent = model.toUpperCase();

    // Color the message count by transmission cost: nominal green up to the
    // 10-message threshold, warning orange above it (the server will ask
    // for confirmation before transmitting).
    const weatherStat = document
      .getElementById("weatherMessages")
      .closest(".stat-item");
    if (weatherStat) {
      weatherStat.classList.toggle("theme-orange", estimatedMsgs > 10);
      weatherStat.classList.toggle("theme-green", estimatedMsgs <= 10);
    }

    const list = document.getElementById("weatherMessageList");
    list.innerHTML = `
      <div class="info">
        <p><strong>Weather Request Ready</strong></p>
        <p>Copy the following message and send via InReach to your cloud server:</p>
      </div>
      <div class="message-item">
        <div class="message-content">${this.escapeHtml(message)}</div>
        <button class="copy-btn" onclick="OffshoreBloggingUI.copyToClipboard('${this.escapeForAttribute(message)}', this)">Copy</button>
      </div>
      ${
        estimatedMsgs > 10
          ? `
        <div class="error">
          <p><strong>Large Request Warning</strong></p>
          <p>This request will produce ${estimatedMsgs} messages. The server will send you a confirmation asking you to confirm before transmitting.</p>
        </div>
      `
          : ""
      }
    `;
  }

  addChunk() {
    const input = document.getElementById("chunkInput");
    const chunk = input.value.trim();

    if (!chunk) return;

    // Unified Compact Chunk Header Protocol (work doc #12):
    //   [ID:4][Type:1][Index:2][Total:2][Meta?:4]:[Payload]
    // The optional 4-hex Meta carries the CRC for blog text/image (T/I);
    // it is omitted for downlink GRIB (G) and system (S) chunks. The
    // deprecated `msg i/total:type:id\n` lo-fi envelope is no longer
    // accepted — only the compact format is supported.
    const match = chunk.match(
      /^([a-zA-Z0-9]{4})([A-Za-z])(\d{2})(\d{2})([0-9a-fA-F]{4})?:(.*)$/s,
    );

    if (!match) {
      alert(
        "Unrecognized chunk format.\n\n" +
          "Expected compact header:\n" +
          "  <id:4><type:1><idx:2><total:2>[meta:4]:<data>\n" +
          "e.g. rqnnG0305:<base64>  or  0715T0102687c:<payload>",
      );
      return;
    }

    const [, transmissionId, typeChar, idx, total, meta, data] = match;
    this.chunks.push({
      transmissionId,
      typeChar: typeChar.toUpperCase(),
      idx: parseInt(idx, 10),
      total: parseInt(total, 10),
      meta, // CRC16 for T/I; undefined for G/S
      data,
      raw: chunk,
    });

    input.value = "";
    this.renderChunks();
  }

  // Human-readable label for a compact type character.
  static chunkTypeLabel(t) {
    return { T: "Text", I: "Image", G: "GRIB", S: "System" }[t] || t;
  }

  renderChunks() {
    const container = document.getElementById("chunksList");
    const display = document.getElementById("chunksDisplay");

    if (this.chunks.length === 0) {
      container.style.display = "none";
      return;
    }

    container.style.display = "block";

    // Group all chunk types by transmissionId-typeChar so a blog post's
    // text and image sequences (which share a transmissionId) are handled
    // independently, and GRIB/system sequences stay separate too.
    const groups = {};
    for (const chunk of this.chunks) {
      const key = `${chunk.transmissionId}-${chunk.typeChar}`;
      if (!groups[key]) {
        groups[key] = {
          transmissionId: chunk.transmissionId,
          typeChar: chunk.typeChar,
          total: chunk.total,
          chunks: {},
        };
      }
      groups[key].chunks[chunk.idx] = chunk;
    }

    let html = "";
    for (const group of Object.values(groups)) {
      const chunkIds = Object.keys(group.chunks)
        .map(Number)
        .sort((a, b) => a - b);
      const total = group.total;
      const missing = [];
      for (let i = 1; i <= total; i++) {
        if (!group.chunks[i]) missing.push(i);
      }
      const statusClass = missing.length === 0 ? "success" : "warning";
      const label = OffshoreBloggingUI.chunkTypeLabel(group.typeChar);
      html += `
        <div class="${statusClass}" style="margin-bottom: 10px;">
          <strong>${label} (${group.transmissionId}):</strong> ${chunkIds.length}/${total} chunks
          ${missing.length > 0 ? `<br>Missing: ${missing.join(", ")}` : "<br>✓ Complete"}
        </div>
      `;
    }

    display.innerHTML = html;
  }

  async reassembleChunks() {
    if (this.chunks.length === 0) {
      alert("No chunks to reassemble");
      return;
    }

    // Group by transmissionId-typeChar (matches renderChunks).
    const groups = {};
    for (const chunk of this.chunks) {
      const key = `${chunk.transmissionId}-${chunk.typeChar}`;
      if (!groups[key]) {
        groups[key] = {
          transmissionId: chunk.transmissionId,
          typeChar: chunk.typeChar,
          total: chunk.total,
          chunks: {},
        };
      }
      groups[key].chunks[chunk.idx] = chunk;
    }

    const resultsDiv = document.getElementById("reassembleResults");
    const output = document.getElementById("reassembleOutput");
    resultsDiv.style.display = "block";

    let html = "";

    for (const group of Object.values(groups)) {
      const total = group.total;
      const missing = [];
      for (let i = 1; i <= total; i++) {
        if (!group.chunks[i]) missing.push(i);
      }

      if (missing.length > 0) {
        const label = OffshoreBloggingUI.chunkTypeLabel(group.typeChar);
        html += `
          <div class="error">
            <h4>${label} (${group.transmissionId})</h4>
            <p>Missing chunks: ${missing.join(", ")} of ${total}</p>
          </div>
        `;
        continue;
      }

      // Blog text/image: server-side dictionary decompression.
      if (group.typeChar === "T" || group.typeChar === "I") {
        // BlogCodec.reassembleChunks expects {idx: {total, crc, data}}.
        const entries = {};
        for (let i = 1; i <= total; i++) {
          const c = group.chunks[i];
          entries[i] = { total: c.total, crc: c.meta, data: c.data };
        }
        try {
          const response = await fetch(
            "/plugins/signalk-offshore-blogging/api/reassemble",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chunks: entries, type: group.typeChar }),
            },
          );
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || "Reassembly failed");
          }
          if (group.typeChar === "T") {
            html += `
              <div class="success">
                <h4>Blog Post ${group.transmissionId} (Text)</h4>
                <p><strong>Title:</strong> ${this.escapeHtml(data.title)}</p>
                <p><strong>Date:</strong> ${this.escapeHtml(data.date)}</p>
                <textarea class="code-block" readonly>${this.escapeHtml(data.body)}</textarea>
              </div>
            `;
          } else {
            html += `
              <div class="success">
                <h4>Blog Post ${group.transmissionId} (Image)</h4>
                <img src="${data.image}" alt="Decoded image">
              </div>
            `;
          }
        } catch (error) {
          const label = OffshoreBloggingUI.chunkTypeLabel(group.typeChar);
          html += `
            <div class="error">
              <h4>Blog Post ${group.transmissionId} (${label})</h4>
              <p>${this.escapeHtml(error.message)}</p>
            </div>
          `;
        }
        continue;
      }

      // GRIB: assemble server-side and persist so any Signal K user can
      // download it later (not only the person who pasted the chunks).
      // Listed latest-first via GET /api/gribs.
      if (group.typeChar === "G") {
        const orderedRaws = [];
        for (let i = 1; i <= total; i++) orderedRaws.push(group.chunks[i].raw);
        try {
          const response = await fetch(
            "/plugins/signalk-offshore-blogging/api/grib/assemble",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chunks: orderedRaws }),
            },
          );
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || "GRIB assembly failed");
          }
          const g = data.grib;
          const downloadUrl = `/plugins/signalk-offshore-blogging/api/gribs/${encodeURIComponent(g.id)}/download`;
          html += `
            <div class="success">
              <h4>GRIB (${g.transmissionId})</h4>
              <p><strong>Size:</strong> ${g.size} bytes</p>
              <p>Assembled &amp; persisted server-side — available to all Signal K users.</p>
              <a href="${downloadUrl}" download="${g.transmissionId}.grb" class="btn">Download .grb</a>
            </div>
          `;
          // Refresh the shared, latest-first list with the new entry.
          this.loadStoredGribs();
        } catch (error) {
          html += `
            <div class="error">
              <h4>GRIB (${group.transmissionId})</h4>
              <p>${this.escapeHtml(error.message)}</p>
            </div>
          `;
        }
        continue;
      }

      // System (S) and other plain-text chunks: concatenate payloads.
      let text = "";
      for (let i = 1; i <= total; i++) text += group.chunks[i].data;
      const label = OffshoreBloggingUI.chunkTypeLabel(group.typeChar);
      html += `
        <div class="success">
          <h4>${label} (${group.transmissionId})</h4>
          <textarea class="code-block" readonly>${this.escapeHtml(text)}</textarea>
        </div>
      `;
    }

    output.innerHTML = html;
  }

  /**
   * Load the server-persisted GRIBs (latest-first) so any Signal K user can
   * see and download previously assembled weather files.
   */
  async loadStoredGribs() {
    const container = document.getElementById("storedGribsList");
    if (!container) return;
    try {
      const response = await fetch(
        "/plugins/signalk-offshore-blogging/api/gribs",
      );
      const data = await response.json();
      const gribs = data.gribs || [];
      if (gribs.length === 0) {
        container.innerHTML =
          '<p style="color: var(--text-muted);">No persisted GRIBs yet.</p>';
        return;
      }
      container.innerHTML = gribs
        .map((g) => {
          const when = new Date(g.createdAt).toLocaleString();
          const url = `/plugins/signalk-offshore-blogging/api/gribs/${encodeURIComponent(g.id)}/download`;
          return `
            <div class="message-item">
              <div class="message-content">
                <strong>${this.escapeHtml(g.transmissionId)}</strong>
                — ${g.size} bytes — ${this.escapeHtml(when)}
              </div>
              <a href="${url}" download="${g.transmissionId}.grb" class="copy-btn">Download</a>
            </div>
          `;
        })
        .join("");
    } catch (_error) {
      container.innerHTML =
        '<p style="color: var(--color-red);">Could not load stored GRIBs.</p>';
    }
  }

  clearChunks() {
    this.chunks = [];
    this.renderChunks();
    document.getElementById("reassembleResults").style.display = "none";
  }

  /**
   * Upload a complete GRIB file (Winlink/Saildocs path). The file is sent
   * as raw bytes (application/octet-stream) and persisted server-side in the
   * same store as InReach-assembled GRIBs, so signalk-grib-weather-provider
   * can ingest it for querying and any Signal K user can download it.
   */
  async uploadGrib() {
    const input = document.getElementById("gribFileInput");
    const resultDiv = document.getElementById("uploadGribResult");
    resultDiv.style.display = "block";

    if (!input.files || input.files.length === 0) {
      resultDiv.innerHTML =
        '<p style="color: var(--color-red);">Please choose a GRIB file first.</p>';
      return;
    }
    const file = input.files[0];
    const originalName = file.name || "";

    try {
      const buf = await file.arrayBuffer();
      const url =
        `/plugins/signalk-offshore-blogging/api/grib/upload` +
        `?filename=${encodeURIComponent(originalName)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(buf),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "GRIB upload failed");
      }
      const g = data.grib;
      const downloadUrl = `/plugins/signalk-offshore-blogging/api/gribs/${encodeURIComponent(g.id)}/download`;
      resultDiv.innerHTML = `
        <div class="success">
          <h4>Uploaded GRIB (${this.escapeHtml(g.transmissionId)})</h4>
          <p><strong>Size:</strong> ${g.size} bytes</p>
          ${g.originalFilename ? `<p><strong>Original:</strong> ${this.escapeHtml(g.originalFilename)}</p>` : ""}
          <p>Persisted server-side — available to all Signal K users.</p>
          <a href="${downloadUrl}" download="${g.transmissionId}.grb" class="btn">Download .grb</a>
        </div>
      `;
      // Reset the input so the same file can be re-selected if needed.
      input.value = "";
      // Refresh the shared, latest-first list with the new entry.
      this.loadStoredGribs();
    } catch (error) {
      resultDiv.innerHTML = `
        <div class="error">
          <p>${this.escapeHtml(error.message)}</p>
        </div>
      `;
    }
  }
}

// Initialize on load
document.addEventListener("DOMContentLoaded", () => {
  window.OffshoreBloggingUI = new OffshoreBloggingUI();
});
