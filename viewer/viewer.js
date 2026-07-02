// Record viewer logic for Telegram Recorder.
// Uses the File System Access API to load local telegram-recorder data.

// DOM references.
const els = {
  openFolder: document.getElementById('open-folder'),
  exportCsv: document.getElementById('export-csv'),
  nameSearch: document.getElementById('name-search'),
  groupInfo: document.getElementById('group-info'),
  groupList: document.getElementById('group-list'),
  sessionsSection: document.getElementById('sessions-section'),
  sessionsToggle: document.getElementById('sessions-toggle'),
  sessionsPanel: document.getElementById('sessions-panel'),
  sessionsList: document.getElementById('sessions-list'),
  selectAllSessions: document.getElementById('select-all-sessions'),
  deselectAllSessions: document.getElementById('deselect-all-sessions'),
  filtersSection: document.getElementById('filters-section'),
  emptyState: document.getElementById('empty-state'),
  tableContainer: document.getElementById('table-container'),
  recordsBody: document.getElementById('records-body'),
  lightbox: document.getElementById('lightbox'),
  lightboxImg: document.getElementById('lightbox-img')
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
/** @type {Set<string>} */
let selectedSessionIds = new Set();
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

function getVisibleMessages() {
  const search = els.nameSearch.value.trim().toLowerCase();

  return messages.filter(record => {
    if (!selectedSessionIds.has(record.sessionId)) return false;
    if (!search) return true;

    // Special keyword: filter anonymous admin posts (posterName null, posterId == groupId).
    if (search === 'admin' || search === '—' || search === '-') {
      return record.posterName == null && record.posterId === record.groupId;
    }

    const name = record.posterName ?? '';
    return name.toLowerCase().includes(search);
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
      case 'group':
        va = getGroupName(a.sessionId);
        vb = getGroupName(b.sessionId);
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
    const session = Array.from(sessions.values()).find(s => s.groupId === groupId);
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

function renderFilters() {
  if (messages.length === 0) {
    els.filtersSection.classList.add('hidden');
    return;
  }
  els.filtersSection.classList.remove('hidden');
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

  const list = els.sessionsList;
  list.innerHTML = '';

  const sortedSessions = Array.from(sessions.values()).sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  for (const session of sortedSessions) {
    const count = counts.get(session.id) || 0;
    const labelText = `${getSessionLabel(session.id)}  (${session.groupName} — ${count} message${count === 1 ? '' : 's'})`;

    const li = document.createElement('li');
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedSessionIds.has(session.id);
    checkbox.dataset.sessionId = session.id;
    checkbox.addEventListener('change', onSessionFilterChange);

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(labelText));
    li.appendChild(label);
    list.appendChild(li);
  }
}

function onSessionFilterChange() {
  selectedSessionIds = new Set();
  els.sessionsList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    if (cb.checked) selectedSessionIds.add(cb.dataset.sessionId);
  });
  renderTable();
}

function setAllSessions(checked) {
  els.sessionsList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
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
    tr.appendChild(createCell(getSessionLabel(record.sessionId)));
    tr.appendChild(createCell(getGroupName(record.sessionId)));
    tr.appendChild(createCell(record.posterName ?? MISSING_FIELD));
    tr.appendChild(createIdCell(record.posterId));
    tr.appendChild(createContentCell(record.content));
    tr.appendChild(createImagesCell(record.images, record.messageId));
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

/**
 * Render a peer ID as a clickable link to the Telegram Web K page.
 * @param {string|null} peerId
 */
function createIdCell(peerId) {
  const td = document.createElement('td');
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
  div.className = 'content-text expanded';
  div.textContent = content ?? MISSING_FIELD;
  div.addEventListener('click', () => div.classList.toggle('expanded'));
  td.appendChild(div);
  return td;
}

function createImagesCell(images, messageId) {
  const td = document.createElement('td');
  td.className = 'images-cell';
  if (!images || images.length === 0) {
    td.textContent = MISSING_FIELD;
    return td;
  }
  const badge = document.createElement('span');
  badge.className = 'image-badge';
  badge.textContent = `${images.length} image${images.length === 1 ? '' : 's'}`;
  badge.title = images.join('\n');
  td.appendChild(badge);
  return td;
}

function createLinksCell(links) {
  const td = document.createElement('td');
  td.className = 'links-cell';
  if (!links || links.length === 0) {
    td.textContent = MISSING_FIELD;
    return td;
  }
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
  'images',
  'screenshot_file',
  'screenshot_path'
];

const CSV_COMMENTS = [
  '# Screenshots are local files. Resolve paths relative to your telegram-recorder/ folder.',
  '# Blob URLs in \'images\' column are ephemeral and expire when the recording tab is closed.'
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
      (record.images ?? []).join('|'),
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

els.openFolder.addEventListener('click', openFolder);

els.nameSearch.addEventListener('input', () => {
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
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !els.lightbox.classList.contains('hidden')) {
    closeLightbox();
  }
});

window.addEventListener('beforeunload', () => {
  for (const url of screenshotBlobUrls.values()) {
    URL.revokeObjectURL(url);
  }
});
