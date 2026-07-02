# Telegram Message Recorder

A Chrome extension that records messages from **Telegram Web K** (`web.telegram.org/k/`) directly to your local `Downloads` folder. No server, no cloud — all data stays on your machine.

## Features

- Records new messages in a Telegram group chat while you have it open.
- Captures a screenshot of each message bubble.
- Saves structured JSON metadata plus PNG screenshots.
- Supports anonymous admin posts (`posterName: null`, `posterId` equals group ID).
- Built-in viewer page to browse, filter, sort, and export recordings.
- CSV export with save-file dialog and group-specific default filename.

## Installation

### Google Chrome

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked**.
4. Select the `telegram-recorder-chrome-ext` directory.
5. The extension icon should appear in your toolbar.

### Microsoft Edge

1. Open Edge and navigate to `edge://extensions/`.
2. Enable **Developer mode** (toggle in the bottom-left).
3. Click **Load unpacked**.
4. Select the `telegram-recorder-chrome-ext` directory.
5. The extension icon should appear in your toolbar.

## Usage

### Recording

1. Open [Telegram Web K](https://web.telegram.org/k/) in Chrome.
2. Open the group chat you want to record.
3. Click the extension icon and press **▶ Start Recording**.
4. A session manifest and future messages will be saved to:
   ```
   ~/Downloads/telegram-recorder/{group-id}/
   ```
5. Click **■ Stop Recording** when finished.

> **Note:** Recording automatically stops if you navigate to a different chat.

### Viewer

1. Click **Open Record Viewer ↗** in the popup, or open `viewer/viewer.html` from the extension.
2. Click **Open Folder** and select a single group folder (e.g. `~/Downloads/telegram-recorder/-5491281397`).
3. Browse messages, filter by session or poster name, view screenshots, and export CSV.

#### Admin post filter

Type `admin`, `—` (em dash), or `-` (hyphen) in the **Poster name** filter to show only anonymous admin posts.

## File layout

```
Downloads/
└── telegram-recorder/
    └── {group-id}/
        ├── manifest-{timestamp}.json
        ├── {message-id}.json
        └── {message-id}.png
```

## Permissions

- `tabs` / `activeTab` — detect the active Telegram tab and capture screenshots.
- `downloads` — save JSON and PNG files locally.
- `storage` — persist recording state across service-worker restarts.
- `scripting` — reinject the content script if needed.
- `host_permissions: https://web.telegram.org/*` — inject the content script into Telegram Web K.

## Development

### Project structure

```
telegram-recorder-chrome-ext/
├── manifest.json
├── background/
│   └── service-worker.js
├── content/
│   ├── content.js
│   ├── extractor.js
│   └── screenshot.js
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── viewer/
│   ├── viewer.html
│   ├── viewer.js
│   └── viewer.css
├── shared/
│   └── messages.js
└── icons/
```

### Build / validation

No build step is required. To check syntax:

```bash
bun build shared/messages.js content/*.js background/*.js popup/*.js viewer/*.js --outdir /tmp/bun-build-check
```

## Known limitations

- Targets **Telegram Web K** only. Web A / Web Z will be detected and you can be redirected to Web K.
- Screenshots require the Telegram tab to be visible (active).
- Inline media blob URLs stored in JSON are ephemeral and expire when the tab is closed; the PNG screenshot remains.
- Icon assets are not included by default — add `icons/icon-16.png`, `icons/icon-48.png`, and `icons/icon-128.png` then update `manifest.json` if desired.

## License

MIT
