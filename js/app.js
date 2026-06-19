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
  // In-memory cache of the structure tree (Books/Chapters), rebuilt from
  // IndexedDB on boot and after any structural edit. Note CONTENT is never
  // cached wholesale here — only the lightweight book/chapter records and
  // enough note metadata (id, title, chapterId, order, updatedAt, type) to
  // render the tree without loading every note body into memory at once.
  books: {},
  chapters: {},
  noteSummaries: {},     // { [id]: { id, title, chapterId, order, updatedAt, type } } — for tree rendering
  drag: null,            // transient drag state, see "Drag and drop" section

  // ── Cipher session state — deliberately ALL outside App.data ───────
  // None of the fields below are ever read by saveLocal() or
  // assembleSyncPayload(), because neither function looks outside
  // App.data. That's not a filter that has to be remembered at every
  // persistence boundary — it's a structural guarantee: a Cipher's open/
  // unlocked state simply cannot reach localStorage or KV, because the
  // functions that write to those places never look here at all.
  openCipherIds: [],     // ordered array of Cipher ids currently open as tabs (mirrors tabState.openIds, but for Ciphers, and NEVER persisted)
  unlockedCiphers: {},   // { [cipherId]: { plaintext, key } } — only for Ciphers open AND successfully unlocked THIS session
  sessionCipherKeys: {}, // { [cipherId]: key } — the OPT-IN "remember for this session" cache; survives a Cipher tab being closed and reopened, but never a page reload
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
    // Nav panel UI state — which books/chapters are expanded, whether the
    // panel itself is open, and whether it's pinned (claims layout space)
    // or pop-out (overlays the layout). Persisted because losing your
    // place in the tree on every reload would undercut the point of having
    // one, and because "pinned" is a workflow preference worth remembering
    // across devices via KV sync just like everything else in this object.
    navState: {
      panelOpen:        false,
      pinned:           false,
      expandedBookIds:    [],
      expandedChapterIds: [],
    },
    lastSyncTime: 0,      // epoch ms of last successful KV push
    pendingSync:  false,  // true when local content has changed since lastSyncTime
    lastModified: Date.now(),
    // "Don't show this warning again" preference for the Cipher creation
    // modal's no-recovery warning. Fine to sync via KV like any other UI
    // preference — it's just a dismissal flag, holds no secret of any kind.
    cipherWarningDismissed: false,
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
    navState: (raw.navState && typeof raw.navState === 'object')
      ? {
          panelOpen:          !!raw.navState.panelOpen,
          pinned:             !!raw.navState.pinned,
          expandedBookIds:    Array.isArray(raw.navState.expandedBookIds)    ? raw.navState.expandedBookIds    : [],
          expandedChapterIds: Array.isArray(raw.navState.expandedChapterIds) ? raw.navState.expandedChapterIds : [],
        }
      : d.navState,
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
// content + structure (books/chapters) + scratchpad into the one JSON blob
// that goes to KV. This is the piece that doesn't exist in the Refectory
// pattern: there, everything synced was already in one synchronous object.
// Here, content lives in IndexedDB, so building the payload is async.
async function assembleSyncPayload() {
  const [notes, books, chapters, scratchpad] = await Promise.all([
    NotesStore.getAll(),
    NotesStore.getAllBooks(),
    NotesStore.getAllChapters(),
    NotesStore.getScratchpad(),
  ]);
  return {
    ...App.data,
    notes,
    structure: { books, chapters },
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
      const { notes, structure, scratchpad, ...metadata } = remote;
      const migrated = Auth.handlePullMigration(migratedTo, mergeData(metadata));
      App.data = migrated;
      await Promise.all([
        NotesStore.replaceAll(notes || {}),
        NotesStore.replaceAllBooks((structure && structure.books) || {}),
        NotesStore.replaceAllChapters((structure && structure.chapters) || {}),
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

// createNote(chapterId) — chapterId is optional; omitted/null means the
// note starts unfiled. Called both from the tab bar's "+" (always unfiled)
// and from the nav tree's "+ New Note" row under a specific chapter.
async function createNote(chapterId = null) {
  const id = generateNoteId();
  const siblingNotes = Object.values(App.noteSummaries).filter(n => n.chapterId === chapterId);
  const order = nextOrder(siblingNotes);
  const note = { id, chapterId, title: '', content: '', order, createdAt: Date.now(), updatedAt: Date.now() };
  await NotesStore.set(id, note);
  App.openNotes[id] = note;
  App.noteSummaries[id] = { id, title: '', chapterId, order, updatedAt: note.updatedAt };
  if (chapterId && App.chapters[chapterId]) {
    App.chapters[chapterId].noteIds.push(id);
    await NotesStore.setChapter(chapterId, App.chapters[chapterId]);
  }
  App.data.tabState.openIds.push(id);
  setActiveNote(id);
  markDirty();
  renderTabs();
  renderNavTree();
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
  revealNoteInNavTree(id);
}

function setActiveNote(id) {
  App.activeNoteId = id;
  // Only a plain Remnant's active-tab id is ever written into App.data —
  // that object is what gets persisted to localStorage and synced to KV.
  // A Cipher becoming active must never appear there, full stop; see the
  // "Ciphers: creation, unlock, editing" section header for the full
  // reasoning on why Cipher tab/session state stays structurally outside
  // App.data everywhere, not just here.
  if (!isCipherNote(App.noteSummaries[id])) {
    App.data.tabState.activeId = id;
  }
  renderActiveNote();
}

async function closeTab(id) {
  const wasCipher = App.openCipherIds.includes(id);
  if (wasCipher) {
    App.openCipherIds = App.openCipherIds.filter(x => x !== id);
    // Closing a Cipher tab clears its UNLOCKED state — reopening it
    // (this session or not) re-prompts, unless a session-cached key
    // exists from an explicit "remember for this session" earlier.
    delete App.unlockedCiphers[id];
  } else {
    App.data.tabState.openIds = App.data.tabState.openIds.filter(x => x !== id);
  }

  if (App.activeNoteId === id) {
    // Fall back to whichever tab list still has something open —
    // Remnant tabs first, then Cipher tabs, matching how they're
    // concatenated for rendering (see renderTabs).
    const remaining = [...App.data.tabState.openIds, ...App.openCipherIds];
    App.activeNoteId = remaining.length ? remaining[remaining.length - 1] : null;
    if (!isCipherNote(App.noteSummaries[App.activeNoteId])) {
      App.data.tabState.activeId = App.activeNoteId;
    } else {
      App.data.tabState.activeId = null;
    }
  }
  markDirty();
  renderTabs();
  renderActiveNote();
}

async function deleteNote(id) {
  const summary = App.noteSummaries[id];
  if (summary?.chapterId && App.chapters[summary.chapterId]) {
    const chapter = App.chapters[summary.chapterId];
    chapter.noteIds = chapter.noteIds.filter(nid => nid !== id);
    await NotesStore.setChapter(chapter.id, chapter);
  }
  await NotesStore.delete(id);
  delete App.openNotes[id];
  delete App.noteSummaries[id];
  delete App.unlockedCiphers[id];
  delete App.sessionCipherKeys[id];
  await closeTab(id);
  markDirty();
  renderNavTree();
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
  if (App.noteSummaries[id]) {
    App.noteSummaries[id].title     = note.title;
    App.noteSummaries[id].updatedAt = note.updatedAt;
  }
  markDirty();
  renderTabs();    // tab title may have changed
  renderNavTree();  // nav row label may have changed
}

// ─── Ciphers: creation, unlock, editing ────────────────────────────
//
// A Cipher is a Remnant (type: 'cipher' on the note record) whose body
// is end-to-end encrypted with a user passphrase. See cipher.js for the
// crypto itself — this section only orchestrates: modals, in-memory
// unlock state, and wiring a Cipher into the same tab/nav system a
// plain Remnant already uses.
//
// Three pieces of in-memory-only state (see App object, top of file):
//   App.openCipherIds    — which Cipher tabs are open right now
//   App.unlockedCiphers  — { [id]: { plaintext, key } } for ones unlocked
//                           THIS session (cleared when the tab is closed)
//   App.sessionCipherKeys — { [id]: key } for ones the user opted into
//                            "remember for this session" — survives a
//                            tab close+reopen, but never a page reload
// None of these three are ever read by saveLocal() or
// assembleSyncPayload(), because neither function looks outside
// App.data — so Cipher session/unlock state structurally cannot reach
// localStorage or KV sync, not as a rule that has to be remembered, but
// because the relevant code paths never look here at all.

function generateCipherId() {
  return generateId('k'); // 'k' for cipher — 'c' is already Chapter's prefix
}

function isCipherNote(noteOrSummary) {
  return noteOrSummary?.type === 'cipher';
}

// openCipherCreateModal(chapterId) — entry point from the nav tree's
// "+ New Cipher" row. chapterId is optional/null for an unfiled Cipher.
function openCipherCreateModal(chapterId = null) {
  App._pendingCipherChapterId = chapterId;
  const dontRemind = !!App.data.cipherWarningDismissed;
  document.getElementById('cipher-create-warning').style.display = dontRemind ? 'none' : '';
  document.getElementById('cipher-create-passphrase').value = '';
  document.getElementById('cipher-create-passphrase-confirm').value = '';
  document.getElementById('cipher-create-dont-remind').checked = dontRemind;
  document.getElementById('cipher-create-status').textContent = '';
  openModal('modal-cipher-create');
  document.getElementById('cipher-create-passphrase').focus();
}

async function submitCipherCreate() {
  const statusEl = document.getElementById('cipher-create-status');
  const pass1 = document.getElementById('cipher-create-passphrase').value;
  const pass2 = document.getElementById('cipher-create-passphrase-confirm').value;

  if (!pass1) { statusEl.textContent = 'Enter a passphrase.'; return; }
  if (pass1 !== pass2) { statusEl.textContent = 'Passphrases do not match.'; return; }
  if (pass1.length < 4) { statusEl.textContent = 'Passphrase is too short.'; return; }

  const confirmBtn = document.getElementById('cipher-create-confirm-btn');
  confirmBtn.disabled = true;
  statusEl.style.color = 'var(--muted)';
  statusEl.textContent = 'Deriving key…'; // Argon2id is deliberately slow — give the user something to read

  // This try/catch guards ONLY the actual encryption + storage write —
  // the part that can legitimately fail (e.g. Argon2 not loaded, a
  // storage quota error). Bookkeeping/rendering after a successful
  // creation is deliberately outside it, same reasoning as
  // submitCipherUnlock: a rendering issue must never be mislabeled as
  // "creating the Cipher failed" when it actually succeeded.
  const chapterId = App._pendingCipherChapterId;
  const id = generateCipherId();
  let record, key, order;
  try {
    const result = await Cipher.createRecord(pass1, ''); // fresh Cipher starts blank, same as a fresh Remnant
    record = result.record;
    key    = result.key;
    const siblingNotes = Object.values(App.noteSummaries).filter(n => n.chapterId === chapterId);
    order = nextOrder(siblingNotes);
    const note = {
      id, chapterId, title: '', type: 'cipher', encrypted: record,
      order, createdAt: Date.now(), updatedAt: Date.now(),
    };
    await NotesStore.set(id, note);
  } catch (e) {
    console.error('[Remnant] Cipher creation failed:', e);
    statusEl.style.color = 'var(--red)';
    statusEl.textContent = 'Something went wrong creating the Cipher. Please try again.';
    confirmBtn.disabled = false;
    return;
  }
  confirmBtn.disabled = false;

  // Creation succeeded — everything below is bookkeeping/rendering.
  App.noteSummaries[id] = { id, title: '', chapterId, order, updatedAt: Date.now(), type: 'cipher' };
  if (chapterId && App.chapters[chapterId]) {
    App.chapters[chapterId].noteIds.push(id);
    await NotesStore.setChapter(chapterId, App.chapters[chapterId]);
  }

  // Just created it — already "unlocked" for this session, no need to
  // immediately re-prompt for the passphrase we just set.
  App.unlockedCiphers[id] = { plaintext: '', key };
  App.openCipherIds.push(id);
  setActiveNote(id);

  if (document.getElementById('cipher-create-dont-remind').checked) {
    App.data.cipherWarningDismissed = true;
    saveLocal();
  }

  closeModal('modal-cipher-create');
  markDirty();
  renderTabs();
  renderNavTree();
  renderActiveNote();
}

document.getElementById('cipher-create-confirm-btn')?.addEventListener('click', submitCipherCreate);
document.getElementById('cipher-create-cancel-btn')?.addEventListener('click', () => closeModal('modal-cipher-create'));
document.getElementById('cipher-create-close-btn')?.addEventListener('click', () => closeModal('modal-cipher-create'));

// openCipherInTab(id) — entry point from clicking a Cipher row in the nav
// tree, or re-selecting an already-open Cipher tab. If the Cipher is
// already unlocked this session (or a session-cached key exists), skip
// the passphrase prompt entirely; otherwise show the unlock modal.
async function openCipherInTab(id) {
  if (!App.openCipherIds.includes(id)) App.openCipherIds.push(id);

  if (App.unlockedCiphers[id]) {
    setActiveNote(id);
    renderTabs();
    renderActiveNote();
    revealNoteInNavTree(id);
    return;
  }

  const cachedKey = App.sessionCipherKeys[id];
  if (cachedKey) {
    const note = await NotesStore.get(id);
    try {
      const plaintext = await Cipher.decryptWithKey(cachedKey, note.encrypted);
      App.unlockedCiphers[id] = { plaintext, key: cachedKey };
      setActiveNote(id);
      renderTabs();
      renderActiveNote();
      revealNoteInNavTree(id);
      return;
    } catch {
      // Cached key no longer works (shouldn't normally happen) — fall
      // through to a fresh prompt rather than fail silently.
      delete App.sessionCipherKeys[id];
    }
  }

  openCipherUnlockModal(id);
}

function openCipherUnlockModal(id) {
  App._pendingUnlockCipherId = id;
  const summary = App.noteSummaries[id];
  document.getElementById('cipher-unlock-name').textContent =
    (summary?.title?.trim() || 'Untitled Remnant') + ' is locked.';
  document.getElementById('cipher-unlock-passphrase').value = '';
  document.getElementById('cipher-unlock-remember').checked = false;
  document.getElementById('cipher-unlock-status').textContent = '';
  openModal('modal-cipher-unlock');
  document.getElementById('cipher-unlock-passphrase').focus();
}

async function submitCipherUnlock() {
  const id = App._pendingUnlockCipherId;
  if (!id) return;
  const statusEl = document.getElementById('cipher-unlock-status');
  const passphrase = document.getElementById('cipher-unlock-passphrase').value;
  if (!passphrase) { statusEl.textContent = 'Enter the passphrase.'; return; }

  const confirmBtn = document.getElementById('cipher-unlock-confirm-btn');
  confirmBtn.disabled = true;
  statusEl.style.color = 'var(--muted)';
  statusEl.textContent = 'Deriving key…';

  // This try/catch guards ONLY the actual unlock attempt (read + decrypt).
  // Deliberately narrow: a rendering hiccup AFTER a successful unlock must
  // never be mischaracterized as a wrong passphrase or a generic unlock
  // failure — that would be confusing to debug and, worse, could mask a
  // real problem behind a misleading "Incorrect passphrase" message.
  let plaintext, key;
  try {
    const note = await NotesStore.get(id);
    if (!note || !note.encrypted) throw new Error('NOT_FOUND');
    const result = await Cipher.decryptRecord(passphrase, note.encrypted);
    plaintext = result.plaintext;
    key       = result.key;
  } catch (e) {
    if (e.message === 'WRONG_PASSPHRASE') {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'Incorrect passphrase.';
    } else {
      console.error('[Remnant] Cipher unlock failed:', e);
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'Something went wrong. Please try again.';
    }
    confirmBtn.disabled = false;
    return;
  }
  confirmBtn.disabled = false;

  // Unlock succeeded — everything from here on is bookkeeping/rendering,
  // not authentication. No try/catch needed for this app's own state
  // updates; if a rendering call ever throws, that's a real bug worth
  // seeing as an uncaught error, not something to silently swallow or
  // mislabel as a failed unlock.
  App.unlockedCiphers[id] = { plaintext, key };
  if (document.getElementById('cipher-unlock-remember').checked) {
    App.sessionCipherKeys[id] = key;
  }
  closeModal('modal-cipher-unlock');
  setActiveNote(id);
  renderTabs();
  renderActiveNote();
  revealNoteInNavTree(id);
}

document.getElementById('cipher-unlock-confirm-btn')?.addEventListener('click', submitCipherUnlock);
document.getElementById('cipher-unlock-cancel-btn')?.addEventListener('click', () => closeModal('modal-cipher-unlock'));
document.getElementById('cipher-unlock-close-btn')?.addEventListener('click', () => closeModal('modal-cipher-unlock'));

// saveActiveCipher() — the Cipher equivalent of saveActiveNote(). Title
// stays plaintext (matches a Remnant; see notesStore.js header for why).
// Body is re-encrypted with a FRESH IV on every save (never reuse an IV
// with the same key — see cipher.js) using the already-derived key held
// in App.unlockedCiphers, so saving never re-runs Argon2id — only the
// initial unlock (or creation) pays that cost.
// NOTE: this currently writes through the same #note-title-input/
// #note-body-input fields a plain Remnant uses. Stage 3 replaces the
// body field with the spotlight-reveal editor; the encrypt/save path
// underneath does not change.
async function saveActiveCipher() {
  const id = App.activeNoteId;
  if (!id) return;
  const unlocked = App.unlockedCiphers[id];
  if (!unlocked) return;

  const note = await NotesStore.get(id);
  if (!note) return;

  const newTitle = document.getElementById('note-title-input').value;
  const newPlaintext = document.getElementById('note-body-input').value;

  unlocked.plaintext = newPlaintext;

  const saltBytes = (() => {
    const binary = atob(note.encrypted.salt);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  })();

  note.title     = newTitle;
  note.encrypted = await Cipher.encryptWithKey(unlocked.key, newPlaintext, saltBytes, note.encrypted.kdfParams);
  note.updatedAt = Date.now();
  await NotesStore.set(id, note);

  if (App.noteSummaries[id]) {
    App.noteSummaries[id].title     = newTitle;
    App.noteSummaries[id].updatedAt = note.updatedAt;
  }
  markDirty();
  renderTabs();
  renderNavTree();
}

let saveCipherTimer = null;
function scheduleSaveActiveCipher() {
  clearTimeout(saveCipherTimer);
  saveCipherTimer = setTimeout(saveActiveCipher, 400);
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

// ─── Books & Chapters: data operations ─────────────────────────────
// "Unfiled Notes" is deliberately NOT a Book/Chapter record — it's just
// the set of notes whose chapterId is null. See notesStore.js header.

function generateId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// nextOrder(siblings) — siblings is an array of records that already carry
// an `order` field. New items get appended to the end of their container.
function nextOrder(siblings) {
  if (!siblings.length) return 0;
  return Math.max(...siblings.map(s => s.order || 0)) + 1;
}

async function createBook(name) {
  const id = generateId('b');
  const existingBooks = Object.values(App.books);
  const book = {
    id, name: name || 'Untitled Corpus', description: '',
    chapterIds: [], order: nextOrder(existingBooks),
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  await NotesStore.setBook(id, book);
  App.books[id] = book;
  setBookExpanded(id, true); // a freshly created corpus opens expanded — it's empty, show the "+ New Scroll" row right away
  markDirty();
  renderNavTree();
  return id;
}

async function createChapter(bookId, name) {
  const book = App.books[bookId];
  if (!book) return null;
  const id = generateId('c');
  const existingChapters = Object.values(App.chapters).filter(c => c.bookId === bookId);
  const chapter = {
    id, bookId, name: name || 'Untitled Scroll', description: '',
    noteIds: [], order: nextOrder(existingChapters),
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  await NotesStore.setChapter(id, chapter);
  App.chapters[id] = chapter;
  book.chapterIds.push(id);
  book.updatedAt = Date.now();
  await NotesStore.setBook(bookId, book);
  setChapterExpanded(id, true);
  markDirty();
  renderNavTree();
  return id;
}

// renameBook/renameChapter — small, focused setters rather than a generic
// "update" function, since name is the one field the nav UI edits inline.
async function renameBook(id, name) {
  const book = App.books[id];
  if (!book) return;
  book.name = name;
  book.updatedAt = Date.now();
  await NotesStore.setBook(id, book);
  markDirty();
  renderNavTree();
}

async function renameChapter(id, name) {
  const chapter = App.chapters[id];
  if (!chapter) return;
  chapter.name = name;
  chapter.updatedAt = Date.now();
  await NotesStore.setChapter(id, chapter);
  markDirty();
  renderNavTree();
}

// deleteBook/deleteChapter — deleting a container does NOT delete its
// contents; chapters/notes inside become unfiled-equivalent (chapterId/
// bookId cleared) rather than being destroyed. Silent data loss on a
// structural delete would be a much worse failure mode than "where did
// my chapter go — oh, it's back in Unfiled."
async function deleteChapter(id) {
  const chapter = App.chapters[id];
  if (!chapter) return;
  const book = App.books[chapter.bookId];

  // Orphan this chapter's notes back to unfiled rather than deleting them.
  const affectedNotes = Object.values(App.noteSummaries).filter(n => n.chapterId === id);
  for (const n of affectedNotes) {
    const note = await NotesStore.get(n.id);
    if (note) {
      note.chapterId = null;
      note.updatedAt = Date.now();
      await NotesStore.set(n.id, note);
      App.noteSummaries[n.id] = { ...App.noteSummaries[n.id], chapterId: null };
      if (App.openNotes[n.id]) App.openNotes[n.id].chapterId = null;
    }
  }

  await NotesStore.deleteChapter(id);
  delete App.chapters[id];
  if (book) {
    book.chapterIds = book.chapterIds.filter(cid => cid !== id);
    book.updatedAt = Date.now();
    await NotesStore.setBook(book.id, book);
  }
  markDirty();
  renderNavTree();
  renderTabs(); // tab tooltips may reference the deleted chapter
}

async function deleteBook(id) {
  const book = App.books[id];
  if (!book) return;
  // Orphan every chapter's notes, then remove the chapters, then the book.
  for (const chapterId of [...book.chapterIds]) {
    await deleteChapter(chapterId); // handles note-orphaning per chapter
  }
  await NotesStore.deleteBook(id);
  delete App.books[id];
  markDirty();
  renderNavTree();
}

// moveNoteToChapter(noteId, chapterId|null, targetIndex) — the core of
// drag-and-drop for notes. chapterId null means "move to Unfiled."
async function moveNoteToChapter(noteId, chapterId, targetOrder) {
  const note = await NotesStore.get(noteId);
  if (!note) return;
  note.chapterId = chapterId;
  note.order = targetOrder;
  note.updatedAt = Date.now();
  await NotesStore.set(noteId, note);
  App.noteSummaries[noteId] = { id: noteId, title: note.title, chapterId, order: targetOrder, updatedAt: note.updatedAt };
  if (App.openNotes[noteId]) { App.openNotes[noteId].chapterId = chapterId; App.openNotes[noteId].order = targetOrder; }
  markDirty();
}

async function moveChapterToBook(chapterId, bookId, targetOrder) {
  const chapter = App.chapters[chapterId];
  if (!chapter) return;
  const oldBook = App.books[chapter.bookId];
  if (oldBook) {
    oldBook.chapterIds = oldBook.chapterIds.filter(id => id !== chapterId);
    await NotesStore.setBook(oldBook.id, oldBook);
  }
  chapter.bookId = bookId;
  chapter.order  = targetOrder;
  chapter.updatedAt = Date.now();
  await NotesStore.setChapter(chapterId, chapter);
  const newBook = App.books[bookId];
  if (newBook && !newBook.chapterIds.includes(chapterId)) {
    newBook.chapterIds.push(chapterId);
    await NotesStore.setBook(bookId, newBook);
  }
  markDirty();
}

async function reorderBook(bookId, targetOrder) {
  const book = App.books[bookId];
  if (!book) return;
  book.order = targetOrder;
  book.updatedAt = Date.now();
  await NotesStore.setBook(bookId, book);
  markDirty();
}

// ─── Nav panel: expand/collapse + open/closed + pinned state ───────
//
// Three concepts, deliberately kept distinct:
//   isPanelOpen()   — is the panel currently visible at all
//   isPinned()      — the user's STORED preference (pinned vs pop-out)
//   isPinnedActive() — whether pinned behavior actually applies right now,
//                      i.e. the stored preference AND the viewport is wide
//                      enough to honor it. Below NAV_PIN_MIN_WIDTH, pinned
//                      mode is overridden back to pop-out at runtime —
//                      WITHOUT mutating the stored preference. A Galaxy
//                      Fold 5 user gets pop-out on the ~370px outer screen
//                      and their real pinned layout back the instant they
//                      unfold to the wider inner screen; nothing about
//                      their saved choice is touched by the override.
//
// Pin and open are LINKED (not independent): pinning always opens the
// panel; unpinning always closes it. There's no "pinned but closed" state
// to represent, so none is modeled.
//
// Breakpoint rationale: 860px matches the documented Galaxy Fold 5 /
// tablet breakpoint already established in the Refectory stylesheet this
// auth/layout pattern was ported from — fold-open width is exactly the
// case where claiming a further 300px for a pinned panel starts being
// genuinely cramped rather than merely cozy.
const NAV_PIN_MIN_WIDTH = 860;

function isPanelOpen()  { return !!App.data.navState.panelOpen; }
function isPinned()     { return !!App.data.navState.pinned; }
function isPinnedActive() { return isPinned() && window.innerWidth >= NAV_PIN_MIN_WIDTH; }

function isBookExpanded(id)    { return App.data.navState.expandedBookIds.includes(id); }
function isChapterExpanded(id) { return App.data.navState.expandedChapterIds.includes(id); }

function setPanelOpen(open) {
  App.data.navState.panelOpen = open;
  saveLocal();
  applyNavPanelDOMState();
}

function setPinned(pinned) {
  App.data.navState.pinned = pinned;
  // Linked behavior, per design: pinning opens, unpinning closes.
  App.data.navState.panelOpen = pinned;
  markDirty(); // pin preference is KV-synced, unlike pure ephemeral UI state
  applyNavPanelDOMState();
}

// applyNavPanelDOMState() — the single place that reconciles stored state
// + current viewport width into actual DOM classes. CSS can't read JS
// state directly, so this is the bridge: it runs on every state change
// AND on window resize, so crossing the NAV_PIN_MIN_WIDTH threshold while
// the page is open (e.g. unfolding a Fold 5) re-evaluates immediately
// rather than only at next load.
function applyNavPanelDOMState() {
  const panel = document.getElementById('nav-panel');
  const scrim = document.getElementById('nav-panel-scrim');
  const layout = document.querySelector('.main-layout');
  if (!panel || !layout) return;

  const open = isPanelOpen();
  const pinnedActive = isPinnedActive();

  panel.classList.toggle('open', open);
  layout.classList.toggle('nav-pinned', open && pinnedActive);
  // Scrim only makes sense in pop-out mode — pinned mode doesn't cover
  // anything, so there's nothing to dismiss-by-clicking-outside.
  if (scrim) scrim.style.display = (open && !pinnedActive) ? '' : 'none';

  const pinBtn = document.getElementById('nav-pin-btn');
  if (pinBtn) {
    pinBtn.classList.toggle('active', isPinned());
    pinBtn.title = isPinned() ? 'Unpin panel' : 'Pin panel';
  }
}

window.addEventListener('resize', applyNavPanelDOMState);

function setBookExpanded(id, expanded) {
  const list = App.data.navState.expandedBookIds;
  const i = list.indexOf(id);
  if (expanded && i === -1) list.push(id);
  if (!expanded && i !== -1) list.splice(i, 1);
  saveLocal();
}

function setChapterExpanded(id, expanded) {
  const list = App.data.navState.expandedChapterIds;
  const i = list.indexOf(id);
  if (expanded && i === -1) list.push(id);
  if (!expanded && i !== -1) list.splice(i, 1);
  saveLocal();
}

document.getElementById('nav-toggle-btn')?.addEventListener('click', () => {
  // The hamburger only makes sense as an independent open/close control
  // when NOT pinned — when pinned, the panel's presence is governed by
  // the pin state itself, so toggling "open" while pinned would just be
  // immediately fighting the linked pinned→open invariant.
  if (isPinned()) return;
  setPanelOpen(!isPanelOpen());
});
document.getElementById('nav-panel-scrim')?.addEventListener('click', () => setPanelOpen(false));
document.getElementById('nav-pin-btn')?.addEventListener('click', () => setPinned(!isPinned()));

document.getElementById('nav-new-book-btn')?.addEventListener('click', async () => {
  const id = await createBook('Untitled Corpus');
  // Immediately offer to rename — a brand new corpus with no name yet is
  // the one moment an inline-rename prompt is welcome rather than intrusive.
  startInlineRename('book', id);
});

// ─── Loading the tree from IndexedDB ───────────────────────────────

// loadNavData() — populates App.books/App.chapters/App.noteSummaries from
// IndexedDB. Note summaries deliberately exclude `content` — the tree only
// ever needs id/title/chapterId/order/updatedAt to render, and pulling full
// note bodies into memory for every note just to draw the tree would scale
// badly for anyone with a large note collection.
async function loadNavData() {
  const [books, chapters, allNotes] = await Promise.all([
    NotesStore.getAllBooks(),
    NotesStore.getAllChapters(),
    NotesStore.getAll(),
  ]);
  App.books    = books;
  App.chapters = chapters;
  App.noteSummaries = {};
  for (const [id, note] of Object.entries(allNotes)) {
    App.noteSummaries[id] = {
      id, title: note.title, chapterId: note.chapterId ?? null,
      order: note.order || 0, updatedAt: note.updatedAt || 0,
      type: note.type || null, // null = plain Remnant; 'cipher' = Cipher
    };
  }
}

// ─── Inline rename (used for both new-book and new-chapter naming) ─

function startInlineRename(kind, id) {
  // Deferred to renderNavTree: after the next render, find the row's label
  // and swap it for a text input. Simpler than threading rename-mode state
  // through the render function itself for what's a rare, short-lived UI mode.
  App._pendingRename = { kind, id };
  renderNavTree();
}

function commitInlineRename(kind, id, value) {
  const name = (value || '').trim() || (kind === 'book' ? 'Untitled Corpus' : 'Untitled Scroll');
  if (kind === 'book') renameBook(id, name);
  else renameChapter(id, name);
}

// ─── Rendering ──────────────────────────────────────────────────────

// notePath(noteId) — returns "Corpus Name / Scroll Name" for a filed
// remnant, or "Loose Remnants" for one that isn't. Used for the tab
// hover tooltip.
function notePath(noteId) {
  const summary = App.noteSummaries[noteId];
  if (!summary || !summary.chapterId) return 'Loose Remnants';
  const chapter = App.chapters[summary.chapterId];
  if (!chapter) return 'Loose Remnants';
  const book = App.books[chapter.bookId];
  return book ? `${book.name} / ${chapter.name}` : chapter.name;
}

function noteTabLabel(note) {
  const t = (note?.title || '').trim();
  return t || 'Untitled Remnant';
}

function renderTabs() {
  const bar = document.getElementById('tab-bar');
  bar.innerHTML = '';

  App.data.tabState.openIds.forEach(id => {
    const note = App.openNotes[id];
    if (!note) return;
    const tab = document.createElement('div');
    tab.className = 'tab' + (id === App.activeNoteId ? ' active' : '');
    tab.title = notePath(id); // hover tooltip: which corpus/scroll this remnant lives in
    tab.innerHTML = `<span class="tab-label"></span><span class="tab-close">&times;</span>`;
    tab.querySelector('.tab-label').textContent = noteTabLabel(note);
    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) {
        closeTab(id);
      } else {
        setActiveNote(id);
        renderTabs();
        revealNoteInNavTree(id); // clicking a tab also expands/highlights its spot in the nav
      }
    });
    bar.appendChild(tab);
  });

  // Cipher tabs render after Remnant tabs, same combined bar. Pulled from
  // App.openCipherIds — never App.data.tabState — so this list is purely
  // in-memory for this session, matching everything else about how
  // Cipher tab state stays outside what gets persisted/synced.
  App.openCipherIds.forEach(id => {
    const summary = App.noteSummaries[id];
    if (!summary) return;
    const tab = document.createElement('div');
    tab.className = 'tab tab-cipher' + (id === App.activeNoteId ? ' active' : '');
    tab.title = notePath(id);
    tab.innerHTML = `<span class="tab-cipher-lock" title="Cipher">🔒</span><span class="tab-label"></span><span class="tab-close">&times;</span>`;
    tab.querySelector('.tab-label').textContent = summary.title?.trim() || 'Untitled Remnant';
    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) {
        closeTab(id);
      } else {
        openCipherInTab(id); // re-checks unlocked/session-cache state, not just setActiveNote
        renderTabs();
        revealNoteInNavTree(id);
      }
    });
    bar.appendChild(tab);
  });

  const newTab = document.createElement('div');
  newTab.className = 'tab-new';
  newTab.textContent = '+';
  newTab.title = 'New remnant';
  newTab.addEventListener('click', () => createNote());
  bar.appendChild(newTab);
}

// ─── Nav tree rendering ─────────────────────────────────────────────
//
// Tree shape (user-facing terms — internal identifiers/classes/dataset
// values stay 'book'/'chapter'/'note' throughout the codebase; only
// display copy uses Corpus/Scroll/Remnant):
//   Corpus (sorted by order)
//     "+ New Scroll" row — always first, pinned, regardless of how many
//      scrolls already exist (so it's never something you have to scroll
//      past everything else to find)
//     Scroll (sorted by order)
//       "+ New Remnant" row — always first under an expanded scroll, same
//        pinning rationale as New Scroll
//       Remnant (sorted by order)
//   "Loose Remnants" — always rendered, even when empty, so it reads as
//    a real, permanent part of the structure rather than a vanishing edge case

function sortByOrder(arr) {
  return [...arr].sort((a, b) => (a.order || 0) - (b.order || 0));
}

function renderNavTree() {
  const treeEl = document.getElementById('nav-tree');
  treeEl.innerHTML = '';

  const books = sortByOrder(Object.values(App.books));
  books.forEach(book => treeEl.appendChild(buildBookRow(book)));

  // Unfiled Notes — a view over notes with chapterId === null, not a
  // Book/Chapter record. Always rendered, even with zero notes in it.
  treeEl.appendChild(buildUnfiledSection());
}

function buildBookRow(book) {
  const wrap = document.createElement('div');
  wrap.className = 'nav-book-wrap';

  const row = document.createElement('div');
  row.className = 'nav-row nav-row-book' + (App._pendingRename?.kind === 'book' && App._pendingRename.id === book.id ? '' : '');
  row.dataset.kind = 'book';
  row.dataset.id = book.id;
  row.draggable = true;

  const expanded = isBookExpanded(book.id);
  row.innerHTML = `
    <span class="nav-row-caret${expanded ? ' expanded' : ''}">▸</span>
    <span class="nav-row-label"></span>
    <span class="nav-row-actions">
      <span class="nav-row-action-btn" data-action="delete-book" title="Delete corpus">🗑</span>
    </span>
  `;

  if (App._pendingRename?.kind === 'book' && App._pendingRename.id === book.id) {
    renderInlineRenameInput(row, 'book', book.id, book.name);
  } else {
    row.querySelector('.nav-row-label').textContent = book.name;
  }

  row.addEventListener('click', (e) => {
    if (e.target.closest('[data-action]')) return; // handled separately below
    if (App._pendingRename) return; // don't toggle while renaming
    setBookExpanded(book.id, !expanded);
    renderNavTree();
  });

  row.querySelector('[data-action="delete-book"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm(`Delete "${book.name}"? Scrolls and remnants inside will move to Loose Remnants.`)) {
      deleteBook(book.id);
    }
  });

  row.addEventListener('dblclick', () => startInlineRename('book', book.id));

  attachDragHandlers(row, { kind: 'book', id: book.id, containerKind: 'root', containerId: null });

  wrap.appendChild(row);

  if (expanded) {
    const childWrap = document.createElement('div');
    childWrap.className = 'nav-book-children';

    // Pinned "+ New Scroll" row — always first, before any real scroll.
    const addRow = document.createElement('div');
    addRow.className = 'nav-row nav-row-chapter nav-row-add';
    addRow.innerHTML = `<span class="nav-row-caret placeholder">·</span><span class="nav-row-label">+ New Scroll</span>`;
    addRow.addEventListener('click', async () => {
      const id = await createChapter(book.id, 'Untitled Scroll');
      if (id) startInlineRename('chapter', id);
    });
    childWrap.appendChild(addRow);

    const chapters = sortByOrder(Object.values(App.chapters).filter(c => c.bookId === book.id));
    chapters.forEach(chapter => childWrap.appendChild(buildChapterRow(chapter)));

    attachContainerDropHandlers(childWrap, { kind: 'chapter-list', bookId: book.id });
    wrap.appendChild(childWrap);
  }

  return wrap;
}

