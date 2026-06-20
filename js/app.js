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
  // Cipher obscured-viewer keyboard navigation: click-to-enter, arrow
  // keys move the reveal, Escape exits. Mouse movement is ignored while
  // true — a deliberately separate mode, not a temporary hover override.
  // See enterCipherKeyboardMode/exitCipherKeyboardMode.
  _cipherKeyboardMode: false,
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

  // Illuminate mode: a per-Cipher, in-memory-only toggle for showing the
  // FULL plaintext (no spotlight masking at all) instead of the usual
  // disguised/spotlight rendering. Same persistence guarantee as the rest
  // of this block — never in App.data, so it can never reach localStorage
  // or KV. Always resets to off when a Cipher's tab is closed (see
  // closeTab) — there is no "stay illuminated across a close+reopen."
  // Requires re-entering the passphrase to ENTER, even if the Cipher is
  // already unlocked — full exposure is treated as a bigger commitment
  // than spotlight viewing, deliberately, and earns its own checkpoint.
  illuminatedCipherIds: [],
  illuminateIdleTimer: null, // see scheduleIlluminateIdleTimer / clearIlluminateIdleTimer
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
    // Disguise text style for the spotlight-reveal editor: 'lorem' (looks
    // like real prose — better disguise to a glancing onlooker, but can
    // be mildly distracting to the user's own eye since it's almost-
    // readable) or 'noise' (abstract character clusters — quieter to the
    // user, slightly weaker disguise). User-selectable in settings.
    cipherDisguiseMode: 'lorem',
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
  if (App._cipherKeyboardMode && App.activeNoteId !== id) exitCipherKeyboardMode();
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
    if (App._cipherKeyboardMode && App.activeNoteId === id) exitCipherKeyboardMode();
    App.openCipherIds = App.openCipherIds.filter(x => x !== id);
    // obscureCipher flushes any pending debounced save (if this Cipher
    // is illuminated and mid-edit) BEFORE we delete its unlocked-state
    // entry below — calling it first, and awaiting it, means a save
    // started just before closing the tab still completes and writes to
    // encrypted storage, rather than being silently lost because
    // unlockedCiphers[id] was already gone by the time the flush ran.
    await obscureCipher(id);
    // Closing a Cipher tab clears its UNLOCKED state — reopening it
    // (this session or not) re-prompts, unless a session-cached key
    // exists from an explicit "remember for this session" earlier.
    delete App.unlockedCiphers[id];
  } else {
    App.data.tabState.openIds = App.data.tabState.openIds.filter(x => x !== id);
  }
  // The body field must repopulate fresh if this same id ever becomes
  // active again later (e.g. a Cipher reopened via session-cache) —
  // without this, a stale match in renderActiveNote's "already showing
  // this id, skip repopulating" check could leave the body showing
  // nothing/wrong content after a close+reopen.
  if (App._bodyShowingNoteId === id) App._bodyShowingNoteId = null;

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
  // immediately re-prompt for the passphrase we just set. Also
  // auto-ILLUMINATED (not just unlocked): the user just set this
  // passphrase moments ago, and a brand-new, empty Cipher has nothing
  // to protect yet — landing in the read-only obscured viewer with no
  // way to start typing would be a bad first moment. Every Cipher
  // opened or reopened AFTER this point goes through the normal
  // unlock-without-decrypt path; this is deliberately the one exception.
  App.unlockedCiphers[id] = { key, plaintext: '' };
  App.illuminatedCipherIds.push(id);
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
      // Prove the cached key still works by decrypting just the first
      // line — same reasoning as verifyAndDeriveKey: a wrong/stale key
      // fails on ANY line via AES-GCM's auth tag, so this is exactly as
      // conclusive as decrypting everything, without actually doing so.
      await Cipher.decryptLineWithKey(cachedKey, note.encrypted.lines[0]);
      App.unlockedCiphers[id] = { key: cachedKey, plaintext: null };
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
    (summary?.title?.trim() || 'Untitled Cipher') + ' is locked.';
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

  // This try/catch guards ONLY the actual unlock attempt. Deliberately
  // narrow: a rendering hiccup AFTER a successful unlock must never be
  // mischaracterized as a wrong passphrase or a generic unlock failure.
  //
  // Uses verifyAndDeriveKey, NOT decryptRecord — unlock now only proves
  // the passphrase is correct (by decrypting just the first line) and
  // derives a working key. It does NOT decrypt the rest of the body.
  // The document stays genuinely encrypted at rest after unlock; only
  // the line currently under the cursor gets decrypted on demand by the
  // read-only obscured viewer (see renderCipherObscuredViewer). Full-
  // body decryption is reserved for Illuminate — an explicit, separately
  // re-prompted, higher-exposure editing mode.
  let key;
  try {
    const note = await NotesStore.get(id);
    if (!note || !note.encrypted) throw new Error('NOT_FOUND');
    const result = await Cipher.verifyAndDeriveKey(passphrase, note.encrypted);
    key = result.key;
  } catch (e) {
    if (e.message === 'WRONG_PASSPHRASE') {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'Incorrect passphrase.';
    } else if (e.message === 'MALFORMED_RECORD') {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'This Cipher is in a format that can no longer be read. It cannot be unlocked — you can delete it from the Library.';
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
  // plaintext starts null — it's only ever populated by illuminateCipher,
  // and discarded again by obscureCipher. See the "Ciphers" section
  // header comment for the full reasoning on why this split exists.
  App.unlockedCiphers[id] = { key, plaintext: null };
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

  // Re-encrypts the ENTIRE line array together on every save (not a diff
  // of just the changed lines) — see cipher.js header for why this
  // tradeoff was chosen deliberately over per-line diffing.
  const newLines = newPlaintext.split('\n');
  note.title     = newTitle;
  note.encrypted = await Cipher.encryptLinesWithKey(unlocked.key, newLines, saltBytes, note.encrypted.kdfParams);
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

// ─── Disguise text generation (currently UNUSED — see note below) ──
//
// Produces ciphertext-looking gibberish, character-for-character
// matching a real token's length. Kept for a later theming pass, but
// NOT currently wired into the spotlight overlay: substituting noise
// characters of matching length does not reliably reproduce the real
// text's wrap points (confirmed empirically — span-per-word layout
// with substituted text measured a different total wrapped height than
// the real text at the same width, causing some rows to become
// unreachable). The overlay now renders the REAL text in every token
// and disguises it with CSS blur alone, which guarantees identical
// wrapping since it's literally the same string. If scrambled-character
// disguise comes back later, it should use a "mirror div" style
// technique (real text drives layout; a separate, position-matched
// element renders the substitute glyphs on top) rather than building
// independent layout from substituted text.

const NOISE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*+=/?';
function noiseToken(token) {
  let out = '';
  for (let i = 0; i < token.length; i++) {
    out += NOISE_CHARS[Math.floor(Math.random() * NOISE_CHARS.length)];
  }
  return out;
}

// ─── Illuminate / Obscure ───────────────────────────────────────────
//
// "Illuminate" shows a Cipher's FULL plaintext with no spotlight masking
// at all — useful for editing or proofreading, where seeing only one
// line at a time under the cursor is impractical. "Obscure" reverses it.
//
// This is a pure RENDERING toggle, not a re-decrypt: the plaintext is
// already sitting in App.unlockedCiphers[id].plaintext once a Cipher is
// unlocked at all, regardless of illuminate state. Illuminating doesn't
// fetch or compute anything new — it just changes how the body textarea
// is drawn. That's why entering/exiting is instant.
//
// Despite that, ENTERING illuminate mode always re-prompts for the
// passphrase, even if the Cipher is already unlocked this session —
// full exposure is treated as a bigger commitment than ordinary
// spotlight viewing, and earns its own checkpoint. The session-cache
// "remember" checkbox on the unlock modal never skips this prompt.
//
// Three independent exits, all funneled through one shared function
// (obscureCipher) so there's exactly one place that does the actual
// state cleanup:
//   1. Manual "Obscure" button click
//   2. Inactivity timeout (no typing/clicking while illuminated)
//   3. Tab/window losing visibility or focus (switching away)
// Closing the Cipher's tab ALSO always clears illuminate state (see
// closeTab) — there is no "stay illuminated across a close+reopen."

const ILLUMINATE_IDLE_MS = 3 * 60 * 1000; // 3 minutes of inactivity while illuminated

function isIlluminated(id) {
  return App.illuminatedCipherIds.includes(id);
}

function openCipherIlluminateModal() {
  const id = App.activeNoteId;
  if (!id || !isCipherNote(App.noteSummaries[id])) return;
  App._pendingIlluminateCipherId = id;
  document.getElementById('cipher-illuminate-passphrase').value = '';
  document.getElementById('cipher-illuminate-status').textContent = '';
  openModal('modal-cipher-illuminate');
  document.getElementById('cipher-illuminate-passphrase').focus();
}

async function submitCipherIlluminate() {
  const id = App._pendingIlluminateCipherId;
  if (!id) return;
  const statusEl = document.getElementById('cipher-illuminate-status');
  const passphrase = document.getElementById('cipher-illuminate-passphrase').value;
  if (!passphrase) { statusEl.textContent = 'Enter the passphrase.'; return; }

  const confirmBtn = document.getElementById('cipher-illuminate-confirm-btn');
  confirmBtn.disabled = true;
  statusEl.style.color = 'var(--muted)';
  statusEl.textContent = 'Verifying…';

  // Narrow try/catch, same discipline as submitCipherUnlock: this guards
  // ONLY the passphrase re-verification AND the full-body decryption that
  // now happens here. Illuminate is the ONE place a Cipher's full
  // plaintext gets reconstructed in memory — unlock (submitCipherUnlock)
  // deliberately stops short of this, decrypting only enough to verify
  // the passphrase. Rendering afterward is outside this try/catch.
  let plaintext;
  try {
    const note = await NotesStore.get(id);
    if (!note || !note.encrypted) throw new Error('NOT_FOUND');
    const result = await Cipher.decryptRecord(passphrase, note.encrypted);
    plaintext = result.plaintext;
  } catch (e) {
    if (e.message === 'WRONG_PASSPHRASE') {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'Incorrect passphrase.';
    } else if (e.message === 'MALFORMED_RECORD') {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'This Cipher is in a format that can no longer be read.';
    } else {
      console.error('[Remnant] Cipher illuminate verification failed:', e);
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'Something went wrong. Please try again.';
    }
    confirmBtn.disabled = false;
    return;
  }
  confirmBtn.disabled = false;

  // Populate the plaintext NOW — this is the moment full decryption
  // happens, deferred from unlock specifically so it only occurs when
  // the user has explicitly chosen the higher-exposure editing mode.
  if (App.unlockedCiphers[id]) App.unlockedCiphers[id].plaintext = plaintext;
  illuminateCipher(id);
  closeModal('modal-cipher-illuminate');
}

function illuminateCipher(id) {
  if (!App.illuminatedCipherIds.includes(id)) App.illuminatedCipherIds.push(id);
  resetIlluminateIdleTimer();
  if (App._cipherKeyboardMode) exitCipherKeyboardMode(); // the viewer is about to be replaced by the textarea
  renderActiveNote();
  renderTabs();
}

// obscureCipher(id) — the single shared exit path for all three trigger
// types. Always safe to call even if the given id isn't illuminated
// (e.g. the idle timer firing after the user already clicked Obscure
// manually) — it's idempotent.
async function obscureCipher(id) {
  const i = App.illuminatedCipherIds.indexOf(id);
  if (i !== -1) App.illuminatedCipherIds.splice(i, 1);
  clearIlluminateIdleTimer();

  // Flush any pending debounced save BEFORE discarding plaintext — and
  // AWAIT it. saveActiveCipher itself writes the textarea's current
  // value into unlocked.plaintext as part of saving; if that write
  // happens AFTER this function's own plaintext = null below (which it
  // would, if this were fire-and-forget instead of awaited), the save's
  // own assignment silently overwrites the discard right back to the
  // real text moments later. Awaiting guarantees strict ordering: save
  // completes fully, including its own plaintext write, THEN we null it.
  if (saveCipherTimer) {
    clearTimeout(saveCipherTimer);
    saveCipherTimer = null;
    if (App.activeNoteId === id) await saveActiveCipher();
  }

  // Discard the plaintext — this is the other half of "only decrypted
  // while illuminated." Once obscured, the document goes back to
  // genuinely encrypted-at-rest-in-memory; only the line under the
  // cursor in the read-only viewer gets decrypted again, on demand.
  if (App.unlockedCiphers[id]) App.unlockedCiphers[id].plaintext = null;

  if (App.activeNoteId === id) {
    renderActiveNote();
    renderTabs();
  }
}

function resetIlluminateIdleTimer() {
  clearIlluminateIdleTimer();
  const id = App.activeNoteId;
  App.illuminateIdleTimer = setTimeout(() => {
    if (id) obscureCipher(id);
  }, ILLUMINATE_IDLE_MS);
}

function clearIlluminateIdleTimer() {
  if (App.illuminateIdleTimer) {
    clearTimeout(App.illuminateIdleTimer);
    App.illuminateIdleTimer = null;
  }
}

// Trigger 3a: tab/window visibility change (switching to another browser
// tab, minimizing, etc). Also re-checked on becoming VISIBLE again, not
// just hidden — mobile browsers commonly freeze JS execution entirely
// while backgrounded, so the 'hidden' handler may not run until the tab
// is already foregrounded again, by which point stale illuminated
// content could already be painted. Obscuring again on return closes
// that gap.
function obscureAllIlluminated() {
  App.illuminatedCipherIds.slice().forEach(obscureCipher); // slice() — obscureCipher mutates the array we'd otherwise be iterating
}
document.addEventListener('visibilitychange', () => {
  obscureAllIlluminated();
});
// Trigger 3b: window losing focus (switching to another application
// entirely, not just another browser tab — visibilitychange alone
// doesn't always catch this depending on OS/window manager behavior).
window.addEventListener('blur', obscureAllIlluminated);
window.addEventListener('pagehide', obscureAllIlluminated);

document.getElementById('cipher-illuminate-btn')?.addEventListener('click', openCipherIlluminateModal);
document.getElementById('cipher-illuminate-confirm-btn')?.addEventListener('click', submitCipherIlluminate);
document.getElementById('cipher-illuminate-cancel-btn')?.addEventListener('click', () => closeModal('modal-cipher-illuminate'));
document.getElementById('cipher-illuminate-close-btn')?.addEventListener('click', () => closeModal('modal-cipher-illuminate'));
document.getElementById('cipher-obscure-btn')?.addEventListener('click', () => {
  if (App.activeNoteId) obscureCipher(App.activeNoteId);
});

// Trigger 2: any typing/clicking while illuminated resets the idle clock.
// Scoped to the title/body inputs specifically — those are the signals
// that the user is actively present and working, not just any DOM event.
['input', 'click'].forEach(evt => {
  document.getElementById('note-title-input')?.addEventListener(evt, () => {
    if (isIlluminated(App.activeNoteId)) resetIlluminateIdleTimer();
  });
  document.getElementById('note-body-input')?.addEventListener(evt, () => {
    if (isIlluminated(App.activeNoteId)) resetIlluminateIdleTimer();
  });
});

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
// Pin and open are PARTIALLY linked: pinning opens the panel (a
// reasonable "make this visible and anchored" action), but unpinning
// does NOT close it — it only switches the open panel from claiming
// layout space to pop-out/overlay mode. Closing is always a separate,
// explicit action: the hamburger (which works identically regardless of
// pinned state) or clicking outside while in pop-out mode. There is no
// "pinned but closed" state, but "unpinned and open" is a perfectly
// normal, common state.
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
  // Pinning still opens the panel (a reasonable "make this visible and
  // anchored" action), but unpinning no longer force-closes it. The panel
  // should stay open and simply switch from claiming layout space to
  // pop-out/overlay mode — closing is now ALWAYS a separate, explicit
  // action (the hamburger, or clicking outside in pop-out mode), never an
  // automatic side effect of changing the pin preference.
  if (pinned) App.data.navState.panelOpen = true;
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
    const wideEnough = window.innerWidth >= NAV_PIN_MIN_WIDTH;
    pinBtn.style.display = wideEnough ? '' : 'none';
    pinBtn.classList.toggle('active', isPinned());
    pinBtn.title = isPinned() ? 'Unpin panel' : 'Pin panel';
  }
}

