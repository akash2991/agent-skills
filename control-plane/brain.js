#!/usr/bin/env node
'use strict';
// Agent Brain control plane CLI. One command surface over the SQLite control plane: sessions
// (with the single-CEO lock), the agent registry, budgets, provider quota, and the combined status
// an agent loads at session start. Output is content-first and compact for agent consumption;
// `--json` on any command returns the same data as JSON.
//
//   brain.js context   --role ceo --harness claude-code --model <id> --effort <level>
//   brain.js session   claim|release|heartbeat|list
//   brain.js agent     register|heartbeat|set|list|tree|close
//   brain.js budget    show|allocate|ask|decide
//   brain.js quota     [--provider a,b]
//   brain.js status
//   brain.js event     --event '<json>'
//   brain.js serve     [--port 4173]
const crypto = require('node:crypto');
const path = require('node:path');
const database = require('./db');
const state = require('./state');
const quota = require('./quota');
const control = require('./control');
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
const EXCLUSIVE_ROLES = new Set(['ceo']);

function claimSession(db, args, actor) {
  const role = flag(args, 'role') || 'ceo';
  const id = flag(args, 'id') || `${role}-${crypto.randomUUID().slice(0, 8)}`;
  const cfg = database.config(db);
  const stale = Number(cfg.session_stale_minutes || 30);
  const held = EXCLUSIVE_ROLES.has(role)
    ? db.prepare('SELECT * FROM sessions WHERE role = ? AND released_at IS NULL').get(role)
    : undefined;
  let reclaimed = null;
  if (held) {
    const age = database.minutesSince(held.last_heartbeat);
    if (age !== null && age <= stale) {
      return { ok: false, reason: 'role_taken', role, holder: held, age_minutes: age, stale_after_minutes: stale };
    }
    db.prepare('UPDATE sessions SET released_at = ? WHERE id = ?').run(now(), held.id);
    database.record(db, actor, 'session', held.id, 'released_at', null, now(), `stale for ${age === null ? 'unknown' : age} min, reclaimed by ${id}`);
    reclaimed = { id: held.id, age_minutes: age };
  }
  const at = now();
  db.prepare(`INSERT INTO sessions(id, role, harness, model, effort, pid, cwd, claimed_at, last_heartbeat)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, role, flag(args, 'harness') || UNKNOWN, flag(args, 'model') || null, flag(args, 'effort') || null,
         int(flag(args, 'pid')) ?? process.ppid, flag(args, 'cwd') || process.cwd(), at, at);
  database.record(db, actor, 'session', id, 'claimed', null, role, flag(args, 'harness') || null);
  return { ok: true, session: db.prepare('SELECT * FROM sessions WHERE id = ?').get(id), reclaimed };
}

function sessionCommand(db, args, actor) {
  const action = args[1];
  if (action === 'claim') {
    const result = claimSession(db, args, actor);
    if (!result.ok) {
      out(args, result, `REFUSED role=${result.role} already held by session ${result.holder.id} (${result.holder.harness}, heartbeat ${result.age_minutes} min ago; reclaimable after ${result.stale_after_minutes} min).\nThis session must not act as ${result.role}. Ask the holder to run: brain.js session release --id ${result.holder.id}`);
      process.exitCode = 3;
      return;
    }
    const s = result.session;
    out(args, result, `session ${s.id} claimed role=${s.role} harness=${s.harness} model=${s.model || UNKNOWN}/${s.effort || UNKNOWN}${result.reclaimed ? `\nreclaimed stale session ${result.reclaimed.id}` : ''}`);
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
    const budget = state.budgetFor(db, id);
    out(args, { ok: true, agent: db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(id), path_conflicts: conflicts, budget }, [
      `registered ${id} role=${flag(args, 'role')} parent=${flag(args, 'parent') || UNKNOWN} ticket=${flag(args, 'ticket') || '-'}`,
      budget ? `budget ${budget.holder}: ${budget.spent.input_tokens}/${budget.allocated.input_tokens} in, ${budget.spent.output_tokens}/${budget.allocated.output_tokens} out (${budget.status})`
             : 'BUDGET: no allocation covers this agent. Ask your grantor before starting.',
      ...conflicts.map(c => `PATH CONFLICT ${c.path} also owned by ${c.agents.filter(a => a !== id).join(', ')}`)
    ].join('\n'));
    return;
  }
  if (action === 'heartbeat' || action === 'set') {
    const id = need(flag(args, 'agent-id'), 'agent-id');
    const row = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(id);
    if (!row) { out(args, { ok: false, reason: 'unknown_agent' }, `unknown agent ${id}`); process.exitCode = 1; return; }
    const fields = { model: 'model', effort: 'effort', status: 'status', ticket: 'ticket', operation: 'current_operation', blocker: 'blocker', paths: 'owned_paths', 'runtime-ref': 'runtime_ref' };
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
    const budget = state.budgetFor(db, id);
    const warn = budget && budget.status !== 'OK' && budget.status !== 'NO_USAGE_RECORDED' ? `\nBUDGET ${budget.status}: ${budget.percent.input}% in / ${budget.percent.output}% out of allocation ${budget.holder}. ${budget.status === 'EXHAUSTED' ? 'Stop at a safe point, set status=BLOCKED --blocker budget, and raise a budget ask.' : 'Finish the current step and report.'}` : '';
    out(args, { ok: true, applied, agent: db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(id), budget },
      `${id} ${applied.length ? applied.join(' ') : 'heartbeat'} at ${now()}${warn}`);
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







function budgetCommand(db, args, actor) {
  const action = args[1] || 'show';
  if (action === 'allocate') {
    const holder = need(flag(args, 'holder'), 'holder');
    const grantedBy = need(flag(args, 'granted-by'), 'granted-by');
    const parent = state.budgetRows(db).find(r => r.holder === grantedBy);
    const input = int(flag(args, 'input')), output = int(flag(args, 'output'));
    if (parent) {
      const siblings = db.prepare('SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM budget_allocations WHERE granted_by = ? AND holder != ?').get(grantedBy, holder);
      const overIn = parent.allocated.input_tokens !== UNKNOWN && siblings.i + (input || 0) > parent.allocated.input_tokens;
      const overOut = parent.allocated.output_tokens !== UNKNOWN && siblings.o + (output || 0) > parent.allocated.output_tokens;
      if ((overIn || overOut) && !has(args, 'force')) {
        out(args, { ok: false, reason: 'exceeds_parent', parent: parent.allocated, siblings },
          `REFUSED: ${grantedBy} would allocate more than it holds (children ${siblings.i + (input || 0)}in/${siblings.o + (output || 0)}out vs allocation ${parent.allocated.input_tokens}in/${parent.allocated.output_tokens}out). Raise ${grantedBy}'s allocation first, or pass --force with a recorded reason.`);
        process.exitCode = 4; return;
      }
    }
    const before = db.prepare('SELECT * FROM budget_allocations WHERE holder = ?').get(holder);
    db.prepare(`INSERT INTO budget_allocations(holder, granted_by, input_tokens, output_tokens, cost_usd, scope, granted_at, note)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(holder) DO UPDATE SET granted_by=excluded.granted_by, input_tokens=excluded.input_tokens,
                  output_tokens=excluded.output_tokens, cost_usd=excluded.cost_usd, scope=excluded.scope,
                  granted_at=excluded.granted_at, note=excluded.note`)
      .run(holder, grantedBy, input, output, flag(args, 'cost') ? Number(flag(args, 'cost')) : null, flag(args, 'scope') || null, now(), flag(args, 'note') || null);
    database.record(db, actor, 'budget', holder, 'allocation',
      before ? `${before.input_tokens}/${before.output_tokens}` : null, `${input}/${output}`, flag(args, 'reason') || null);
    emitEvent({ schema_version: '1.0', type: 'budget.changed', agent_id: actor, session_id: flag(args, 'session') || actor,
      budget: { action: 'allocate', holder, granted_by: grantedBy, input_tokens: input ?? undefined, output_tokens: output ?? undefined } }, { db });
    out(args, { ok: true, holder, allocated: { input, output } }, `allocated ${holder}: ${input}in/${output}out granted_by=${grantedBy}`);
    return;
  }
  if (action === 'ask') {
    const from = need(flag(args, 'from'), 'from');
    const to = need(flag(args, 'to'), 'to');
    const id = flag(args, 'id') || `B-${crypto.randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO budget_requests(id, from_holder, to_holder, input_tokens, output_tokens, cost_usd, reason, status, created_at)
                VALUES(?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`)
      .run(id, from, to, int(flag(args, 'input')), int(flag(args, 'output')), flag(args, 'cost') ? Number(flag(args, 'cost')) : null, flag(args, 'reason') || null, now());
    emitEvent({ schema_version: '1.0', type: 'budget.changed', agent_id: from, session_id: flag(args, 'session') || from,
      budget: { action: 'request', holder: from, granted_by: to, request_id: id, input_tokens: int(flag(args, 'input')) ?? undefined, output_tokens: int(flag(args, 'output')) ?? undefined } }, { db });
    out(args, { ok: true, id }, `budget ask ${id}: ${from} → ${to} for ${flag(args, 'input')}in/${flag(args, 'output')}out\nSet your row BLOCKED with blocker=budget until it is decided: brain.js agent set --agent-id ${from} --status BLOCKED --blocker ${id}`);
    return;
  }
  if (action === 'decide') {
    const id = need(flag(args, 'id'), 'id');
    const status = need(flag(args, 'status'), 'status').toUpperCase();
    if (!REQUEST_STATUS.has(status)) throw new Error(`status must be one of ${[...REQUEST_STATUS].join('|')}`);
    const req = db.prepare('SELECT * FROM budget_requests WHERE id = ?').get(id);
    if (!req) { out(args, { ok: false, reason: 'unknown_request' }, `unknown budget request ${id}`); process.exitCode = 1; return; }
    db.prepare('UPDATE budget_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(status, actor, now(), id);
    database.record(db, actor, 'budget_request', id, 'status', req.status, status, flag(args, 'reason') || null);
    emitEvent({ schema_version: '1.0', type: 'budget.changed', agent_id: actor, session_id: flag(args, 'session') || actor,
      budget: { action: status === 'GRANTED' ? 'grant' : status === 'PARTIAL' ? 'partial' : status === 'DENIED' ? 'deny' : 'request', holder: req.from_holder, granted_by: req.to_holder, request_id: id } }, { db });
    let note = '';
    if (status === 'GRANTED' || status === 'PARTIAL') {
      const current = db.prepare('SELECT * FROM budget_allocations WHERE holder = ?').get(req.from_holder);
      const addIn = int(flag(args, 'input')) ?? req.input_tokens ?? 0;
      const addOut = int(flag(args, 'output')) ?? req.output_tokens ?? 0;
      if (current) {
        db.prepare('UPDATE budget_allocations SET input_tokens = ?, output_tokens = ?, granted_at = ? WHERE holder = ?')
          .run((current.input_tokens || 0) + addIn, (current.output_tokens || 0) + addOut, now(), req.from_holder);
        note = `\nallocation ${req.from_holder} raised by ${addIn}in/${addOut}out`;
      } else {
        db.prepare('INSERT INTO budget_allocations(holder, granted_by, input_tokens, output_tokens, scope, granted_at) VALUES(?, ?, ?, ?, ?, ?)')
          .run(req.from_holder, req.to_holder, addIn, addOut, flag(args, 'scope') || null, now());
        note = `\nallocation ${req.from_holder} created with ${addIn}in/${addOut}out`;
      }
      database.record(db, actor, 'budget', req.from_holder, 'allocation', current ? `${current.input_tokens}/${current.output_tokens}` : null, `+${addIn}/+${addOut}`, `request ${id}`);
    }
    out(args, { ok: true, id, status }, `budget ask ${id} ${status} by ${actor}${note}`);
    return;
  }
  const rows = state.budgetRows(db);
  const cfg = database.config(db);
  const requests = db.prepare("SELECT * FROM budget_requests WHERE status IN ('PENDING','ESCALATED') ORDER BY created_at").all();
  const unbudgeted = db.prepare("SELECT DISTINCT agent_id FROM events WHERE type = 'model.completed'").all()
    .map(r => r.agent_id).filter(id => !state.budgetFor(db, id));
  const human = [
    `company ${cfg.company_input_tokens}in/${cfg.company_output_tokens}out cost=${cfg.company_cost_usd} warn_at=${cfg.warn_at_percent}% input_basis=${cfg.budget_input_basis || 'new'}`,
    ...rows.map(r => `${r.status.padEnd(18)} ${r.holder.padEnd(22)} ${String(r.spent.input_tokens).padStart(9)}/${String(r.allocated.input_tokens).padEnd(9)}in ${String(r.spent.output_tokens).padStart(8)}/${String(r.allocated.output_tokens).padEnd(8)}out granted_by=${r.granted_by}${r.over_allocated ? ' OVER-ALLOCATED' : ''}`),
    ...rows.filter(r => r.spent.cache_read_tokens).map(r => `${''.padEnd(18)} ${r.holder.padEnd(22)} components: fresh ${r.spent.fresh_input_tokens} + cache-write ${r.spent.cache_write_tokens} + cache-read ${r.spent.cache_read_tokens} (basis: ${r.spent.input_basis})`),
    ...(unbudgeted.length ? [`unbudgeted agents with spend: ${unbudgeted.join(', ')}`] : []),
    ...(requests.length ? ['open asks:', ...requests.map(r => `  ${r.id} ${r.from_holder} → ${r.to_holder} ${r.input_tokens}in/${r.output_tokens}out [${r.status}] ${r.reason || ''}`)] : [])
  ].join('\n');
  out(args, { company: cfg, holders: rows, open_requests: requests, unbudgeted_agents_with_spend: unbudgeted }, human);
}

