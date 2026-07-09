# Telegram Message Recorder — Chrome Extension

## Planning Document (Final)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Extension Architecture](#2-extension-architecture)
3. [Telegram Web K — DOM Structure](#3-telegram-web-k--dom-structure)
4. [Sender Identity Resolution](#4-sender-identity-resolution)
5. [MutationObserver Strategy](#5-mutationobserver-strategy)
6. [Content Extraction Rules](#6-content-extraction-rules)
7. [Screenshot Pipeline](#7-screenshot-pipeline)
8. [Rapid Message Queue](#8-rapid-message-queue)
9. [Data Schemas](#9-data-schemas)
10. [File System Layout](#10-file-system-layout)
11. [Software Flows](#11-software-flows)
12. [Extension Popup — Specification](#12-extension-popup--specification)
13. [Viewer Page — Specification](#13-viewer-page--specification)
14. [State Management](#14-state-management)
15. [Collision Handling](#15-collision-handling)
16. [Extension Permissions](#16-extension-permissions)
17. [Known Limitations & Workarounds](#17-known-limitations--workarounds)
18. [Research Items Resolved](#18-research-items-resolved)
19. [Implementation Phases](#19-implementation-phases)

---

## 1. Overview

A Chrome Extension targeting **Telegram Web K** (`web.telegram.org/k/`) that passively records
new messages via DOM observation, captures screenshots, and persists structured data to the local
filesystem. A viewer page enables multi-group browsing, session filtering, and CSV export.

**Target platform:** Telegram Web K exclusively. The extension detects if the user is on Web A
(`/a/`) or Web Z (`/z/`) and offers a manual switch to `/k/`. Telegram blocks direct,
group-preserving URL changes from the extension popup, so the switch opens the Web K root
and the user must navigate back to the desired group manually.

**No server required.** All data stays local. Files written to `Downloads/telegram-recorder/`.

---

## 2. Extension Architecture

**Manifest Version:** MV3

```
telegram-recorder-chrome-ext/
├── manifest.json
├── background/
│   └── service-worker.js         # State, chrome.downloads, message broker
├── content/
│   ├── content.js                # MutationObserver setup + orchestration
│   ├── extractor.js              # DOM → structured message data
│   ├── screenshot.js             # Screenshot strategy orchestrator
│   ├── screenshot-canvas.js      # html2canvas-based capture
│   └── screenshot-tab.js         # chrome.tabs.captureVisibleTab crop
├── lib/
│   └── html2canvas.min.js        # Canvas rendering library
├── popup/
│   ├── popup.html                # Start/Stop UI, page validation, group info
│   ├── popup.js
│   └── popup.css
├── shared/
│   └── messages.js               # Message type constants
├── viewer/
│   ├── viewer.html               # Single-group record viewer
│   ├── viewer.js
│   └── viewer.css
└── icons/
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```

Icon PNGs are optional. The extension runs without them; add them and reference them in
`manifest.json` if you want toolbar icons.

### Component Responsibilities

| Component | Context | Responsibilities |
|---|---|---|
| `service-worker.js` | Background (persistent via keepalive) | Recording state, `chrome.downloads`, routing messages between content ↔ popup |
| `content.js` | Injected into `web.telegram.org/k/*` | MutationObserver lifecycle, message processing queue, screenshot trigger, media download |
| `extractor.js` | Same context as `content.js` | DOM parsing → structured data object |
| `screenshot.js` | Same context as `content.js` | Chooses canvas or tab capture strategy |
| `screenshot-canvas.js` | Same context as `content.js` | html2canvas-based full-bubble render |
| `screenshot-tab.js` | Same context as `content.js` | `chrome.tabs.captureVisibleTab` + viewport crop |
| `popup.html/js` | Extension popup | Page validation, group info display, start/stop, session status, screenshot/media settings |
| `viewer.html/js` | `chrome-extension://...` page | File System Access API, table render, session filter, CSV export, media/screenshot lightboxes |

### MV3 Communication Channels

```
popup.js  ←→  service-worker.js  ←→  content.js
              (chrome.runtime.sendMessage / chrome.tabs.sendMessage)
```

The service worker acts as the central coordinator. Direct popup ↔ content communication is
avoided to prevent race conditions when the popup closes and reopens.

---

## 3. Telegram Web K — DOM Structure

### Confirmed DOM Hierarchy

```html
<!-- Chat scroll container — parent of all message groups -->
<div class="bubbles" data-peer-id="-2350891274">  ← group peer ID

  <!-- One bubbles-group per sender cluster -->
  <div class="bubbles-group [bubbles-group-last]">

    <!-- Avatar — data-peer-id = SENDER's effective peer ID (always) -->
    <div class="bubbles-group-avatar-container">
      <div class="avatar bubbles-group-avatar user-avatar"
           data-peer-id="8419206193">        ← sender peer ID (positive = real user)
        <img class="avatar-photo" src="blob:...">
      </div>
    </div>

    <!-- One or more bubbles from the same sender -->

    <!-- Bubble — regular user message (name always shown per bubble) -->
    <div data-mid="4294984774"
         data-peer-id="-2350891274"           ← group peer ID (always)
         data-timestamp="1782958658"
         class="bubble is-in can-have-tail is-group-first">
      <div class="bubble-content-wrapper">
        <div class="bubble-content">

          <!-- Sender name — present when sender is a real user -->
          <div class="colored-name name floating-part next-is-message"
               data-peer-id="8419206193">
            <span class="peer-title"
                  data-peer-id="8419206193"
                  data-with-premium-icon="1">Hao Xiang Yong</span>
          </div>

          <!-- Text content -->
          <div class="message spoilers-container">
            <span class="translatable-message">
              Message text here
              <img src="assets/img/emoji/1f4b0.png"
                   class="emoji emoji-image" alt="💰">
              <a class="anchor-url"
                 href="https://t.me/example">t.me/example</a>
            </span>
          </div>

        </div>
      </div>
    </div>

    <!-- Bubble — anonymous admin / channel post (hide-name = no sender element) -->
    <div data-mid="4294984776"
         data-peer-id="-2350891274"
         data-timestamp="1782959801"
         class="bubble hide-name video is-in can-have-tail is-group-first is-group-last">
      <div class="bubble-content-wrapper">
        <div class="bubble-content">

          <!-- No .colored-name / .peer-title present (hide-name) -->

          <!-- Media attachment -->
          <div class="attachment media-container">
            <img class="media-photo" src="blob:...">
            <video class="media-video" src="stream/..."></video>
          </div>

          <div class="message spoilers-container">
            <span class="translatable-message">...</span>
          </div>

        </div>
      </div>
    </div>

  </div>

</div>
```

### Data Attribute Reference

| Attribute | On Element | Value | Notes |
|---|---|---|---|
| `data-peer-id` | `.bubbles` | Group/chat peer ID | Alternative group ID source |
| `data-peer-id` | `.bubbles-group-avatar` | **Sender's effective peer ID** | Positive = real user; negative = anonymous/group post |
| `data-peer-id` | `.bubble` | Group/chat peer ID | Same as `.bubbles` peer ID |
| `data-mid` | `.bubble` | Message ID | Unique within this chat |
| `data-timestamp` | `.bubble` | Unix timestamp (seconds) | |
| `data-peer-id` | `.colored-name` | Sender peer ID | Same as avatar peer ID |
| `data-peer-id` | `span.peer-title` | Sender peer ID | Use for name + ID extraction |

### `hide-name` Class Meaning

`hide-name` does NOT mean "consecutive message from same user". It means the sender is
posting anonymously as the group entity (anonymous admin or channel post). The `.colored-name`
and `.peer-title` elements are absent. The avatar's `data-peer-id` equals the group peer ID.

Real users always have `.peer-title` rendered on every bubble regardless of consecutiveness.

### Public Groups / Forwarded Channel Posts

In public groups and channels the sender metadata may live inside the bubble itself rather
than the `bubbles-group` header, especially for forwarded channel posts:

```html
<div class="bubbles-group">

  <!-- Group-level avatar: the user who forwarded the message -->
  <div class="bubbles-group-avatar-container">
    <div class="avatar avatar-like avatar-40 avatar-gradient bubbles-group-avatar user-avatar"
         data-peer-id="7655458616" data-color="orange">三</div>
  </div>

  <!-- Top-level forwarded bubble -->
  <div class="bubble forwarded must-have-name is-in can-have-tail is-group-first is-group-last"
       data-mid="4295141094"
       data-peer-id="-1701501526"
       data-timestamp="1782978702">
    <div class="bubble-content-wrapper">
      <div class="bubble-content">

        <!-- Forwarded sender metadata rendered inside the bubble -->
        <div class="name floating-part next-is-message" dir="auto">
          <span class="i18n bubble-name-forwarded">Forwarded from
            <br class="hide-ol">
            <div class="avatar avatar-like avatar-20 avatar-gradient bubble-name-forwarded-avatar"
                 data-peer-id="7655458616" data-color="orange">三</div>
            <span class="peer-title" dir="auto"
                  data-peer-id="7655458616" data-with-premium-icon="0">三</span>
          </span>
        </div>

        <!-- Text content -->
        <div class="message spoilers-container" dir="auto">
          <span class="translatable-message">
            Unlock Extra Bonuses Now!
            <img src="assets/img/emoji/1f499.png" class="emoji emoji-image" alt="💙">
            Rent out your bank account today!
            <img src="assets/img/emoji/1f933.png" class="emoji emoji-image" alt="🤳">
            Supported banks: POSB, OCBC, GXS, LiquidPay, Mari, CIMB, Trust, and more.
          </span>
          <span class="time">
            <span class="i18n" dir="auto">15:51</span>
            <div class="time-inner" title="2 July 2026, 15:51:42 Original: 2 July 2026, 15:51:31">
              <span class="i18n" dir="auto">15:51</span>
            </div>
          </span>
          <span class="clearfix"></span>
        </div>

        <svg viewBox="0 0 11 20" width="11" height="20" class="bubble-tail">
          <use href="#message-tail-filled"></use>
        </svg>

      </div>
    </div>
  </div>

</div>
```

Key differences:
- The bubble itself has `.bubble.forwarded.must-have-name` and the usual `data-mid`,
  `data-peer-id` (group), and `data-timestamp` attributes.
- Sender avatar may be `.bubble-name-forwarded-avatar[data-peer-id]` inside the bubble
  (authoritative for the original forwarded sender). A `.bubbles-group-avatar` is still
  present at the group level and is used as a fallback.
- Sender name is `.bubble-name-forwarded .peer-title`.
- Standard emoji are `<img class="emoji emoji-image">` in addition to Telegram's
  `<custom-emoji-element>` / `<custom-emoji-renderer-element>` stickers.
- The inline timestamp contains a nested `.time-inner` with an "Original: ..." tooltip;
  timestamp elements must be stripped from extracted text.
- Hashtags use `a.anchor-hashtag`; mentions use `a.mention`.

### Non-Forwarded Public Group Message

Regular public-group messages keep the same `.bubbles-group` clustering as private groups,
but the `.peer-title` can contain an `.emoji-status` decoration alongside the visible name:

```html
<div class="bubbles-group">
  <div class="bubbles-group-avatar-container">
    <div class="avatar bubbles-group-avatar user-avatar" data-peer-id="8313477730">
      <img class="avatar-photo" src="blob:...">
    </div>
  </div>

  <div class="bubble is-in can-have-tail is-group-first"
       data-mid="10145"
       data-peer-id="-1701501526"
       data-timestamp="1782899304">
    <div class="bubble-content-wrapper">
      <div class="bubble-content">

        <div class="colored-name name floating-part" data-peer-id="8313477730">
          <span class="peer-title with-icons" data-peer-id="8313477730" dir="auto">
            <span class="peer-title-inner">Max Teh</span>
            <span class="emoji-status">…</span>
          </span>
        </div>

        <div class="message spoilers-container">
          <span class="translatable-message">
            WTS
            <custom-emoji-element class="custom-emoji media-sticker-wrapper" data-sticker-emoji="✨">…</custom-emoji-element>
            MacBook Air M3
            <custom-emoji-element>…</custom-emoji-element>
            <a class="mention" href="https://t.me/SGMaxTehh">@SGMaxTehh</a>
          </span>
        </div>

      </div>
    </div>
  </div>
</div>
```

Name extraction must prefer `.peer-title-inner` when it exists, otherwise the sibling
`.emoji-status` canvas/SVG text can be appended to the sender name. Text extraction strips
all `<custom-emoji-element>` / `<custom-emoji-renderer-element>` children and normalizes
runs of whitespace to single spaces.

### System / Service Messages

System messages (join events, pinned message notifications, etc.) appear as DOM additions to
the messages container. Some have no `data-mid`, while others (e.g. "X joined the group") do
carry a `data-mid` and use the `service` bubble class. Both conditions are skipped:

```js
if (!mid) return;                         // no message ID
if (bubble.classList.contains('service')) return;  // system/service message
```

---

## 4. Sender Identity Resolution

### Resolution Chain (applied to every `.bubble`)

```
Step 1 — Avatar peer ID (sender's effective peer ID):
  Try bubble-level avatar first:
    bubble.querySelector('.avatar[data-peer-id], .bubble-name-forwarded-avatar[data-peer-id]')
  Fallback: walk up to parent .bubbles-group → .bubbles-group-avatar[data-peer-id]
  → avatarPeerId = avatar.dataset.peerId

Step 2 — Group peer ID (for comparison):
  groupId = bubble.dataset.peerId

Step 3 — Determine sender type:
  if (avatarPeerId === groupId):
    → Anonymous/group post (admin posting as group, or channel post-as-group)
    → posterId = groupId
    → posterName = null
  else if (avatarPeerId is null):
    → Anonymous/group post (no sender resolvable)
    → posterId = groupId
    → posterName = null
  else:
    → Real sender (user, bot, or channel)
    → posterId = avatarPeerId
    → posterName = bubble.querySelector('.peer-title')?.textContent.trim() ?? null
```

### Outcomes

| Scenario | `posterId` | `posterName` |
|---|---|---|
| Real user | User peer ID (positive int) | Display name string |
| Forwarded channel / bot / public group sender | Channel/bot peer ID (negative int) | Display name string |
| Anonymous admin / group post | Group peer ID (negative int) | `null` |
| No avatar resolvable (edge case) | `null` | `null` |

---

## 5. MutationObserver Strategy

### Target

Observe the `.bubbles` scroll container with `childList: true, subtree: true`.

Do NOT target `.bubbles-group-last` — this class moves between elements as new messages arrive
and cannot be used as a stable observation point.

### Mutation Handler

```
Two scenarios for new messages:

Scenario A — New sender arrives (new .bubbles-group added to .bubbles):
  addedNodes contains: div.bubbles-group
  → querySelectorAll('.bubble') within it → process each individually

Scenario B — Same sender, new consecutive message (.bubble added to existing .bubbles-group):
  addedNodes contains: div.bubble
  → process directly
```

### Handler Pseudocode

```js
function handleMutations(mutations) {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      // Direct bubble addition (Scenario B)
      if (node.classList.contains('bubble')) {
        enqueue(node);
        continue;
      }

      // New bubbles-group containing one or more bubbles (Scenario A)
      node.querySelectorAll?.('.bubble').forEach(enqueue);
    }
  }
}
```

### Guards in `processBubbleNode(bubble)`

```
1. No data-mid → skip
2. bubble.classList.contains('service') → skip (system/service message)
3. mid in baselineSet → skip (existed before recording started)
4. mid in recordedSet → skip (already processed — collision guard)
5. Else → extract, download, and add to processing queue
```

### Safety Scan Fallback

Because Telegram's SPA router may recreate the `.bubbles` container while a session is active,
a periodic scan (e.g. every 3 seconds) walks `document.querySelectorAll('.bubble[data-mid]')` and
enqueues any bubble whose `data-mid` is neither in `baselineSet` nor `recordedSet`. This catches
messages that were inserted during brief observer detachments without adding noticeable overhead.

---

## 6. Content Extraction Rules

### 6.1 Text Content — Emoji / Sticker Handling

Emoji are rendered as `<img class="emoji emoji-image" alt="💰">` inside `.translatable-message`.
Public groups and channels also use `<custom-emoji-element>` and `<custom-emoji-renderer-element>`
for stickers and custom emoji. These elements are replaced with either the raw default emoji
character or a marker, so the extracted text still indicates where an emoji appeared.

Replacement rules:
- If the candidate (`data-sticker-emoji`, `alt`, or inner `img[alt]`) is a single default
  emoji grapheme (e.g. `💰`, `✨`), use it as-is.
- Otherwise, wrap the candidate in braces (e.g. `{party-popper}`).
- If no usable attribute exists, use `{}`.

```
clone = translatable.cloneNode(true)
clone.querySelectorAll('img.emoji, img.emoji-image, custom-emoji-element, custom-emoji-renderer-element')
  .forEach(el => {
    candidate = el.dataset.stickerEmoji?.trim() || el.alt?.trim() ||
                el.querySelector('img[alt]')?.alt?.trim() || ''
    if (isSingleDefaultEmojiGrapheme(candidate)) replacement = candidate
    else if (candidate) replacement = `{${candidate}}`
    else replacement = '{}'
    el.replaceWith(document.createTextNode(replacement))
  })
// Telegram interleaves a lot of wrapper whitespace around stickers/emoji.
// Preserve intentional line breaks for the viewer, but collapse runs of
// spaces/tabs and multiple blank lines.
content = clone.textContent
  .replace(/[ \t]+/g, ' ')
  .replace(/\n+/g, '\n')
  .trim()
// Browser decodes HTML entities (&amp; → &) automatically via textContent
```

### 6.2 Links — Deduplicated URL Array

Link text is preserved in the `content` string (via `textContent`).
The `href` values from external URLs, mentions, and hashtags are separately extracted into
`links: string[]`.

```
links = []
translatable.querySelectorAll('a.anchor-url, a.mention, a.anchor-hashtag').forEach(a => {
  url = a.href  // browser-resolved absolute URL
  if (!links.includes(url)) links.push(url)
})
```

### 6.3 Media URLs — Ephemeral Blob / Stream URLs

```
media = []
// Photos / videos / files / GIFs inside the bubble.
// Includes <img src>, <video src>, background-image URLs, and attachment <a href>.
// Avatars, emoji, tiny images, and GIF poster frames are excluded.
bubble.querySelectorAll('img, video, .media-photo, .message-photo, .attachment, .thumbnail, .photo, a[download]')
  .forEach(el => {
    const url = el.currentSrc || el.src || el.href || backgroundImageUrl(el)
    if (!url) return
    if (isAvatarOrEmoji(el)) return
    if (isPosterFrame(el)) return   // skip GIF/video poster thumbnails
    if (!media.includes(url)) media.push(url)  // blob:, stream:, or file URL
  })

// Keep only same-origin blob: URLs and Telegram stream: URLs as media references.
return media.filter(url => url.startsWith('blob:') || url.startsWith('stream:'))
```

Blob and `stream:` URLs are ephemeral (expire with the tab session). They are stored in the JSON
record for reference but will be dead after the tab is closed or refreshed. The screenshot captures
media visually. Stickers and custom emoji are excluded from `media[]` because they are part of the
message text, not standalone media attachments.

Telegram renders animated GIFs as silent videos inside a `.media-gif-wrapper`. That wrapper also
contains a static JPEG poster image (`<img class="media-photo">`). The poster must be skipped so
that the actual video blob is captured; otherwise the JPEG thumbnail is saved instead of the GIF.
Any image whose wrapper already contains a `<video>` is also treated as a poster frame and skipped.

Media detection checks both bubble-level classes (`photo`, `video`, `document`, etc.) and the
presence of actual media wrappers/elements (`.media-gif-wrapper`, `.media-container`, `.attachment`,
`.media-photo`, `.media-video`, `<audio>`). Custom-emoji stickers are deliberately excluded from
this detection.

#### Lazy-Loaded Photos

Telegram only inserts the actual `<img class="media-photo">` blob source when the bubble scrolls
into the viewport. If media is extracted immediately on bubble insertion, the image element is not
yet present and extraction returns nothing. Therefore the final media extraction and download
happen when the bubble reaches the front of the screenshot queue:

```
processNext():
  if (bubbleHasMedia(bubble)):
    bubble.scrollIntoView({ block: 'center', behavior: 'instant' })
    wait for contained <img>/<video> elements to load
    re-extract media
    download any newly found blob:/stream: URLs
  captureScreenshot(bubble)
  save files
```

Video URLs may be either `blob:` (ephemeral same-origin blobs) or Telegram `stream:` URLs (internal
streaming endpoints). Both are captured as references; downloads are attempted for both schemes, but
`stream:` URLs may fail if Telegram's streaming endpoint rejects the request.

### 6.4 Complete Extraction Object

```js
{
  messageId:   bubble.dataset.mid,
  groupId:     bubble.dataset.peerId,                      // group peer ID
  timestamp:   new Date(+bubble.dataset.timestamp * 1000).toISOString(),
  posterName:  resolvePosterName(bubble),                  // string | null
  posterId:    resolvePosterPeerId(bubble),                 // string | null
  content:     extractText(bubble),                        // emoji-stripped, link text preserved
  media:       extractMedia(bubble),                       // string[] — blob:/stream: URLs
  mediaFiles:  downloadMessageMedia(extractMedia(bubble)), // string[] — local "media/<guid>.ext" paths
  links:       extractLinks(bubble),                       // string[] — unique hrefs
  sessionId:   currentSessionId,                           // set by recording state
  screenshotFile: `${bubble.dataset.mid}.png`,
}
```

`mediaFiles` is populated in two places: (1) an initial download attempt right after extraction,
and (2) a second attempt when the bubble is scrolled into view for its screenshot, which catches
lazy-loaded photos that were not present at extraction time.

---

## 7. Screenshot Pipeline

### Process (per message)

```
1. Choose capture strategy (`chrome.storage.local` key `useCanvasCapture`; default = true/canvas-first):
   a. Canvas-first: try html2canvas full-bubble render
      → if successful, return PNG data URL
   b. Fallback / disabled: use tab capture

2. Tab capture path:
   a. initialRect = element.getBoundingClientRect()
   b. If initialRect.height > viewport height → element.scrollIntoView({ block: 'start' })
      else → element.scrollIntoView({ block: 'center' })
   c. await 150ms  — allow repaint to settle
   d. await requestAnimationFrame  — ensure scroll position is reflected
   e. rect = element.getBoundingClientRect()
   f. visibleRect = intersection of rect with the current viewport
   g. dpr = window.devicePixelRatio  — account for retina displays

   h. content.js → background: { type: 'CAPTURE_TAB', focus: true }
   i. background restores the sender window if minimized, focuses it, activates the
      sender tab, then calls chrome.tabs.captureVisibleTab({ format: 'png' }) with 3 retries.
      Empty data URLs are treated as failures and retried.
      → fullDataUrl (entire visible tab as PNG base64)
   j. background → content.js: { fullDataUrl }

   k. content.js: create <canvas> width=(visibleRect.width × dpr), height=(visibleRect.height × dpr)
   l. img.onload: ctx.drawImage(fullImg, -(visibleRect.left × dpr), -(visibleRect.top × dpr))
   m. croppedDataUrl = canvas.toDataURL('image/png')

3. content.js → background: { type: 'SAVE_FILES', messageData, croppedDataUrl }
4. background: chrome.downloads.download() × 2
      filename: `telegram-recorder/{groupId}/{messageId}.png`
      filename: `telegram-recorder/{groupId}/{messageId}.json`
```

### Notes

- `captureVisibleTab` requires the tab to be visible (active). The extension only records from
  the active Telegram tab, so this is always satisfied.
- `scrollIntoView` with `behavior: 'instant'` prevents animation delay. 150ms wait is the
  minimum observed for repaint; adjust if screenshots show partially rendered content.
- The service worker restores the sender window if minimized, focuses it, and activates the
  sender tab before each capture. It retries up to 3 times with 500 ms delays because
  `captureVisibleTab` can return an empty result while the page is still painting or the
  window focus is transitioning. JSON is still saved if all retries fail. This briefly brings
  the Telegram window to the foreground.
- Messages taller than the viewport are scrolled to the top and clipped to the visible area.
  This avoids transparent/failed screenshots; very long messages are therefore captured as
  their top portion only.
- Canvas crop uses `dpr` to correctly handle retina/HiDPI screens — without this, crops would
  be offset by a 2× factor on Retina displays.

---

## 8. Rapid Message Queue

When multiple messages arrive rapidly, screenshot captures must be serialized (each requires
scroll → wait → capture). A FIFO queue processes messages one at a time.

### Queue Behavior

```
On enqueue(bubble):
  queue.push(bubble)
  if (!isProcessing) processNext()

async function processNext():
  if (queue.length === 0): isProcessing = false; return
  isProcessing = true
  bubble = queue.shift()
  await captureAndSave(bubble)
  processNext()  // tail call — continues until queue empty
```

### Characteristics

- **No messages dropped.** All mutations are queued regardless of how fast they arrive.
- Queue processes in arrival order (FIFO).
- In a very active chat, the screenshot queue may lag behind real-time. The JSON data record
  is still captured accurately at enqueue time (data extracted immediately before queuing).
- Screenshot is taken when the message reaches the front of the queue — message should still
  be visible if the user hasn't scrolled far. If the message has scrolled off-screen,
  `scrollIntoView` will bring it back.

### Data Capture Timing

```
On bubble detection (before enqueue):
  recordedSet.add(mid)                      ← immediate, prevents double-processing
  messageData = extractor.extract(bubble)   ← immediate
  if bubbleHasMedia(bubble):
    waitForMediaReady(bubble)               ← allow lazy/injected media to settle
    re-extract media
  messageData.mediaFiles = downloadMessageMedia(messageData.media)
  queue.push({ bubble, messageData })

On dequeue (when screenshot slot is free):
  if bubbleHasMedia(bubble):
    bubble.scrollIntoView({ block: 'center', behavior: 'instant' })
    wait for contained <img>/<video> to load
    re-extract media and download any new blob:/stream: URLs
  screenshot pipeline for this bubble
  save messageData + screenshot
```

Text, links, and sender metadata are captured immediately when the bubble is detected. Media is
first extracted after a short readiness wait, then finalized when the bubble is scrolled into view
for its screenshot, because Telegram lazy-loads photo blobs and only injects the real `<img>`
source at that point.

---

## 9. Data Schemas

### 9.1 Session Manifest — `manifest-{unix-timestamp}.json`

```json
{
  "id": "1704067200000",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "groupId": "-2350891274",
  "groupName": "My Telegram Group"
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unix timestamp in ms — also used as session identifier |
| `timestamp` | `string` | ISO 8601 UTC |
| `groupId` | `string` | Telegram group peer ID |
| `groupName` | `string` | Group display name at time of recording |

### 9.2 Message Record — `{message-id}.json`

```json
{
  "messageId": "4294984774",
  "sessionId": "1704067200000",
  "groupId": "-2350891274",
  "posterName": "Hao Xiang Yong",
  "posterId": "8419206193",
  "content": "Yes, we are waiting for today's trading results. Hopefully it goes smoothly",
  "timestamp": "2026-07-02T10:17:38.000Z",
  "media": [],
  "links": [],
  "screenshotFile": "4294984774.png"
}
```

**Anonymous post example:**
```json
{
  "messageId": "4294984776",
  "sessionId": "1704067200000",
  "groupId": "-2350891274",
  "posterName": null,
  "posterId": "-2350891274",
  "content": "We have disbursed investor profits!\nPlease check your bank account!!!",
  "timestamp": "2026-07-02T10:36:41.000Z",
  "media": [
    "blob:https://web.telegram.org/94e1baae-13ef-427f-ba9e-c1b3b535ec01"
  ],
  "links": [
    "https://t.me/PercentClub1Tradingg"
  ],
  "screenshotFile": "4294984776.png"
}
```

| Field | Type | Description |
|---|---|---|
| `messageId` | `string` | `data-mid` from bubble |
| `sessionId` | `string` | Links to manifest `id` |
| `groupId` | `string` | Group peer ID |
| `posterName` | `string \| null` | Display name; `null` for anonymous posts |
| `posterId` | `string \| null` | Sender peer ID; equals `groupId` for anonymous posts |
| `content` | `string` | Plain text, emoji stripped, link text preserved, HTML entities decoded |
| `timestamp` | `string` | ISO 8601 UTC, derived from `data-timestamp` |
| `media` | `string[]` | Blob/file URLs of media attachments (photos, videos, GIFs, files) — ephemeral |
| `mediaFiles` | `string[]` | Local "media/<guid>.ext" paths saved by the extension |
| `links` | `string[]` | Unique absolute URLs from anchor tags |
| `screenshotFile` | `string` | Relative filename of PNG in same directory |

---

## 10. File System Layout

```
Downloads/
└── telegram-recorder/
    ├── -2350891274/                            ← group A (peer ID as folder name)
    │   ├── manifest-1704067200000.json         ← session 1
    │   ├── manifest-1704070800000.json         ← session 2
    │   ├── media/                              ← downloaded media attachments
    │   │   ├── 94e1baae-13ef-427f-ba9e-c1b3b535ec01.png
    │   │   └── a1b2c3d4.mp4
    │   ├── 4294984774.json
    │   ├── 4294984774.png
    │   ├── 4294984775.json
    │   ├── 4294984775.png
    │   ├── 4294984776.json
    │   └── 4294984776.png
    └── -1001234567890/                         ← group B
        ├── manifest-1704153600000.json
        ├── media/
        ├── 5000012345.json
        └── 5000012345.png
```

Viewer opens a single group folder (e.g. `telegram-recorder/-2350891274`).

---

## 11. Software Flows

### 11.1 Start Recording

```
User clicks "Start" in popup
  → popup.js → background: { type: 'START_RECORDING', tabId, groupId, groupName }
  → background:
      sessionId = Date.now().toString()
      activeSessions.set(tabId, { tabId, sessionId, groupId, groupName })
      persist activeSessions array to chrome.storage.local
      manifest = { id: sessionId, timestamp: ISO, groupId, groupName }
      chrome.downloads.download({
        filename: `telegram-recorder/${groupId}/manifest-${sessionId}.json`,
        url: jsonDataUrl(manifest)
      })
  → background → content.js: { type: 'START_RECORDING', sessionId, groupId }
  → content.js:
      baselineSet = new Set( all .bubble[data-mid] currently in DOM )
      recordedSet = new Set()
      attach MutationObserver to .bubbles container
```

### 11.2 New Message Detected

```
MutationObserver fires
  → handleMutations() → processBubbleNode(bubble)
    → guard checks (data-mid, service class, baselineSet, recordedSet)
    → recordedSet.add(mid)                       ← immediate, prevents double-processing
    → messageData = extractor.extract(bubble)   ← immediate
    → if bubbleHasMedia(bubble): waitForMediaReady + re-extract media
    → messageData.mediaFiles = downloadMessageMedia(messageData.media)
    → queue.push({ bubble, messageData })
    → processNext() if not already processing

processNext():
  { bubble, messageData } = queue.shift()
  → if bubbleHasMedia(bubble):
      bubble.scrollIntoView({ block: 'center', behavior: 'instant' })
      wait for contained <img>/<video> to load
      re-extract media and download any new blob:/stream: URLs
  → screenshot.js (canvas-first or tab capture):
      capture bubble → croppedDataUrl
  → background: SAVE_FILES { messageData, croppedDataUrl }
      chrome.downloads.download({ filename: `telegram-recorder/${groupId}/${mid}.png`, url: croppedDataUrl })
      chrome.downloads.download({ filename: `telegram-recorder/${groupId}/${mid}.json`, url: jsonDataUrl(messageData) })
  → processNext()  ← continue queue
```

### 11.3 Stop Recording

```
User clicks "Stop"
  → popup.js → background: { type: 'STOP_RECORDING', tabId }
  → background:
      removes tab's session from activeSessions and persists to chrome.storage.local
      sends STOP_RECORDING to the tab's content script
  → content.js:
      observer.disconnect()
      observer = null
      baselineSet.clear()
      recordedSet.clear()
      queue = []           ← discard pending queue (in-flight capture completes)
      isProcessing = false
      stop navigation polling
```

Note: any message currently mid-capture when Stop is clicked will complete and be saved.
Messages still in queue are discarded.

### 11.4 Chat Navigation While Recording

```
content.js detects chat navigation by observing the unique `.sidebar-header.topbar` element:
  - top bar is replaced when the user switches chats → parent MutationObserver fires
  - top bar attributes/subtree mutations (e.g. `data-peer-id` change) also trigger check
  - popstate / hashchange listeners kept as lightweight backup
  if (recording && newChatId !== currentGroupId):
    → send AUTO_STOPPED to background
    → background: removes tab session from activeSessions and persists
    → content.js: observer.disconnect(), clear queue
    → popup (if open): re-renders to "Stopped" state with note "Chat changed"
```

User must manually start a new recording session on the new chat.

### 11.5 Viewer Load Flow

```
User opens viewer.html → clicks "Open Folder"
  → window.showDirectoryPicker({ mode: 'read' })
  → User selects a single group folder (e.g. telegram-recorder/-2350891274)
  → Iterate entries within the selected folder:
      if directory named "media" → load media file handles, keyed by filename
      if file starts with "manifest-" and ends with ".json" → parse → sessions map
      if file ends with ".json" → parse → messages array
      if file ends with ".png" → index by stem (messageId) for screenshot lookup
  → sessions: Map<sessionId, SessionManifest>
  → messages: MessageRecord[]
  → Sort messages by timestamp DESC
  → Render table + session accordion
```

---

## 12. Extension Popup — Specification

### Page Validation States

```
Query active tab URL on popup open.

Case A — Not Telegram:
  ┌─────────────────────────────────────────┐
  │  Telegram Recorder                      │
  │                                         │
  │  ⚠ Navigate to web.telegram.org/k/     │
  │    to use this extension.               │
  │                                         │
  │  [ Open Record Viewer ↗ ]               │
  └─────────────────────────────────────────┘

Case B — Telegram Web A or Z (/a/ or /z/):
  ┌─────────────────────────────────────────┐
  │  Telegram Recorder                      │
  │                                         │
  │  ⚠ You are on Telegram Web A.          │
  │    This extension requires Web K.       │
  │                                         │
  │  [ Switch to Telegram Web K ]           │
  │    (opens /k/; Telegram prevents the    │
  │     extension from preserving the       │
  │     current group in the URL)           │
  │                                         │
  │  [ Open Record Viewer ↗ ]               │
  └─────────────────────────────────────────┘

Case C — Telegram Web K, no group open:
  ┌─────────────────────────────────────────┐
  │  Telegram Recorder                      │
  │                                         │
  │  Group    No group open                 │
  │  Status   Stopped                       │
  │                                         │
  │  (Start button disabled)                │
  │  [ Open Record Viewer ↗ ]               │
  └─────────────────────────────────────────┘

Case D — Telegram Web K, group open, not recording:
  ┌─────────────────────────────────────────┐
  │  Telegram Recorder                      │
  ├─────────────────────────────────────────┤
  │  Group    My Telegram Group             │
  │  ID       -2350891274                   │
  ├─────────────────────────────────────────┤
  │  Status   ● Stopped                     │
  ├─────────────────────────────────────────┤
  │  [ ▶ Start Recording ]                  │
  │  [ Open Record Viewer ↗ ]               │
  └─────────────────────────────────────────┘

Case E — Telegram Web K, recording active:
  ┌─────────────────────────────────────────┐
  │  Telegram Recorder                      │
  ├─────────────────────────────────────────┤
  │  Group    My Telegram Group             │
  │  ID       -2350891274                   │
  ├─────────────────────────────────────────┤
  │  Status   ● Recording                   │
  │  Session  1704067200000                 │
  ├─────────────────────────────────────────┤
  │  [ ■ Stop Recording ]                   │
  │  [ Open Record Viewer ↗ ]               │
  └─────────────────────────────────────────┘
```

### Popup Settings

Below the status row the popup shows two toggles persisted in `chrome.storage.local`:

- **Use canvas capture** (`useCanvasCapture`, default `true`) — when enabled, the screenshot
  pipeline tries `html2canvas` first and falls back to tab capture if the canvas render fails.
- **Download media** (`downloadMedia`, default `true`) — when enabled, the content script
  downloads photos, videos, GIFs, and files into the group's `media/` folder.

### Group Info Extraction

`popup.js` sends `GET_GROUP_INFO` to the content script via `chrome.tabs.sendMessage`.

Content script responds with `{ groupId, groupName }` extracted from:
- `groupId`: `.sidebar-header.topbar` `data-peer-id` (preferred), with fallback to URL hash fragment
  and `.bubbles[data-peer-id]`
- `groupName`: first match among `.sidebar-header.topbar .chat-info .peer-title`,
  `.chat-info .peer-title`, `.chat-info-title`, `.topbar .peer-title`, or `<title>` text content

If no chat identifier can be resolved → content script responds `{ groupId: null, groupName: null }`.

### Popup → Background → Content Message Flow

```
Popup opens:
  1. popup queries GET_ACTIVE_SESSIONS from background → render current state
  2. popup sends GET_GROUP_INFO → content.js → responds with group data
  3. popup updates group info display

Start clicked:
  1. popup → background: START_RECORDING { tabId, groupId, groupName }
  2. background updates storage, creates manifest, notifies content.js
  3. popup re-reads active sessions → re-renders

Stop clicked:
  1. popup → background: STOP_RECORDING { tabId }
  2. background updates storage, notifies content.js
  3. popup re-reads active sessions → re-renders
```

---

## 13. Viewer Page — Specification

### 13.1 Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Telegram Recorder — Viewer                                              │
│  [ Open Folder ]  [ Export CSV ]                                        │
├──────────────────────────────────────────────────────────────────────────┤
│  Group Info card                                                         │
│  Quick FAQ card                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  Filters                                                                 │
│  Poster IDs    [ Add a poster ID… ]   [Add]   [chip] [chip] [x]        │
│  Poster names  [ Add a poster name… ] [Add]   [chip] [chip] [x]        │
│  ☑ Match case  ☑ Match whole word                                       │
│  Content terms [ Add a content term… ] [Add]  [chip] [chip] [x]        │
│  ☑ Match case  ☑ Match whole word                                       │
│  Must have     ☑ Screenshot  ☐ Link                                     │
├──────────────────────────────────────────────────────────────────────────┤
│  [▶ Sessions]  ← accordion, collapsed by default                        │
├──────────────────────────────────────────────────────────────────────────┤
│  Table (see columns below)                                               │
│  ...                                                                     │
└──────────────────────────────────────────────────────────────────────────┘
```

### 13.2 Table Columns

| Column | Sortable | Details |
|---|---|---|
| Timestamp | Yes — default DESC | Formatted to local time via `toLocaleString()` |
| Session | Yes | Raw session ID (Unix timestamp) |
| Poster Name | Yes + multi-term filter | `—` when `null`; supports `admin`, `—`, or `-` keyword for anonymous posts |
| Poster ID | Yes | `—` when `null`; otherwise a clickable link to `https://web.telegram.org/k/#<posterId>` |
| Message Content | No | Full text shown in-cell; not collapsible |
| Media | No | Count label + each downloaded media file rendered as clickable anchor; stacked vertically. Click opens a media lightbox (image or video) loaded from the local file handle |
| Links | No | Each `href` rendered as clickable anchor; stacked vertically |
| Screenshot | No | Thumbnail max 80px height; click → lightbox overlay |

Sortable columns: click header once = ASC, again = DESC, third = reset to default.

### 13.3 Message Filters

The viewer provides three multi-term filters below the Filters heading. Terms within a
filter are combined with OR; filters are combined with AND (a row must match at least
one term in each active filter).

#### Poster IDs

- Input + Add button creates a filter chip.
- Poster IDs are matched **exactly** against the recorded `posterId` (no substring,
  no case/word options).
- Multiple chips match any of the listed IDs (OR within the Poster ID filter).
- Chips display match indicators but no option badges.

#### Poster Names

- Input + Add button creates a filter chip.
- The **Match case** and **Match whole word** checkboxes set the options for the
  next chip added; each chip stores its own options independently.
- Special keywords `admin`, `—`, or `-` match anonymous admin posts
  (`posterName == null && posterId == groupId`), regardless of case/word options.
- Chips display option badges: `Aa` for match-case, `W` for match-whole-word.
- Chips are colored green when at least one visible row matches, and red when none
  match.

#### Content Terms

- Input + Add button creates a filter chip.
- The **Match case** and **Match whole word** checkboxes set the options for the
  next chip added; each chip stores its own options independently.
- Chips display option badges: `Aa` for match-case, `W` for match-whole-word.
- Chips are colored green when at least one visible row matches, and red when none
  match, so users can see which terms are producing results.
- Multiple chips match any of the listed terms (OR within the Content filter).

#### Must Have

A separate section filters rows based on whether specific data exists:

- **Screenshot** — when checked, only rows with a screenshot file are shown.
  Checked by default.
- **Link** — when checked, only rows with at least one extracted link are shown.

If both are checked, rows must have both a screenshot and a link. If neither is
checked, this section imposes no restriction.

### 13.4 Session Filter Accordion

```
[▶ Sessions]   ← click to expand/collapse
  ──────────────────────────────────────────
  [ Select All ]  [ Deselect All ]
  ┌─────┬──────────────┬───────────┬──────────┐
  │     │ Session ID   │ Group Name│ Messages │
  │ ☑   │ 1704067200000│ Group A   │ 24       │
  │ ☑   │ 1704070800000│ Group A   │ 31       │
  └─────┴──────────────┴───────────┴──────────┘
```

- Sessions are shown in a small table with columns: Session ID, Group Name, Messages.
- The first column contains only a checkbox (no header) and is sized to fit the checkbox.
- Unchecking a session hides its rows in real-time (no reload).
- Select/Deselect All operates on all session checkboxes.

### 13.5 Lightboxes

**Screenshot lightbox**
- Click screenshot thumbnail → full-size image shown in overlay
- Overlay: semi-transparent dark background, centered image, click outside to close
- Image loaded via `URL.createObjectURL(await fileHandle.getFile())`

**Media lightbox**
- Click a media link in the Media column → overlay showing the downloaded image or video
- Video element has native controls
- Image/video loaded via `URL.createObjectURL(await fileHandle.getFile())`

All object URLs are revoked on `window.beforeunload`.

### 13.6 CSV Export

Export applies to currently **visible rows** (respects session filter + message filters).

**Column mapping:**

| CSV Header | Source | Notes |
|---|---|---|
| `timestamp` | `record.timestamp` | ISO 8601 |
| `session_id` | `record.sessionId` | |
| `session_label` | `session.timestamp → toLocaleString()` | Local time string |
| `group_id` | `record.groupId` | |
| `group_name` | `session.groupName` | |
| `poster_name` | `record.posterName` | Empty string if null |
| `poster_id` | `record.posterId` | Empty string if null |
| `content` | `record.content` | Quoted; internal newlines as `\n` |
| `links` | `record.links.join('\|')` | Pipe-separated URLs |
| `media` | `record.media.join('\|')` | Pipe-separated blob/file URLs (ephemeral) |
| `screenshot_file` | `record.screenshotFile` | Filename only (no path) |
| `screenshot_path` | `{groupId}/{screenshotFile}` | Relative to telegram-recorder/ root |

**Header note row** (first line after headers):
```
# Screenshots are local files. Resolve paths relative to your telegram-recorder/ folder.
# Blob URLs in 'media' column are ephemeral and expire when the recording tab is closed.
```

**Generation:** client-side `Blob` + `window.showSaveFilePicker()` with a suggested filename.
No server. If the picker is cancelled or unavailable, no file is written.

---

## 14. State Management

The extension supports **multiple concurrent recording sessions** across tabs/windows,
with one session per tab. A group-level guard prevents starting two recordings for the
same `groupId` at the same time.

### `chrome.storage.local` (persists across browser restarts)

| Key | Type | Description |
|---|---|---|
| `activeSessions` | `Array<ActiveSession>` | List of active sessions (one per tab) |

```ts
interface ActiveSession {
  tabId: number;
  sessionId: string;   // unix-ms timestamp
  groupId: string;     // group peer ID or @username
  groupName: string | null;
}
```

### `chrome.storage.session` (cleared on browser close)

No longer used for service-worker state. Each content script keeps its own
`recordedSet` in memory.

### Service Worker In-Memory

| Variable | Type | Description |
|---|---|---|
| `activeSessions` | `Map<number, ActiveSession>` | Active sessions keyed by tab ID |

On service worker wake (MV3 service workers may terminate and restart):
- Rehydrate `activeSessions` from `chrome.storage.local`
- Content scripts ask for their own session via `GET_SESSION` and resume if present

### Content Script In-Memory

| Variable | Type | Description |
|---|---|---|
| `baselineSet` | `Set<string>` | `data-mid` values present at START |
| `recordedSet` | `Set<string>` | `data-mid` values processed in this session |
| `observer` | `MutationObserver \| null` | Active observer instance |
| `queue` | `Array<QueueItem>` | Pending screenshot/save items |
| `isProcessing` | `boolean` | Queue lock flag |

---

## 15. Collision Handling

- `baselineSet` — all `data-mid` values in DOM at moment START is clicked
- `recordedSet` — all `data-mid` values processed in current session

On each `enqueue(bubble)`:
1. No `data-mid` → skip (system message)
2. `mid` in `baselineSet` → skip (pre-existing message)
3. `mid` in `recordedSet` → skip (already processed)
4. Else → `recordedSet.add(mid)` immediately, then add to queue

No file writes occur on collision. No error thrown. Silent skip.

**Edited messages** reuse the same `data-mid` — treated as collision → not re-recorded. The original record is preserved.

---

## 16. Extension Permissions

```json
{
  "manifest_version": 3,
  "permissions": [
    "tabs",
    "activeTab",
    "downloads",
    "storage",
    "scripting"
  ],
  "host_permissions": [
    "https://web.telegram.org/*"
  ],
  "content_scripts": [
    {
      "matches": ["https://web.telegram.org/k/*"],
      "js": [
        "shared/messages.js",
        "lib/html2canvas.min.js",
        "content/screenshot-canvas.js",
        "content/screenshot-tab.js",
        "content/screenshot.js",
        "content/extractor.js",
        "content/content.js"
      ],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["viewer/*"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

| Permission / Entry | Required For |
|---|---|---|
| `tabs` | `chrome.tabs.captureVisibleTab()`, `chrome.tabs.sendMessage()` |
| `activeTab` | Accessing active tab URL in popup |
| `downloads` | `chrome.downloads.download()` for all file saves |
| `storage` | `chrome.storage.local` (session storage is available but unused) |
| `scripting` | `chrome.scripting.executeScript()` for content-script reinjection |
| `host_permissions: web.telegram.org` | Content script injection |
| `web_accessible_resources: viewer/*` | Allowing the viewer page to load its own assets from any origin |

---

## 17. Known Limitations & Workarounds

| Limitation | Impact | Workaround / Decision |
|---|---|---|
| Telegram uses encrypted HTTPS (no packet access) | Cannot intercept messages at network level | DOM MutationObserver — sufficient for all data |
| `captureVisibleTab` captures entire tab | Larger data per capture | Canvas crop to `getBoundingClientRect()` with DPR correction |
| Blob media URLs expire with tab session | `media[]` URLs are dead after tab close | Screenshots capture media visually; filename in `screenshotFile`; blob URLs stored for in-session reference |
| CSV media portability | No portable media path in CSV | `screenshot_path` column stores `{groupId}/{filename}` relative path; comment row explains resolution |
| `hide-name` = anonymous sender | No name available | `posterName = null`; `posterId = groupId` (accurate — posted as group entity) |
| Emoji rendered as `<img>` | Mixed with text content | Clone + remove `img.emoji` before `textContent` read |
| Multiple messages arrive rapidly | Screenshot serialization lag | FIFO queue; data captured immediately at enqueue time, screenshot taken when slot free |
| MV3 service worker may terminate | In-flight state lost | `recordedSet` lives in each content script's memory; content scripts re-request their session via `GET_SESSION` after the service worker wakes |
| Chat navigation while recording | Observer on wrong DOM | Auto-stop when `.sidebar-header.topbar` changes; `popstate`/`hashchange` kept as backup; user must restart on new chat |
| Edited messages reuse `data-mid` | Re-record would overwrite | Treated as collision — original preserved, edit not re-recorded |
| Service messages have `data-mid` | Would be recorded as normal messages | Skipped by `bubble.classList.contains('service')` |
| Photos lazy-load on scroll | Media missing if extracted before bubble is visible | Final media extraction happens when the bubble is scrolled into view for its screenshot |
| Non-local `blob:` / `stream:` URLs | Dead after Telegram tab closes/refreshes | Downloaded files are persisted in `media/`; viewer FAQ warns about ephemeral links |
| Telegram blocks direct URL changes | Group-aware popup redirect from /a/ or /z/ to /k/#group fails | Popup offers a manual switch to `/k/` root; user reopens the group manually |

---

## 18. Research Items Resolved

| Item | Status | Finding |
|---|---|---|
| `.bubbles-group-avatar[data-peer-id]` — sender or group? | **Resolved** | Always carries sender's effective peer ID. Positive = real user. Negative = anonymous/group post. |
| `hide-name` meaning | **Resolved** | Anonymous admin / channel posting as group entity — not consecutive messages. Real users always show `.peer-title`. |
| Sender name element structure | **Resolved** | `div.colored-name > span.peer-title[data-peer-id]`. Both carry sender peer ID. |
| `data-peer-id` on `.bubble` | **Resolved** | Always the group/chat peer ID. Not the sender. |
| Multiple bubbles per sender in one group | **Resolved** | Both bubbles confirmed to have `.peer-title` (non-anonymous). Observer handles Scenario A and B. |
| System message `data-mid` absence | **Resolved** | Some service messages (e.g. join events) do carry `data-mid`. Reliable skip uses the `service` bubble class. |

### Remaining Research (Phase 1 — live DOM validation)

| # | Task | Goal |
|---|---|---|
| 1 | Group name selector | Confirm exact selector for chat name (`.chat-info .peer-title` or `<title>`) |
| 2 | `data-mid` uniqueness across sessions | Confirm IDs don't repeat across different recording sessions for same group |
| 3 | `subtree: true` observer performance | Verify no performance degradation in high-volume chats |
| 4 | Scroll + capture timing | Validate 150ms wait is sufficient; test on slow connections and media-heavy messages |
| 5 | Chat navigation detection | **Resolved** — observe `.sidebar-header.topbar` (unique element, replaced on chat switch); keep `hashchange`/`popstate` as backup |

---

## 19. Implementation Phases

| Phase | Components | Key Deliverables |
|---|---|---|
| **1 — Research** | Live DOM in browser | Validate group name selector, scroll timing, navigation event, system message guards |
| **2 — Extension Scaffold** | `manifest.json`, `service-worker.js` skeleton | Permissions, MV3 structure, storage schema, message type definitions |
| **3 — Content Script** | `content.js`, `extractor.js` | MutationObserver, extraction, queue, baseline snapshot, start/stop handlers |
| **4 — Screenshot Pipeline** | `screenshot.js`, background handler | `captureVisibleTab`, canvas crop, DPR handling |
| **5 — File Persistence** | Background download handler | JSON + PNG save via `chrome.downloads`, manifest creation |
| **6 — Popup** | `popup.html/js/css` | Page validation, auto-redirect, group info display, start/stop, session status |
| **7 — Viewer** | `viewer.html/js/css` | `showDirectoryPicker`, multi-group load, table, sortable headers, name search |
| **8 — Session Filter** | Viewer JS | Accordion, session checkboxes, select/deselect all, real-time filter |
| **9 — CSV Export** | Viewer JS | Column mapping, visible-row filter, comment header, download trigger |
| **10 — Polish** | All | Error handling, null field display (`—`), edge cases, icon assets |
