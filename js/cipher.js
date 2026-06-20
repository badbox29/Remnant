/**
 * cipher.js — Cryptographic core for Remnant's Cipher feature.
 *
 * A Cipher is a Remnant whose content is encrypted client-side with a
 * user-supplied passphrase. This module is the ONLY place that touches
 * the actual cryptography — key derivation and AES-GCM encrypt/decrypt.
 * Nothing here knows about the UI, the nav tree, or the spotlight-reveal
 * rendering; it just turns (passphrase, plaintext) into a storable
 * encrypted record, and turns (passphrase, record) back into plaintext.
 *
 * ── Security model — read this before touching anything below ──────
 *
 * - The passphrase is NEVER stored, anywhere, in any form. Not in
 *   localStorage, not in the KV sync payload, not even hashed for a
 *   "remember me" feature. The only thing ever persisted is the salt
 *   (not secret — it just needs to be known to re-derive the same key),
 *   the KDF parameters, and the per-line IVs/ciphertexts.
 * - There is NO recovery path. A forgotten passphrase means permanently
 *   lost content. This is load-bearing, not a missing feature — any
 *   "reset" mechanism that could recover the plaintext would mean the
 *   encryption was never actually protecting anything.
 * - Key derivation: Argon2id (via the vendored hash-wasm build —
 *   vendor/argon2.umd.min.js, fetched and checksum-verified from the
 *   official npm registry, MIT licensed). Parameters below are tuned for
 *   CLIENT-SIDE, REPEATED use (every unlock, on whatever device the user
 *   has, not a one-time server-side login) — see ARGON2_PARAMS for the
 *   reasoning. Argon2id was chosen over PBKDF2 because it's memory-hard,
 *   which specifically defeats cheap massively-parallel GPU/ASIC
 *   brute-forcing of the kind PBKDF2 has grown weaker against over time.
 * - Encryption: AES-256-GCM via the browser's native Web Crypto API.
 *   Authenticated — a wrong key fails decryption outright (throws)
 *   rather than silently producing corrupted plaintext, which is exactly
 *   the signal needed to tell a user "wrong passphrase" with confidence.
 *   Native means no additional library/trust surface for this half.
 *
 * ── PER-LINE encryption (this is the load-bearing design choice) ───────
 * A Cipher's body is encrypted ONE LINE AT A TIME, not as a single blob.
 * Every line shares the same derived key but gets its OWN fresh random
 * IV — reusing a key across many independently-IV'd ciphertexts is the
 * normal, correct use of AES-GCM (nonce-per-message), not a special case.
 *
 * Why: this is what lets the spotlight-reveal UI (app.js) decrypt only
 * the line currently under the cursor, on demand, and let every other
 * line sit as genuine ciphertext bytes the rest of the time — not just
 * a substring of a string that's already fully decrypted in memory. A
 * memory snapshot taken at a random moment shows nearly the whole
 * document as ciphertext, with only the active line's plaintext ever
 * existing — a meaningfully smaller exposure footprint than decrypting
 * the whole body once at unlock.
 *
 * Saving an edit re-encrypts the ENTIRE line array together (not a diff
 * of just the changed lines) — simpler, and the per-line-at-rest
 * property is what matters between saves; diffing buys little extra
 * for real added complexity (line-shift bugs on insert/delete).
 *
 * ── Cipher record shape (what gets stored in IndexedDB / synced to KV) ──
 *   {
 *     salt:      base64 string, 16 random bytes, unique per Cipher,
 *                permanent for the Cipher's lifetime
 *     kdfParams: { memorySize, iterations, parallelism, hashLength } —
 *                not secret, just need to be known to re-derive the
 *                exact same key later (see deriveKey's comment on why
 *                THIS RECORD'S OWN stored params must always be used,
 *                never the live ARGON2_PARAMS constant)
 *     lines: [
 *       { iv: base64 string (12 bytes), ciphertext: base64 string },
 *       ...  one entry per line of the plaintext body, in order
 *     ]
 *   }
 *
 * API (all async):
 *   Cipher.deriveKey(passphrase, salt, kdfParams) → CryptoKey
 *   Cipher.createRecord(passphrase, plaintext)    → { record, key }
 *                                                    (plaintext is split
 *                                                    on \n; generates a
 *                                                    fresh salt)
 *   Cipher.decryptRecord(passphrase, record)      → { plaintext, key }
 *                                                    (joins lines with \n;
 *                                                    throws WRONG_PASSPHRASE)
 *   Cipher.decryptLineWithKey(key, lineRecord)    → string
 *                                                    (decrypt ONE line —
 *                                                    this is what the
 *                                                    spotlight reveal
 *                                                    calls on demand)
 *   Cipher.encryptLinesWithKey(key, lines[], salt, kdfParams) → record
 *                                                    (re-encrypt the
 *                                                    whole line array,
 *                                                    fresh IV per line)
 */
