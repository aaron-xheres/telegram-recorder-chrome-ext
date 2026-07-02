// Content script orchestration — populated in Phase 3.
// eslint-disable-next-line no-undef
const CONTENT_MSG = MESSAGE_TYPES;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    sendResponse({ ok: false, error: 'Invalid message' });
    return false;
  }

  switch (message.type) {
    case CONTENT_MSG.GET_GROUP_INFO:
      sendResponse({ ok: false, error: 'Not implemented yet' });
      break;
    case CONTENT_MSG.START_RECORDING:
      sendResponse({ ok: false, error: 'Not implemented yet' });
      break;
    case CONTENT_MSG.STOP_RECORDING:
      sendResponse({ ok: false, error: 'Not implemented yet' });
      break;
    default:
      sendResponse({ ok: false, error: 'Unknown message type: ' + message.type });
  }

  return false;
});