// ─── quota, status, context ──────────────────────────────────────────────────
function quotaCommand(db, args) {
  const providers = (flag(args, 'provider') || '').split(',').map(s => s.trim()).filter(Boolean);
  const report = quota.read({ providers });
  if (!report.available) { out(args, report, `quota UNKNOWN: ${report.reason}`); return; }
  const ranked = quota.preferred(report.scopes);
  out(args, report, [
    `quota from ${report.command} at ${report.generated_at || now()}`,
    ...report.scopes.map(s => `${s.provider}/${s.scope} ${s.percent_remaining ?? UNKNOWN}% prio=${s.spend_priority ?? UNKNOWN} runway=${s.runway_status || UNKNOWN} pace=${s.pace_status || UNKNOWN}${s.stale ? ' STALE' : ''}`),
    ranked.length ? `prefer: ${ranked.slice(0, 3).map(s => `${s.provider}/${s.scope}`).join(' > ')}` : 'no healthy scope reported'
  ].join('\n'));
}



// One command an agent runs at session start: claims its role, then prints everything it needs.
function contextCommand(db, args, actor) {
  const role = flag(args, 'role') || 'ceo';
  const claim = claimSession(db, args, actor);
  if (!claim.ok) {
    out(args, { ok: false, ...claim }, [
      `REFUSED: role=${role} is already held by session ${claim.holder.id} (${claim.holder.harness}, heartbeat ${claim.age_minutes} min ago).`,
      `Do not act as ${role} in this session. Either work as a different role, or have the holder run:`,
      `  node ${path.relative(process.cwd(), __filename)} session release --id ${claim.holder.id}`
    ].join('\n'));
    process.exitCode = 3;
    return;
  }
  const session = claim.session;
  // The session's own model and effort become this role's current values in the registry.
  db.prepare(`INSERT INTO agents(agent_id, role, parent, session_id, harness, model, effort, status, started_at, last_heartbeat, current_operation)
              VALUES(?, ?, 'user', ?, ?, ?, ?, 'RUNNING', ?, ?, 'session start')
              ON CONFLICT(agent_id) DO UPDATE SET session_id=excluded.session_id, harness=excluded.harness,
                model=excluded.model, effort=excluded.effort, status='RUNNING', last_heartbeat=excluded.last_heartbeat`)
    .run(role, role, session.id, session.harness, session.model, session.effort, now(), now());
  database.record(db, actor, 'agent', role, 'session_start', null, `${session.model || UNKNOWN}/${session.effort || UNKNOWN}`, `session ${session.id}`);
  emitEvent({ schema_version: '1.0', type: 'agent.started', agent_id: role, session_id: session.id, role,
    model: session.model || undefined, effort: session.effort || undefined }, { db });
  const snapshot = state.statusData(db);
  const q = quota.read({});
  const data = { ok: true, session, role, state: snapshot, quota: q };
  out(args, data, [
    `You are the ${role}. Session ${session.id} on ${session.harness}; your model is ${session.model || UNKNOWN} at ${session.effort || UNKNOWN} effort, recorded as the ${role}'s current values.`,
    `You hold the ${role} lock: no other session may act as ${role} until this one is released.`,
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

// ─── runtime control (Herdr) ─────────────────────────────────────────────────
function controlCommand(db, args, actor) {
  const action = args[1];
  const id = need(flag(args, 'agent-id'), 'agent-id');
  const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(id);
  if (!agent) throw new Error(`unknown agent ${id}`);
  const result = control.controlAgent(agent, { action, text: flag(args, 'text'), confirm: has(args, 'confirm') });
  emitEvent({ schema_version: '1.0', type: 'control.completed', agent_id: id, session_id: agent.session_id || actor,
    control: { action, target: id, outcome: 'success' } }, { db });
  database.record(db, actor, 'agent', id, `control:${action}`, null, flag(args, 'text') || 'ok', flag(args, 'reason') || null);
  out(args, result, `${action} ${id} via ${agent.runtime}/${agent.runtime_ref}: ok`);
}

// ─── entry ───────────────────────────────────────────────────────────────────
function main(args = process.argv.slice(2)) {
  const group = args[0];
  const actor = flag(args, 'actor') || process.env.BRAIN_ACTOR || 'cli';
  if (!group || group === 'help' || group === '--help') {
    process.stdout.write(['brain.js <group> <action> [--flags]  ·  add --json to any command',
      '  context  --role ceo --harness <h> --model <id> --effort <level>   claim the role and print the full state',
      '  session  claim|release|heartbeat|list',
      '  agent    register|heartbeat|set|close|list|tree',
      '  budget   show|allocate|ask|decide',
      '  quota    [--provider claude,codex,...]', '  status', "  event    --event '<json>'", '  serve    [--port 4173]',
      '  control  focus|steer|interrupt|stop --agent-id A [--text "..."] [--confirm]   (requires a Herdr runtime binding)',
      '  config   show|set --key K --value V'].join('\n') + '\n');
    return;
  }
  if (group === 'serve') { require('./server').serve({ port: int(flag(args, 'port')) || 4173, host: flag(args, 'host') || '127.0.0.1' }); return; }
  const db = database.open(flag(args, 'db'));
  try {
    if (group === 'context') return contextCommand(db, args, actor);
    if (group === 'session') return sessionCommand(db, args, actor);
    if (group === 'agent') return agentCommand(db, args, actor);
    if (group === 'budget') return budgetCommand(db, args, actor);
    if (group === 'quota') return quotaCommand(db, args);
    if (group === 'control') return controlCommand(db, args, actor);
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
  try { main(); } catch (error) { process.stderr.write(`ERROR ${error.message}\n`); process.exitCode = 1; }
}
