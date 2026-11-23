'use strict';

// The orchestrator's session record: one SQLite file per project, shared by the
// orchestrator CLI, the Claude hook, and the Pi extension. Every writer goes
// through this module so the schema and the hook semantics live in one place.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const PROMPT_LIMIT = 4000;
const ORCHESTRATOR_MARK = /\[orchestrator S\d+\]/;

function loadSqlite() {
  // node:sqlite prints an ExperimentalWarning on load; it is noise in a hook.
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
    if (type === 'ExperimentalWarning' && /sqlite/i.test(String((warning && warning.message) || warning))) return;
    return emit.call(process, warning, ...rest);
  };
  try {
    return require('node:sqlite');
  } catch (err) {
    throw new Error(`node:sqlite is unavailable in Node ${process.version}; the orchestrator needs Node 22.5 or newer`);
  } finally {
    process.emitWarning = emit;
  }
}

const SCHEMA = `
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  intent TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'superseded')),
  harness TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  persona TEXT,
  ticket TEXT,
  native_session_id TEXT,
  cwd TEXT NOT NULL,
  tab_id TEXT,
  pane_id TEXT,
  agent_name TEXT,
  parent_id INTEGER REFERENCES sessions(id),
  started_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  resolved_at TEXT,
  compactions INTEGER NOT NULL DEFAULT 0,
  last_compacted_at TEXT,
  launches INTEGER NOT NULL DEFAULT 0,
  pending_prompt TEXT
);
CREATE TABLE prompts (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('orchestrator', 'direct')),
  text TEXT NOT NULL
);
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  request TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('new', 'resume', 'send')),
  session_id INTEGER REFERENCES sessions(id),
  considered TEXT,
  reason TEXT NOT NULL
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX prompts_by_session ON prompts(session_id, id);
CREATE INDEX events_by_session ON events(session_id, id);
`;

const UPDATABLE = new Set([
  'title', 'intent', 'summary', 'status', 'model', 'effort', 'persona', 'ticket',
  'native_session_id', 'cwd', 'tab_id', 'pane_id', 'agent_name', 'last_active_at',
  'resolved_at', 'compactions', 'last_compacted_at', 'launches', 'pending_prompt',
]);

const now = () => new Date().toISOString();

function open(dbPath) {
  const { DatabaseSync } = loadSqlite();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version === 0) {
    transaction(db, () => {
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  } else if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`${dbPath} has schema ${version}; this orchestrator knows ${SCHEMA_VERSION}. Update the brain.`);
  }
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

function createSession(db, fields) {
  const at = now();
  const row = db.prepare(`INSERT INTO sessions
    (title, intent, summary, status, harness, model, effort, persona, ticket, native_session_id, cwd, parent_id, started_at, last_active_at)
    VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    fields.title, fields.intent, fields.summary ?? null, fields.harness, fields.model ?? null,
    fields.effort ?? null, fields.persona ?? null, fields.ticket ?? null, fields.native_session_id ?? null,
    fields.cwd, fields.parent_id ?? null, at, at);
  return Number(row.lastInsertRowid);
}

function getSession(db, id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(id)) || null;
}

function listSessions(db) {
  return db.prepare('SELECT * FROM sessions ORDER BY last_active_at DESC').all();
}

function updateSession(db, id, fields) {
  const keys = Object.keys(fields);
  for (const key of keys) if (!UPDATABLE.has(key)) throw new Error(`not an updatable session field: ${key}`);
  if (!keys.length) return;
  db.prepare(`UPDATE sessions SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map(k => fields[k] ?? null), Number(id));
}

function addEvent(db, sessionId, kind, detail) {
  db.prepare('INSERT INTO events (session_id, at, kind, detail) VALUES (?, ?, ?, ?)')
    .run(Number(sessionId), now(), kind, detail == null ? null : String(detail));
}

function addPrompt(db, sessionId, text) {
  const body = String(text);
  const source = ORCHESTRATOR_MARK.test(body.slice(0, 400)) ? 'orchestrator' : 'direct';
  db.prepare('INSERT INTO prompts (session_id, at, source, text) VALUES (?, ?, ?, ?)')
    .run(Number(sessionId), now(), source, body.length > PROMPT_LIMIT ? `${body.slice(0, PROMPT_LIMIT)}…` : body);
  return source;
}

function addDecision(db, { request, action, sessionId, considered, reason }) {
  db.prepare('INSERT INTO decisions (at, request, action, session_id, considered, reason) VALUES (?, ?, ?, ?, ?, ?)')
    .run(now(), request, action, sessionId == null ? null : Number(sessionId), considered || null, reason);
}

function recentPrompts(db, sessionId, limit = 5) {
  return db.prepare('SELECT * FROM prompts WHERE session_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(sessionId), limit).reverse();
}

function promptCount(db, sessionId) {
  return db.prepare('SELECT COUNT(*) AS n FROM prompts WHERE session_id = ?').get(Number(sessionId)).n;
}

function recentEvents(db, sessionId, limit = 10) {
  return db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(sessionId), limit).reverse();
}

// One harness event from a worker the orchestrator launched. `kind` is one of
// start, prompt, compact, stop, end; the Claude hook and the Pi extension map
// their native events onto these.
function recordHookEvent(db, sessionId, event) {
  const row = getSession(db, sessionId);
  if (!row) return false;
  const at = now();
  transaction(db, () => {
    switch (event.kind) {
      case 'start':
        if (event.nativeSessionId && event.nativeSessionId !== row.native_session_id) {
          if (row.native_session_id) addEvent(db, row.id, 'native-session-changed', `${row.native_session_id} -> ${event.nativeSessionId}`);
          updateSession(db, row.id, { native_session_id: event.nativeSessionId });
        }
        addEvent(db, row.id, 'start', event.detail);
        break;
      case 'prompt':
        if (event.text) addPrompt(db, row.id, event.text);
        break;
      case 'compact':
        updateSession(db, row.id, { compactions: row.compactions + 1, last_compacted_at: at });
        addEvent(db, row.id, 'compact', event.detail);
        break;
      case 'stop':
        break;
      case 'end':
        addEvent(db, row.id, 'end', event.detail);
        break;
      default:
        throw new Error(`unknown hook event kind: ${event.kind}`);
    }
    updateSession(db, row.id, { last_active_at: at });
  });
  return true;
}

module.exports = {
  open, transaction, now, createSession, getSession, listSessions, updateSession,
  addEvent, addPrompt, addDecision, recentPrompts, promptCount, recentEvents, recordHookEvent,
  SCHEMA_VERSION,
};
