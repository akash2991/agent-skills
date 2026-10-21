'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createFlow, ADAPTER_LIMITS } = require('../runtime/langfuse/flow.cjs');
const { OUTBOX_LIMITS } = require('../runtime/langfuse/export.cjs');
const { dependencyCacheDir } = require('../runtime/langfuse/dependencies.cjs');
const { handleClaudeHook } = require('../runtime/langfuse/claude.cjs');
const { runContext } = require('../runtime/langfuse/context-cli.cjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-real-flow-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  const put = (rel, body) => { const file = path.join(cwd, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
  put('.agent-brain/tracing.json', JSON.stringify({ schema: 1, enabled: true, captureMode: 'metadata-only' }));
  put('.agent-brain/observability/pi.js', '// discovery fixture, never executed\n');
  put('.claude/agents/backend-engineer.md', 'Synthetic known role\n');
  put('.agents/skills/coding-standards/SKILL.md', 'Synthetic known skill\n');
  const records = []; let now = Date.now();
  const flow = createFlow({ harness: 'claude', cwd, stateDir: path.join(root, 'state'), env: {},
    clock: () => ++now, queueObservation: record => { records.push(record); return { queued: true }; },
    flushOutbox: async () => ({ accepted: 0, verified: false }) });
  const sessionId = crypto.randomUUID();
  const hook = (event, extra = {}) => handleClaudeHook({ cwd, session_id: sessionId, hook_event_name: event, ...extra }, { flow, clock: () => ++now });
  return { cwd, flow, records, sessionId, hook };
}

test('unfinished actor identities are allocated locally without racing terminal span metadata', async t => {
  const { flow, sessionId, hook, records } = fixture(t);
  await hook('SessionStart');
  assert.ok(flow.session(sessionId)?.rootSpanId);
  assert.equal(records.filter(record => record.type === 'AGENT').length, 0);
  await hook('Stop');
  assert.equal(records.filter(record => record.type === 'AGENT').length, 1);
  assert.equal(records.at(-1).outcome, 'completed');
});

test('Claude adapter uses real context/privacy/flow for exact native child lineage and semantic attribution', async t => {
  const { flow, records, sessionId, hook } = fixture(t);
  await hook('SessionStart', { model: 'claude-opus-4-6' });
  await hook('UserPromptSubmit', { prompt: '/brain backend-engineer --ticket TEST-17' });
  await hook('PreToolUse', { tool_use_id: 'dispatch', tool_name: 'Agent' });
  await hook('SubagentStart', { agent_id: 'exact-child', agent_type: 'backend-engineer' });
  await hook('SubagentStop', { agent_id: 'exact-child' });
  await hook('PostToolUse', { tool_use_id: 'dispatch', tool_name: 'Agent', tool_response: { agentId: 'exact-child' } });
  const root = flow.session(sessionId);
  const children = records.filter(record => record.type === 'AGENT' && record.id !== root.rootSpanId);
  assert.ok(children.length > 0, 'positive child observation must exist, not merely be absent of canaries');
  assert.ok(children.every(record => record.traceId === root.traceId && record.parentId === root.rootSpanId));
  assert.ok(children.every(record => record.sessionId === root.sessionId));
  assert.ok(records.every(record => record.context.projectId === root.projectId), 'canonical project ID must survive privacy normalization');
  assert.ok(records.some(record => record.context.persona === 'backend-engineer' && record.context.ticketId === 'TEST-17'));
});

