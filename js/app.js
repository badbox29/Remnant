/* ─────────────────────────────────────────────────────────────────
   Remnant — app.js
   localStorage (account/tab metadata) + IndexedDB (note/scratchpad
   content) + Cloudflare KV sync, three auth tiers via auth.js.
   ───────────────────────────────────────────────────────────────── */
'use strict';

// ─── Constants ────────────────────────────────────────────────────

const STORAGE_KEY         = 'rmt_appdata';
const STORAGE_AUTH_KEY    = 'rmt_google_id_token';
const STORAGE_DISMISS_KEY = 'rmt_token_upgrade_dismissed';

// Sync cadence: not a fixed interval like a 60s ping. We sync when the
// page opens (if it's been more than an hour), on a coarse background
// check while the tab stays open, on a best-effort basis when the tab
// is hidden/closed, and on demand via the Save Session button.
const SYNC_THRESHOLD_MS      = 60 * 60 * 1000; // 1 hour
const SYNC_CHECK_INTERVAL_MS = 5 * 60 * 1000;  // re-check the threshold every 5 min while open

// ─── State ────────────────────────────────────────────────────────

const App = {
  data: null,           // localStorage-shaped object: account/tab metadata only
  openNotes: {},         // in-memory cache of notes currently open in tabs: { [id]: note }
  activeNoteId: null,
  syncCheckTimer: null,
};

// Default data shape (localStorage). Note CONTENT is never stored here —
// only which notes are open and which is active. Content lives in
// NotesStore (IndexedDB) and is assembled into the KV blob separately.
function defaultData() {
  return {
    authMethod:   'guest',
    userToken:    Auth.generateToken(),
    workerUrl:    '',
    linkedGoogle: null,
    firstName:    '',
    lastName:     '',
    username:     '',
    tabState: {
      openIds:  [],   // ordered array of note ids currently open as tabs
      activeId: null,
    },
    lastSyncTime: 0,      // epoch ms of last successful KV push
    pendingSync:  false,  // true when local content has changed since lastSyncTime
    lastModified: Date.now(),
  };
}

function mergeData(raw) {
  const d = defaultData();
  if (!raw || typeof raw !== 'object') return d;
  return {
    ...d,
    ...raw,
    tabState: (raw.tabState && typeof raw.tabState === 'object')
      ? { openIds: Array.isArray(raw.tabState.openIds) ? raw.tabState.openIds : [], activeId: raw.tabState.activeId ?? null }
      : d.tabState,
  };
}

// ─── LocalStorage helpers ─────────────────────────────────────────

const ls = {
  get:    k => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set:    (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) { console.error('[Remnant] localStorage.set failed:', e); } },
  remove: k => { try { localStorage.removeItem(k); } catch {} },
};

function saveLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(App.data));
  } catch(e) {
    console.error('[Remnant] saveLocal failed — data NOT persisted:', e);
    showToast('⚠️ Could not save — storage may be full or unavailable');
  }
}

// markDirty() — call after any note/scratchpad/tab-state change.
// Persists the pendingSync flag itself (not just in-memory) so a reload
// before the next sync still knows there's unsynced content.
function markDirty() {
  App.data.pendingSync  = true;
  App.data.lastModified = Date.now();
  saveLocal();
  updateSyncIndicator();
}

function updateSyncIndicator() {
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  el.style.display = (App.data?.pendingSync && getWorkerUrl()) ? '' : 'none';
}

// ─── Worker sync ──────────────────────────────────────────────────

function getWorkerUrl() {
  return App.data?.workerUrl || '';
}

// assembleSyncPayload() — gathers localStorage metadata + IndexedDB note
// content + scratchpad into the one JSON blob that goes to KV. This is the
// piece that doesn't exist in the Refectory pattern: there, everything
// synced was already in one synchronous object. Here, content lives in
// IndexedDB, so building the payload is async.
async function assembleSyncPayload() {
  const [notes, scratchpad] = await Promise.all([
    NotesStore.getAll(),
    NotesStore.getScratchpad(),
  ]);
  return {
    ...App.data,
    notes,
    scratchpad: scratchpad || { content: '', updatedAt: 0 },
  };
}

