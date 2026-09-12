#!/usr/bin/env node
'use strict';
// Tests for the control plane: event ingestion and its privacy boundary, the single-CEO session
// lock, subtree budget roll-up and its guards, runtime mutation with an audit trail, and the
// quota-axi adapter's normalization. Every test runs against a throwaway database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'control-plane');
const database = require(path.join(ROOT, 'db'));
const emitter = require(path.join(ROOT, 'emit'));
const state = require(path.join(ROOT, 'state'));
const brain = require(path.join(ROOT, 'brain'));
const quota = require(path.join(ROOT, 'quota'));

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-brain-cp-'));
  return { db: database.open(path.join(dir, 'brain.db')), dir };
}

const usage = (db, agent, input, output, cost) => emitter.emitEvent({
  schema_version: '1.0', type: 'model.completed', agent_id: agent, session_id: 's',
  usage: { input_tokens: input, output_tokens: output, ...(cost === undefined ? {} : { cost_usd: cost }), source: 'provider' }
}, { db });

function org(db) {
  const args = (id, role, parent, extra = {}) => ({ agent_id: id, role, parent, ...extra });
  for (const a of [args('ceo', 'ceo', 'user'), args('em-api-1', 'engineering-manager', 'ceo'),
    args('staff-1', 'backend-staff-engineer', 'em-api-1'), args('staff-2', 'backend-staff-engineer', 'em-api-1')]) {
    db.prepare(`INSERT INTO agents(agent_id, role, parent, status, started_at, last_heartbeat)
                VALUES(?, ?, ?, 'RUNNING', ?, ?)`).run(a.agent_id, a.role, a.parent, new Date().toISOString(), new Date().toISOString());
  }
}

// ─── events ──────────────────────────────────────────────────────────────────

test('an event is normalized, stored, and read back intact', () => {
  const { db } = fresh();
  const event = emitter.emitEvent({
    schema_version: '1.0', type: 'skill.loaded', agent_id: 'staff-1', session_id: 's',
    artifact: { kind: 'skill', name: 'lld', path: 'skills/lld/SKILL.md', bytes: 1200, tokens: 310, token_measurement: 'exact' }
  }, { db, now: () => '2026-09-12T10:15:00.000Z', id: () => 'event-1' });

  assert.equal(event.event_id, 'event-1');
  assert.equal(event.timestamp, '2026-09-12T10:15:00.000Z');
  assert.deepEqual(emitter.readEvents({ db }), [event]);
  const row = db.prepare('SELECT artifact_name, artifact_tokens, type FROM events WHERE event_id = ?').get('event-1');
  assert.deepEqual({ ...row }, { artifact_name: 'lld', artifact_tokens: 310, type: 'skill.loaded' });
});

test('content payloads are rejected and nothing is stored', () => {
  const { db } = fresh();
  assert.throws(() => emitter.emitEvent({
    schema_version: '1.0', type: 'model.completed', agent_id: 'staff-1', session_id: 's', prompt: 'secret'
  }, { db }), /unsupported field "prompt"/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
});

test('an observed model or effort updates the registry and is audited', () => {
  const { db } = fresh();
  org(db);
  db.prepare("UPDATE agents SET model = 'claude-sonnet-5' WHERE agent_id = 'staff-1'").run();
  emitter.emitEvent({ schema_version: '1.0', type: 'turn.completed', agent_id: 'staff-1', session_id: 's',
    model: 'claude-fable-5-1', turn: { number: 1, outcome: 'success' } }, { db });
  assert.equal(db.prepare("SELECT model FROM agents WHERE agent_id = 'staff-1'").get().model, 'claude-fable-5-1');
  const change = db.prepare("SELECT * FROM changes WHERE field = 'model' ORDER BY id DESC").get();
  assert.equal(change.old_value, 'claude-sonnet-5');
  assert.equal(change.new_value, 'claude-fable-5-1');
});

test('budget.changed events validate their action', () => {
  const { db } = fresh();
  const ok = emitter.emitEvent({ schema_version: '1.0', type: 'budget.changed', agent_id: 'em-api-1', session_id: 's',
    budget: { action: 'allocate', holder: 'staff-1', granted_by: 'em-api-1', input_tokens: 10000 } }, { db });
  assert.equal(ok.budget.action, 'allocate');
  assert.throws(() => emitter.emitEvent({ schema_version: '1.0', type: 'budget.changed', agent_id: 'a', session_id: 's',
    budget: { action: 'steal', holder: 'b' } }, { db }), /unsupported budget action/);
});

// ─── sessions: the single-CEO lock ───────────────────────────────────────────

test('only one live session may hold the CEO role', () => {
  const { db } = fresh();
  const first = brain.claimSession(db, ['session', 'claim', '--role', 'ceo', '--harness', 'claude-code', '--model', 'claude-opus-5', '--effort', 'high', '--id', 'sess-a'], 'cli');
  assert.equal(first.ok, true);
  assert.equal(first.session.model, 'claude-opus-5');

  const second = brain.claimSession(db, ['session', 'claim', '--role', 'ceo', '--harness', 'codex', '--id', 'sess-b'], 'cli');
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'role_taken');
  assert.equal(second.holder.id, 'sess-a');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE released_at IS NULL').get().n, 1);
});

