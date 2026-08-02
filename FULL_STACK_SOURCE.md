# PSA Workflow — Combined Frontend + Backend Source

Single-file reference combining every source file from `frontend` (React UI)
and `backend/api` + `backend/worker` (Node backend). Generated for review —
the actual, running code still lives in the original files under those folders.

---

## Architecture

```
Browser
  -> frontend (Vite/React, :5173)
  -> api (Express, :3000)
      -> Postgres (job/employee/file metadata)
      -> Redis (job queue, session blacklist, search cache)
      -> MinIO (PDF/avatar object storage)
  -> worker (consumes Redis queue, writes results back to Postgres)
```

---

# FRONTEND — frontend

## frontend/Dockerfile

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY index.html ./
COPY src ./src

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
```

## frontend/package.json

```json
{
  "name": "psa-workflow-frontend",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "vite --host 0.0.0.0",
    "build": "vite build",
    "preview": "vite preview --host 0.0.0.0"
  },
  "dependencies": {
    "@vitejs/plugin-react": "^6.0.2",
    "vite": "^8.0.16",
    "react": "^19.2.7",
    "react-dom": "^19.2.7"
  },
  "devDependencies": {}
}
```

## frontend/index.html

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PSA Workflow</title>
    <link rel="icon" type="image/png" href="/PSA.png" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/App.jsx"></script>
  </body>
</html>
```

## frontend/public/security.js

Client-side auth module — calls the API for register/login/logout/session, plus
a UI-only lockout counter in `localStorage` (not a security boundary; the server
enforces real rate limiting).

```javascript
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

  // ── REGISTER: POST /auth/register ────────────────────────────────────────────

  async function registerUser(username, password) {
    try {
      const res  = await fetch(`${API_URL}/auth/register`, {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (res.ok) return { success: true };
      return { success: false, error: data.error ?? 'Registration failed.' };
    } catch {
      return { success: false, error: 'Could not connect to server.' };
    }
  }

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
    registerUser,
    authenticateUser,
    requireAuth,
    validateSession,
    logout,
    checkLockout,
    MAX_ATTEMPTS,
    LOCKOUT_MS,
  };

})();
```

## frontend/public/login.html

Static login page (styled inline, no build step). Talks to `security.js` above.
Markup only — see the file itself (`frontend/public/login.html`) for the
full HTML/CSS/inline script; omitted here for brevity since it's pure
presentation with no logic beyond what's already shown in `security.js`.

## frontend/public/register.html

Static registration page with client-side password-strength meter. Talks to
`security.js` above. See `frontend/public/register.html` for full
markup — omitted here for brevity, same reasoning as login.html.

## frontend/src/constants.js

```javascript
export const REQUIREMENT_DOCUMENTS = [
  { item: "A", name: "Appointment (CS FORM 33)" },
  { item: "B", name: "Oath of Office" },
  { item: "C", name: "Certificate of Assumption to Duty" },
  { item: "D", name: "Position Description Form (PDF)" },
  { item: "E", name: "Personal Data Sheet (PDS)" },
  { item: "F", name: "Notice of Salary Adjustment (NOSA) / Notice of Salary Increment (NOSI)" },
  { item: "G", name: "Certificate of Eligibility" },
  { item: "H", name: "Transcript of Records / Diploma" },
  { item: "I", name: "Service Record" },
  { item: "J", name: "Certificate of Leave Balance" },
  { item: "K", name: "Statement of Assets and Liabilities (SALN)" },
  { item: "L", name: "Marriage Contract" },
  { item: "M", name: "Medical Certificate" },
  { item: "N", name: "Clearances" },
  { item: "O", name: "Special Orders (SO) / Memorandum" },
  { item: "P", name: "Certificate of Training" },
  { item: "Q", name: "Others" },
];
```

## frontend/src/pages/Dashboard.jsx

