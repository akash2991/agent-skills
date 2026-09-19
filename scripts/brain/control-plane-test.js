#!/usr/bin/env node
'use strict';
// Tests for the control plane: event ingestion and its privacy boundary, usage capture from harness
// transcripts and its attribution, the usage summary, the CLI, and the Langfuse export. Every test
// runs against a throwaway database. Sessions, the agent registry, and quota belong to firstmate and
// have no tests here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', 'control-plane');
const database = require(path.join(ROOT, 'db'));
const emitter = require(path.join(ROOT, 'emit'));
const langfuse = require(path.join(ROOT, 'langfuse'));
const hook = require(path.join(ROOT, 'hook'));

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-brain-cp-'));
  return { db: database.open(path.join(dir, 'brain.db')), dir, file: path.join(dir, 'brain.db') };
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

test('terminal control is firstmate\'s, so a control event is not representable', () => {
  const { db } = fresh();
  assert.throws(() => emitter.emitEvent({
    schema_version: '1.0', type: 'control.completed', agent_id: 'a', session_id: 's',
    control: { action: 'stop', target: 'a', outcome: 'success' }
  }, { db }), /unsupported (field|event type)/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
});

test('an event for an agent nobody registered is recorded as reported', () => {
  const { db } = fresh();
  emitter.emitEvent({ schema_version: '1.0', type: 'turn.completed', agent_id: 'fm-task-7', session_id: 's',
    model: 'claude-fable-5-1', effort: 'high', turn: { number: 1, outcome: 'success' } }, { db });
  const row = db.prepare("SELECT agent_id, model, effort FROM events WHERE type = 'turn.completed'").get();
  assert.deepEqual({ ...row }, { agent_id: 'fm-task-7', model: 'claude-fable-5-1', effort: 'high' });
});

// ─── config and usage ────────────────────────────────────────────────────────

test('a config change is stored with who made it', () => {
  const { db } = fresh();
  database.setConfig(db, 'langfuse_export', 'off', 'user');
  assert.equal(database.config(db).langfuse_export, 'off');
  assert.equal(db.prepare("SELECT updated_by FROM config WHERE key = 'langfuse_export'").get().updated_by, 'user');
});

const usage = (db, agent, session, u) => emitter.emitEvent({
  schema_version: '1.0', type: 'model.completed', agent_id: agent, session_id: session, model: 'claude-opus-5',
  usage: { source: 'provider', ...u }
}, { db });

test('usage is summarized per agent and session, with every input component visible', () => {
  const { db } = fresh();
  usage(db, 't-1', 's1', { input_tokens: 10, cache_write_input_tokens: 200, cache_read_input_tokens: 5000, output_tokens: 100, cost_usd: 0.5 });
  usage(db, 't-1', 's1', { input_tokens: 5, output_tokens: 50 });
  usage(db, 't-2', 's2', { input_tokens: 1, output_tokens: 1 });

  const summary = database.usage(db);
  assert.equal(summary.input_basis, 'new');
  const t1 = summary.rows.find(r => r.agent_id === 't-1');
  assert.equal(t1.input_tokens, 215, 'new = fresh input plus cache writes');
  assert.equal(t1.fresh_input_tokens, 15);
  assert.equal(t1.cache_read_tokens, 5000);
  assert.equal(t1.output_tokens, 150);
  assert.equal(t1.cost_usd, 0.5);
  assert.equal(t1.usage_events, 2);
  assert.equal(database.usage(db, 'billable').rows.find(r => r.agent_id === 't-1').input_tokens, 5215);
  assert.equal(summary.rows.length, 2);
});

// ─── the CLI itself ──────────────────────────────────────────────────────────
// These drive brain.js as a subprocess. The unit tests above exercise the modules directly, which
// would not have caught a broken SQL string inside a command handler.

function cli(dbFile, args) {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'brain.js'), ...args, '--db', dbFile],
    { encoding: 'utf8', env: { ...process.env, BRAIN_DB: dbFile } });
  return { code: run.status, out: run.stdout, err: run.stderr };
}

test('the CLI records an event and reports it in status', () => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-brain-cli-')), 'brain.db');
  const recorded = cli(dbFile, ['event', '--event', JSON.stringify({ schema_version: '1.0', type: 'model.completed', agent_id: 't-42',
    session_id: 's', usage: { input_tokens: 39000, output_tokens: 1000, cost_usd: 1.2, source: 'provider' } })]);
  assert.equal(recorded.code, 0, recorded.err);
  assert.match(recorded.out, /recorded model.completed for t-42/);

  const status = JSON.parse(cli(dbFile, ['status', '--json']).out);
  assert.equal(status.usage[0].agent_id, 't-42');
  assert.equal(status.usage[0].output_tokens, 1000);
  assert.equal(status.event_counts['model.completed'], 1);

  const human = cli(dbFile, ['status']);
  assert.equal(human.code, 0, human.err);
  assert.match(human.out, /t-42/);
  assert.match(human.out, /Langfuse tracing:/, 'status must say whether tracing is on');
});

