CREATE TABLE IF NOT EXISTS hub_human_read (
 workspace_id TEXT NOT NULL,
 user_id TEXT NOT NULL DEFAULT 'owner',
 channel_id TEXT NOT NULL,
 number INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,user_id,channel_id)
);
