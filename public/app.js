// SubMail frontend. Vanilla JS, no build step, no framework — the app is a
// single page with a handful of interactions, which doesn't need one.
//
// All API calls are same-origin, relative paths. Auth is header-based
// (X-Mailbox-Id + Authorization: Bearer <token>) rather than cookies, so
// there is no ambient authority and nothing for CSRF to exploit.

(() => {
  "use strict";

  const STORAGE_MAILBOX_KEY = "submail:mailbox";
  const STORAGE_THEME_KEY = "submail:theme";
  const POLL_INTERVAL_MS = 12000;

  /** @type {{id:string,address:string,token:string,createdAt:number}|null} */
  let mailbox = null;
  let messages = [];
  let pollTimer = null;
  let openMessageId = null;
  let lastFocusedBeforeDialog = null;
  let refreshInFlight = false;
  let pollFailureCount = 0;
  let seenMessageIds = new Set();

  // -----------------------------------------------------------------------
  // Elements
  // -----------------------------------------------------------------------
  const el = {
    addressSkeleton: document.getElementById("address-skeleton"),
    addressText: document.getElementById("address-text"),
    copyBtn: document.getElementById("copy-btn"),
    copyBtnLabel: document.getElementById("copy-btn-label"),
    newAddressBtn: document.getElementById("new-address-btn"),
    customToggleBtn: document.getElementById("custom-toggle-btn"),
    customForm: document.getElementById("custom-form"),
    customName: document.getElementById("custom-name"),
    customNameDomain: document.getElementById("custom-name-domain"),
    customStatus: document.getElementById("custom-name-status"),
    messageList: document.getElementById("message-list"),
    emptyState: document.getElementById("empty-state"),
    liveIndicator: document.getElementById("live-indicator"),
    liveIndicatorLabel: document.getElementById("live-indicator-label"),
    messageView: document.getElementById("message-view"),
    messageViewBackdrop: document.getElementById("message-view-backdrop"),
    messageViewPanel: document.getElementById("message-view-panel"),
    messageViewClose: document.getElementById("message-view-close"),
    messageViewDelete: document.getElementById("message-view-delete"),
    messageViewSubject: document.getElementById("message-view-subject"),
    messageViewFrom: document.getElementById("message-view-from"),
    messageViewTo: document.getElementById("message-view-to"),
    messageViewDate: document.getElementById("message-view-date"),
    messageViewBody: document.getElementById("message-view-body"),
    messageViewAttachments: document.getElementById("message-view-attachments"),
    messageViewAttachmentList: document.getElementById("message-view-attachment-list"),
    toast: document.getElementById("toast"),
    themeButtons: Array.from(document.querySelectorAll(".theme-switch__btn")),
    customCheckBtn: document.getElementById("custom-check-btn"),
  };

  // -----------------------------------------------------------------------
  // Theme
  // -----------------------------------------------------------------------
  function initTheme() {
    const stored = safeGetItem(STORAGE_THEME_KEY) || "system";
    applyThemeChoice(stored, { persist: false });

    for (const btn of el.themeButtons) {
      btn.addEventListener("click", () => {
        applyThemeChoice(btn.dataset.themeChoice, { persist: true });
      });
    }
  }

  function applyThemeChoice(choice, { persist }) {
    if (choice === "light" || choice === "dark") {
      document.documentElement.setAttribute("data-theme", choice);
    } else {
      document.documentElement.removeAttribute("data-theme");
      choice = "system";
    }
    for (const btn of el.themeButtons) {
      btn.setAttribute("aria-pressed", String(btn.dataset.themeChoice === choice));
    }
    if (persist) safeSetItem(STORAGE_THEME_KEY, choice);
  }

  // -----------------------------------------------------------------------
  // Storage helpers (localStorage can throw in private-browsing contexts)
  // -----------------------------------------------------------------------
  function safeGetItem(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function safeSetItem(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  }
  function safeRemoveItem(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }

  function loadStoredMailbox() {
    const raw = safeGetItem(STORAGE_MAILBOX_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.id && parsed.token && parsed.address) return parsed;
    } catch { /* corrupt — ignore */ }
    return null;
  }

  function persistMailbox(mb) {
    safeSetItem(STORAGE_MAILBOX_KEY, JSON.stringify(mb));
  }

  // -----------------------------------------------------------------------
  // Seen-message tracking (drives the unread bar in the inbox list)
  // -----------------------------------------------------------------------
  const seenKeyFor = (mailboxId) => `submail:seen:${mailboxId}`;

  function loadSeenMessageIds(mailboxId) {
    const raw = safeGetItem(seenKeyFor(mailboxId));
    if (!raw) return new Set();
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? new Set(parsed) : new Set();
    } catch {
      return new Set();
    }
  }

  function markMessageSeen(messageId) {
    if (!mailbox) return;
    seenMessageIds.add(messageId);
    // Bound the stored list to the most recent IDs we care about.
    const trimmed = Array.from(seenMessageIds).slice(-500);
    seenMessageIds = new Set(trimmed);
    safeSetItem(seenKeyFor(mailbox.id), JSON.stringify(trimmed));
  }

  // -----------------------------------------------------------------------
  // API client
  // -----------------------------------------------------------------------
  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (mailbox) {
      headers.set("X-Mailbox-Id", mailbox.id);
      headers.set("Authorization", `Bearer ${mailbox.token}`);
    }

    const res = await fetch(path, { ...options, headers });
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }

    if (!res.ok) {
      const code = body && body.error ? body.error.code : "INTERNAL_ERROR";
      const message = body && body.error ? body.error.message : `Request failed (${res.status})`;
      throw new ApiError(code, message, res.status);
    }
    return body ? body.data : null;
  }

  class ApiError extends Error {
    constructor(code, message, status) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  // -----------------------------------------------------------------------
  // Mailbox lifecycle
  // -----------------------------------------------------------------------
  async function initMailbox() {
    const stored = loadStoredMailbox();
    if (stored) {
      mailbox = stored;
      seenMessageIds = loadSeenMessageIds(stored.id);
      try {
        const info = await api("/api/mailbox");
        mailbox = { ...mailbox, address: info.address, createdAt: info.createdAt };
        persistMailbox(mailbox);
        onMailboxReady();
        return;
      } catch {
        // Expired/invalid — fall through and create a fresh one.
        mailbox = null;
        safeRemoveItem(STORAGE_MAILBOX_KEY);
      }
    }
    await createMailbox();
  }

  async function createMailbox(localPart) {
    const data = await api("/api/mailbox", {
      method: "POST",
      body: localPart ? JSON.stringify({ localPart }) : undefined,
    });
    mailbox = data;
    persistMailbox(mailbox);
    seenMessageIds = loadSeenMessageIds(mailbox.id);
    onMailboxReady();
  }

  function hideAddressSkeleton() {
    // Both the property and a class: the old CSS kept .skeleton's explicit
    // display:inline-block overriding the [hidden] attribute, which left the
    // shimmer visible behind the real address forever (the reported
    // "skeleton is still there" bug). styles.css now forces [hidden] to
    // display:none and the class removal makes it robust either way.
    el.addressSkeleton.hidden = true;
    el.addressSkeleton.classList.add("is-hidden");
  }
  function showAddressSkeleton() {
    el.addressSkeleton.hidden = false;
    el.addressSkeleton.classList.remove("is-hidden");
  }

  function onMailboxReady() {
    hideAddressSkeleton();
    el.addressText.hidden = false;
    el.addressText.textContent = mailbox.address;
    el.copyBtn.disabled = false;
    el.newAddressBtn.disabled = false;
    el.customToggleBtn.disabled = false;

    const domain = mailbox.address.split("@")[1] || "";
    el.customNameDomain.textContent = "@" + domain;

    messages = [];
    renderMessageList();
    refreshMessages();
    startPolling();
  }

  async function handleNewAddress() {
    el.newAddressBtn.disabled = true;
    el.customToggleBtn.disabled = true;
    stopPolling();
    closeMessageView();

    try {
      if (mailbox) {
        try { await api("/api/mailbox", { method: "DELETE" }); } catch { /* already gone is fine */ }
      }
      safeRemoveItem(STORAGE_MAILBOX_KEY);
      mailbox = null;
      el.addressText.hidden = true;
      showAddressSkeleton();
      await createMailbox();
      showToast("New address created");
    } catch (err) {
      showToast(friendlyErrorMessage(err));
      el.newAddressBtn.disabled = false;
      el.customToggleBtn.disabled = false;
    }
  }

  // -----------------------------------------------------------------------
  // Custom name form
  // -----------------------------------------------------------------------
  function initCustomForm() {
    el.customToggleBtn.addEventListener("click", () => {
      const expanded = el.customToggleBtn.getAttribute("aria-expanded") === "true";
      el.customToggleBtn.setAttribute("aria-expanded", String(!expanded));
      el.customForm.hidden = expanded;
      if (!expanded) el.customName.focus();
    });

    let debounceTimer = null;
    el.customName.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      const value = el.customName.value.trim();
      if (!value) {
        setCustomStatus("", null);
        return;
      }
      debounceTimer = setTimeout(() => checkAvailabilityPreview(value), 400);
    });

    el.customForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = el.customName.value.trim();
      if (!value) return;

      el.customCheckBtn.disabled = true;
      try {
        stopPolling();
        closeMessageView();
        if (mailbox) {
          try { await api("/api/mailbox", { method: "DELETE" }); } catch { /* ignore */ }
        }
        safeRemoveItem(STORAGE_MAILBOX_KEY);
        mailbox = null;
        el.addressText.hidden = true;
        showAddressSkeleton();
        await createMailbox(value);
        el.customForm.hidden = true;
        el.customToggleBtn.setAttribute("aria-expanded", "false");
        el.customName.value = "";
        setCustomStatus("", null);
        showToast("Custom address created");
      } catch (err) {
        setCustomStatus(friendlyErrorMessage(err), "error");
        // We may have already deleted the old mailbox; ensure the UI has
        // *some* usable mailbox rather than being left in a broken state.
        if (!mailbox) await createMailbox().catch(() => {});
      } finally {
        el.customCheckBtn.disabled = false;
      }
    });
  }

  async function checkAvailabilityPreview(localPart) {
    try {
      const data = await api(`/api/mailbox/check?localPart=${encodeURIComponent(localPart)}`);
      if (data.available) {
        setCustomStatus("Available", "ok");
      } else {
        setCustomStatus(data.reason || "That name is taken", "error");
      }
    } catch {
      // Silent — this is just a live preview; the submit handler surfaces
      // any real error.
    }
  }

  function setCustomStatus(text, state) {
    el.customStatus.textContent = text;
    if (state) el.customStatus.setAttribute("data-state", state);
    else el.customStatus.removeAttribute("data-state");
  }

  // -----------------------------------------------------------------------
  // Inbox: polling + rendering
  // -----------------------------------------------------------------------
  function startPolling() {
    stopPolling();
    pollFailureCount = 0;
    setLiveIndicator("live");
    pollTimer = setInterval(() => {
      if (!document.hidden) refreshMessages();
    }, POLL_INTERVAL_MS);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && mailbox) refreshMessages();
  });

  /**
   * Drives the small "Live" chip next to the Inbox heading so the page is
   * visibly refreshing:
   *  - "live"    — polling normally; dot pulses
   *  - "syncing" — a poll request is in flight
   *  - "stalled" — the last 3+ polls failed (offline / API down); turns the
   *                dot red and says "Reconnecting…" instead of silently
   *                looking alive while nothing can arrive.
   */
  function setLiveIndicator(state) {
    if (!mailbox) {
      el.liveIndicator.hidden = true;
      return;
    }
    el.liveIndicator.hidden = false;
    el.liveIndicator.dataset.state = state;
    if (state === "syncing") el.liveIndicatorLabel.textContent = "Checking for mail…";
    else if (state === "stalled") el.liveIndicatorLabel.textContent = "Reconnecting…";
    else el.liveIndicatorLabel.textContent = "Live — auto-refreshing";
  }

  async function refreshMessages() {
    if (!mailbox) return;
    if (refreshInFlight) return; // never stack overlapping polls
    refreshInFlight = true;
    setLiveIndicator("syncing");
    try {
      const data = await api("/api/mailbox/messages");
      pollFailureCount = 0;
      const previousIds = new Set(messages.map((m) => m.id));
      const arrived = data.messages.filter((m) => !previousIds.has(m.id));
      messages = data.messages;
      renderMessageList();
      if (previousIds.size > 0 && arrived.length > 0) {
        showToast(arrived.length === 1 ? "New message received" : `${arrived.length} new messages received`);
      }
      setLiveIndicator("live");
    } catch {
      // Transient network/API errors during background polling shouldn't
      // interrupt the user — but after 3 consecutive failures, say so
      // rather than silently appearing to work.
      pollFailureCount += 1;
      if (pollFailureCount >= 3) setLiveIndicator("stalled");
      else setLiveIndicator("live");
    } finally {
      refreshInFlight = false;
    }
  }

  function renderMessageList() {
    const previousFirst = el.messageList.firstElementChild;
    const previousFirstId = previousFirst ? previousFirst.dataset.messageId : null;

    el.messageList.innerHTML = "";
    el.emptyState.hidden = messages.length > 0;

    for (const message of messages) {
      const li = document.createElement("li");
      li.dataset.messageId = message.id;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "message-item";
      btn.setAttribute("aria-haspopup", "dialog");
      if (message.isUnread || !seenMessageIds.has(message.id)) btn.classList.add("is-unread");

      const row1 = document.createElement("div");
      row1.className = "message-item__row1";
      const sender = document.createElement("span");
      sender.className = "message-item__sender";
      sender.textContent = message.senderName || message.senderAddress || "Unknown sender";
      const time = document.createElement("span");
      time.className = "message-item__time";
      time.textContent = formatRelativeTime(message.createdAt);
      row1.append(sender, time);

      const row2 = document.createElement("div");
      row2.className = "message-item__row2";
      const subject = document.createElement("span");
      subject.className = "message-item__subject";
      subject.textContent = message.subject || "(no subject)";
      row2.appendChild(subject);
      if (message.hasAttachments) {
        row2.insertAdjacentHTML(
          "beforeend",
          `<svg class="message-item__attachment-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M8 12.5V7a4 4 0 0 1 8 0v7.5a2.5 2.5 0 0 1-5 0V8"/></svg>`
        );
      }

      btn.append(row1, row2);
      btn.addEventListener("click", () => openMessage(message.id, btn));
      li.appendChild(btn);
      el.messageList.appendChild(li);
    }

    // A message arriving during background polling gets a subtle highlight
    // (and the list a gentle settle animation) so the change is noticeable.
    const first = el.messageList.firstElementChild;
    if (first && first.dataset.messageId && first.dataset.messageId !== previousFirstId) {
      first.classList.add("is-new");
    }
  }

  // -----------------------------------------------------------------------
  // Message detail view
  // -----------------------------------------------------------------------
  async function openMessage(id, triggerEl) {
    lastFocusedBeforeDialog = triggerEl || document.activeElement;
    openMessageId = id;

    el.messageView.hidden = false;
    document.body.style.overflow = "hidden";
    el.messageViewSubject.textContent = "Loading…";
    el.messageViewBody.innerHTML = "";
    el.messageViewAttachments.hidden = true;
    el.messageViewClose.focus();

    document.addEventListener("keydown", onDialogKeydown);
    markMessageSeen(id);

    try {
      const detail = await api(`/api/mailbox/messages/${id}`);
      if (openMessageId !== id) return; // user navigated away before this resolved
      renderMessageDetail(detail);
    } catch (err) {
      el.messageViewSubject.textContent = "Couldn't load message";
      el.messageViewBody.textContent = friendlyErrorMessage(err);
    }
  }

  function renderMessageDetail(detail) {
    el.messageViewSubject.textContent = detail.subject || "(no subject)";
    el.messageViewFrom.textContent = formatSender(detail.senderName, detail.senderAddress);
    el.messageViewTo.textContent = detail.recipientAddress || mailbox.address;
    el.messageViewDate.textContent = formatAbsoluteTime(detail.createdAt);

    el.messageViewBody.innerHTML = "";
    if (detail.htmlBody) {
      renderHtmlBody(detail.htmlBody, false);
    } else {
      const pre = document.createElement("pre");
      pre.textContent = detail.textBody || "(this message has no content)";
      el.messageViewBody.appendChild(pre);
    }

    if (detail.attachments && detail.attachments.length > 0) {
      el.messageViewAttachments.hidden = false;
      el.messageViewAttachmentList.innerHTML = "";
      for (const attachment of detail.attachments) {
        el.messageViewAttachmentList.appendChild(renderAttachmentRow(attachment));
      }
    } else {
      el.messageViewAttachments.hidden = true;
    }
  }

  /**
   * Renders untrusted HTML email inside a sandboxed iframe.
   *
   * sandbox="" grants none of allow-scripts/allow-same-origin/allow-forms/
   * allow-popups, and the iframe's own document carries a strict CSP —
   * together these make any embedded script or handler inert regardless of
   * the (already defense-in-depth-sanitized) HTML content. Remote images
   * are blocked by default via the CSP's img-src (data: URIs still work,
   * since they can't be used for tracking) and only allowed after the user
   * explicitly asks to load them, matching the "tracking pixel" concern.
   */
  function renderHtmlBody(html, imagesAllowed) {
    el.messageViewBody.innerHTML = "";

    if (!imagesAllowed) {
      const loadImagesBtn = document.createElement("button");
      loadImagesBtn.type = "button";
      loadImagesBtn.className = "btn btn--ghost message-view__load-images";
      loadImagesBtn.textContent = "Load images";
      loadImagesBtn.addEventListener("click", () => {
        renderHtmlBody(html, true);
      });
      el.messageViewBody.appendChild(loadImagesBtn);
    }

    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("title", "Email content");
    const imgSrc = imagesAllowed ? "data: https:" : "data:";
    const csp = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; script-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none';`;
    iframe.srcdoc =
      `<!DOCTYPE html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
      `<style>body{font-family:sans-serif;color:#171a1f;margin:12px;word-break:break-word;} img{max-width:100%;}</style>` +
      `</head><body>${html}</body></html>`;
    el.messageViewBody.appendChild(iframe);
  }

  function renderAttachmentRow(attachment) {
    const li = document.createElement("li");

    const info = document.createElement("div");
    info.className = "attachment-info";
    info.insertAdjacentHTML(
      "afterbegin",
      `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 12.5V7a4 4 0 0 1 8 0v7.5a2.5 2.5 0 0 1-5 0V8"/></svg>`
    );
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = attachment.filename;
    const size = document.createElement("span");
    size.className = "attachment-size";
    size.textContent = formatBytes(attachment.sizeBytes);
    info.append(name, size);

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "btn btn--ghost";
    downloadBtn.textContent = "Download";
    downloadBtn.addEventListener("click", () => downloadAttachment(attachment, downloadBtn));

    li.append(info, downloadBtn);
    return li;
  }

  async function downloadAttachment(attachment, triggerBtn) {
    const originalLabel = triggerBtn.textContent;
    triggerBtn.disabled = true;
    triggerBtn.textContent = "Downloading…";
    try {
      const headers = new Headers({
        "X-Mailbox-Id": mailbox.id,
        Authorization: `Bearer ${mailbox.token}`,
      });
      const res = await fetch(`/api/attachments/${attachment.id}`, { headers });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = attachment.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      showToast("Couldn't download attachment");
    } finally {
      triggerBtn.disabled = false;
      triggerBtn.textContent = originalLabel;
    }
  }

  function closeMessageView() {
    if (el.messageView.hidden) return;
    el.messageView.hidden = true;
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onDialogKeydown);
    openMessageId = null;
    if (lastFocusedBeforeDialog && document.contains(lastFocusedBeforeDialog)) {
      lastFocusedBeforeDialog.focus();
    }
  }

  function onDialogKeydown(event) {
    if (event.key === "Escape") {
      closeMessageView();
      return;
    }
    if (event.key === "Tab") {
      trapFocus(event, el.messageViewPanel);
    }
  }

  function trapFocus(event, container) {
    const focusable = container.querySelectorAll(
      'button, [href], input, select, textarea, iframe, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function handleDeleteMessage() {
    if (!openMessageId) return;
    const id = openMessageId;
    el.messageViewDelete.disabled = true;
    try {
      await api(`/api/mailbox/messages/${id}`, { method: "DELETE" });
      messages = messages.filter((m) => m.id !== id);
      renderMessageList();
      closeMessageView();
      showToast("Message deleted");
    } catch (err) {
      showToast(friendlyErrorMessage(err));
    } finally {
      el.messageViewDelete.disabled = false;
    }
  }

  // -----------------------------------------------------------------------
  // Copy address
  // -----------------------------------------------------------------------
  async function handleCopy() {
    if (!mailbox) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(mailbox.address);
      } else {
        legacyCopy(mailbox.address);
      }
      flashCopySuccess();
    } catch {
      showToast("Couldn't copy — select and copy the address manually");
    }
  }

  function legacyCopy(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function flashCopySuccess() {
    el.copyBtnLabel.textContent = "Copied";
    el.copyBtn.classList.add("is-success");
    setTimeout(() => {
      el.copyBtnLabel.textContent = "Copy";
      el.copyBtn.classList.remove("is-success");
    }, 1500);
  }

  // -----------------------------------------------------------------------
  // Toast (non-intrusive, per spec §29 — not a modal/alert)
  // -----------------------------------------------------------------------
  let toastTimer = null;
  function showToast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
  }

  function friendlyErrorMessage(err) {
    if (err instanceof ApiError) {
      if (err.code === "RATE_LIMITED") return "Too many requests — please wait a moment.";
      return err.message || "Something went wrong.";
    }
    return "Something went wrong. Please try again.";
  }

  // -----------------------------------------------------------------------
  // Formatting helpers
  // -----------------------------------------------------------------------
  function formatSender(name, address) {
    if (name && address) return `${name} <${address}>`;
    return name || address || "Unknown sender";
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
  }

  function formatRelativeTime(timestampMs) {
    const diffSeconds = Math.round((timestampMs - Date.now()) / 1000);
    const abs = Math.abs(diffSeconds);

    if (abs < 60) return "just now";
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    if (abs < 3600) return rtf.format(Math.round(diffSeconds / 60), "minute");
    if (abs < 86400) return rtf.format(Math.round(diffSeconds / 3600), "hour");
    if (abs < 86400 * 6) return rtf.format(Math.round(diffSeconds / 86400), "day");
    return new Date(timestampMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function formatAbsoluteTime(timestampMs) {
    return new Date(timestampMs).toLocaleString(undefined, {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    });
  }

  // -----------------------------------------------------------------------
  // Wire up
  // -----------------------------------------------------------------------
  function init() {
    initTheme();
    initCustomForm();

    el.copyBtn.addEventListener("click", handleCopy);
    el.newAddressBtn.addEventListener("click", handleNewAddress);
    el.messageViewClose.addEventListener("click", closeMessageView);
    el.messageViewBackdrop.addEventListener("click", closeMessageView);
    el.messageViewDelete.addEventListener("click", handleDeleteMessage);

    initMailbox().catch((err) => {
      hideAddressSkeleton();
      el.addressText.hidden = false;
      el.addressText.textContent = "Couldn't create an address";
      showToast(friendlyErrorMessage(err));
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