test('a released role can be claimed again', () => {
  const { db } = fresh();
  brain.claimSession(db, ['x', 'x', '--role', 'ceo', '--harness', 'a', '--id', 'sess-a'], 'cli');
  db.prepare("UPDATE sessions SET released_at = ? WHERE id = 'sess-a'").run(new Date().toISOString());
  assert.equal(brain.claimSession(db, ['x', 'x', '--role', 'ceo', '--harness', 'b', '--id', 'sess-b'], 'cli').ok, true);
});

test('a stale session is reclaimed rather than blocking forever', () => {
  const { db } = fresh();
  brain.claimSession(db, ['x', 'x', '--role', 'ceo', '--harness', 'a', '--id', 'sess-a'], 'cli');
  const old = new Date(Date.now() - 90 * 60000).toISOString();
  db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = 'sess-a'").run(old);
  const taken = brain.claimSession(db, ['x', 'x', '--role', 'ceo', '--harness', 'b', '--id', 'sess-b'], 'cli');
  assert.equal(taken.ok, true);
  assert.equal(taken.reclaimed.id, 'sess-a');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE released_at IS NULL').get().n, 1);
});

test('roles other than CEO are not exclusive', () => {
  const { db } = fresh();
  assert.equal(brain.claimSession(db, ['x', 'x', '--role', 'engineering-manager', '--harness', 'a', '--id', 'em-a'], 'cli').ok, true);
  assert.equal(brain.claimSession(db, ['x', 'x', '--role', 'engineering-manager', '--harness', 'b', '--id', 'em-b'], 'cli').ok, true);
});

// ─── budgets ─────────────────────────────────────────────────────────────────

test('spend rolls up the parent tree and flags warning and exhaustion', () => {
  const { db } = fresh();
  org(db);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO budget_allocations(holder, granted_by, input_tokens, output_tokens, granted_at) VALUES(?, ?, ?, ?, ?)')
    .run('em-api-1', 'ceo', 40000, 40000, now);
  db.prepare('INSERT INTO budget_allocations(holder, granted_by, input_tokens, output_tokens, granted_at) VALUES(?, ?, ?, ?, ?)')
    .run('staff-1', 'em-api-1', 10000, 10000, now);
  usage(db, 'staff-1', 9000, 2000);
  usage(db, 'staff-2', 20000, 5000);
  usage(db, 'ceo', 1000, 500);

  const rows = Object.fromEntries(state.budgetRows(db).map(r => [r.holder, r]));
  assert.equal(rows['staff-1'].spent.input_tokens, 9000);
  assert.equal(rows['staff-1'].status, 'WARN');                 // 90% of input
  assert.equal(rows['em-api-1'].spent.input_tokens, 29000);     // its own subtree, both engineers
  assert.equal(rows['em-api-1'].status, 'OK');
  assert.equal(rows.ceo.spent.input_tokens, 30000);             // whole company
  assert.equal(rows.ceo.remaining.output_tokens, 100000 - 7500);

  usage(db, 'staff-1', 2000, 0);
  assert.equal(state.budgetRows(db).find(r => r.holder === 'staff-1').status, 'EXHAUSTED');
});

