-- Additive: existing workspace, account IDs, tasks and artifacts remain untouched.
CREATE TABLE IF NOT EXISTS hub_v2_clock (
  workspace_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, mutation_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hub_v2_records (
  workspace_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '', parent_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY(workspace_id, kind, id)
);
CREATE INDEX IF NOT EXISTS hub_v2_scope ON hub_v2_records(workspace_id,kind,scope_id,updated_at,id);
CREATE INDEX IF NOT EXISTS hub_v2_parent ON hub_v2_records(workspace_id,kind,parent_id,updated_at,id);
CREATE INDEX IF NOT EXISTS hub_v2_status ON hub_v2_records(workspace_id,kind,status,updated_at,id);
CREATE INDEX IF NOT EXISTS hub_v2_feed ON hub_v2_records(workspace_id,kind,scope_id,sequence,id);
CREATE TABLE IF NOT EXISTS hub_v2_receipts (
  workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(workspace_id, request_id)
);

-- Small attachments are supported on accounts without R2 activation.
-- Immutable content-addressed chunks stay below D1's per-row limit.
CREATE TABLE IF NOT EXISTS hub_v2_file_chunks (
  object_key TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (object_key, chunk_index)
);