function buildChapterRow(chapter) {
  const wrap = document.createElement('div');
  wrap.className = 'nav-chapter-wrap';

  const row = document.createElement('div');
  row.className = 'nav-row nav-row-chapter';
  row.dataset.kind = 'chapter';
  row.dataset.id = chapter.id;
  row.draggable = true;

  const expanded = isChapterExpanded(chapter.id);
  row.innerHTML = `
    <span class="nav-row-caret${expanded ? ' expanded' : ''}">▸</span>
    <span class="nav-row-label"></span>
    <span class="nav-row-actions">
      <span class="nav-row-action-btn" data-action="delete-chapter" title="Delete scroll">🗑</span>
    </span>
  `;

  if (App._pendingRename?.kind === 'chapter' && App._pendingRename.id === chapter.id) {
    renderInlineRenameInput(row, 'chapter', chapter.id, chapter.name);
  } else {
    row.querySelector('.nav-row-label').textContent = chapter.name;
  }

  row.addEventListener('click', (e) => {
    if (e.target.closest('[data-action]')) return;
    if (App._pendingRename) return;
    setChapterExpanded(chapter.id, !expanded);
    renderNavTree();
  });

  row.querySelector('[data-action="delete-chapter"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm(`Delete "${chapter.name}"? Remnants inside will move to Loose Remnants.`)) {
      deleteChapter(chapter.id);
    }
  });

  row.addEventListener('dblclick', () => startInlineRename('chapter', chapter.id));

  attachDragHandlers(row, { kind: 'chapter', id: chapter.id, containerKind: 'book', containerId: chapter.bookId });

  wrap.appendChild(row);

  if (expanded) {
    const childWrap = document.createElement('div');
    childWrap.className = 'nav-chapter-children';

    // Pinned "+ New Remnant" row — always first under an expanded scroll.
    const addRow = document.createElement('div');
    addRow.className = 'nav-row nav-row-note nav-row-add';
    addRow.innerHTML = `<span class="nav-row-caret placeholder">·</span><span class="nav-row-label">+ New Remnant</span>`;
    addRow.addEventListener('click', () => createNote(chapter.id));
    childWrap.appendChild(addRow);

    // Pinned "+ New Cipher" row — second, right after New Remnant.
    const addCipherRow = document.createElement('div');
    addCipherRow.className = 'nav-row nav-row-note nav-row-add';
    addCipherRow.innerHTML = `<span class="nav-row-caret placeholder">·</span><span class="nav-row-label">+ New Cipher</span>`;
    addCipherRow.addEventListener('click', () => openCipherCreateModal(chapter.id));
    childWrap.appendChild(addCipherRow);

    const notes = sortByOrder(Object.values(App.noteSummaries).filter(n => n.chapterId === chapter.id));
    if (!notes.length) {
      const hint = document.createElement('div');
      hint.className = 'nav-empty-hint';
      hint.textContent = 'No remnants yet';
      childWrap.appendChild(hint);
    }
    notes.forEach(note => childWrap.appendChild(buildNoteRow(note)));

    attachContainerDropHandlers(childWrap, { kind: 'note-list', chapterId: chapter.id });
    wrap.appendChild(childWrap);
  }

  return wrap;
}