window.addEventListener('resize', applyNavPanelDOMState);

// The obscured viewer's rows reflow naturally on resize (each is sized
// by its own content, nothing pixel-matched to copy) — but the active/
// adjacent row DETECTION depends on getBoundingClientRect() positions,
// which do change on resize, so that needs a fresh recompute.
window.addEventListener('resize', () => {
  if (isCipherNote(App.noteSummaries[App.activeNoteId]) && !isIlluminated(App.activeNoteId)) {
    syncObscuredViewerToPointer(App.activeNoteId, App._lastPointerY);
  }
});

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
  // The hamburger always toggles panel visibility, regardless of pinned
  // state. Pinning controls HOW the panel behaves when open (claims
  // layout space vs. overlays as a pop-out) — it was never meant to make
  // the panel impossible to temporarily hide. The earlier guard here
  // ("if pinned, do nothing") meant pinned mode had NO way to hide the
  // panel at all short of unpinning — a real usability gap, not a
  // deliberate restriction, since panelOpen and pinned are already
  // independent stored fields (see setPinned/isPanelOpen) and nothing
  // re-forces panelOpen back to match pinned except setPinned itself.
  setPanelOpen(!isPanelOpen());
});
document.getElementById('nav-panel-scrim')?.addEventListener('click', () => setPanelOpen(false));