test('an agent inherits the nearest budgeted ancestor, and an unbudgeted agent has none', () => {
  const { db } = fresh();
  org(db);
  db.prepare('INSERT INTO budget_allocations(holder, granted_by, input_tokens, output_tokens, granted_at) VALUES(?, ?, ?, ?, ?)')
    .run('em-api-1', 'ceo', 40000, 40000, new Date().toISOString());
  assert.equal(state.budgetFor(db, 'staff-2').holder, 'em-api-1');
  db.prepare(`INSERT INTO agents(agent_id, role, parent, status, started_at) VALUES('orphan', 'web-staff-engineer', NULL, 'RUNNING', ?)`)
    .run(new Date().toISOString());
  assert.equal(state.budgetFor(db, 'orphan'), null);
});

test('child allocations that exceed the parent are reported as over-allocated', () => {
  const { db } = fresh();
  org(db);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO budget_allocations(holder, granted_by, input_tokens, output_tokens, granted_at) VALUES(?, ?, ?, ?, ?)').run('em-api-1', 'ceo', 10000, 10000, now);
  db.prepare('INSERT INTO budget_allocations(holder, granted_by, input_tokens, output_tokens, granted_at) VALUES(?, ?, ?, ?, ?)').run('staff-1', 'em-api-1', 9000, 9000, now);
  db.prepare('INSERT INTO budget_allocations(holder, granted_by, input_tokens, output_tokens, granted_at) VALUES(?, ?, ?, ?, ?)').run('staff-2', 'em-api-1', 9000, 9000, now);
  assert.equal(state.budgetRows(db).find(r => r.holder === 'em-api-1').over_allocated, true);
});

test('a holder with no usage events reports NO_USAGE_RECORDED rather than zero spend', () => {
  const { db } = fresh();
  org(db);
  assert.equal(state.budgetRows(db).find(r => r.holder === 'ceo').status, 'NO_USAGE_RECORDED');
});

// ─── status and conflicts ────────────────────────────────────────────────────

test('two running agents owning one path is reported as a conflict', () => {
  const { db } = fresh();
  org(db);
  db.prepare("UPDATE agents SET owned_paths = 'backend/orders/**' WHERE agent_id IN ('staff-1','staff-2')").run();
  const conflicts = state.pathConflicts(db);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].agents.sort(), ['staff-1', 'staff-2']);
});

test('status reports stale running agents and renders without throwing', () => {
  const { db } = fresh();
  org(db);
  db.prepare("UPDATE agents SET last_heartbeat = ? WHERE agent_id = 'staff-1'").run(new Date(Date.now() - 60 * 60000).toISOString());
  const s = state.statusData(db);
  assert.deepEqual(s.stale.map(a => a.agent_id), ['staff-1']);
  assert.match(state.renderStatus(s), /staff-1/);
});

test('the agent tree nests children under their parent', () => {
  const { db } = fresh();
  org(db);
  const tree = state.tree(db);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].agent_id, 'ceo');
  assert.deepEqual(tree[0].children[0].children.map(c => c.agent_id).sort(), ['staff-1', 'staff-2']);
});

// ─── audit ───────────────────────────────────────────────────────────────────

test('config changes and mutations are recorded with actor and reason', () => {
  const { db } = fresh();
  database.setConfig(db, 'warn_at_percent', '70', 'ceo', 'tighter guard for this project');
  const change = db.prepare("SELECT * FROM changes WHERE entity = 'config' ORDER BY id DESC").get();
  assert.equal(change.actor, 'ceo');
  assert.equal(change.old_value, '80');
  assert.equal(change.new_value, '70');
  assert.equal(change.reason, 'tighter guard for this project');
  assert.equal(database.config(db).warn_at_percent, '70');
});

// ─── quota-axi adapter ───────────────────────────────────────────────────────

