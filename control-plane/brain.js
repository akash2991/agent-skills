#!/usr/bin/env node
'use strict';
// Agent Brain control plane CLI. One command surface over the SQLite control plane: sessions
// the agent registry, observability events, provider quota, and the combined status
// an agent loads at session start. Output is content-first and compact for agent consumption;
// `--json` on any command returns the same data as JSON.
//
//   brain.js context   --role <role> --harness claude-code --model <id> --effort <level>
//   brain.js session   claim|release|heartbeat|list
//   brain.js agent     register|heartbeat|set|list|tree|close
//   brain.js quota     [--provider a,b]
//   brain.js status
//   brain.js event     --event '<json>'
//   brain.js serve     [--port 4173]
const crypto = require('node:crypto');
const path = require('node:path');
const database = require('./db');
const state = require('./state');
const quota = require('./quota');
const langfuse = require('./langfuse');
const { emitEvent } = require('./emit');

const AGENT_STATUS = new Set(['PLANNED', 'RUNNING', 'WAITING', 'BLOCKED', 'COMPLETED', 'FAILED', 'UNKNOWN']);
const REQUEST_STATUS = new Set(['PENDING', 'GRANTED', 'PARTIAL', 'DENIED', 'ESCALATED']);
const UNKNOWN = 'UNKNOWN';

