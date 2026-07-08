// Record viewer logic for Telegram Recorder.
// Uses the File System Access API to load local telegram-recorder data.

// DOM references.
const els = {
  openFolder: document.getElementById('open-folder'),
  exportCsv: document.getElementById('export-csv'),
  posterNameInput: document.getElementById('poster-name-input'),
  addPosterName: document.getElementById('add-poster-name'),
  posterNameFilters: document.getElementById('poster-name-filters'),
  posterNameMatchCase: document.getElementById('poster-name-match-case'),
  posterNameMatchWord: document.getElementById('poster-name-match-word'),
  posterIdInput: document.getElementById('poster-id-input'),
  addPosterId: document.getElementById('add-poster-id'),
  posterIdFilters: document.getElementById('poster-id-filters'),
  contentInput: document.getElementById('content-input'),
  addContent: document.getElementById('add-content'),
  contentFilters: document.getElementById('content-filters'),
  contentMatchCase: document.getElementById('content-match-case'),
  contentMatchWord: document.getElementById('content-match-word'),
  requireScreenshot: document.getElementById('require-screenshot'),
  requireLink: document.getElementById('require-link'),
  groupInfo: document.getElementById('group-info'),
  groupList: document.getElementById('group-list'),
  sessionsSection: document.getElementById('sessions-section'),
  sessionsToggle: document.getElementById('sessions-toggle'),
  sessionsPanel: document.getElementById('sessions-panel'),
  sessionsTable: document.getElementById('sessions-table'),
  sessionsTableBody: document.getElementById('sessions-table-body'),
  selectAllSessions: document.getElementById('select-all-sessions'),
  deselectAllSessions: document.getElementById('deselect-all-sessions'),
  filtersSection: document.getElementById('filters-section'),
  emptyState: document.getElementById('empty-state'),
  tableContainer: document.getElementById('table-container'),
  recordsBody: document.getElementById('records-body'),
  lightbox: document.getElementById('lightbox'),
  lightboxImg: document.getElementById('lightbox-img'),
  mediaLightbox: document.getElementById('media-lightbox'),
  mediaLightboxImg: document.getElementById('media-lightbox-img'),
  mediaLightboxVideo: document.getElementById('media-lightbox-video')
};

// State.
let directoryHandle = null;
let currentGroupId = '';
/** @type {Map<string, object>} */
let sessions = new Map();
/** @type {object[]} */
let messages = [];
/** @type {Map<string, FileSystemFileHandle>} */
let screenshotHandles = new Map();
/** @type {Map<string, string>} */
let screenshotBlobUrls = new Map();
/** @type {Map<string, FileSystemFileHandle>} */
let mediaHandles = new Map();
/** @type {Map<string, string>} */
let mediaBlobUrls = new Map();
/** @type {Set<string>} */
let selectedSessionIds = new Set();
/**
 * Poster name filters with per-term options.
 * @type {Array<{term: string, matchCase: boolean, matchWord: boolean}>}
 */
let posterNameFilters = [];
let posterNameMatchCase = false;
let posterNameMatchWord = false;

/**
 * Poster ID filters. Poster IDs are matched exactly, so options are always false.
 * @type {Array<{term: string, matchCase: boolean, matchWord: boolean}>}
 */
let posterIdFilters = [];

/**
 * Content filters with per-term options.
 * @type {Array<{term: string, matchCase: boolean, matchWord: boolean}>}
 */
let contentFilters = [];
// Default options applied to the next content term added.
let contentMatchCase = false;
let contentMatchWord = false;
let requireScreenshot = true;
let requireLink = false;
/** @type {{ column: string|null, direction: 'asc'|'desc'|null }} */
let sortState = { column: 'timestamp', direction: 'desc' };

const MISSING_FIELD = '—';

// ---------------------------------------------------------------------------
// Folder loading
// ---------------------------------------------------------------------------

async function openFolder() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    directoryHandle = handle;
    await loadDirectory(handle);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[TelegramRecorder] openFolder failed', err);
    alert('Failed to open folder: ' + (err.message ?? String(err)));
  }
}

/**
 * Traverse the selected directory and load sessions, messages, and screenshots.
 * @param {FileSystemDirectoryHandle} root
 */
