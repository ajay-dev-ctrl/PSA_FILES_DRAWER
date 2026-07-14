import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { randomUUID } from "crypto";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import logger from "./logger.js";
import {
  createJob,
  ensureSchema,
  getJob,
  listJobs,
  listMemories,
  pool,
  searchUsers,
  updateMemory,
  upsertFileMeta,
  getFileMeta,
  listFilesForMemory,
  insertFileMeta,
  deleteFileMetaById,
  getFileMetaById,
  getPendingUsers,
  approveUser,
  rejectUser,
  getAllManagedUsers,
  blockUser,
  unblockUser,
  deleteSystemUser,
  getMemoriesByIds,
  incrementSearchCount,
  getTopUsers,
  deleteMemory,
  getDashboardSummary,
} from "./db.js";
import { enqueueJob, redis } from "./queue.js";
import { ensureBucket, uploadObject, getPresignedUrl, deleteObject } from "./storage.js";

const app  = express();
const port = Number(process.env.PORT ?? 3000);

// ── JWT secret validation (fail fast at startup) ──────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET must be set in environment.");

// Precompute sentinel hash once — used in /auth/login to prevent timing-based
// user enumeration (bcrypt always runs even when the username doesn't exist).
const _sentinelHash = await bcrypt.hash("__sentinel__", 12);

// ── Structured request logging — every req gets a unique request ID ──────────
app.use(pinoHttp({
  logger,
  genReqId: () => randomUUID(),
  customLogLevel: (_req, res) => res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
  serializers: {
    req: (req) => ({ method: req.method, url: req.url, id: req.id }),
    res: (res) => ({ statusCode: res.statusCode })
  }
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

// ── JSON body (50 KB cap — blocks JSON bomb) ──────────────────────────────────
app.use(express.json({ limit: "50kb" }));

// ── Cookie parser ─────────────────────────────────────────────────────────────
app.use(cookieParser());

// ── XSS sanitizer (skip /auth/* — passwords must not be modified) ─────────────
function sanitizePayload(obj, depth = 0) {
  if (depth > 10) throw new Error("Payload nesting too deep");
  if (typeof obj !== "object" || obj === null) return obj;
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === "string") {
      obj[key] = obj[key].replace(/<[^>]*>?/gm, "").trim();
    } else if (typeof obj[key] === "object") {
      sanitizePayload(obj[key], depth + 1);
    }
  }
  return obj;
}
app.use((req, res, next) => {
  if (req.body && !req.path.startsWith("/auth")) req.body = sanitizePayload(req.body);
  next();
});

// ── Rate limiter for file uploads ─────────────────────────────────────────────
// 5 uploads per IP per 60 seconds — blocks flood attacks at O(1)
const uploadLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many uploads from this IP. Please wait 60 seconds." }
});

// ── Global rate limiter — 1000 req / 15 min per IP ───────────────────────────
// Skip /events (SSE connections are long-lived, not per-request)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/events",
  message: { error: "Too many requests. Please wait 15 minutes." }
});
app.use(globalLimiter);

// ── SSE client registry ───────────────────────────────────────────────────────
const sseClients = new Set();

function broadcast(event, data = {}) {
  if (sseClients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

// ── Multer: memory storage, 10 MB hard cap, PDF only ─────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },   // 10 MB — rejected before MinIO write
  fileFilter(_req, file, cb) {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(Object.assign(new Error("Only PDF files are accepted."), { status: 400 }));
    }
  }
});

// ── Multer: avatar images, 2 MB cap ──────────────────────────────────────────
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error("Only JPEG, PNG, WebP, or GIF images are accepted."), { status: 400 }));
    }
  }
});

function detectImageMime(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  return null;
}

// ── Valid doc items (A–Q) ─────────────────────────────────────────────────────
const VALID_DOC_ITEMS = new Set("ABCDEFGHIJKLMNOPQ".split(""));