test('quota-axi output is normalized to one row per scope and ranked by spend priority', () => {
  const payload = {
    generatedAt: '2026-09-12T16:00:00Z', schemaVersion: 5,
    providers: [
      { provider: 'claude', plan: 'max', state: { status: 'fresh', stale: false, authStatus: 'usable' },
        quotaSemantics: { status: 'known', effectiveAvailability: [
          { scope: 'session', status: 'known', effectivePercentRemaining: 62, selection: { spendPriority: 18 }, runway: { status: 'through_reset' }, pace: { status: 'ahead', burnMultiple: 0.8 } },
          { scope: 'weekly', status: 'known', effectivePercentRemaining: 12, selection: { spendPriority: -40 }, runway: { status: 'projected_exhaustion' }, pace: { status: 'behind' } }] } },
      { provider: 'codex', plan: 'pro', state: { status: 'fresh' },
        quotaSemantics: { effectiveAvailability: [{ scope: 'weekly', status: 'known', effectivePercentRemaining: 88, selection: { spendPriority: 55 }, runway: { status: 'through_reset' } }] } }
    ]
  };
  const normalized = quota.normalize(payload);
  assert.equal(normalized.scopes.length, 3);
  assert.deepEqual(quota.preferred(normalized.scopes).map(s => `${s.provider}/${s.scope}`), ['codex/weekly', 'claude/session', 'claude/weekly']);
  assert.equal(normalized.providers.find(p => p.provider === 'claude').auth, 'usable');
});

test('an exhausted scope is never preferred', () => {
  const scopes = quota.normalize({ providers: [{ provider: 'kimi', quotaSemantics: { effectiveAvailability: [
    { scope: 'weekly', status: 'known', effectivePercentRemaining: 0, selection: { spendPriority: 90 } }] } }] }).scopes;
  assert.deepEqual(quota.preferred(scopes), []);
});

// ─── the CLI itself ──────────────────────────────────────────────────────────
// These drive brain.js as a subprocess. The unit tests above exercise the modules directly, which
// would not have caught a broken SQL string inside a command handler.

const { spawnSync } = require('node:child_process');

function cli(dbFile, args) {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'brain.js'), ...args, '--db', dbFile],
    { encoding: 'utf8', env: { ...process.env, BRAIN_DB: dbFile } });
  return { code: run.status, out: run.stdout, err: run.stderr };
}

test('the CLI runs the whole session, register, budget, and status path', () => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-brain-cli-')), 'brain.db');

  const context = cli(dbFile, ['context', '--role', 'ceo', '--harness', 'claude-code', '--model', 'claude-opus-5', '--effort', 'high']);
  assert.equal(context.code, 0, context.err);
  assert.match(context.out, /You are the ceo/);
  assert.match(context.out, /claude-opus-5 at high effort/);

  const second = cli(dbFile, ['context', '--role', 'ceo', '--harness', 'codex', '--model', 'gpt-5-codex', '--effort', 'high']);
  assert.equal(second.code, 3, 'a second CEO session must be refused with exit 3');
  assert.match(second.out, /REFUSED/);

  assert.equal(cli(dbFile, ['budget', 'allocate', '--holder', 'em-api-1', '--granted-by', 'ceo', '--input', '40000', '--output', '40000', '--actor', 'ceo']).code, 0);
  const over = cli(dbFile, ['budget', 'allocate', '--holder', 'em-web-1', '--granted-by', 'ceo', '--input', '80000', '--output', '80000', '--actor', 'ceo']);
  assert.equal(over.code, 4, 'over-allocating the grantor must be refused with exit 4');

  const register = cli(dbFile, ['agent', 'register', '--agent-id', 'staff-1', '--role', 'backend-staff-engineer',
    '--parent', 'em-api-1', '--ticket', 'ENG-42', '--model', 'claude-sonnet-5', '--effort', 'medium', '--paths', 'backend/orders/**', '--actor', 'em-api-1']);
  assert.equal(register.code, 0, register.err);
  assert.match(register.out, /registered staff-1/);
  assert.match(register.out, /budget em-api-1/, 'registration should report the covering allocation');

  const orphan = cli(dbFile, ['agent', 'register', '--agent-id', 'orphan-1', '--role', 'web-staff-engineer', '--actor', 'ceo']);
  assert.match(orphan.out, /no allocation covers this agent/);

  cli(dbFile, ['event', '--event', JSON.stringify({ schema_version: '1.0', type: 'model.completed', agent_id: 'staff-1',
    session_id: 's', usage: { input_tokens: 39000, output_tokens: 1000, cost_usd: 1.2, source: 'provider' } })]);
  const beat = cli(dbFile, ['agent', 'heartbeat', '--agent-id', 'staff-1', '--operation', 'implementing']);
  assert.match(beat.out, /BUDGET WARN/, 'a heartbeat past the warning threshold must say so');

  const set = cli(dbFile, ['agent', 'set', '--agent-id', 'staff-1', '--model', 'claude-fable-5-1', '--effort', 'max', '--reason', 'T3', '--actor', 'em-api-1']);
  assert.match(set.out, /model=claude-fable-5-1 effort=max/);

  const status = JSON.parse(cli(dbFile, ['status', '--json']).out);
  assert.equal(status.tree[0].agent_id, 'ceo');
  assert.equal(status.budgets.find(b => b.holder === 'em-api-1').spent.input_tokens, 39000);
  assert.ok(status.recent_changes.some(c => c.field === 'model' && c.new_value === 'claude-fable-5-1'));

  const ask = cli(dbFile, ['budget', 'ask', '--from', 'staff-1', '--to', 'em-api-1', '--input', '5000', '--output', '1000', '--reason', 'half done', '--id', 'B-test']);
  assert.equal(ask.code, 0, ask.err);
  assert.equal(cli(dbFile, ['budget', 'decide', '--id', 'B-test', '--status', 'GRANTED', '--actor', 'em-api-1']).code, 0);
  const after = JSON.parse(cli(dbFile, ['budget', '--json']).out);
  assert.equal(after.holders.find(h => h.holder === 'staff-1').allocated.input_tokens, 5000, 'a granted ask creates or raises the allocation');
  assert.equal(after.open_requests.length, 0);

  assert.match(cli(dbFile, ['agent', 'tree']).out, /staff-1/);
  assert.equal(cli(dbFile, ['session', 'list']).code, 0);
  assert.match(cli(dbFile, ['config']).out, /company_input_tokens=100000/);
});