async function pushToWorker() {
  const base  = getWorkerUrl().replace(/\/+$/, '');
  if (!base) return false;
  const token = App.data?.userToken;
  if (!token) return false;

  const payload = await assembleSyncPayload();
  const body    = JSON.stringify(payload);
  const headers = await Auth._authHeaders('PUT', token, body);
  try {
    const res = await fetch(`${base}/storage/${encodeURIComponent(token)}/profile`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    if (res.ok) {
      App.data.pendingSync  = false;
      App.data.lastSyncTime = Date.now();
      saveLocal();
      updateSyncIndicator();
      updateLastSyncedLabel();
    } else {
      const errText = await res.text().catch(() => String(res.status));
      console.error(`[Remnant] pushToWorker failed (${res.status}):`, errText);
    }
    return res.ok;
  } catch(e) {
    console.error('[Remnant] pushToWorker network error:', e);
    return false;
  }
}

async function pullFromWorker() {
  const base  = getWorkerUrl().replace(/\/+$/, '');
  if (!base) return null;
  const token   = App.data?.userToken;
  if (!token) return null;
  const headers = await Auth._authHeaders('GET', token, '');
  try {
    const res = await fetch(`${base}/storage/${encodeURIComponent(token)}/profile`, { headers });
    if (res.status === 410) {
      // Token was migrated to a Google account on another device.
      App.data.authMethod = 'google';
      saveLocal();
      return null;
    }

    const migratedTo = res.headers.get('X-Token-Migrated');
    if (migratedTo) {
      const j = await res.json();
      const remote = j.value ?? j;
      const { notes, scratchpad, ...metadata } = remote;
      const migrated = Auth.handlePullMigration(migratedTo, mergeData(metadata));
      App.data = migrated;
      await Promise.all([
        NotesStore.replaceAll(notes || {}),
        NotesStore.setScratchpad((scratchpad && scratchpad.content) || ''),
      ]);
      saveLocal();
      return remote;
    }

    if (!res.ok) return null;
    const j = await res.json();
    return j.value ?? j;
  } catch { return null; }
}

// shouldSync() — the heart of the new cadence: sync if there's anything
// dirty AND it's been more than SYNC_THRESHOLD_MS since the last
// successful push. The Save Session button bypasses this check entirely.
function shouldSync() {
  if (Auth.isGuest()) return false;
  if (!getWorkerUrl()) return false;
  if (!App.data.pendingSync) return false;
  return (Date.now() - (App.data.lastSyncTime || 0)) >= SYNC_THRESHOLD_MS;
}

async function maybeSync() {
  if (!shouldSync()) return;
  await pushToWorker();
}

function startSyncPing() {
  if (App.syncCheckTimer) clearInterval(App.syncCheckTimer);
  App.syncCheckTimer = setInterval(maybeSync, SYNC_CHECK_INTERVAL_MS);
}

// Best-effort push when the tab is hidden or being closed — no prompt,
// no guarantee, just a quiet attempt if there's unsynced content. This
// covers the "open all day, never revisits the threshold check" gap and
// the "closing the laptop" moment, without relying on a beforeunload
// dialog that can't reliably await a network call anyway.
function bestEffortPushOnHide() {
  if (Auth.isGuest()) return;
  if (!getWorkerUrl()) return;
  if (!App.data.pendingSync) return;
  // Fire and forget — we cannot await this once the page is unloading.
  pushToWorker();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') bestEffortPushOnHide();
});
window.addEventListener('beforeunload', bestEffortPushOnHide);

function updateLastSyncedLabel() {
  const el = document.getElementById('settings-last-synced');
  if (!el) return;
  const t = App.data?.lastSyncTime;
  el.textContent = t ? new Date(t).toLocaleString() : 'Never';
}

// ─── Save Session button (manual sync, bypasses the threshold) ────

function updateSaveSessionVisibility() {
  const btn = document.getElementById('save-session-btn');
  if (!btn) return;
  btn.style.display = (!Auth.isGuest() && getWorkerUrl()) ? '' : 'none';
}

document.getElementById('save-session-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('save-session-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const ok = await pushToWorker();
  btn.disabled = false;
  btn.textContent = 'Save Session';
  showToast(ok ? 'Session saved ✓' : 'Could not save — check your connection');
});

// ─── Toast ────────────────────────────────────────────────────────

let toastTimer = null;
function showToast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ─── Modals ───────────────────────────────────────────────────────

function openModal(id) {
  document.getElementById(id)?.classList.add('open');
}
function closeModal(id) {
  document.getElementById(id)?.classList.remove('open');
}

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

// ─── Notes: creation, switching, editing ──────────────────────────

