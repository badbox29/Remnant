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
  const DB_VERSION        = 2; // v2 adds the structure store (Books/Chapters)

  let _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(NOTES_STORE))      db.createObjectStore(NOTES_STORE);
        if (!db.objectStoreNames.contains(STRUCTURE_STORE))  db.createObjectStore(STRUCTURE_STORE);
        if (!db.objectStoreNames.contains(SCRATCHPAD_STORE)) db.createObjectStore(SCRATCHPAD_STORE);
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
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

  // ── Scratchpad (separate store — never appears in the notes collection) ──

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
      await Promise.all([wrap(notesS.clear()), wrap(structS.clear()), wrap(padS.clear())]);
    } catch { /* ignore */ }
  }

  return {
    get, set, delete: del, getAll, replaceAll,
    getBook, setBook, deleteBook, getAllBooks, replaceAllBooks,
    getChapter, setChapter, deleteChapter, getAllChapters, replaceAllChapters,
    getScratchpad, setScratchpad,
    clear,
  };
})();