// Backup outside-tap close: the scrim's bounds rely on .main-layout's
// height (calc(100vh - 57px)), which mobile browser chrome (URL bar
// collapsing/expanding) can make briefly inaccurate. This listens at the
// document level instead of depending on the scrim element's exact
// rendered bounds — closes the panel on any tap/click outside it,
// whenever it's open in pop-out (non-pinned) mode.
document.addEventListener('click', (e) => {
  if (!isPanelOpen() || isPinnedActive()) return;
  const panel = document.getElementById('nav-panel');
  const toggleBtn = document.getElementById('nav-toggle-btn');
  if (panel.contains(e.target) || toggleBtn?.contains(e.target)) return;
  setPanelOpen(false);
}, true);
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
    const illuminated = isIlluminated(id);
    const tab = document.createElement('div');
    tab.className = 'tab tab-cipher' + (illuminated ? ' tab-cipher-illuminated' : '') + (id === App.activeNoteId ? ' active' : '');
    tab.title = notePath(id);
    const lockIcon = illuminated ? '🔓' : '🔒';
    tab.innerHTML = `<span class="tab-cipher-lock" title="Cipher">${lockIcon}</span><span class="tab-label"></span><span class="tab-close">&times;</span>`;
    tab.querySelector('.tab-label').textContent = summary.title?.trim() || 'Untitled Cipher';
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
    <span class="nav-row-actions">
      <span class="nav-row-action-btn" data-action="delete-note" title="${isCipher ? 'Delete cipher' : 'Delete remnant'}">🗑</span>
    </span>
  `;
  row.querySelector('.nav-row-label').textContent = noteSummary.title?.trim() || (isCipher ? 'Untitled Cipher' : 'Untitled Remnant');
  row.addEventListener('click', (e) => {
    if (e.target.closest('[data-action]')) return; // handled separately below
    if (isCipher) openCipherInTab(noteSummary.id);
    else openNoteInTab(noteSummary.id);
  });

  row.querySelector('[data-action="delete-note"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const label = noteSummary.title?.trim() || (isCipher ? 'Untitled Cipher' : 'Untitled Remnant');
    const warning = isCipher
      ? `Delete "${label}"? This Cipher's encrypted content will be permanently deleted — there is no way to recover it afterward, even with the correct passphrase.`
      : `Delete "${label}"? This cannot be undone.`;
    if (confirm(warning)) {
      deleteNote(noteSummary.id);
    }
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

