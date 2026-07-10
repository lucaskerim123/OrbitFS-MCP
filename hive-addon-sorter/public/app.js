const statusDotEl = document.getElementById('status-dot');
const statusMainEl = document.getElementById('status-main');
const statusSubEl = document.getElementById('status-sub');
const bulkRowEl = document.getElementById('bulk-row');
const bulkCountEl = document.getElementById('bulk-count');
const itemsEl = document.getElementById('items');
let session = null;
let folders = [];

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (window.HIVE_SORTER_API_KEY) headers['Authorization'] = `Bearer ${window.HIVE_SORTER_API_KEY}`;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function loadFolders() {
  const data = await api('/api/folders');
  folders = data.folders.map(f => f.path);
}

function updateStatusCard() {
  const items = session?.items || [];
  const approved = items.filter(i => i.approved).length;

  if (!session || session.status === 'idle') {
    statusDotEl.classList.add('idle');
    statusMainEl.textContent = 'Idle';
    statusSubEl.textContent = 'Scan the inbox to preview what would move.';
  } else if (session.status === 'stopped') {
    statusDotEl.classList.add('idle');
    statusMainEl.textContent = 'Session stopped';
    statusSubEl.textContent = session.lastRun ? `Last run ${new Date(session.lastRun).toLocaleString()}` : '';
  } else if (session.status === 'confirmed') {
    statusDotEl.classList.add('idle');
    const moved = session.result?.moved?.length ?? 0;
    statusMainEl.textContent = `Confirmed — moved ${moved} item${moved === 1 ? '' : 's'}`;
    statusSubEl.textContent = session.lastRun ? `Last run ${new Date(session.lastRun).toLocaleString()}` : '';
  } else if (!items.length) {
    statusDotEl.classList.add('idle');
    statusMainEl.textContent = 'Nothing to sort';
    statusSubEl.textContent = '_sorter is empty.';
  } else {
    statusDotEl.classList.remove('idle');
    statusMainEl.textContent = `${items.length} item${items.length === 1 ? '' : 's'} awaiting review`;
    statusSubEl.textContent = `${approved} approved · scanned ${session.startedAt ? new Date(session.startedAt).toLocaleTimeString() : ''}`;
  }

  bulkRowEl.classList.toggle('hidden', !items.length);
  if (items.length) bulkCountEl.textContent = `${approved} of ${items.length} approved`;
}

function renderItems() {
  itemsEl.innerHTML = '';
  const items = session?.items || [];

  if (!items.length) {
    itemsEl.innerHTML = '<p class="empty-state">No items to review. Scan the inbox to get started.</p>';
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = `item${item.approved ? ' approved' : ''}`;

    const check = document.createElement('div');
    check.className = 'item-check';
    check.textContent = item.approved ? '✓' : '';
    check.title = 'Toggle approve';
    check.addEventListener('click', () => {
      item.approved = !item.approved;
      renderItems();
      updateStatusCard();
    });

    const main = document.createElement('div');
    main.className = 'item-main';

    const head = document.createElement('div');
    head.className = 'item-head';
    const name = document.createElement('span');
    name.className = 'item-name';
    name.textContent = item.name;
    const badge = document.createElement('span');
    badge.className = `class-badge${item.status === 'needs_destination' ? ' needs-dest' : ''}`;
    badge.textContent = item.classification;
    head.append(name, badge);

    const reason = document.createElement('p');
    reason.className = 'item-reason';
    reason.textContent = item.status === 'needs_destination'
      ? 'No confident match — choose a destination before approving.'
      : item.reason;

    const dest = document.createElement('div');
    dest.className = 'item-dest';
    const select = document.createElement('select');
    const blankOpt = document.createElement('option');
    blankOpt.value = '';
    blankOpt.textContent = 'Choose a folder…';
    select.appendChild(blankOpt);
    for (const f of folders) {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      select.appendChild(opt);
    }
    const currentFolder = folders.find(f => item.selectedDestination?.startsWith(`${f}/`)) || '';
    select.value = currentFolder;

    const destInput = document.createElement('input');
    destInput.type = 'text';
    destInput.placeholder = 'Or type a destination path';
    destInput.value = item.selectedDestination || '';

    select.addEventListener('change', () => {
      item.selectedDestination = select.value ? `${select.value}/${item.name}` : '';
      destInput.value = item.selectedDestination;
    });
    destInput.addEventListener('input', () => { item.selectedDestination = destInput.value; });

    dest.append(select, destInput);
    main.append(head, reason, dest);
    row.append(check, main);
    itemsEl.appendChild(row);
  }
}

async function saveSession() {
  if (!session) return;
  await api('/api/session', { method: 'PUT', body: JSON.stringify(session) });
}

async function refreshSession() {
  try {
    session = await api('/api/session');
  } catch (err) {
    session = null;
    statusMainEl.textContent = err.message;
    statusSubEl.textContent = '';
  }
  updateStatusCard();
  renderItems();
}

document.getElementById('startBtn').addEventListener('click', async () => {
  statusMainEl.textContent = 'Scanning…';
  statusSubEl.textContent = '';
  try {
    await loadFolders();
    session = await api('/api/startsorter', { method: 'POST', body: '{}' });
    updateStatusCard();
    renderItems();
  } catch (err) {
    statusMainEl.textContent = err.message;
  }
});

document.getElementById('stopBtn').addEventListener('click', async () => {
  try {
    session = await api('/api/stopsorter', { method: 'POST', body: '{}' });
    updateStatusCard();
    renderItems();
  } catch (err) {
    statusMainEl.textContent = err.message;
  }
});

document.getElementById('confirmBtn').addEventListener('click', async () => {
  if (!session || !session.items?.length) return alert('No active session.');
  const approved = session.items.filter(x => x.approved).length;
  if (!approved) return alert('Nothing is approved yet — check the items you want moved first.');
  if (!confirm(`Move ${approved} approved item(s)? This can’t be undone from here.`)) return;
  try {
    await saveSession();
    session = await api('/api/confirmsorter', { method: 'POST', body: JSON.stringify({ items: session.items }) });
    await refreshSession();
  } catch (err) {
    statusMainEl.textContent = err.message;
  }
});

document.getElementById('approve-all-btn').addEventListener('click', () => {
  (session?.items || []).forEach(i => { i.approved = true; });
  renderItems();
  updateStatusCard();
});
document.getElementById('clear-all-btn').addEventListener('click', () => {
  (session?.items || []).forEach(i => { i.approved = false; });
  renderItems();
  updateStatusCard();
});

loadFolders().then(refreshSession).catch(err => {
  statusMainEl.textContent = err.message;
});
