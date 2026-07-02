// Message extraction utilities for Telegram Web K.
// Converts a message bubble DOM element into a structured record.

/**
 * @typedef {Object} MessageRecord
 * @property {string} messageId
 * @property {string} sessionId
 * @property {string} groupId
 * @property {string|null} posterName
 * @property {string|null} posterId
 * @property {string|null} content
 * @property {string} timestamp
 * @property {string[]} images
 * @property {string[]} links
 * @property {string|null} screenshotFile
 */

const MESSAGE_TEXT_SELECTORS = [
  '.translatable-message',
  '.message-text',
  '.text-content',
  '.bubble-content .message',
  '.bubble-content-wrapper .message'
];

const LINK_ANCHOR_SELECTORS = [
  'a.anchor-url',
  '.translatable-message a',
  '.message-text a',
  'a[href]'
];

const MEDIA_IMAGE_SELECTORS = [
  '.attachment img.media-photo',
  '.media-container img.media-photo',
  '.attachment img',
  '.media-container img'
];

const TIMESTAMP_SELECTORS = [
  '.time',
  '.message-time',
  '.bubble-time',
  '.time-inner',
  '.message-time-text',
  '[class*="time"]'
];

/**
 * Walk up from a bubble to its parent bubbles-group and read the avatar's data-peer-id.
 * @param {Element} bubble
 * @returns {string|null}
 */
function resolveSenderPeerId(bubble) {
  try {
    const group = bubble.closest('.bubbles-group');
    if (!group) return null;
    const avatar = group.querySelector('.bubbles-group-avatar[data-peer-id]');
    return avatar?.dataset.peerId ?? null;
  } catch (err) {
    console.error('[TelegramRecorder] resolveSenderPeerId failed', err);
    return null;
  }
}

/**
 * Read the sender display name from the bubble's peer-title element.
 * @param {Element} bubble
 * @returns {string|null}
 */
function resolveSenderName(bubble) {
  try {
    const title = bubble.querySelector('.colored-name .peer-title, span.peer-title');
    return title?.textContent?.trim() ?? null;
  } catch (err) {
    console.error('[TelegramRecorder] resolveSenderName failed', err);
    return null;
  }
}

/**
 * Determine whether the sender is anonymous (admin posting as group or channel post).
 * @param {string|null} posterId
 * @param {string} groupId
 * @returns {boolean}
 */
function isAnonymousSender(posterId, groupId) {
  if (!posterId) return true;
  if (posterId === groupId) return true;
  // Negative peer IDs represent anonymous/group/channel entities in Telegram.
  if (posterId.startsWith('-')) return true;
  return false;
}

/**
 * Find the message text container inside a bubble.
 * @param {Element} bubble
 * @returns {Element|null}
 */
function findMessageTextContainer(bubble) {
  for (const selector of MESSAGE_TEXT_SELECTORS) {
    const el = bubble.querySelector(selector);
    if (el) return el;
  }
  return null;
}

/**
 * Extract text content from the bubble, stripping emoji images.
 * @param {Element} bubble
 * @returns {string|null}
 */
function extractText(bubble) {
  try {
    const translatable = findMessageTextContainer(bubble);
    if (!translatable) {
      console.warn('[TelegramRecorder] no message text container found for', bubble.dataset.mid);
      return null;
    }
    const clone = translatable.cloneNode(true);
    clone.querySelectorAll('img.emoji, img.emoji-image').forEach(el => el.remove());
    // Strip Telegram's inline message timestamp so it isn't appended to content.
    clone.querySelectorAll(TIMESTAMP_SELECTORS.join(', ')).forEach(el => el.remove());
    return clone.textContent.trim();
  } catch (err) {
    console.error('[TelegramRecorder] extractText failed', err);
    return null;
  }
}

/**
 * Extract unique absolute URLs from anchor tags in the message text.
 * @param {Element} bubble
 * @returns {string[]}
 */
function extractLinks(bubble) {
  try {
    const translatable = findMessageTextContainer(bubble);
    const links = [];
    const anchors = translatable
      ? translatable.querySelectorAll('a.anchor-url')
      : bubble.querySelectorAll(LINK_ANCHOR_SELECTORS.join(', '));

    anchors.forEach(a => {
      const url = a.href;
      if (url && !links.includes(url)) links.push(url);
    });
    return links;
  } catch (err) {
    console.error('[TelegramRecorder] extractLinks failed', err);
    return [];
  }
}

/**
 * Extract media image blob URLs from the bubble.
 * @param {Element} bubble
 * @returns {string[]}
 */
function extractMediaImages(bubble) {
  try {
    const images = [];
    bubble.querySelectorAll(MEDIA_IMAGE_SELECTORS.join(', ')).forEach(img => {
      if (img.classList.contains('emoji') || img.classList.contains('emoji-image')) return;
      if (img.src && !images.includes(img.src)) images.push(img.src);
    });
    return images;
  } catch (err) {
    console.error('[TelegramRecorder] extractMediaImages failed', err);
    return [];
  }
}

/**
 * Orchestrate extraction of a full message record.
 * @param {Element} bubble
 * @param {string} sessionId
 * @returns {MessageRecord}
 */
function extract(bubble, sessionId) {
  try {
    const messageId = bubble.dataset.mid ?? null;
    const groupId = bubble.dataset.peerId ?? null;
    const rawTimestamp = bubble.dataset.timestamp;

    let timestamp = '';
    if (rawTimestamp) {
      try {
        timestamp = new Date(Number(rawTimestamp) * 1000).toISOString();
      } catch (err) {
        console.error('[TelegramRecorder] invalid timestamp', rawTimestamp, err);
        timestamp = '';
      }
    }

    let posterId = resolveSenderPeerId(bubble);
    let posterName = resolveSenderName(bubble);

    if (isAnonymousSender(posterId, groupId)) {
      posterId = groupId;
      posterName = null;
    }

    let content = extractText(bubble);
    let images = extractMediaImages(bubble);
    let links = extractLinks(bubble);

    const record = {
      messageId,
      sessionId,
      groupId,
      posterName,
      posterId,
      content,
      timestamp,
      images,
      links,
      screenshotFile: messageId ? `${messageId}.png` : null
    };

    console.log('[TelegramRecorder] extracted', messageId, { posterName, contentLength: content?.length, images: images.length, links: links.length });
    return record;
  } catch (err) {
    console.error('[TelegramRecorder] extract failed for bubble', bubble.dataset.mid, err);
    return {
      messageId: bubble.dataset.mid ?? null,
      sessionId,
      groupId: bubble.dataset.peerId ?? null,
      posterName: null,
      posterId: null,
      content: null,
      timestamp: '',
      images: [],
      links: [],
      screenshotFile: null
    };
  }
}