async function loadDirectory(root) {
  sessions = new Map();
  messages = [];
  screenshotHandles = new Map();
  screenshotBlobUrls = new Map();
  mediaHandles = new Map();
  mediaBlobUrls = new Map();
  selectedSessionIds = new Set();

  // Viewer expects a single group folder, not the telegram-recorder/ root.
  currentGroupId = root.name;
  await loadGroupDirectory(root, root.name);

  selectedSessionIds = new Set(sessions.keys());

  sortMessages();
  renderGroupInfo();
  renderSessionsAccordion();
  renderFilters();
  renderTable();

  els.emptyState.classList.add('hidden');
  els.tableContainer.classList.remove('hidden');
  els.exportCsv.disabled = messages.length === 0;
}

/**
 * @param {FileSystemDirectoryHandle} groupDir
 * @param {string} groupId
 */
async function loadGroupDirectory(groupDir, groupId) {
  for await (const [name, entry] of groupDir.entries()) {
    if (entry.kind === 'directory' && name === 'media') {
      await loadMediaDirectory(entry);
      continue;
    }

    if (entry.kind !== 'file') continue;

    if (name.startsWith('manifest-') && name.endsWith('.json')) {
      try {
        const file = await entry.getFile();
        const text = await file.text();
        const manifest = JSON.parse(text);
        if (manifest.id) sessions.set(manifest.id, manifest);
      } catch (err) {
        console.error('[TelegramRecorder] failed to parse manifest', name, err);
      }
      continue;
    }

    if (name.endsWith('.json')) {
      try {
        const file = await entry.getFile();
        const text = await file.text();
        const record = JSON.parse(text);
        if (record.messageId) messages.push(record);
      } catch (err) {
        console.error('[TelegramRecorder] failed to parse message record', name, err);
      }
      continue;
    }

    if (name.endsWith('.png')) {
      const stem = name.replace(/\.png$/i, '');
      screenshotHandles.set(stem, entry);
    }
  }
}

/**
 * Load all files from the group's media/ folder.
 * Files are keyed by their full name and by the GUID stem (name without
 * extension) so they can be matched against blob URLs.
 * @param {FileSystemDirectoryHandle} mediaDir
 */
