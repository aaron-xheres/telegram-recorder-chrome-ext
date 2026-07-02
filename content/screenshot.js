// Screenshot pipeline for Telegram Message Recorder.
// Scrolls a bubble into view, captures the visible tab, and crops to the bubble rect.

// eslint-disable-next-line no-undef
const SCREENSHOT_MSG = MESSAGE_TYPES;

const CAPTURE_WAIT_MS = 150;

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
    await sleep(CAPTURE_WAIT_MS);

    const rect = bubble.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      console.warn('[TelegramRecorder] bubble has zero size; skipping screenshot');
      return null;
    }

    const dpr = window.devicePixelRatio || 1;

    const response = await chrome.runtime.sendMessage({ type: SCREENSHOT_MSG.CAPTURE_TAB });
    if (!response || !response.ok || !response.fullDataUrl) {
      console.error('[TelegramRecorder] CAPTURE_TAB failed', response);
      return null;
    }

    return await cropToRect(response.fullDataUrl, rect, dpr);
  } catch (err) {
    console.error('[TelegramRecorder] captureScreenshot failed', err);
    return null;
  }
}
