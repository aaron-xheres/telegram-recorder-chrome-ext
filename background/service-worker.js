// Background service worker for Telegram Message Recorder.
// Coordinates state, storage, downloads, and messaging between popup and content scripts.

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
 * Rehydrate in-memory state from persistent/session storage.
 * Called on startup and after any service worker wake event.
 */
async function rehydrateState() {
  const local = await chrome.storage.local.get(STORAGE_LOCAL_KEYS);
  state.recording = Boolean(local.recording);
  state.currentSessionId = local.currentSessionId ?? null;
  state.currentGroupId = local.currentGroupId ?? null;
  state.currentGroupName = local.currentGroupName ?? null;

  const session = await chrome.storage.session.get(STORAGE_SESSION_KEY);
  recordedSet = Array.isArray(session.recordedSet) ? session.recordedSet : [];
}

// Initial rehydration.
rehydrateState().catch(err => console.error('[TelegramRecorder] rehydrate failed', err));

chrome.runtime.onStartup.addListener(() => {
  rehydrateState().catch(err => console.error('[TelegramRecorder] startup rehydrate failed', err));
});

chrome.runtime.onInstalled.addListener(() => {
  rehydrateState().catch(err => console.error('[TelegramRecorder] install rehydrate failed', err));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    sendResponse({ ok: false, error: 'Invalid message' });
    return false;
  }

  switch (message.type) {
    case MSG.GET_GROUP_INFO:
      // Forwarded to content script by popup via background for routing stability.
      // Handled in Phase 6.
      sendResponse({ ok: false, error: 'Not implemented yet' });
      break;

    case MSG.START_RECORDING:
      // Implemented in Phase 5.
      sendResponse({ ok: false, error: 'Not implemented yet' });
      break;

    case MSG.STOP_RECORDING:
      // Implemented in Phase 5.
      sendResponse({ ok: false, error: 'Not implemented yet' });
      break;

    case MSG.CAPTURE_TAB:
      // Implemented in Phase 4.
      sendResponse({ ok: false, error: 'Not implemented yet' });
      break;

    case MSG.SAVE_FILES:
      // Implemented in Phase 5.
      sendResponse({ ok: false, error: 'Not implemented yet' });
      break;

    case MSG.AUTO_STOPPED:
      // Implemented in Phase 5.
      sendResponse({ ok: false, error: 'Not implemented yet' });
      break;

    case MSG.PING:
      sendResponse({ ok: true, type: MSG.PONG });
      break;

    default:
      sendResponse({ ok: false, error: 'Unknown message type: ' + message.type });
  }

  return false;
});
