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
    const messageData = await extract(bubble, currentSessionId);
    // Ensure every record in this session uses the same group identifier
    // (numeric peer ID or sanitized @username) as the manifest/folder.
    if (!messageData.groupId || messageData.groupId !== currentGroupId) {
      messageData.groupId = currentGroupId;
    }
    console.log('[TelegramRecorder] queued new message', mid, messageData.posterName);
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