test('the CLI refuses control without a Herdr binding and without confirmation', () => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-brain-cli2-')), 'brain.db');
  cli(dbFile, ['agent', 'register', '--agent-id', 'staff-1', '--role', 'backend-staff-engineer', '--actor', 'ceo']);
  assert.match(cli(dbFile, ['control', 'focus', '--agent-id', 'staff-1']).err, /no Herdr runtime binding/);
});

// ─── automatic usage capture ─────────────────────────────────────────────────
// The hook turns real runtime facts into events. These tests pin the two properties that matter:
// usage is never double-counted, and the cache-aware budget basis is honest about what it counts.

const hook = require(path.join(ROOT, 'hook'));

function transcript(dir, messages) {
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, messages.map(m => JSON.stringify({
    type: 'assistant', uuid: m.uuid, timestamp: m.timestamp || '2026-09-13T10:00:00.000Z',
    ...(m.sidechain ? { isSidechain: true } : {}),
    message: { model: m.model || 'claude-opus-5', usage: {
      input_tokens: m.input ?? 0, output_tokens: m.output ?? 0,
      cache_read_input_tokens: m.cacheRead ?? 0, cache_creation_input_tokens: m.cacheWrite ?? 0
    } }
  })).join('\n') + '\n');
  return file;
}

test('the hook ingests transcript usage and never double-counts it', () => {
  const { db, dir } = fresh();
  org(db);
  const file = transcript(dir, [
    { uuid: 'a', input: 10, output: 100, cacheRead: 5000, cacheWrite: 200 },
    { uuid: 'b', input: 20, output: 200, cacheRead: 6000, cacheWrite: 300 }
  ]);

  const first = hook.ingest(db, { transcript: file, sessionId: 's1', agentId: 'staff-1' });
  assert.equal(first.recorded, 2);
  assert.equal(first.turns, 2);

  const second = hook.ingest(db, { transcript: file, sessionId: 's1', agentId: 'staff-1' });
  assert.equal(second.recorded, 0, 'a second run must record nothing');
  assert.equal(second.skipped, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'model.completed'").get().n, 2);
});

test('an appended message is picked up without re-counting the earlier ones', () => {
  const { db, dir } = fresh();
  org(db);
  const file = transcript(dir, [{ uuid: 'a', input: 10, output: 100 }]);
  hook.ingest(db, { transcript: file, sessionId: 's1', agentId: 'staff-1' });
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'b',
    message: { model: 'claude-opus-5', usage: { input_tokens: 30, output_tokens: 300 } } }) + '\n');
  const again = hook.ingest(db, { transcript: file, sessionId: 's1', agentId: 'staff-1' });
  assert.equal(again.recorded, 1);
  assert.equal(db.prepare("SELECT SUM(output_tokens) t FROM events WHERE type = 'model.completed'").get().t, 400);
});

