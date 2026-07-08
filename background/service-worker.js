// Background service worker for Telegram Message Recorder.
// Coordinates state, storage, downloads, and messaging between popup and content scripts.
// Supports multiple concurrent recording sessions across tabs/windows, with one session
// per Telegram group (guard by groupId).

importScripts('../shared/messages.js');

// eslint-disable-next-line no-undef
const MSG = MESSAGE_TYPES;

/**
 * @typedef {Object} ActiveSession
 * @property {number} tabId
 * @property {string} sessionId
 * @property {string} groupId
 * @property {string|null} groupName
 */

const ACTIVE_SESSIONS_KEY = 'activeSessions';

/** @type {Map<number, ActiveSession>} */
let activeSessions = new Map();

/**
 * Convert an object to a data URL suitable for chrome.downloads.download().
 * @param {Object} obj
 * @returns {string}
 */
function jsonDataUrl(obj) {
  return 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(obj, null, 2));
}

/**
 * Persist the active sessions map to chrome.storage.local.
 */
async function persistSessions() {
  const sessions = Array.from(activeSessions.values());
  await chrome.storage.local.set({ [ACTIVE_SESSIONS_KEY]: sessions });
}

/**
 * Load active sessions from chrome.storage.local into the in-memory map.
 */
async function loadSessions() {
  const result = await chrome.storage.local.get(ACTIVE_SESSIONS_KEY);
  const sessions = Array.isArray(result[ACTIVE_SESSIONS_KEY]) ? result[ACTIVE_SESSIONS_KEY] : [];
  activeSessions = new Map();
  for (const session of sessions) {
    if (session && typeof session.tabId === 'number') {
      activeSessions.set(session.tabId, session);
    }
  }
}

/**
 * @param {number} tabId
 * @returns {ActiveSession|null}
 */
function getSessionByTabId(tabId) {
  return activeSessions.get(tabId) ?? null;
}

/**
 * Check whether any active session is already recording the given group.
 * @param {string} groupId
 * @returns {boolean}
 */
function hasSessionForGroup(groupId) {
  for (const session of activeSessions.values()) {
    if (session.groupId === groupId) return true;
  }
  return false;
}

/**
 * @param {number} tabId
 * @param {string} sessionId
 * @param {string} groupId
 * @param {string|null} groupName
 */
async function addSession(tabId, sessionId, groupId, groupName) {
  activeSessions.set(tabId, { tabId, sessionId, groupId, groupName: groupName ?? null });
  await persistSessions();
}

/**
 * Remove a session from the map and persist.
 * @param {number} tabId
 */
async function removeSession(tabId) {
  activeSessions.delete(tabId);
  await persistSessions();
}

/**
 * Stop a session and notify its content script.
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
async function stopSession(tabId) {
  const session = activeSessions.get(tabId);
  if (!session) return false;
  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG.STOP_RECORDING });
  } catch (err) {
    console.warn('[TelegramRecorder] could not notify tab of stop', tabId, err);
  }
  await removeSession(tabId);
  return true;
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
      console.log('[TelegramRecorder] captureVisibleTab attempt', attempt, { windowId });
      let fullDataUrl;
      if (windowId) {
        fullDataUrl = await chrome.tabs.captureVisibleTab(windowId, options);
      } else {
        fullDataUrl = await chrome.tabs.captureVisibleTab(options);
      }
      console.log('[TelegramRecorder] captureVisibleTab result', { attempt, type: typeof fullDataUrl, length: fullDataUrl?.length });
      if (!fullDataUrl) {
        throw new Error('captureVisibleTab returned empty data URL');
      }
      return fullDataUrl;
    } catch (err) {
      lastErr = err;
      console.warn('[TelegramRecorder] captureVisibleTab attempt', attempt, 'failed:', err?.message ?? err);
      if (attempt < 3) await sleep(500);
    }
  }
  throw lastErr ?? new Error('captureVisibleTab failed after retries');
}

/**
 * Rehydrate in-memory sessions from persistent storage.
 * Called on startup and after any service worker wake event.
 * @param {boolean} preserveSessions Whether to preserve stored sessions
 *   (used on normal wake). On browser startup or extension install the session is
 *   interrupted, so sessions are cleared.
 */
async function rehydrateState(preserveSessions = true) {
  if (preserveSessions) {
    await loadSessions();
    return;
  }

  // Browser restarted / extension installed: clear any stale sessions.
  activeSessions = new Map();
  await persistSessions();
}

// Initial rehydration (normal service worker wake) — preserve sessions so content
// scripts can reattach if the browser session is still alive.
rehydrateState(true).catch(err => console.error('[TelegramRecorder] rehydrate failed', err));

chrome.runtime.onStartup.addListener(() => {
  // Browser restarted: recording cannot survive the restart.
  rehydrateState(false).catch(err => console.error('[TelegramRecorder] startup rehydrate failed', err));
});