// ── Sanitize filename: only safe characters ───────────────────────────────────
function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._\- ]/g, "_").slice(0, 200);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  const token = req.cookies?.auth_token;
  if (!token) return res.status(401).json({ error: "Not authenticated." });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // O(1) Redis check — token blacklisted on logout so copied tokens die immediately
    if (payload.jti && await redis.get(`bl:${payload.jti}`)) {
      res.clearCookie("auth_token");
      return res.status(401).json({ error: "Session has been revoked. Please sign in again." });
    }
    req.user = payload;
    next();
  } catch {
    res.clearCookie("auth_token");
    return res.status(401).json({ error: "Session expired. Please sign in again." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// 20 auth attempts per 15 min per IP — prevents server-side brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts. Please wait 15 minutes." }
});

app.post("/auth/register", authLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body ?? {};

    if (!username || typeof username !== "string" || username.trim().length < 3) {
      return res.status(400).json({ error: "Username must be at least 3 characters." });
    }
    if (!password || typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    if (!/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      return res.status(400).json({ error: "Password must include uppercase, number, and symbol." });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    try {
      await pool.query(
        "INSERT INTO users (username, password_hash, status) VALUES (LOWER($1), $2, 'pending')",
        [username.trim(), passwordHash]
      );
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "Username already taken." });
      throw err;
    }

    res.status(201).json({ success: true, pending: true });
  } catch (err) { next(err); }
});

app.post("/auth/login", authLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body ?? {};

    if (!username || typeof username !== "string" || !password || typeof password !== "string") {
      return res.status(400).json({ error: "Username and password required." });
    }

    const result = await pool.query(
      "SELECT id, username, password_hash, status FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1",
      [username.trim()]
    );
    const user = result.rows[0];

    // Always run bcrypt (sentinel hash when user not found) — prevents timing-based
    // user enumeration: attacker cannot distinguish "user not found" from "wrong password"
    const match = await bcrypt.compare(password, user?.password_hash ?? _sentinelHash);

    if (!user || !match) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    if (user.status === "pending") {
      return res.status(403).json({ error: "Account pending system validation.", pending: true });
    }
    if (user.status === "blocked") {
      return res.status(403).json({ error: "Account access has been restricted." });
    }
    if (user.status === "rejected") {
      return res.status(403).json({ error: "Account validation unsuccessful." });
    }

    const token = jwt.sign(
      { sub: user.id, username: user.username, jti: randomUUID() },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.cookie("auth_token", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 1000
    });

    res.json({ success: true, username: user.username });
  } catch (err) { next(err); }
});

app.get("/auth/me", requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT avatar_key FROM users WHERE id = $1 LIMIT 1",
      [req.user.sub]
    );
    const hasAvatar = !!result.rows[0]?.avatar_key;
    const isAdmin = req.user.username?.toLowerCase() === ADMIN_USERNAME;
    res.json({ username: req.user.username, hasAvatar, isAdmin });
  } catch (err) { next(err); }
});

// Proxy avatar image through API — avoids MinIO URL accessibility issues in browser
app.get("/auth/avatar-proxy", requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT avatar_key FROM users WHERE id = $1 LIMIT 1",
      [req.user.sub]
    );
    const avatarKey = result.rows[0]?.avatar_key;
    if (!avatarKey) return res.status(404).end();

    const ext = avatarKey.split(".").pop().toLowerCase();
    const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
    res.setHeader("Content-Type", mimeMap[ext] ?? "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");

    const { minio } = await import("./storage.js");
    const BUCKET = process.env.MINIO_BUCKET ?? "psa-documents";
    const stream = await minio.getObject(BUCKET, avatarKey);
    stream.pipe(res);
  } catch (err) { next(err); }
});

app.post(
  "/auth/avatar",
  requireAuth,
  uploadLimiter,
  avatarUpload.single("avatar"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No image uploaded." });

      const mime = detectImageMime(req.file.buffer.subarray(0, 12));
      if (!mime) return res.status(400).json({ error: "File content is not a valid image." });

      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[mime];
      const objectKey = `avatars/${randomUUID()}.${ext}`;

      const existing = await pool.query(
        "SELECT avatar_key FROM users WHERE id = $1 LIMIT 1",
        [req.user.sub]
      );
      const oldKey = existing.rows[0]?.avatar_key ?? null;

      await uploadObject(objectKey, req.file.buffer, req.file.size, mime);
      await pool.query("UPDATE users SET avatar_key = $1 WHERE id = $2", [objectKey, req.user.sub]);
      if (oldKey && oldKey !== objectKey) await deleteObject(oldKey);

      const avatarUrl = await getPresignedUrl(objectKey, 3600);
      res.json({ avatarUrl });
    } catch (err) { next(err); }
  }
);