function buildNoteRow(noteSummary) {
  const isCipher = isCipherNote(noteSummary);
  const row = document.createElement('div');
  row.className = 'nav-row nav-row-note' + (isCipher ? ' nav-row-cipher' : '') + (noteSummary.id === App.activeNoteId ? ' active' : '');
  row.dataset.kind = 'note';
  row.dataset.id = noteSummary.id;
  row.draggable = true;
  row.innerHTML = `
    <span class="nav-row-caret placeholder">·</span>
    <span class="nav-row-label"></span>
    ${isCipher ? '<span class="nav-row-cipher-badge" title="Cipher">🔒</span>' : ''}
  `;
  row.querySelector('.nav-row-label').textContent = noteSummary.title?.trim() || 'Untitled Remnant';
  row.addEventListener('click', () => {
    if (isCipher) openCipherInTab(noteSummary.id);
    else openNoteInTab(noteSummary.id);
  });

  attachDragHandlers(row, {
    kind: 'note', id: noteSummary.id,
    containerKind: 'chapter', containerId: noteSummary.chapterId,
  });

  return row;
}

function buildUnfiledSection() {
  const wrap = document.createElement('div');
  wrap.className = 'nav-unfiled-wrap';

  const header = document.createElement('div');
  header.className = 'nav-row nav-row-unfiled-header';
  header.innerHTML = `<span class="nav-row-label">Loose Remnants</span>`;
  wrap.appendChild(header);

  const childWrap = document.createElement('div');
  childWrap.className = 'nav-unfiled-children';

  const notes = sortByOrder(Object.values(App.noteSummaries).filter(n => !n.chapterId));
  if (!notes.length) {
    const hint = document.createElement('div');
    hint.className = 'nav-empty-hint';
    hint.textContent = 'Nothing unfiled';
    childWrap.appendChild(hint);
  }
  notes.forEach(note => childWrap.appendChild(buildNoteRow(note)));

  attachContainerDropHandlers(childWrap, { kind: 'note-list', chapterId: null });
  wrap.appendChild(childWrap);
  return wrap;
}