test('a command firstmate now owns points there instead of failing silently', () => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-brain-moved-')), 'brain.db');
  for (const group of ['context', 'session', 'agent', 'quota', 'serve']) {
    const run = cli(dbFile, [group]);
    assert.equal(run.code, 2, `${group} must exit non-zero`);
    assert.match(run.err, /firstmate/, `${group} must name where it went`);
  }
});

// ─── observability export ────────────────────────────────────────────────────

const spansOf = db => langfuse.buildPayload(db, langfuse.pending(db, {}), 'test').resourceSpans[0].scopeSpans[0].spans;
const attrOf = (span, key) => span.attributes.find(a => a.key === key)?.value;
const roots = spans => spans.filter(s => attrOf(s, 'langfuse.observation.type')?.stringValue === 'agent');

test('the Langfuse export nests an agent under the parent its events name, and never carries content', () => {
  const { db } = fresh();
  emitter.emitEvent({ schema_version: '1.0', event_id: 'a1', type: 'agent.started', agent_id: 'em-1', session_id: 's1',
    role: 'engineering-manager', timestamp: '2026-09-13T10:00:00.000Z' }, { db });
  emitter.emitEvent({ schema_version: '1.0', event_id: 'a2', type: 'agent.started', agent_id: 'staff-1', session_id: 's2',
    role: 'backend-staff-engineer', parent_agent_id: 'em-1', timestamp: '2026-09-13T10:01:00.000Z' }, { db });
  emitter.emitEvent({ schema_version: '1.0', event_id: 'e1', type: 'model.completed', agent_id: 'staff-1', session_id: 's2',
    model: 'claude-opus-5', effort: 'high',
    usage: { input_tokens: 5, output_tokens: 7, thinking_tokens: 3, source: 'runtime' } }, { db });

  const spans = spansOf(db);
  const byName = n => spans.find(s => s.name === n);
  assert.equal(byName('backend-staff-engineer').parentSpanId, byName('engineering-manager').spanId);
  const gen = byName('generate-response');
  assert.equal(attrOf(gen, 'langfuse.observation.type').stringValue, 'generation');
  assert.equal(attrOf(gen, 'langfuse.observation.model.name').stringValue, 'claude-opus-5');
  assert.match(attrOf(gen, 'langfuse.observation.usage_details').stringValue, /"reasoning":3/);
  assert.ok(!spans.some(s => /claude-opus-5|staff-1|turn \d/.test(s.name)), 'span names must stay stable and low-cardinality');
  const serialized = JSON.stringify(spans);
  for (const forbidden of ['gen_ai.prompt', 'gen_ai.completion', 'input.value', 'output.value']) {
    assert.ok(!serialized.includes(forbidden), `payload must not carry ${forbidden}`);
  }
});

test('an agent whose parent sent no events is not nested under a span that was never sent', () => {
  const { db } = fresh();
  emitter.emitEvent({ schema_version: '1.0', type: 'turn.completed', agent_id: 'child', session_id: 's',
    parent_agent_id: 'ghost', turn: { number: 1, outcome: 'success' } }, { db });
  const [root] = roots(spansOf(db));
  assert.equal(root.parentSpanId, undefined);
});

test('a trace is named for what is known, never for a placeholder', () => {
  const { db } = fresh();
  emitter.emitEvent({ schema_version: '1.0', type: 'turn.completed', agent_id: 'session-778cf7e2',
    session_id: '778cf7e2-c6ae', turn: { number: 1, outcome: 'success' } }, { db });
  emitter.emitEvent({ schema_version: '1.0', type: 'turn.completed', agent_id: 'login-fix',
    session_id: 'aaaa1111', turn: { number: 1, outcome: 'success' } }, { db });
  const names = roots(spansOf(db)).map(r => r.name).sort();
  assert.deepEqual(names, ['login-fix', 'session 778cf7e2'], 'a firstmate task id names its trace; a bare session falls back to its id');
  for (const r of roots(spansOf(db))) {
    assert.ok(!r.attributes.some(a => a.key === 'langfuse.user.id'), 'no user id rather than a meaningless one');
  }
});

test('an exported event is not exported twice', async () => {
  const { db, dir } = fresh();
  emitter.emitEvent({ schema_version: '1.0', event_id: 'e1', type: 'turn.completed', agent_id: 't-1', session_id: 's1',
    turn: { number: 1, outcome: 'success' } }, { db });
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, ['LANGFUSE_PUBLIC_KEY=pk', 'LANGFUSE_SECRET_KEY=sk', 'LANGFUSE_BASE_URL=https://example.invalid'].join('\n'));
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, status: 207, text: async () => '' }; };

  const first = await langfuse.send(db, { envFile, fetchImpl });
  const second = await langfuse.send(db, { envFile, fetchImpl });
  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(calls, 1, 'the second run must not post anything');
});