app.post("/auth/logout", async (req, res) => {
  const token = req.cookies?.auth_token;
  if (token) {
    try {
      // Blacklist the token's jti until its natural expiry — O(1) Redis SET with TTL
      const payload = jwt.decode(token);
      if (payload?.jti && payload?.exp) {
        const ttl = payload.exp - Math.floor(Date.now() / 1000);
        if (ttl > 0) await redis.set(`bl:${payload.jti}`, "1", { EX: ttl });
      }
    } catch { /* ignore decode errors */ }
  }
  res.clearCookie("auth_token", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production"
  });
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// EXISTING ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// ── SSE endpoint — replaces client-side polling ───────────────────────────────
app.get("/events", requireAuth, (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");  // disable nginx buffering
  res.flushHeaders();

  res.write("event: connected\ndata: {}\n\n");
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { /* ignore */ }
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.get("/health", async (_req, res) => {
  const checks = {};

  try { await pool.query("SELECT 1"); checks.postgres = "ok"; }
  catch { checks.postgres = "error"; }

  try { await redis.ping(); checks.redis = "ok"; }
  catch { checks.redis = "error"; }

  try {
    const { minio } = await import("./storage.js");
    await minio.bucketExists(process.env.MINIO_BUCKET ?? "psa-documents");
    checks.minio = "ok";
  } catch { checks.minio = "error"; }

  const allOk = Object.values(checks).every((v) => v === "ok");
  res.status(allOk ? 200 : 503).json({ ok: allOk, checks, service: "api" });
});

app.post("/jobs", requireAuth, async (req, res, next) => {
  try {
    const payload = req.body?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return res.status(400).json({ error: "Request body must include a payload object." });
    }
    const job = await createJob(payload);
    await enqueueJob(job);
    res.status(202).json(job);
    broadcast("refresh");
  } catch (err) { next(err); }
});

app.get("/jobs", requireAuth, async (_req, res, next) => {
  try { res.json(await listJobs()); } catch (err) { next(err); }
});

app.get("/memories", requireAuth, async (req, res, next) => {
  try {
    const limit  = req.query.limit  ? Number(req.query.limit)  : 50;
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
    res.json(await listMemories({ limit, cursor }));
  } catch (err) { next(err); }
});

app.get("/dashboard/summary", requireAuth, async (_req, res, next) => {
  try { res.json(await getDashboardSummary()); } catch (err) { next(err); }
});

const searchLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many searches. Please wait a moment." }
});

/**
 * GET /users/search?q=...
 * Returns ALL name-prefix matches, ranked by search_count DESC then recency DESC.
 * Algorithm: O(log n) prefix index scan — search_count column is part of the result row,
 * so no second query needed. PostgreSQL sorts in-place.
 */
app.get("/users/search", requireAuth, searchLimiter, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "").slice(0, 100);
    res.json(await searchUsers(q, 200));
  } catch (err) { next(err); }
});

/**
 * GET /users/top
 * Top 10 most-searched employees — persistent PostgreSQL rank.
 * ORDER BY search_count DESC, created_at DESC LIMIT 10.
 * O(log n) via partial index idx_memories_search_count.
 */
app.get("/users/top", requireAuth, async (req, res, next) => {
  try {
    res.json(await getTopUsers());
  } catch (err) { next(err); }
});

/**
 * POST /users/:memoryId/search-hit
 * Atomically increments search_count in PostgreSQL — persistent, never resets.
 * O(log n) index update.
 */
app.post("/users/:memoryId/search-hit", requireAuth, async (req, res, next) => {
  try {
    await incrementSearchCount(req.params.memoryId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.patch("/memories/:id", requireAuth, async (req, res, next) => {
  try {
    const updates = req.body?.updates;
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      return res.status(400).json({ error: "Request body must include an updates object." });
    }
    const memory = await updateMemory(req.params.id, updates);
    if (!memory) return res.status(404).json({ error: "Memory not found." });
    res.json(memory);
    broadcast("refresh");
  } catch (err) { next(err); }
});

app.get("/jobs/:id", requireAuth, async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found." });
    res.json(job);
  } catch (err) { next(err); }
});

// UUID format validation — rejects malformed IDs before they reach the DB
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DELETE /memories/:id
 * Permanently deletes an employee record, all file metadata (CASCADE),
 * and all associated MinIO objects.
 * Security: requireAuth, UUID validation, parameterized queries only, kind check.
 */
app.delete("/memories/:id", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    // Reject non-UUID inputs immediately — no DB query needed
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: "Invalid ID format." });
    }

    const result = await deleteMemory(id);
    if (!result) return res.status(404).json({ error: "User not found." });

    // Delete all associated MinIO objects (fire-and-forget per object — non-fatal if already gone)
    const { deleteObject } = await import("./storage.js");
    await Promise.allSettled(result.objectKeys.map(key => deleteObject(key)));

    // Invalidate Redis file cache for this memory
    await redis.del(`filesv2:${id}`);

    broadcast("refresh");
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// FILE ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /files/:memoryId
 * List all uploaded doc items for a user.
 * Hot path: Redis cache GET → O(1).
 * Cold path: DB index scan → O(log n).
 */
