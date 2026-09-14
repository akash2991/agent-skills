-- Agent Brain control plane. One SQLite database holds recorded agent-work usage: the metadata-only
-- events that harness hooks capture, and which of them have been exported. Who is running, in which
-- pane, on which model and effort, is firstmate's state and is not duplicated here. Durable
-- documents (ORG.md, CONVENTIONS.md, HLD/LLD, DECISIONS) stay as markdown.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Settings. Values are strings so UNKNOWN is representable.
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- Observability events. Columns mirror the metadata-only event contract in event.schema.json;
-- `raw` keeps the original JSON so nothing is lost when the contract grows.
CREATE TABLE IF NOT EXISTS events (
  event_id                TEXT PRIMARY KEY,
  timestamp               TEXT NOT NULL,
  type                    TEXT NOT NULL,
  agent_id                TEXT NOT NULL,
  parent_agent_id         TEXT,
  session_id              TEXT,
  trace_id                TEXT,
  span_id                 TEXT,
  parent_span_id          TEXT,
  role                    TEXT,
  ticket                  TEXT,
  status                  TEXT,
  model                   TEXT,
  effort                  TEXT,
  duration_ms             REAL,
  error_type              TEXT,
  input_tokens            INTEGER,
  output_tokens           INTEGER,
  -- Reasoning tokens, reported by the harness inside output_tokens_details. Counted within
  -- output_tokens by the provider, so it is a breakdown, never added on top.
  thinking_tokens         INTEGER,
  cache_read_tokens       INTEGER,
  cache_write_tokens      INTEGER,
  cost_usd                REAL,
  usage_source            TEXT,
  context_input_tokens    INTEGER,
  context_window_tokens   INTEGER,
  context_measurement     TEXT,
  artifact_kind           TEXT,
  artifact_name           TEXT,
  artifact_path           TEXT,
  artifact_bytes          INTEGER,
  artifact_tokens         INTEGER,
  artifact_measurement    TEXT,
  artifact_sha256         TEXT,
  turn_number             INTEGER,
  turn_outcome            TEXT,
  tool_name               TEXT,
  tool_outcome            TEXT,
  raw                     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, timestamp);
CREATE INDEX IF NOT EXISTS events_type  ON events(type, timestamp);

-- Which events have been shipped to an external observability backend. The marker lives here rather
-- than as a column on events so a second backend can be added without another migration, and so an
-- interrupted export resumes instead of re-sending everything.
CREATE TABLE IF NOT EXISTS exports (
  event_id    TEXT NOT NULL,
  backend     TEXT NOT NULL,
  exported_at TEXT NOT NULL,
  PRIMARY KEY (event_id, backend)
);
