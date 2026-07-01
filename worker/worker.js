/**
 * Remnant — Cloudflare Worker
 *
 * Environment variables (Cloudflare dashboard):
 *   GOOGLE_CLIENT_ID   — Google OAuth Client ID (never sent to the frontend source;
 *                        the client fetches it at runtime via GET /auth/config)
 *   ALLOWED_ORIGINS    — Comma-separated allowed origins
 *
 * KV Namespace binding:
 *   REMNANT_KV         — KV namespace for user data
 *
 * Routes:
 *   GET    /                    — Health check (open CORS)
 *   GET    /ping                — Health check (open CORS)
 *   GET    /auth/config         — Return Google Client ID for GIS bootstrap
 *   POST   /auth/google         — Verify Google ID token
 *   POST   /auth/verify         — Re-verify stored Google credential at boot
 *   POST   /auth/migrate        — Token → Google migration (HMAC-authenticated)
 *   GET    /storage/:token/:key — Read KV value
 *   PUT    /storage/:token/:key — Write KV value (HMAC signed)
 *   DELETE /storage/:token/:key — Delete KV value
 *   GET    /storage/:token      — List all keys for token
 *
 * This worker is a direct port of the Refectory auth stack. The auth/migration/
 * HMAC/JWT logic is unchanged — only naming (KV binding, HMAC salt, app name in
 * the health check) has been adapted for Remnant. See AUTH_NOTES.md for the
 * full rationale behind the three-tier account model.
 */

const KV_BINDING          = 'REMNANT_KV';
const KV_TTL              = 60 * 60 * 24 * 1825; // 5 years, resets on every write
const HMAC_SALT           = 'remnant-hmac-v1';    // must never change after deployment
const MAX_BODY_SIZE       = 5 * 1024 * 1024;      // 5 MB — generous ceiling for a notes blob
const AUTH_RATE_LIMIT     = 20;
const AUTH_RATE_LIMIT_WIN = 3600;
const RATE_LIMIT          = 120;
const RATE_LIMIT_WINDOW   = 60;

// ── Response helpers ───────────────────────────────────────────────────────

function respond(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', ...extra } });
}

// ── CORS ───────────────────────────────────────────────────────────────────

function buildCors(origin) {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Timestamp, X-Signature, X-Rev',
    'Access-Control-Expose-Headers': 'X-Rev, X-Token-Migrated, X-Account-Migrated',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}

function getAllowedOrigin(request, allowedOrigins) {
  const origin = request.headers.get('Origin') || '';
  return allowedOrigins.includes(origin) ? origin : null;
}

// ── Token validation ───────────────────────────────────────────────────────

function isValidToken(token) {
  return /^(google:\d{10,30}|[a-zA-Z0-9_-]{8,128})$/.test(token);
}

// ── KV key identity (token hashing) ────────────────────────────────────────
//
// The raw HMAC token IS the credential — it's the HMAC signing secret. Storing
// it verbatim as the KV key prefix (user:{token}:…) meant a KV dump handed out
// usable credentials. So the KV IDENTITY for a token account is now the token's
// SHA-256 hash, not the token itself. A dump exposes hashes, which can't be used
// to forge signatures. Auth is unaffected: verifyHmac still uses the raw token,
// which only ever travels in the request, never into KV.
//
// Google tokens (google:{sub}) pass through unchanged — a Google sub is not a
// secret credential (auth there is the verified Google JWT), and passing it
// through keeps existing Google data exactly where it already lives.

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function kvId(token) {
  return token.startsWith('google:') ? token : await sha256hex(token);
}

