/**
 * cipher.js — Cryptographic core for Remnant's Cipher feature.
 *
 * A Cipher is a Remnant whose content is encrypted client-side with a
 * user-supplied passphrase. This module is the ONLY place that touches
 * the actual cryptography — key derivation and AES-GCM encrypt/decrypt.
 * Nothing here knows about the UI, the nav tree, or the spotlight-reveal
 * rendering; it just turns (passphrase, plaintext) into a storable
 * ciphertext record, and turns (passphrase, record) back into plaintext.
 *
 * ── Security model — read this before touching anything below ──────
 *
 * - The passphrase is NEVER stored, anywhere, in any form. Not in
 *   localStorage, not in the KV sync payload, not even hashed for a
 *   "remember me" feature. The only thing ever persisted is the salt
 *   (not secret — it just needs to be known to re-derive the same key),
 *   the KDF parameters, the IV, and the ciphertext itself.
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
 * ── Cipher record shape (what gets stored in IndexedDB / synced to KV) ──
 *   {
 *     salt:       base64 string, 16 random bytes, unique per Cipher
 *     iv:         base64 string, 12 random bytes, unique per ENCRYPTION
 *                 (regenerated every time content is re-encrypted, even
 *                 for the same Cipher — reusing an IV with the same key
 *                 is the one cardinal sin of AES-GCM, so every save gets
 *                 a fresh one)
 *     ciphertext: base64 string, the encrypted content
 *     kdfParams:  { memorySize, iterations, parallelism } — not secret,
 *                 just need to be known to re-derive the same key later
 *   }
 *
 * API (all async):
 *   Cipher.deriveKey(passphrase, salt)        → CryptoKey
 *   Cipher.createRecord(passphrase, plaintext) → record (generates a
 *                                                 fresh salt)
 *   Cipher.decryptRecord(passphrase, record)   → { plaintext, key }
 *                                                 throws on wrong passphrase
 *   Cipher.decryptWithKey(key, record)         → plaintext
 *                                                 (reuse a held key —
 *                                                 e.g. session cache, or
 *                                                 re-encrypting after an
 *                                                 edit — without re-running
 *                                                 Argon2)
 *   Cipher.encryptWithKey(key, plaintext, salt, kdfParams) → record
 *                                                 (re-encrypt with a
 *                                                 fresh IV, same key/salt)
 */