// ─── automatic usage capture ─────────────────────────────────────────────────
// The hook turns real runtime facts into events. These tests pin the properties that matter: usage is
// never double-counted, it lands on the task that spent it, and a hook never loses a gap.

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
  const file = transcript(dir, [{ uuid: 'a', input: 10, output: 100, cacheRead: 5000, cacheWrite: 200 }]);
  hook.ingest(db, { transcript: file, sessionId: 's1', agentId: 'staff-1' });
  const row = db.prepare("SELECT context_input_tokens c, context_measurement m FROM events WHERE type = 'model.completed'").get();
  assert.equal(row.c, 5210);
  assert.equal(row.m, 'exact');
});

test('a tool hook records the call and its outcome without capturing arguments', () => {
  const { db } = fresh();
  emitter.emitEvent({ schema_version: '1.0', type: 'tool.completed', agent_id: 'staff-1', session_id: 's1',
    tool: { name: 'Bash', outcome: 'error' } }, { db });
  const row = db.prepare("SELECT tool_name, tool_outcome, raw FROM events WHERE type = 'tool.completed'").get();
  assert.equal(row.tool_name, 'Bash');
  assert.equal(row.tool_outcome, 'error');
  assert.ok(!row.raw.includes('tool_input'), 'a tool event must not carry its arguments');
});

test('usage is attributed to an explicit id, then the firstmate task, then the harness session', () => {
  assert.equal(hook.agentFor('abcdef123456', {}), 'session-abcdef12');
  assert.equal(hook.agentFor('abcdef123456', { FM_TASK_ID: 'login-fix' }), 'login-fix');
  assert.equal(hook.agentFor('abcdef123456', { FM_TASK_ID: 'login-fix', BRAIN_AGENT_ID: 'explicit' }), 'explicit');
});

test('a turn hook fired inside a firstmate pane records usage against that task', () => {
  const { db, dir, file: dbFile } = fresh();
  // Keep the hook from shipping anything anywhere, whatever credentials this machine has.
  database.setConfig(db, 'langfuse_export', 'off', 'test');
  db.close();
  const file = transcript(dir, [{ uuid: 'a', input: 1, output: 10 }, { uuid: 'b', input: 2, output: 20 }]);
  const env = { ...process.env, BRAIN_DB: dbFile, FM_TASK_ID: 'login-fix' };
  delete env.BRAIN_AGENT_ID;
  const run = spawnSync(process.execPath, [path.join(ROOT, 'hook.js'), 'turn'],
    { encoding: 'utf8', env, input: JSON.stringify({ session_id: 'sess-1234abcd', transcript_path: file }) });
  assert.equal(run.status, 0, run.stderr);
  const after = database.open(dbFile);
  assert.deepEqual(after.prepare('SELECT DISTINCT agent_id FROM events').all().map(r => r.agent_id), ['login-fix']);
  assert.equal(after.prepare("SELECT SUM(output_tokens) s FROM events WHERE type = 'model.completed'").get().s, 30);
  after.close();
});

test('a hook that fell behind catches up instead of losing the gap forever', () => {
  const { db, dir } = fresh();
  // The hook used to read only the last 40 messages. A session that produced more than that between
  // firings lost the difference permanently, because a skipped message is never revisited: a real
  // session recorded 47 of 499. Ingestion must be self-healing, not window-bound.
  const many = Array.from({ length: 120 }, (_, i) => ({ uuid: `m${i}`, input: 1, output: 10 }));
  const file = transcript(dir, many);
  const first = hook.ingest(db, { transcript: file, sessionId: 'sess-x', agentId: 't-1' });
  assert.equal(first.recorded, 120, 'every message in the transcript is recorded, however far back');

  const second = hook.ingest(db, { transcript: file, sessionId: 'sess-x', agentId: 't-1' });
  assert.equal(second.recorded, 0);
  assert.equal(second.skipped, 120);
  assert.equal(db.prepare("SELECT SUM(output_tokens) s FROM events WHERE type = 'model.completed'").get().s, 1200);
});

test('a malformed or missing transcript yields no events instead of throwing', () => {
  const { db, dir } = fresh();
  assert.deepEqual(hook.transcriptMessages(path.join(dir, 'nope.jsonl'), 10), []);
  const bad = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(bad, 'not json\n{"type":"assistant"}\n');
  assert.deepEqual(hook.transcriptMessages(bad, 10), []);
  assert.equal(hook.ingest(db, { transcript: bad, sessionId: 's', agentId: 'staff-1' }).recorded, 0);
});