// ensureHashedPrefix(token, env) — one-time migration-on-access. Data written
// before hashing lives under user:{rawToken}:*. On a token account's first
// request after deploy, copy that whole prefix to user:{hash}:* and delete the
// originals (which removes the exposed raw-token keys). Idempotent and cheap
// afterwards: once the hashed profile exists, the existence check short-circuits.
// Google tokens never need this.
async function ensureHashedPrefix(token, env) {
  if (token.startsWith('google:')) return false;
  const kv     = env[KV_BINDING];
  const hashed = await kvId(token);
  const newPfx = `user:${hashed}:`;
  // Hashed data already present (or this is a brand-new account) → nothing to do.
  if (await kv.get(`${newPfx}profile`, { type: 'text' }) !== null) return false;
  const rawPfx = `user:${token}:`;
  let cursor, migrated = false;
  do {
    const listed = await kv.list({ prefix: rawPfx, cursor });
    for (const k of listed.keys) {
      const sub = k.name.slice(rawPfx.length);
      const val = await kv.get(k.name, { type: 'text' });
      if (val !== null) {
        await kv.put(newPfx + sub, val, { expirationTtl: KV_TTL });
        await kv.delete(k.name);
        migrated = true;
      }
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return migrated;
}

// ── IP rate limiting (auth routes) ─────────────────────────────────────────

async function checkIpRateLimit(env, ip) {
  const kv    = env[KV_BINDING];
  const key   = `rl:ip:${ip}`;
  const raw   = await kv.get(key, { type: 'text' });
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= AUTH_RATE_LIMIT) return false;
  await kv.put(key, String(count + 1), { expirationTtl: AUTH_RATE_LIMIT_WIN * 2 });
  return true;
}

// ── HMAC signing (mirrors auth.js exactly — salt MUST match) ───────────────

async function deriveHmacKey(token) {
  const enc    = new TextEncoder();
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HKDF' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(HMAC_SALT), info: enc.encode('request-signing') },
    keyMat,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']
  );
}

async function verifyHmac(request, token, body) {
  const timestamp = request.headers.get('X-Timestamp') || '';
  const signature = request.headers.get('X-Signature') || '';
  if (!timestamp || !signature) return { ok: false, reason: 'Missing HMAC headers' };
  if (Math.abs(Date.now() - parseInt(timestamp, 10)) > 5 * 60 * 1000)
    return { ok: false, reason: 'Timestamp expired' };

  const enc      = new TextEncoder();
  const bodyHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(body || '')))
  ).map(b => b.toString(16).padStart(2, '0')).join('');

  const message  = `${request.method.toUpperCase()}:${token}:${timestamp}:${bodyHash}`;
  try {
    const key      = await deriveHmacKey(token);
    const sigBytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid    = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(message));
    return valid ? { ok: true } : { ok: false, reason: 'Invalid signature' };
  } catch { return { ok: false, reason: 'Verification error' }; }
}

async function checkAuth(request, token, cors, requireHmac, body, env) {
  if (token.startsWith('google:')) {
    const authHeader = request.headers.get('Authorization') || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!idToken) return { ok: false, res: respond(JSON.stringify({ error: 'Authorization required' }), 401, cors) };
    const payload = await verifyGoogleJWT(idToken, env?.GOOGLE_CLIENT_ID);
    if (!payload) return { ok: false, res: respond(JSON.stringify({ error: 'Invalid or expired Google token' }), 401, cors) };
    if (token !== `google:${payload.sub}`) return { ok: false, res: respond(JSON.stringify({ error: 'Token mismatch' }), 403, cors) };
    return { ok: true };
  }
  const hmac = await verifyHmac(request, token, body);
  if (!hmac.ok && requireHmac)
    return { ok: false, res: respond(JSON.stringify({ error: `Auth failed: ${hmac.reason}` }), 401, cors) };
  return { ok: true };
}

// ── Google JWT (RS256) ─────────────────────────────────────────────────────

async function verifyGoogleJWT(idToken, clientId) {
  if (!clientId) return null;
  try {
    const parts   = idToken.split('.');
    if (parts.length !== 3) return null;
    const header  = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    const now     = Math.floor(Date.now() / 1000);
    if (payload.exp < now)   return null;
    if (payload.aud !== clientId) return null;
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) return null;
    if (!payload.sub) return null;

    const jwksRes = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    if (!jwksRes.ok) return null;
    const jwks    = await jwksRes.json();
    const jwk     = jwks.keys?.find(k => k.kid === header.kid);
    if (!jwk) return null;

    const cryptoKey    = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig          = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid        = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sig, signingInput);
    if (!valid) return null;

    return { sub: payload.sub, email: payload.email || null, name: payload.name || null, picture: payload.picture || null };
  } catch (e) {
    console.error('[Auth] verifyGoogleJWT:', e);
    return null;
  }
}

// ── Auth routes ────────────────────────────────────────────────────────────