// renderInlineRenameInput(row, kind, id, currentName) — swaps a row's label
// span for a text input, focused and selected, committing on blur or Enter,
// cancelling on Escape. Used for both brand-new books/chapters (auto-
// triggered) and double-click-to-rename on existing ones.
function renderInlineRenameInput(row, kind, id, currentName) {
  const labelEl = row.querySelector('.nav-row-label');
  const input = document.createElement('input');
  input.className = 'input nav-rename-input';
  input.value = currentName;
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    App._pendingRename = null;
    commitInlineRename(kind, id, input.value);
  };
  const cancel = () => {
    if (committed) return;
    committed = true;
    App._pendingRename = null;
    renderNavTree();
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
}

// revealNoteInNavTree(noteId) — expands the book/chapter containing this
// note (if any) and highlights its row. Called whenever a note becomes the
// active tab, whether by clicking an existing tab or opening a new one,
// so the nav panel always shows "you are here."
function revealNoteInNavTree(noteId) {
  const summary = App.noteSummaries[noteId];
  if (summary?.chapterId) {
    const chapter = App.chapters[summary.chapterId];
    if (chapter) {
      setChapterExpanded(chapter.id, true);
      setBookExpanded(chapter.bookId, true);
    }
  }
  renderNavTree();
  // Scroll the now-highlighted row into view if the panel is open.
  requestAnimationFrame(() => {
    document.querySelector(`.nav-row-note.active`)?.scrollIntoView({ block: 'nearest' });
  });
}