const Cipher = (() => {
  // Argon2id parameters. OWASP's 2026 guidance for security-conscious
  // password storage sits around 64 MiB / t=3 / p=1 up to 128 MiB / t=3-5
  // (their bare minimum baseline is lighter: 19 MiB / t=2, intended for a
  // one-time server-side login check). This runs client-side and on every
  // unlock rather than once at login, so it's deliberately calibrated a
  // bit below the heaviest end of that range — security-conscious but not
  // punishing on modest hardware. Adjust here only; nothing else hardcodes
  // these values.
  const ARGON2_PARAMS = {
    memorySize:  65536, // 64 MiB, in KiB (hash-wasm's unit)
    iterations:  3,
    parallelism: 1,
    hashLength:  32,    // 32 bytes = 256 bits, matching AES-256
  };

  const AES_ALGO = 'AES-GCM';
  const AES_KEY_LENGTH = 256;
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

  // deriveKey(passphrase, saltBytes, kdfParams) — runs Argon2id and imports
  // the resulting bytes as a non-extractable AES-GCM CryptoKey.
  // kdfParams defaults to the current ARGON2_PARAMS, but callers unlocking
  // an EXISTING Cipher must pass that Cipher's own stored kdfParams instead
  // — see decryptRecord below. If ARGON2_PARAMS is ever tuned in a future
  // app update, re-deriving an old Cipher's key with the NEW defaults
  // instead of the params it was actually created with would silently
  // produce a different key, and the correct passphrase would stop
  // working. Pinning each Cipher to its own stored params is what keeps
  // the no-recovery promise honest across future tuning changes.
  // non-extractable import is deliberate: once derived, the raw key bytes
  // can never be read back out of the CryptoKey object by any caller,
  // including this module itself. The key can only be USED (encrypt/
  // decrypt), never exported — one more guard against the key material
  // leaking out somewhere it shouldn't (an accidental console.log, a
  // bug elsewhere in the app, etc).
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
      false, // extractable: false — see comment above
      ['encrypt', 'decrypt']
    );
  }

  // ── Encrypt / decrypt with an already-derived key ──────────────────

  async function encryptWithKey(key, plaintext, saltBytes, kdfParams) {
    const iv = randomBytes(IV_BYTES); // fresh IV every encryption — never reused with the same key
    const enc = new TextEncoder();
    const ciphertextBuf = await crypto.subtle.encrypt(
      { name: AES_ALGO, iv },
      key,
      enc.encode(plaintext)
    );
    return {
      salt: bytesToBase64(saltBytes),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertextBuf)),
      // kdfParams (including hashLength) must be persisted in full — every
      // field is needed to re-derive the exact same key later. If
      // hashLength ever differs from what was used originally (e.g. after
      // a future app update changes ARGON2_PARAMS), re-deriving with the
      // NEW default instead of the value stored at creation time would
      // silently produce a different key and the correct passphrase would
      // stop working. Falling back to the current ARGON2_PARAMS only
      // happens here when the caller didn't supply params at all (e.g. a
      // brand-new Cipher being created right now).
      kdfParams: kdfParams || { ...ARGON2_PARAMS },
    };
  }

  async function decryptWithKey(key, record) {
    const iv = base64ToBytes(record.iv);
    const ciphertextBytes = base64ToBytes(record.ciphertext);
    let plaintextBuf;
    try {
      plaintextBuf = await crypto.subtle.decrypt({ name: AES_ALGO, iv }, key, ciphertextBytes);
    } catch (e) {
      // AES-GCM's authentication tag check failed — this is the expected,
      // clean signal for "wrong key" (and therefore "wrong passphrase").
      // Re-throw a clearly-labeled error so callers can distinguish this
      // from an unexpected/internal failure.
      throw new Error('WRONG_PASSPHRASE');
    }
    return new TextDecoder().decode(plaintextBuf);
  }

  // ── Full create / unlock flows (passphrase in, derives fresh each time) ──

  // createRecord(passphrase, plaintext) — used when a Cipher is first
  // created, or whenever the passphrase itself is being set/changed.
  // Generates a fresh salt (this Cipher's permanent salt going forward)
  // and a fresh IV, derives a key via Argon2id, encrypts, and returns
  // everything needed to store the Cipher. The derived CryptoKey is
  // also returned so the caller can immediately use it for the current
  // editing session without re-deriving.
  async function createRecord(passphrase, plaintext) {
    const saltBytes = randomBytes(SALT_BYTES);
    const key = await deriveKey(passphrase, saltBytes);
    const record = await encryptWithKey(key, plaintext, saltBytes, { ...ARGON2_PARAMS });
    return { record, key };
  }

  // decryptRecord(passphrase, record) — used when unlocking an existing
  // Cipher. Re-derives the key from the passphrase using THIS RECORD'S
  // OWN stored salt and kdfParams (not the live ARGON2_PARAMS constant —
  // see deriveKey's comment for why that distinction matters), then
  // attempts decryption. Throws WRONG_PASSPHRASE (via decryptWithKey) if
  // the passphrase doesn't match. Returns both the plaintext AND the
  // derived key, so the caller can hold the key for the rest of the
  // editing session (re-encrypting on edits, or for the optional
  // "remember for this session" cache) without re-running Argon2id again
  // for the same Cipher in the same session.
  async function decryptRecord(passphrase, record) {
    const saltBytes = base64ToBytes(record.salt);
    const key = await deriveKey(passphrase, saltBytes, record.kdfParams);
    const plaintext = await decryptWithKey(key, record); // throws WRONG_PASSPHRASE on failure
    return { plaintext, key };
  }

  return {
    deriveKey,
    createRecord,
    decryptRecord,
    decryptWithKey,
    encryptWithKey,
    ARGON2_PARAMS, // exposed read-only for reference (e.g. showing params in a debug/settings view later)
  };
})();
