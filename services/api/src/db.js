import pg from "pg";

const { Pool } = pg;

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME ?? "admin123").toLowerCase();
// Used in queries: LOWER(username) <> ADMIN_USERNAME prevents admin from being blocked/deleted

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

export async function ensureSchema() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      kind TEXT NOT NULL,
      content JSONB NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `DO $$
    BEGIN
      IF to_regclass('public.jobs') IS NOT NULL
        AND to_regclass('public.positions') IS NULL THEN
        ALTER TABLE jobs RENAME TO positions;
      END IF;
    END $$;`
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
      payload JSONB NOT NULL,
      result JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    "ALTER TABLE positions ADD COLUMN IF NOT EXISTS memory_id UUID REFERENCES memories(id) ON DELETE SET NULL"
  );
  await pool.query("CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind)");
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_memories_cursor ON memories(created_at DESC, id DESC)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_memories_name_prefix ON memories (LOWER(content->>'name') text_pattern_ops)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_memories_position_prefix ON memories (LOWER(content->>'position') text_pattern_ops)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_memories_source_prefix ON memories (LOWER(content->>'source') text_pattern_ops)"
  );
  await pool.query("CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status)");
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_positions_created_at ON positions(created_at DESC)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_positions_memory_id ON positions(memory_id)"
  );

  // Files table — metadata only, binary lives in MinIO
  await pool.query(`
    CREATE TABLE IF NOT EXISTS files (
      id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      memory_id    UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      doc_item     TEXT NOT NULL CHECK (doc_item IN ('A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P')),
      filename     TEXT NOT NULL,
      object_key   TEXT NOT NULL,
      size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
      uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_files_memory_doc ON files (memory_id, doc_item)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_files_memory_id ON files (memory_id)"
  );

  // Auth — system users (admin accounts, not employee records)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      username      TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (LOWER(username))"
  );
  await pool.query(
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_key TEXT"
  );
  await pool.query(
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'"
  );
  await pool.query("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check");
  await pool.query(`
    ALTER TABLE users ADD CONSTRAINT users_status_check
      CHECK (status IN ('pending', 'active', 'blocked', 'rejected'))
  `);

  // Fix: extend doc_item constraint from A–P to A–Q to match frontend slot 'Q' (Others)
  await pool.query(`
    ALTER TABLE files
      DROP CONSTRAINT IF EXISTS files_doc_item_check
  `);
  await pool.query(`
    ALTER TABLE files
      ADD CONSTRAINT files_doc_item_check
      CHECK (doc_item IN ('A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q'))
  `);

  // Index on users.status — prevents full table scan on admin panel queries
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)"
  );

  // Persistent search frequency counter — survives Docker restarts unlike Redis
  await pool.query(
    "ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_count INTEGER NOT NULL DEFAULT 0"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_memories_search_count ON memories(search_count DESC) WHERE kind = 'position_input'"
  );

  // Clean up orphaned position rows left by the old SET NULL delete behavior
  await pool.query("DELETE FROM positions WHERE memory_id IS NULL");
}

export async function createJob(payload) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const duplicateResult = await client.query(
      `SELECT id
       FROM memories
       WHERE kind = $1
         AND LOWER(content->>'name') = LOWER($2)
       LIMIT 1`,
      ["position_input", payload.name ?? ""]
    );

    if (duplicateResult.rowCount > 0) {
      const error = new Error("A user with this name already exists.");
      error.status = 409;
      throw error;
    }

    const memoryResult = await client.query(
      "INSERT INTO memories (kind, content, metadata) VALUES ($1, $2, $3) RETURNING *",
      [
        "position_input",
        payload,
        {
          officeDivision:
            payload.officeDivision ?? payload.source ?? "unknown"
        }
      ]
    );

    const jobResult = await client.query(
      "INSERT INTO positions (memory_id, status, payload) VALUES ($1, $2, $3) RETURNING *",
      [memoryResult.rows[0].id, "queued", payload]
    );

    await client.query("COMMIT");

    return {
      ...jobResult.rows[0],
      memory: memoryResult.rows[0]
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listMemories({ limit = 50, cursor } = {}) {
  const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 200);

  let rows;
  if (cursor) {
    let ts, id;
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      ts = decoded.ts;
      id = decoded.id;
      if (!ts || !id) throw new Error("bad cursor");
    } catch {
      const err = new Error("Invalid pagination cursor.");
      err.status = 400;
      throw err;
    }
    const result = await pool.query(
      `SELECT * FROM memories
       WHERE (created_at < $1) OR (created_at = $1 AND id::text < $2)
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [ts, id, safeLimit + 1]
    );
    rows = result.rows;
  } else {
    const result = await pool.query(
      `SELECT * FROM memories ORDER BY created_at DESC, id DESC LIMIT $1`,
      [safeLimit + 1]
    );
    rows = result.rows;
  }

  const hasMore = rows.length > safeLimit;
  const items   = hasMore ? rows.slice(0, safeLimit) : rows;
  const last    = items[items.length - 1];
  const nextCursor = hasMore
    ? Buffer.from(JSON.stringify({ ts: last.created_at.toISOString(), id: last.id })).toString("base64url")
    : null;

  return { items, nextCursor };
}