async function loadMediaDirectory(mediaDir) {
  for await (const [name, entry] of mediaDir.entries()) {
    if (entry.kind !== 'file') continue;
    mediaHandles.set(name, entry);
    const stem = name.replace(/\.[^.]+$/, '');
    if (stem && stem !== name) {
      mediaHandles.set(stem, entry);
    }
  }
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

function getSessionLabel(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return MISSING_FIELD;
  try {
    return new Date(session.timestamp).toLocaleString();
  } catch {
    return session.timestamp;
  }
}

function getGroupName(sessionId) {
  return sessions.get(sessionId)?.groupName ?? MISSING_FIELD;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * @param {string} name
 * @returns {boolean}
 */
function isAdminFilterKeyword(name) {
  return name === 'admin' || name === '—' || name === '-';
}

/**
 * Generic string matcher for filter terms with case/word options.
 * @param {string} text
 * @param {{term: string, matchCase: boolean, matchWord: boolean}} filter
 * @returns {boolean}
 */
function matchesTerm(text, filter) {
  let haystack = text;
  let needle = filter.term;
  if (!filter.matchCase) {
    haystack = haystack.toLowerCase();
    needle = needle.toLowerCase();
  }

  if (filter.matchWord) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = filter.matchCase ? '' : 'i';
    const regex = new RegExp(`\\b${escaped}\\b`, flags);
    return regex.test(haystack);
  }

  return haystack.includes(needle);
}

/**
 * @param {object} record
 * @param {{term: string, matchCase: boolean, matchWord: boolean}} filter
 * @returns {boolean}
 */
function matchesPosterNameFilter(record, filter) {
  const normalizedTerm = filter.term.toLowerCase();
  if (isAdminFilterKeyword(normalizedTerm)) {
    return record.posterName == null && record.posterId === record.groupId;
  }
  return matchesTerm(record.posterName ?? '', filter);
}

/**
 * @param {object} record
 * @returns {boolean}
 */
function matchesPosterNameFilters(record) {
  if (posterNameFilters.length === 0) return true;
  return posterNameFilters.some(filter => matchesPosterNameFilter(record, filter));
}

/**
 * @param {object} record
 * @param {{term: string, matchCase: boolean, matchWord: boolean}} filter
 * @returns {boolean}
 */
function matchesPosterIdFilter(record, filter) {
  return String(record.posterId ?? '') === filter.term;
}

/**
 * @param {object} record
 * @returns {boolean}
 */
function matchesPosterIdFilters(record) {
  if (posterIdFilters.length === 0) return true;
  return posterIdFilters.some(filter => matchesPosterIdFilter(record, filter));
}

/**
 * @param {object} record
 * @param {{term: string, matchCase: boolean, matchWord: boolean}} filter
 * @returns {boolean}
 */
function matchesContentFilter(record, filter) {
  return matchesTerm(record.content ?? '', filter);
}

/**
 * @param {object} record
 * @returns {boolean}
 */
function matchesContentFilters(record) {
  if (contentFilters.length === 0) return true;
  return contentFilters.some(filter => matchesContentFilter(record, filter));
}

function hasScreenshot(record) {
  return Boolean(screenshotHandles.has(record.messageId));
}

function hasLink(record) {
  return Array.isArray(record.links) && record.links.length > 0;
}

function getVisibleMessages() {
  return messages.filter(record => {
    if (!selectedSessionIds.has(record.sessionId)) return false;
    if (!matchesPosterNameFilters(record)) return false;
    if (!matchesPosterIdFilters(record)) return false;
    if (!matchesContentFilters(record)) return false;
    if (requireScreenshot && !hasScreenshot(record)) return false;
    if (requireLink && !hasLink(record)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function sortMessages() {
  const { column, direction } = sortState;
  if (!column || !direction) {
    // Default: timestamp descending.
    messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return;
  }

  messages.sort((a, b) => {
    let va, vb;
    switch (column) {
      case 'timestamp':
        va = new Date(a.timestamp);
        vb = new Date(b.timestamp);
        break;
      case 'session':
        va = getSessionLabel(a.sessionId);
        vb = getSessionLabel(b.sessionId);
        break;
      case 'posterName':
        va = a.posterName ?? '';
        vb = b.posterName ?? '';
        break;
      case 'posterId':
        va = a.posterId ?? '';
        vb = b.posterId ?? '';
        break;
      default:
        return 0;
    }

    if (va < vb) return direction === 'asc' ? -1 : 1;
    if (va > vb) return direction === 'asc' ? 1 : -1;
    return 0;
  });
}

function updateSortUI() {
  document.querySelectorAll('#records-table th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    const col = th.dataset.column;
    if (col === sortState.column && sortState.direction) {
      th.classList.add(sortState.direction === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

function cycleSort(column) {
  if (sortState.column === column) {
    if (sortState.direction === 'asc') sortState.direction = 'desc';
    else if (sortState.direction === 'desc') {
      sortState.column = null;
      sortState.direction = null;
    } else {
      sortState.direction = 'asc';
    }
  } else {
    sortState.column = column;
    sortState.direction = 'asc';
  }

  sortMessages();
  updateSortUI();
  renderTable();
}

// ---------------------------------------------------------------------------
// Group info card
// ---------------------------------------------------------------------------

function renderGroupInfo() {
  const groupIds = new Set(messages.map(m => m.groupId));
  if (groupIds.size === 0) {
    els.groupInfo.classList.add('hidden');
    return;
  }

  const list = els.groupList;
  list.innerHTML = '';

  for (const groupId of groupIds) {
    const groupSessions = Array.from(sessions.values()).filter(s => s.groupId === groupId);
    const session = groupSessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    const groupName = session?.groupName ?? MISSING_FIELD;

    const li = document.createElement('li');

    const nameRow = document.createElement('div');
    const nameLabel = document.createElement('span');
    nameLabel.className = 'label';
    nameLabel.textContent = 'Group Name:';
    const nameValue = document.createElement('span');
    nameValue.className = 'group-name';
    nameValue.textContent = groupName;
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameValue);

    const idRow = document.createElement('div');
    const idLabel = document.createElement('span');
    idLabel.className = 'label';
    idLabel.textContent = 'Group ID:';
    const idValue = document.createElement('span');
    idValue.className = 'group-id';
    idValue.textContent = groupId;
    idRow.appendChild(idLabel);
    idRow.appendChild(idValue);

    li.appendChild(nameRow);
    li.appendChild(idRow);
    list.appendChild(li);
  }

  els.groupInfo.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Filters card
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} container
 * @param {{term: string, matchCase: boolean, matchWord: boolean}} filter
 * @param {boolean} hasMatches
 * @param {Function} onRemove
 */
function renderFilterChip(container, filter, hasMatches, onRemove) {
  const chip = document.createElement('span');
  chip.className = 'filter-chip' + (hasMatches ? ' has-matches' : ' no-matches');

  const label = document.createElement('span');
  label.className = 'filter-chip-label';
  label.textContent = filter.term;
  chip.appendChild(label);

  if (filter.matchCase || filter.matchWord) {
    const badges = document.createElement('span');
    badges.className = 'filter-chip-badges';
    if (filter.matchCase) {
      const badge = document.createElement('span');
      badge.className = 'filter-chip-badge';
      badge.title = 'Match case';
      badge.textContent = 'Aa';
      badges.appendChild(badge);
    }
    if (filter.matchWord) {
      const badge = document.createElement('span');
      badge.className = 'filter-chip-badge';
      badge.title = 'Match whole word';
      badge.textContent = 'W';
      badges.appendChild(badge);
    }
    chip.appendChild(badges);
  }

  const remove = document.createElement('button');
  remove.className = 'filter-chip-remove';
  remove.textContent = '×';
  remove.title = 'Remove filter';
  remove.addEventListener('click', onRemove);
  chip.appendChild(remove);

  container.appendChild(chip);
}

function renderFilters() {
  if (messages.length === 0) {
    els.filtersSection.classList.add('hidden');
    return;
  }
  els.filtersSection.classList.remove('hidden');

  // Compute visible rows once so we can indicate which chips have matches.
  const visible = getVisibleMessages();

  els.posterNameFilters.innerHTML = '';
  posterNameFilters.forEach((filter, index) => {
    const hasMatches = visible.some(record => matchesPosterNameFilter(record, filter));
    renderFilterChip(els.posterNameFilters, filter, hasMatches, () => {
      posterNameFilters.splice(index, 1);
      renderFilters();
      renderTable();
    });
  });

  els.posterIdFilters.innerHTML = '';
  posterIdFilters.forEach((filter, index) => {
    const hasMatches = visible.some(record => matchesPosterIdFilter(record, filter));
    renderFilterChip(els.posterIdFilters, filter, hasMatches, () => {
      posterIdFilters.splice(index, 1);
      renderFilters();
      renderTable();
    });
  });

  els.contentFilters.innerHTML = '';
  contentFilters.forEach((filter, index) => {
    const hasMatches = visible.some(record => matchesContentFilter(record, filter));
    renderFilterChip(els.contentFilters, filter, hasMatches, () => {
      contentFilters.splice(index, 1);
      renderFilters();
      renderTable();
    });
  });
}

// ---------------------------------------------------------------------------
// Session accordion (Phase 8 will populate checkboxes)
// ---------------------------------------------------------------------------

function renderSessionsAccordion() {
  const hasSessions = sessions.size > 0;
  els.sessionsSection.classList.toggle('hidden', !hasSessions);
  if (!hasSessions) return;

  const counts = new Map();
  for (const record of messages) {
    counts.set(record.sessionId, (counts.get(record.sessionId) || 0) + 1);
  }

  const tbody = els.sessionsTableBody;
  tbody.innerHTML = '';

  const sortedSessions = Array.from(sessions.values()).sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  for (const session of sortedSessions) {
    const count = counts.get(session.id) || 0;

    const tr = document.createElement('tr');

    const checkboxTd = document.createElement('td');
    checkboxTd.className = 'checkbox-col';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedSessionIds.has(session.id);
    checkbox.dataset.sessionId = session.id;
    checkbox.addEventListener('change', onSessionFilterChange);
    checkboxTd.appendChild(checkbox);
    tr.appendChild(checkboxTd);

    const idTd = document.createElement('td');
    idTd.className = 'session-id-col';
    idTd.textContent = session.id;
    tr.appendChild(idTd);

    const nameTd = document.createElement('td');
    nameTd.textContent = session.groupName ?? MISSING_FIELD;
    tr.appendChild(nameTd);

    const countTd = document.createElement('td');
    countTd.textContent = String(count);
    tr.appendChild(countTd);

    tbody.appendChild(tr);
  }
}

function onSessionFilterChange() {
  selectedSessionIds = new Set();
  els.sessionsTableBody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    if (cb.checked) selectedSessionIds.add(cb.dataset.sessionId);
  });
  renderTable();
}

function setAllSessions(checked) {
  els.sessionsTableBody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = checked;
  });
  onSessionFilterChange();
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function renderTable() {
  const visible = getVisibleMessages();
  const tbody = els.recordsBody;
  tbody.innerHTML = '';

  for (const record of visible) {
    const tr = document.createElement('tr');

    tr.appendChild(createCell(formatTimestamp(record.timestamp)));
    tr.appendChild(createCell(record.sessionId));
    tr.appendChild(createPosterNameCell(record.posterName));
    tr.appendChild(createIdCell(record.posterId));
    tr.appendChild(createContentCell(record.content));
    tr.appendChild(createMediaCell(record.media ?? record.images));
    tr.appendChild(createLinksCell(record.links));
    tr.appendChild(createScreenshotCell(record.messageId));

    tbody.appendChild(tr);
  }
}

function createCell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function createPosterNameCell(name) {
  const td = document.createElement('td');
  td.className = 'poster-name-cell';
  td.textContent = name ?? MISSING_FIELD;
  return td;
}

/**
 * Render a peer ID as a clickable link to the Telegram Web K page.
 * @param {string|null} peerId
 */
function createIdCell(peerId) {
  const td = document.createElement('td');
  td.className = 'poster-id-cell';
  if (!peerId) {
    td.textContent = MISSING_FIELD;
    return td;
  }

  const a = document.createElement('a');
  a.href = `https://web.telegram.org/k/#${peerId}`;
  a.textContent = peerId;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  td.appendChild(a);
  return td;
}

function createContentCell(content) {
  const td = document.createElement('td');
  td.className = 'content-cell';
  const div = document.createElement('div');
  // Content is always shown in full; no click-to-collapse behavior.
  div.className = 'content-text expanded';
  div.textContent = content ?? MISSING_FIELD;
  td.appendChild(div);
  return td;
}

function extractBlobGuid(url) {
  try {
    return new URL(url).pathname.split('/').pop() || '';
  } catch {
    return '';
  }
}

async function openLocalMedia(guid, event) {
  event.preventDefault();
  await openMediaViewer(guid);
}

function createMediaCell(media) {
  const td = document.createElement('td');
  td.className = 'media-cell';
  if (!media || media.length === 0) {
    td.textContent = MISSING_FIELD;
    return td;
  }
  const count = document.createElement('div');
  count.className = 'media-count';
  count.textContent = `${media.length} media item${media.length === 1 ? '' : 's'}`;
  td.appendChild(count);
    for (const url of media) {
    const guid = extractBlobGuid(url);
    const localHandle = guid ? mediaHandles.get(guid) : null;

    if (localHandle) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'media-link-button';
      btn.textContent = `${guid} (local)`;
      btn.title = `Open downloaded media: ${guid}`;
      btn.addEventListener('click', e => openLocalMedia(guid, e));
      td.appendChild(btn);
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      a.title = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      td.appendChild(a);
    }
  }
  return td;
}

function createLinksCell(links) {
  const td = document.createElement('td');
  td.className = 'links-cell';
  if (!links || links.length === 0) {
    td.textContent = MISSING_FIELD;
    return td;
  }
  const count = document.createElement('div');
  count.className = 'link-count';
  count.textContent = `${links.length} link${links.length === 1 ? '' : 's'}`;
  td.appendChild(count);
  for (const url of links) {
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    td.appendChild(a);
  }
  return td;
}

function createScreenshotCell(messageId) {
  const td = document.createElement('td');
  const handle = screenshotHandles.get(messageId);
  if (!handle) {
    td.textContent = MISSING_FIELD;
    return td;
  }

  const img = document.createElement('img');
  img.className = 'screenshot-thumb';
  img.alt = 'Screenshot';
  loadThumbnail(messageId, handle, img);
  img.addEventListener('click', () => openLightbox(messageId));
  td.appendChild(img);
  return td;
}

async function loadThumbnail(messageId, handle, img) {
  try {
    const file = await handle.getFile();
    const url = URL.createObjectURL(file);
    screenshotBlobUrls.set(messageId, url);
    img.src = url;
  } catch (err) {
    console.error('[TelegramRecorder] failed to load screenshot', messageId, err);
  }
}

function formatTimestamp(iso) {
  if (!iso) return MISSING_FIELD;
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------

async function openLightbox(messageId) {
  const url = screenshotBlobUrls.get(messageId);
  if (!url) {
    const handle = screenshotHandles.get(messageId);
    if (!handle) return;
    try {
      const file = await handle.getFile();
      const newUrl = URL.createObjectURL(file);
      screenshotBlobUrls.set(messageId, newUrl);
      els.lightboxImg.src = newUrl;
    } catch (err) {
      console.error('[TelegramRecorder] failed to open lightbox', messageId, err);
      return;
    }
  } else {
    els.lightboxImg.src = url;
  }
  els.lightbox.classList.remove('hidden');
}

function closeLightbox() {
  els.lightbox.classList.add('hidden');
  els.lightboxImg.src = '';
}

let currentMediaObjectUrl = '';

function mimeFromFilename(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    pdf: 'application/pdf'
  };
  return map[ext] || '';
}

async function openMediaViewer(guid) {
  const handle = mediaHandles.get(guid);
  if (!handle) return;
  try {
    const file = await handle.getFile();
    let mime = file.type || mimeFromFilename(handle.name);
    if (!mime) {
      // Last resort: treat unknown files as octet-stream and open externally.
      const objectUrl = URL.createObjectURL(file);
      window.open(objectUrl, '_blank');
      URL.revokeObjectURL(objectUrl);
      return;
    }

    const buffer = await file.arrayBuffer();
    const blob = new Blob([buffer], { type: mime });
    const objectUrl = URL.createObjectURL(blob);
    currentMediaObjectUrl = objectUrl;

    const isImage = mime.startsWith('image/');
    const isVideo = mime.startsWith('video/');

    if (isImage) {
      els.mediaLightboxImg.src = objectUrl;
      els.mediaLightboxImg.classList.remove('hidden');
      els.mediaLightboxVideo.classList.add('hidden');
    } else if (isVideo) {
      els.mediaLightboxVideo.src = objectUrl;
      els.mediaLightboxVideo.classList.remove('hidden');
      els.mediaLightboxImg.classList.add('hidden');
    } else {
      window.open(objectUrl, '_blank');
      URL.revokeObjectURL(objectUrl);
      currentMediaObjectUrl = '';
      return;
    }

    els.mediaLightbox.classList.remove('hidden');
  } catch (err) {
    console.error('[TelegramRecorder] failed to open media viewer', guid, err);
  }
}

function closeMediaViewer() {
  els.mediaLightbox.classList.add('hidden');
  els.mediaLightboxImg.src = '';
  els.mediaLightboxVideo.pause();
  els.mediaLightboxVideo.src = '';
  if (currentMediaObjectUrl) {
    URL.revokeObjectURL(currentMediaObjectUrl);
    currentMediaObjectUrl = '';
  }
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

const CSV_HEADERS = [
  'timestamp',
  'session_id',
  'session_label',
  'group_id',
  'group_name',
  'poster_name',
  'poster_id',
  'content',
  'links',
  'media',
  'screenshot_file',
  'screenshot_path'
];

const CSV_COMMENTS = [
  '# Screenshots are local files. Resolve paths relative to your telegram-recorder/ folder.',
  '# Blob URLs in \'media\' column are ephemeral and expire when the recording tab is closed.'
];

/**
 * Escape a CSV field by doubling internal quotes and wrapping in quotes.
 * @param {string} value
 * @returns {string}
 */
function escapeCsvField(value) {
  const text = value == null ? '' : String(value);
  return '"' + text.replace(/"/g, '""').replace(/\n/g, '\\n') + '"';
}

/**
 * Build CSV rows for the currently visible messages.
 * @param {object[]} visibleMessages
 * @returns {string[]}
 */
function buildCsvRows(visibleMessages) {
  const rows = [];
  rows.push(CSV_HEADERS.join(','));
  rows.push(...CSV_COMMENTS);

  for (const record of visibleMessages) {
    const session = sessions.get(record.sessionId);
    const screenshotFile = record.screenshotFile ?? '';
    const screenshotPath = screenshotFile ? `${record.groupId}/${screenshotFile}` : '';

    const row = [
      record.timestamp,
      record.sessionId,
      session ? new Date(session.timestamp).toLocaleString() : '',
      record.groupId,
      session?.groupName ?? '',
      record.posterName ?? '',
      record.posterId ?? '',
      record.content ?? '',
      (record.links ?? []).join('|'),
      ((record.media ?? record.images) ?? []).join('|'),
      screenshotFile,
      screenshotPath
    ];

    rows.push(row.map(escapeCsvField).join(','));
  }

  return rows;
}

async function exportCsv() {
  const visible = getVisibleMessages();
  if (visible.length === 0) {
    alert('No visible rows to export.');
    return;
  }

  const csvString = buildCsvRows(visible).join('\n') + '\n';
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });

  const groupId = currentGroupId || messages[0]?.groupId || 'unknown';
  const suggestedName = `telegram-recorder-${groupId}.csv`;

  try {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{
        description: 'CSV files',
        accept: { 'text/csv': ['.csv'] }
      }]
    });

    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[TelegramRecorder] save CSV failed', err);
    alert('Failed to save CSV: ' + (err.message ?? String(err)));
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function addPosterNameFilter() {
  const value = els.posterNameInput.value.trim();
  if (!value) return;
  const filter = {
    term: value,
    matchCase: posterNameMatchCase,
    matchWord: posterNameMatchWord
  };
  const exists = posterNameFilters.some(
    f => f.term === filter.term && f.matchCase === filter.matchCase && f.matchWord === filter.matchWord
  );
  if (!exists) {
    posterNameFilters.push(filter);
    renderFilters();
    renderTable();
  }
  els.posterNameInput.value = '';
}

function addPosterIdFilter() {
  const value = els.posterIdInput.value.trim();
  if (!value) return;
  const filter = {
    term: value,
    matchCase: false,
    matchWord: false
  };
  const exists = posterIdFilters.some(f => f.term === filter.term);
  if (!exists) {
    posterIdFilters.push(filter);
    renderFilters();
    renderTable();
  }
  els.posterIdInput.value = '';
}

function addContentFilter() {
  const value = els.contentInput.value.trim();
  if (!value) return;
  const filter = {
    term: value,
    matchCase: contentMatchCase,
    matchWord: contentMatchWord
  };
  const exists = contentFilters.some(
    f => f.term === filter.term && f.matchCase === filter.matchCase && f.matchWord === filter.matchWord
  );
  if (!exists) {
    contentFilters.push(filter);
    renderFilters();
    renderTable();
  }
  els.contentInput.value = '';
}

els.openFolder.addEventListener('click', openFolder);

els.addPosterName.addEventListener('click', addPosterNameFilter);
els.posterNameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addPosterNameFilter();
  }
});

