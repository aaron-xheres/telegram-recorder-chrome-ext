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
 * @property {string[]} media
 * @property {string[]} links
 * @property {string[]} mediaFiles
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

const MEDIA_EXCLUDE_SELECTORS = [
  '.avatar',
  '.bubbles-group-avatar',
  '.bubble-name-forwarded-avatar',
  'custom-emoji-element',
  'custom-emoji-renderer-element',
  '.emoji',
  '.emoji-image'
].join(', ');

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
 * Public groups sometimes wrap the visible name in .peer-title-inner and add an
 * .emoji-status sibling; prefer the inner element to avoid polluting the name.
 * @param {Element} bubble
 * @returns {string|null}
 */
function resolveSenderName(bubble) {
  try {
    // Forwarded posts expose the original sender's title inside the bubble.
    const title = bubble.querySelector('.bubble-name-forwarded .peer-title, .colored-name .peer-title, span.peer-title');
    if (!title) return null;
    const inner = title.querySelector('.peer-title-inner');
    const text = (inner?.textContent ?? title.textContent).trim();
    return text || null;
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
 * Determine whether a string is a single default emoji grapheme.
 * @param {string} str
 * @returns {boolean}
 */
function isSingleEmoji(str) {
  try {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    const segments = Array.from(segmenter.segment(str));
    if (segments.length !== 1) return false;
    return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segments[0].segment);
  } catch (err) {
    // Fallback for environments without Intl.Segmenter.
    return Array.from(str).length === 1 && /\p{Extended_Pictographic}/u.test(str);
  }
}

/**
 * Build a replacement string for an emoji/sticker element. Default emoji are
 * kept as-is; custom stickers/descriptions are wrapped in braces so we can tell
 * them apart from plain text.
 * @param {Element} el
 * @returns {string}
 */
function getEmojiReplacement(el) {
  const stickerEmoji = el.getAttribute?.('data-sticker-emoji')?.trim();
  let candidate = stickerEmoji;

  if (!candidate) {
    candidate = el.getAttribute?.('alt')?.trim();
  }

  if (!candidate) {
    const innerImg = el.querySelector('img[alt]');
    candidate = innerImg?.getAttribute('alt')?.trim() ?? '';
  }

  if (!candidate) return '{}';
  if (isSingleEmoji(candidate)) return candidate;
  return `{${candidate}}`;
}

/**
 * Extract text content from the bubble, replacing emoji/stickers with their
 * default emoji character or a `{alt}` marker, and stripping the inline timestamp.
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
    clone.querySelectorAll(EMOJI_ELEMENT_SELECTORS.join(', ')).forEach(el => {
      el.replaceWith(document.createTextNode(getEmojiReplacement(el)));
    });
    // Strip Telegram's inline message timestamp so it isn't appended to content.
    clone.querySelectorAll(TIMESTAMP_SELECTORS.join(', ')).forEach(el => el.remove());
    // Telegram interleaves a lot of custom-emoji/sticker whitespace. Preserve
    // intentional line breaks for the viewer, but collapse runs of spaces/tabs
    // and multiple blank lines so the text stays readable.
    return clone.textContent
      .replace(/[ \t]+/g, ' ')
      .replace(/\n+/g, '\n')
      .trim();
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
 * Extract media URLs from the bubble.
 * Waits for contained <img> and <video> elements to finish loading, then
 * collects their sources. Also picks up background-image URLs and attachment
 * links from Telegram's photo/video/file wrappers. Avatars, emoji, and
 * custom-emoji elements are excluded.
 * @param {Element} bubble
 * @returns {Promise<string[]>}
 */
async function extractMedia(bubble) {
  try {
    const media = [];
    const seen = new Set();

    // Wait for any lazy-loading media inside the bubble to settle.
    let imgs = Array.from(bubble.querySelectorAll('img'));
    let videos = Array.from(bubble.querySelectorAll('video'));
    await Promise.all([
      ...imgs.map(img =>
        img.complete
          ? Promise.resolve()
          : new Promise(resolve => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
              // Failsafe so extraction is never blocked for more than 500 ms.
              window.setTimeout(resolve, 500);
            })
      ),
      ...videos.map(video =>
        video.readyState >= 1
          ? Promise.resolve()
          : new Promise(resolve => {
              video.addEventListener('loadedmetadata', resolve, { once: true });
              video.addEventListener('error', resolve, { once: true });
              window.setTimeout(resolve, 500);
            })
      )
    ]);

    // Re-query after waiting so any late-inserted images are included.
    imgs = Array.from(bubble.querySelectorAll('img'));
    videos = Array.from(bubble.querySelectorAll('video'));

    imgs.forEach(img => {
      if (img.classList.contains('emoji') || img.classList.contains('emoji-image')) return;
      if (img.closest(MEDIA_EXCLUDE_SELECTORS)) return;
      const src = img.currentSrc || img.src;
      if (!src) return;
      if (seen.has(src)) return;
      // Skip transparent placeholder data URIs used for lazy loading.
      if (src.startsWith('data:image/gif;base64,')) return;
      // Skip tiny media (<32px) to avoid icons/decorations.
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w > 0 && h > 0 && (w < 32 || h < 32)) return;
      // If the same wrapper already has a blob video, this image is just a
      // static thumbnail/poster; prefer the actual video.
      const mediaWrapper = img.closest('.media-container, .media-gif-wrapper, .attachment');
      if (mediaWrapper && mediaWrapper.querySelector('video[src^="blob:"]')) return;
      seen.add(src);
      media.push(src);
    });

    videos.forEach(video => {
      if (video.closest(MEDIA_EXCLUDE_SELECTORS)) return;
      const src = video.currentSrc || video.src;
      if (!src) return;
      if (seen.has(src)) return;
      const w = video.videoWidth || 0;
      const h = video.videoHeight || 0;
      if (w > 0 && h > 0 && (w < 32 || h < 32)) return;
      seen.add(src);
      media.push(src);
    });

    // Telegram sometimes renders photos as divs with background-image.
    const bgSelectors = [
      '.media-photo',
      '.message-photo',
      '.attachment',
      '.thumbnail',
      '.photo',
      '.media-container',
      '.message-media',
      '.photo-container',
      '.document-thumb',
      '.video-thumb',
      '.webpage-preview-photo',
      '.webpage-photo',
      '.link-preview-photo'
    ].join(', ');
    bubble.querySelectorAll(bgSelectors).forEach(el => {
      const style = window.getComputedStyle(el);
      const bg = style.backgroundImage;
      if (!bg || bg === 'none') return;
      const match = bg.match(/url\(["']?(blob:[^"')]+)["']?\)/);
      if (!match) return;
      const url = match[1];
      if (seen.has(url)) return;
      seen.add(url);
      media.push(url);
    });

    // Attachments (files, videos, audio, GIFs) are often linked via <a> tags
    // inside wrappers or with a download attribute.
    const attachmentSelectors = [
      '.attachment a[href]',
      '.document a[href]',
      '.audio a[href]',
      '.file a[href]',
      '.video a[href]',
      '.media-container a[download]',
      'a[download]'
    ].join(', ');
    bubble.querySelectorAll(attachmentSelectors).forEach(a => {
      const url = a.href;
      if (!url || seen.has(url)) return;
      if (!url.startsWith('blob:')) return;
      seen.add(url);
      media.push(url);
    });

    // Only keep blob: URLs as media references. External/reference links
    // (e.g. t.me, co.uk) belong in the links array, not media.
    return media.filter(url => url.startsWith('blob:'));
  } catch (err) {
    console.error('[TelegramRecorder] extractMedia failed', err);
    return [];
  }
}

/**
 * Orchestrate extraction of a full message record.
 * @param {Element} bubble
 * @param {string} sessionId
 * @returns {Promise<MessageRecord>}
 */
async function extract(bubble, sessionId) {
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
    let media = await extractMedia(bubble);
    let links = extractLinks(bubble);

    const record = {
      messageId,
      sessionId,
      groupId,
      posterName,
      posterId,
      content,
      timestamp,
      media,
      links,
      screenshotFile: messageId ? `${messageId}.png` : null
    };

    console.log('[TelegramRecorder] extracted', messageId, { posterName, posterId, contentLength: content?.length, media: media.length, links: links.length });
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
      media: [],
      links: [],
      screenshotFile: null
    };
  }
}
