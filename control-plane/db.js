'use strict';
// Control-plane database access. Uses Node's built-in SQLite (Node 22.5+), so an injected
// repository needs no dependencies. Every helper is synchronous, which is what a CLI wants.
const fs = require('node:fs');
const path = require('node:path');

// node:sqlite is stable enough for a local control plane but still prints an experimental warning.
// Agents consume this CLI's output, so suppress that one line and nothing else.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  return emitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB = path.join(__dirname, 'brain.db');
const SCHEMA = path.join(__dirname, 'schema.sql');
const SCHEMA_VERSION = '1';

// Company defaults, overridable with `brain.js config set`.
const DEFAULT_CONFIG = {
  company_input_tokens: '100000',
  company_output_tokens: '100000',
  company_cost_usd: 'UNKNOWN',
  warn_at_percent: '80',
  // See INPUT_BASIS below: fresh | new | billable.
  budget_input_basis: 'new',
  session_stale_minutes: '30',
  agent_stale_minutes: '20',
  // When captured events are shipped to Langfuse: off | session-end | turn. Nothing is sent unless
  // LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are present, so this default is inert without them.
  langfuse_export: 'session-end'
};

// Columns added after a database already exists. `CREATE TABLE IF NOT EXISTS` never adds a column
// to a live table, so every additive change is listed here and applied once, in order.
const ADDED_COLUMNS = [
  ['sessions', 'harness_session_id', 'TEXT'],
  ['events', 'thinking_tokens', 'INTEGER'],
];

function migrate(db) {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const has = db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function open(file = process.env.BRAIN_DB || DEFAULT_DB) {
  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync(SCHEMA, 'utf8'));
  migrate(db);
  const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)').run('schema_version', SCHEMA_VERSION);
  const insertConfig = db.prepare('INSERT OR IGNORE INTO config(key, value, updated_at, updated_by) VALUES(?, ?, ?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) insertConfig.run(key, value, now, 'default');
  db.prepare(`INSERT OR IGNORE INTO budget_allocations(holder, granted_by, input_tokens, output_tokens, cost_usd, scope, granted_at, note)
              VALUES('ceo', 'user', ?, ?, NULL, 'company', ?, 'company budget; the CEO keeps a reserve for itself, PMs, EMs, and hires')`)
    .run(Number(DEFAULT_CONFIG.company_input_tokens), Number(DEFAULT_CONFIG.company_output_tokens), now);
  db.file = file;
  return db;
}

function config(db) {
  return Object.fromEntries(db.prepare('SELECT key, value FROM config').all().map(r => [r.key, r.value]));
}

function setConfig(db, key, value, actor = 'cli', reason = null) {
  const now = new Date().toISOString();
  const old = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  db.prepare('INSERT INTO config(key, value, updated_at, updated_by) VALUES(?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .run(key, String(value), now, actor);
  record(db, actor, 'config', key, 'value', old ? old.value : null, String(value), reason);
}

function record(db, actor, entity, entityId, field, oldValue, newValue, reason = null) {
  db.prepare('INSERT INTO changes(at, actor, entity, entity_id, field, old_value, new_value, reason) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), actor, entity, entityId, field, oldValue === undefined ? null : oldValue, newValue === undefined ? null : newValue, reason);
}

function minutesSince(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.round((now - t) / 60000);
}

// How `input_tokens` is counted against a budget. Prompt caching makes this a real choice rather
// than a detail: in a measured Claude Code session, 40 assistant messages billed 80 fresh input
// tokens, 767k cache writes, and 29M cache reads. Counting only fresh input makes a budget
// unreachable; counting cache reads makes a small budget instantly exhausted. The basis is therefore
// explicit, configurable, and every component is reported alongside the total so nothing is hidden.
//
//   fresh    = input_tokens only                                   (what the provider saw as new)
//   new      = input_tokens + cache writes                         (default: tokens processed at full price)
//   billable = input_tokens + cache writes + cache reads           (everything the provider counted)
const INPUT_BASIS = {
  fresh: 'COALESCE(e.input_tokens, 0)',
  new: 'COALESCE(e.input_tokens, 0) + COALESCE(e.cache_write_tokens, 0)',
  billable: 'COALESCE(e.input_tokens, 0) + COALESCE(e.cache_write_tokens, 0) + COALESCE(e.cache_read_tokens, 0)'
};

// Subtree token spend per holder, following agents.parent, from model.completed usage events.
function spend(db, holder, basis) {
  const chosen = basis || config(db).budget_input_basis || 'new';
  const expression = INPUT_BASIS[chosen] || INPUT_BASIS.new;
  const row = db.prepare(`
    WITH RECURSIVE subtree(agent_id) AS (
      SELECT ?
      UNION
      SELECT a.agent_id FROM agents a JOIN subtree s ON a.parent = s.agent_id
    )
    SELECT
      COALESCE(SUM(${expression}), 0)        AS input_tokens,
      COALESCE(SUM(e.input_tokens), 0)       AS fresh_input_tokens,
      COALESCE(SUM(e.cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(e.cache_read_tokens), 0)  AS cache_read_tokens,
      COALESCE(SUM(e.output_tokens), 0)      AS output_tokens,
      SUM(e.cost_usd)                        AS cost_usd,
      COUNT(*)                               AS usage_events,
      (SELECT COUNT(*) FROM subtree)         AS agents
    FROM events e
    WHERE e.type = 'model.completed' AND e.agent_id IN (SELECT agent_id FROM subtree)
  `).get(holder);
  return { ...row, input_basis: chosen };
}

module.exports = { open, config, setConfig, record, minutesSince, spend, INPUT_BASIS, DEFAULT_DB, DEFAULT_CONFIG, SCHEMA_VERSION };
