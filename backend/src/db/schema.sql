CREATE TABLE IF NOT EXISTS server_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  comfy_host TEXT NOT NULL DEFAULT '',
  ollama_host TEXT NOT NULL DEFAULT '',
  piper_host TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('url','text')),
  source_ref TEXT NOT NULL,
  language TEXT NOT NULL,
  voice_a TEXT NOT NULL,
  voice_b TEXT NOT NULL,
  mix INTEGER NOT NULL DEFAULT 0,
  escaleta TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
  stage TEXT NOT NULL DEFAULT '',
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  output_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