els.posterNameMatchCase.addEventListener('change', () => {
  posterNameMatchCase = els.posterNameMatchCase.checked;
});

els.posterNameMatchWord.addEventListener('change', () => {
  posterNameMatchWord = els.posterNameMatchWord.checked;
});

els.addPosterId.addEventListener('click', addPosterIdFilter);
els.posterIdInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addPosterIdFilter();
  }
});

els.addContent.addEventListener('click', addContentFilter);
els.contentInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addContentFilter();
  }
});

els.contentMatchCase.addEventListener('change', () => {
  contentMatchCase = els.contentMatchCase.checked;
});

els.contentMatchWord.addEventListener('change', () => {
  contentMatchWord = els.contentMatchWord.checked;
});

els.requireScreenshot.addEventListener('change', () => {
  requireScreenshot = els.requireScreenshot.checked;
  renderFilters();
  renderTable();
});

els.requireLink.addEventListener('change', () => {
  requireLink = els.requireLink.checked;
  renderFilters();
  renderTable();
});

els.sessionsToggle.addEventListener('click', () => {
  const expanded = els.sessionsPanel.classList.toggle('hidden');
  els.sessionsToggle.setAttribute('aria-expanded', String(!expanded));
  els.sessionsToggle.textContent = expanded ? '▶ Sessions' : '▼ Sessions';
});

els.selectAllSessions.addEventListener('click', () => setAllSessions(true));
els.deselectAllSessions.addEventListener('click', () => setAllSessions(false));

els.exportCsv.addEventListener('click', exportCsv);

document.querySelectorAll('#records-table th.sortable').forEach(th => {
  th.addEventListener('click', () => cycleSort(th.dataset.column));
});

els.lightbox.addEventListener('click', closeLightbox);
els.mediaLightbox.addEventListener('click', closeMediaViewer);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!els.lightbox.classList.contains('hidden')) {
    closeLightbox();
  }
  if (!els.mediaLightbox.classList.contains('hidden')) {
    closeMediaViewer();
  }
});

window.addEventListener('beforeunload', () => {
  for (const url of screenshotBlobUrls.values()) {
    URL.revokeObjectURL(url);
  }
  for (const url of mediaBlobUrls.keys()) {
    URL.revokeObjectURL(url);
  }
});