// updateCipherControlsVisibility(id) — shows/hides the Illuminate button,
// Obscure button, illuminated border, warning banner, and switches
// between the textarea (illuminated) and the read-only obscured viewer
// (not illuminated), based on whether the active tab is a Cipher at all.
// Called from every renderActiveNote() exit path so these stay correct
// regardless of which branch (no tab / Cipher / plain Remnant) is active.
function updateCipherControlsVisibility(id) {
  const editorEl      = document.getElementById('note-editor');
  const illuminateBtn = document.getElementById('cipher-illuminate-btn');
  const obscureBtn     = document.getElementById('cipher-obscure-btn');
  const bannerEl       = document.getElementById('cipher-illuminate-banner');
  const viewerEl       = document.getElementById('cipher-obscured-viewer');
  const bodyEl         = document.getElementById('note-body-input');

  const isCipher = id && isCipherNote(App.noteSummaries[id]);
  const illuminated = isCipher && isIlluminated(id);
  const unlocked = isCipher && !!App.unlockedCiphers[id];

  illuminateBtn.style.display = (isCipher && !illuminated) ? '' : 'none';
  obscureBtn.style.display    = illuminated ? '' : 'none';
  bannerEl.style.display      = illuminated ? '' : 'none';
  editorEl.classList.toggle('illuminated', !!illuminated);
  document.getElementById('note-title-input').placeholder = isCipher ? 'Untitled cipher' : 'Untitled remnant';

  // Exactly one of {textarea, viewer} is visible at a time for a Cipher.
  // Illuminated -> textarea (full plaintext, editable). Unlocked-but-
  // obscured -> the read-only viewer (nothing decrypted except whatever
  // row the cursor is currently over). A plain Remnant always uses the
  // textarea, same as before.
  const showViewer = isCipher && unlocked && !illuminated;
  viewerEl.style.display = showViewer ? '' : 'none';
  bodyEl.style.display   = showViewer ? 'none' : '';
}