// ─── Drag and drop ──────────────────────────────────────────────────
//
// Three draggable kinds (book, chapter, note), each constrained to valid
// targets only:
//   book    → reorder among other books (root level only)
//   chapter → reorder within its book, OR move to a different book
//   note    → reorder within its chapter/Unfiled, OR move to a different
//             chapter or to/from Unfiled
//
// Two drop affordances per row, chosen by cursor position within the row:
//   top third / bottom third → insertion line (reorder before/after this row)
//   middle third             → "drop into" highlight (move INTO this row's
//                               container — only valid when the row is a
//                               container itself: a book accepts a chapter
//                               dropped on it, a chapter accepts a note)
//
// Self-drop and drop-into-own-descendant are rejected by construction:
// canDropOn() below is the single gate every drop passes through.

function attachDragHandlers(rowEl, meta) {
  rowEl.addEventListener('dragstart', (e) => {
    App.drag = meta;
    rowEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox requires setData to be called for drag to initiate at all.
    e.dataTransfer.setData('text/plain', meta.id);
  });
  rowEl.addEventListener('dragend', () => {
    rowEl.classList.remove('dragging');
    clearDropIndicators();
    App.drag = null;
  });

  rowEl.addEventListener('dragover', (e) => {
    if (!App.drag) return;
    const target = { kind: rowEl.dataset.kind, id: rowEl.dataset.id };
    const zone = dropZoneFor(e, rowEl, App.drag, target);
    if (!zone) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    showDropIndicator(rowEl, zone);
  });

  rowEl.addEventListener('dragleave', () => {
    rowEl.classList.remove('drop-line-above', 'drop-line-below', 'drop-target-into');
  });

  rowEl.addEventListener('drop', (e) => {
    if (!App.drag) return;
    const target = { kind: rowEl.dataset.kind, id: rowEl.dataset.id };
    const zone = dropZoneFor(e, rowEl, App.drag, target);
    if (!zone) return;
    e.preventDefault();
    e.stopPropagation();
    performDrop(App.drag, target, zone);
    clearDropIndicators();
  });
}

