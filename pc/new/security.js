/**
 * ============================================================
 *  SECURITY.JS — Cryptographic Authentication Core
 *  Uses Web Crypto API (built into modern browsers)
 *  - PBKDF2-SHA256 password hashing (100,000 iterations)
 *  - HMAC-SHA256 signed session tokens
 *  - Brute-force lockout (3 attempts → 30 sec cooldown)
 *  - Session expiry (1 hour)
 * ============================================================
 */

'use strict';

const AUTH = (() => {

  // ── CONSTANTS ──────────────────────────────────────────────
  const PBKDF2_ITERATIONS = 100_000;
  const PBKDF2_KEY_LENGTH = 256;          // bits
  const SALT_BYTES = 16;
  const SESSION_EXPIRY_MS = 60 * 60 * 1000;   // 1 hour
  const MAX_ATTEMPTS = 3;
  const LOCKOUT_MS = 30 * 1000;         // 30 seconds
  const STORAGE_USERS = '__auth_users__';
  const STORAGE_LOCKOUT = '__auth_lockout__';
  const SESSION_KEY = '__auth_session__';
  const HMAC_SECRET_SEED = 'psa-secure-2026-hmac-secret-key';

  // ── UTILITY: buf ↔ hex ──────────────────────────────────────
  function bufToHex(buf) {
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function hexToBuf(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes.buffer;
  }

  // ── UTILITY: constant-time comparison (anti-timing attack) ──
  function safeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  // ── CRYPTO: Generate random salt ────────────────────────────
  function generateSalt() {
    const salt = new Uint8Array(SALT_BYTES);
    crypto.getRandomValues(salt);
    return bufToHex(salt.buffer);
  }

  // ── CRYPTO: PBKDF2-SHA256 password hash ─────────────────────
  async function hashPassword(password, saltHex) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: hexToBuf(saltHex),
        iterations: PBKDF2_ITERATIONS,
      },
      keyMaterial,
      PBKDF2_KEY_LENGTH
    );
    return bufToHex(bits);
  }

  // ── CRYPTO: Import HMAC key from seed string ─────────────────
  async function getHmacKey() {
    const enc = new TextEncoder();
    const rawKey = await crypto.subtle.digest('SHA-256', enc.encode(HMAC_SECRET_SEED));
    return crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    );
  }

  // ── CRYPTO: Sign a payload with HMAC-SHA256 ─────────────────
  async function signToken(payload) {
    const key = await getHmacKey();
    const enc = new TextEncoder();
    const data = JSON.stringify(payload);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
    return {
      payload: btoa(data),
      sig: bufToHex(sig),
    };
  }

  // ── CRYPTO: Verify HMAC-SHA256 signature ────────────────────
  async function verifyToken(tokenObj) {
    try {
      const key = await getHmacKey();
      const enc = new TextEncoder();
      const data = atob(tokenObj.payload);
      const expectedSig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
      const expectedHex = bufToHex(expectedSig);

      if (!safeEqual(expectedHex, tokenObj.sig)) return null; // tampered

      const payload = JSON.parse(data);
      if (Date.now() > payload.exp) return null; // expired

      return payload;
    } catch {
      return null;
    }
  }

  // ── SESSION: Create & store ──────────────────────────────────
  async function createSession(email) {
    const payload = {
      email,
      iat: Date.now(),
      exp: Date.now() + SESSION_EXPIRY_MS,
      jti: bufToHex(crypto.getRandomValues(new Uint8Array(8)).buffer), // unique ID
    };
    const token = await signToken(payload);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(token));
    return token;
  }

  // ── SESSION: Validate (used by requireAuth) ──────────────────
  async function validateSession() {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    try {
      const token = JSON.parse(raw);
      return await verifyToken(token);
    } catch {
      return null;
    }
  }

  // ── SESSION: Require auth guard (call on protected pages) ────
  async function requireAuth(redirectTo = 'login.html') {
    const session = await validateSession();
    if (!session) {
      sessionStorage.removeItem(SESSION_KEY);
      window.location.replace(redirectTo);
      return null;
    }
    return session;
  }

  // ── SESSION: Logout ──────────────────────────────────────────
  function logout(redirectTo = 'login.html') {
    sessionStorage.removeItem(SESSION_KEY);
    window.location.replace(redirectTo);
  }

  // ── LOCKOUT: Check if email is locked ───────────────────────
  function checkLockout(email) {
    const raw = localStorage.getItem(STORAGE_LOCKOUT);
    const store = raw ? JSON.parse(raw) : {};
    const record = store[email.toLowerCase()];
    if (!record) return { locked: false, attempts: 0 };

    const now = Date.now();
    if (record.lockedUntil && now < record.lockedUntil) {
      return {
        locked: true,
        remainingSeconds: Math.ceil((record.lockedUntil - now) / 1000),
        attempts: record.attempts,
      };
    }
    // Lockout expired — reset
    if (record.lockedUntil && now >= record.lockedUntil) {
      delete store[email.toLowerCase()];
      localStorage.setItem(STORAGE_LOCKOUT, JSON.stringify(store));
    }
    return { locked: false, attempts: record ? record.attempts : 0 };
  }

  // ── LOCKOUT: Record a failed attempt ────────────────────────
  function recordFailedAttempt(email) {
    const raw = localStorage.getItem(STORAGE_LOCKOUT);
    const store = raw ? JSON.parse(raw) : {};
    const key = email.toLowerCase();
    const record = store[key] || { attempts: 0 };

    record.attempts += 1;
    if (record.attempts >= MAX_ATTEMPTS) {
      record.lockedUntil = Date.now() + LOCKOUT_MS;
    }
    store[key] = record;
    localStorage.setItem(STORAGE_LOCKOUT, JSON.stringify(store));
    return record;
  }

  // ── LOCKOUT: Reset on successful login ───────────────────────
  function clearLockout(email) {
    const raw = localStorage.getItem(STORAGE_LOCKOUT);
    if (!raw) return;
    const store = JSON.parse(raw);
    delete store[email.toLowerCase()];
    localStorage.setItem(STORAGE_LOCKOUT, JSON.stringify(store));
  }

  // ── USER STORE: Register ────────────────────────────────────
  async function registerUser(username, password) {
    const raw = localStorage.getItem(STORAGE_USERS);
    const users = raw ? JSON.parse(raw) : {};
    const key = username.toLowerCase();

    if (users[key]) return { success: false, error: 'Username already taken.' };

    const salt = generateSalt();
    const hash = await hashPassword(password, salt);

    users[key] = { username: key, salt, hash, createdAt: Date.now() };
    localStorage.setItem(STORAGE_USERS, JSON.stringify(users));
    return { success: true };
  }

  // ── USER STORE: Authenticate ────────────────────────────────
  async function authenticateUser(username, password) {
    const lockout = checkLockout(username);
    if (lockout.locked) {
      return {
        success: false,
        locked: true,
        remainingSeconds: lockout.remainingSeconds,
        error: `Account locked. Try again in ${Math.ceil(lockout.remainingSeconds / 60)} min.`,
      };
    }

    const raw = localStorage.getItem(STORAGE_USERS);
    const users = raw ? JSON.parse(raw) : {};
    const user = users[username.toLowerCase()];

    if (!user) {
      // Don't reveal if user exists (security best practice)
      recordFailedAttempt(username);
      return { success: false, error: 'Invalid username or password.' };
    }

    const hash = await hashPassword(password, user.salt);
    if (!safeEqual(hash, user.hash)) {
      const record = recordFailedAttempt(username);
      const remaining = MAX_ATTEMPTS - record.attempts;
      if (record.lockedUntil) {
        return {
          success: false,
          locked: true,
          remainingSeconds: Math.ceil((record.lockedUntil - Date.now()) / 1000),
          error: `Too many failed attempts. Account locked for 30 seconds.`,
        };
      }
      return {
        success: false,
        error: `Invalid username or password.`,
      };
    }

    clearLockout(username);
    const session = await createSession(user.username);
    return { success: true, username: user.username, session };
  }

  // ── PUBLIC API ───────────────────────────────────────────────
  return {
    registerUser,
    authenticateUser,
    requireAuth,
    validateSession,
    logout,
    checkLockout,
    hashPassword,
    generateSalt,
    MAX_ATTEMPTS,
    LOCKOUT_MS,
  };

})();
