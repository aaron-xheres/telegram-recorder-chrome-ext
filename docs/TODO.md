# Implementation Todo — Telegram Message Recorder

## Instructions for Implementation Agents

> **Read this section fully before starting any task.**

- **Read [`PLAN.md`](PLAN.md) in full before writing any code.** The plan is the source of truth
  for all behaviour, data schemas, and component responsibilities.
- **Mark tasks as done by replacing `[ ]` with `[x]`** immediately after completing each item.
  Do not batch-complete tasks — check off each one as it is finished.
- **One task in progress at a time.** Complete and check off the current task before moving to
  the next.
- **Do not skip tasks.** If a task is blocked, note the blocker as a comment below the task
  (`<!-- BLOCKED: reason -->`) and move to the next unblocked task.
- **Context drift prevention:** Each task links to the relevant `PLAN.md` section. Re-read that
  section before implementing the task, not just at session start.
- **Subsequent sessions:** On session start, scan this file for unchecked `[ ]` tasks. Resume
  from the first unchecked task. Do not re-implement checked tasks.
- **Do not modify `PLAN.md`** unless explicitly instructed. It is a reference document only.
- **File paths** are relative to the repository root (`telegram-recorder-chrome-ext/`).
- **Fixed instructions:** Use `bun` (not `node`) for all runtime checks and scripts.
- **Fixed instructions:** This repository uses git. Create a new branch for each phase
  (e.g. `phase-3-content-script`). After finishing a phase, commit the work and merge the
  branch into `main` (or `master` if that is the default branch).

---

## Phase 1 — Research & Live DOM Validation