function renderActiveNote() {
  const titleEl = document.getElementById('note-title-input');
  const bodyEl  = document.getElementById('note-body-input');
  const id      = App.activeNoteId;
  const summary = id ? App.noteSummaries[id] : null;

  updateCipherControlsVisibility(id);

  if (!id || !summary) {
    titleEl.value = '';
    bodyEl.value  = '';
    titleEl.disabled = true;
    bodyEl.disabled  = true;
    bodyEl.placeholder = 'Open a remnant, or click "+" to start a new one…';
    App._bodyShowingNoteId = null;
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
      App._bodyShowingNoteId = null;
      return;
    }
    titleEl.disabled = false;
    titleEl.value = summary.title || '';

    if (isIlluminated(id)) {
      // Illuminated: textarea, full plaintext, editable — same as before.
      bodyEl.disabled = false;
      bodyEl.placeholder = 'Start writing…';
      if (App._bodyShowingNoteId !== id) {
        bodyEl.value = unlocked.plaintext || '';
        App._bodyShowingNoteId = id;
      }
    } else {
      // Obscured: the read-only viewer. Built from the ENCRYPTED line
      // array's metadata (count) — no decryption happens just to render
      // the viewer's structure. unlocked.plaintext is null here by
      // design (see the "Ciphers" section header) and is never read.
      App._bodyShowingNoteId = null; // textarea isn't showing this id's content right now
      renderCipherObscuredViewer(id);
    }
    return;
  }

  const note = App.openNotes[id];
  if (!note) {
    titleEl.value = '';
    bodyEl.value  = '';
    titleEl.disabled = true;
    bodyEl.disabled  = true;
    bodyEl.placeholder = 'Open a remnant, or click "+" to start a new one…';
    App._bodyShowingNoteId = null;
    return;
  }
  titleEl.disabled = false;
  bodyEl.disabled  = false;
  bodyEl.placeholder = 'Start writing…';
  titleEl.value = note.title || '';
  if (App._bodyShowingNoteId !== id) {
    bodyEl.value = note.content || '';
    App._bodyShowingNoteId = id;
  }
}