app.get("/files/:memoryId", requireAuth, async (req, res, next) => {
  try {
    const { memoryId } = req.params;
    const cacheKey = `filesv2:${memoryId}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    } catch { /* stale cache type — fall through */ }

    const rows = await listFilesForMemory(memoryId);
    const files = rows.map(r => ({
      id:         r.id,
      docItem:    r.doc_item,
      filename:   r.filename,
      sizeBytes:  r.size_bytes,
      uploadedAt: r.uploaded_at
    }));

    if (files.length > 0) {
      await redis.set(cacheKey, JSON.stringify(files), { EX: 300 });
    }

    res.json(files);
  } catch (err) { next(err); }
});

/**
 * GET /files/:memoryId/:docItem/url
 * Get a 60-second presigned URL to view the PDF.
 */
app.get("/files/:memoryId/:docItem/url", requireAuth, async (req, res, next) => {
  try {
    const { memoryId, docItem } = req.params;

    if (!VALID_DOC_ITEMS.has(docItem.toUpperCase())) {
      return res.status(400).json({ error: "Invalid document item." });
    }

    const meta = await getFileMeta(memoryId, docItem.toUpperCase());
    if (!meta) {
      return res.status(404).json({ error: "File not found." });
    }

    const url = await getPresignedUrl(meta.object_key);
    res.json({ url, filename: meta.filename, expiresIn: 60 });
  } catch (err) { next(err); }
});

/**
 * GET /files/:memoryId/:docItem/view
 * Stream the PDF inline through the API so the browser can render it directly.
 */
app.get("/files/:memoryId/:docItem/view", requireAuth, async (req, res, next) => {
  try {
    const { memoryId, docItem } = req.params;

    if (!VALID_DOC_ITEMS.has(docItem.toUpperCase())) {
      return res.status(400).json({ error: "Invalid document item." });
    }

    const meta = await getFileMeta(memoryId, docItem.toUpperCase());
    if (!meta) return res.status(404).json({ error: "File not found." });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${meta.filename}"`);
    res.setHeader("Cache-Control", "private, max-age=60");

    const { minio } = await import("./storage.js");
    const BUCKET = process.env.MINIO_BUCKET ?? "psa-documents";
    const stream = await minio.getObject(BUCKET, meta.object_key);
    stream.pipe(res);
  } catch (err) { next(err); }
});

/**
 * GET /files/:memoryId/:docItem/download
 * Download the PDF by proxying it through the API.
 */
app.get("/files/:memoryId/:docItem/download", requireAuth, async (req, res, next) => {
  try {
    const { memoryId, docItem } = req.params;

    if (!VALID_DOC_ITEMS.has(docItem.toUpperCase())) {
      return res.status(400).json({ error: "Invalid document item." });
    }

    const meta = await getFileMeta(memoryId, docItem.toUpperCase());
    if (!meta) {
      return res.status(404).json({ error: "File not found." });
    }

    const { minio } = await import("./storage.js");
    const BUCKET = process.env.MINIO_BUCKET ?? "psa-documents";
    const stream = await minio.getObject(BUCKET, meta.object_key);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(meta.filename)}"`
    );
    stream.pipe(res);
  } catch (err) { next(err); }
});

/**
 * POST /files/:memoryId/:docItem
 * Upload a PDF for a document slot (append — multiple files per slot allowed).
 * Rate limited: 5 uploads per IP per 60 s.
 */
app.post(
  "/files/:memoryId/:docItem",
  requireAuth,
  uploadLimiter,
  upload.single("file"),
  async (req, res, next) => {
    try {
      const { memoryId, docItem } = req.params;

      if (!VALID_DOC_ITEMS.has(docItem.toUpperCase())) {
        return res.status(400).json({ error: "Invalid document item." });
      }
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded." });
      }

      const magic = req.file.buffer.subarray(0, 4).toString("ascii");
      if (magic !== "%PDF") {
        return res.status(400).json({ error: "File content is not a valid PDF." });
      }

      const memCheck = await pool.query("SELECT id FROM memories WHERE id=$1 LIMIT 1", [memoryId]);
      if (memCheck.rowCount === 0) {
        return res.status(404).json({ error: "User not found." });
      }

      const objectKey    = `${randomUUID()}.pdf`;
      const safeFilename = sanitizeFilename(req.file.originalname);

      await uploadObject(objectKey, req.file.buffer, req.file.size);

      // upsertFileMeta replaces any existing row for this slot (ON CONFLICT DO UPDATE)
      // and returns the old object_key so we can delete the replaced MinIO object
      const existing = await getFileMeta(memoryId, docItem.toUpperCase());
      const row = await upsertFileMeta(memoryId, docItem.toUpperCase(), safeFilename, objectKey, req.file.size);
      if (existing?.object_key && existing.object_key !== objectKey) {
        await deleteObject(existing.object_key).catch(() => {});
      }

      await redis.del(`filesv2:${memoryId}`);

      res.status(201).json({
        id:        row.id,
        docItem:   docItem.toUpperCase(),
        filename:  safeFilename,
        sizeBytes: req.file.size
      });
    } catch (err) { next(err); }
  }
);