// attachContainerDropHandlers — lets a note/chapter be dropped into an
// otherwise-empty (or end-of-list) container, not just onto a sibling row.
// Without this, the only way to move a note into a chapter with zero notes
// already in it would be... nowhere to drop it.
function attachContainerDropHandlers(containerEl, containerMeta) {
  containerEl.addEventListener('dragover', (e) => {
    if (!App.drag) return;
    if (!containerAccepts(App.drag, containerMeta)) return;
    // Only claim this if the event didn't already land on a child row
    // (rows call stopPropagation in their own drop handler, but dragover
    // bubbles, so check we're not hovering a specific row's middle/edge zones).
    if (e.target.closest('.nav-row')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    containerEl.classList.add('drop-target-into');
  });
  containerEl.addEventListener('dragleave', (e) => {
    if (e.target === containerEl) containerEl.classList.remove('drop-target-into');
  });
  containerEl.addEventListener('drop', (e) => {
    if (!App.drag) return;
    if (e.target.closest('.nav-row')) return; // a row already handled it
    if (!containerAccepts(App.drag, containerMeta)) return;
    e.preventDefault();
    containerEl.classList.remove('drop-target-into');
    performContainerDrop(App.drag, containerMeta);
  });
}

function containerAccepts(drag, containerMeta) {
  if (containerMeta.kind === 'chapter-list') return drag.kind === 'chapter' || false; // chapters only reorder within their own book's list via row drops; cross-book chapter moves land on the BOOK row itself, not the empty list area
  if (containerMeta.kind === 'note-list')    return drag.kind === 'note';
  return false;
}

async function performContainerDrop(drag, containerMeta) {
  if (containerMeta.kind === 'note-list' && drag.kind === 'note') {
    const siblings = Object.values(App.noteSummaries).filter(n => n.chapterId === containerMeta.chapterId && n.id !== drag.id);
    const order = nextOrder(siblings);
    await moveNoteToChapter(drag.id, containerMeta.chapterId, order);
    renderNavTree();
    renderTabs();
  }
}

// dropZoneFor(e, rowEl, drag, target) — returns 'above' | 'below' | 'into'
// | null (null = not a valid drop here at all). Position within the row
// determines above/below vs into; canDropOn() determines validity.
function dropZoneFor(e, rowEl, drag, target) {
  if (!canDropOn(drag, target)) return null;
  const rect = rowEl.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const third = rect.height / 3;
  // "Into" only makes sense when the target is a container the dragged
  // item could actually live inside (a chapter for a note, a book for a
  // chapter). Same-kind drags (note-on-note, chapter-on-chapter, book-on-
  // book) are always reorder-only — there's no "into" for a sibling.
  const intoValid = (drag.kind === 'note' && target.kind === 'chapter')
                  || (drag.kind === 'chapter' && target.kind === 'book');
  if (intoValid && y > third && y < third * 2) return 'into';
  return y < rect.height / 2 ? 'above' : 'below';
}

// canDropOn(drag, target) — the single validity gate. Rejects self-drop,
// drop-into-own-descendant, and cross-kind drops that don't make sense
// (e.g. a book dropped onto a note).
function canDropOn(drag, target) {
  if (drag.id === target.id && drag.kind === target.kind) return false; // no self-drop

  if (drag.kind === 'book')    return target.kind === 'book';
  if (drag.kind === 'chapter') return target.kind === 'chapter' || target.kind === 'book';
  if (drag.kind === 'note')    return target.kind === 'note' || target.kind === 'chapter';
  return false;
}

function showDropIndicator(rowEl, zone) {
  clearDropIndicators();
  if (zone === 'into')  rowEl.classList.add('drop-target-into');
  if (zone === 'above') rowEl.classList.add('drop-line-above');
  if (zone === 'below') rowEl.classList.add('drop-line-below');
}

function clearDropIndicators() {
  document.querySelectorAll('.drop-line-above, .drop-line-below, .drop-target-into')
    .forEach(el => el.classList.remove('drop-line-above', 'drop-line-below', 'drop-target-into'));
}

// performDrop(drag, target, zone) — the actual data mutation once a valid
// drop is confirmed. Reorders use the target's siblings' order values to
// compute a new order for the dragged item; moves additionally change the
// dragged item's parent (chapterId/bookId).
async function performDrop(drag, target, zone) {
  if (drag.kind === 'note')    return performNoteDrop(drag, target, zone);
  if (drag.kind === 'chapter') return performChapterDrop(drag, target, zone);
  if (drag.kind === 'book')    return performBookDrop(drag, target, zone);
}

// computeInsertOrder(siblings, targetId, zone) — siblings is the full
// sorted sibling list of the container the item is landing in (NOT
// excluding the target), targetId is the row being dropped on, zone is
// 'above'/'below'. Returns a numeric order placing the dragged item
// adjacent to the target on the requested side, leaving room between
// existing siblings rather than requiring a full renumber on every drag.
function computeInsertOrder(siblings, targetId, zone) {
  const sorted = sortByOrder(siblings);
  const idx = sorted.findIndex(s => s.id === targetId);
  if (idx === -1) return nextOrder(sorted);
  const targetOrder = sorted[idx].order || 0;
  if (zone === 'above') {
    const prevOrder = idx > 0 ? (sorted[idx - 1].order || 0) : targetOrder - 2;
    return (prevOrder + targetOrder) / 2;
  } else {
    const nextSib = sorted[idx + 1];
    const afterOrder = nextSib ? (nextSib.order || 0) : targetOrder + 2;
    return (targetOrder + afterOrder) / 2;
  }
}

async function performNoteDrop(drag, target, zone) {
  if (target.kind === 'chapter' && zone === 'into') {
    const siblings = Object.values(App.noteSummaries).filter(n => n.chapterId === target.id);
    await moveNoteToChapter(drag.id, target.id, nextOrder(siblings));
  } else if (target.kind === 'note') {
    const targetSummary = App.noteSummaries[target.id];
    const siblings = Object.values(App.noteSummaries).filter(n => n.chapterId === targetSummary.chapterId);
    const order = computeInsertOrder(siblings, target.id, zone);
    await moveNoteToChapter(drag.id, targetSummary.chapterId, order);
  } else {
    return;
  }
  renderNavTree();
  renderTabs();
}

async function performChapterDrop(drag, target, zone) {
  if (target.kind === 'book' && zone === 'into') {
    const siblings = Object.values(App.chapters).filter(c => c.bookId === target.id);
    await moveChapterToBook(drag.id, target.id, nextOrder(siblings));
  } else if (target.kind === 'chapter') {
    const targetChapter = App.chapters[target.id];
    const siblings = Object.values(App.chapters).filter(c => c.bookId === targetChapter.bookId);
    const order = computeInsertOrder(siblings, target.id, zone);
    await moveChapterToBook(drag.id, targetChapter.bookId, order);
  } else {
    return;
  }
  renderNavTree();
}

async function performBookDrop(drag, target, zone) {
  if (target.kind !== 'book') return;
  const siblings = Object.values(App.books);
  const order = computeInsertOrder(siblings, target.id, zone);
  await reorderBook(drag.id, order);
  renderNavTree();
}

function renderActiveNote() {
  const titleEl = document.getElementById('note-title-input');
  const bodyEl  = document.getElementById('note-body-input');
  const id      = App.activeNoteId;
  const summary = id ? App.noteSummaries[id] : null;

  if (!id || !summary) {
    titleEl.value = '';
    bodyEl.value  = '';
    titleEl.disabled = true;
    bodyEl.disabled  = true;
    bodyEl.placeholder = 'Open a remnant, or click "+" to start a new one…';
    return;
  }

  if (isCipherNote(summary)) {
    const unlocked = App.unlockedCiphers[id];
    if (!unlocked) {
      // Shouldn't normally happen — a Cipher only becomes active via
      // openCipherInTab, which always unlocks (or prompts) first. Guard
      // anyway rather than show a stale/wrong body.
      titleEl.value = summary.title || '';
      titleEl.disabled = false;
      bodyEl.value = '';
      bodyEl.disabled = true;
      bodyEl.placeholder = 'Locked.';
      return;
    }
    titleEl.disabled = false;
    bodyEl.disabled  = false;
    // Stage 2: plain decrypted text, no spotlight-reveal disguise yet —
    // that's stage 3. The encrypt/decrypt/save plumbing underneath is
    // already final; only this rendering step changes later.
    bodyEl.placeholder = 'Start writing…';
    titleEl.value = summary.title || '';
    bodyEl.value  = unlocked.plaintext || '';
    return;
  }

  const note = App.openNotes[id];
  if (!note) {
    titleEl.value = '';
    bodyEl.value  = '';
    titleEl.disabled = true;
    bodyEl.disabled  = true;
    bodyEl.placeholder = 'Open a remnant, or click "+" to start a new one…';
    return;
  }
  titleEl.disabled = false;
  bodyEl.disabled  = false;
  bodyEl.placeholder = 'Start writing…';
  titleEl.value = note.title || '';
  bodyEl.value  = note.content || '';
}

function scheduleSaveActive() {
  if (isCipherNote(App.noteSummaries[App.activeNoteId])) scheduleSaveActiveCipher();
  else scheduleSaveActiveNote();
}
document.getElementById('note-title-input')?.addEventListener('input', scheduleSaveActive);
document.getElementById('note-body-input')?.addEventListener('input', scheduleSaveActive);
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

  await loadNavData();
  renderNavTree();
  applyNavPanelDOMState();

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

// Terminology modal — purely informational, no state to save on close.
document.getElementById('terminology-link-btn')?.addEventListener('click', () => openModal('modal-terminology'));
document.getElementById('terminology-close-btn')?.addEventListener('click', () => closeModal('modal-terminology'));

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
  // If the incoming data carries notes/structure/scratchpad (it came straight
  // off a KV pull elsewhere in auth.js, e.g. handleGoogleCredential or the
  // load-existing-token flow), route that content into IndexedDB now rather
  // than leaving it stranded on the plain metadata object.
  const { notes, structure, scratchpad, ...metadata } = data || {};
  App.data = mergeData(metadata);
  if (notes || structure || scratchpad) {
    await Promise.all([
      notes ? NotesStore.replaceAll(notes) : Promise.resolve(),
      structure?.books    ? NotesStore.replaceAllBooks(structure.books)       : Promise.resolve(),
      structure?.chapters ? NotesStore.replaceAllChapters(structure.chapters) : Promise.resolve(),
      scratchpad ? NotesStore.setScratchpad(scratchpad.content || '') : Promise.resolve(),
    ]);
  }
  saveLocal();
  await renderAll();
  showToast(isNew ? 'Welcome to Remnant 📜' : 'Welcome back — syncing your remnants…');
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

  // First-run default: open AND pinned on wide viewports (a desktop-sized
  // window has room to spare, and a pinned tree reads as part of the
  // workspace rather than a transient overlay); closed on narrow ones (a
  // notes tool's primary space should be the page being written, especially
  // on a phone-width screen). Uses the same NAV_PIN_MIN_WIDTH threshold as
  // the runtime pinned-mode override, so the first-run choice and the
  // ongoing responsive behavior agree on what counts as "wide enough."
  // Only applied when there's no stored preference yet — a returning
  // user's explicit choice always wins over this default.
  if (!stored) {
    const wide = window.innerWidth >= NAV_PIN_MIN_WIDTH;
    App.data.navState.panelOpen = wide;
    App.data.navState.pinned    = wide;
  }

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
  // Local edits win on conflict (per-record updatedAt), same spirit as the
  // Refectory pattern, applied to notes AND structure (books/chapters)
  // across the IndexedDB/localStorage split rather than a single object.
  const tokenBeforePull = App.data.userToken;
  if (getWorkerUrl()) {
    const remote = await pullFromWorker();
    if (remote) {
      const { notes: remoteNotes, structure: remoteStructure, scratchpad: remoteScratchpad, ...metadata } = remote;

      const mergeByUpdatedAt = async (remoteObj, localObj) => {
        const merged = { ...(remoteObj || {}) };
        for (const [id, localRec] of Object.entries(localObj || {})) {
          const remoteRec = merged[id];
          if (!remoteRec || (localRec.updatedAt || 0) >= (remoteRec.updatedAt || 0)) {
            merged[id] = localRec;
          }
        }
        return merged;
      };

      const [localNotes, localBooks, localChapters] = await Promise.all([
        NotesStore.getAll(), NotesStore.getAllBooks(), NotesStore.getAllChapters(),
      ]);

      const mergedNotes    = await mergeByUpdatedAt(remoteNotes, localNotes);
      const mergedBooks    = await mergeByUpdatedAt(remoteStructure?.books, localBooks);
      const mergedChapters = await mergeByUpdatedAt(remoteStructure?.chapters, localChapters);

      App.data = mergeData(metadata);
      await Promise.all([
        NotesStore.replaceAll(mergedNotes),
        NotesStore.replaceAllBooks(mergedBooks),
        NotesStore.replaceAllChapters(mergedChapters),
      ]);

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

// Auth's guest-switch-confirm flow (showGuestSwitchConfirm in auth.js)
// only clears localStorage — it has no knowledge of IndexedDB, since the
// ported module's original host app kept all account data in one
// localStorage blob. Remnant's note/book/chapter CONTENT lives in
// IndexedDB, so without this, "switch account" would clear the guest's
// profile metadata but silently leave all their notes behind to reappear
// under the next account. Attached on the capture phase, and re-attached
// every time the wizard re-renders this screen (auth.js rebuilds the
// button fresh via innerHTML each time setupScreen runs), so this always
// fires — and finishes — before auth.js's own bubble-phase handler calls
// location.reload().
document.addEventListener('click', (e) => {
  if (e.target?.id === 'auth-btn-guest-switch-confirm') {
    NotesStore.clear(); // best-effort; not awaited — a reload is about to
                         // happen regardless, and IndexedDB writes that are
                         // in-flight when a page reloads still commit.
  }
}, true); // capture phase — runs before auth.js's bubble-phase listener

document.addEventListener('DOMContentLoaded', boot);