function generateNoteId() {
  return 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function createNote() {
  const id = generateNoteId();
  const note = { id, title: '', content: '', createdAt: Date.now(), updatedAt: Date.now() };
  await NotesStore.set(id, note);
  App.openNotes[id] = note;
  App.data.tabState.openIds.push(id);
  setActiveNote(id);
  markDirty();
  renderTabs();
}

async function openNoteInTab(id) {
  if (!App.openNotes[id]) {
    const note = await NotesStore.get(id);
    if (!note) return;
    App.openNotes[id] = note;
  }
  if (!App.data.tabState.openIds.includes(id)) {
    App.data.tabState.openIds.push(id);
  }
  setActiveNote(id);
  markDirty();
  renderTabs();
}

function setActiveNote(id) {
  App.activeNoteId = id;
  App.data.tabState.activeId = id;
  renderActiveNote();
}

async function closeTab(id) {
  App.data.tabState.openIds = App.data.tabState.openIds.filter(x => x !== id);
  if (App.activeNoteId === id) {
    const remaining = App.data.tabState.openIds;
    App.activeNoteId = remaining.length ? remaining[remaining.length - 1] : null;
    App.data.tabState.activeId = App.activeNoteId;
  }
  markDirty();
  renderTabs();
  renderActiveNote();
}

async function deleteNote(id) {
  await NotesStore.delete(id);
  delete App.openNotes[id];
  await closeTab(id);
  renderNotesList();
}

// Debounced autosave-to-IndexedDB on every keystroke. This is the first
// line of defense against data loss — independent of KV sync cadence.
let saveNoteTimer = null;
function scheduleSaveActiveNote() {
  clearTimeout(saveNoteTimer);
  saveNoteTimer = setTimeout(saveActiveNote, 400);
}

async function saveActiveNote() {
  const id = App.activeNoteId;
  if (!id) return;
  const note = App.openNotes[id];
  if (!note) return;
  note.title     = document.getElementById('note-title-input').value;
  note.content   = document.getElementById('note-body-input').value;
  note.updatedAt = Date.now();
  await NotesStore.set(id, note);
  markDirty();
  renderTabs(); // tab title may have changed
}

// ─── Scratchpad ─────────────────────────────────────────────────────

let saveScratchpadTimer = null;
function scheduleSaveScratchpad() {
  clearTimeout(saveScratchpadTimer);
  saveScratchpadTimer = setTimeout(async () => {
    const content = document.getElementById('scratchpad-input').value;
    await NotesStore.setScratchpad(content);
    markDirty();
  }, 400);
}

async function loadScratchpad() {
  const pad = await NotesStore.getScratchpad();
  document.getElementById('scratchpad-input').value = (pad && pad.content) || '';
}

// ─── Rendering ──────────────────────────────────────────────────────

function noteTabLabel(note) {
  const t = (note?.title || '').trim();
  return t || 'Untitled';
}

function renderTabs() {
  const bar = document.getElementById('tab-bar');
  bar.innerHTML = '';

  App.data.tabState.openIds.forEach(id => {
    const note = App.openNotes[id];
    if (!note) return;
    const tab = document.createElement('div');
    tab.className = 'tab' + (id === App.activeNoteId ? ' active' : '');
    tab.innerHTML = `<span class="tab-label"></span><span class="tab-close">&times;</span>`;
    tab.querySelector('.tab-label').textContent = noteTabLabel(note);
    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) {
        closeTab(id);
      } else {
        setActiveNote(id);
        renderTabs();
      }
    });
    bar.appendChild(tab);
  });

  const newTab = document.createElement('div');
  newTab.className = 'tab-new';
  newTab.textContent = '+';
  newTab.title = 'New note';
  newTab.addEventListener('click', createNote);
  bar.appendChild(newTab);
}

function renderActiveNote() {
  const titleEl = document.getElementById('note-title-input');
  const bodyEl  = document.getElementById('note-body-input');
  const note    = App.activeNoteId ? App.openNotes[App.activeNoteId] : null;

  if (!note) {
    titleEl.value = '';
    bodyEl.value  = '';
    titleEl.disabled = true;
    bodyEl.disabled  = true;
    bodyEl.placeholder = 'Open a note, or click "+" to start a new one…';
    return;
  }
  titleEl.disabled = false;
  bodyEl.disabled  = false;
  bodyEl.placeholder = 'Start writing…';
  titleEl.value = note.title || '';
  bodyEl.value  = note.content || '';
}

