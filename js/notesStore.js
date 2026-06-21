/**
 * notesStore.js — IndexedDB wrapper for note content, the scratchpad, and
 * the Book → Chapter → Note organizational structure.
 *
 * Note: the UI displays these as "Corpus / Scroll / Remnant" — this is a
 * display-only rename. Every identifier in this file (function names,
 * key prefixes, field names) intentionally stays book/chapter/note, since
 * changing them would touch the KV wire format and IndexedDB schema for
 * no user-visible benefit.
 *
 * Note bodies and the scratchpad live here, not in localStorage, so a long
 * history of writing never approaches localStorage's ~5MB per-origin ceiling.
 * IndexedDB's quota is disk-proportional and effectively unbounded for text.
 *
 * Three object stores in one database:
 *   notes       — keyed by note id. Two shapes share this store, told apart
 *                 by the `type` field (see below).
 *   structure   — two logical record types sharing one store, namespaced by
 *                 key prefix: 'book:<id>' and 'chapter:<id>'. Kept in one
 *                 store (rather than two) because Books and Chapters are
 *                 both small metadata records read/written together far
 *                 more often than separately (e.g. rendering the whole tree).
 *   scratchpad  — single fixed key ('main'); there is only ever one scratchpad
 *
 * localStorage still holds small account/tab metadata (see app.js — tabState,
 * authMethod, userToken, etc.) via Auth's own store helper. This module only
 * ever touches note/structure/scratchpad *content*.
 *
 * Ordering: each record (book, chapter, note) carries an integer `order`
 * field used for drag-to-reorder within a single container. Order is NOT
 * derived from array position — array/list position in a parent's
 * childIds is for membership only; the `order` field on the CHILD record
 * itself is what determines display sequence among its siblings. This
 * keeps reordering a single-record write instead of requiring a rewrite
 * of the parent's id array on every drag.
 *
 * Two record shapes in the `notes` store, told apart by `type`:
 *   Plain Remnant (no `type` field at all — its ABSENCE means "ordinary
 *   Remnant," so every Remnant created before Ciphers existed is still a
 *   perfectly valid record with zero migration):
 *     { id, chapterId, title, content, order, createdAt, updatedAt }
 *   Cipher (type: 'cipher' — a Remnant whose content is end-to-end
 *   encrypted with a user passphrase; see cipher.js for the crypto and
 *   app.js for the unlock/spotlight-reveal UI):
 *     { id, chapterId, title, type: 'cipher', encrypted: { salt, iv,
 *       ciphertext, kdfParams }, order, createdAt, updatedAt }
 *   A Cipher record deliberately has NO `content` field at all — only
 *   `encrypted`. Letting both fields coexist on the same record risks a
 *   future bug accidentally reading/syncing stale or absent plaintext
 *   instead of failing loudly; structurally absent is safer than present-
 *   but-supposed-to-be-empty. cipher.js never touches notesStore.js
 *   directly and has no IndexedDB/KV awareness at all — it only knows how
 *   to turn (passphrase, plaintext) into an `encrypted` object and back.
 *   Fragment (type: 'fragment' — an ephemeral, title-less note; see the
 *   Fragment Lifecycle spec). No chapterId/title/order at all: Fragments
 *   are never filed into a Book/Chapter and never manually reordered —
 *   they always live in the single computed "Loose Fragments" bucket,
 *   sorted by recency. content is plain text (never encrypted).
 *     { id, type: 'fragment', content, status, lastInteractedAt,
 *       createdAt, updatedAt }
 *   status is either absent/undefined (a live, decaying Fragment) or
 *   'dust' (expired past its 28-day lifespan, sitting in the 7-day Dust
 *   limbo awaiting salvage or hard deletion). There is no separate Dust
 *   store/type — it's the same record, same id, just flagged, so
 *   salvaging is a one-field write (clear status, reset
 *   lastInteractedAt) rather than a move between stores.
 *
 * API (all async):
 *   NotesStore.get(id)                  → note | null
 *   NotesStore.set(id, note)            → void
 *   NotesStore.delete(id)               → void
 *   NotesStore.getAll()                 → { [id]: note }     — used by pushToWorker
 *   NotesStore.replaceAll(notesObj)     → void                — used by pullFromWorker
 *   NotesStore.getScratchpad()          → { content, updatedAt } | null
 *   NotesStore.setScratchpad(content)   → void
 *
 *   NotesStore.getBook(id)              → book | null
 *   NotesStore.setBook(id, book)        → void
 *   NotesStore.deleteBook(id)           → void
 *   NotesStore.getAllBooks()            → { [id]: book }
 *   NotesStore.replaceAllBooks(obj)     → void
 *
 *   NotesStore.getChapter(id)           → chapter | null
 *   NotesStore.setChapter(id, chapter)  → void
 *   NotesStore.deleteChapter(id)        → void
 *   NotesStore.getAllChapters()         → { [id]: chapter }
 *   NotesStore.replaceAllChapters(obj)  → void
 *
 *   NotesStore.clear()                  → void  — wipes notes, structure, AND scratchpad
 *
 *   Fragment Lifecycle — all on the same `notes` store as Remnants/Ciphers,
 *   discriminated by type:'fragment'. See FRAGMENT_LIFESPAN_MS /
 *   FRAGMENT_DUST_MS below for the 28-day / 7-day windows.
 *   NotesStore.createFragment(content)        → fragment record
 *   NotesStore.getAllFragments()              → { [id]: fragment }  — every type:'fragment' record, live AND dusted
 *   NotesStore.touchFragment(id)               → void  — bumps lastInteractedAt to now (any "meaningful interaction": edit/merge)
 *   NotesStore.getFragmentStage(fragment)      → 0-3 (live) | 'dust' | 'expired'  — pure function, no I/O; see comment above its definition
 *   NotesStore.mergeFragments(survivorId, mergedId) → fragment record | null — appends mergedId's content onto survivorId with a provenance line, deletes mergedId, resets survivor's clock
 *   NotesStore.moveFragmentToDust(id)          → void  — sets status:'dust', does NOT touch lastInteractedAt (the Dust clock is computed from it)
 *   NotesStore.salvageFragment(id)             → void  — clears status, resets lastInteractedAt to now
 *   NotesStore.sweepFragments()                → { dusted: [...ids], deleted: [...ids] } — call once per load; moves expired live Fragments to Dust, hard-deletes Fragments whose Dust window has elapsed (logging each)
 *   NotesStore.getDeletionLog()                → [{ snippet, deletedAt }, ...]  — newest first
 *
 * Book shape:    { id, name, description, chapterIds: [], order, createdAt, updatedAt }
 * Chapter shape: { id, bookId, name, description, noteIds: [], order, createdAt, updatedAt }
 * Note shape:    see "Two record shapes" above
 */
