CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind TEXT NOT NULL,
  content JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  payload JSONB NOT NULL,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Metadata-only file table (binary stored in MinIO, not here)
CREATE TABLE IF NOT EXISTS files (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  memory_id    UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  doc_item     TEXT NOT NULL CHECK (doc_item IN ('A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q')),
  filename     TEXT NOT NULL,
  object_key   TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  mime_type    TEXT NOT NULL DEFAULT 'application/pdf',
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_name_prefix
  ON memories (LOWER(content->>'name') text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_memories_position_prefix
  ON memories (LOWER(content->>'position') text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_memories_source_prefix
  ON memories (LOWER(content->>'source') text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_created_at ON positions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_positions_memory_id ON positions(memory_id);

-- O(log n)→O(1) lookup: one file per doc slot per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_memory_doc
  ON files (memory_id, doc_item);
CREATE INDEX IF NOT EXISTS idx_files_memory_id
  ON files (memory_id);