async function handleAuth(url, method, request, env, cors, ip) {
  const kv = env[KV_BINDING];

  // GET /auth/config — return Google Client ID so the frontend never stores it
  if (url.pathname === '/auth/config' && method === 'GET') {
    return respond(JSON.stringify({
      googleClientId: env.GOOGLE_CLIENT_ID || '',
    }), 200, cors);
  }

  // All /auth/* routes are IP rate-limited
  if (!(await checkIpRateLimit(env, ip))) {
    return respond(JSON.stringify({ error: 'Too many requests — try again later' }), 429, cors);
  }

  // POST /auth/google
  if (url.pathname === '/auth/google' && method === 'POST') {
    let idToken;
    try { idToken = (await request.json()).idToken; } catch { return respond(JSON.stringify({ error: 'Invalid body' }), 400, cors); }
    if (!idToken) return respond(JSON.stringify({ error: 'idToken required' }), 400, cors);
    const p = await verifyGoogleJWT(idToken, env.GOOGLE_CLIENT_ID);
    if (!p) return respond(JSON.stringify({ error: 'Invalid or expired Google token' }), 401, cors);
    return respond(JSON.stringify({ ok: true, kvKey: `google:${p.sub}`, profile: p }), 200, cors);
  }

  // POST /auth/verify
  if (url.pathname === '/auth/verify' && method === 'POST') {
    let idToken;
    try { idToken = (await request.json()).idToken; } catch { return respond(JSON.stringify({ error: 'Invalid body' }), 400, cors); }
    if (!idToken) return respond(JSON.stringify({ error: 'idToken required' }), 400, cors);
    const p = await verifyGoogleJWT(idToken, env.GOOGLE_CLIENT_ID);
    if (!p) return respond(JSON.stringify({ ok: false, error: 'Token expired or invalid' }), 401, cors);
    return respond(JSON.stringify({ ok: true, profile: p }), 200, cors);
  }

  // POST /auth/migrate — requires HMAC proof of old token ownership
  if (url.pathname === '/auth/migrate' && method === 'POST') {
    const bodyText = await readBodyText(request);
    if (!bodyText) return respond(JSON.stringify({ error: 'Invalid body' }), 400, cors);
    let body;
    try { body = JSON.parse(bodyText); } catch { return respond(JSON.stringify({ error: 'Invalid JSON' }), 400, cors); }

    const { idToken, oldToken } = body || {};
    if (!idToken || !oldToken) return respond(JSON.stringify({ error: 'idToken and oldToken required' }), 400, cors);
    if (!isValidToken(oldToken)) return respond(JSON.stringify({ error: 'Invalid token format' }), 400, cors);

    // Verify Google credential
    const p = await verifyGoogleJWT(idToken, env.GOOGLE_CLIENT_ID);
    if (!p) return respond(JSON.stringify({ error: 'Invalid or expired Google token' }), 401, cors);

    // Verify caller controls oldToken via HMAC — closes the gap where any
    // authenticated Google user could migrate a stranger's data.
    const hmac = await verifyHmac(request, oldToken, bodyText);
    if (!hmac.ok) return respond(JSON.stringify({ error: 'Cannot verify ownership of source token' }), 401, cors);

    const kvKey = `google:${p.sub}`;

    // One Google identity = one account
    const existingGoogle = await kv.get(`user:${kvKey}:profile`, { type: 'text' });
    if (existingGoogle) return respond(JSON.stringify({ error: 'A Remnant account already exists for this Google account. Sign in with Google instead.' }), 409, cors);

    // Source data may still be under the raw token (pre-hashing) or already
    // hashed — normalize to the hashed space, then read from there.
    await ensureHashedPrefix(oldToken, env);
    const idOld = await kvId(oldToken);
    const existingRaw = await kv.get(`user:${idOld}:profile`, { type: 'text' });
    if (!existingRaw) return respond(JSON.stringify({ error: 'Source account not found' }), 404, cors);

    let existing;
    try { existing = JSON.parse(existingRaw); } catch { return respond(JSON.stringify({ error: 'Corrupt source data' }), 500, cors); }

    existing.authMethod   = 'google';
    existing.linkedGoogle = p;
    existing.lastModified = Date.now();

    await kv.put(`user:${kvKey}:profile`, JSON.stringify(existing), { expirationTtl: KV_TTL });
    await kv.put(`migrated:${oldToken}`, kvKey, { expirationTtl: 60 * 60 * 24 * 90 });

    // Copy any additional per-key data (none beyond `profile` in Remnant v1,
    // but this loop is preserved so future per-note keys migrate for free).
    const oldPfx = `user:${idOld}:`;
    const newPfx = `user:${kvKey}:`;
    let cursor;
    do {
      const listed = await kv.list({ prefix: oldPfx, cursor });
      for (const k of listed.keys) {
        const sub = k.name.slice(oldPfx.length);
        if (sub !== 'profile') {
          const val = await kv.get(k.name, { type: 'text' });
          if (val !== null) await kv.put(newPfx + sub, val, { expirationTtl: KV_TTL });
        }
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);

    // Remove the source key space now that it's copied to the Google account.
    // Previously this was left behind, stranding an exposed user:{oldToken}
    // profile (the 'ikz' leftover we cleaned up by hand). The migrated:{oldToken}
    // tombstone above is what still redirects the old device to Google.
    let delCursor;
    do {
      const del = await kv.list({ prefix: oldPfx, cursor: delCursor });
      for (const k of del.keys) await kv.delete(k.name);
      delCursor = del.list_complete ? undefined : del.cursor;
    } while (delCursor);

    return respond(JSON.stringify({ ok: true, kvKey, profile: p }), 200, cors);
  }

  return null; // no match
}

// ── Storage handler ────────────────────────────────────────────────────────

async function handleStorage(request, env, pathname, cors) {
  if (!env[KV_BINDING]) return respond(JSON.stringify({ error: 'KV not configured' }), 500, cors);

  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return respond(JSON.stringify({ error: 'Token required' }), 400, cors);

  const token = decodeURIComponent(parts[1]);
  if (!isValidToken(token)) return respond(JSON.stringify({ error: 'Invalid token format' }), 400, cors);

  const rlErr = await checkStorageRateLimit(token, env, cors);
  if (rlErr) return rlErr;

  // Convert any pre-hashing data under the raw token to the hashed key space,
  // once, before any read/write so every branch below operates on the hash.
  await ensureHashedPrefix(token, env);
  const id = await kvId(token);

  // GET /storage/:token — list keys
  if (parts.length === 2 && request.method === 'GET') {
    const auth = await checkAuth(request, token, cors, true, null, env);
    if (!auth.ok) return auth.res;
    return await listKeys(id, env, cors);
  }

  if (parts.length < 3) return respond(JSON.stringify({ error: 'Key required' }), 400, cors);

  const userKey = parts.slice(2).join('/');
  if (!/^[a-zA-Z0-9_\-./]{1,256}$/.test(userKey))
    return respond(JSON.stringify({ error: 'Invalid key format' }), 400, cors);

  const kvKey = `user:${id}:${userKey}`;

  if (request.method === 'GET') {
    const auth = await checkAuth(request, token, cors, true, null, env);
    if (!auth.ok) return auth.res;

    const { remaining } = await rateLimitCount(token, env);
    const tombRes = await checkMigrationTombstone(token, env, cors, remaining);
    if (tombRes) return tombRes;
    const fwdRes = await checkLegacyForward(token, env, cors, remaining);
    if (fwdRes) return fwdRes;

    const value = await env[KV_BINDING].get(kvKey, { type: 'text' });
    if (value === null) return respond(JSON.stringify({ error: 'Not found' }), 404, cors);
    return respond(JSON.stringify({ value: JSON.parse(value) }), 200, cors);
  }

  if (request.method === 'PUT') {
    const bodyText = await readBodyText(request);
    if (bodyText === null) return respond(JSON.stringify({ error: 'Invalid or oversized body' }), 400, cors);
    let parsed;
    try { parsed = JSON.parse(bodyText); } catch { return respond(JSON.stringify({ error: 'Invalid JSON' }), 400, cors); }

    const auth = await checkAuth(request, token, cors, true, bodyText, env);
    if (!auth.ok) return auth.res;

    parsed = await writeLegacyPointer(parsed, token, env);

    // Optimistic concurrency (Layer 3) — profile blob only. The client sends
    // X-Rev = the rev it based its merge on; if the stored rev moved since
    // (another device wrote in between), reject with 409 so the client
    // re-pulls, re-merges, and retries instead of clobbering that write.
    // A missing X-Rev header means a legacy client that predates this — we
    // skip the check so old sessions keep working, but still stamp the rev.
    if (userKey === 'profile') {
      const currentRaw = await env[KV_BINDING].get(kvKey, { type: 'text' });
      let currentRev = 0;
      if (currentRaw) { try { currentRev = JSON.parse(currentRaw)._rev || 0; } catch {} }
      const clientRev = request.headers.get('X-Rev');
      if (clientRev !== null && parseInt(clientRev, 10) !== currentRev) {
        return respond(JSON.stringify({ error: 'Conflict', rev: currentRev }), 409, { ...cors, 'X-Rev': String(currentRev) });
      }
      parsed._rev = currentRev + 1; // server-authoritative, monotonic
    }

    await env[KV_BINDING].put(kvKey, JSON.stringify(parsed), { expirationTtl: KV_TTL });
    return respond(JSON.stringify({ ok: true, rev: parsed._rev }), 200, cors);
  }

  if (request.method === 'DELETE') {
    const auth = await checkAuth(request, token, cors, true, null, env);
    if (!auth.ok) return auth.res;
    await env[KV_BINDING].delete(kvKey);
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  return respond(JSON.stringify({ error: 'Method not allowed' }), 405, cors);
}

async function listKeys(id, env, cors) {
  const prefix = `user:${id}:`;
  const list   = await env[KV_BINDING].list({ prefix });
  return respond(JSON.stringify({
    keys: list.keys.map(k => ({ key: k.name.slice(prefix.length), expiration: k.expiration })),
    list_complete: list.list_complete,
  }), 200, cors);
}

// ── Migration helpers ──────────────────────────────────────────────────────

async function checkMigrationTombstone(token, env, cors, remaining) {
  const migratedTo = await env[KV_BINDING].get(`migrated:${token}`, { type: 'text' });
  if (!migratedTo) return null;
  return respond(
    JSON.stringify({ migrated: true, authMethod: 'google' }),
    410,
    { ...cors, 'X-Account-Migrated': 'google', 'X-RateLimit-Remaining': String(remaining) }
  );
}

async function checkLegacyForward(token, env, cors, remaining) {
  const forwardTo = await env[KV_BINDING].get(`legacy:${token}`, { type: 'text' });
  if (!forwardTo) return null;
  const newData = await env[KV_BINDING].get(forwardTo, { type: 'text' });
  if (!newData) return null;
  return respond(newData, 200, { ...cors, 'X-Token-Migrated': forwardTo, 'X-RateLimit-Remaining': String(remaining) });
}

async function writeLegacyPointer(parsed, newToken, env) {
  const legacy = parsed._legacyToken;
  if (legacy && typeof legacy === 'string' && isValidToken(legacy) && legacy !== newToken) {
    delete parsed._legacyToken;
    await env[KV_BINDING].put(`legacy:${legacy}`, newToken, { expirationTtl: 60 * 60 * 24 * 90 });
  } else {
    delete parsed._legacyToken;
  }
  return parsed;
}

// ── Rate limiting (storage) ────────────────────────────────────────────────

async function checkStorageRateLimit(token, env, cors) {
  const rlKey  = `ratelimit:${await kvId(token)}`;
  const now    = Math.floor(Date.now() / 1000);
  const win    = now - RATE_LIMIT_WINDOW;
  let ts       = [];
  const stored = await env[KV_BINDING].get(rlKey, { type: 'text' });
  if (stored) { try { ts = JSON.parse(stored).filter(t => t > win); } catch {} }
  if (ts.length >= RATE_LIMIT)
    return respond(JSON.stringify({ error: 'Rate limit exceeded — please wait' }), 429, cors);
  ts.push(now);
  await env[KV_BINDING].put(rlKey, JSON.stringify(ts), { expirationTtl: RATE_LIMIT_WINDOW * 2 });
  return null;
}

async function rateLimitCount(token, env) {
  const rlKey  = `ratelimit:${await kvId(token)}`;
  const now    = Math.floor(Date.now() / 1000);
  const win    = now - RATE_LIMIT_WINDOW;
  let ts       = [];
  const stored = await env[KV_BINDING].get(rlKey, { type: 'text' });
  if (stored) { try { ts = JSON.parse(stored).filter(t => t > win); } catch {} }
  return { remaining: Math.max(0, RATE_LIMIT - ts.length) };
}

// ── Body helpers ───────────────────────────────────────────────────────────

async function readBodyText(request) {
  const cl = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (cl > MAX_BODY_SIZE) return null;
  try {
    const text = await request.text();
    return text.length > MAX_BODY_SIZE ? null : text;
  } catch { return null; }
}

// ── Entry point ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();
    const ip     = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

    // Health check — open CORS, no auth (needed by Auth.testWorkerUrl)
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/ping')) {
      return new Response(JSON.stringify({ ok: true, ts: Date.now(), app: 'Remnant' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Origin allowlist
    const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
    const origin         = getAllowedOrigin(request, allowedOrigins);
    if (!origin) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    const cors = buildCors(origin);

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname.startsWith('/auth/')) {
        const r = await handleAuth(url, method, request, env, cors, ip);
        if (r) return r;
      }

      if (url.pathname.startsWith('/storage')) {
        return await handleStorage(request, env, url.pathname.replace(/\/$/, ''), cors);
      }

      return respond(JSON.stringify({ error: 'Not found' }), 404, cors);
    } catch (err) {
      console.error('Worker error:', err);
      return respond(JSON.stringify({ error: 'Internal server error' }), 500, cors);
    }
  },
};
