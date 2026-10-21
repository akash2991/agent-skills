'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createFlow } = require('../runtime/langfuse/flow.cjs');
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