const flag = (args, name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
const has = (args, name) => args.includes(`--${name}`);
const now = () => new Date().toISOString();
const need = (value, name) => { if (value === undefined || value === '') throw new Error(`--${name} is required`); return value; };
const int = value => (value === undefined || value === '' ? null : Number.parseInt(value, 10));
const out = (args, data, human) => process.stdout.write(has(args, 'json') ? `${JSON.stringify(data, null, 2)}\n` : `${human}\n`);

// ─── sessions ────────────────────────────────────────────────────────────────
// Only the CEO is exclusive: the organization has exactly one, so a second terminal must not
// become a second one. The schema enforces it with a partial unique index; this function gives the
// refusal a useful message. Every other role may run many sessions concurrently. A session whose
// heartbeat is older than session_stale_minutes is reclaimable rather than blocking forever.
// What the harness tells us about itself. A claimed role must be bound to the harness's own session
// identifier, because that is the only id a runtime hook reports; without the binding, captured
// usage is attributed to a synthetic agent instead of the role that actually spent it.
// Flags always win, so a harness that exposes nothing can still be bound explicitly.
const HARNESS_ENV = {
  session: ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID', 'BRAIN_HARNESS_SESSION'],
  effort: ['CLAUDE_EFFORT', 'BRAIN_EFFORT'],
};
function fromEnv(kind) {
  for (const name of HARNESS_ENV[kind]) if (process.env[name]) return process.env[name];
  return null;
}

function claimSession(db, args, actor) {
  const role = flag(args, 'role') || 'session';
  const id = flag(args, 'id') || `${role}-${crypto.randomUUID().slice(0, 8)}`;
  const at = now();
  const harnessSession = flag(args, 'harness-session') || fromEnv('session');
  const effort = flag(args, 'effort') || fromEnv('effort');
  db.prepare(`INSERT INTO sessions(id, role, harness, model, effort, pid, cwd, claimed_at, last_heartbeat, harness_session_id)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, role, flag(args, 'harness') || UNKNOWN, flag(args, 'model') || null, effort || null,
         int(flag(args, 'pid')) ?? process.ppid, flag(args, 'cwd') || process.cwd(), at, at, harnessSession || null);
  database.record(db, actor, 'session', id, 'claimed', null, role, flag(args, 'harness') || null);
  return { ok: true, session: db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) };
}

function sessionCommand(db, args, actor) {
  const action = args[1];
  if (action === 'claim') {
    const s = claimSession(db, args, actor).session;
    out(args, { ok: true, session: s }, `session ${s.id} claimed role=${s.role} harness=${s.harness} model=${s.model || UNKNOWN}/${s.effort || UNKNOWN}`);
    return;
  }
  if (action === 'release') {
    const id = need(flag(args, 'id'), 'id');
    const row = db.prepare('SELECT * FROM sessions WHERE id = ? AND released_at IS NULL').get(id);
    if (!row) { out(args, { ok: false, reason: 'not_live' }, `no live session ${id}`); process.exitCode = 1; return; }
    db.prepare('UPDATE sessions SET released_at = ? WHERE id = ?').run(now(), id);
    database.record(db, actor, 'session', id, 'released_at', null, now(), flag(args, 'reason') || null);
    out(args, { ok: true, id }, `session ${id} released`);
    return;
  }
  if (action === 'heartbeat') {
    const id = need(flag(args, 'id'), 'id');
    const changed = db.prepare('UPDATE sessions SET last_heartbeat = ? WHERE id = ? AND released_at IS NULL').run(now(), id);
    out(args, { ok: changed.changes > 0, id }, changed.changes ? `session ${id} heartbeat ${now()}` : `no live session ${id}`);
    if (!changed.changes) process.exitCode = 1;
    return;
  }
  const rows = db.prepare('SELECT * FROM sessions ORDER BY claimed_at DESC LIMIT 20').all()
    .map(r => ({ ...r, heartbeat_age_minutes: database.minutesSince(r.last_heartbeat), live: !r.released_at }));
  out(args, { sessions: rows }, rows.length
    ? rows.map(r => `${r.live ? 'LIVE   ' : 'closed '} ${r.id} role=${r.role} harness=${r.harness} model=${r.model || UNKNOWN}/${r.effort || UNKNOWN} hb=${r.heartbeat_age_minutes ?? '?'}min`).join('\n')
    : 'no sessions');
}

// ─── agents ──────────────────────────────────────────────────────────────────
function agentCommand(db, args, actor) {
  const action = args[1];
  if (action === 'register') {
    const id = need(flag(args, 'agent-id'), 'agent-id');
    const at = now();
    db.prepare(`INSERT INTO agents(agent_id, role, parent, session_id, harness, runtime, runtime_ref, model, effort, ticket, status, owned_paths, current_operation, started_at, last_heartbeat)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(agent_id) DO UPDATE SET role=excluded.role, parent=excluded.parent, session_id=excluded.session_id,
                  harness=excluded.harness, runtime=excluded.runtime, runtime_ref=excluded.runtime_ref, model=excluded.model,
                  effort=excluded.effort, ticket=excluded.ticket, status=excluded.status, owned_paths=excluded.owned_paths,
                  current_operation=excluded.current_operation, last_heartbeat=excluded.last_heartbeat`)
      .run(id, need(flag(args, 'role'), 'role'), flag(args, 'parent') || null, flag(args, 'session') || null,
           flag(args, 'harness') || null, flag(args, 'runtime') || null, flag(args, 'runtime-ref') || null,
           flag(args, 'model') || null, flag(args, 'effort') || null, flag(args, 'ticket') || null,
           flag(args, 'status') || 'RUNNING', flag(args, 'paths') || null, flag(args, 'operation') || null, at, at);
    database.record(db, actor, 'agent', id, 'registered', null, flag(args, 'role'), flag(args, 'ticket') || null);
    const conflicts = state.pathConflicts(db).filter(c => c.agents.includes(id));
    out(args, { ok: true, agent: db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(id), path_conflicts: conflicts }, [
      `registered ${id} role=${flag(args, 'role')} parent=${flag(args, 'parent') || UNKNOWN} ticket=${flag(args, 'ticket') || '-'}`,
      ...conflicts.map(c => `PATH CONFLICT ${c.path} also owned by ${c.agents.filter(a => a !== id).join(', ')}`)
    ].join('\n'));
    return;
  }
  if (action === 'heartbeat' || action === 'set') {
    const id = need(flag(args, 'agent-id'), 'agent-id');
    const row = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(id);
    if (!row) { out(args, { ok: false, reason: 'unknown_agent' }, `unknown agent ${id}`); process.exitCode = 1; return; }
    const fields = { model: 'model', effort: 'effort', status: 'status', ticket: 'ticket', operation: 'current_operation', blocker: 'blocker', paths: 'owned_paths', runtime: 'runtime', 'runtime-ref': 'runtime_ref' };
    const applied = [];
    for (const [name, column] of Object.entries(fields)) {
      const value = flag(args, name);
      if (value === undefined) continue;
      if (column === 'status' && !AGENT_STATUS.has(value)) throw new Error(`status must be one of ${[...AGENT_STATUS].join('|')}`);
      db.prepare(`UPDATE agents SET ${column} = ? WHERE agent_id = ?`).run(value, id);
      database.record(db, actor, 'agent', id, column, row[column], value, flag(args, 'reason') || null);
      applied.push(`${column}=${value}`);
    }
    db.prepare('UPDATE agents SET last_heartbeat = ? WHERE agent_id = ?').run(now(), id);
    out(args, { ok: true, applied, agent: db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(id) },
      `${id} ${applied.length ? applied.join(' ') : 'heartbeat'} at ${now()}`);
    return;
  }
  if (action === 'close') {
    const id = need(flag(args, 'agent-id'), 'agent-id');
    const result = flag(args, 'result') || 'DONE';
    db.prepare('UPDATE agents SET status = ?, result = ?, report = ?, completed_at = ?, last_heartbeat = ? WHERE agent_id = ?')
      .run(result === 'DONE' ? 'COMPLETED' : 'FAILED', result, flag(args, 'report') || null, now(), now(), id);
    database.record(db, actor, 'agent', id, 'closed', null, result, flag(args, 'report') || null);
    out(args, { ok: true, agent_id: id, result }, `${id} closed result=${result}`);
    return;
  }
  if (action === 'tree') { const t = state.tree(db); out(args, { tree: t }, state.renderTree(t)); return; }
  const rows = state.agents(db);
  out(args, { agents: rows }, rows.length ? rows.map(a =>
    `${a.status.padEnd(9)} ${a.agent_id.padEnd(24)} ${a.role.padEnd(24)} ${(a.ticket || '-').padEnd(10)} ${(a.model || UNKNOWN)}/${a.effort || UNKNOWN} hb=${a.heartbeat_age_minutes ?? '?'}min ${a.current_operation || ''}`).join('\n') : 'no agents registered');
}







// ─── quota, status, context ──────────────────────────────────────────────────
function quotaCommand(db, args) {
  const providers = (flag(args, 'provider') || '').split(',').map(s => s.trim()).filter(Boolean);
  const report = quota.read({ providers });
  if (!report.available) { out(args, report, `quota UNKNOWN: ${report.reason}`); return; }
  quota.snapshot(db, report);
  const ranked = quota.preferred(report.scopes);
  out(args, report, [
    `quota from ${report.command} at ${report.generated_at || now()}`,
    ...report.scopes.map(s => `${s.provider}/${s.scope} ${s.percent_remaining ?? UNKNOWN}% prio=${s.spend_priority ?? UNKNOWN} runway=${s.runway_status || UNKNOWN} pace=${s.pace_status || UNKNOWN}${s.stale ? ' STALE' : ''}`),
    ranked.length ? `prefer: ${ranked.slice(0, 3).map(s => `${s.provider}/${s.scope}`).join(' > ')}` : 'no healthy scope reported'
  ].join('\n'));
}



// One command an agent runs at session start: claims its role, then prints everything it needs.
// A hook can observe a session before any role claims it, and records that usage against a
// synthetic `session-*` agent. When the role claims the same harness session, that work was always
// the role's: move the events and close the placeholder, so spend is not split across two rows.
function adoptObservedAgent(db, harnessSession, role, actor) {
  if (!harnessSession || role === 'unregistered') return null;
  const observed = db.prepare(
    "SELECT agent_id FROM agents WHERE session_id = ? AND role = 'unregistered' AND agent_id <> ?").all(harnessSession, role);
  let moved = 0;
  for (const row of observed) {
    const n = db.prepare('SELECT COUNT(*) c FROM events WHERE agent_id = ?').get(row.agent_id).c;
    db.prepare('UPDATE events SET agent_id = ? WHERE agent_id = ?').run(role, row.agent_id);
    db.prepare("UPDATE agents SET status = 'CLOSED', current_operation = ? WHERE agent_id = ?")
      .run(`adopted by ${role}`, row.agent_id);
    database.record(db, actor, 'agent', row.agent_id, 'adopted', row.agent_id, role, `${n} event(s) re-attributed to ${role}`);
    moved += n;
  }
  return observed.length ? { agents: observed.map(r => r.agent_id), events: moved } : null;
}

// Silence is the worst failure mode for tracing: you only find out it never worked when you go
// looking for data that is not there. Say plainly, at session start, whether it is on.
function tracingLine(db) {
  const mode = database.config(db).langfuse_export || 'turn';
  const cred = langfuse.credentials();
  if (mode === 'off') return 'Langfuse tracing: OFF (langfuse_export=off).';
  if (cred.missing.length) {
    return `Langfuse tracing: OFF, no credentials. Set ${cred.missing.join(' and ')} in ${cred.searched[0]} or ${cred.searched[cred.searched.length - 1]} (which serves every project).`;
  }
  return `Langfuse tracing: ON (${mode}) → ${cred.baseUrl}, credentials from ${cred.source}.`;
}

function contextCommand(db, args, actor) {
  const role = flag(args, 'role') || 'session';
  const session = claimSession(db, args, actor).session;
  // Bind the agent row to the harness's session id when there is one. Runtime hooks only know that
  // id, so this is what makes captured usage land on the role instead of a synthetic agent.
  const bindTo = session.harness_session_id || session.id;
  // The session's own model and effort become this role's current values in the registry.
  db.prepare(`INSERT INTO agents(agent_id, role, parent, session_id, harness, model, effort, status, started_at, last_heartbeat, current_operation)
              VALUES(?, ?, 'user', ?, ?, ?, ?, 'RUNNING', ?, ?, 'session start')
              ON CONFLICT(agent_id) DO UPDATE SET session_id=excluded.session_id, harness=excluded.harness,
                model=excluded.model, effort=excluded.effort, status='RUNNING', last_heartbeat=excluded.last_heartbeat`)
    .run(role, role, bindTo, session.harness, session.model, session.effort, now(), now());
  const adopted = adoptObservedAgent(db, bindTo, role, actor);
  database.record(db, actor, 'agent', role, 'session_start', null, `${session.model || UNKNOWN}/${session.effort || UNKNOWN}`, `session ${session.id}`);
  emitEvent({ schema_version: '1.0', type: 'agent.started', agent_id: role, session_id: session.id, role,
    model: session.model || undefined, effort: session.effort || undefined }, { db });
  const snapshot = state.statusData(db);
  // A fresh database knows nothing about the account it will spend against. Seeding it with a real
  // reading means routing decisions are made against what the providers will actually serve, not
  // against a guess.
  const seeding = !quota.isSeeded(db);
  const q = quota.read({});
  const seeded = quota.snapshot(db, q);
  if (seeding && seeded) database.record(db, actor, 'quota', 'provider_quota', 'seeded', null, String(seeded), 'first reading on a fresh database');
  const data = { ok: true, session, role, state: snapshot, quota: q, quota_seeded: seeding ? seeded : 0 };
  out(args, data, [
    `You are the ${role}. Session ${session.id} on ${session.harness}; your model is ${session.model || UNKNOWN} at ${session.effort || UNKNOWN} effort, recorded as the ${role}'s current values.`,
    ...(session.harness_session_id
      ? [`Usage capture is bound to harness session ${session.harness_session_id}: tokens land on ${role}.`]
      : ['WARNING: this harness exposed no session id, so captured usage cannot be attributed to you. Pass --harness-session <id> or set BRAIN_HARNESS_SESSION.']),
    ...(adopted ? [`Adopted ${adopted.events} event(s) already observed on this session from ${adopted.agents.join(', ')}.`] : []),
    tracingLine(db),
    ...(seeding && seeded ? [`Seeded this fresh control plane with ${seeded} provider quota scope(s) read from the real account.`] : []),
    '',
    state.renderStatus(snapshot),
    '',
    q.available
      ? `provider quota: ${quota.preferred(q.scopes).slice(0, 3).map(s => `${s.provider}/${s.scope} ${s.percent_remaining}%`).join(' > ') || 'no healthy scope'}`
      : `provider quota UNKNOWN (${q.reason})`,
    '',
    'Heartbeat this session while you work: brain.js session heartbeat --id ' + session.id,
    'Release it when you stop: brain.js session release --id ' + session.id
  ].join('\n'));
}

