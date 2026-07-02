// Screenshot pipeline for Telegram Message Recorder.
// Scrolls a bubble into view, captures the visible tab, and crops to the bubble rect.

// eslint-disable-next-line no-undef
var SCREENSHOT_MSG = MESSAGE_TYPES;

var CAPTURE_WAIT_MS = 150;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

/**
 * Crop a full-tab data URL to the bounding rect of an element.
 * @param {string} fullDataUrl
 * @param {DOMRect} rect
 * @param {number} dpr
 * @returns {Promise<string|null>}
 */
function cropToRect(fullDataUrl, rect, dpr) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(rect.width * dpr));
        canvas.height = Math.max(1, Math.round(rect.height * dpr));

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Could not get canvas 2D context'));
          return;
        }

        ctx.drawImage(
          img,
          -(rect.left * dpr),
          -(rect.top * dpr)
        );

        resolve(canvas.toDataURL('image/png'));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('Failed to load captured tab image'));
    img.src = fullDataUrl;
  });
}

/**
 * Scroll a bubble into view, capture the tab, and return a cropped data URL.
 * @param {Element} bubble
 * @returns {Promise<string|null>}
 */
  async function captureScreenshot(bubble) {
  try {
    bubble.scrollIntoView({ block: 'center', behavior: 'instant' });
    // Give Telegram a moment to finish layout/paint, then wait for the next frame
    // so the scroll position is reflected before capture.
    await sleep(CAPTURE_WAIT_MS);
    await new Promise(resolve => requestAnimationFrame(resolve));

    const rect = bubble.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      console.warn('[TelegramRecorder] bubble has zero size; skipping screenshot');
      return null;
    }

    const dpr = window.devicePixelRatio || 1;

    // Capture can be flaky when the window/tab is not fully focused or still painting.
    // Retry a few times before giving up; JSON is still saved on failure.
    let response = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      response = await chrome.runtime.sendMessage({ type: SCREENSHOT_MSG.CAPTURE_TAB });
      if (response?.ok && response.fullDataUrl) break;
      console.warn('[TelegramRecorder] CAPTURE_TAB attempt', attempt, 'failed', response);
      if (attempt < 3) await sleep(200);
    }

    if (!response || !response.ok || !response.fullDataUrl) {
      console.error('[TelegramRecorder] CAPTURE_TAB failed after retries', response);
      return null;
    }

    return await cropToRect(response.fullDataUrl, rect, dpr);
  } catch (err) {
    console.error('[TelegramRecorder] captureScreenshot failed', err);
    return null;
  }
}
