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
  'a.mention',
  'a.anchor-hashtag'
];

const MEDIA_IMAGE_SELECTORS = [
  '.attachment img.media-photo',
  '.media-container img.media-photo'
];

const TIMESTAMP_SELECTORS = [
  '.time',
  '.message-time',
  '.bubble-time',
  '.time-inner',
  '.message-time-text',
  '[class*="time"]'
];

const EMOJI_ELEMENT_SELECTORS = [
  'img.emoji',
  'img.emoji-image',
  'custom-emoji-element',
  'custom-emoji-renderer-element'
];

/**
 * Resolve the sender's peer ID.
 * For public groups and forwarded messages the avatar may be inside the bubble
 * (e.g. .bubble-name-forwarded-avatar) rather than the bubbles-group header.
 * @param {Element} bubble
 * @returns {string|null}
 */
function resolveSenderPeerId(bubble) {
  try {
    // 1. Bubble-level avatar (forwarded messages / public groups).
    const bubbleAvatar = bubble.querySelector('.avatar[data-peer-id], .bubble-name-forwarded-avatar[data-peer-id]');
    if (bubbleAvatar?.dataset.peerId) {
      return bubbleAvatar.dataset.peerId;
    }

    // 2. Bubbles-group avatar (normal group chats).
    const group = bubble.closest('.bubbles-group');
    if (group) {
      const avatar = group.querySelector('.bubbles-group-avatar[data-peer-id]');
      if (avatar?.dataset.peerId) return avatar.dataset.peerId;
    }

    return null;
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
    // Forwarded posts expose the original sender's title inside the bubble.
    const title = bubble.querySelector('.bubble-name-forwarded .peer-title, .colored-name .peer-title, span.peer-title');
    return title?.textContent?.trim() ?? null;
  } catch (err) {
    console.error('[TelegramRecorder] resolveSenderName failed', err);
    return null;
  }
}

/**
 * Determine whether the sender is anonymous (admin posting as group or channel post-as-group).
 * A real channel/user sender, even with a negative peer ID, is NOT anonymous.
 * @param {string|null} posterId
 * @param {string} groupId
 * @returns {boolean}
 */
function isAnonymousSender(posterId, groupId) {
  if (!posterId) return true;
  // Anonymous only when the sender is explicitly posting as the group entity.
  if (posterId === groupId) return true;
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
 * Extract text content from the bubble, stripping emoji and stickers.
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
    clone.querySelectorAll(EMOJI_ELEMENT_SELECTORS.join(', ')).forEach(el => el.remove());
    // Strip Telegram's inline message timestamp so it isn't appended to content.
    clone.querySelectorAll(TIMESTAMP_SELECTORS.join(', ')).forEach(el => el.remove());
    return clone.textContent.trim();
  } catch (err) {
    console.error('[TelegramRecorder] extractText failed', err);
    return null;
  }
}

/**
 * Extract unique absolute URLs and mentions/hashtags from the message text.
 * @param {Element} bubble
 * @returns {string[]}
 */
function extractLinks(bubble) {
  try {
    const translatable = findMessageTextContainer(bubble);
    const scope = translatable ?? bubble;
    const links = [];

    scope.querySelectorAll(LINK_ANCHOR_SELECTORS.join(', ')).forEach(a => {
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
 * Stickers and custom emoji are excluded even if they use <img> tags.
 * @param {Element} bubble
 * @returns {string[]}
 */
function extractMediaImages(bubble) {
  try {
    const images = [];
    bubble.querySelectorAll(MEDIA_IMAGE_SELECTORS.join(', ')).forEach(img => {
      if (img.classList.contains('emoji') || img.classList.contains('emoji-image')) return;
      if (img.closest('custom-emoji-element, custom-emoji-renderer-element')) return;
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

    console.log('[TelegramRecorder] extracted', messageId, { posterName, posterId, contentLength: content?.length, images: images.length, links: links.length });
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
