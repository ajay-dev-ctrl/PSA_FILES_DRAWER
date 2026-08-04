'use strict';

/**
 * AUTH — Client-side auth module for PSA WORKS
 * All cryptographic operations happen on the server.
 * This module handles:
 *  - API calls for register / login / logout / session check
 *  - Client-side lockout UX (localStorage counter — UI only, not security)
 */
const AUTH = (() => {

  // API_URL can be overridden by setting window.PSA_API_URL before loading this script.
  const API_URL = (window.PSA_API_URL ?? 'http://localhost:3000');

  const MAX_ATTEMPTS   = 3;
  const LOCKOUT_MS     = 30 * 60 * 1000;   // 30 minutes
  const STORAGE_LOCKOUT = '__auth_lockout__';

  // ── LOCKOUT: Client-side attempt counter (UX feedback only) ─────────────────

  function checkLockout(username) {
    const raw   = localStorage.getItem(STORAGE_LOCKOUT);
    const store = raw ? JSON.parse(raw) : {};
    const record = store[username.toLowerCase()];
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
      delete store[username.toLowerCase()];
      localStorage.setItem(STORAGE_LOCKOUT, JSON.stringify(store));
    }
    return { locked: false, attempts: record ? record.attempts : 0 };
  }

  function recordFailedAttempt(username) {
    const raw   = localStorage.getItem(STORAGE_LOCKOUT);
    const store = raw ? JSON.parse(raw) : {};
    const key   = username.toLowerCase();
    const record = store[key] || { attempts: 0 };

    record.attempts += 1;
    if (record.attempts >= MAX_ATTEMPTS) {
      record.lockedUntil = Date.now() + LOCKOUT_MS;
    }
    store[key] = record;
    localStorage.setItem(STORAGE_LOCKOUT, JSON.stringify(store));
    return record;
  }

  function clearLockout(username) {
    const raw = localStorage.getItem(STORAGE_LOCKOUT);
    if (!raw) return;
    const store = JSON.parse(raw);
    delete store[username.toLowerCase()];
    localStorage.setItem(STORAGE_LOCKOUT, JSON.stringify(store));
  }

  // NOTE: there is no public registration call here. Accounts are created by
  // an admin (Settings → Create User), never by self-signup.

  // ── LOGIN: POST /auth/login + client-side lockout UX ─────────────────────────

  async function authenticateUser(username, password) {
    // Client-side lockout check (immediate UI feedback)
    const lockout = checkLockout(username);
    if (lockout.locked) {
      return {
        success: false,
        locked: true,
        remainingSeconds: lockout.remainingSeconds,
        error: `Account locked. Try again in ${Math.ceil(lockout.remainingSeconds / 60)} min.`,
      };
    }

    try {
      const res  = await fetch(`${API_URL}/auth/login`, {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (res.ok) {
        clearLockout(username);
        return { success: true, username: data.username };
      }

      if (res.status === 401 || res.status === 400) {
        const record = recordFailedAttempt(username);
        if (record.lockedUntil) {
          return {
            success: false,
            locked: true,
            remainingSeconds: Math.ceil((record.lockedUntil - Date.now()) / 1000),
            error: 'Too many failed attempts. Account locked for 30 minutes.',
          };
        }
        return { success: false, error: 'Invalid username or password.' };
      }

      return { success: false, error: data.error ?? 'Login failed.' };
    } catch {
      return { success: false, error: 'Could not connect to server.' };
    }
  }

  // ── SESSION: GET /auth/me ─────────────────────────────────────────────────────

  async function validateSession() {
    try {
      const res = await fetch(`${API_URL}/auth/me`, { credentials: 'include' });
      if (!res.ok) return null;
      return await res.json();  // { username }
    } catch {
      return null;
    }
  }

  // ── AUTH GUARD: redirect to login if no valid session ───────────────────────

  async function requireAuth(redirectTo = 'login.html') {
    const session = await validateSession();
    if (!session) {
      window.location.replace(redirectTo);
      return null;
    }
    return session;
  }

  // ── LOGOUT: POST /auth/logout then redirect ───────────────────────────────────

  async function logout(redirectTo = 'login.html') {
    try {
      await fetch(`${API_URL}/auth/logout`, {
        method:      'POST',
        credentials: 'include',
      });
    } catch { /* ignore — redirect anyway */ }
    window.location.replace(redirectTo);
  }

  // ── PUBLIC API ────────────────────────────────────────────────────────────────
  return {
    authenticateUser,
    requireAuth,
    validateSession,
    logout,
    checkLockout,
    MAX_ATTEMPTS,
    LOCKOUT_MS,
  };

})();
