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
    document.getElementById("weatherPreset").addEventListener("change", (e) => {
      if (e.target.value) {
        document.getElementById("weatherRequest").value = e.target.value;
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

  async generateWeatherRequest() {
    const request = document.getElementById("weatherRequest").value.trim();

    if (!request) {
      alert("Please enter a Saildocs weather request");
      return;
    }

    // Parse the request to estimate message count
    const parts = request.split("|");
    const model = parts[0].split(":")[0];
    const _timepoints = parts[2] ? parts[2].split(",").length : 1;

    // Simple estimation: each message ~120 chars, weather requests vary
    const estimatedMsgs = Math.ceil(request.length / 120);

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
        <div class="message-content">${this.escapeHtml(request)}</div>
        <button class="copy-btn" onclick="OffshoreBloggingUI.copyToClipboard('${this.escapeForAttribute(request)}', this)">Copy</button>
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

    // Validate chunk format
    const match = chunk.match(
      /^([0-9A-Za-z]{4})([TI])(\d{2})(\d{2})([0-9a-f]{4}):(.*)$/,
    );
    if (!match) {
      alert(
        "Invalid chunk format. Expected: <postid:4><type:1><idx:2><total:2><crc:4>:<base64 data>",
      );
      return;
    }

    const [, postid, type, idx, total, crc, data] = match;
    this.chunks.push({
      postid,
      type,
      idx: parseInt(idx, 10),
      total: parseInt(total, 10),
      crc,
      data,
      raw: chunk,
    });

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

    // Group by postid and type
    const groups = {};
    this.chunks.forEach((chunk) => {
      const key = `${chunk.postid}-${chunk.type}`;
      if (!groups[key]) {
        groups[key] = { postid: chunk.postid, type: chunk.type, chunks: {} };
      }
      groups[key].chunks[chunk.idx] = chunk;
    });

    let html = "";
    for (const [_key, group] of Object.entries(groups)) {
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

    display.innerHTML = html;
  }

  async reassembleChunks() {
    if (this.chunks.length === 0) {
      alert("No chunks to reassemble");
      return;
    }

    // Group by postid and type
    const groups = {};
    this.chunks.forEach((chunk) => {
      const key = `${chunk.postid}-${chunk.type}`;
      if (!groups[key]) {
        groups[key] = { postid: chunk.postid, type: chunk.type, entries: {} };
      }
      groups[key].entries[chunk.idx] = {
        total: chunk.total,
        crc: chunk.crc,
        data: chunk.data,
      };
    });

    const resultsDiv = document.getElementById("reassembleResults");
    const output = document.getElementById("reassembleOutput");
    resultsDiv.style.display = "block";

    let html = "";

    for (const [_key, group] of Object.entries(groups)) {
      try {
        const response = await fetch(
          "/plugins/signalk-offshore-blogging/api/reassemble",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chunks: group.entries,
              type: group.type,
            }),
          },
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Reassembly failed");
        }

        if (group.type === "T") {
          html += `
            <div class="success">
              <h4>Post ${group.postid} (Text)</h4>
              <p><strong>Title:</strong> ${data.title}</p>
              <p><strong>Date:</strong> ${data.date}</p>
              <textarea class="code-block" readonly>${this.escapeHtml(data.body)}</textarea>
            </div>
          `;
        } else if (group.type === "I") {
          html += `
            <div class="success">
              <h4>Post ${group.postid} (Image)</h4>
              <img src="${data.image}" style="max-width: 100%; border-radius: 5px;" alt="Decoded image">
            </div>
          `;
        }
      } catch (error) {
        html += `
          <div class="error">
            <h4>Post ${group.postid} (${group.type === "T" ? "Text" : "Image"})</h4>
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