chrome.runtime.onInstalled.addListener(() => {
  // Extension installed/updated: do not auto-resume any previous recording.
  rehydrateState(false).catch(err => console.error('[TelegramRecorder] install rehydrate failed', err));
});

// Clean up sessions when their tab is closed.
chrome.tabs.onRemoved.addListener(tabId => {
  if (activeSessions.has(tabId)) {
    removeSession(tabId).catch(err => {
      console.error('[TelegramRecorder] failed to remove session for closed tab', tabId, err);
    });
  }
});

// Safety net: if a tab navigates away from Telegram Web K, end its session.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!activeSessions.has(tabId)) return;
  if (changeInfo.url && !changeInfo.url.startsWith('https://web.telegram.org/k/')) {
    stopSession(tabId).catch(err => {
      console.error('[TelegramRecorder] failed to stop session after navigation', tabId, err);
    });
  }
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
      sendResponse({ ok: false, error: 'Not implemented yet' });
      break;

    case MSG.GET_SESSION:
      sendResponse({ ok: true, session: getSessionByTabId(tabId ?? -1) });
      break;

    case MSG.GET_ACTIVE_SESSIONS:
      sendResponse({ ok: true, sessions: Array.from(activeSessions.values()) });
      break;

    case MSG.START_RECORDING: {
      const { groupId, groupName } = message;
      if (!groupId) {
        sendResponse({ ok: false, error: 'Missing groupId' });
        break;
      }
      handleAsync(
        (async () => {
          if (hasSessionForGroup(groupId)) {
            return { ok: false, error: `A recording for group ${groupId} is already active` };
          }

          const targetTabId = message.tabId ?? await findActiveTelegramKTab();
          if (!targetTabId) {
            return { ok: false, error: 'No active Telegram Web K tab found' };
          }

          // Verify the tab is actually on Telegram Web K.
          try {
            const tab = await chrome.tabs.get(targetTabId);
            if (!tab.url || !tab.url.startsWith('https://web.telegram.org/k/')) {
              return { ok: false, error: 'Target tab is not on Telegram Web K' };
            }
          } catch (err) {
            return { ok: false, error: 'Could not inspect target tab: ' + (err.message ?? String(err)) };
          }

          const sessionId = Date.now().toString();
          await saveManifest(sessionId, groupId, groupName ?? '');
          await addSession(targetTabId, sessionId, groupId, groupName ?? null);

          try {
            await chrome.tabs.sendMessage(targetTabId, { type: MSG.START_RECORDING, sessionId, groupId });
          } catch (err) {
            // Content script not reachable — roll back.
            await removeSession(targetTabId);
            return { ok: false, error: 'Could not reach content script: ' + (err.message ?? String(err)) };
          }

          return { ok: true, sessionId, tabId: targetTabId };
        })()
      );
      return true;
    }

    case MSG.STOP_RECORDING: {
      handleAsync(
        (async () => {
          const targetTabId = message.tabId ?? await findActiveTelegramKTab();
          if (!targetTabId) {
            return { ok: false, error: 'No Telegram Web K tab specified or active' };
          }

          const stopped = await stopSession(targetTabId);
          return { ok: stopped };
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
        (async () => {
          try {
            const windowId = sender.tab?.windowId;
            console.log('[TelegramRecorder] CAPTURE_TAB start', { tabId, windowId, focus: message.focus });

            // Only focus/restore the window when the caller explicitly requests
            // it (i.e. the tab-capture fallback path). The canvas path does not
            // need an active tab.
            if (message.focus === true) {
              if (windowId) {
                try {
                  const win = await chrome.windows.get(windowId);
                  console.log('[TelegramRecorder] window state', { windowId, state: win.state });
                  if (win.state === 'minimized') {
                    console.log('[TelegramRecorder] restoring minimized window', windowId);
                    await chrome.windows.update(windowId, { state: 'normal' });
                  }
                } catch (winErr) {
                  console.warn('[TelegramRecorder] could not inspect window state', windowId, winErr);
                }
                await chrome.windows.update(windowId, { focused: true });
              }
              await chrome.tabs.update(tabId, { active: true });
              console.log('[TelegramRecorder] tab activated', tabId);
              await sleep(150);
            }

            const fullDataUrl = await captureVisibleTabWithRetry(windowId);
            console.log('[TelegramRecorder] capture success', { tabId, dataUrlLength: fullDataUrl?.length });
            return { ok: true, fullDataUrl };
          } catch (err) {
            console.error('[TelegramRecorder] CAPTURE_TAB failed for tab', tabId, err);
            return { ok: false, error: err?.message ?? String(err) };
          }
        })()
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
        (async () => {
          if (tabId) await removeSession(tabId);
          return { ok: true };
        })()
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