// ─── Cipher obscured viewer: per-line decrypt-on-demand ────────────
//
// Read-only. Shown whenever a Cipher is unlocked but NOT illuminated.
// Built as one real <div> row per ENCRYPTED line (note.encrypted.lines)
// — row count and therefore scroll height are known immediately from
// that array's length, with ZERO decryption needed just to lay out the
// viewer. This is the actual structural fix for the wrap-mismatch bugs
// chased earlier today: there's no second text layer trying to
// reproduce anything's wrapping, because at rest there's no text at all
// in most rows — just a sand-texture placeholder div with no characters
// for a browser to lay out incorrectly.
//
// Decryption happens ONLY for the row currently under the cursor
// (mouse or touch), via Cipher.decryptLineWithKey — and the decrypted
// text is DISCARDED (the row's real-text div is cleared) the moment the
// cursor moves to a different row. This is genuine per-line decrypt-on-
// demand: at any moment, only the active row's plaintext exists in
// memory at all, not a slice/mask of an already-fully-decrypted string.

let cipherViewerRowCount = 0;
let cipherViewerActiveRowIndex = -1;
let cipherViewerDecryptToken = 0; // incremented on every row change, so a slow in-flight decrypt for a row the cursor has already left can detect it's stale and discard its own result instead of writing into the wrong row

function renderCipherObscuredViewer(id) {
  const viewerEl = document.getElementById('cipher-obscured-viewer');
  if (viewerEl.style.display === 'none') return;

  runWithCipherNote(id, (note) => {
    const lineCount = note?.encrypted?.lines?.length || 0;
    viewerEl.innerHTML = '';
    for (let i = 0; i < lineCount; i++) {
      const row = document.createElement('div');
      row.className = 'cipher-obscured-row';
      row.dataset.lineIndex = i;
      row.innerHTML = `
        <div class="cipher-obscured-row-sand"></div>
        <div class="cipher-obscured-row-real"></div>
      `;
      viewerEl.appendChild(row);
    }
    cipherViewerRowCount = lineCount;
    cipherViewerActiveRowIndex = -1;
    syncObscuredViewerToPointer(id, App._lastPointerY);
  });
}

// runWithCipherNote — small helper since renderCipherObscuredViewer
// needs the note record (for encrypted.lines.length) but isn't itself
// async-friendly to call from every render path; fires the callback
// once the note is fetched. Synchronous callers just don't get a
// return value, which is fine here since rendering is fire-and-forget.
function runWithCipherNote(id, callback) {
  NotesStore.get(id).then(note => { if (App.activeNoteId === id) callback(note); });
}

function lineHeightPx() {
  const viewerEl = document.getElementById('cipher-obscured-viewer');
  const lh = parseFloat(getComputedStyle(viewerEl).lineHeight);
  return Number.isFinite(lh) ? lh : 24;
}

// syncObscuredViewerToPointer(id, clientY) — determines which ROW the
// pointer is over (by measured position, same approach as before) and
// activates exactly that row, deactivating whichever was active before.
function syncObscuredViewerToPointer(id, clientY) {
  if (clientY == null) return;
  const viewerEl = document.getElementById('cipher-obscured-viewer');
  if (viewerEl.style.display === 'none') return;

  const rows = viewerEl.querySelectorAll('.cipher-obscured-row');
  if (!rows.length) return;
  const lh = lineHeightPx();

  const tops = Array.from(rows).map(r => Math.round(r.getBoundingClientRect().top));
  let hoveredIdx = 0;
  for (let i = 0; i < tops.length; i++) {
    if (clientY >= tops[i] - lh / 2 && clientY < tops[i] + lh / 2) { hoveredIdx = i; break; }
    if (clientY < tops[i]) { hoveredIdx = Math.max(0, i - 1); break; }
    hoveredIdx = i;
  }

  rows.forEach((row, i) => {
    row.classList.toggle('adjacent', i === hoveredIdx - 1 || i === hoveredIdx + 1);
  });

  if (hoveredIdx === cipherViewerActiveRowIndex) return; // no change, nothing to (de/re)activate

  const prevIdx = cipherViewerActiveRowIndex;
  cipherViewerActiveRowIndex = hoveredIdx;
  const myToken = ++cipherViewerDecryptToken;

  if (prevIdx >= 0) deactivateRow(rows[prevIdx]);
  activateRow(id, rows[hoveredIdx], hoveredIdx, myToken);
}

async function activateRow(id, rowEl, lineIndex, token) {
  const unlocked = App.unlockedCiphers[id];
  if (!unlocked) return;
  const note = await NotesStore.get(id);
  if (!note?.encrypted?.lines?.[lineIndex]) return;

  let text;
  try {
    text = await Cipher.decryptLineWithKey(unlocked.key, note.encrypted.lines[lineIndex]);
  } catch (e) {
    console.error('[Remnant] Failed to decrypt line for obscured viewer:', e);
    return;
  }

  // The cursor may have already moved on to a different row while this
  // decrypt was in flight (decryptLineWithKey is async — a fast mouse
  // movement across several rows can easily outrun one decrypt call).
  // If a newer activation has started since this one began, THIS
  // result is stale: discard it rather than writing decrypted text
  // into a row the cursor isn't even on anymore, and rather than
  // letting a slow result clobber a newer/correct one.
  if (token !== cipherViewerDecryptToken) return;
  // Also bail if this exact row got deactivated in the meantime (e.g.
  // the user scrolled away) even without the row index itself changing.
  if (!rowEl.isConnected) return;

  const realEl = rowEl.querySelector('.cipher-obscured-row-real');
  realEl.textContent = text;
  rowEl.classList.add('active');
}