async function renderNotesList() {
  const listEl = document.getElementById('notes-list');
  const all = await NotesStore.getAll();
  const entries = Object.values(all).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  listEl.innerHTML = '';
  if (!entries.length) {
    listEl.innerHTML = `<div class="notes-list-item"><span class="muted f13">No notes yet.</span></div>`;
    return;
  }
  entries.forEach(note => {
    const row = document.createElement('div');
    row.className = 'notes-list-item';
    row.innerHTML = `
      <span class="notes-list-item-title"></span>
      <span class="notes-list-item-date"></span>
    `;
    row.querySelector('.notes-list-item-title').textContent = noteTabLabel(note);
    row.querySelector('.notes-list-item-date').textContent  =
      note.updatedAt ? new Date(note.updatedAt).toLocaleDateString() : '';
    row.addEventListener('click', () => openNoteInTab(note.id));
    listEl.appendChild(row);
  });
}

document.getElementById('toggle-notes-list-btn')?.addEventListener('click', () => {
  const el = document.getElementById('notes-list');
  const showing = el.style.display !== 'none';
  el.style.display = showing ? 'none' : '';
  if (!showing) renderNotesList();
});

document.getElementById('note-title-input')?.addEventListener('input', scheduleSaveActiveNote);
document.getElementById('note-body-input')?.addEventListener('input', scheduleSaveActiveNote);
document.getElementById('scratchpad-input')?.addEventListener('input', scheduleSaveScratchpad);

async function renderAll() {
  // Rehydrate open tabs from IndexedDB
  const ids = App.data.tabState.openIds || [];
  for (const id of ids) {
    const note = await NotesStore.get(id);
    if (note) App.openNotes[id] = note;
  }
  // Drop any tab ids that no longer resolve to a note (e.g. deleted elsewhere)
  App.data.tabState.openIds = ids.filter(id => App.openNotes[id]);
  App.activeNoteId = App.data.tabState.activeId && App.openNotes[App.data.tabState.activeId]
    ? App.data.tabState.activeId
    : (App.data.tabState.openIds[0] || null);
  App.data.tabState.activeId = App.activeNoteId;

  renderTabs();
  renderActiveNote();
  await loadScratchpad();
  updateSyncIndicator();
  updateSaveSessionVisibility();
  updateLastSyncedLabel();
}

// ─── Settings modal ─────────────────────────────────────────────────

function openSettingsModal() {
  const d = App.data;
  document.getElementById('settings-firstname-input').value = d.firstName || '';
  document.getElementById('settings-lastname-input').value  = d.lastName  || '';
  document.getElementById('settings-username-input').value  = d.username  || '';
  const workerEl = document.getElementById('settings-worker-url');
  if (workerEl) workerEl.value = d.workerUrl || '';

  Auth.renderSettingsSection();
  updateLastSyncedLabel();
  openModal('modal-settings');
}

function saveSettingsProfileFields() {
  App.data.firstName = document.getElementById('settings-firstname-input').value.trim();
  App.data.lastName  = document.getElementById('settings-lastname-input').value.trim();
  App.data.username  = document.getElementById('settings-username-input').value.trim();
  const workerEl = document.getElementById('settings-worker-url');
  if (workerEl) App.data.workerUrl = workerEl.value.trim().replace(/\/+$/, '');
  saveLocal();
}

document.getElementById('open-settings-btn')?.addEventListener('click', openSettingsModal);
document.getElementById('settings-close-btn')?.addEventListener('click', () => {
  saveSettingsProfileFields();
  closeModal('modal-settings');
  updateSaveSessionVisibility();
  updateSyncIndicator();
});

document.getElementById('settings-sync-now-btn')?.addEventListener('click', async () => {
  const ok = await pushToWorker();
  showToast(ok ? 'Synced ✓' : 'Sync failed — check your connection');
});

document.getElementById('settings-token-copy')?.addEventListener('click', () => {
  const token = App.data?.userToken || '';
  navigator.clipboard.writeText(token).then(() => {
    const btn = document.getElementById('settings-token-copy');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  }).catch(() => showToast('Select the token above and copy manually.'));
});

document.getElementById('settings-token-change')?.addEventListener('click', () => {
  closeModal('modal-settings');
  Auth.showSetupLoadToken();
});

