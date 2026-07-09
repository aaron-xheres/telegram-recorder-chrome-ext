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
  /** @type {MutationObserver|null} */
  var topbarObserver = null;
  /** @type {string} */
  var lastTopbarGroupId = '';

  const GROUP_NAME_SELECTORS = [
    '.sidebar-header.topbar .chat-info .peer-title',
    '.chat-info .peer-title',
    '.chat-info-title',
    '.chat-info .chat-info-title',
    '.topbar .peer-title',
    'title'
  ];
  const TOPBAR_SELECTOR = '.sidebar-header.topbar';
  const TOPBAR_PEER_ID_SELECTORS = [
    '.person-avatar[data-peer-id]',
    '.peer-title[data-peer-id]'
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
   * Extract the current chat/group peer ID from the top bar.
   * The top bar is unique and updated synchronously with navigation.
   * @returns {string|null}
   */
  function getTopbarGroupId() {
    const topbar = document.querySelector(TOPBAR_SELECTOR);
    if (!topbar) return null;
    for (const selector of TOPBAR_PEER_ID_SELECTORS) {
      const el = topbar.querySelector(selector);
      if (el?.dataset.peerId) return el.dataset.peerId;
    }
    return null;
  }

  /**
   * @returns {string|null}
   */
  function getGroupId() {
    // Prefer the top bar: it is unique and updates synchronously with chat
    // navigation, unlike the URL hash which can lag or miss SPA transitions.
    const topbarId = getTopbarGroupId();
    if (topbarId) return topbarId;

    // Fallback to the URL hash fragment.
    const rawHash = location.hash?.replace(/^#/, '') ?? '';
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
          continue;
        }
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

    // MP4/MOV: starts with a 4-byte size then "ftyp"
    if (buffer.byteLength > 11) {
      const ftyp = String.fromCharCode(...bytes.slice(4, 8));
      if (ftyp === 'ftyp') {
        const brand = String.fromCharCode(...bytes.slice(8, 12)).toLowerCase();
        if (brand.startsWith('qt')) return 'video/quicktime';
        return 'video/mp4';
      }
    }

    // WebM: 0x1A 0x45 0xDF 0xA3
    if (hex.startsWith('1a45dfa3')) return 'video/webm';

    // Ogg: "OggS"
    if (String.fromCharCode(...bytes.slice(0, 4)) === 'OggS') {
      return 'audio/ogg';
    }

    // WebP: "RIFF" at 0, "WEBP" at 8
    if (buffer.byteLength >= 12) {
      const riff = String.fromCharCode(...bytes.slice(0, 4));
      const webp = String.fromCharCode(...bytes.slice(8, 12));
      if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
    }

    return '';
  }

  /**
   * Reset the in-memory set of already-downloaded media GUIDs.
   * GUIDs are ephemeral (valid only for the current Telegram tab session),
   * so they are kept in memory only and not persisted to storage.
   */
  function resetDownloadedMediaGuids() {
    downloadedMediaGuids = new Map();
  }

  /**
   * Remember a newly downloaded GUID so it is not re-downloaded this session.
   * @param {string} guid
   * @param {string} filename
   */
  function registerDownloadedMediaGuid(guid, filename) {
    downloadedMediaGuids.set(guid, filename);
  }

  /**
   * Convert a Blob to a base64 data URL in the content script.
   * Sending an ArrayBuffer through chrome.runtime.sendMessage can be serialized
   * incorrectly; a string data URL survives reliably.
   * @param {Blob} blob
   * @returns {Promise<string>}
   */
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Compute a short, stable identifier for a string. Used for stream: URLs whose
   * full path is too long to be a filename.
   * @param {string} str
   * @returns {string}
   */
  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h).toString(16);
  }

  /**
   * Download a single media item to the background service worker.
   * Supports blob: URLs (same-origin page blobs) and Telegram stream: URLs.
   * Remote URLs (e.g. t.me links) are blocked by CORS and left as references.
   * @param {string} url
   * @param {string} groupId
   * @returns {Promise<string|null>} Relative path inside the group folder, e.g. "media/<guid>.ext".
   */
  async function downloadMediaItem(url, groupId) {
    if (!url.startsWith('blob:') && !url.startsWith('stream:')) {
      return null;
    }

    const guid = url.startsWith('stream:')
      ? hashString(url)
      : (url.split('/').pop() || 'unknown');
    if (downloadedMediaGuids.has(guid)) {
      const filename = downloadedMediaGuids.get(guid);
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
      // Always trust magic bytes over the blob's reported type. Telegram
      // sometimes reports image/png for GIFs or leaves the type empty.
      const mime = detectMimeFromBuffer(buffer) || blob.type || 'application/octet-stream';
      const ext = extFromMime(mime);
      const filename = ext ? `${guid}.${ext}` : guid;
      const dataUrl = await blobToDataUrl(blob);

      const dlResponse = await chrome.runtime.sendMessage({
        type: CONTENT_MSG.DOWNLOAD_MEDIA,
        groupId,
        filename,
        dataUrl
      });

      if (!dlResponse || !dlResponse.ok) {
        console.warn('[TelegramRecorder] background media download failed', url, dlResponse);
        return null;
      }

      registerDownloadedMediaGuid(guid, filename);
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
   * Wait for media-relevant <img>/<video> elements inside a bubble to finish
   * loading. Uses a MutationObserver to catch late-injected media and late-set
   * src attributes, resolving after a short quiet period once everything is
   * complete.
   * Avatars, emoji, and custom-emoji stickers are ignored so that a slow or
   * broken avatar/emoji image cannot block the actual media attachment.
   * @param {Element} bubble
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  function waitForMediaReady(bubble, timeoutMs = 3000) {
    return new Promise(resolve => {
      let quietTimer = null;
      let settled = false;

      // Same exclusion list as extractor.js; defined there but mirrored here
      // so this helper does not wait on avatar/emoji decorations.
      const excludeSelectors = [
        '.avatar',
        '.bubbles-group-avatar',
        '.bubble-name-forwarded-avatar',
        'custom-emoji-element',
        'custom-emoji-renderer-element',
        '.emoji',
        '.emoji-image'
      ].join(', ');

      function isMediaComplete() {
        const imgs = Array.from(bubble.querySelectorAll('img')).filter(img =>
          !img.closest(excludeSelectors)
        );
        const videos = Array.from(bubble.querySelectorAll('video')).filter(video =>
          !video.closest(excludeSelectors)
        );

        // Wait for images to have a src and finish loading.
        const imagesReady = imgs.every(img => {
          const src = img.currentSrc || img.src;
          if (!src) return false;
          return img.complete;
        });

        // Only wait for blob: videos to become ready. Stream URLs (e.g.
        // stream/...) may never fire metadata and are handled separately.
        const videosReady = videos.every(video => {
          const src = video.currentSrc || video.src;
          if (!src) return true;
          if (!src.startsWith('blob:')) return true;
          return video.readyState >= 1;
        });

        return imagesReady && videosReady;
      }

      function mediaChanged(mutations) {
        return mutations.some(mutation => {
          if (mutation.type === 'childList') {
            return Array.from(mutation.addedNodes).some(node => {
              if (node.nodeType !== Node.ELEMENT_NODE) return false;
              const el = /** @type {Element} */ (node);
              if (el.closest?.(excludeSelectors)) return false;
              return el.matches?.('img, video') || el.querySelector?.('img, video') != null;
            });
          }
          if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
            const target = mutation.target;
            return target.matches?.('img, video') && !target.closest?.(excludeSelectors);
          }
          return false;
        });
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
        if (mediaChanged(mutations)) {
          clearTimeout(quietTimer);
          tryResolve();
        }
      });

      observer.observe(bubble, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src']
      });
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
      // Re-extract media when the bubble reaches the front of the queue.
      // Telegram lazy-loads photos; the actual <img class="media-photo">
      // is only inserted/loaded once the bubble scrolls into view.
      if (bubbleHasMedia(bubble)) {
        bubble.scrollIntoView({ block: 'center', behavior: 'instant' });
        // Wait for lazy media elements to appear and finish loading.
        await waitForMediaReady(bubble, 3000);
        const reMedia = await extractMedia(bubble);
        if (reMedia.length > 0) {
          messageData.media = reMedia;
          messageData.mediaFiles = await downloadMessageMedia(reMedia, messageData.groupId);
        }
      }

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
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  /**
   * Determine whether a bubble likely contains standalone media attachments.
   * Checks both bubble-level classes and actual media wrappers/elements.
   * Custom-emoji stickers are excluded because they belong to the message text.
   * @param {Element} bubble
   * @returns {boolean}
   */
  function bubbleHasMedia(bubble) {
    const mediaClasses = ['photo', 'video', 'document', 'audio', 'voice', 'sticker', 'gif'];
    if (mediaClasses.some(cls => bubble.classList.contains(cls))) return true;

    // Look for real media wrappers/elements. Avoid catching sticker videos
    // inside custom-emoji elements — those are text decorations, not attachments.
    const mediaSelectors = [
      '.media-gif-wrapper',
      '.media-container',
      '.attachment',
      '.media-photo',
      '.media-video',
      'audio'
    ].join(', ');
    const candidates = bubble.querySelectorAll(mediaSelectors);
    return Array.from(candidates).some(el =>
      !el.closest('custom-emoji-element, custom-emoji-renderer-element')
    );
  }

  /**
   * @param {Element} bubble
   */
  async function processBubbleNode(bubble) {
    const mid = bubble.dataset.mid;
    if (!mid) return;
    // Ignore service messages (e.g. "X joined the group", pinned messages,
    // group name changes) that have no real sender or content to record.
    if (bubble.classList.contains('service')) return;
    if (baselineSet.has(mid)) return;
    if (recordedSet.has(mid)) return;

    // Add to recordedSet before the first await so concurrent callers (e.g. a
    // mutation and the safety scan) cannot both enter the extraction path for
    // the same message ID.
    recordedSet.add(mid);
    let messageData = await extract(bubble, currentSessionId);
    // Ensure every record in this session uses the same group identifier
    // (numeric peer ID or sanitized @username) as the manifest/folder.
    if (!messageData.groupId || messageData.groupId !== currentGroupId) {
      messageData.groupId = currentGroupId;
    }

    // If the bubble contains media, wait for any lazy-loaded/injected elements
    // (e.g. GIF videos inside .media-gif-wrapper) to settle and re-extract.
    // This is driven by DOM/network readiness rather than a fixed timer.
    if (bubbleHasMedia(bubble)) {
      await waitForMediaReady(bubble, 3000);
      const reMedia = await extractMedia(bubble);
      if (reMedia.length > 0) {
        messageData = { ...messageData, media: reMedia };
      }
    }

    messageData.mediaFiles = await downloadMessageMedia(messageData.media, currentGroupId);

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

    startTopbarObserver();
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
    stopTopbarObserver();

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
  }

  /**
   * Observe the top bar to detect chat navigation without polling.
   * The top bar is replaced when the user switches chats and removed when
   * no chat is selected, so watching its parent catches all transitions.
   */
  function startTopbarObserver() {
    stopTopbarObserver();
    lastTopbarGroupId = getTopbarGroupId() ?? '';

    const topbar = document.querySelector(TOPBAR_SELECTOR);
    if (!topbar) {
      // No chat open yet; watch the main/chat container for a topbar to appear.
      const container = document.querySelector('.main, .chat') || document.body;
      const observer = new MutationObserver(() => {
        const newTopbar = document.querySelector(TOPBAR_SELECTOR);
        if (newTopbar) {
          observer.disconnect();
          observeTopbarElement(newTopbar);
        }
      });
      observer.observe(container, { childList: true, subtree: true });
      topbarObserver = observer;
      return;
    }

    observeTopbarElement(topbar);
  }

  /**
   * Watch the topbar's parent for replacement/removal and the topbar itself
   * for attribute/subtree changes.
   * @param {Element} topbar
   */
  function observeTopbarElement(topbar) {
    const parent = topbar.parentElement;
    if (!parent) return;

    let stale = false;
    const observers = [];

    const notifyIfChanged = () => {
      if (stale) return;
      const newGroupId = getTopbarGroupId();
      if (newGroupId !== lastTopbarGroupId) {
        lastTopbarGroupId = newGroupId ?? '';
        onNavigation();
      }
    };

    const parentObserver = new MutationObserver(mutations => {
      let topbarChanged = false;
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        for (const node of mutation.removedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.matches(TOPBAR_SELECTOR)) {
            topbarChanged = true;
            break;
          }
        }
        if (!topbarChanged) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && node.matches(TOPBAR_SELECTOR)) {
              topbarChanged = true;
              break;
            }
          }
        }
      }
      if (!topbarChanged) return;

      // The observed topbar was replaced or removed; stop observing it and
      // re-attach to the new topbar if one exists.
      stale = true;
      observers.forEach(o => o.disconnect());
      startTopbarObserver();
      notifyIfChanged();
    });
    parentObserver.observe(parent, { childList: true });
    observers.push(parentObserver);

    const subtreeObserver = new MutationObserver(notifyIfChanged);
    subtreeObserver.observe(topbar, { childList: true, subtree: true, attributes: true });
    observers.push(subtreeObserver);

    topbarObserver = {
      disconnect() {
        observers.forEach(o => o.disconnect());
      }
    };
  }

  function stopTopbarObserver() {
    if (topbarObserver) {
      topbarObserver.disconnect();
      topbarObserver = null;
    }
  }

  // Keep popstate/hashchange as a lightweight backup; the topbar observer handles
  // the actual DOM transitions that SPA events sometimes miss.
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
    resetDownloadedMediaGuids();

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
