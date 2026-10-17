CREATE TABLE IF NOT EXISTS server_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  comfy_host TEXT NOT NULL DEFAULT '',
  ollama_host TEXT NOT NULL DEFAULT '',
  kokoro_host TEXT NOT NULL DEFAULT ''
);