const Cipher = (() => {
  const ARGON2_PARAMS = {
    memorySize:  65536, // 64 MiB, in KiB (hash-wasm's unit)
    iterations:  3,
    parallelism: 1,
    hashLength:  32,    // 32 bytes = 256 bits, matching AES-256
  };

  const AES_ALGO = 'AES-GCM';
  const SALT_BYTES = 16;
  const IV_BYTES   = 12; // standard/recommended IV length for AES-GCM

  // ── Encoding helpers ────────────────────────────────────────────────

  function randomBytes(n) {
    const arr = new Uint8Array(n);
    crypto.getRandomValues(arr);
    return arr;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ── Key derivation (Argon2id) ───────────────────────────────────────

  async function deriveKey(passphrase, saltBytes, kdfParams) {
    if (typeof window.hashwasm?.argon2id !== 'function') {
      throw new Error('Argon2 library not loaded — check vendor/argon2.umd.min.js is included before cipher.js');
    }
    const params = kdfParams || ARGON2_PARAMS;
    const derivedBytes = await window.hashwasm.argon2id({
      password: passphrase,
      salt: saltBytes,
      parallelism: params.parallelism,
      iterations:  params.iterations,
      memorySize:  params.memorySize,
      hashLength:  params.hashLength,
      outputType:  'binary',
    });
    return crypto.subtle.importKey(
      'raw',
      derivedBytes,
      { name: AES_ALGO },
      false, // extractable: false — non-extractable import means the raw
             // key bytes can never be read back out of the CryptoKey
             // object by any caller, including this module itself
      ['encrypt', 'decrypt']
    );
  }

  // ── Single-line encrypt / decrypt — the core primitive ─────────────
  // Both are thin wrappers around one crypto.subtle call each. Nothing
  // about "per-line" requires new cryptography — it's the same AES-GCM
  // operation already used for the whole-blob approach, just called once
  // per line instead of once per Cipher.

  async function encryptLine(key, lineText) {
    const iv = randomBytes(IV_BYTES); // fresh IV every line, every encryption — never reused with the same key
    const enc = new TextEncoder();
    const ciphertextBuf = await crypto.subtle.encrypt(
      { name: AES_ALGO, iv },
      key,
      enc.encode(lineText)
    );
    return {
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertextBuf)),
    };
  }

  async function decryptLineWithKey(key, lineRecord) {
    const iv = base64ToBytes(lineRecord.iv);
    const ciphertextBytes = base64ToBytes(lineRecord.ciphertext);
    let plaintextBuf;
    try {
      plaintextBuf = await crypto.subtle.decrypt({ name: AES_ALGO, iv }, key, ciphertextBytes);
    } catch (e) {
      throw new Error('WRONG_PASSPHRASE');
    }
    return new TextDecoder().decode(plaintextBuf);
  }

  // ── Whole-array encrypt / decrypt — used for save and for unlock ───

  async function encryptLinesWithKey(key, lines, saltBytes, kdfParams) {
    const encryptedLines = await Promise.all(lines.map(line => encryptLine(key, line)));
    return {
      salt: bytesToBase64(saltBytes),
      kdfParams: kdfParams || { ...ARGON2_PARAMS },
      lines: encryptedLines,
    };
  }

  async function decryptAllLinesWithKey(key, record) {
    if (!Array.isArray(record?.lines)) {
      // Not a wrong passphrase — the record itself isn't in the shape
      // this module expects (e.g. a Cipher created under an earlier,
      // incompatible record format, or corrupted data). Surface this
      // as its own distinct error rather than letting record.lines.map
      // throw a raw TypeError, so callers can tell "bad passphrase"
      // apart from "this record can't be read at all" and message the
      // user accordingly instead of a generic crash.
      throw new Error('MALFORMED_RECORD');
    }
    const lines = await Promise.all(record.lines.map(line => decryptLineWithKey(key, line)));
    return lines.join('\n');
  }

  // ── Full create / unlock flows (passphrase in, derives fresh each time) ──

  async function createRecord(passphrase, plaintext) {
    const saltBytes = randomBytes(SALT_BYTES);
    const key = await deriveKey(passphrase, saltBytes);
    const lines = plaintext.split('\n');
    const record = await encryptLinesWithKey(key, lines, saltBytes, { ...ARGON2_PARAMS });
    return { record, key };
  }

  async function decryptRecord(passphrase, record) {
    const saltBytes = base64ToBytes(record.salt);
    const key = await deriveKey(passphrase, saltBytes, record.kdfParams);
    const plaintext = await decryptAllLinesWithKey(key, record);
    return { plaintext, key };
  }

  // verifyAndDeriveKey(passphrase, record) — derives the key and proves
  // it's correct by decrypting ONLY THE FIRST LINE, never the rest of
  // the document. AES-GCM's authentication tag means a wrong key fails
  // decryption outright on ANY line — checking one line is exactly as
  // conclusive as checking all of them, so there's no security reason
  // to decrypt more than this just to verify a passphrase.
  // This is the unlock path for read-only/obscured viewing: the
  // document should stay genuinely encrypted at rest, line by line,
  // with only the line currently under the cursor ever decrypted (via
  // decryptLineWithKey, called on demand by the viewer) — full-body
  // decryption (decryptRecord above) is reserved for Illuminate, an
  // explicit, separately-gated, higher-exposure editing mode.
  // Throws WRONG_PASSPHRASE / MALFORMED_RECORD same as decryptRecord.
  async function verifyAndDeriveKey(passphrase, record) {
    const saltBytes = base64ToBytes(record.salt);
    const key = await deriveKey(passphrase, saltBytes, record.kdfParams);
    if (!Array.isArray(record?.lines) || !record.lines.length) {
      throw new Error('MALFORMED_RECORD');
    }
    await decryptLineWithKey(key, record.lines[0]); // throws WRONG_PASSPHRASE on mismatch; result discarded — this call exists purely to prove the key works
    return { key };
  }

  return {
    deriveKey,
    createRecord,
    decryptRecord,
    verifyAndDeriveKey,
    decryptLineWithKey,
    encryptLinesWithKey,
    decryptAllLinesWithKey,
    ARGON2_PARAMS,
  };
})();