export async function searchUsers(searchTerm, limit = 200) {
  const normalizedSearch = searchTerm.trim().toLowerCase();
  if (!normalizedSearch) return [];
  const safeLimit = Math.min(Math.max(1, Number(limit)), 200);
  const result = await pool.query(
    `SELECT * FROM memories
     WHERE kind = $1 AND LOWER(content->>'name') LIKE $2
     ORDER BY search_count DESC, created_at DESC LIMIT $3`,
    ["position_input", `${normalizedSearch}%`, safeLimit]
  );
  return result.rows;
}

export async function getMemoriesByIds(ids) {
  if (!ids.length) return [];
  const result = await pool.query(
    "SELECT * FROM memories WHERE id = ANY($1) AND kind = 'position_input'",
    [ids]
  );
  return result.rows;
}

/**
 * Atomically increment search_count for a memory.
 * O(log n) via idx_memories_search_count.
 * Persistent — survives restarts, no data loss.
 */
export async function incrementSearchCount(memoryId) {
  await pool.query(
    "UPDATE memories SET search_count = search_count + 1 WHERE id = $1",
    [memoryId]
  );
}

/**
 * Top 10 most-searched employees.
 * Primary sort: search_count DESC (frequency).
 * Tie-break: created_at DESC (most recent).
 * O(log n) via partial index on search_count.
 */
export async function getTopUsers() {
  const result = await pool.query(
    `SELECT * FROM memories
     WHERE kind = 'position_input'
     ORDER BY search_count DESC, created_at DESC
     LIMIT 10`
  );
  return result.rows;
}

export async function updateMemory(id, updates) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existingResult = await client.query(
      "SELECT * FROM memories WHERE id = $1",
      [id]
    );
    const existingMemory = existingResult.rows[0];

    if (!existingMemory) {
      await client.query("ROLLBACK");
      return null;
    }

    const nextContent = {
      ...existingMemory.content,
      ...updates,
      updatedAt: new Date().toISOString()
    };

    if (nextContent.name) {
      const duplicateResult = await client.query(
        `SELECT id
         FROM memories
         WHERE kind = $1
           AND id <> $2
           AND LOWER(content->>'name') = LOWER($3)
         LIMIT 1`,
        ["position_input", id, nextContent.name]
      );

      if (duplicateResult.rowCount > 0) {
        const error = new Error("A user with this name already exists.");
        error.status = 409;
        throw error;
      }
    }

    const memoryResult = await client.query(
      "UPDATE memories SET content = $1, metadata = $2 WHERE id = $3 RETURNING *",
      [
        nextContent,
        {
          ...existingMemory.metadata,
          officeDivision:
            nextContent.officeDivision ?? nextContent.source ?? "unknown"
        },
        id
      ]
    );

    await client.query(
      "UPDATE positions SET payload = $1, updated_at = NOW() WHERE memory_id = $2",
      [nextContent, id]
    );

    await client.query("COMMIT");
    return memoryResult.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Delete an employee record and all linked data.
 * Files rows are removed via ON DELETE CASCADE.
 * Returns the MinIO object_keys of files so the caller can delete them from storage.
 * All queries use $1 parameterized placeholders — no SQL injection possible.
 * Complexity: O(log n) PK lookup + O(k) file rows (max 17 per employee).
 */