test('real flow distinguishes skill expansion from brain command, and detects an interrupted unidentified second prompt', async t => {
  const { records, hook } = fixture(t);
  await hook('UserPromptExpansion', { expansion_type: 'slash_command', command_name: 'brain', command_args: 'backend-engineer TEST-17' });
  await hook('UserPromptExpansion', { expansion_type: 'slash_command', command_name: 'coding-standards' });
  await hook('PreToolUse', { tool_name: 'Skill', tool_use_id: 'skill-failed', tool_input: { skill: 'never-used' } });
  await hook('PostToolUseFailure', { tool_name: 'Skill', tool_use_id: 'skill-failed', tool_input: { skill: 'never-used' } });
  await hook('Stop');
  await hook('UserPromptSubmit', { prompt: 'CANARY_PRIVATE_BODY' });
  await hook('SessionEnd');
  const latest = records.at(-1);
  assert.equal(latest.outcome, 'interrupted');
  assert.ok(latest.context.skillsInvoked.includes('coding-standards'));
  assert.ok(!latest.context.skillsInvoked.includes('brain'));
  assert.ok(!latest.context.skillsInvoked.includes('never-used'));
  assert.ok(!JSON.stringify(records).includes('CANARY_PRIVATE_BODY'));
});

test('real checkpoints accept canonical numeric usage without admitting content or counting TTL buckets twice', async t => {
  const { cwd, hook, records } = fixture(t);
  const file = path.join(cwd, 'synthetic-transcript.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', timestamp: Date.now(), message: {
    id: 'exact-native-message', model: 'claude-opus-5-5', usage: { input_tokens: 2, output_tokens: 3,
      cache_read_input_tokens: 7, cache_creation_input_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 5 } },
    content: [{ type: 'text', text: 'CANARY_PRIVATE_COMPLETION' }]
  } }) + '\n');
  await hook('Stop', { transcript_path: file });
  const generations = records.filter(record => record.type === 'GENERATION');
  assert.equal(generations.length, 1);
  assert.deepEqual(generations[0].usage, { input: 2, output: 3, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 });
  assert.ok(!JSON.stringify(records).includes('CANARY_PRIVATE_COMPLETION'));
});

test('an unresolved native child can set its own context without bypassing lineage deferral', t => {
  const { cwd, flow, records } = fixture(t);
  const nativeSessionId = crypto.randomUUID();
  const child = flow.begin({ cwd, nativeSessionId, pendingIdentity: 'claude:exact-unbound-child' });
  const binding = flow.createToolLaunch(child);
  assert.equal(flow.store.resolveLaunch({ nonce: binding.nonce }), null, 'export still cannot resolve this child');
  const result = runContext(['set', '--persona', 'backend-engineer', '--ticket', 'TEST-18'], {
    cwd, flow, env: { BRAIN_TRACE_LAUNCH_ID: binding.nonce }
  });
  assert.equal(result.persona, 'backend-engineer');
  assert.equal(result.ticketId, 'TEST-18');
  assert.equal(result.ancestryPending, true);
  assert.equal(result.sessionId, 'UNKNOWN');
  assert.equal(flow.resolve(child), null);
  assert.equal(records.length, 0, 'metadata editing must not export a guessed root');
});

