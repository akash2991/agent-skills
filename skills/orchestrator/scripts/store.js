'use strict';

// The orchestrator's session record: one SQLite file per project, shared by the
// orchestrator CLI and the recorders in its workers (the Claude hook and the
// Pi extension's writer). Every writer goes through this module so the schema,
// the ownership rule, and the hook semantics live in one place.

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
  } catch {
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
  transcript_path TEXT,
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
  identity_seq INTEGER NOT NULL DEFAULT 0,
  launch_token TEXT,
  summary_at TEXT,
  pending TEXT
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
  action TEXT NOT NULL CHECK (action IN ('new', 'resume', 'send', 'relaunch')),
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
CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pane_id TEXT NOT NULL,
  tab_id TEXT,
  workspace_id TEXT,
  agent_session TEXT,
  at TEXT NOT NULL
);
CREATE INDEX prompts_by_session ON prompts(session_id, id);
CREATE INDEX events_by_session ON events(session_id, id);
`;

const UPDATABLE = new Set([
  'title', 'intent', 'summary', 'status', 'model', 'effort', 'persona', 'ticket', 'native_session_id',
  'transcript_path', 'cwd', 'tab_id', 'pane_id', 'agent_name', 'last_active_at', 'resolved_at',
  'last_compacted_at', 'launches', 'identity_seq', 'launch_token', 'summary_at', 'pending',
]);

const now = () => new Date().toISOString();

// Test seam: a named point a test can stop at, to force an interleaving with
// another writer. Nothing is registered outside the tests, so it is a no-op.
// The one point is `write-lock`, just before a write transaction takes the
// lock, so every read a writer makes before its lock comes before it.
const probes = new Map();
const probe = name => { const fn = probes.get(name); if (fn) fn(); };
const setProbe = (name, fn) => (fn ? probes.set(name, fn) : probes.delete(name));
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function retryBusy(fn, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      if (!/locked|busy/i.test(err.message) || Date.now() >= deadline) throw err;
      sleep(25);
    }
  }
}

// `create: false` opens only an existing record (a worker's recorder never
// creates one); `busyTimeout` bounds how long a write waits for another writer.
function open(dbPath, { create = true, busyTimeout = 5000 } = {}) {
  if (!create && !fs.existsSync(dbPath)) return null;
  const { DatabaseSync } = loadSqlite();
  if (create) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${Number(busyTimeout)}; PRAGMA foreign_keys = ON;`);
    // Switching to WAL takes an exclusive lock that does not honour busy_timeout.
    retryBusy(() => db.exec('PRAGMA journal_mode = WAL'), busyTimeout);
    const version = () => db.prepare('PRAGMA user_version').get().user_version;
    if (version() === 0) {
      transaction(db, () => {
        if (version() !== 0) return; // another opener initialised it first
        db.exec(SCHEMA);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
    if (version() > SCHEMA_VERSION) {
      throw new Error(`${dbPath} has schema ${version()}; this orchestrator knows ${SCHEMA_VERSION}. Update the brain.`);
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

function transaction(db, fn) {
  probe('write-lock');
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

// ─── Held prompts ───────────────────────────────────────────────────────────
// A worker's prompts are written here before they are sent, and each is
// removed once the agent accepted it. An entry is `pending` (known not sent)
// or `unknown` (its submission was interrupted, so it may or may not have
// reached the worker). An unknown entry is never resent or dropped on its
// own; the orchestrator settles it. `sending` is written just before a
// submission, so one found later is unknown.

function pendingOf(row) {
  let entries;
  try { entries = row && row.pending ? JSON.parse(row.pending) : []; } catch { entries = []; }
  return entries.map(e => (e.state === 'pending' ? e : { ...e, state: 'unknown' }));
}

function setPending(db, id, entries) {
  updateSession(db, id, { pending: entries.length ? JSON.stringify(entries) : null });
}

// ─── Ownership: one orchestrator per project ────────────────────────────────

function getOwner(db) {
  return db.prepare('SELECT * FROM owner WHERE id = 1').get() || null;
}

const sameOwner = (a, b) => (!a && !b) || (!!a && !!b && a.pane_id === b.pane_id && a.at === b.at);

// Judge the current holder outside the write transaction (that takes Herdr
// calls), then replace it inside one only if the holder is still the one that
// was judged. Contenders are serialized, and exactly one wins; `changed` asks
// the caller to judge again.
function claimOwner(db, me, holderAlive) {
  const seen = getOwner(db);
  const alive = !!seen && seen.pane_id !== me.pane_id && holderAlive(seen);
  return transaction(db, () => {
    const held = getOwner(db);
    if (!sameOwner(held, seen)) return { claimed: false, held, changed: true };
    if (alive) return { claimed: false, held };
    db.prepare(`INSERT INTO owner (id, pane_id, tab_id, workspace_id, agent_session, at) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET pane_id = excluded.pane_id, tab_id = excluded.tab_id,
      workspace_id = excluded.workspace_id, agent_session = excluded.agent_session, at = excluded.at`)
      .run(me.pane_id, me.tab_id ?? null, me.workspace_id ?? null, me.agent_session ?? null, now());
    return { claimed: true, tookOver: !!held && held.pane_id !== me.pane_id, held };
  });
}

function releaseOwner(db, paneId) {
  return db.prepare('DELETE FROM owner WHERE id = 1 AND pane_id = ?').run(paneId).changes > 0;
}

// ─── Recorder events ────────────────────────────────────────────────────────

// One harness event from a worker the orchestrator launched. `kind` is one of
// start, prompt, compact, stop, end; the Claude hook and the Pi extension map
// their native events onto these.
//
// Identity and compactions are fenced: an event from another launch than the
// session's current one (`launch`, a token never reused, so a failed launch's
// late writer cannot pass for its retry), or a start older than the last one
// applied (`seq`, from Pi's independent writers), does not change them. Prompts are
// always kept; they are what the user said.
function recordHookEvent(db, sessionId, event) {
  return transaction(db, () => {
    const row = getSession(db, sessionId);
    if (!row) return false;
    const at = now();
    const current = event.launch == null || String(event.launch) === String(row.launch_token);
    switch (event.kind) {
      case 'start': {
        const seq = event.seq == null ? null : Number(event.seq);
        if (!current || (seq !== null && seq <= row.identity_seq)) {
          addEvent(db, row.id, 'stale-start-ignored', `launch ${event.launch ?? '?'} seq ${seq ?? '-'}`);
          break;
        }
        if (event.nativeSessionId && event.nativeSessionId !== row.native_session_id) {
          if (row.native_session_id) addEvent(db, row.id, 'native-session-changed', `${row.native_session_id} -> ${event.nativeSessionId}`);
          updateSession(db, row.id, { native_session_id: event.nativeSessionId });
        }
        if (event.transcriptPath) updateSession(db, row.id, { transcript_path: event.transcriptPath });
        if (seq !== null) updateSession(db, row.id, { identity_seq: seq });
        addEvent(db, row.id, 'start', event.detail);
        break;
      }
      case 'prompt':
        if (event.text) addPrompt(db, row.id, event.text);
        break;
      case 'compact':
        if (!current) break;
        db.prepare('UPDATE sessions SET compactions = compactions + 1, last_compacted_at = ? WHERE id = ?').run(at, row.id);
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
    return true;
  });
}

module.exports = {
  open, transaction, now, createSession, getSession, listSessions, updateSession,
  addEvent, addPrompt, addDecision, recentPrompts, promptCount, recentEvents, recordHookEvent,
  pendingOf, setPending, getOwner, claimOwner, releaseOwner, SCHEMA_VERSION, setProbe,
};
