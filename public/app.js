// Offshore Blogging UI

class OffshoreBloggingUI {
  constructor() {
    this.currentEncodeResult = null;
    this.currentPreviews = null;
    this.chunks = [];
    // Messages the user has already copied, so we can mark them and make it
    // easier to keep track of what has been sent. Persisted in localStorage so
    // the markers survive page reloads (e.g. if the server requests a chunk
    // again later). Keyed by the exact message string.
    this.copiedMessages = this.loadCopiedMessages();
    this.initTabs();
    this.initBlogTab();
    this.initWeatherTab();
    this.initDecodeTab();
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
        wrapper.style.marginBottom = "20px";
        wrapper.style.border = "1px solid var(--border-color)";
        wrapper.style.padding = "15px";
        wrapper.style.borderRadius = "5px";
        wrapper.style.backgroundColor = "var(--card-bg)";

        const isError = preview.error !== undefined;

        wrapper.innerHTML = `
          <p style="margin-bottom: 10px; color: var(--highlight-color);">
            <strong>Image ${idx + 1}: ${preview.alt || "(no alt text)"}</strong>
            ${isError ? ` <span style="color: #ff6b6b;">(Error: ${preview.error})</span>` : ""}
          </p>
          ${
            !isError
              ? `
            <img src="data:image/webp;base64,${preview.base64}" 
                 style="max-width: 100%; max-height: 200px; border-radius: 3px; border: 1px solid #333; margin-bottom: 10px;" 
                 alt="Compressed preview">
            <p style="font-size: 0.85rem; margin: 0;">
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
        <p style="margin-bottom: 10px; color: var(--highlight-color);">
          <strong>Subject:</strong> Blog Post via Vara HF
        </p>
        <p style="margin-bottom: 10px;">Copy the following and paste into a new Winlink email:</p>
        <div class="message-item${metaCopied ? " message-copied" : ""}">
          <div class="message-content" style="white-space: pre-wrap; font-family: monospace; font-size: 0.85rem;">${this.escapeHtml(winlinkData.metadata)}</div>
          <button class="copy-btn${metaCopied ? " copied" : ""}" onclick="OffshoreBloggingUI.copyToClipboard('${this.escapeForAttribute(winlinkData.metadata)}', this)">${metaCopied ? "Copied ✓" : "Copy Metadata"}</button>
        </div>
        <div class="message-item${contentCopied ? " message-copied" : ""}">
          <div class="message-content" style="white-space: pre-wrap; font-family: monospace; font-size: 0.85rem;">${this.escapeHtml(winlinkData.content)}</div>
          <button class="copy-btn${contentCopied ? " copied" : ""}" onclick="OffshoreBloggingUI.copyToClipboard('${this.escapeForAttribute(winlinkData.content)}', this)">${contentCopied ? "Copied ✓" : "Copy Content"}</button>
        </div>
        <p style="color: #888; font-size: 0.85rem; margin-top: 10px;">
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

    // Try blog format: <postid:4><type:1[TI]><idx:2><total:2><crc:4>:<data>
    const blogMatch = chunk.match(
      /^([0-9A-Za-z]{4})([TI])(\d{2})(\d{2})([0-9a-f]{4}):(.*)$/,
    );

    // Try lo-fi format: msg <idx>/<total>:<partType>:<transmissionId>\n<data>
    // (used by InReachSender for multi-chunk GRIB and text deliveries).
    // The header and data are separated by a newline; we match the header
    // prefix and take the rest as data so we don't care whether the paste
    // preserved the \n or replaced it with a space.
    const lofiMatch = chunk.match(/^msg\s+(\d+)\/(\d+):(\w+):(\w+)\s*/);

    if (blogMatch) {
      const [, postid, type, idx, total, crc, data] = blogMatch;
      this.chunks.push({
        format: "blog",
        postid,
        type,
        idx: parseInt(idx, 10),
        total: parseInt(total, 10),
        crc,
        data,
        raw: chunk,
      });
    } else if (lofiMatch) {
      const [, idx, total, partType, transmissionId] = lofiMatch;
      const data = chunk.substring(lofiMatch[0].length).trim();
      this.chunks.push({
        format: "lofi",
        partType,
        transmissionId,
        idx: parseInt(idx, 10),
        total: parseInt(total, 10),
        data,
        raw: chunk,
      });
    } else {
      alert(
        "Unrecognized chunk format.\n\n" +
          "Blog:  <postid:4><type:1><idx:2><total:2><crc:4>:<data>\n" +
          "Lo-fi: msg <idx>/<total>:<partType>:<id>\\n<data>",
      );
      return;
    }

    input.value = "";
    this.renderChunks();
  }