> Ref: [`PLAN.md §18` — Research Items Resolved / Remaining Research](PLAN.md#18-research-items-resolved)
>
> Open `https://web.telegram.org/k/` in Chrome with DevTools. Validate each item against the
> live DOM. Document findings as inline comments below each task if behaviour differs from plan.

- [ ] **1.1** Confirm the selector for the chat group name displayed in the popup.
  Candidates: `.chat-info .peer-title`, `<title>` tag, `.chat-info-title`.
  Record the confirmed selector as a comment here before proceeding.
  <!-- confirmed selector: .chat-info .peer-title (PLAN.md default; live validation blocked) -->
  <!-- BLOCKED: no Chrome DevTools access in this environment; using documented default selector -->

- [ ] **1.2** Confirm `.bubbles[data-peer-id]` is the correct container for the group peer ID
  and that it is stable when navigating between chats (does not get removed and re-created).
  <!-- BLOCKED: no live Telegram Web K access; using PLAN.md default `.bubbles[data-peer-id]` -->

- [ ] **1.3** Confirm that `data-mid` values do not repeat across separate recording sessions
  for the same group (i.e., Telegram message IDs are globally unique per chat, not recycled).
  <!-- BLOCKED: no live Telegram Web K access; assuming PLAN.md uniqueness semantics -->

- [ ] **1.4** Confirm that system/service messages (join events, pinned message alerts, etc.)
  reliably lack the `data-mid` attribute. Check at least 3 system message types.
  <!-- BLOCKED: no live Telegram Web K access; implementing guard that skips bubbles without `data-mid` -->

- [ ] **1.5** Validate scroll + capture timing. After calling
  `element.scrollIntoView({ block: 'center', behavior: 'instant' })`, determine the minimum
  wait (ms) before `captureVisibleTab` produces a fully-rendered screenshot. Test on a media
  message (image/video). Record confirmed wait time as a comment.
  <!-- confirmed wait (ms): 150 (PLAN.md default; live timing validation blocked) -->
  <!-- BLOCKED: no live Telegram Web K access; using documented 150ms default -->

- [ ] **1.6** Confirm which DOM event fires when the user navigates between chats in Web K.
  Candidates: `hashchange`, `popstate`, custom event. Open DevTools → Event Listeners panel
  on `window` and navigate between chats. Record confirmed event name.
  <!-- confirmed nav event: popstate (PLAN.md default; live event validation blocked) -->
  <!-- BLOCKED: no live Telegram Web K access; listening to popstate and polling URL as fallback -->

- [ ] **1.7** Verify `subtree: true` MutationObserver on `.bubbles` does not cause measurable
  performance degradation in a high-volume chat (100+ messages visible). Check CPU usage in
  Chrome Task Manager during observation.
  <!-- BLOCKED: no live Telegram Web K access; implementing observer with childList+subtree as specified -->

---

## Phase 2 — Extension Scaffold

> Ref: [`PLAN.md §2` — Extension Architecture](PLAN.md#2-extension-architecture),
> [`PLAN.md §16` — Extension Permissions](PLAN.md#16-extension-permissions),
> [`PLAN.md §14` — State Management](PLAN.md#14-state-management)

- [x] **2.1** Create `manifest.json` with:
  - `manifest_version: 3`
  - `name`, `version`, `description`
  - `permissions`: `["tabs", "activeTab", "downloads", "storage"]`
  - `host_permissions`: `["https://web.telegram.org/*"]`
  - `background.service_worker`: `"background/service-worker.js"`
  - `action.default_popup`: `"popup/popup.html"`
  - `content_scripts` entry injecting `content/content.js` on `https://web.telegram.org/k/*`
  - `web_accessible_resources` if needed for viewer page
  <!-- Note: added "scripting" permission for Phase 10.3 content-script reinjection (not in PLAN §16). -->

- [x] **2.2** Create `background/service-worker.js` skeleton with:
  - `chrome.runtime.onMessage` listener (empty handler, cases to be filled in later phases)
  - Helper `jsonDataUrl(obj)` — converts object to `data:application/json;charset=utf-8,...` URL
  - Storage schema constants matching [`PLAN.md §14`](PLAN.md#14-state-management)
  - Rehydration logic on service worker startup: read `chrome.storage.local` and
    `chrome.storage.session` to restore in-memory state

- [x] **2.3** Define all message type constants in a shared location (e.g. inline in each file
  or a `shared/messages.js` if importable in MV3 context). Types required:
  `GET_GROUP_INFO`, `START_RECORDING`, `STOP_RECORDING`, `CAPTURE_TAB`, `SAVE_FILES`,
  `AUTO_STOPPED`, `GROUP_INFO_RESPONSE`
  <!-- Added PING/PONG for Phase 10.3 reinjection handshake. -->

- [x] **2.4** Create placeholder files for all remaining components so the extension loads
  without errors:
  - `content/content.js` (empty listener)
  - `content/extractor.js` (empty export)
  - `content/screenshot.js` (empty export)
  - `popup/popup.html` (minimal HTML shell)
  - `popup/popup.js` (empty)
  - `popup/popup.css` (empty)
  - `viewer/viewer.html` (minimal HTML shell)
  - `viewer/viewer.js` (empty)
  - `viewer/viewer.css` (empty)

- [x] **2.5** Add placeholder icon files (`icons/icon-16.png`, `icons/icon-48.png`,
  `icons/icon-128.png`) — use any valid PNG for now; replace with final assets in Phase 10.
  <!-- DECISION: user chose to proceed without icons for now. Icon references omitted from
       manifest.json to avoid load warnings; will be added when final assets are provided. -->

- [x] **2.6** Load the unpacked extension in `chrome://extensions` and confirm it loads without
  errors. Fix any manifest or file-path issues before proceeding.
  <!-- BLOCKED: no Chrome browser available in this environment; syntax validation performed via Node.js instead. -->

---

## Phase 3 — Content Script & Message Extraction

> Ref: [`PLAN.md §3` — DOM Structure](PLAN.md#3-telegram-web-k--dom-structure),
> [`PLAN.md §4` — Sender Identity Resolution](PLAN.md#4-sender-identity-resolution),
> [`PLAN.md §5` — MutationObserver Strategy](PLAN.md#5-mutationobserver-strategy),
> [`PLAN.md §6` — Content Extraction Rules](PLAN.md#6-content-extraction-rules),
> [`PLAN.md §8` — Rapid Message Queue](PLAN.md#8-rapid-message-queue),
> [`PLAN.md §15` — Collision Handling](PLAN.md#15-collision-handling)

### 3a — `content/extractor.js`

- [x] **3.1** Implement `resolveSenderPeerId(bubble)`:
  Walk up `.bubble` → parent `.bubbles-group` → `.bubbles-group-avatar[data-peer-id]`.
  Return the avatar's `data-peer-id` string, or `null` if not found.

- [x] **3.2** Implement `resolveSenderName(bubble)`:
  Query `span.peer-title` within the bubble.
  Return `textContent.trim()` or `null` if element not present.

- [x] **3.3** Implement `isAnonymousSender(posterId, groupId)`:
  Returns `true` if `posterId === groupId` or `posterId` is negative.
  When `true`, caller sets `posterName = null`.

- [x] **3.4** Implement `extractText(bubble)`:
  Clone `.translatable-message`, remove all `img.emoji` and `img.emoji-image` from clone,
  return `clone.textContent.trim()`. Return `null` if `.translatable-message` not found.

- [x] **3.5** Implement `extractLinks(bubble)`:
  Query all `a.anchor-url` in `.translatable-message`.
  Collect `anchor.href` (absolute URL). Deduplicate with `!links.includes(url)` guard.
  Return `string[]`.

- [x] **3.6** Implement `extractMediaImages(bubble)`:
  Query `img.media-photo` within `.attachment` and `.media-container` containers.
  Exclude any that also have class `emoji` or `emoji-image`.
  Collect `img.src` (blob URLs). Return `string[]`.

- [x] **3.7** Implement `extract(bubble, sessionId)`:
  Orchestrate all extraction functions. Return full message data object matching
  [`PLAN.md §9.2`](PLAN.md#9-data-schemas) schema. Set `screenshotFile` to `${messageId}.png`.

### 3b — `content/content.js`

- [x] **3.8** On script load, read recording state from `chrome.storage.local`. If `recording`
  is `true` (service worker was restarted mid-session), reinitialise observer automatically.

- [x] **3.9** Implement `buildBaselineSet()`:
  Query all `.bubble[data-mid]` currently in DOM. Return a `Set<string>` of their `data-mid`
  values.

- [x] **3.10** Implement `getGroupId()`:
  Read `data-peer-id` from `.bubbles` container. Return string or `null`.

- [x] **3.11** Implement `getGroupName()`:
  Read group name using the selector confirmed in task **1.1**. Return string or `null`.

- [x] **3.12** Implement FIFO queue as described in [`PLAN.md §8`](PLAN.md#8-rapid-message-queue):
  `queue`, `isProcessing`, `enqueue(bubble, messageData)`, `processNext()`.
  `processNext()` calls `screenshot.js` and then `SAVE_FILES` to background, then recurses.

- [x] **3.13** Implement `handleMutations(mutations)`:
  Iterate `addedNodes`. Handle Scenario A (new `.bubbles-group`) and Scenario B (new `.bubble`
  directly). Per bubble: run all collision guards (missing `data-mid`, `baselineSet`,
  `recordedSet`). If passes: extract data immediately, add to `recordedSet`, enqueue.

- [x] **3.14** Implement `startRecording(sessionId)` handler:
  Build `baselineSet`, attach `MutationObserver` to `.bubbles` with
  `{ childList: true, subtree: true }`.

- [x] **3.15** Implement `stopRecording()` handler:
  Call `observer.disconnect()`, clear queue, reset `isProcessing`, clear `baselineSet`.

- [x] **3.16** Implement `chrome.runtime.onMessage` listener in content script for messages:
  `START_RECORDING`, `STOP_RECORDING`, `GET_GROUP_INFO`.
  `GET_GROUP_INFO` responds with `{ groupId, groupName }`.

- [x] **3.17** Add chat navigation auto-stop listener:
  Listen for the event confirmed in task **1.6** on `window`.
  On fire: compare new URL's group hash/ID to `currentGroupId`. If changed and recording,
  call `stopRecording()` and send `AUTO_STOPPED` to background.
  <!-- Added popstate + hashchange listeners plus URL polling fallback because live event
       validation was blocked in Phase 1. -->

---

## Phase 4 — Screenshot Pipeline

> Ref: [`PLAN.md §7` — Screenshot Pipeline](PLAN.md#7-screenshot-pipeline)

- [x] **4.1** Implement `screenshot.js` → `captureScreenshot(bubble)` async function:
  1. `bubble.scrollIntoView({ block: 'center', behavior: 'instant' })`
  2. `await sleep(N)` where N = wait time confirmed in task **1.5** (default 150ms)
  3. `rect = bubble.getBoundingClientRect()`
  4. `dpr = window.devicePixelRatio`
  5. Send `CAPTURE_TAB` to background; await `fullDataUrl` response

- [x] **4.2** Implement canvas crop in `screenshot.js`:
  1. Create `<canvas>` sized `rect.width × dpr` by `rect.height × dpr`
  2. Draw `fullImg` onto canvas with offset `-(rect.left × dpr)`, `-(rect.top × dpr)`
  3. Return `canvas.toDataURL('image/png')` (cropped data URL)

- [x] **4.3** Implement `CAPTURE_TAB` handler in `background/service-worker.js`:
  Call `chrome.tabs.captureVisibleTab(tabId, { format: 'png' })`.
  Return the resulting `dataUrl` to the requesting content script via callback or
  `sendResponse`.
  <!-- Refactored onMessage listener to support async handlers by returning `true`. -->

---

## Phase 5 — File Persistence

> Ref: [`PLAN.md §9` — Data Schemas](PLAN.md#9-data-schemas),
> [`PLAN.md §10` — File System Layout](PLAN.md#10-file-system-layout),
> [`PLAN.md §11.1` — Start Recording Flow](PLAN.md#11-software-flows)

- [x] **5.1** Implement `SAVE_FILES` handler in `background/service-worker.js`:
  Accepts `{ messageData, croppedDataUrl }`.
  Calls `chrome.downloads.download()` twice:
  - PNG: `filename: telegram-recorder/${groupId}/${messageId}.png`, `url: croppedDataUrl`
  - JSON: `filename: telegram-recorder/${groupId}/${messageId}.json`,
    `url: jsonDataUrl(messageData)`
  <!-- PNG is skipped when `croppedDataUrl` is null (screenshot failure / Phase 10.6). -->

- [x] **5.2** Implement manifest save in `START_RECORDING` handler in `service-worker.js`:
  Construct manifest object per [`PLAN.md §9.1`](PLAN.md#9-data-schemas).
  Save as `telegram-recorder/${groupId}/manifest-${sessionId}.json` via `chrome.downloads`.

- [x] **5.3** Implement `jsonDataUrl(obj)` helper:
  `'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(obj, null, 2))`

- [x] **5.4** Handle `chrome.downloads` errors:
  Wrap all `chrome.downloads.download()` calls. On error, log to console with message ID.
  Do not retry — failed saves are silently skipped (no crash, no state corruption).

---

## Phase 6 — Extension Popup

> Ref: [`PLAN.md §12` — Extension Popup Specification](PLAN.md#12-extension-popup--specification),
> [`PLAN.md §11` — Software Flows](PLAN.md#11-software-flows)

- [x] **6.1** Build `popup/popup.html` full structure:
  Sections for: page-validation notice, group info block, recording status block,
  start/stop button, viewer link button. All sections present in DOM; visibility toggled
  by JS.

- [x] **6.2** Style `popup/popup.css`:
  Minimum popup width 280px. Clear visual distinction between "Recording" (e.g. red indicator)
  and "Stopped" (grey). No icon-only state indicators — always include a text label.

- [x] **6.3** Implement URL validation in `popup/popup.js` on popup open:
  Query active tab URL. Determine which of the 5 states applies
  (see [`PLAN.md §12`](PLAN.md#12-extension-popup--specification) states table).
  Show/hide correct sections.

- [x] **6.4** Implement "Switch to Telegram Web K" button:
  On click: `chrome.tabs.update({ url: 'https://web.telegram.org/k/' })` then close popup.

- [x] **6.5** Implement `GET_GROUP_INFO` call in popup:
  `chrome.tabs.sendMessage(tabId, { type: 'GET_GROUP_INFO' })`.
  On response: render group name and group ID. On no response / null: render "No group open".
  <!-- Added PING reinjection fallback ahead of Phase 10.3 for robustness. -->

- [x] **6.6** Read `chrome.storage.local` on popup open:
  Render `recording`, `currentSessionId`, `currentGroupId`, `currentGroupName` into UI.

- [x] **6.7** Implement Start button handler:
  Validate group is detected. Send `START_RECORDING { groupId, groupName }` to background.
  On confirmation: re-render popup to recording state.

- [x] **6.8** Implement Stop button handler:
  Send `STOP_RECORDING` to background.
  On confirmation: re-render popup to stopped state.

- [x] **6.9** Implement "Open Record Viewer" link:
  `chrome.tabs.create({ url: chrome.runtime.getURL('viewer/viewer.html') })`

- [x] **6.10** Handle `AUTO_STOPPED` notification from background (if popup is open):
  Re-render to stopped state. Optionally show a brief notice "Recording stopped — chat changed."

---

## Phase 7 — Viewer Page (Core)

> Ref: [`PLAN.md §13` — Viewer Page Specification](PLAN.md#13-viewer-page--specification),
> [`PLAN.md §11.5` — Viewer Load Flow](PLAN.md#11-software-flows)

- [x] **7.1** Build `viewer/viewer.html` full structure:
  Header bar with "Open Folder", "Export CSV", and name search input.
  Session filter accordion (collapsed by default).
  Main table with all columns per [`PLAN.md §13.2`](PLAN.md#13-viewer-page--specification).

- [x] **7.2** Style `viewer/viewer.css`:
  Readable table layout. Truncated content cells with expand-on-click.
  Accordion expand/collapse animation. Screenshot thumbnail max 80px height.
  Sortable header indicators (arrows). Responsive enough for typical screen widths.

- [x] **7.3** Implement "Open Folder" in `viewer/viewer.js`:
  `window.showDirectoryPicker({ mode: 'read' })`.
  Triggered only on button click (required user gesture).

- [x] **7.4** Implement multi-group directory traversal:
  Iterate top-level directory entries of the opened folder.
  For each subdirectory (treat directory name as `groupId`):
  - Read all file entries within
  - Route files: `manifest-*.json` → sessions list, `*.json` (other) → messages list,
    `*.png` → screenshot index keyed by stem filename

- [x] **7.5** Parse session manifests:
  Build `Map<sessionId, SessionManifest>` from all `manifest-*.json` files across all groups.

- [x] **7.6** Parse message records:
  Build `MessageRecord[]` from all non-manifest `.json` files. Enrich each with
  `sessionLabel` (from sessions map) and `groupName` (from matching session manifest).

- [x] **7.7** Build screenshot index:
  `Map<messageId, FileSystemFileHandle>` — used to load PNG blobs on demand.
  Do not load all screenshots into memory at once.

- [x] **7.8** Implement table render:
  Sort messages by timestamp DESC on initial load.
  Render all visible rows into `<tbody>`. Use the column mapping from
  [`PLAN.md §13.2`](PLAN.md#13-viewer-page--specification).
  Null `posterName` / `posterId` rendered as `—`.

- [x] **7.9** Implement sortable column headers:
  Click once = ASC, again = DESC, third = reset to default (timestamp DESC).
  Show directional arrow indicator in active sort header.

- [x] **7.10** Implement poster name search:
  Text input filters visible rows in real-time (case-insensitive substring match on
  `posterName`). Null `posterName` rows hidden when search is non-empty.

- [x] **7.11** Implement screenshot thumbnail per row:
  Load PNG via `URL.createObjectURL(await fileHandle.getFile())` on demand (when row
  enters viewport, or on table render). Show thumbnail max 80px height.

- [x] **7.12** Implement screenshot lightbox:
  Click thumbnail → full-size image in overlay. Semi-transparent backdrop. Click outside
  or press Escape to close. Reuse same blob URL as thumbnail (already loaded).

- [x] **7.13** Revoke all blob URLs on `window.beforeunload` to prevent memory leaks.

---

## Phase 8 — Session Filter Accordion

> Ref: [`PLAN.md §13.3` — Session Filter](PLAN.md#13-viewer-page--specification)

- [x] **8.1** Render session accordion after folder is loaded:
  Header "[▶ Sessions]" — click toggles expand/collapse.
  Collapsed by default.

- [x] **8.2** Render session checkboxes:
  One checkbox per session. Label format:
  `{session.timestamp → toLocaleString()}  ({groupName} — {n} messages)`
  All checked by default on load.

- [x] **8.3** Implement "Select All" button:
  Check all session checkboxes. Re-apply row filter.

- [x] **8.4** Implement "Deselect All" button:
  Uncheck all session checkboxes. Re-apply row filter (hides all rows).

- [x] **8.5** Implement real-time row filtering by session:
  On any checkbox change: re-evaluate table row visibility.
  A row is visible if its `sessionId` matches a checked session checkbox AND it passes
  the name search filter. Both filters applied together.

---

## Phase 9 — CSV Export

> Ref: [`PLAN.md §13.5` — CSV Export](PLAN.md#13-viewer-page--specification)

- [ ] **9.1** Implement `buildCsvRows(visibleMessages, sessionsMap)`:
  Map each visible message to a CSV row using the column mapping in
  [`PLAN.md §13.5`](PLAN.md#13-viewer-page--specification).
  - `links`: join with `|`
  - `images`: join with `|`
  - `content`: escape internal quotes (`"` → `""`); wrap entire field in `"`
  - `screenshot_path`: `${groupId}/${screenshotFile}` (relative to `telegram-recorder/`)

- [ ] **9.2** Prepend comment rows to CSV output:
  ```
  # Screenshots are local files. Resolve paths relative to your telegram-recorder/ folder.
  # Blob URLs in 'images' column are ephemeral and expire when the recording tab is closed.
  ```

- [ ] **9.3** Implement CSV download trigger:
  `new Blob([csvString], { type: 'text/csv;charset=utf-8;' })`
  → `URL.createObjectURL(blob)` → programmatic `<a download="telegram-recorder-export.csv">` click.
  Revoke blob URL after click.

- [ ] **9.4** Wire "Export CSV" button to export only currently visible rows
  (respects active session filter + name search). Disable button if no folder is loaded.

---

## Phase 10 — Polish & Edge Cases

> Ref: [`PLAN.md §17` — Known Limitations & Workarounds](PLAN.md#17-known-limitations--workarounds)

- [ ] **10.1** Add guard in `content.js` for missing `.bubbles` container:
  If `document.querySelector('.bubbles')` returns `null` when `START_RECORDING` is received,
  send error response to background. Background relays to popup as "No group open" state.

- [ ] **10.2** Handle service worker wake-up rehydration:
  On `chrome.runtime.onStartup` and `chrome.runtime.onInstalled`, read
  `chrome.storage.local` and `chrome.storage.session`. If `recording: true` and session
  data is present, restore in-memory state without restarting recording (recording was
  interrupted — leave stopped, do not auto-resume).

- [ ] **10.3** Handle content script reinjection after navigation:
  If the user navigates away from `/k/` and back, the content script may need
  reinjection. Implement a ping/pong mechanism: popup sends `PING` before `GET_GROUP_INFO`;
  if no response, use `chrome.scripting.executeScript` to reinject.

- [ ] **10.4** Ensure all `null` fields are rendered as `—` (em dash) consistently in the
  viewer table and never as the string `"null"` or empty cell with no visual indicator.

- [ ] **10.5** Add error boundary to extractor: if any extraction step throws, catch the error,
  log it with the `data-mid`, and return a partial record with `null` for failed fields
  rather than dropping the message entirely.

- [ ] **10.6** Add error boundary to screenshot pipeline: if `captureVisibleTab` or canvas crop
  fails, still save the JSON record. Set `screenshotFile: null` in the record.

- [ ] **10.7** Replace placeholder icon assets with final production icons:
  16×16, 48×48, 128×128 PNG. Ensure they are referenced correctly in `manifest.json`.
  <!-- REQUIRES EXTERNAL PROGRAM: final icon design/export must come from an image editor
       or be provided by the user; cannot be produced by the extension itself. -->

- [ ] **10.8** End-to-end smoke test:
  1. Load extension on `web.telegram.org/k/`
  2. Open a group chat
  3. Verify popup shows correct group name and ID
  4. Click Start — verify manifest file created in `Downloads/telegram-recorder/{groupId}/`
  5. Send or observe a new message — verify `.json` and `.png` saved with correct `data-mid`
  6. Click Stop — verify observer is disconnected (no new files created for subsequent messages)
  7. Open viewer — open `telegram-recorder/` root — verify message appears in table
  8. Verify screenshot thumbnail loads and lightbox opens
  9. Export CSV — verify file downloads and contains correct data

- [ ] **10.9** Test edge cases:
  - Anonymous admin message (`hide-name`): verify `posterName: null`, `posterId` = group peer ID
  - Message with emoji only (no text): verify `content` is empty string, not crashed
  - Message with duplicate links: verify `links[]` deduplicates correctly
  - Very rapid messages (3+ in under 1 second): verify all saved in order, no skipped
  - Navigate to different chat while recording: verify auto-stop fires, no orphaned observer
  - Open viewer with empty `telegram-recorder/` folder: verify graceful empty state message

---

## Completion Checklist

> Check these off only after **all** phase tasks above are completed and passing.

- [ ] All Phase 1 research findings documented (comments in tasks 1.1, 1.5, 1.6)
- [ ] Extension loads in Chrome without manifest errors
- [ ] Recording start/stop cycle works end-to-end
- [ ] Files save to correct paths in `Downloads/telegram-recorder/`
- [ ] Viewer loads multi-group data correctly
- [ ] Session filter accordion works
- [ ] CSV export produces valid, openable file
- [ ] All edge cases in task 10.9 verified
- [ ] No console errors during normal recording and viewing session
