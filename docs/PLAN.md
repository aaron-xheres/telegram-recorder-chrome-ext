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
(`/a/`) or Web Z (`/z/`) and offers an auto-redirect to `/k/`.

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
│   └── screenshot.js             # captureVisibleTab + canvas crop
├── popup/
│   ├── popup.html                # Start/Stop UI, page validation, group info
│   ├── popup.js
│   └── popup.css
├── viewer/
│   ├── viewer.html               # Multi-group record viewer
│   ├── viewer.js
│   └── viewer.css
└── icons/
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```

### Component Responsibilities

| Component | Context | Responsibilities |
|---|---|---|
| `service-worker.js` | Background (persistent via keepalive) | Recording state, `chrome.downloads`, routing messages between content ↔ popup |
| `content.js` | Injected into `web.telegram.org/k/*` | MutationObserver lifecycle, message processing queue, screenshot trigger |
| `extractor.js` | Same context as `content.js` | DOM parsing → structured data object |
| `screenshot.js` | Same context as `content.js` | scroll → wait → request capture → crop |
| `popup.html/js` | Extension popup | Page validation, group info display, start/stop, session status |
| `viewer.html/js` | `chrome-extension://...` page | File System Access API, table render, session filter, CSV export |

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

### System / Service Messages

System messages (join events, pinned message notifications, etc.) appear as DOM additions to
the messages container but reliably lack `data-mid`. Absence of `data-mid` → skip.

---

## 4. Sender Identity Resolution

### Resolution Chain (applied to every `.bubble`)

```
Step 1 — Avatar peer ID (sender's effective peer ID):
  Walk up: .bubble → parent .bubbles-group → .bubbles-group-avatar[data-peer-id]
  → avatarPeerId = avatar.dataset.peerId

Step 2 — Group peer ID (for comparison):
  groupId = bubble.dataset.peerId

Step 3 — Determine sender type:
  if (avatarPeerId === groupId || avatarPeerId is negative):
    → Anonymous/group post
    → posterId = avatarPeerId  (group peer ID — accurate, reflects post-as-group)
    → posterName = null
  else:
    → Real user
    → posterId = avatarPeerId
    → posterName = bubble.querySelector('span.peer-title')?.textContent.trim() ?? null
```

### Outcomes

| Scenario | `posterId` | `posterName` |
|---|---|---|
| Real user | User peer ID (positive int) | Display name string |
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

### Guards in `enqueue(bubble)`

```
1. No data-mid → skip (system message)
2. mid in baselineSet → skip (existed before recording started)
3. mid in recordedSet → skip (already processed — collision guard)
4. Else → add to processing queue
```

---

## 6. Content Extraction Rules

### 6.1 Text Content — Emoji Stripping

Emoji are rendered as `<img class="emoji emoji-image" alt="💰">` inside `.translatable-message`.
These must be removed before reading text. The `alt` unicode char is NOT preserved.

```
clone = translatable.cloneNode(true)
clone.querySelectorAll('img.emoji, img.emoji-image').forEach(el => el.remove())
content = clone.textContent.trim()
// Browser decodes HTML entities (&amp; → &) automatically via textContent
```

### 6.2 Links — Deduplicated URL Array

Link text is preserved in the `content` string (via `textContent`).
Only the `href` values are separately extracted into `links: string[]`.

```
links = []
translatable.querySelectorAll('a.anchor-url').forEach(a => {
  url = a.href  // browser-resolved absolute URL
  if (!links.includes(url)) links.push(url)
})
```

### 6.3 Media Images — Ephemeral Blob URLs

```
images = []
bubble.querySelectorAll('.attachment img.media-photo, .media-container img.media-photo')
  .forEach(img => {
    if (!img.classList.contains('emoji') && !img.classList.contains('emoji-image')) {
      images.push(img.src)  // blob: URL
    }
  })
```

Blob URLs are ephemeral (expire with the tab session). They are stored in the JSON record for
reference but will be dead after the tab is closed. The screenshot captures media visually.

### 6.4 Complete Extraction Object

```js
{
  messageId:   bubble.dataset.mid,
  groupId:     bubble.dataset.peerId,                      // group peer ID
  timestamp:   new Date(+bubble.dataset.timestamp * 1000).toISOString(),
  posterName:  resolvePosterName(bubble),                  // string | null
  posterId:    resolvePosterPeerId(bubble),                 // string | null
  content:     extractText(bubble),                        // emoji-stripped, link text preserved
  images:      extractMediaImages(bubble),                 // string[] — blob URLs
  links:       extractLinks(bubble),                       // string[] — unique hrefs
  sessionId:   currentSessionId,                           // set by recording state
  screenshotFile: `${bubble.dataset.mid}.png`,
}
```

---

## 7. Screenshot Pipeline

### Process (per message)

```
1. element.scrollIntoView({ block: 'center', behavior: 'instant' })
2. await 150ms  — allow repaint to settle
3. rect = element.getBoundingClientRect()
4. dpr = window.devicePixelRatio  — account for retina displays

5. content.js → background: { type: 'CAPTURE_TAB', tabId }
6. background: chrome.tabs.captureVisibleTab(tabId, { format: 'png' })
   → fullDataUrl (entire visible tab as PNG base64)
7. background → content.js: { fullDataUrl }

8. content.js: create <canvas> width=(rect.width × dpr), height=(rect.height × dpr)
9. img.onload: ctx.drawImage(fullImg, -(rect.left × dpr), -(rect.top × dpr))
10. croppedDataUrl = canvas.toDataURL('image/png')

11. content.js → background: { type: 'SAVE_FILES', messageData, croppedDataUrl }
12. background: chrome.downloads.download() × 2
      filename: `telegram-recorder/{groupId}/{messageId}.png`
      filename: `telegram-recorder/{groupId}/{messageId}.json`
```

### Notes

- `captureVisibleTab` requires the tab to be visible (active). The extension only records from
  the active Telegram tab, so this is always satisfied.
- `scrollIntoView` with `behavior: 'instant'` prevents animation delay. 150ms wait is the
  minimum observed for repaint; adjust if screenshots show partially rendered content.
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
On enqueue:
  messageData = extractor.extract(bubble)   ← immediate, before queue wait
  recordedSet.add(mid)                      ← immediate, prevents double-processing

On dequeue (when screenshot slot is free):
  screenshot pipeline for this bubble
  save messageData + screenshot
```

This ensures data accuracy even if the screenshot is delayed.

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
  "images": [],
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
  "images": [
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
| `images` | `string[]` | Blob URLs of media images — ephemeral |
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
    │   ├── 4294984774.json
    │   ├── 4294984774.png
    │   ├── 4294984775.json
    │   ├── 4294984775.png
    │   ├── 4294984776.json
    │   └── 4294984776.png
    └── -1001234567890/                         ← group B
        ├── manifest-1704153600000.json
        ├── 5000012345.json
        └── 5000012345.png
```

Viewer opens the `telegram-recorder/` root. Subdirectories are enumerated as groups.

---

## 11. Software Flows

### 11.1 Start Recording

```
User clicks "Start" in popup
  → popup.js → background: { type: 'START_RECORDING', groupId, groupName }
  → background:
      sessionId = Date.now().toString()
      state = { recording: true, sessionId, groupId, groupName }
      chrome.storage.local.set(state)
      chrome.storage.session.set({ recordedSet: [] })
      manifest = { id: sessionId, timestamp: ISO, groupId, groupName }
      chrome.downloads.download({
        filename: `telegram-recorder/${groupId}/manifest-${sessionId}.json`,
        url: jsonDataUrl(manifest)
      })
  → background → content.js: { type: 'START_RECORDING', sessionId }
  → content.js:
      baselineSet = new Set( all .bubble[data-mid] currently in DOM )
      attach MutationObserver to .bubbles container
```

### 11.2 New Message Detected

```
MutationObserver fires
  → handleMutations() → enqueue(bubble)
    → guard checks (data-mid, baselineSet, recordedSet)
    → messageData = extractor.extract(bubble)   ← immediate
    → recordedSet.add(mid)                       ← immediate
    → queue.push({ bubble, messageData })
    → processNext() if not already processing

processNext():
  { bubble, messageData } = queue.shift()
  → screenshot.js:
      bubble.scrollIntoView({ block: 'center', behavior: 'instant' })
      await 150ms
      rect = bubble.getBoundingClientRect()
      dpr = window.devicePixelRatio
      → background: CAPTURE_TAB
      ← fullDataUrl
      → canvas crop → croppedDataUrl
  → background: SAVE_FILES { messageData, croppedDataUrl }
      chrome.downloads.download({ filename: `telegram-recorder/${groupId}/${mid}.png`, url: croppedDataUrl })
      chrome.downloads.download({ filename: `telegram-recorder/${groupId}/${mid}.json`, url: jsonDataUrl(messageData) })
  → processNext()  ← continue queue
```

### 11.3 Stop Recording

```
User clicks "Stop"
  → popup.js → background: { type: 'STOP_RECORDING' }
  → background:
      chrome.storage.local.set({ recording: false, sessionId: null })
  → background → content.js: { type: 'STOP_RECORDING' }
  → content.js:
      observer.disconnect()
      observer = null
      baselineSet.clear()
      queue = []           ← discard pending queue (in-flight capture completes)
      isProcessing = false
```

Note: any message currently mid-capture when Stop is clicked will complete and be saved.
Messages still in queue are discarded.

### 11.4 Chat Navigation While Recording

```
content.js detects URL change (popstate / hashchange listener on window):
  if (recording && newChatId !== currentGroupId):
    → send AUTO_STOPPED to background
    → background: state = { recording: false, sessionId: null }
    → content.js: observer.disconnect(), clear queue
    → popup (if open): re-renders to "Stopped" state with note "Chat changed"
```

User must manually start a new recording session on the new chat.

### 11.5 Viewer Load Flow

```
User opens viewer.html → clicks "Open Folder"
  → window.showDirectoryPicker({ mode: 'read' })
  → User selects telegram-recorder/ root directory
  → Iterate top-level entries:
      for each subdirectory (groupId folder):
        read all files within:
          manifest-*.json  → parse → sessions map for this group
          *.json (non-manifest) → parse → messages array
          *.png            → index by stem (messageId) for screenshot lookup
  → Merge all groups into unified data store:
      sessions: Map<sessionId, SessionManifest>
      messages: MessageRecord[]
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
  │    (redirects tab to /k/)               │
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

### Group Info Extraction

`popup.js` sends `GET_GROUP_INFO` to the content script via `chrome.tabs.sendMessage`.

Content script responds with `{ groupId, groupName }` extracted from:
- `groupId`: `.bubbles[data-peer-id]` or URL hash fragment
- `groupName`: `.chat-info .peer-title` text content (research required for exact selector)

If no `.bubbles` in DOM (no chat open) → content script responds `{ groupId: null, groupName: null }`.

### Popup → Background → Content Message Flow

```
Popup opens:
  1. popup reads chrome.storage.local → render current state
  2. popup sends GET_GROUP_INFO → content.js → responds with group data
  3. popup updates group info display

Start clicked:
  1. popup → background: START_RECORDING { groupId, groupName }
  2. background updates storage, creates manifest, notifies content.js
  3. popup re-reads storage → re-renders

Stop clicked:
  1. popup → background: STOP_RECORDING
  2. background updates storage, notifies content.js
  3. popup re-reads storage → re-renders
```

---

## 13. Viewer Page — Specification

### 13.1 Layout

```
┌──────────────────────────────────────────────────────────────┐
│  Telegram Recorder — Viewer                                  │
│  [ Open Folder ]  [ Export CSV ]      Search: [           ] │
├──────────────────────────────────────────────────────────────┤
│  [▶ Sessions]  ← accordion, collapsed by default            │
├──────────────────────────────────────────────────────────────┤
│  Table (see columns below)                                   │
│  ...                                                         │
└──────────────────────────────────────────────────────────────┘
```

### 13.2 Table Columns

| Column | Sortable | Details |
|---|---|---|
| Timestamp | Yes — default DESC | Formatted to local time via `toLocaleString()` |
| Session | Yes | ISO timestamp → local time; derived from session manifest |
| Group | Yes | Group name from session manifest |
| Poster Name | Yes + text search | `—` when `null` |
| Poster ID | Yes | `—` when `null` |
| Message Content | No | Truncated at ~120 chars; click to expand full text in-cell |
| Images | No | Count badge (e.g. "2 images"); click to show blob URLs list |
| Links | No | Each `href` rendered as clickable anchor; stacked vertically |
| Screenshot | No | Thumbnail max 80px height; click → lightbox overlay |

Sortable columns: click header once = ASC, again = DESC, third = reset to default.

### 13.3 Session Filter Accordion

```
[▶ Sessions]   ← click to expand/collapse
  ──────────────────────────────────────────
  [ Select All ]  [ Deselect All ]
  ☑ 2024-01-01 08:00:00  (Group A — 24 messages)
  ☑ 2024-01-01 09:00:00  (Group A — 31 messages)
  ☐ 2024-01-02 10:00:00  (Group B — 8 messages)
```

- Each checkbox labelled: `{localTime}  ({groupName} — {n} messages)`
- Unchecking hides matching rows in real-time (no reload)
- Select/Deselect All operates on all visible checkboxes

### 13.4 Screenshot Lightbox

- Click thumbnail → full-size image shown in overlay
- Overlay: semi-transparent dark background, centered image, click outside to close
- Image loaded via `URL.createObjectURL(await fileHandle.getFile())`
- All blob URLs revoked on `window.beforeunload`

### 13.5 CSV Export

Export applies to currently **visible rows** (respects session filter + name search).

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
| `images` | `record.images.join('\|')` | Pipe-separated blob URLs (ephemeral) |
| `screenshot_file` | `record.screenshotFile` | Filename only (no path) |
| `screenshot_path` | `{groupId}/{screenshotFile}` | Relative to telegram-recorder/ root |

**Header note row** (first line after headers):
```
# Screenshots are local files. Resolve paths relative to your telegram-recorder/ folder.
# Blob URLs in 'images' column are ephemeral and expire when the recording tab is closed.
```

**Generation:** client-side `Blob` + `URL.createObjectURL()` + programmatic `<a download="export.csv">` click. No server.

---

## 14. State Management

### `chrome.storage.local` (persists across browser restarts)

| Key | Type | Description |
|---|---|---|
| `recording` | `boolean` | Current recording state |
| `currentSessionId` | `string \| null` | Active session unix-ms timestamp |
| `currentGroupId` | `string \| null` | Active group peer ID |
| `currentGroupName` | `string \| null` | Active group name |

### `chrome.storage.session` (cleared on browser close)

| Key | Type | Description |
|---|---|---|
| `recordedSet` | `string[]` | Message IDs recorded this session (collision guard) |

On service worker wake (MV3 service workers may terminate and restart):
- Rehydrate `recordedSet` from `chrome.storage.session`
- Rehydrate `recording` / `sessionId` from `chrome.storage.local`

### Content Script In-Memory

| Variable | Type | Description |
|---|---|---|
| `baselineSet` | `Set<string>` | `data-mid` values present at START |
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
    "storage"
  ],
  "host_permissions": [
    "https://web.telegram.org/*"
  ]
}
```

| Permission | Required For |
|---|---|
| `tabs` | `chrome.tabs.captureVisibleTab()`, `chrome.tabs.sendMessage()` |
| `activeTab` | Accessing active tab URL in popup |
| `downloads` | `chrome.downloads.download()` for all file saves |
| `storage` | `chrome.storage.local` + `chrome.storage.session` |
| `host_permissions: web.telegram.org` | Content script injection |

---

## 17. Known Limitations & Workarounds

| Limitation | Impact | Workaround / Decision |
|---|---|---|
| Telegram uses encrypted HTTPS (no packet access) | Cannot intercept messages at network level | DOM MutationObserver — sufficient for all data |
| `captureVisibleTab` captures entire tab | Larger data per capture | Canvas crop to `getBoundingClientRect()` with DPR correction |
| Blob image URLs expire with tab session | `images[]` URLs are dead after tab close | Screenshots capture media visually; filename in `screenshotFile`; blob URLs stored for in-session reference |
| CSV image portability | No portable image path in CSV | `screenshot_path` column stores `{groupId}/{filename}` relative path; comment row explains resolution |
| `hide-name` = anonymous sender | No name available | `posterName = null`; `posterId = groupId` (accurate — posted as group entity) |
| Emoji rendered as `<img>` | Mixed with text content | Clone + remove `img.emoji` before `textContent` read |
| Multiple messages arrive rapidly | Screenshot serialization lag | FIFO queue; data captured immediately at enqueue time, screenshot taken when slot free |
| MV3 service worker may terminate | In-flight state lost | `chrome.storage.session` for `recordedSet`; rehydrate on wake |
| Chat navigation while recording | Observer on wrong DOM | Auto-stop on URL change; user must restart on new chat |
| Edited messages reuse `data-mid` | Re-record would overwrite | Treated as collision — original preserved, edit not re-recorded |

---

## 18. Research Items Resolved

| Item | Status | Finding |
|---|---|---|
| `.bubbles-group-avatar[data-peer-id]` — sender or group? | **Resolved** | Always carries sender's effective peer ID. Positive = real user. Negative = anonymous/group post. |
| `hide-name` meaning | **Resolved** | Anonymous admin / channel posting as group entity — not consecutive messages. Real users always show `.peer-title`. |
| Sender name element structure | **Resolved** | `div.colored-name > span.peer-title[data-peer-id]`. Both carry sender peer ID. |
| `data-peer-id` on `.bubble` | **Resolved** | Always the group/chat peer ID. Not the sender. |
| Multiple bubbles per sender in one group | **Resolved** | Both bubbles confirmed to have `.peer-title` (non-anonymous). Observer handles Scenario A and B. |

### Remaining Research (Phase 1 — live DOM validation)

| # | Task | Goal |
|---|---|---|
| 1 | Group name selector | Confirm exact selector for chat name (`.chat-info .peer-title` or `<title>`) |
| 2 | `data-mid` uniqueness across sessions | Confirm IDs don't repeat across different recording sessions for same group |
| 3 | `subtree: true` observer performance | Verify no performance degradation in high-volume chats |
| 4 | System message `data-mid` absence | Confirm service messages reliably lack `data-mid` |
| 5 | Scroll + capture timing | Validate 150ms wait is sufficient; test on slow connections and media-heavy messages |
| 6 | Chat navigation event | Confirm `hashchange` or `popstate` fires when switching chats in Web K |

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
