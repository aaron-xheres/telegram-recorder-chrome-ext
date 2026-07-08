// Screenshot strategy orchestrator.
// Reads the user's popup preference and either tries canvas first (with tab
// fallback) or always uses tab capture.

const CANVAS_SETTING_KEY = 'useCanvasCapture';

/**
 * Read the screenshot strategy preference from storage.
 * Defaults to true (canvas enabled).
 * @returns {Promise<boolean>}
 */
async function getUseCanvasCapture() {
  try {
    const result = await chrome.storage.local.get(CANVAS_SETTING_KEY);
    return result[CANVAS_SETTING_KEY] !== false;
  } catch (err) {
    console.error('[TelegramRecorder] failed to read canvas capture setting', err);
    return true;
  }
}

/**
 * Capture a screenshot of a message bubble.
 * @param {Element} bubble
 * @returns {Promise<string|null>}
 */
async function captureScreenshot(bubble) {
  const useCanvas = await getUseCanvasCapture();

  if (useCanvas) {
    const canvasResult = await captureScreenshotCanvas(bubble);
    if (canvasResult) return canvasResult;
    console.log('[TelegramRecorder] falling back to tab-capture screenshot');
  } else {
    console.log('[TelegramRecorder] canvas capture disabled; using tab capture');
  }

  return captureScreenshotTab(bubble);
}