// ─── observability export (Langfuse) ─────────────────────────────────────────
// The local UI answers "what is happening now". Langfuse answers "what happened, in what order,
// and what did it cost", with trace timelines and dashboards it would be wasteful to rebuild.
async function exportCommand(db, args, actor) {
  const backend = args[1];
  if (backend !== 'langfuse') { console.error('usage: brain.js export langfuse [--limit N] [--all] [--dry-run]'); process.exitCode = 2; return; }
  const result = await langfuse.send(db, {
    limit: int(flag(args, 'limit')) ?? 500,
    all: has(args, 'all'),
    dryRun: has(args, 'dry-run'),
    envFile: flag(args, 'env-file'),
  });
  if (!result.ok) {
    const why = result.reason === 'missing_credentials'
      ? `set ${result.missing.join(' and ')} (a .env file in this directory is read too)`
      : `${result.status}: ${result.body}`;
    out(args, result, `export to ${result.baseUrl} failed: ${why}`);
    process.exitCode = 5;
    return;
  }
  if (result.sent) database.record(db, actor, 'export', 'langfuse', 'sent', null, String(result.sent), `${result.spans} span(s)`);
  out(args, result, result.dryRun
    ? `[dry-run] ${result.events} event(s) would become ${result.spans} span(s) at ${result.baseUrl}`
    : `exported ${result.sent} event(s) as ${result.spans} span(s) to ${result.baseUrl}${result.note ? ` (${result.note})` : ''}`);
}

