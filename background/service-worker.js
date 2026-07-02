// Background service worker for Telegram Message Recorder.
// Coordinates state, storage, downloads, and messaging between popup and content scripts.

importScripts('../shared/messages.js');

// eslint-disable-next-line no-undef
const MSG = MESSAGE_TYPES;

/**
 * In-memory state rehydrated from storage on service worker startup.
 * @typedef {Object} ServiceState
 * @property {boolean} recording
 * @property {string|null} currentSessionId
 * @property {string|null} currentGroupId
 * @property {string|null} currentGroupName
 */

/** @type {ServiceState} */
let state = {
  recording: false,
  currentSessionId: null,
  currentGroupId: null,
  currentGroupName: null
};

/** @type {string[]} */
let recordedSet = [];

const STORAGE_LOCAL_KEYS = [
  'recording',
  'currentSessionId',
  'currentGroupId',
  'currentGroupName'
];

const STORAGE_SESSION_KEY = 'recordedSet';

/**
 * Convert an object to a data URL suitable for chrome.downloads.download().
 * @param {Object} obj
 * @returns {string}
 */
function jsonDataUrl(obj) {
  return 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(obj, null, 2));
}

/**
 * Persist the in-memory state to chrome.storage.local.
 */
async function persistState() {
  await chrome.storage.local.set({
    recording: state.recording,
    currentSessionId: state.currentSessionId,
    currentGroupId: state.currentGroupId,
    currentGroupName: state.currentGroupName
  });
}

/**
 * Clear recording state in memory and storage, but preserve other settings.
 */
async function clearRecordingState() {
  state.recording = false;
  state.currentSessionId = null;
  state.currentGroupId = null;
  state.currentGroupName = null;
  recordedSet = [];
  await persistState();
  await chrome.storage.session.set({ recordedSet: [] });
}

/**
 * Find the active Telegram Web K tab to notify during start/stop.
 * @returns {Promise<number|null>}
 */
async function findActiveTelegramKTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs.find(t => t.url && t.url.startsWith('https://web.telegram.org/k/'));
    return tab?.id ?? null;
  } catch (err) {
    console.error('[TelegramRecorder] findActiveTelegramKTab failed', err);
    return null;
  }
}

/**
 * Download the session manifest file.
 * @param {string} sessionId
 * @param {string} groupId
 * @param {string} groupName
 */
async function saveManifest(sessionId, groupId, groupName) {
  const manifest = {
    id: sessionId,
    timestamp: new Date(Number(sessionId)).toISOString(),
    groupId,
    groupName
  };
  await chrome.downloads.download({
    url: jsonDataUrl(manifest),
    filename: `telegram-recorder/${groupId}/manifest-${sessionId}.json`,
    saveAs: false
  });
}

/**
 * Download a message's JSON record and optional screenshot PNG.
 * @param {Object} messageData
 * @param {string|null} croppedDataUrl
 */
async function saveFiles(messageData, croppedDataUrl) {
  const groupId = messageData.groupId;
  const messageId = messageData.messageId;
  if (!groupId || !messageId) {
    throw new Error('Missing groupId or messageId in messageData');
  }

  const downloads = [];

  if (croppedDataUrl) {
    downloads.push(
      chrome.downloads.download({
        url: croppedDataUrl,
        filename: `telegram-recorder/${groupId}/${messageId}.png`,
        saveAs: false
      }).catch(err => {
        console.error(`[TelegramRecorder] PNG download failed for ${messageId}`, err);
      })
    );
  }

  downloads.push(
    chrome.downloads.download({
      url: jsonDataUrl(messageData),
      filename: `telegram-recorder/${groupId}/${messageId}.json`,
      saveAs: false
    }).catch(err => {
      console.error(`[TelegramRecorder] JSON download failed for ${messageId}`, err);
    })
  );

  await Promise.all(downloads);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Capture the visible tab, retrying a few times if Chrome is not ready.
 * Omitting windowId defaults to the currently active window.
 * @param {number|undefined} windowId
 * @returns {Promise<string>}
 */
async function captureVisibleTabWithRetry(windowId) {
  const options = { format: 'png' };
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (windowId) {
        return await chrome.tabs.captureVisibleTab(windowId, options);
      }
      return await chrome.tabs.captureVisibleTab(options);
    } catch (err) {
      lastErr = err;
      console.warn('[TelegramRecorder] captureVisibleTab attempt', attempt, 'failed:', err?.message ?? err);
      if (attempt < 3) await sleep(300);
    }
  }
  throw lastErr ?? new Error('captureVisibleTab failed after retries');
}

/**
 * Rehydrate in-memory state from persistent/session storage.
 * Called on startup and after any service worker wake event.
 * @param {boolean} preserveRecording Whether to preserve a true `recording` flag
 *   (used on normal wake). On browser startup or extension install the session is
 *   interrupted, so recording is left stopped.
 */