test('real disk outbox and pinned SDK drain deferred batches beyond count/byte capacities across restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-backlog-sdk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), stateDir = path.join(root, 'state'); fs.mkdirSync(cwd);
  const make = () => createFlow({ cwd, stateDir, env: {} });
  let flow = make();
  const parent = flow.begin({ cwd, nativeSessionId: crypto.randomUUID(), ticketId: 'TEST-17' });
  const child = flow.begin({ cwd, nativeSessionId: crypto.randomUUID(), pendingIdentity: 'large-exact-child' });
  const skills = Array.from({ length: 32 }, (_, i) => `skill-${String(i).padStart(3, '0')}-${'z'.repeat(118)}`);
  const run = flow.update(child, { skillsInvoked: skills, skillsLoaded: skills });
  const records = Array.from({ length: 600 }, () => ({ id: flow.id(), traceId: run.traceId,
    parentId: run.rootSpanId, sessionId: run.sessionId, nativeSessionId: run.nativeSessionId,
    type: 'GENERATION', startTime: Date.now(), endTime: Date.now(), model: 'synthetic-model',
    usage: { input: 2, output: 3 }, outcome: 'completed' }));
  assert.deepEqual(flow.submit(run, records), { queued: 0, pending: records.length });
  const pendingDir = path.join(stateDir, 'adapters', 'pending');
  const pendingCount = () => fs.readdirSync(pendingDir).reduce((sum, name) =>
    sum + JSON.parse(fs.readFileSync(path.join(pendingDir, name), 'utf8')).records.length, 0);
  const bytes = fs.readdirSync(pendingDir).reduce((sum, name) => sum + fs.statSync(path.join(pendingDir, name)).size, 0);
  assert.ok(bytes > OUTBOX_LIMITS.bytes, 'sanitized deferred metadata exceeds real byte capacity');
  assert.ok(records.length > OUTBOX_LIMITS.records);
  assert.ok(fs.readdirSync(pendingDir).length > 1, 'oversized suffix must fit bounded individual checkpoints');
  flow.store.createLaunch(parent, { launchId: 'large-exact-child', multiUse: true });
  const spans = []; let acknowledge = false;
  const opts = { dependencyRoot: dependencyCacheDir(), timeoutMs: 30000, exporterFactory: () => ({
    export(batch, callback) { if (acknowledge) spans.push(...batch); callback({ code: acknowledge ? 0 : 1 }); },
    async shutdown() {}, async forceFlush() {}
  }) };
  const first = await flow.flush(opts);
  assert.equal(first.accepted, 0);
  assert.ok(first.queued > 0);
  const retained = pendingCount();
  assert.ok(retained > 0 && retained < records.length, 'only the unqueued tail remains durable');
  flow = make();
  await flow.flush(opts);
  assert.equal(pendingCount(), retained, 'restart while full must not restore the transferred prefix');
  acknowledge = true;
  for (let pass = 0; pass < 10; pass++) {
    flow = make();
    const result = await flow.flush(opts);
    if (!result.deferred && !result.queued) break;
  }
  const ids = spans.map(span => span.spanContext().spanId);
  assert.equal(new Set(ids).size, records.length);
  assert.equal(ids.length, records.length, 'normal capacity retries must not continually replay the same prefix');
  assert.equal(pendingCount(), 0);
  assert.equal(fs.readdirSync(path.join(stateDir, 'outbox')).length, 0);
  assert.ok(spans.every(span => span.spanContext().traceId === parent.traceId));
  assert.ok(spans.every(span => JSON.parse(span.attributes['langfuse.observation.metadata.ticketId']) === 'TEST-17'
    && JSON.parse(span.attributes['langfuse.observation.metadata.ticketSource']) === 'explicit'));
});

test('late historical rebase exports captured semantics through the real outbox and SDK without selecting the old turn', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-historical-sdk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), stateDir = path.join(root, 'state'); fs.mkdirSync(cwd);
  const flow = createFlow({ cwd, stateDir, env: {} });
  const parent = flow.begin({ cwd, nativeSessionId: crypto.randomUUID(), ticketId: 'TEST-17' });
  const nativeSessionId = crypto.randomUUID();
  const first = flow.begin({ cwd, nativeSessionId, pendingIdentity: 'historical-sdk-child',
    requestedModel: 'synthetic/early-model', requestedEffort: 'low' });
  const id = flow.id(), now = Date.now();
  flow.submit(first, [{ id, type: 'GENERATION', parentId: first.rootSpanId,
    startTime: now, endTime: now, model: 'synthetic/early-model', outcome: 'completed' }]);
  flow.update(first, { requestedEffort: 'high', requestedModel: 'synthetic/later-model',
    observedEffort: 'high', skillsLoaded: ['later-skill'] });
  const second = flow.begin({ cwd, nativeSessionId });
  flow.store.createLaunch(parent, { launchId: 'historical-sdk-child', child: { persona: 'backend-engineer' } });
  const spans = [];
  const result = await flow.flush({ dependencyRoot: dependencyCacheDir(), timeoutMs: 10000, exporterFactory: () => ({
    export(batch, callback) { spans.push(...batch); callback({ code: 0 }); },
    async shutdown() {}, async forceFlush() {}
  }) });
  assert.equal(result.accepted, 1);
  assert.equal(result.deferred, 0);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].spanContext().spanId, id);
  assert.equal(spans[0].spanContext().traceId, parent.traceId);
  const attributes = spans[0].attributes;
  const metadata = key => attributes[`langfuse.observation.metadata.${key}`];
  assert.equal(JSON.parse(metadata('ticketId')), 'TEST-17');
  assert.equal(JSON.parse(metadata('ticketSource')), 'explicit');
  assert.equal(JSON.parse(metadata('persona')), 'backend-engineer');
  assert.equal(JSON.parse(metadata('requestedModel')), 'synthetic/early-model');
  assert.equal(JSON.parse(metadata('requestedEffort')), 'low');
  assert.equal(metadata('observedEffort'), undefined, 'later observations cannot become earlier evidence');
  assert.equal(metadata('skillsLoaded'), undefined);
  assert.equal(flow.store.getSession('pi', nativeSessionId).runId, second.runId);
});