function deactivateRow(rowEl) {
  if (!rowEl) return;
  rowEl.classList.remove('active');
  // This is the actual "discard from memory" step — clearing
  // textContent removes the decrypted string from the DOM/render tree.
  // The underlying JS string becomes unreachable once nothing else
  // references it, eligible for garbage collection on the engine's own
  // schedule (see cipher.js's broader notes on what "discard" can and
  // cannot guarantee in JS — there's no hard zero-out, but this closes
  // the window of EXPOSURE/REFERENCE as tightly as the language allows).
  const realEl = rowEl.querySelector('.cipher-obscured-row-real');
  if (realEl) realEl.textContent = '';
}

// Mobile touch offset: the reveal window sits ABOVE the touch point on
// mobile, not under it — a finger on the glass would otherwise cover
// the one area that's actually legible. Fixed pixel offset so it stays
// predictable regardless of zoom/viewport size.
const TOUCH_REVEAL_OFFSET_PX = 48;

function attachCipherObscuredViewerTracking() {
  const viewerEl = document.getElementById('cipher-obscured-viewer');
  if (!viewerEl) return;

  // Throttled to once per animation frame — measuring every row's
  // getBoundingClientRect() on every raw event is the same kind of cost
  // that caused mobile scroll jank in the earlier overlay design.
  let frameQueued = false;
  function queueSync(y) {
    App._lastPointerY = y;
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => {
      frameQueued = false;
      if (isCipherNote(App.noteSummaries[App.activeNoteId]) && !isIlluminated(App.activeNoteId)) {
        syncObscuredViewerToPointer(App.activeNoteId, App._lastPointerY);
      }
    });
  }

  // Keyboard navigation mode (desktop): click anywhere in the viewer to
  // enter a locked reveal mode controlled by arrow keys instead of mouse
  // position. Mouse movement is deliberately IGNORED while active — this
  // is a genuinely separate mode, not a temporary override, so a stray
  // mouse twitch doesn't silently kick you back to hover-follow. Escape
  // exits back to normal hover-follow with everything re-obscured.
  viewerEl.addEventListener('mousemove', (e) => {
    if (App._cipherKeyboardMode) return;
    queueSync(e.clientY);
  });

  viewerEl.addEventListener('click', () => {
    if (isIlluminated(App.activeNoteId)) return;
    enterCipherKeyboardMode();
  });

  viewerEl.addEventListener('touchmove', (e) => {
    if (!e.touches?.length) return;
    const y = e.touches[0].clientY;
    queueSync(y - TOUCH_REVEAL_OFFSET_PX);
    updateTouchEdgeAutoScroll(viewerEl, y);
  }, { passive: true });
  viewerEl.addEventListener('touchend', stopTouchEdgeAutoScroll);
  viewerEl.addEventListener('touchcancel', stopTouchEdgeAutoScroll);

  // Native scroll — the viewer is a real scroll container with real
  // per-row content height, so scrolling just works; only the active-
  // row DETECTION needs a refresh as rows move under the (stationary,
  // during a scroll) pointer position.
  viewerEl.addEventListener('scroll', () => queueSync(App._lastPointerY), { passive: true });
}

// ─── Touch edge auto-scroll ─────────────────────────────────────────
//
// While dragging (touchmove) near the top or bottom edge of the viewer,
// auto-scroll the document in that direction, scaled by how deep into
// the edge zone the finger is — shallow into the zone scrolls slowly,
// right at the very edge scrolls faster. Moving back out of the zone
// (without lifting the finger) stops it immediately. This exists
// because on touch, "drag to scroll" and "drag to reveal" are the same
// physical gesture and were fighting each other; this turns them into
// one continuous motion instead of two competing ones.
const EDGE_ZONE_FRACTION = 0.18; // top/bottom 18% of the viewer's height
const EDGE_SCROLL_MAX_PX_PER_FRAME = 14;

let edgeScrollDirection = 0; // -1 up, 0 none, 1 down
let edgeScrollSpeed = 0;
let edgeScrollRAF = null;

