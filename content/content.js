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
  /** @type {MutationObserver[]} */
  var groupObservers = [];
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
    '[class*="bubbles"]',
    '.chat-background',
    '.scrollable.scrollable-y'
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
    // Prefer the bubbles container's data-peer-id when available.
    const bubbles = document.querySelector(BUBBLES_SELECTOR);
    if (bubbles?.dataset.peerId) {
      return bubbles.dataset.peerId;
    }

    // Look for any other chat-level peer-id element.
    const chatPeer = document.querySelector('[data-peer-id]');
    const chatPeerId = chatPeer?.dataset.peerId;
    if (chatPeerId && /^-?\d+$/.test(chatPeerId)) {
      return chatPeerId;
    }

    // Fallback: Telegram Web K puts the current chat peer ID in the URL hash.
    const hash = location.hash?.replace(/^#/, '');
    if (hash && /^-?\d+$/.test(hash)) {
      return hash;
    }

    // Fallback for public group/channel URLs like /k/@groupname.
    const usernameMatch = location.pathname.match(/@([a-zA-Z0-9_]+)/);
    if (usernameMatch) {
      return '@' + usernameMatch[1].replace(/[^a-zA-Z0-9_]/g, '_');
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
        console.log('[TelegramRecorder] found bubbles container via', selector);
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
    const groupId = getGroupId();

    // Prefer elements explicitly tied to the current chat peer ID.
    if (groupId) {
      const peerSelectors = [
        `.peer-title[data-peer-id="${groupId}"]`,
        `[data-peer-id="${groupId}"] .peer-title`,
        `.chat-info [data-peer-id="${groupId}"] .peer-title`
      ];
      for (const selector of peerSelectors) {
        const title = document.querySelector(selector);
        const text = title?.textContent?.trim();
        if (text) return text;
      }
    }

    // Fallback to generic chat-info/title selectors.
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
   * @param {MutationRecord[]} mutations
   */
  function handleMutations(mutations) {
    try {
      let detected = 0;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          if (node.classList.contains('bubble')) {
            processBubbleNode(node);
            detected++;
            continue;
          }

          if (node.querySelectorAll) {
            const bubbles = node.querySelectorAll('.bubble');
            bubbles.forEach(processBubbleNode);
            detected += bubbles.length;
          }
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
   * Observe a single bubbles-group for new child bubbles.
   * @param {Element} group
   */
  function observeGroup(group) {
    if (!group || group.__telegramRecorderObserved) return;
    group.__telegramRecorderObserved = true;
    const obs = new MutationObserver(handleMutations);
    obs.observe(group, { childList: true });
    groupObservers.push(obs);
  }

  /**
   * Handle new bubbles-groups added to the main container.
   * @param {MutationRecord[]} mutations
   */
  function handleBubblesContainerMutations(mutations) {
    try {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          if (node.classList.contains('bubbles-group')) {
            observeGroup(node);
            node.querySelectorAll('.bubble').forEach(processBubbleNode);
            continue;
          }

          if (node.querySelectorAll) {
            node.querySelectorAll('.bubbles-group').forEach(group => {
              observeGroup(group);
              group.querySelectorAll('.bubble').forEach(processBubbleNode);
            });
          }
        }
      }
    } catch (err) {
      console.error('[TelegramRecorder] container mutation handler error', err);
    }
  }

  /**
   * @param {Element} bubble
   */
  function processBubbleNode(bubble) {
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
    const messageData = extract(bubble, currentSessionId);
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
   */
  function startRecording(sessionId) {
    const bubbles = getBubblesContainer();
    if (!bubbles) {
      throw new Error('No bubbles container found');
    }

    isRecording = true;
    currentSessionId = sessionId;
    currentGroupId = getGroupId() ?? '';
    baselineSet = buildBaselineSet();
    recordedSet = new Set();

    // Observe existing groups.
    bubbles.querySelectorAll('.bubbles-group').forEach(observeGroup);

    // Observe the container for new groups (no subtree — avoids interfering with Telegram internals).
    bubblesObserver = new MutationObserver(handleBubblesContainerMutations);
    bubblesObserver.observe(bubbles, { childList: true });

    startNavPolling();
    console.log('[TelegramRecorder] started recording', { sessionId, groupId: currentGroupId });
  }

  function stopRecording() {
    isRecording = false;
    currentSessionId = '';
    currentGroupId = '';

    if (bubblesObserver) {
      bubblesObserver.disconnect();
      bubblesObserver = null;
    }
    groupObservers.forEach(obs => obs.disconnect());
    groupObservers = [];
    document.querySelectorAll('.bubbles-group').forEach(g => {
      g.__telegramRecorderObserved = false;
    });

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
        console.log('[TelegramRecorder] GET_GROUP_INFO', info);
        sendResponse(info);
        break;
      }

      case CONTENT_MSG.START_RECORDING: {
        try {
          startRecording(message.sessionId);
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

  chrome.storage.local.get(['recording', 'currentSessionId', 'currentGroupId']).then(state => {
    if (state.recording && state.currentSessionId) {
      try {
        startRecording(state.currentSessionId);
        currentGroupId = state.currentGroupId ?? currentGroupId;
      } catch (err) {
        console.error('[TelegramRecorder] failed to rehydrate recording', err);
        stopRecordingAndNotify();
      }
    }
  }).catch(err => {
    console.error('[TelegramRecorder] storage read failed', err);
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
