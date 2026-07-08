// Content script orchestration for Telegram Web K recording.
(function () {
  'use strict';

  // eslint-disable-next-line no-undef
  var CONTENT_MSG = MESSAGE_TYPES;

  // Cleanup any previous instance (e.g. after extension reload + reinjection).
  if (globalThis.__telegramRecorderCleanup) {
    try {
      globalThis.__telegramRecorderCleanup();
    } catch (err) {
      console.error('[TelegramRecorder] previous cleanup failed', err);
    }
  }

  /**
   * @typedef {Object} QueueItem
   * @property {Element} bubble
   * @property {import('./extractor.js').MessageRecord} messageData
   */

  // In-memory recording state. Using var so reinjection does not throw.
  var isRecording = false;
  var currentSessionId = '';
  var currentGroupId = '';
  var baselineSet = new Set();
  var recordedSet = new Set();

  var isProcessing = false;
  var navPollInterval = null;
  var lastLocationHref = location.href;
  var eventAbortController = new AbortController();
  var downloadMediaEnabled = true;
  /** @type {Map<string, string>} */
  var downloadedMediaGuids = new Map();

  /** @type {MutationObserver|null} */
  var bubblesObserver = null;
  /** @type {number|null} */
  var scanInterval = null;
  /** @type {QueueItem[]} */
  var queue = [];

  const GROUP_NAME_SELECTORS = [
    '.chat-info .peer-title',
    '.chat-info-title',
    '.chat-info .chat-info-title',
    '.topbar .peer-title',
    'title'
  ];
  const BUBBLES_SELECTOR = '.bubbles';
  const BUBBLE_SELECTOR = '.bubble';

  const BUBBLES_CONTAINER_SELECTORS = [
    '.bubbles',
    '.bubbles-inner',
    '.chat-background',
    '.scrollable.scrollable-y',
    '[class*="bubbles"]'
  ];

  // ---------------------------------------------------------------------------
  // Cleanup registration
  // ---------------------------------------------------------------------------

  function registerCleanup(fn) {
    globalThis.__telegramRecorderCleanup = fn;
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  /**
   * @returns {Set<string>}
   */
  function buildBaselineSet() {
    const set = new Set();
    document.querySelectorAll(`${BUBBLE_SELECTOR}[data-mid]`).forEach(el => {
      if (el.dataset.mid) set.add(el.dataset.mid);
    });
    return set;
  }

  /**
   * @returns {string|null}
   */
  function getGroupId() {
    // Telegram Web K puts the current chat identifier in the URL.
    // Prefer it because the DOM may lag behind navigation.
    const rawHash = location.hash?.replace(/^#/, '') ?? '';
    // Hashes may contain query params (e.g. #@username?folder=...).
    const hash = rawHash.split('?')[0];

    if (hash) {
      if (/^-?\d+$/.test(hash)) {
        return hash;
      }
      const usernameMatch = hash.match(/^@([a-zA-Z0-9_]+)/);
      if (usernameMatch) {
        return '@' + usernameMatch[1].replace(/[^a-zA-Z0-9_]/g, '_');
      }
      // Telegram sometimes uses #?tgaddr=tg://resolve?domain=username
      const tgaddrMatch = rawHash.match(/tgaddr=tg:\/\/resolve\?domain=([a-zA-Z0-9_]+)/);
      if (tgaddrMatch) {
        return '@' + tgaddrMatch[1].replace(/[^a-zA-Z0-9_]/g, '_');
      }
    }

    const usernameMatch = location.pathname.match(/@([a-zA-Z0-9_]+)/);
    if (usernameMatch) {
      return '@' + usernameMatch[1].replace(/[^a-zA-Z0-9_]/g, '_');
    }

    // Fallback to the bubbles container's data-peer-id.
    const bubbles = document.querySelector(BUBBLES_SELECTOR);
    if (bubbles?.dataset.peerId) {
      return bubbles.dataset.peerId;
    }

    return null;
  }

  /**
   * Find the scroll container that holds message bubbles.
   * Telegram's DOM class names vary, so we try several candidates.
   * @returns {Element|null}
   */
  function getBubblesContainer() {
    for (const selector of BUBBLES_CONTAINER_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) {
        // Ensure we don't accidentally grab a small inner element.
        if (selector === '[class*="bubbles"]' && !el.querySelector('.bubble') && !el.classList.contains('bubbles')) {
          console.log('[TelegramRecorder] skipping generic bubbles match', selector, el.className);
          continue;
        }
        console.log('[TelegramRecorder] found bubbles container via', selector, el.className);
        return el;
      }
    }
    console.warn('[TelegramRecorder] no bubbles container found with known selectors');
    return null;
  }

  /**
   * @returns {string|null}
   */
  function getGroupName() {
    // Use generic chat-info/title selectors. Avoid peer-id-specific selectors
    // because the DOM may still contain elements from a previously viewed chat.
    for (const selector of GROUP_NAME_SELECTORS) {
      const title = document.querySelector(selector);
      const text = title?.textContent?.trim();
      if (text) return text;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Media download helpers
  // ---------------------------------------------------------------------------

  /**
   * Map common MIME types to file extensions.
   * @param {string} mime
   * @returns {string}
   */
  function extFromMime(mime) {
    const map = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'application/pdf': 'pdf'
    };
    return map[mime?.toLowerCase()] ?? '';
  }

  /**
   * Detect MIME type from file magic bytes when the browser/OS cannot.
   * @param {ArrayBuffer} buffer
   * @returns {string}
   */
  function detectMimeFromBuffer(buffer) {
    if (!buffer || buffer.byteLength < 8) return '';
    const bytes = new Uint8Array(buffer);
    const hex = Array.from(bytes.slice(0, 8))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (hex.startsWith('ffd8ff')) return 'image/jpeg';
    if (hex.startsWith('89504e47')) return 'image/png';
    if (hex.startsWith('47494638')) return 'image/gif';
    if (hex.startsWith('25504446')) return 'application/pdf';
    if (hex.startsWith('000000') && bytes.length > 11) {
      const ftyp = String.fromCharCode(...bytes.slice(4, 8));
      if (ftyp === 'ftyp') return 'video/mp4';
    }

    // WebP: "RIFF" at 0, "WEBP" at 8
    if (buffer.byteLength >= 12) {
      const riff = String.fromCharCode(...bytes.slice(0, 4));
      const webp = String.fromCharCode(...bytes.slice(8, 12));
      if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
    }

    return '';
  }

  const DOWNLOADED_MEDIA_KEY = 'downloadedMedia';

  /**
   * Load the set of already-downloaded media GUIDs from storage.
   */
  async function loadDownloadedMediaGuids() {
    try {
      const result = await chrome.storage.local.get(DOWNLOADED_MEDIA_KEY);
      const map = result[DOWNLOADED_MEDIA_KEY] ?? {};
      downloadedMediaGuids = new Map(Object.entries(map));
    } catch (err) {
      console.error('[TelegramRecorder] failed to load downloaded media guids', err);
      downloadedMediaGuids = new Map();
    }
  }

  /**
   * Persist a newly downloaded GUID so it is not re-downloaded this session.
   * @param {string} guid
   * @param {string} filename
   */
  async function persistDownloadedMediaGuid(guid, filename) {
    try {
      const result = await chrome.storage.local.get(DOWNLOADED_MEDIA_KEY);
      const map = result[DOWNLOADED_MEDIA_KEY] ?? {};
      map[guid] = filename;
      await chrome.storage.local.set({ [DOWNLOADED_MEDIA_KEY]: map });
    } catch (err) {
      console.error('[TelegramRecorder] failed to persist downloaded media guid', guid, err);
    }
  }

  /**
   * Download a single media blob to the background service worker.
   * Only blob: URLs are downloaded locally; remote URLs (e.g. t.me links)
   * would be blocked by CORS and are left as references in the media array.
   * @param {string} url
   * @param {string} groupId
   * @returns {Promise<string|null>} Relative path inside the group folder, e.g. "media/<guid>.ext".
   */
  async function downloadMediaItem(url, groupId) {
    if (!url.startsWith('blob:')) {
      console.log('[TelegramRecorder] skipping non-blob media URL', url);
      return null;
    }

    const guid = url.split('/').pop() || 'unknown';
    if (downloadedMediaGuids.has(guid)) {
      const filename = downloadedMediaGuids.get(guid);
      console.log('[TelegramRecorder] media already downloaded, skipping', guid);
      return `media/${filename}`;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn('[TelegramRecorder] failed to fetch media', url, response.status);
        return null;
      }
      const blob = await response.blob();
      const buffer = await blob.arrayBuffer();
      const mime = blob.type && blob.type !== 'application/octet-stream'
        ? blob.type
        : detectMimeFromBuffer(buffer);
      const ext = extFromMime(mime);
      const filename = ext ? `${guid}.${ext}` : guid;

      const dlResponse = await chrome.runtime.sendMessage({
        type: CONTENT_MSG.DOWNLOAD_MEDIA,
        groupId,
        filename,
        mimeType: mime || blob.type || 'application/octet-stream',
        buffer
      });

      if (!dlResponse || !dlResponse.ok) {
        console.warn('[TelegramRecorder] background media download failed', url, dlResponse);
        return null;
      }

      downloadedMediaGuids.set(guid, filename);
      persistDownloadedMediaGuid(guid, filename).catch(err => {
        console.warn('[TelegramRecorder] failed to persist downloaded guid', guid, err);
      });
      return `media/${filename}`;
    } catch (err) {
      console.warn('[TelegramRecorder] downloadMediaItem failed', url, err);
      return null;
    }
  }

  /**
   * Download all media attachments for a message when the setting is enabled.
   * @param {string[]} media
   * @param {string} groupId
   * @returns {Promise<string[]>}
   */
  async function downloadMessageMedia(media, groupId) {
    if (!downloadMediaEnabled || !media || media.length === 0) return [];
    const results = await Promise.all(media.map(url => downloadMediaItem(url, groupId)));
    return results.filter(Boolean);
  }

  /**
   * Load the download-media preference from storage.
   */
  async function loadDownloadMediaSetting() {
    try {
      const result = await chrome.storage.local.get('downloadMedia');
      downloadMediaEnabled = result.downloadMedia !== false;
    } catch (err) {
      console.error('[TelegramRecorder] failed to load download media setting', err);
      downloadMediaEnabled = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Media readiness helper
  // ---------------------------------------------------------------------------

  /**
   * Wait for all <img>/<video> elements inside a bubble to finish loading.
   * Uses a MutationObserver to catch late-injected media and resolves after a
   * short quiet period once everything is complete.
   * @param {Element} bubble
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  function waitForMediaReady(bubble, timeoutMs = 3000) {
    return new Promise(resolve => {
      const deadline = Date.now() + timeoutMs;
      let quietTimer = null;
      let settled = false;

      function isMediaComplete() {
        const imgs = bubble.querySelectorAll('img');
        const videos = bubble.querySelectorAll('video');
        return (
          Array.from(imgs).every(img => img.complete) &&
          Array.from(videos).every(video => video.readyState >= 1)
        );
      }

      function hasAddedMedia(mutations) {
        return mutations.some(mutation =>
          Array.from(mutation.addedNodes).some(node => {
            if (node.nodeType !== Node.ELEMENT_NODE) return false;
            const el = /** @type {Element} */ (node);
            return el.matches?.('img, video') || el.querySelector?.('img, video') != null;
          })
        );
      }

      function tryResolve() {
        if (settled) return;
        if (!isMediaComplete()) return;
        clearTimeout(quietTimer);
        quietTimer = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          resolve();
        }, 300);
      }

      const observer = new MutationObserver(mutations => {
        if (hasAddedMedia(mutations)) {
          clearTimeout(quietTimer);
          tryResolve();
        }
      });

      observer.observe(bubble, { childList: true, subtree: true });
      tryResolve();

      window.setTimeout(() => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(quietTimer);
        resolve();
      }, timeoutMs);
    });
  }

  // ---------------------------------------------------------------------------
  // Queue / screenshot pipeline
  // ---------------------------------------------------------------------------

  /**
   * @param {Element} bubble
   * @param {import('./extractor.js').MessageRecord} messageData
   */
  function enqueue(bubble, messageData) {
    queue.push({ bubble, messageData });
    if (!isProcessing) processNext();
  }

  async function processNext() {
    if (queue.length === 0) {
      isProcessing = false;
      return;
    }
    isProcessing = true;
    const { bubble, messageData } = queue.shift();

    try {
      const croppedDataUrl = await captureScreenshot(bubble);

      if (!croppedDataUrl) {
        messageData.screenshotFile = null;
        console.warn('[TelegramRecorder] screenshot failed or skipped for message', messageData?.messageId, '- JSON will still be saved');
      } else {
        console.log('[TelegramRecorder] captured screenshot for message', messageData?.messageId);
      }

      await chrome.runtime.sendMessage({
        type: CONTENT_MSG.SAVE_FILES,
        messageData,
        croppedDataUrl
      });
      console.log('[TelegramRecorder] saved message', messageData?.messageId);
    } catch (err) {
      console.error('[TelegramRecorder] processNext failed for message', messageData?.messageId, err);
    }

    processNext();
  }

  // ---------------------------------------------------------------------------
  // Mutation handling
  // ---------------------------------------------------------------------------

  /**
   * Process all bubble elements inside (or equal to) an added node.
   * @param {Node} node
   */
  function processAddedNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return 0;
    const el = /** @type {Element} */ (node);
    let count = 0;

    if (el.classList.contains('bubble')) {
      processBubbleNode(el);
      count++;
    }

    if (el.querySelectorAll) {
      const bubbles = el.querySelectorAll('.bubble');
      bubbles.forEach(processBubbleNode);
      count += bubbles.length;
    }

    return count;
  }

  /**
   * Catch new messages anywhere inside the bubbles container.
   * Public groups sometimes insert .bubble nodes directly or wrap them differently,
   * so we observe the full subtree rather than only direct children.
   * @param {MutationRecord[]} mutations
   */
  function handleBubblesMutations(mutations) {
    try {
      let detected = 0;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          detected += processAddedNode(node);
        }
      }
      if (detected > 0) {
        console.log('[TelegramRecorder] mutation detected', detected, 'bubble(s)');
      }
    } catch (err) {
      console.error('[TelegramRecorder] mutation handler error', err);
    }
  }

  /**
   * Periodic safety scan: process any .bubble[data-mid] that is not yet recorded.
   * This catches messages that were inserted while the observer was not attached
   * (e.g. the .bubbles container was recreated by Telegram's router).
   */
  function scanForMissedBubbles() {
    if (!isRecording) return;
    let detected = 0;
    document.querySelectorAll('.bubble[data-mid]').forEach(bubble => {
      const mid = bubble.dataset.mid;
      if (mid && !baselineSet.has(mid) && !recordedSet.has(mid)) {
        processBubbleNode(bubble);
        detected++;
      }
    });
    if (detected > 0) {
      console.log('[TelegramRecorder] scan caught', detected, 'missed bubble(s)');
    }
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  /**
   * @param {Element} bubble
   */
  async function processBubbleNode(bubble) {
    const mid = bubble.dataset.mid;
    if (!mid) {
      console.log('[TelegramRecorder] skipped bubble without data-mid (system/service message)');
      return;
    }
    if (baselineSet.has(mid)) {
      console.log('[TelegramRecorder] skipped baseline message', mid);
      return;
    }
    if (recordedSet.has(mid)) {
      console.log('[TelegramRecorder] skipped already-recorded message', mid);
      return;
    }

    recordedSet.add(mid);
    let messageData = await extract(bubble, currentSessionId);
    // Ensure every record in this session uses the same group identifier
    // (numeric peer ID or sanitized @username) as the manifest/folder.
    if (!messageData.groupId || messageData.groupId !== currentGroupId) {
      messageData.groupId = currentGroupId;
    }

    // If the bubble looks like it should have media but none was found, wait
    // for the actual <img>/<video> elements to be injected and loaded before
    // saving. This is driven by DOM/network readiness rather than a fixed timer.
    const looksLikeMedia = ['photo', 'video', 'document', 'audio', 'voice', 'sticker', 'gif'].some(cls =>
      bubble.classList.contains(cls)
    );
    if (looksLikeMedia && (messageData.media?.length ?? 0) === 0) {
      await waitForMediaReady(bubble, 3000);
      const reMedia = await extractMedia(bubble);
      if (reMedia.length > 0) {
        messageData = { ...messageData, media: reMedia };
      }
    }

    messageData.mediaFiles = await downloadMessageMedia(messageData.media, currentGroupId);

    console.log('[TelegramRecorder] queued new message', mid, messageData.posterName, {
      media: messageData.media?.length,
      mediaFiles: messageData.mediaFiles?.length
    });
    enqueue(bubble, messageData);
  }

  // ---------------------------------------------------------------------------
  // Recording lifecycle
  // ---------------------------------------------------------------------------

  /**
   * @param {string} sessionId
   * @param {string} [groupId]
   */
  function startRecording(sessionId, groupId) {
    const bubbles = getBubblesContainer();
    if (!bubbles) {
      throw new Error('No bubbles container found');
    }

    isRecording = true;
    currentSessionId = sessionId;
    currentGroupId = groupId || getGroupId() || '';
    baselineSet = buildBaselineSet();
    recordedSet = new Set();

    // Observe the entire bubbles subtree so we catch messages regardless of whether
    // Telegram wraps them in .bubbles-group, inserts them directly, or uses other wrappers.
    bubblesObserver = new MutationObserver(handleBubblesMutations);
    bubblesObserver.observe(bubbles, { childList: true, subtree: true });

    // Safety net: re-scan the DOM every few seconds for any bubble we missed.
    scanInterval = window.setInterval(scanForMissedBubbles, 3000);

    startNavPolling();
    console.log('[TelegramRecorder] started recording', {
      sessionId,
      groupId: currentGroupId,
      baseline: baselineSet.size,
      container: bubbles.className
    });
  }

  function stopRecording() {
    isRecording = false;
    currentSessionId = '';
    currentGroupId = '';

    if (bubblesObserver) {
      bubblesObserver.disconnect();
      bubblesObserver = null;
    }
    if (scanInterval !== null) {
      window.clearInterval(scanInterval);
      scanInterval = null;
    }

    baselineSet.clear();
    recordedSet.clear();
    queue = [];
    isProcessing = false;
    stopNavPolling();

    console.log('[TelegramRecorder] stopped recording');
  }

  function stopRecordingAndNotify() {
    stopRecording();
    chrome.runtime.sendMessage({ type: CONTENT_MSG.AUTO_STOPPED }).catch(err => {
      console.error('[TelegramRecorder] failed to send AUTO_STOPPED', err);
    });
  }

  // ---------------------------------------------------------------------------
  // Chat navigation auto-stop
  // ---------------------------------------------------------------------------

  function onNavigation() {
    if (!isRecording) return;
    const newGroupId = getGroupId();
    if (newGroupId && newGroupId !== currentGroupId) {
      console.log('[TelegramRecorder] chat changed, auto-stopping', {
        from: currentGroupId,
        to: newGroupId
      });
      stopRecordingAndNotify();
    }
    lastLocationHref = location.href;
  }

  function startNavPolling() {
    stopNavPolling();
    lastLocationHref = location.href;
    navPollInterval = window.setInterval(() => {
      if (location.href !== lastLocationHref) {
        onNavigation();
      }
    }, 500);
  }

  function stopNavPolling() {
    if (navPollInterval !== null) {
      window.clearInterval(navPollInterval);
      navPollInterval = null;
    }
  }

  window.addEventListener('popstate', onNavigation, { signal: eventAbortController.signal });
  window.addEventListener('hashchange', onNavigation, { signal: eventAbortController.signal });

  // ---------------------------------------------------------------------------
  // Runtime messaging
  // ---------------------------------------------------------------------------

  function onRuntimeMessage(message, sender, sendResponse) {
    if (!message || typeof message.type !== 'string') {
      sendResponse({ ok: false, error: 'Invalid message' });
      return false;
    }

    switch (message.type) {
      case CONTENT_MSG.GET_GROUP_INFO: {
        const info = { ok: true, groupId: getGroupId(), groupName: getGroupName() };
        console.log('[TelegramRecorder] GET_GROUP_INFO', location.href, info);
        sendResponse(info);
        break;
      }

      case CONTENT_MSG.START_RECORDING: {
        try {
          startRecording(message.sessionId, message.groupId);
          sendResponse({ ok: true });
        } catch (err) {
          console.error('[TelegramRecorder] START_RECORDING failed', err);
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }

      case CONTENT_MSG.STOP_RECORDING: {
        stopRecording();
        sendResponse({ ok: true });
        break;
      }

      case CONTENT_MSG.PING: {
        sendResponse({ ok: true, type: CONTENT_MSG.PONG });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'Unknown message type: ' + message.type });
    }

    return false;
  }

  if (globalThis.__telegramRecorderMessageListener) {
    chrome.runtime.onMessage.removeListener(globalThis.__telegramRecorderMessageListener);
  }
  globalThis.__telegramRecorderMessageListener = onRuntimeMessage;
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  // ---------------------------------------------------------------------------
  // Rehydration on script load
  // ---------------------------------------------------------------------------

  (async function rehydrate() {
    await loadDownloadMediaSetting();
    await loadDownloadedMediaGuids();

    try {
      const response = await chrome.runtime.sendMessage({ type: CONTENT_MSG.GET_SESSION });
      const session = response?.session;
      if (session?.sessionId) {
        try {
          startRecording(session.sessionId, session.groupId);
        } catch (err) {
          console.error('[TelegramRecorder] failed to rehydrate recording', err);
          stopRecordingAndNotify();
        }
      }
    } catch (err) {
      console.error('[TelegramRecorder] session rehydration failed', err);
    }
  })();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.downloadMedia) {
      downloadMediaEnabled = changes.downloadMedia.newValue !== false;
    }
  });

  // ---------------------------------------------------------------------------
  // Cleanup registration for future reinjection
  // ---------------------------------------------------------------------------

  registerCleanup(() => {
    stopRecording();
    eventAbortController.abort();
    if (globalThis.__telegramRecorderMessageListener) {
      chrome.runtime.onMessage.removeListener(globalThis.__telegramRecorderMessageListener);
      globalThis.__telegramRecorderMessageListener = null;
    }
  });

})();