  renderChunks() {
    const container = document.getElementById("chunksList");
    const display = document.getElementById("chunksDisplay");

    if (this.chunks.length === 0) {
      container.style.display = "none";
      return;
    }

    container.style.display = "block";

    // Group blog chunks by postid-type, lo-fi chunks by transmissionId
    const blogGroups = {};
    const lofiGroups = {};
    this.chunks.forEach((chunk) => {
      if (chunk.format === "lofi") {
        const key = chunk.transmissionId;
        if (!lofiGroups[key]) {
          lofiGroups[key] = {
            transmissionId: chunk.transmissionId,
            partType: chunk.partType,
            total: chunk.total,
            chunks: {},
          };
        }
        lofiGroups[key].chunks[chunk.idx] = chunk;
        return;
      }
      // Blog format (default for backward compat)
      const key = `${chunk.postid}-${chunk.type}`;
      if (!blogGroups[key]) {
        blogGroups[key] = {
          postid: chunk.postid,
          type: chunk.type,
          chunks: {},
        };
      }
      blogGroups[key].chunks[chunk.idx] = chunk;
    });

    let html = "";

    // Render blog groups
    for (const [_key, group] of Object.entries(blogGroups)) {
      const chunkIds = Object.keys(group.chunks)
        .map(Number)
        .sort((a, b) => a - b);
      const total = group.chunks[chunkIds[0]].total;
      const missing = [];

      for (let i = 1; i <= total; i++) {
        if (!group.chunks[i]) missing.push(i);
      }

      const typeLabel = group.type === "T" ? "Text" : "Image";
      const statusClass = missing.length === 0 ? "success" : "info";

      html += `
        <div class="${statusClass}" style="margin-bottom: 10px;">
          <strong>Post ${group.postid} (${typeLabel}):</strong> ${chunkIds.length}/${total} chunks
          ${missing.length > 0 ? `<br>Missing: ${missing.join(", ")}` : "<br>✓ Complete"}
        </div>
      `;
    }

    // Render lo-fi groups (GRIB, etc.)
    for (const group of Object.values(lofiGroups)) {
      const chunkIds = Object.keys(group.chunks)
        .map(Number)
        .sort((a, b) => a - b);
      const total = group.total;
      const missing = [];
      for (let i = 1; i <= total; i++) {
        if (!group.chunks[i]) missing.push(i);
      }
      const typeLabel =
        group.partType === "grib"
          ? "GRIB"
          : group.partType.charAt(0).toUpperCase() + group.partType.slice(1);
      const statusClass = missing.length === 0 ? "success" : "info";

      html += `
        <div class="${statusClass}" style="margin-bottom: 10px;">
          <strong>${typeLabel} (${group.transmissionId}):</strong> ${chunkIds.length}/${total} chunks
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

    // Group chunks by transmissionId
    const groups = {};
    this.chunks.forEach((chunk) => {
      const key = chunk.transmissionId;
      if (!groups[key]) {
        groups[key] = {
          transmissionId: chunk.transmissionId,
          typeChar: chunk.typeChar,
          type: chunk.type,
          total: chunk.total,
          entries: {},
        };
      }
      groups[key].entries[chunk.idx] = chunk.data;
    });

    const resultsDiv = document.getElementById("reassembleResults");
    const output = document.getElementById("reassembleOutput");
    resultsDiv.style.display = "block";

    let html = "";

    // Reassemble blog chunks (server-side: dictionary decompression)
    for (const group of Object.values(groups)) {
      // Only T and I types go to server for decompression
      if (group.typeChar !== "T" && group.typeChar !== "I") {
        continue;
      }

      try {
        const response = await fetch(
          "/plugins/signalk-offshore-blogging/api/reassemble",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chunks: group.entries,
              type: group.typeChar,
            }),
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
              <p><strong>Title:</strong> ${data.title}</p>
              <p><strong>Date:</strong> ${data.date}</p>
              <textarea class="code-block" readonly>${this.escapeHtml(data.body)}</textarea>
            </div>
          `;
        } else if (group.typeChar === "I") {
          html += `
            <div class="success">
              <h4>Blog Post ${group.transmissionId} (Image)</h4>
              <img src="${data.image}" style="max-width: 100%; border-radius: 5px;" alt="Decoded image">
            </div>
          `;
        }
      } catch (error) {
        html += `
          <div class="error">
            <h4>Blog Post ${group.transmissionId} (${group.typeChar === "T" ? "Text" : "Image"})</h4>
            <p>${this.escapeHtml(error.message)}</p>
          </div>
        `;
      }
    }

    // Reassemble non-blog chunks (client-side: base64 concat → binary → download)
    // GRIB (G) and system (S) chunks are plain base64 slices, no decompression
    for (const group of Object.values(groups)) {
      if (group.typeChar === "T" || group.typeChar === "I") {
        continue; // Already handled above
      }

      const total = group.total;

      // Check for missing chunks
      const missing = [];
      for (let i = 1; i <= total; i++) {
        if (!group.entries[i]) missing.push(i);
      }

      if (missing.length > 0) {
        const label =
          group.typeChar === "G"
            ? "GRIB"
            : group.type.charAt(0).toUpperCase() + group.type.slice(1);
        html += `
          <div class="error">
            <h4>${label} (${group.transmissionId})</h4>
            <p>Missing chunks: ${missing.join(", ")}</p>
          </div>
        `;
        continue;
      }

      try {
        // Concatenate base64 chunks in order (1-based)
        let base64Data = "";
        for (let i = 1; i <= total; i++) {
          base64Data += group.entries[i];
        }
        base64Data = base64Data.replace(/\s+/g, "");

        // Decode base64 → binary
        const binary = atob(base64Data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }

        if (group.typeChar === "G") {
          // Create a downloadable .grb file
          const blob = new Blob([bytes], { type: "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          const magic =
            bytes.length >= 4
              ? String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
              : "";
          const magicOk = magic === "GRIB";
          html += `
            <div class="success">
              <h4>GRIB (${group.transmissionId})</h4>
              <p><strong>Size:</strong> ${bytes.length} bytes</p>
              <p><strong>Magic:</strong> ${this.escapeHtml(magic)} ${magicOk ? "✓" : "⚠ expected GRIB"}</p>
              <a href="${url}" download="${group.transmissionId}.grb" class="btn">Download .grb</a>
            </div>
          `;
        } else {
          // System messages or other text
          const text = new TextDecoder().decode(bytes);
          html += `
            <div class="success">
              <h4>${group.type} (${group.transmissionId})</h4>
              <textarea class="code-block" readonly>${this.escapeHtml(text)}</textarea>
            </div>
          `;
        }
      } catch (error) {
        const label =
          group.typeChar === "G"
            ? "GRIB"
            : group.type.charAt(0).toUpperCase() + group.type.slice(1);
        html += `
          <div class="error">
            <h4>${label} (${group.transmissionId})</h4>
            <p>${this.escapeHtml(error.message)}</p>
          </div>
        `;
      }
    }

    output.innerHTML = html;
  }

  clearChunks() {
    this.chunks = [];
    this.renderChunks();
    document.getElementById("reassembleResults").style.display = "none";
  }
}

// Initialize on load
document.addEventListener("DOMContentLoaded", () => {
  window.OffshoreBloggingUI = new OffshoreBloggingUI();
});