test('context size is recorded as fresh input plus cache traffic, marked exact', () => {
  const { db, dir } = fresh();
  org(db);
  const file = transcript(dir, [{ uuid: 'a', input: 10, output: 100, cacheRead: 5000, cacheWrite: 200 }]);
  hook.ingest(db, { transcript: file, sessionId: 's1', agentId: 'staff-1' });
  const row = db.prepare("SELECT context_input_tokens c, context_measurement m FROM events WHERE type = 'model.completed'").get();
  assert.equal(row.c, 5210);
  assert.equal(row.m, 'exact');
});

test('the budget input basis decides what cache traffic counts toward an allocation', () => {
  const { db, dir } = fresh();
  org(db);
  const file = transcript(dir, [{ uuid: 'a', input: 100, output: 50, cacheWrite: 900, cacheRead: 50000 }]);
  hook.ingest(db, { transcript: file, sessionId: 's1', agentId: 'staff-1' });

  assert.equal(database.spend(db, 'staff-1', 'fresh').input_tokens, 100);
  assert.equal(database.spend(db, 'staff-1', 'new').input_tokens, 1000);
  assert.equal(database.spend(db, 'staff-1', 'billable').input_tokens, 51000);

  // Whatever the basis, every component stays visible so the number is never misleading.
  const spent = database.spend(db, 'staff-1');
  assert.equal(spent.input_basis, 'new');
  assert.equal(spent.fresh_input_tokens, 100);
  assert.equal(spent.cache_write_tokens, 900);
  assert.equal(spent.cache_read_tokens, 50000);

  database.setConfig(db, 'budget_input_basis', 'billable', 'test');
  assert.equal(database.spend(db, 'staff-1').input_tokens, 51000);
});

test('a tool hook records the call and its outcome without capturing arguments', () => {
  const { db } = fresh();
  org(db);
  const before = db.prepare('SELECT COUNT(*) n FROM events').get().n;
  emitter.emitEvent({ schema_version: '1.0', type: 'tool.completed', agent_id: 'staff-1', session_id: 's1',
    tool: { name: 'Bash', outcome: 'error' } }, { db });
  const row = db.prepare("SELECT tool_name, tool_outcome, raw FROM events WHERE type = 'tool.completed'").get();
  assert.equal(row.tool_name, 'Bash');
  assert.equal(row.tool_outcome, 'error');
  assert.ok(!row.raw.includes('tool_input'), 'a tool event must not carry its arguments');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, before + 1);
});

test('the hook attributes usage to the agent bound to the session', () => {
  const { db, dir } = fresh();
  org(db);
  db.prepare("UPDATE agents SET session_id = 'sess-x' WHERE agent_id = 'staff-2'").run();
  assert.equal(hook.resolveAgent(db, 'sess-x'), 'staff-2');
  // With no binding at all it falls back to the running CEO rather than dropping the usage.
  assert.equal(hook.resolveAgent(db, 'sess-unknown'), 'ceo');
});

test('a malformed or missing transcript yields no events instead of throwing', () => {
  const { db, dir } = fresh();
  org(db);
  assert.deepEqual(hook.transcriptMessages(path.join(dir, 'nope.jsonl'), 10), []);
  const bad = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(bad, 'not json\n{"type":"assistant"}\n');
  assert.deepEqual(hook.transcriptMessages(bad, 10), []);
  assert.equal(hook.ingest(db, { transcript: bad, sessionId: 's', agentId: 'staff-1' }).recorded, 0);
});
