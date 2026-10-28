CREATE TABLE IF NOT EXISTS hub_workspace (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  mutation_id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hub_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  at TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hub_events_workspace_time ON hub_events(workspace_id, at DESC);
CREATE TABLE IF NOT EXISTS hub_artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