// ─── entry ───────────────────────────────────────────────────────────────────
// Async because one command (export) performs network I/O. Every other command stays synchronous;
// the await below is what keeps the database open until an async command has finished with it.
async function main(args = process.argv.slice(2)) {
  const group = args[0];
  const actor = flag(args, 'actor') || process.env.BRAIN_ACTOR || 'cli';
  if (!group || group === 'help' || group === '--help') {
    process.stdout.write(['brain.js <group> <action> [--flags]  ·  add --json to any command',
      '  context  --role <role> --harness <h> --model <id> --effort <level>   claim a role and print the full state',
      '  session  claim|release|heartbeat|list',
      '  agent    register|heartbeat|set|close|list|tree',
      '  quota    [--provider claude,codex,...]', '  status', "  event    --event '<json>'", '  serve    [--port 4173]',
      '  export   langfuse [--limit N] [--all] [--dry-run]   ship events to Langfuse as OTLP spans',
      '  config   show|set --key K --value V'].join('\n') + '\n');
    return;
  }
  if (group === 'serve') { require('./server').serve({ port: int(flag(args, 'port')) || 4173, host: flag(args, 'host') || '127.0.0.1' }); return; }
  const db = database.open(flag(args, 'db'));
  try {
    if (group === 'context') return contextCommand(db, args, actor);
    if (group === 'session') return sessionCommand(db, args, actor);
    if (group === 'agent') return agentCommand(db, args, actor);
    if (group === 'quota') return quotaCommand(db, args);
    if (group === 'export') return await exportCommand(db, args, actor);
    if (group === 'status') { const s = state.statusData(db); return out(args, s, state.renderStatus(s)); }
    if (group === 'event') {
      const raw = flag(args, 'event') || require('node:fs').readFileSync(0, 'utf8');
      const event = emitEvent(JSON.parse(raw), { db });
      return out(args, event, `recorded ${event.type} for ${event.agent_id}`);
    }
    if (group === 'config') {
      if (args[1] === 'set') { database.setConfig(db, need(flag(args, 'key'), 'key'), need(flag(args, 'value'), 'value'), actor, flag(args, 'reason')); return out(args, { ok: true }, `config ${flag(args, 'key')}=${flag(args, 'value')}`); }
      const cfg = database.config(db);
      return out(args, cfg, Object.entries(cfg).map(([k, v]) => `${k}=${v}`).join('\n'));
    }
    throw new Error(`unknown group "${group}" (try: brain.js help)`);
  } finally { db.close(); }
}

module.exports = { main, claimSession };

if (require.main === module) {
  main().catch(error => { process.stderr.write(`ERROR ${error.message}\n`); process.exitCode = 1; });
}