function updateTouchEdgeAutoScroll(viewerEl, touchClientY) {
  const rect = viewerEl.getBoundingClientRect();
  const zoneSize = rect.height * EDGE_ZONE_FRACTION;
  const distanceFromTop    = touchClientY - rect.top;
  const distanceFromBottom = rect.bottom - touchClientY;

  if (distanceFromBottom < zoneSize) {
    edgeScrollDirection = 1;
    edgeScrollSpeed = EDGE_SCROLL_MAX_PX_PER_FRAME * (1 - Math.max(0, distanceFromBottom) / zoneSize);
  } else if (distanceFromTop < zoneSize) {
    edgeScrollDirection = -1;
    edgeScrollSpeed = EDGE_SCROLL_MAX_PX_PER_FRAME * (1 - Math.max(0, distanceFromTop) / zoneSize);
  } else {
    edgeScrollDirection = 0;
  }

  if (edgeScrollDirection !== 0 && !edgeScrollRAF) {
    const step = () => {
      if (edgeScrollDirection === 0) { edgeScrollRAF = null; return; }
      viewerEl.scrollTop += edgeScrollDirection * edgeScrollSpeed;
      edgeScrollRAF = requestAnimationFrame(step);
    };
    edgeScrollRAF = requestAnimationFrame(step);
  }
}

function stopTouchEdgeAutoScroll() {
  edgeScrollDirection = 0;
  if (edgeScrollRAF) { cancelAnimationFrame(edgeScrollRAF); edgeScrollRAF = null; }
}

// ─── Keyboard navigation mode ───────────────────────────────────────
//
// Click anywhere in the obscured viewer to enter: reveals the TOP row
// (not wherever you clicked), then Up/Down arrows move the reveal one
// row at a time, scrolling it into view as needed. Escape exits back
// to normal hover-follow, fully re-obscuring everything. Mouse movement
// is ignored for the duration — this is a deliberately separate,
// locked mode, not a temporary hover override.

function enterCipherKeyboardMode() {
  const id = App.activeNoteId;
  if (!id || isIlluminated(id)) return;
  App._cipherKeyboardMode = true;
  document.getElementById('cipher-obscured-viewer')?.classList.add('keyboard-mode');
  cipherViewerActiveRowIndex = -1; // force activateRow to actually run for row 0, even if it was already hover-active
  navigateCipherKeyboardRow(id, 0);
  document.addEventListener('keydown', handleCipherKeyboardNav);
}

function exitCipherKeyboardMode() {
  App._cipherKeyboardMode = false;
  document.getElementById('cipher-obscured-viewer')?.classList.remove('keyboard-mode');
  document.removeEventListener('keydown', handleCipherKeyboardNav);
  const viewerEl = document.getElementById('cipher-obscured-viewer');
  const rows = viewerEl?.querySelectorAll('.cipher-obscured-row');
  if (rows && cipherViewerActiveRowIndex >= 0 && rows[cipherViewerActiveRowIndex]) {
    deactivateRow(rows[cipherViewerActiveRowIndex]);
  }
  rows?.forEach(r => r.classList.remove('adjacent'));
  cipherViewerActiveRowIndex = -1;
}

function navigateCipherKeyboardRow(id, newIndex) {
  const viewerEl = document.getElementById('cipher-obscured-viewer');
  const rows = viewerEl?.querySelectorAll('.cipher-obscured-row');
  if (!rows?.length) return;
  const clamped = Math.max(0, Math.min(rows.length - 1, newIndex));
  if (clamped === cipherViewerActiveRowIndex) return;

  const prevIdx = cipherViewerActiveRowIndex;
  cipherViewerActiveRowIndex = clamped;
  const myToken = ++cipherViewerDecryptToken;

  if (prevIdx >= 0 && rows[prevIdx]) deactivateRow(rows[prevIdx]);
  rows.forEach((row, i) => row.classList.toggle('adjacent', i === clamped - 1 || i === clamped + 1));
  activateRow(id, rows[clamped], clamped, myToken);
  rows[clamped].scrollIntoView({ block: 'nearest' });
}

function handleCipherKeyboardNav(e) {
  if (!App._cipherKeyboardMode) return;
  const id = App.activeNoteId;
  if (e.key === 'ArrowDown') { e.preventDefault(); navigateCipherKeyboardRow(id, cipherViewerActiveRowIndex + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); navigateCipherKeyboardRow(id, cipherViewerActiveRowIndex - 1); }
  else if (e.key === 'Escape') { e.preventDefault(); exitCipherKeyboardMode(); }
}
attachCipherObscuredViewerTracking();

function scheduleSaveActive() {
  if (isCipherNote(App.noteSummaries[App.activeNoteId])) scheduleSaveActiveCipher();
  else scheduleSaveActiveNote();
}
document.getElementById('note-title-input')?.addEventListener('input', scheduleSaveActive);
document.getElementById('note-body-input')?.addEventListener('input', scheduleSaveActive);
document.getElementById('scratchpad-input')?.addEventListener('input', scheduleSaveScratchpad);

// Mobile pop-out toggle. No-op on desktop (button is CSS-hidden there,
// but harmless if clicked since the column is already always visible).
function setScratchpadOpen(open) {
  document.getElementById('scratchpad-column')?.classList.toggle('open', open);
}
document.getElementById('scratchpad-toggle-btn')?.addEventListener('click', () => setScratchpadOpen(true));
document.getElementById('scratchpad-close-btn')?.addEventListener('click', () => setScratchpadOpen(false));
document.getElementById('scratchpad-scrim')?.addEventListener('click', () => setScratchpadOpen(false));

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