```jsx
import { Fragment, useEffect, useMemo, useState } from "react";
import { REQUIREMENT_DOCUMENTS } from "../constants.js";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const TOTAL_DOCS = REQUIREMENT_DOCUMENTS.length;

function progressBand(pct) {
  if (pct >= 70) return "high";
  if (pct >= 30) return "partial";
  return "low";
}

function DocumentChips({ completedSet, onSelect }) {
  return (
    <>
      {REQUIREMENT_DOCUMENTS.map((d) => {
        const done = completedSet.has(d.item);
        return (
          <button
            key={d.item}
            type="button"
            className={`dash-missing-chip${done ? " dash-missing-chip--done" : ""}`}
            title={`${d.name} — click to open in Add Files`}
            onClick={() => onSelect?.(d.item)}
          >
            {d.item}
          </button>
        );
      })}
    </>
  );
}

export default function Dashboard({ onOpenInAddFiles }) {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [officeFilter, setOfficeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [tableCollapsed, setTableCollapsed] = useState(false);

  function toggleExpanded(id) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiUrl}/dashboard/summary`, { credentials: "include" })
      .then((r) => {
        if (r.status === 401) { window.location.replace("/login.html"); return null; }
        if (!r.ok) throw new Error("Could not load dashboard data.");
        return r.json();
      })
      .then((rows) => { if (!cancelled && rows) setEmployees(rows); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(() => employees.map((e) => {
    const completedSet = new Set(e.completed_items ?? []);
    const completedCount = REQUIREMENT_DOCUMENTS.filter((d) => completedSet.has(d.item)).length;
    return {
      id: e.id,
      name: e.name || "Unnamed user",
      position: e.position || "No position",
      officeDivision: e.office_division || "unknown",
      completedSet,
      completedCount,
      pct: TOTAL_DOCS ? Math.round((completedCount / TOTAL_DOCS) * 100) : 0,
    };
  }), [employees]);

  const officeOptions = useMemo(() => {
    const set = new Set(rows.map((r) => r.officeDivision));
    return Array.from(set).sort();
  }, [rows]);

  const filteredRows = rows.filter((r) => {
    if (officeFilter && r.officeDivision !== officeFilter) return false;
    if (statusFilter === "complete" && r.pct < 100) return false;
    if (statusFilter === "incomplete" && r.pct >= 100) return false;
    return true;
  });

  return (
    <>
      <div className="page-header">
        <div className="page-header-title">Dashboard</div>
        <div className="page-header-sub">Document completion overview per employee</div>
      </div>

      {/* ── Filters ── */}
      <section className="panel" id="dashboard-filters">
        <div className="section-heading">
          <h3 className="panel-title">
            <span className="panel-title-dot" />
            Filters
          </h3>
        </div>
        <div className="dash-filter-row">
          <label>
            Office / Division
            <select value={officeFilter} onChange={(e) => setOfficeFilter(e.target.value)}>
              <option value="">All offices</option>
              {officeOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          <label>
            Completion status
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All</option>
              <option value="complete">Complete</option>
              <option value="incomplete">Incomplete</option>
            </select>
          </label>
        </div>
      </section>

      {/* ── Document status table ── */}
      <section className="panel" id="dashboard-table">
        <div className="section-heading">
          <h3 className="panel-title">
            <span className="panel-title-dot" />
            Document Status
          </h3>
          <button
            type="button"
            className={`dash-expand-toggle${tableCollapsed ? "" : " dash-expand-toggle--open"}`}
            aria-expanded={!tableCollapsed}
            aria-label={tableCollapsed ? "Show document status table" : "Hide document status table"}
            title={tableCollapsed ? "Show table" : "Hide table"}
            onClick={() => setTableCollapsed((v) => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16">
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </button>
        </div>
        {tableCollapsed ? null : loading ? (
          <div className="empty">Loading…</div>
        ) : error ? (
          <div className="empty">{error}</div>
        ) : filteredRows.length === 0 ? (
          <div className="empty">No employees match the current filters.</div>
        ) : (
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Position</th>
                  <th>Office / Division</th>
                  <th>Progress</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r) => {
                  const isExpanded = expandedIds.has(r.id);
                  return (
                    <Fragment key={r.id}>
                      <tr>
                        <td>
                          <button
                            type="button"
                            className="dash-name-link"
                            title="Open in Add Files to attach documents"
                            onClick={() => onOpenInAddFiles?.(r.id, r.name)}
                          >
                            {r.name}
                          </button>
                        </td>
                        <td>{r.position}</td>
                        <td>{r.officeDivision}</td>
                        <td>
                          <div className="dash-table-progress">
                            <div className="dash-table-progress-track">
                              <div
                                className={`dash-progress-fill dash-progress-fill--${progressBand(r.pct)}`}
                                style={{ width: `${r.pct}%` }}
                              />
                            </div>
                            <span className="dash-table-progress-count">{r.completedCount}/{TOTAL_DOCS}</span>
                          </div>
                        </td>
                        <td>
                          <button
                            type="button"
                            className={`dash-expand-toggle${isExpanded ? " dash-expand-toggle--open" : ""}`}
                            aria-expanded={isExpanded}
                            aria-label={isExpanded ? "Hide documents" : "Show documents"}
                            title={isExpanded ? "Hide documents" : "Show documents"}
                            onClick={() => toggleExpanded(r.id)}
                          >
                            <svg width="14" height="14" viewBox="0 0 16 16">
                              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="dash-table-detail-row">
                          <td colSpan={5}>
                            <div className="dash-card-details">
                              <div className="dash-card-detail-row">
                                <span className="dash-card-detail-label">Documents</span>
                                <span className="dash-missing-cell">
                                  <DocumentChips
                                    completedSet={r.completedSet}
                                    onSelect={(item) => onOpenInAddFiles?.(r.id, r.name, item)}
                                  />
                                </span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
```

## frontend/src/App.jsx

Main app shell: sidebar nav (Dashboard / New User / Add Files / Settings),
auth-gated on mount, SSE-driven data refresh, employee CRUD, document upload,
avatar upload, password change, and (for `admin123`) pending-registration and
user-management panels. Full source lives in `frontend/src/App.jsx`
(1834 lines) — key pieces:

- **Auth gate** (`useEffect` on mount): calls `GET /auth/me`; redirects to
  `/login.html` on 401.
- **Data loading**: `refreshData()` fetches `/jobs`, `/memories`, `/options` in
  parallel; an `EventSource` on `/events` triggers `refreshData()` on server
  `refresh` broadcasts (replaces polling).
- **File upload** (`uploadFile`): `POST /files/:memoryId/:docItem` as
  `multipart/form-data`.
- **Employee CRUD**: `submitUser` → `POST /jobs` (create) or
  `PATCH /memories/:id` (edit); `deleteUser` → `DELETE /memories/:id`.
- **Saved options catalog**: `saveSecondAssignment` / `clearPosition2` /
  `clearOfficeDivision2` → `POST`/`DELETE /options`.
- **Admin panel** (gated on `isAdmin`): approve/reject pending registrations,
  block/unblock/delete system users via `/admin/*` routes.
- **UI primitives**: `CustomSelect` (styled dropdown), `ClearableInput`
  (text input with inline ✕), `UserCard` (memoized, expandable document
  upload card).

## frontend/src/styles.css

Design tokens, sidebar/topbar layout, panels, forms, buttons, dashboard table,
upload states, toast, and a single responsive breakpoint at 780px. See
`frontend/src/styles.css` for the full stylesheet (1155 lines) — omitted
here in full since it's pure CSS with no logic to review.

---

# BACKEND — backend/api

## backend/api/Dockerfile

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

EXPOSE 3000

CMD ["npm", "start"]
```

## backend/api/package.json

```json
{
  "name": "psa-workflow-api",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "cookie-parser": "^1.4.6",
    "cors": "^2.8.5",
    "express": "^4.19.2",
    "express-rate-limit": "^7.3.1",
    "jsonwebtoken": "^9.0.2",
    "minio": "^8.0.2",
    "multer": "^2.0.0",
    "pg": "^8.12.0",
    "pino": "^9.0.0",
    "pino-http": "^10.0.0",
    "redis": "^4.6.15"
  }
}
```

## backend/api/src/logger.js

```javascript
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    level: (label) => ({ level: label })
  },
  base: { service: "psa-api" }
});

export default logger;
```

## backend/api/src/queue.js

```javascript
import { createClient } from "redis";

const queueName = process.env.JOB_QUEUE_NAME ?? "data-jobs";

export const redis = createClient({
  url: process.env.REDIS_URL
});

redis.on("error", (error) => {
  console.error("Redis error", error);
});

export async function enqueueJob(job) {
  await redis.rPush(queueName, JSON.stringify({ id: job.id }));
}
```

## backend/api/src/storage.js

```javascript
import * as Minio from "minio";

const BUCKET = process.env.MINIO_BUCKET ?? "psa-documents";

if (!process.env.MINIO_ACCESS_KEY || !process.env.MINIO_SECRET_KEY) {
  throw new Error("MINIO_ACCESS_KEY and MINIO_SECRET_KEY must be set in environment.");
}

export const minio = new Minio.Client({
  endPoint:  process.env.MINIO_ENDPOINT ?? "minio",
  port:      Number(process.env.MINIO_PORT ?? 9000),
  useSSL:    process.env.MINIO_USE_SSL === "true",
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY
});

/**
 * Called once on startup — idempotent, O(1).
 * Creates the bucket if it does not exist, and applies a private-only
 * policy so objects cannot be fetched without a presigned URL.
 */
export async function ensureBucket() {
  const exists = await minio.bucketExists(BUCKET);
  if (!exists) {
    await minio.makeBucket(BUCKET, "us-east-1");
    // Block all public access — files only served via presigned URLs
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Deny",
        Principal: "*",
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${BUCKET}/*`],
        Condition: {
          StringNotEquals: {
            "s3:signatureversion": ["AWS4-HMAC-SHA256"]
          }
        }
      }]
    });
    await minio.setBucketPolicy(BUCKET, policy);
  }
}

/**
 * Upload a Buffer to MinIO by a server-generated UUID key.
 * O(1) — single object write, user never controls the key.
 */
export async function uploadObject(objectKey, buffer, sizeBytes, contentType = "application/pdf") {
  await minio.putObject(BUCKET, objectKey, buffer, sizeBytes, {
    "Content-Type": contentType
  });
}

/**
 * Generate a presigned GET URL valid for exactly 60 seconds.
 * O(1) — pure HMAC computation, no storage read.
 * After 60 s the URL is mathematically invalid — no revocation needed.
 *
 * MinIO generates URLs using its internal Docker hostname (e.g. "minio:9000").
 * Browsers cannot resolve that hostname, so we rewrite it to the public
 * endpoint before returning the URL to the frontend.
 */
export async function getPresignedUrl(objectKey, expirySeconds = 60) {
  const url = await minio.presignedGetObject(BUCKET, objectKey, expirySeconds);

  // Replace internal Docker hostname with the publicly accessible address.
  // Defaults to localhost:9000 for local dev; override via MINIO_PUBLIC_ENDPOINT.
  const internalHost  = `${process.env.MINIO_ENDPOINT ?? "minio"}:${process.env.MINIO_PORT ?? 9000}`;
  const publicEndpoint = process.env.MINIO_PUBLIC_ENDPOINT ?? "localhost:9000";

  return url.replace(internalHost, publicEndpoint);
}

/**
 * Delete an object from MinIO when a file is replaced.
 * O(1) — direct key delete.
 */
export async function deleteObject(objectKey) {
  try {
    await minio.removeObject(BUCKET, objectKey);
  } catch {
    // Ignore if already deleted — idempotent
  }
}
```

## backend/api/src/db.js

Schema (`ensureSchema`) + all query functions: `memories` (employee records),
`positions` (jobs), `files` (document metadata), `users` (login accounts),
`saved_options`/`hidden_saved_options` (position/office catalog). Full source
in `backend/api/src/db.js` (676 lines) — notable functions:

- `createJob` / `updateMemory` / `deleteMemory` — employee CRUD, all
  transactional, duplicate-name checks via case-insensitive unique lookup.
- `listMemories` — cursor-based pagination (base64url-encoded
  `{ts, id}` cursor).
- `searchUsers` — prefix search ranked by `search_count DESC`.
- `upsertFileMeta` / `getFileMeta` / `deleteFileMeta` — one row per
  `(memory_id, doc_item)` slot, replace semantics via `ON CONFLICT`.
- `getPendingUsers` / `approveUser` / `rejectUser` / `blockUser` /
  `unblockUser` / `deleteSystemUser` / `getAllManagedUsers` — admin user
  management, all excluding the `ADMIN_USERNAME` account from mutation.
- `listSavedOptions` / `addSavedOption` / `deleteSavedOption` — standalone
  position/office-division catalog, independent of any employee record.
- `getDashboardSummary` — one row per employee with an array of completed
  `doc_item`s, used by the Dashboard page.

All queries are parameterized (`$1`, `$2`, …) — no string-built SQL.

## backend/api/src/server.js

Express app. Full source in `backend/api/src/server.js` (911 lines) —
notable pieces:

- **Security middleware**: CORS locked to `CORS_ORIGIN`, 50 KB JSON body cap,
  recursive HTML-tag stripper on all non-`/auth` bodies, global rate limit
  (1000 req/15 min/IP), auth rate limit (20/15 min/IP), upload rate limit
  (5/60s/IP), search rate limit (30/60s/IP).
- **Auth** (`/auth/*`): register (bcrypt cost 12, starts `pending`), login
  (JWT in `httpOnly` cookie, timing-safe via sentinel-hash bcrypt compare on
  unknown usernames), `/auth/me`, avatar upload/proxy, logout (blacklists the
  JWT `jti` in Redis until natural expiry), password change.
- **SSE** (`GET /events`): pushes a `refresh` event to all connected clients
  whenever data changes, instead of the frontend polling.
- **Health** (`GET /health`): checks Postgres, Redis, and MinIO connectivity.
- **Jobs/memories/dashboard/options routes**: CRUD wrapping the `db.js`
  functions above, each broadcasting `refresh` over SSE after a mutation.
- **Files routes**: upload (multer memory storage, 10 MB cap, magic-byte
  `%PDF` check, not just MIME type), view/download (streamed through the API,
  never exposing MinIO directly), delete.
- **Admin routes** (`/admin/*`), gated by `requireAdmin` (username must equal
  `ADMIN_USERNAME`, default `admin123`): pending-user approve/reject, list all
  managed users, block/unblock, delete account.
- **Error handling**: single global error handler; `LIMIT_FILE_SIZE` → 413,
  everything else → the error's own `status` or 500.
- **Startup**: `ensureSchema()` → `redis.connect()` → `ensureBucket()` →
  `app.listen()`.

---

# BACKEND — backend/worker

## backend/worker/Dockerfile

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

CMD ["npm", "start"]
```

## backend/worker/package.json

```json
{
  "name": "psa-workflow-worker",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "node src/worker.js",
    "dev": "node --watch src/worker.js"
  },
  "dependencies": {
    "pg": "^8.12.0",
    "pino": "^9.0.0",
    "redis": "^4.6.15"
  }
}
```

## backend/worker/src/logger.js

```javascript
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    level: (label) => ({ level: label })
  },
  base: { service: "psa-worker" }
});

export default logger;
```

## backend/worker/src/processor.js

```javascript
export function processPayload(payload) {
  const serialized = JSON.stringify(payload);
  const keys = Object.keys(payload);

  return {
    received: payload,
    summary: {
      keyCount: keys.length,
      keys,
      byteSize: Buffer.byteLength(serialized, "utf8"),
      processedAt: new Date().toISOString()
    }
  };
}
```

## backend/worker/src/worker.js

```javascript
import pg from "pg";
import { createClient } from "redis";
import { processPayload } from "./processor.js";
import logger from "./logger.js";

const { Pool } = pg;
const queueName = process.env.JOB_QUEUE_NAME ?? "data-jobs";
const pollMs    = Number(process.env.WORKER_POLL_MS ?? 1000);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (err) => logger.error({ err }, "Redis client error"));

async function markProcessing(jobId) {
  const result = await pool.query(
    "UPDATE positions SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    ["processing", jobId]
  );
  return result.rows[0] ?? null;
}

async function markCompleted(jobId, result) {
  await pool.query(
    "UPDATE positions SET status = $1, result = $2, error = NULL, updated_at = NOW() WHERE id = $3",
    ["completed", result, jobId]
  );
}

async function markFailed(jobId, error) {
  await pool.query(
    "UPDATE positions SET status = $1, error = $2, updated_at = NOW() WHERE id = $3",
    ["failed", error.message, jobId]
  );
}

async function handleQueueItem(rawItem) {
  const item = JSON.parse(rawItem);
  const job  = await markProcessing(item.id);

  if (!job) {
    logger.warn({ jobId: item.id }, "Skipping missing job");
    return;
  }

  const t0 = Date.now();
  try {
    const result = processPayload(job.payload);
    await markCompleted(job.id, result);
    logger.info({ jobId: job.id, ms: Date.now() - t0 }, "Job completed");
  } catch (err) {
    await markFailed(job.id, err);
    logger.error({ err, jobId: job.id }, "Job failed");
  }
}

async function run() {
  await redis.connect();
  logger.info({ queue: queueName }, "Worker listening");

  while (true) {
    try {
      const item = await redis.blPop(queueName, pollMs / 1000);
      if (item) await handleQueueItem(item.element);
    } catch (err) {
      logger.error({ err }, "Worker poll error — retrying in 2s");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function shutdown(signal) {
  logger.info({ signal }, "Graceful shutdown started");
  await redis.quit().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

run().catch((err) => {
  logger.fatal({ err }, "Worker fatal error");
  process.exit(1);
});
```