const NotesStore = (() => {
  const DB_NAME           = 'remnant-notes';
  const NOTES_STORE       = 'notes';
  const STRUCTURE_STORE   = 'structure';
  const SCRATCHPAD_STORE  = 'scratchpad';
  const SCRATCHPAD_KEY    = 'main';
  const DELETION_LOG_STORE = 'deletionLog'; // Dust hard-deletes only — see sweepFragments()
  const DB_VERSION        = 3; // v3 adds the deletionLog store (Fragment Lifecycle)

  let _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(NOTES_STORE))      db.createObjectStore(NOTES_STORE);
        if (!db.objectStoreNames.contains(STRUCTURE_STORE))  db.createObjectStore(STRUCTURE_STORE);
        if (!db.objectStoreNames.contains(SCRATCHPAD_STORE)) db.createObjectStore(SCRATCHPAD_STORE);
        if (!db.objectStoreNames.contains(DELETION_LOG_STORE)) {
          // autoIncrement: log entries have no natural id and are never
          // looked up individually — only ever listed in bulk, newest first.
          db.createObjectStore(DELETION_LOG_STORE, { autoIncrement: true });
        }
      };
      req.onsuccess = e => { resolve(e.target.result); };
      req.onerror   = e => { _dbPromise = null; reject(e.target.error); }; // clear cache on failure so a later call can retry, rather than permanently caching a rejected promise
    });
    return _dbPromise;
  }

  async function store(name, mode) {
    const db = await openDB();
    return db.transaction(name, mode).objectStore(name);
  }

  function wrap(req) {
    return new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = (e) => { console.warn('[NotesStore]', e.target.error); resolve(null); };
    });
  }

  // ── Individual notes ──────────────────────────────────────────────
  // chapterId defaults to null (unfiled) for any note read before the
  // Books/Chapters feature existed — a one-time shape migration applied
  // lazily on read, rather than a bulk upgrade pass over every note.

  function withNoteDefaults(note) {
    if (!note) return note;
    return { chapterId: null, order: 0, ...note };
  }

  async function get(id) {
    try { return withNoteDefaults(await wrap((await store(NOTES_STORE, 'readonly')).get(id))); }
    catch { return null; }
  }

  async function set(id, note) {
    if (!id || !note) return;
    try { await wrap((await store(NOTES_STORE, 'readwrite')).put(note, id)); }
    catch (e) { console.warn('[NotesStore] set failed:', e); }
  }

  async function del(id) {
    try { await wrap((await store(NOTES_STORE, 'readwrite')).delete(id)); }
    catch { /* ignore */ }
  }

  // ── Bulk note operations (sync with worker) ────────────────────────

  // getAll() — returns every note as { [id]: note }, the shape pushToWorker
  // assembles into the KV wire-format blob.
  async function getAll() {
    try {
      const s = await store(NOTES_STORE, 'readonly');
      const keysReq = s.getAllKeys();
      const valsReq = s.getAll();
      const [keys, vals] = await Promise.all([wrap(keysReq), wrap(valsReq)]);
      const out = {};
      (keys || []).forEach((k, i) => { out[k] = withNoteDefaults((vals || [])[i]); });
      return out;
    } catch (e) {
      console.warn('[NotesStore] getAll failed:', e);
      return {};
    }
  }

  // replaceAll(notesObj) — wipes the notes store and rehydrates from a pulled
  // KV blob. Used after a successful pullFromWorker so local IndexedDB matches
  // the server's copy exactly (no stale notes left behind after a delete on
  // another device, for example).
  async function replaceAll(notesObj) {
    try {
      const s = await store(NOTES_STORE, 'readwrite');
      await wrap(s.clear());
      const entries = Object.entries(notesObj || {});
      await Promise.all(entries.map(([id, note]) => wrap(s.put(note, id))));
    } catch (e) {
      console.warn('[NotesStore] replaceAll failed:', e);
    }
  }

  // ── Structure: Books and Chapters ───────────────────────────────────
  // Stored in one object store, namespaced by key prefix so getAllBooks()/
  // getAllChapters() can filter by prefix without scanning record contents.

  const BOOK_PREFIX    = 'book:';
  const CHAPTER_PREFIX = 'chapter:';

  function withBookDefaults(book) {
    if (!book) return book;
    return { description: '', chapterIds: [], order: 0, ...book };
  }
  function withChapterDefaults(chapter) {
    if (!chapter) return chapter;
    return { description: '', noteIds: [], order: 0, ...chapter };
  }

  async function getBook(id) {
    try { return withBookDefaults(await wrap((await store(STRUCTURE_STORE, 'readonly')).get(BOOK_PREFIX + id))); }
    catch { return null; }
  }

  async function setBook(id, book) {
    if (!id || !book) return;
    try { await wrap((await store(STRUCTURE_STORE, 'readwrite')).put(book, BOOK_PREFIX + id)); }
    catch (e) { console.warn('[NotesStore] setBook failed:', e); }
  }

  async function deleteBook(id) {
    try { await wrap((await store(STRUCTURE_STORE, 'readwrite')).delete(BOOK_PREFIX + id)); }
    catch { /* ignore */ }
  }

  async function getChapter(id) {
    try { return withChapterDefaults(await wrap((await store(STRUCTURE_STORE, 'readonly')).get(CHAPTER_PREFIX + id))); }
    catch { return null; }
  }

  async function setChapter(id, chapter) {
    if (!id || !chapter) return;
    try { await wrap((await store(STRUCTURE_STORE, 'readwrite')).put(chapter, CHAPTER_PREFIX + id)); }
    catch (e) { console.warn('[NotesStore] setChapter failed:', e); }
  }

  async function deleteChapter(id) {
    try { await wrap((await store(STRUCTURE_STORE, 'readwrite')).delete(CHAPTER_PREFIX + id)); }
    catch { /* ignore */ }
  }

  // Internal: read every record in STRUCTURE_STORE once, split by prefix.
  // Used by getAllBooks/getAllChapters so a full-tree render only needs one
  // store read, not two separate cursor scans.
  async function _getAllStructure() {
    try {
      const s = await store(STRUCTURE_STORE, 'readonly');
      const keysReq = s.getAllKeys();
      const valsReq = s.getAll();
      const [keys, vals] = await Promise.all([wrap(keysReq), wrap(valsReq)]);
      const books = {}, chapters = {};
      (keys || []).forEach((k, i) => {
        if (k.startsWith(BOOK_PREFIX))         books[k.slice(BOOK_PREFIX.length)]    = withBookDefaults((vals || [])[i]);
        else if (k.startsWith(CHAPTER_PREFIX)) chapters[k.slice(CHAPTER_PREFIX.length)] = withChapterDefaults((vals || [])[i]);
      });
      return { books, chapters };
    } catch (e) {
      console.warn('[NotesStore] _getAllStructure failed:', e);
      return { books: {}, chapters: {} };
    }
  }

  async function getAllBooks() {
    return (await _getAllStructure()).books;
  }
  async function getAllChapters() {
    return (await _getAllStructure()).chapters;
  }

  // replaceAllBooks/replaceAllChapters — used by pullFromWorker. Each only
  // clears its own prefix's keys, never touching the other record type
  // sharing the store.
  async function _replacePrefixed(prefix, obj) {
    try {
      const s = await store(STRUCTURE_STORE, 'readwrite');
      const existingKeys = await wrap(s.getAllKeys());
      const toDelete = (existingKeys || []).filter(k => k.startsWith(prefix));
      await Promise.all(toDelete.map(k => wrap(s.delete(k))));
      const entries = Object.entries(obj || {});
      await Promise.all(entries.map(([id, rec]) => wrap(s.put(rec, prefix + id))));
    } catch (e) {
      console.warn('[NotesStore] _replacePrefixed failed:', e);
    }
  }
  async function replaceAllBooks(booksObj)       { await _replacePrefixed(BOOK_PREFIX, booksObj); }
  async function replaceAllChapters(chaptersObj) { await _replacePrefixed(CHAPTER_PREFIX, chaptersObj); }

  // ── Fragment Lifecycle ──────────────────────────────────────────────
  // Fragments share the `notes` store with Remnants/Ciphers (type:
  // 'fragment'). See the file header for the record shape. All timing
  // constants below are in ms so call sites never do day-math themselves.

  const FRAGMENT_STAGE_MS   = 7  * 24 * 60 * 60 * 1000; // one icon-decay stage
  const FRAGMENT_LIFESPAN_MS = 4 * FRAGMENT_STAGE_MS;    // 28 days total before Dust
  const FRAGMENT_DUST_MS    = 7  * 24 * 60 * 60 * 1000;  // 7-day Dust limbo before hard delete

  function newId() {
    return (crypto?.randomUUID?.() || `frag_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  }

  async function createFragment(content) {
    const now = Date.now();
    const fragment = {
      id: newId(),
      type: 'fragment',
      content: content || '',
      lastInteractedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await set(fragment.id, fragment);
    return fragment;
  }

  // getAllFragments() — every type:'fragment' record, live AND dusted.
  // Callers needing only one or the other should filter on `status`
  // themselves (e.g. UI splits Loose Fragments vs. the Dust view).
  async function getAllFragments() {
    const all = await getAll();
    const out = {};
    for (const [id, note] of Object.entries(all)) {
      if (note?.type === 'fragment') out[id] = note;
    }
    return out;
  }

  // touchFragment(id) — the ONLY thing that resets a Fragment's decay
  // clock. Call this on every "meaningful interaction" per the spec:
  // editing content, or as part of mergeFragments() below. Viewing a
  // Fragment must NEVER call this.
  async function touchFragment(id) {
    const fragment = await get(id);
    if (!fragment || fragment.type !== 'fragment') return;
    fragment.lastInteractedAt = Date.now();
    fragment.updatedAt = fragment.lastInteractedAt;
    await set(id, fragment);
  }

  // getFragmentStage(fragment) — pure function, no I/O, safe to call from
  // render code on every tick. Returns:
  //   0-3      → live, in decay stage N (0 = freshest week, 3 = oldest week before Dust)
  //   'dust'   → status is already 'dust' (icon/UI should NOT render a decay stage at all per spec)
  //   'expired'→ still status-live in storage but its 28 days have elapsed;
  //              callers should treat this as "about to be swept" — render
  //              as stage 3 — and the next sweepFragments() call will flip
  //              it to 'dust' for real. Exists so the UI never has to wait
  //              for a sweep to reflect reality.
  function getFragmentStage(fragment) {
    if (!fragment) return null;
    if (fragment.status === 'dust') return 'dust';
    const age = Date.now() - fragment.lastInteractedAt;
    if (age >= FRAGMENT_LIFESPAN_MS) return 'expired';
    return Math.min(3, Math.floor(age / FRAGMENT_STAGE_MS));
  }

  // mergeFragments(survivorId, mergedId) — appends mergedId's content onto
  // survivorId separated by a short plain-text provenance line, deletes
  // mergedId outright, and resets survivorId's clock via touchFragment.
  // There is no "Composite Fragment" type — the result is just a Fragment
  // (see spec: merge history lives as inline content, not structured data).
  // Returns the updated survivor record, or null if either id isn't a
  // live fragment (no-op rather than throwing, since this is reachable
  // from drag-and-drop UI where stale ids are possible).
  async function mergeFragments(survivorId, mergedId) {
    if (survivorId === mergedId) return null;
    const survivor = await get(survivorId);
    const merged   = await get(mergedId);
    if (!survivor || survivor.type !== 'fragment') return null;
    if (!merged   || merged.type   !== 'fragment') return null;

    const provenance = `— merged fragment, ${new Date().toLocaleString()} —`;
    survivor.content = `${survivor.content}\n\n${provenance}\n${merged.content}`;
    survivor.updatedAt = Date.now();
    await set(survivorId, survivor);
    await del(mergedId);
    await touchFragment(survivorId); // resets lastInteractedAt to now, full 28-day clock
    return await get(survivorId);
  }

  // moveFragmentToDust(id) — flips status to 'dust'. Deliberately does NOT
  // touch lastInteractedAt: the Dust 7-day countdown is computed as
  // (now - lastInteractedAt - FRAGMENT_LIFESPAN_MS) by sweepFragments(),
  // so the original decay timestamp must survive the transition.
  async function moveFragmentToDust(id) {
    const fragment = await get(id);
    if (!fragment || fragment.type !== 'fragment') return;
    fragment.status = 'dust';
    await set(id, fragment);
  }

  // salvageFragment(id) — the ONLY sanctioned exit from Dust. Clears
  // status and resets lastInteractedAt to now, per spec: salvaging grants
  // a full fresh 28-day lifespan, not a partial restore.
  async function salvageFragment(id) {
    const fragment = await get(id);
    if (!fragment || fragment.type !== 'fragment' || fragment.status !== 'dust') return;
    delete fragment.status;
    fragment.lastInteractedAt = Date.now();
    fragment.updatedAt = fragment.lastInteractedAt;
    await set(id, fragment);
  }

  // _logDeletion(content) — records a short content preview + timestamp
  // for a Dust hard-delete. Deliberately stores ONLY a snippet, never the
  // full content: the log is for "what did I lose and when," not a backup
  // that would undercut Fragments' whole point of not living forever.
  const DELETION_SNIPPET_LEN = 80;
  async function _logDeletion(content) {
    const raw = (content || '').trim().replace(/\s+/g, ' ');
    const snippet = raw.length > DELETION_SNIPPET_LEN
      ? raw.slice(0, DELETION_SNIPPET_LEN) + '…'
      : (raw || '(empty fragment)');
    try {
      const s = await store(DELETION_LOG_STORE, 'readwrite');
      await wrap(s.add({ snippet, deletedAt: Date.now() }));
    } catch (e) { console.warn('[NotesStore] _logDeletion failed:', e); }
  }

  async function getDeletionLog() {
    try {
      const s = await store(DELETION_LOG_STORE, 'readonly');
      const entries = await wrap(s.getAll());
      return (entries || []).sort((a, b) => b.deletedAt - a.deletedAt);
    } catch (e) {
      console.warn('[NotesStore] getDeletionLog failed:', e);
      return [];
    }
  }

  // sweepFragments() — call once per app load (and optionally on a coarse
  // background interval, mirroring the existing sync-check pattern in
  // app.js). Two passes over the same data, kept structurally separate
  // even though both stem from "is this Fragment too old":
  //   1. live Fragments whose 28 days have elapsed → moved to Dust
  //   2. dusted Fragments whose 7-day Dust window has elapsed → hard
  //      deleted, no confirmation (per spec), logged via _logDeletion
  // Single pass would conflate "just expired" with "already dusted," and
  // a Fragment dusted ON THIS SAME SWEEP must never be immediately
  // eligible for deletion in the same pass (its Dust clock starts now,
  // not 28 days ago) — hence two explicit loops rather than one.
  async function sweepFragments() {
    const fragments = await getAllFragments();
    const dusted = [];
    const deleted = [];
    const now = Date.now();

    for (const fragment of Object.values(fragments)) {
      if (fragment.status === 'dust') continue;
      if (now - fragment.lastInteractedAt >= FRAGMENT_LIFESPAN_MS) {
        await moveFragmentToDust(fragment.id);
        dusted.push(fragment.id);
      }
    }

    for (const fragment of Object.values(fragments)) {
      if (fragment.status !== 'dust') continue;
      if (dusted.includes(fragment.id)) continue; // just dusted above; Dust clock starts now, not eligible this sweep
      const dustElapsed = now - fragment.lastInteractedAt - FRAGMENT_LIFESPAN_MS;
      if (dustElapsed >= FRAGMENT_DUST_MS) {
        await _logDeletion(fragment.content);
        await del(fragment.id);
        deleted.push(fragment.id);
      }
    }

    return { dusted, deleted };
  }



  async function getScratchpad() {
    try { return await wrap((await store(SCRATCHPAD_STORE, 'readonly')).get(SCRATCHPAD_KEY)); }
    catch { return null; }
  }

  async function setScratchpad(content) {
    try {
      const record = { content: content || '', updatedAt: Date.now() };
      await wrap((await store(SCRATCHPAD_STORE, 'readwrite')).put(record, SCRATCHPAD_KEY));
    } catch (e) { console.warn('[NotesStore] setScratchpad failed:', e); }
  }

  // ── Reset (guest switch-account, etc.) ────────────────────────────

  async function clear() {
    try {
      const notesS  = await store(NOTES_STORE, 'readwrite');
      const structS = await store(STRUCTURE_STORE, 'readwrite');
      const padS    = await store(SCRATCHPAD_STORE, 'readwrite');
      const logS    = await store(DELETION_LOG_STORE, 'readwrite');
      await Promise.all([wrap(notesS.clear()), wrap(structS.clear()), wrap(padS.clear()), wrap(logS.clear())]);
    } catch { /* ignore */ }
  }

  return {
    get, set, delete: del, getAll, replaceAll,
    getBook, setBook, deleteBook, getAllBooks, replaceAllBooks,
    getChapter, setChapter, deleteChapter, getAllChapters, replaceAllChapters,
    getScratchpad, setScratchpad,
    createFragment, getAllFragments, touchFragment, getFragmentStage,
    mergeFragments, moveFragmentToDust, salvageFragment, sweepFragments,
    getDeletionLog,
    FRAGMENT_STAGE_MS, FRAGMENT_LIFESPAN_MS, FRAGMENT_DUST_MS,
    clear,
  };
})();
