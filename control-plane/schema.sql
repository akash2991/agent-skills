-- Agent Brain control plane. One SQLite database holds every piece of mutable runtime state:
-- sessions (with the single-CEO lock), the agent registry, observability events, budgets, and an
-- audit trail of runtime changes. Durable *documents* (ORG.md, CONVENTIONS.md, HLD/LLD, DECISIONS)
-- stay as markdown; only state that changes while agents work lives here.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Company budget and settings. Values are strings so UNKNOWN is representable.
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- Harness sessions. A partial unique index enforces one live CEO across all terminals.
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  role           TEXT NOT NULL,
  harness        TEXT NOT NULL,
  model          TEXT,
  effort         TEXT,
  pid            INTEGER,
  cwd            TEXT,
  claimed_at     TEXT NOT NULL,
  last_heartbeat TEXT NOT NULL,
  released_at    TEXT,
  -- The harness's own session identifier, which is what runtime hooks report. Without it, hook
  -- usage cannot be matched to the role this session claimed and lands on a synthetic agent.
  harness_session_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_single_live_ceo
  ON sessions(role) WHERE released_at IS NULL AND role = 'ceo';

-- The agent registry. `model` and `effort` are current values, mutable at runtime; there is no
-- per-persona allowlist. Every change is recorded in `changes`.
CREATE TABLE IF NOT EXISTS agents (
  agent_id          TEXT PRIMARY KEY,
  role              TEXT NOT NULL,
  parent            TEXT,
  session_id        TEXT,
  harness           TEXT,
  runtime           TEXT,
  runtime_ref       TEXT,
  model             TEXT,
  effort            TEXT,
  ticket            TEXT,
  status            TEXT NOT NULL DEFAULT 'PLANNED',
  owned_paths       TEXT,
  current_operation TEXT,
  blocker           TEXT,
  started_at        TEXT NOT NULL,
  last_heartbeat    TEXT,
  completed_at      TEXT,
  result            TEXT,
  report            TEXT
);
CREATE INDEX IF NOT EXISTS agents_parent ON agents(parent);
CREATE INDEX IF NOT EXISTS agents_status ON agents(status);

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
  control_action          TEXT,
  control_target          TEXT,
  control_outcome         TEXT,
  budget_action           TEXT,
  budget_holder           TEXT,
  budget_granted_by       TEXT,
  budget_request_id       TEXT,
  raw                     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, timestamp);
CREATE INDEX IF NOT EXISTS events_type  ON events(type, timestamp);

-- Budget allocations: one row per holder, granted by its parent in the allocation chain.
CREATE TABLE IF NOT EXISTS budget_allocations (
  holder        TEXT PRIMARY KEY,
  granted_by    TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  scope         TEXT,
  granted_at    TEXT NOT NULL,
  note          TEXT
);

-- Budget asks, in order, with their decision.
CREATE TABLE IF NOT EXISTS budget_requests (
  id            TEXT PRIMARY KEY,
  from_holder   TEXT NOT NULL,
  to_holder     TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  decided_by    TEXT,
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS budget_requests_status ON budget_requests(status);

-- Audit trail for every runtime mutation made through the CLI or the UI.
CREATE TABLE IF NOT EXISTS changes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  actor     TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field     TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason    TEXT
);
CREATE INDEX IF NOT EXISTS changes_entity ON changes(entity, entity_id, at);

-- Which events have been shipped to an external observability backend. The marker lives here rather
-- than as a column on events so a second backend can be added without another migration, and so an
-- interrupted export resumes instead of re-sending everything.
CREATE TABLE IF NOT EXISTS exports (
  event_id    TEXT NOT NULL,
  backend     TEXT NOT NULL,
  exported_at TEXT NOT NULL,
  PRIMARY KEY (event_id, backend)
);