app.delete("/files/:memoryId/:docItem/:fileId", requireAuth, async (req, res, next) => {
  try {
    const { memoryId, fileId } = req.params;

    const row = await deleteFileMetaById(fileId);
    if (!row) return res.status(404).json({ error: "File not found." });

    await deleteObject(row.object_key);
    await redis.del(`filesv2:${memoryId}`);

    res.json({ success: true });
  } catch (err) { next(err); }
});

app.get("/files/:memoryId/:docItem/:fileId/download", requireAuth, async (req, res, next) => {
  try {
    const { fileId } = req.params;
    const meta = await getFileMetaById(fileId);
    if (!meta) return res.status(404).json({ error: "File not found." });

    const { minio } = await import("./storage.js");
    const BUCKET = process.env.MINIO_BUCKET ?? "psa-documents";
    const stream = await minio.getObject(BUCKET, meta.object_key);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(meta.filename)}"`);
    stream.pipe(res);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME ?? "admin123").toLowerCase();

function requireAdmin(req, res, next) {
  if (req.user?.username?.toLowerCase() !== ADMIN_USERNAME) {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

app.get("/admin/pending-users", requireAuth, requireAdmin, async (req, res, next) => {
  try { res.json(await getPendingUsers()); } catch (err) { next(err); }
});

app.post("/admin/approve/:userId", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const user = await approveUser(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found or already active." });
    res.json({ success: true, user });
  } catch (err) { next(err); }
});

app.post("/admin/reject/:userId", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const user = await rejectUser(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found or not pending." });
    res.json({ success: true, user });
  } catch (err) { next(err); }
});

app.get("/admin/users", requireAuth, requireAdmin, async (req, res, next) => {
  try { res.json(await getAllManagedUsers()); } catch (err) { next(err); }
});

app.post("/admin/block/:userId", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const user = await blockUser(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found." });
    res.json({ success: true, user });
  } catch (err) { next(err); }
});

app.post("/admin/unblock/:userId", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const user = await unblockUser(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found or not blocked." });
    res.json({ success: true, user });
  } catch (err) { next(err); }
});

app.delete("/admin/users/:userId", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!UUID_RE.test(userId)) return res.status(400).json({ error: "Invalid ID format." });
    const user = await deleteSystemUser(userId);
    if (!user) return res.status(404).json({ error: "User not found or cannot be deleted." });
    res.json({ success: true, user });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE PASSWORD
// ─────────────────────────────────────────────────────────────────────────────

app.patch("/auth/password", requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};

    if (!currentPassword || typeof currentPassword !== "string" ||
        !newPassword   || typeof newPassword   !== "string") {
      return res.status(400).json({ error: "Both current and new password are required." });
    }
    if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) ||
        !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
      return res.status(400).json({ error: "New password must be 8+ characters with an uppercase letter, number, and symbol." });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: "New password must be different from the current password." });
    }

    const result = await pool.query(
      "SELECT password_hash FROM users WHERE id = $1 LIMIT 1",
      [req.user.sub]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: "User not found." });

    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) return res.status(401).json({ error: "Current password is incorrect." });

    const newHash = await bcrypt.hash(newPassword, 12);
    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [newHash, req.user.sub]);

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Global error handler ───────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  const log = req.log ?? logger;
  log.error({ err, reqId: req.id }, "Unhandled request error");
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File exceeds 10 MB limit." });
  }
  res.status(err.status ?? 500).json({
    error: err.status ? err.message : "Internal server error."
  });
});

// ── Startup ────────────────────────────────────────────────────────────────────
await ensureSchema();
await redis.connect();
await ensureBucket();   // Creates MinIO bucket if not exists (idempotent)

app.listen(port, () => {
  logger.info({ port }, "API listening");
});
