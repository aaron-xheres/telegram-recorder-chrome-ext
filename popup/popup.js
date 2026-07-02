// Popup UI logic for Telegram Recorder.
// eslint-disable-next-line no-undef
const POPUP_MSG = MESSAGE_TYPES;

// DOM references.
const els = {
  noticeSection: document.getElementById('notice-section'),
  noticeText: document.getElementById('notice-text'),
  switchWebK: document.getElementById('switch-web-k'),
  groupSection: document.getElementById('group-section'),
  groupName: document.getElementById('group-name'),
  groupId: document.getElementById('group-id'),
  statusSection: document.getElementById('status-section'),
  statusValue: document.getElementById('status-value'),
  statusText: document.getElementById('status-text'),
  sessionRow: document.getElementById('session-row'),
  sessionId: document.getElementById('session-id'),
  autoStopNotice: document.getElementById('auto-stop-notice'),
  startButton: document.getElementById('start-button'),
  stopButton: document.getElementById('stop-button'),
  viewerButton: document.getElementById('viewer-button')
};

// Current popup state.
let activeTabId = null;
let activeTabUrl = '';
let state = {
  recording: false,
  currentSessionId: null,
  currentGroupId: null,
  currentGroupName: null
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTelegramUrl(url) {
  return url && url.startsWith('https://web.telegram.org/');
}

function isWebK(url) {
  return url && url.startsWith('https://web.telegram.org/k/');
}

function isWebAorZ(url) {
  return url && (url.startsWith('https://web.telegram.org/a/') || url.startsWith('https://web.telegram.org/z/'));
}

function setVisible(el, visible) {
  el.classList.toggle('hidden', !visible);
}

// ---------------------------------------------------------------------------
// Content-script communication with reinjection fallback
// ---------------------------------------------------------------------------

/**
 * Send a message to the active tab's content script, reinjecting scripts if needed.
 * @param {any} message
 * @returns {Promise<any>}
 */
async function sendToContent(message) {
  try {
    const pingResponse = await chrome.tabs.sendMessage(activeTabId, { type: POPUP_MSG.PING });
    console.log('[TelegramRecorder] ping response', pingResponse);
    if (pingResponse?.ok) {
      return await chrome.tabs.sendMessage(activeTabId, message);
    }
    console.log('[TelegramRecorder] ping not ok; reinjecting content scripts');
  } catch (err) {
    console.log('[TelegramRecorder] content script not responding; reinjecting', err);
  }

  // Reinjection fallback (Phase 10.3).
  await chrome.scripting.executeScript({
    target: { tabId: activeTabId },
    files: ['shared/messages.js', 'content/extractor.js', 'content/screenshot.js', 'content/content.js']
  });

  // Give the scripts a moment to register listeners.
  await new Promise(resolve => setTimeout(resolve, 100));
  const response = await chrome.tabs.sendMessage(activeTabId, message);
  console.log('[TelegramRecorder] post-reinjection response', response);
  return response;
}

async function fetchGroupInfo() {
  if (!isWebK(activeTabUrl)) {
    console.log('[TelegramRecorder] not Web K, skipping group info', activeTabUrl);
    return { groupId: null, groupName: null };
  }

  try {
    console.log('[TelegramRecorder] fetching group info from tab', activeTabId);
    const response = await sendToContent({ type: POPUP_MSG.GET_GROUP_INFO });
    console.log('[TelegramRecorder] group info response', response);
    return {
      groupId: response?.groupId ?? null,
      groupName: response?.groupName ?? null
    };
  } catch (err) {
    console.error('[TelegramRecorder] fetchGroupInfo failed', err);
    return { groupId: null, groupName: null };
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  // Reset sections.
  setVisible(els.noticeSection, false);
  setVisible(els.switchWebK, false);
  setVisible(els.groupSection, false);
  setVisible(els.statusSection, false);
  setVisible(els.startButton, false);
  setVisible(els.stopButton, false);
  setVisible(els.autoStopNotice, false);

  // Case A — Not Telegram.
  if (!isTelegramUrl(activeTabUrl)) {
    setVisible(els.noticeSection, true);
    els.noticeText.textContent = '⚠ Navigate to web.telegram.org/k/ to use this extension.';
    return;
  }

  // Case B — Telegram Web A or Z.
  if (isWebAorZ(activeTabUrl)) {
    setVisible(els.noticeSection, true);
    const variant = activeTabUrl.includes('/a/') ? 'Web A' : 'Web Z';
    els.noticeText.textContent = `⚠ You are on Telegram ${variant}. This extension requires Web K.`;
    setVisible(els.switchWebK, true);
    return;
  }

  // Cases C–E — Telegram Web K.
  setVisible(els.groupSection, true);
  setVisible(els.statusSection, true);

  const groupInfo = fetchGroupInfo(); // async; will re-render on response
  // Initial render uses storage state; group info updates after response.
  els.groupName.textContent = state.currentGroupName ?? 'No group open';
  els.groupId.textContent = state.currentGroupId ?? '—';

  const isRecording = Boolean(state.recording);
  els.statusValue.classList.toggle('status-recording', isRecording);
  els.statusText.textContent = isRecording ? 'Recording' : 'Stopped';

  if (isRecording && state.currentSessionId) {
    setVisible(els.sessionRow, true);
    els.sessionId.textContent = state.currentSessionId;
    setVisible(els.stopButton, true);
    setVisible(els.startButton, false);
  } else {
    setVisible(els.sessionRow, false);
    setVisible(els.stopButton, false);
    setVisible(els.startButton, true);
    const hasGroup = Boolean(state.currentGroupId);
    els.startButton.disabled = !hasGroup;
    els.startButton.title = hasGroup ? '' : 'Open a Telegram group chat first';
  }

  // Update group info asynchronously.
  groupInfo.then(info => {
    const hasGroup = Boolean(info.groupId);
    els.groupName.textContent = hasGroup
      ? (info.groupName ?? 'Unknown')
      : 'No group open';
    els.groupId.textContent = info.groupId ?? '—';

    if (!isRecording) {
      setVisible(els.startButton, true);
      els.startButton.disabled = !hasGroup;
      els.startButton.title = hasGroup ? '' : 'Open a Telegram group chat first';
    }
  });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

els.switchWebK.addEventListener('click', () => {
  chrome.tabs.update(activeTabId, { url: 'https://web.telegram.org/k/' });
  window.close();
});

els.startButton.addEventListener('click', async () => {
  const info = await fetchGroupInfo();
  if (!info.groupId) {
    alert('No group open. Open a Telegram group chat first.');
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: POPUP_MSG.START_RECORDING,
      groupId: info.groupId,
      groupName: info.groupName ?? 'Unknown Group'
    });

    if (response?.ok) {
      state.recording = true;
      state.currentSessionId = response.sessionId;
      state.currentGroupId = info.groupId;
      state.currentGroupName = info.groupName ?? 'Unknown Group';
      render();
    } else {
      console.error('[TelegramRecorder] START_RECORDING failed', response);
    }
  } catch (err) {
    console.error('[TelegramRecorder] start recording error', err);
  }
});

els.stopButton.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: POPUP_MSG.STOP_RECORDING });
    state.recording = false;
    state.currentSessionId = null;
    render();
  } catch (err) {
    console.error('[TelegramRecorder] stop recording error', err);
  }
});

els.viewerButton.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer/viewer.html') });
  window.close();
});

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  activeTabUrl = tab?.url ?? '';

  const local = await chrome.storage.local.get([
    'recording',
    'currentSessionId',
    'currentGroupId',
    'currentGroupName'
  ]);

  state = {
    recording: Boolean(local.recording),
    currentSessionId: local.currentSessionId ?? null,
    currentGroupId: local.currentGroupId ?? null,
    currentGroupName: local.currentGroupName ?? null
  };

  render();
}

init().catch(err => console.error('[TelegramRecorder] popup init failed', err));

// Listen for runtime messages (e.g. AUTO_STOPPED from background).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === POPUP_MSG.AUTO_STOPPED) {
    state.recording = false;
    state.currentSessionId = null;
    setVisible(els.autoStopNotice, true);
    render();
  }
  sendResponse({ ok: true });
  return false;
});
