// Canvas-based screenshot strategy using html2canvas.
// Renders the message bubble directly to a canvas; does not require the tab to
// be active or the window to be focused.

var CANVAS_CAPTURE_WAIT_MS = 150;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

/**
 * Render a message bubble directly to a canvas using html2canvas.
 * @param {Element} bubble
 * @returns {Promise<string|null>}
 */
async function captureScreenshotCanvas(bubble) {
  try {
    if (typeof html2canvas !== 'function') {
      console.warn('[TelegramRecorder] html2canvas is not loaded');
      return null;
    }

    // Scroll the bubble into view so the user can see what is being captured,
    // but the full element is rendered regardless of viewport size.
    bubble.scrollIntoView({ block: 'center', behavior: 'instant' });

    await sleep(CANVAS_CAPTURE_WAIT_MS);
    await new Promise(resolve => requestAnimationFrame(resolve));

    const rect = bubble.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      console.warn('[TelegramRecorder] bubble has zero size; skipping screenshot');
      return null;
    }

    console.log('[TelegramRecorder] rendering bubble with html2canvas', {
      width: rect.width,
      height: rect.height,
      dpr: window.devicePixelRatio || 1
    });

    const canvas = await html2canvas(bubble, {
      useCORS: true,
      allowTaint: true,
      scale: window.devicePixelRatio || 1,
      backgroundColor: null,
      logging: false
    });

    return canvas.toDataURL('image/png');
  } catch (err) {
    console.error('[TelegramRecorder] captureScreenshotCanvas failed', err);
    return null;
  }
}
