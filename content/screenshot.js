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
 * Compute the intersection of a bubble rect with the current viewport.
 * Long messages may be taller than the viewport, so we clip to what is actually
 * visible instead of creating a huge transparent screenshot.
 * @param {DOMRect} rect
 * @returns {DOMRect|null}
 */
function intersectWithViewport(rect) {
  const viewport = {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight
  };

  const left = Math.max(rect.left, viewport.left);
  const top = Math.max(rect.top, viewport.top);
  const right = Math.min(rect.right, viewport.right);
  const bottom = Math.min(rect.bottom, viewport.bottom);

  if (right <= left || bottom <= top) {
    return null;
  }

  return new DOMRect(left, top, right - left, bottom - top);
}

/**
 * Scroll a bubble into view, capture the tab, and return a cropped data URL.
 * If the bubble is taller than the viewport, scroll to its top and capture only
 * the visible portion to avoid a failed/transparent screenshot.
 * @param {Element} bubble
 * @returns {Promise<string|null>}
 */
async function captureScreenshot(bubble) {
  try {
    const initialRect = bubble.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const bubbleTallerThanViewport = initialRect.height > viewportHeight;

    if (bubbleTallerThanViewport) {
      console.warn('[TelegramRecorder] bubble is taller than viewport; capturing visible top portion');
      bubble.scrollIntoView({ block: 'start', behavior: 'instant' });
    } else {
      bubble.scrollIntoView({ block: 'center', behavior: 'instant' });
    }

    // Give Telegram a moment to finish layout/paint, then wait for the next frame
    // so the scroll position is reflected before capture.
    await sleep(CAPTURE_WAIT_MS);
    await new Promise(resolve => requestAnimationFrame(resolve));

    const rect = bubble.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      console.warn('[TelegramRecorder] bubble has zero size; skipping screenshot');
      return null;
    }

    const visibleRect = intersectWithViewport(rect);
    if (!visibleRect) {
      console.warn('[TelegramRecorder] bubble is outside viewport; skipping screenshot');
      return null;
    }

    if (visibleRect.width < rect.width || visibleRect.height < rect.height) {
      console.warn('[TelegramRecorder] bubble clipped to viewport', {
        full: { width: rect.width, height: rect.height },
        visible: { width: visibleRect.width, height: visibleRect.height }
      });
    }

    const dpr = window.devicePixelRatio || 1;

    console.log('[TelegramRecorder] requesting capture', {
      bubbleRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      visibleRect: { x: visibleRect.x, y: visibleRect.y, width: visibleRect.width, height: visibleRect.height },
      dpr,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    });

    // The service worker focuses the tab and retries the capture internally.
    // We only retry here if the message channel itself is temporarily unavailable.
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: SCREENSHOT_MSG.CAPTURE_TAB });
    } catch (err) {
      console.warn('[TelegramRecorder] CAPTURE_TAB message failed, retrying once', err);
      await sleep(200);
      response = await chrome.runtime.sendMessage({ type: SCREENSHOT_MSG.CAPTURE_TAB });
    }

    console.log('[TelegramRecorder] CAPTURE_TAB response', {
      ok: response?.ok,
      hasFullDataUrl: Boolean(response?.fullDataUrl),
      fullDataUrlLength: response?.fullDataUrl?.length,
      error: response?.error
    });

    if (!response || !response.ok || !response.fullDataUrl) {
      console.error('[TelegramRecorder] CAPTURE_TAB failed', response);
      return null;
    }

    return await cropToRect(response.fullDataUrl, visibleRect, dpr);
  } catch (err) {
    console.error('[TelegramRecorder] captureScreenshot failed', err);
    return null;
  }
}