document.getElementById('settings-upgrade-google-btn')?.addEventListener('click', () => {
  closeModal('modal-settings');
  Auth.showGoogleUpgradeFlow();
});

document.getElementById('settings-account-btn')?.addEventListener('click', () => {
  closeModal('modal-settings');
  if (Auth.isGuest())             Auth.showSetupFresh();
  else if (Auth.isTokenAccount()) Auth.showGoogleUpgradeFlow();
  else                             Auth.showGuestSwitchConfirm();
});

// ─── Auth callbacks ─────────────────────────────────────────────────

async function onSignedIn(data, isNew) {
  // If the incoming data carries notes/scratchpad (it came straight off a
  // KV pull elsewhere in auth.js, e.g. handleGoogleCredential or the
  // load-existing-token flow), route that content into IndexedDB now
  // rather than leaving it stranded on the plain metadata object.
  const { notes, scratchpad, ...metadata } = data || {};
  App.data = mergeData(metadata);
  if (notes || scratchpad) {
    await Promise.all([
      notes ? NotesStore.replaceAll(notes) : Promise.resolve(),
      scratchpad ? NotesStore.setScratchpad(scratchpad.content || '') : Promise.resolve(),
    ]);
  }
  saveLocal();
  await renderAll();
  showToast(isNew ? 'Welcome to Remnant 📜' : 'Welcome back — syncing your notes…');
  pushToWorker();
}

async function onGuestReady(data) {
  App.data = mergeData(data);
  saveLocal();
  await renderAll();
}

// ─── Boot ───────────────────────────────────────────────────────────

async function fetchGoogleClientId() {
  const base = getWorkerUrl().replace(/\/+$/, '');
  if (!base) return '';
  try {
    const res = await fetch(`${base}/auth/config`);
    if (!res.ok) return '';
    const data = await res.json();
    return data.googleClientId || '';
  } catch { return ''; }
}

async function boot() {
  const stored = ls.get(STORAGE_KEY);
  App.data     = stored ? mergeData(stored) : defaultData();

  const googleClientId = await fetchGoogleClientId();

  Auth.init({
    googleClientId,
    storageKey:        STORAGE_KEY,
    storageAuthKey:    STORAGE_AUTH_KEY,
    storageDismissKey: STORAGE_DISMISS_KEY,
    workerBase:        getWorkerUrl,
    getData:           () => App.data,
    setData:           (d) => { App.data = d; saveLocal(); },
    mergeData,
    onSignedIn,
    onGuestReady,
    onSessionExpired:  () => {},
    pushToWorker,
    startSyncPing,
    openModal,
    closeModal,
    toast:             showToast,
    appName:           'Remnant',
    appEmoji:          '📜',
  });

  // New user — show account setup wizard
  if (!stored) {
    await renderAll();
    Auth.showAccountSetup();
    return;
  }

  // Existing session — pull from worker if configured, merge with local.
  // Local note edits win on conflict (per-note updatedAt), same spirit as
  // the Refectory pattern, just applied across the IndexedDB/localStorage
  // split rather than a single object.
  const tokenBeforePull = App.data.userToken;
  if (getWorkerUrl()) {
    const remote = await pullFromWorker();
    if (remote) {
      const { notes: remoteNotes, scratchpad: remoteScratchpad, ...metadata } = remote;
      const localNotes = await NotesStore.getAll();
      const merged = { ...(remoteNotes || {}) };
      for (const [id, localNote] of Object.entries(localNotes)) {
        const remoteNote = merged[id];
        if (!remoteNote || (localNote.updatedAt || 0) >= (remoteNote.updatedAt || 0)) {
          merged[id] = localNote;
        }
      }
      App.data = mergeData(metadata);
      await NotesStore.replaceAll(merged);

      const localPad  = await NotesStore.getScratchpad();
      const remotePad  = remoteScratchpad;
      // Scratchpad has no per-id merge target — newest updatedAt wins outright.
      if (remotePad && (!localPad || (remotePad.updatedAt || 0) > (localPad.updatedAt || 0))) {
        await NotesStore.setScratchpad(remotePad.content || '');
      }
      saveLocal();
    }
  }

  const ok = await Auth.bootCheck(tokenBeforePull);
  if (!ok) return;

  await renderAll();
  if (!Auth.isGuest()) startSyncPing();
  // Catch up on a sync immediately if we crossed the threshold while away.
  maybeSync();
}

document.addEventListener('DOMContentLoaded', boot);
