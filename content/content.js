// Content script orchestration for Telegram Web K recording.
(function () {
  'use strict';

  // Guard against duplicate injection (e.g. popup reinjection fallback).
  if (globalThis.__telegramRecorderContentLoaded) {
    console.log('[TelegramRecorder] content script already loaded; skipping duplicate injection');
    return;
  }
  globalThis.__telegramRecorderContentLoaded = true;

  // eslint-disable-next-line no-undef
  var CONTENT_MSG = MESSAGE_TYPES;

/**
 * @typedef {Object} QueueItem
 * @property {Element} bubble
 * @property {import('./extractor.js').MessageRecord} messageData
 */

// In-memory recording state.
let isRecording = false;
let currentSessionId = '';
let currentGroupId = '';
let baselineSet = new Set();
let recordedSet = new Set();
let observer = null;
/** @type {QueueItem[]} */
let queue = [];
let isProcessing = false;
let navPollInterval = null;
let lastLocationHref = location.href;

const GROUP_NAME_SELECTORS = [
  '.chat-info .peer-title',
  '.chat-info-title',
  '.chat-info .chat-info-title',
  '.topbar .peer-title',
  'title'
];
const BUBBLES_SELECTOR = '.bubbles';
const BUBBLE_SELECTOR = '.bubble';

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
  const bubbles = document.querySelector(BUBBLES_SELECTOR);
  return bubbles?.dataset.peerId ?? null;
}

/**
 * @returns {string|null}
 */
function getGroupName() {
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
    // Screenshot pipeline is implemented in screenshot.js (Phase 4).
    const croppedDataUrl = await captureScreenshot(bubble);

    if (!croppedDataUrl) {
      // Screenshot failed or pipeline not yet fully wired — still persist JSON record.
      messageData.screenshotFile = null;
    }

    await chrome.runtime.sendMessage({
      type: CONTENT_MSG.SAVE_FILES,
      messageData,
      croppedDataUrl
    });
  } catch (err) {
    console.error('[TelegramRecorder] processNext failed for message', messageData?.messageId, err);
  }

  // Continue with next queued item.
  processNext();
}

// ---------------------------------------------------------------------------
// Mutation handling
// ---------------------------------------------------------------------------

/**
 * @param {MutationRecord[]} mutations
 */
function handleMutations(mutations) {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      // Scenario B: direct bubble addition.
      if (node.classList.contains('bubble')) {
        processBubbleNode(node);
        continue;
      }

      // Scenario A: new bubbles-group containing bubbles.
      if (node.querySelectorAll) {
        node.querySelectorAll('.bubble').forEach(processBubbleNode);
      }
    }
  }
}

/**
 * @param {Element} bubble
 */
function processBubbleNode(bubble) {
  const mid = bubble.dataset.mid;
  if (!mid) return; // system message
  if (baselineSet.has(mid)) return; // existed before recording started
  if (recordedSet.has(mid)) return; // already processed

  recordedSet.add(mid);
  const messageData = extract(bubble, currentSessionId);
  enqueue(bubble, messageData);
}

// ---------------------------------------------------------------------------
// Recording lifecycle
// ---------------------------------------------------------------------------

/**
 * @param {string} sessionId
 */
function startRecording(sessionId) {
  const bubbles = document.querySelector(BUBBLES_SELECTOR);
  if (!bubbles) {
    throw new Error('No .bubbles container found');
  }

  isRecording = true;
  currentSessionId = sessionId;
  currentGroupId = getGroupId() ?? '';
  baselineSet = buildBaselineSet();
  recordedSet = new Set();

  observer = new MutationObserver(handleMutations);
  observer.observe(bubbles, { childList: true, subtree: true });

  startNavPolling();
  console.log('[TelegramRecorder] started recording', { sessionId, groupId: currentGroupId });
}

function stopRecording() {
  isRecording = false;
  currentSessionId = '';
  currentGroupId = '';

  if (observer) {
    observer.disconnect();
    observer = null;
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

window.addEventListener('popstate', onNavigation);
window.addEventListener('hashchange', onNavigation);

// ---------------------------------------------------------------------------
// Runtime messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    sendResponse({ ok: false, error: 'Invalid message' });
    return false;
  }

  switch (message.type) {
    case CONTENT_MSG.GET_GROUP_INFO: {
      sendResponse({
        ok: true,
        groupId: getGroupId(),
        groupName: getGroupName()
      });
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

    default:
      sendResponse({ ok: false, error: 'Unknown message type: ' + message.type });
  }

  return false;
});

// ---------------------------------------------------------------------------
// Rehydration on script load
// ---------------------------------------------------------------------------

chrome.storage.local.get(['recording', 'currentSessionId', 'currentGroupId']).then(state => {
  if (state.recording && state.currentSessionId) {
    // Reattach observer. If the group has changed since the service worker last ran,
    // the nav polling will detect the mismatch and auto-stop.
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

})();