test('many completed Claude runs/tools/generations expire on disk while an active session retains replay state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-checkpoint-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), stateDir = path.join(root, 'state'); fs.mkdirSync(cwd);
  let now = Date.now();
  const make = () => createFlow({ cwd, stateDir, harness: 'claude', env: {}, clock: () => now,
    // Keep the real flow/store/outbox; transport is explicitly offline.
    flushOutbox: async () => ({ queued: 0, accepted: 0, verified: false }) });
  let flow = make(); const expiredFiles = [];
  for (let i = 0; i < 24; i++) {
    const session = crypto.randomUUID(), file = path.join(cwd, 'synthetic.jsonl');
    const hook = (event, extra = {}) => handleClaudeHook({ cwd, session_id: session, hook_event_name: event, ...extra }, { flow, clock: () => now });
    await hook('SessionStart');
    for (let n = 0; n < 3; n++) {
      await hook('PreToolUse', { tool_name: 'Bash', tool_use_id: `tool-${n}`, tool_input: { command: 'true' } });
      await hook('PostToolUse', { tool_name: 'Bash', tool_use_id: `tool-${n}` });
    }
    fs.writeFileSync(file, JSON.stringify({ type: 'assistant', timestamp: now, message: {
      id: `native-message-${i}`, model: 'claude-opus-4-6', usage: { input_tokens: 2, output_tokens: 3 }
    } }) + '\n');
    await hook('Stop', { transcript_path: file });
    expiredFiles.push(flow.stateFile(`run:${flow.session(session).rootSpanId}`));
    // Offline acknowledgement of synthetic observations. No network or credentials.
    for (const name of fs.readdirSync(path.join(stateDir, 'outbox'))) fs.unlinkSync(path.join(stateDir, 'outbox', name));
  }
  const adapterDir = path.join(stateDir, 'adapters');
  const usage = () => {
    const files = fs.readdirSync(adapterDir).filter(name => name.endsWith('.json'));
    return { files: files.length, bytes: files.reduce((sum, name) => sum + fs.statSync(path.join(adapterDir, name)).size, 0) };
  };
  const before = usage();
  assert.ok(before.files > 200, 'actual native generation/tool/capability checkpoints were created');
  const activeSession = crypto.randomUUID();
  const activeHook = event => handleClaudeHook({ cwd, session_id: activeSession, hook_event_name: event }, { flow, clock: () => now });
  await activeHook('SessionStart');
  const activeRun = flow.session(activeSession);
  flow.writeState('active-replay-cursor', { offset: 42 });
  now += ADAPTER_LIMITS.retentionMs - 1000;
  flow.update(activeRun, { observedModel: 'claude-opus-4-6' });
  now += 2000; flow = make(); await flow.flush();
  const after = usage();
  assert.ok(expiredFiles.every(file => !fs.existsSync(file)));
  assert.ok(after.files < 20 && after.files < before.files);
  assert.ok(after.bytes < before.bytes && after.bytes <= ADAPTER_LIMITS.bytes);
  assert.ok(after.files <= ADAPTER_LIMITS.files);
  assert.ok(flow.readState('active-replay-cursor'));
  assert.ok(flow.session(activeSession));
});