async function rehydrateState(preserveRecording = true) {
  const local = await chrome.storage.local.get(STORAGE_LOCAL_KEYS);
  state.recording = preserveRecording ? Boolean(local.recording) : false;
  state.currentSessionId = local.currentSessionId ?? null;
  state.currentGroupId = local.currentGroupId ?? null;
  state.currentGroupName = local.currentGroupName ?? null;

  const session = await chrome.storage.session.get(STORAGE_SESSION_KEY);
  recordedSet = Array.isArray(session.recordedSet) ? session.recordedSet : [];

  if (!preserveRecording && local.recording) {
    // Browser restarted / extension installed while a session was active. Leave it stopped
    // and update storage so content scripts do not try to reattach on next load.
    await persistState();
  }
}

// Initial rehydration (normal service worker wake) — preserve recording so the content
// script can reattach if the browser session is still alive.
rehydrateState(true).catch(err => console.error('[TelegramRecorder] rehydrate failed', err));

chrome.runtime.onStartup.addListener(() => {
  // Browser restarted: recording cannot survive the restart.
  rehydrateState(false).catch(err => console.error('[TelegramRecorder] startup rehydrate failed', err));
});

chrome.runtime.onInstalled.addListener(() => {
  // Extension installed/updated: do not auto-resume any previous recording.
  rehydrateState(false).catch(err => console.error('[TelegramRecorder] install rehydrate failed', err));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    sendResponse({ ok: false, error: 'Invalid message' });
    return false;
  }

  const tabId = sender.tab?.id;

  /**
   * Helper for async handlers. Keeps the message channel open until the promise settles.
   * @param {Promise<any>} promise
   */
  function handleAsync(promise) {
    promise
      .then(result => sendResponse(result))
      .catch(err => {
        console.error('[TelegramRecorder] message handler error', message.type, err);
        sendResponse({ ok: false, error: err.message ?? String(err) });
      });
  }

  switch (message.type) {
    case MSG.GET_GROUP_INFO:
      // Forwarded to content script by popup via background for routing stability.
      // Handled in Phase 6.
      sendResponse({ ok: false, error: 'Not implemented yet' });
      break;

    case MSG.START_RECORDING: {
      const { groupId, groupName } = message;
      if (!groupId) {
        sendResponse({ ok: false, error: 'Missing groupId' });
        break;
      }
      handleAsync(
        (async () => {
          const tabId = await findActiveTelegramKTab();
          if (!tabId) {
            return { ok: false, error: 'No active Telegram Web K tab found' };
          }

          const sessionId = Date.now().toString();
          state.recording = true;
          state.currentSessionId = sessionId;
          state.currentGroupId = groupId;
          state.currentGroupName = groupName ?? null;
          recordedSet = [];
          await persistState();
          await chrome.storage.session.set({ recordedSet: [] });
          await saveManifest(sessionId, groupId, groupName ?? '');

          try {
            await chrome.tabs.sendMessage(tabId, { type: MSG.START_RECORDING, sessionId });
          } catch (err) {
            // Content script not reachable — roll back to a clean stopped state.
            await clearRecordingState();
            return { ok: false, error: 'Could not reach content script: ' + (err.message ?? String(err)) };
          }

          return { ok: true, sessionId };
        })()
      );
      return true;
    }

    case MSG.STOP_RECORDING: {
      handleAsync(
        (async () => {
          const previousTabId = state.currentGroupId ? await findActiveTelegramKTab() : null;
          await clearRecordingState();
          if (previousTabId) {
            await chrome.tabs.sendMessage(previousTabId, { type: MSG.STOP_RECORDING });
          }
          return { ok: true };
        })()
      );
      return true;
    }

    case MSG.CAPTURE_TAB: {
      if (!tabId) {
        sendResponse({ ok: false, error: 'CAPTURE_TAB requires sender tab' });
        break;
      }
      handleAsync(
        captureVisibleTabWithRetry(sender.tab?.windowId)
          .then(fullDataUrl => ({ ok: true, fullDataUrl }))
      );
      return true; // keep channel open for async response
    }

    case MSG.SAVE_FILES: {
      const { messageData, croppedDataUrl } = message;
      if (!messageData) {
        sendResponse({ ok: false, error: 'Missing messageData' });
        break;
      }
      handleAsync(
        saveFiles(messageData, croppedDataUrl ?? null)
          .then(() => ({ ok: true }))
      );
      return true;
    }

    case MSG.AUTO_STOPPED: {
      handleAsync(
        clearRecordingState().then(() => ({ ok: true }))
      );
      return true;
    }

    case MSG.PING:
      sendResponse({ ok: true, type: MSG.PONG });
      break;

    default:
      sendResponse({ ok: false, error: 'Unknown message type: ' + message.type });
  }

  return false;
});
