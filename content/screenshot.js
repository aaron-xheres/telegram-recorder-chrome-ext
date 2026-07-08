// Screenshot strategy orchestrator.
// Tries the canvas-based strategy first (no active-tab requirement) and falls
// back to the tab-capture strategy only when html2canvas is unavailable.

/**
 * Capture a screenshot of a message bubble.
 * @param {Element} bubble
 * @returns {Promise<string|null>}
 */
async function captureScreenshot(bubble) {
  const canvasResult = await captureScreenshotCanvas(bubble);
  if (canvasResult) return canvasResult;

  console.log('[TelegramRecorder] falling back to tab-capture screenshot');
  return captureScreenshotTab(bubble);
}