export async function deleteMemory(id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Verify record exists and is an employee record (not another kind)
    const check = await client.query(
      "SELECT id FROM memories WHERE id = $1 AND kind = 'position_input' LIMIT 1",
      [id]
    );
    if (check.rowCount === 0) return null;

    // Collect file object_keys BEFORE cascade delete removes the rows
    const filesResult = await client.query(
      "SELECT object_key FROM files WHERE memory_id = $1",
      [id]
    );
    const objectKeys = filesResult.rows.map(r => r.object_key);

    // Delete linked position record before memory (prevents SET NULL orphan)
    await client.query("DELETE FROM positions WHERE memory_id = $1", [id]);

    // Delete memory — files CASCADE deleted
    await client.query("DELETE FROM memories WHERE id = $1", [id]);

    await client.query("COMMIT");
    return { objectKeys };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listJobs() {
  const result = await pool.query(
    "SELECT * FROM positions ORDER BY created_at DESC LIMIT 100"
  );

  return result.rows;
}

export async function getJob(id) {
  const result = await pool.query("SELECT * FROM positions WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

/**
 * Atomically upsert a file metadata row.
 * ON CONFLICT replaces the old row (replace semantics — one file per slot).
 * Returns the old object_key so the caller can delete the replaced MinIO object.
 * Complexity: O(log n) via composite unique index.
 */
export async function upsertFileMeta(memoryId, docItem, filename, objectKey, sizeBytes) {
  const result = await pool.query(
    `INSERT INTO files (memory_id, doc_item, filename, object_key, size_bytes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (memory_id, doc_item) DO UPDATE
       SET filename   = EXCLUDED.filename,
           object_key = EXCLUDED.object_key,
           size_bytes = EXCLUDED.size_bytes,
           uploaded_at = NOW()
     RETURNING *`,
    [memoryId, docItem, filename, objectKey, sizeBytes]
  );
  return result.rows[0];
}

/**
 * Get file metadata for a single doc slot.
 * Complexity: O(log n) via composite unique index — effectively O(1) per user (max 16 slots).
 */
export async function getFileMeta(memoryId, docItem) {
  const result = await pool.query(
    "SELECT * FROM files WHERE memory_id=$1 AND doc_item=$2",
    [memoryId, docItem]
  );
  return result.rows[0] ?? null;
}

/**
 * List all uploaded files for one user.
 * Returns at most 16 rows (one per doc item A-P).
 * Complexity: O(log n) index scan on memory_id.
 */
export async function listFilesForMemory(memoryId) {
  const result = await pool.query(
    "SELECT * FROM files WHERE memory_id=$1 ORDER BY doc_item",
    [memoryId]
  );
  return result.rows;
}

/**
 * Delete a file metadata row (called when replacing a file).
 * Complexity: O(log n).
 */
export async function deleteFileMeta(memoryId, docItem) {
  const result = await pool.query(
    "DELETE FROM files WHERE memory_id=$1 AND doc_item=$2 RETURNING object_key",
    [memoryId, docItem]
  );
  return result.rows[0]?.object_key ?? null;
}

export async function insertFileMeta(memoryId, docItem, filename, objectKey, sizeBytes) {
  const result = await pool.query(
    `INSERT INTO files (memory_id, doc_item, filename, object_key, size_bytes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [memoryId, docItem, filename, objectKey, sizeBytes]
  );
  return result.rows[0];
}

export async function deleteFileMetaById(fileId) {
  const result = await pool.query(
    "DELETE FROM files WHERE id=$1 RETURNING object_key, memory_id",
    [fileId]
  );
  return result.rows[0] ?? null;
}

export async function getFileMetaById(fileId) {
  const result = await pool.query(
    "SELECT * FROM files WHERE id=$1 LIMIT 1",
    [fileId]
  );
  return result.rows[0] ?? null;
}

export async function getPendingUsers() {
  const result = await pool.query(
    "SELECT id, username, created_at FROM users WHERE status = 'pending' ORDER BY created_at ASC"
  );
  return result.rows;
}

export async function getAllManagedUsers() {
  const result = await pool.query(
    "SELECT id, username, status, created_at FROM users WHERE LOWER(username) <> $1 ORDER BY created_at DESC LIMIT 200",
    [ADMIN_USERNAME]
  );
  return result.rows;
}

export async function blockUser(userId) {
  const result = await pool.query(
    "UPDATE users SET status = 'blocked' WHERE id = $1 AND LOWER(username) <> $2 RETURNING id, username, status",
    [userId, ADMIN_USERNAME]
  );
  return result.rows[0] ?? null;
}

export async function unblockUser(userId) {
  const result = await pool.query(
    "UPDATE users SET status = 'active' WHERE id = $1 AND status = 'blocked' RETURNING id, username, status",
    [userId]
  );
  return result.rows[0] ?? null;
}

export async function approveUser(userId) {
  const result = await pool.query(
    "UPDATE users SET status = 'active' WHERE id = $1 AND status = 'pending' RETURNING id, username, status",
    [userId]
  );
  return result.rows[0] ?? null;
}

export async function rejectUser(userId) {
  const result = await pool.query(
    "DELETE FROM users WHERE id = $1 AND status = 'pending' RETURNING id, username",
    [userId]
  );
  return result.rows[0] ?? null;
}

export async function deleteSystemUser(userId) {
  const result = await pool.query(
    "DELETE FROM users WHERE id = $1 AND LOWER(username) <> $2 RETURNING id, username",
    [userId, ADMIN_USERNAME]
  );
  return result.rows[0] ?? null;
}

/**
 * One row per employee with the set of doc_items they have an uploaded file for.
 * Used by the Dashboard page to compute per-employee completion.
 */
export async function getDashboardSummary() {
  const result = await pool.query(`
    SELECT
      m.id,
      m.content->>'name' AS name,
      m.content->>'position' AS position,
      COALESCE(m.content->>'officeDivision', m.content->>'source', 'unknown') AS office_division,
      COALESCE(
        ARRAY_AGG(f.doc_item) FILTER (WHERE f.doc_item IS NOT NULL),
        ARRAY[]::text[]
      ) AS completed_items
    FROM memories m
    LEFT JOIN files f ON f.memory_id = m.id
    WHERE m.kind = 'position_input'
    GROUP BY m.id
    ORDER BY m.created_at DESC
  `);
  return result.rows;
}
