'use strict';

// Entirely local synthetic fixtures: no models, credentials, global config or
// Langfuse transport. The stub models the shared flow's pending/rebase contract.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { HOOK_EVENTS, handleClaudeHook } = require('../runtime/langfuse/claude.cjs');
const { MAX_INPUT_BYTES, readPayload } = require('../runtime/langfuse/claude-hook.cjs');

class TestFlow {
  constructor() {
    this.states = new Map();
    this.sessions = new Map();
    this.runs = new Map();
    this.launches = new Map();
    this.queue = new Map();
    this.records = new Map();
    this.now = 1800000000000;
    this.flushes = 0;
    this.store = {
      createLaunch: (parent, opts = {}) => {
        const nonce = opts.launchId ? this.id(opts.launchId) : this.id(`nonce:${this.launches.size}`);
        const binding = { nonce, parent, child: opts.child, multiUse: opts.multiUse };
        this.launches.set(nonce, binding);
        if (opts.launchId) this.launches.set(opts.launchId, binding);
        return binding;
      },
      resolveLaunch: ({ nonce, launchId }) => this.launches.get(nonce || launchId) || null
    };
  }
  createToolLaunch(run) { return this.store.createLaunch(run, { multiUse: true }); }
  id(seed) { return crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 16); }
  readState(key) { return structuredClone(this.states.get(key)); }
  writeState(key, data) { this.states.set(key, structuredClone(data)); }
  begin(opts) {
    const rootSpanId = this.id(`agent:${opts.nativeSessionId}`);
    const parent = opts.parent;
    const run = { rootSpanId, traceId: parent?.traceId || rootSpanId + rootSpanId,
      parentSpanId: parent?.rootSpanId || null,
      sessionId: parent?.sessionId || this.id(`session:${opts.nativeSessionId}`),
      nativeSessionId: opts.nativeSessionId, runId: rootSpanId, projectId: 'test-project',
      startedAt: this.now++, ...(opts.pendingIdentity ? { pendingIdentity: opts.pendingIdentity } : {}) };
    this.sessions.set(opts.nativeSessionId, run);
    this.runs.set(rootSpanId, run);
    return run;
  }
  session(id) { return this.sessions.get(id) || null; }
  remember(run, opts = {}) { return this.update(run, opts); }
  update(run, patch) {
    const updated = { ...this.runs.get(run.rootSpanId), ...patch };
    this.runs.set(run.rootSpanId, updated);
    this.sessions.set(run.nativeSessionId, updated);
    return updated;
  }
  resolve(run, visited = new Set()) {
    run = this.runs.get(run.rootSpanId) || run;
    if (!run.pendingIdentity) return run;
    if (visited.has(run.rootSpanId)) return null;
    visited.add(run.rootSpanId);
    const binding = this.launches.get(run.pendingIdentity);
    if (!binding) return null;
    const parent = this.resolve(binding.parent, visited);
    if (!parent) return null;
    return this.update(run, { traceId: parent.traceId, parentSpanId: parent.rootSpanId,
      sessionId: parent.sessionId, persona: run.persona || parent.persona,
      ticketId: run.ticketId || parent.ticketId });
  }
  submit(run, records) {
    for (const record of records) this.queue.set(record.id, { run, record });
  }
  async flush() {
    this.flushes++;
    for (const [id, entry] of this.queue) {
      const run = this.resolve(entry.run);
      if (!run) continue;
      const record = { ...entry.record, traceId: run.traceId, sessionId: run.sessionId,
        parentId: entry.record.type === 'AGENT' ? run.parentSpanId : run.rootSpanId,
        context: Object.fromEntries(['persona', 'ticketId', 'requestedEffort', 'requestedModel', 'invokedSkills', 'loadedSkills']
          .filter(k => run[k] !== undefined).map(k => [k, run[k]])) };
      this.records.set(id, record);
    }
  }
  captureBrainCommand(run, input) {
    const text = input.commandName === 'brain' ? `/brain ${input.commandArgs}` : input.text;
    const match = typeof text === 'string' && text.match(/^\/brain (backend-engineer|test-engineer) (ABC-\d+)\b/);
    return match ? this.update(run, { persona: match[1], ticketId: match[2] }) : run;
  }
  knownPersona(_cwd, name) { return ['backend-engineer', 'test-engineer'].includes(name); }
  knownSkill(_cwd, name) { return ['coding-standards', 'test-driven-development'].includes(name); }
  captureSkill(run, { toolName, input, success, invoked }) {
    if (!success) return run;
    const skill = toolName === 'Skill' ? input?.skill :
      input?.file_path?.match(/\/skills\/([^/]+)\/SKILL\.md$/)?.[1];
    if (!['coding-standards', 'test-driven-development'].includes(skill)) return run;
    const current = this.runs.get(run.rootSpanId);
    const patch = {};
    if (invoked) patch.invokedSkills = [...new Set([...(current.invokedSkills || []), skill])];
    if (success) patch.loadedSkills = [...new Set([...(current.loadedSkills || []), skill])];
    return this.update(run, patch);
  }
}
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-claude-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function driver(flow = new TestFlow()) {
  let now = 1800000010000;
  return { flow, hook: (event, data = {}) => handleClaudeHook({
    session_id: 'session-test', cwd: '/synthetic/project', hook_event_name: event, ...data
  }, { flow, clock: () => now++, flushTimeoutMs: 25 }) };
}
function childRun(flow, id) {
  const hex = crypto.createHash('sha256').update(`claude:session-test:${id}`).digest('hex');
  return flow.session(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`);
}
function rows(flow, type) { return [...flow.records.values()].filter(r => r.type === type); }
function transcript(file, messages) {
  fs.writeFileSync(file, messages.map(row => JSON.stringify(row)).join('\n') + '\n');
}
function assistant(id, time, extra = {}) {
  return { type: 'assistant', timestamp: time,
    message: { id, model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 10, output_tokens: 1 },
      content: [{ type: 'text', text: 'SYNTHETIC_PRIVATE_RESPONSE' }], ...extra } };
}

test('native parallel children, grandchild, and foreign Bash descendants bind only by observed IDs', async t => {
  const dir = sandbox(t);
  const { flow, hook } = driver();
  await hook('SessionStart', { model: 'claude-opus-4-6' });
  await hook('UserPromptSubmit', { prompt: '/brain backend-engineer ABC-12' });
  const root = flow.session('session-test');
  await hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'dispatch-a' });
  await hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'dispatch-b' });
  await hook('SubagentStart', { agent_id: 'child-b', agent_type: 'general-purpose' });
  await hook('SubagentStart', { agent_id: 'child-a', agent_type: 'general-purpose' });
  assert.equal(rows(flow, 'AGENT').length, 1, 'SubagentStart does not pick an active/newest parent');

  const bash = { agent_id: 'child-b', tool_name: 'Bash', tool_use_id: 'bash-child',
    tool_input: { command: 'node synthetic-child.cjs', description: 'private description' } };
  const update = await hook('PreToolUse', bash);
  assert.equal(update.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(update.hookSpecificOutput.permissionDecision, undefined);
  const prefix = update.hookSpecificOutput.updatedInput.command;
  const nonce = prefix.match(/^export BRAIN_TRACE_LAUNCH_ID='([a-f0-9]+)'\n/)[1];
  assert.ok(prefix.endsWith(bash.tool_input.command));
  assert.equal((await hook('PreToolUse', bash)).hookSpecificOutput.updatedInput.command, prefix);
  assert.equal((await hook('PreToolUse', { ...bash, tool_input: { command: prefix } }))
    .hookSpecificOutput.updatedInput.command, prefix, 'replay does not stack exports');
  const binding = flow.store.resolveLaunch({ nonce });
  assert.equal(binding.parent.rootSpanId, childRun(flow, 'child-b').rootSpanId);
  assert.equal(binding.multiUse, true);
  const foreign = flow.begin({ nativeSessionId: 'foreign-pi', pendingIdentity: nonce });
  flow.submit(foreign, [{ id: foreign.rootSpanId, type: 'AGENT', startTime: flow.now, endTime: flow.now }]);
  assert.equal(flow.resolve(foreign), null, 'foreign descendant waits for the native ancestor too');

  await hook('PreToolUse', { agent_id: 'child-b', tool_name: 'Agent', tool_use_id: 'dispatch-grand' });
  await hook('SubagentStart', { agent_id: 'grandchild' });
  const grandFile = path.join(dir, 'grand.jsonl');
  transcript(grandFile, [assistant('msg-grand', 1800000020000)]);
  await hook('SubagentStop', { agent_id: 'grandchild', agent_transcript_path: grandFile });
  await hook('PostToolUse', { agent_id: 'child-b', tool_name: 'Agent', tool_use_id: 'dispatch-grand',
    tool_response: { agentId: 'grandchild' } });
  assert.equal(rows(flow, 'GENERATION').length, 0, 'completed child is held while exact parent remains pending');
  await hook('SubagentStop', { agent_id: 'child-b' });
  await hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'dispatch-a',
    tool_response: { agentId: 'child-a', status: 'async_launched' } });
  await hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'dispatch-b',
    tool_input: { model: 'sonnet', prompt: '/brain test-engineer ABC-13' },
    tool_response: { agentId: 'child-b', status: 'completed', totalTokens: 999999, usage: { output_tokens: 999999 } } });
  const a = flow.records.get(childRun(flow, 'child-a').rootSpanId);
  const b = flow.records.get(childRun(flow, 'child-b').rootSpanId);
  const grand = flow.records.get(childRun(flow, 'grandchild').rootSpanId);
  assert.equal(a.parentId, root.rootSpanId);
  assert.equal(b.parentId, root.rootSpanId);
  assert.equal(grand.parentId, b.id);
  assert.equal(flow.records.get(foreign.rootSpanId).parentId, b.id);
  assert.equal(rows(flow, 'GENERATION')[0].parentId, grand.id);
  for (const r of flow.records.values()) {
    assert.equal(r.sessionId, root.sessionId);
    assert.equal(r.traceId, root.traceId);
    assert.match(r.id, /^[a-f0-9]{16}$/);
  }
  assert.equal(b.context.persona, 'test-engineer');
  assert.equal(b.context.ticketId, 'ABC-13');
  assert.equal(b.context.requestedModel, 'sonnet');
  assert.equal(b.outcome, 'completed');
  assert.equal(rows(flow, 'TOOL').length, 0, 'successful Agent dispatches are never duplicate TOOL records');
  assert.equal(flow.session('session-test').rootSpanId, root.rootSpanId, 'child hooks do not replace root current run');
});

test('transcript identity dedup, latest usage, exact timing, incomplete tails and lag', async t => {
  const file = path.join(sandbox(t), 'root.jsonl');
  const { flow, hook } = driver();
  const first = assistant('msg-real', 1800000020000);
  const later = assistant('msg-real', 1800000020500, { usage: { input_tokens: 12, output_tokens: 7,
    cache_read_input_tokens: 3, cache_creation_input_tokens: 4,
    cache_creation: { ephemeral_5m_input_tokens: 4 }, private_key: 'SYNTHETIC_PRIVATE_USAGE' } });
  const second = assistant('msg-next', 1800000021000, { model: 'claude-haiku-4-5' });
  transcript(file, [first, later, { type: 'assistant', timestamp: 1800000020600,
    message: { id: 'dispatch-synthetic', content: [{ type: 'tool_use', name: 'Agent', input: { prompt: 'PRIVATE' } }] } },
  assistant('synthetic-model', 1800000020700, { model: '<synthetic>' })]);
  const partial = JSON.stringify(second);
  fs.appendFileSync(file, partial.slice(0, 90));
  await hook('Stop', { transcript_path: file });
  let generations = rows(flow, 'GENERATION');
  assert.equal(generations.length, 1);
  assert.equal(generations[0].startTime, first.timestamp);
  assert.equal(generations[0].endTime, later.timestamp);
  assert.deepEqual(generations[0].usage, { input: 12, output: 7,
    cache_read_input_tokens: 3, cache_creation_input_tokens: 4 });
  await hook('Stop', { transcript_path: file });
  assert.equal(rows(flow, 'GENERATION').length, 1);
  fs.appendFileSync(file, partial.slice(90) + '\n');
  await hook('SessionEnd', { transcript_path: file, reason: 'prompt_input_exit' });
  generations = rows(flow, 'GENERATION');
  assert.equal(generations.length, 2);
  assert.equal(generations.find(g => g.model === 'claude-haiku-4-5').startTime, second.timestamp);
  // Rotation and replay retain identity and do not add token/cost aggregates.
  transcript(file, [later]);
  await hook('Stop', { transcript_path: file });
  assert.equal(rows(flow, 'GENERATION').length, 2);
  assert.equal(rows(flow, 'GENERATION').find(g => g.id === generations[0].id).usage.output, 7);
  const saved = JSON.stringify([...flow.states]);
  assert.ok(!saved.includes('SYNTHETIC_PRIVATE'));
  assert.ok(!saved.includes('content'));
});

test('child Stop uses its explicit transcript, and root excludes sidechains', async t => {
  const dir = sandbox(t);
  const rootFile = path.join(dir, 'root.jsonl');
  const childFile = path.join(dir, 'child.jsonl');
  transcript(rootFile, [assistant('root-msg', 1800000030000),
    { ...assistant('side-msg', 1800000030100), agentId: 'unbound-child', isSidechain: true }]);
  transcript(childFile, [assistant('child-msg', 1800000030200)]);
  const { flow, hook } = driver();
  await hook('SessionStart', { transcript_path: rootFile });
  await hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'agent-dispatch' });
  await hook('SubagentStart', { agent_id: 'unbound-child', transcript_path: rootFile });
  await hook('SubagentStop', { agent_id: 'unbound-child', transcript_path: rootFile, agent_transcript_path: childFile });
  await hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'agent-dispatch', tool_response: { agentId: 'unbound-child' } });
  assert.equal(rows(flow, 'GENERATION').length, 2);
  assert.equal(rows(flow, 'GENERATION').filter(g => g.parentId === childRun(flow, 'unbound-child').rootSpanId).length, 1);
});

test('actual model, effort, brain command, invoked versus loaded skills, and tools are metadata-only', async () => {
  const { flow, hook } = driver();
  await hook('SessionStart', { model: 'claude-opus-4-6', agent_type: 'private-unrecognized-agent' });
  await hook('UserPromptExpansion', { expansion_type: 'slash_command', command_name: 'brain',
    command_args: 'backend-engineer ABC-91 private trailing instructions', prompt: 'private expanded text',
    declared_skills: ['never-used'] });
  await hook('PreToolUse', { tool_name: 'Skill', tool_use_id: 'skill-1', tool_input: { skill: 'coding-standards' }, effort: { level: 'xhigh' } });
  assert.equal(flow.session('session-test').invokedSkills, undefined, 'a planned invocation is not successful execution');
  assert.equal(flow.session('session-test').loadedSkills, undefined);
  await hook('PostToolUse', { tool_name: 'Skill', tool_use_id: 'skill-1', tool_input: { skill: 'coding-standards' },
    tool_response: { text: 'private loaded skill' } });
  await hook('UserPromptExpansion', { expansion_type: 'slash_command', command_name: 'test-driven-development' });
  await hook('PostToolUse', { tool_name: 'Read', tool_use_id: 'read-1',
    tool_input: { file_path: '/synthetic/project/skills/coding-standards/SKILL.md' } });
  await hook('PostModelSwitch', { to_model: 'claude-sonnet-4-6', from_model: 'claude-opus-4-6' });
  await hook('Stop', { effort: { level: 'high' }, last_assistant_message: 'private answer' });
  const agent = rows(flow, 'AGENT')[0];
  assert.equal(agent.model, 'claude-sonnet-4-6');
  assert.equal(agent.context.requestedEffort, 'high');
  assert.equal(agent.context.persona, 'backend-engineer');
  assert.equal(agent.context.ticketId, 'ABC-91');
  assert.deepEqual(agent.context.invokedSkills, ['coding-standards', 'test-driven-development']);
  assert.deepEqual(agent.context.loadedSkills, ['coding-standards', 'test-driven-development']);
  assert.equal(rows(flow, 'TOOL').length, 2);
  assert.ok(rows(flow, 'TOOL').every(r => r.parentId === agent.id));
  assert.ok(!JSON.stringify([...flow.states, ...flow.records]).includes('private'));
});

test('known native brain persona is evidence, but arbitrary persona/model labels stay private', async t => {
  const { flow, hook } = driver();
  await hook('SessionStart', { agent_type: 'backend-engineer' });
  assert.equal(rows(flow, 'AGENT')[0].context.persona, 'backend-engineer');
  const file = path.join(sandbox(t), 'unknown-model.jsonl');
  transcript(file, [assistant('custom-model-msg', 1800000040000, { model: 'PRIVATE_GATEWAY_MODEL_LABEL' })]);
  await hook('Stop', { transcript_path: file });
  assert.equal(rows(flow, 'GENERATION').length, 1, 'unknown labels do not discard actual message usage');
  assert.equal(rows(flow, 'GENERATION')[0].model, undefined);
  assert.equal(rows(flow, 'GENERATION')[0].usage.input, 10);
  assert.ok(!JSON.stringify([...flow.states, ...flow.records]).includes('PRIVATE_GATEWAY_MODEL_LABEL'));
});

test('errors, aborts, session interruption, replay, and bounded flush have distinct outcomes', async () => {
  const { flow, hook } = driver();
  await hook('SessionStart');
  await hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'error-tool', tool_input: { command: 'private command' } });
  await hook('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'error-tool', error: 'private exception' });
  await hook('PostToolUseFailure', { tool_name: 'Read', tool_use_id: 'abort-tool', is_interrupt: true, duration_ms: 12,
    error: 'private error' });
  await hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'failed-agent' });
  await hook('PostToolUseFailure', { tool_name: 'Agent', tool_use_id: 'failed-agent', error: 'private agent error' });
  assert.deepEqual(rows(flow, 'TOOL').map(r => r.outcome), ['error', 'aborted', 'error']);
  await hook('StopFailure', { error: 'authentication_failed', error_details: 'private provider credentials' });
  const errorAgent = structuredClone(rows(flow, 'AGENT')[0]);
  await hook('SessionEnd', { reason: 'other' });
  assert.equal(rows(flow, 'AGENT')[0].outcome, 'error');
  assert.equal(rows(flow, 'AGENT')[0].endTime, errorAgent.endTime);
  const prior = structuredClone(rows(flow, 'TOOL'));
  await hook('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'error-tool' });
  assert.deepEqual(rows(flow, 'TOOL'), prior, 'repeat hook keeps stable ID/timestamps');
  await hook('UserPromptSubmit', { prompt_id: 'prompt-second', prompt: 'private question' });
  await hook('SessionEnd', { reason: 'clear' });
  assert.equal(rows(flow, 'AGENT')[0].outcome, 'interrupted');
  await hook('Stop', { is_interrupt: true });
  assert.equal(rows(flow, 'AGENT')[0].outcome, 'aborted');
  flow.flush = () => new Promise(() => {});
  const started = Date.now();
  await hook('SessionEnd');
  assert.ok(Date.now() - started < 300, 'hung transport cannot hold a hook indefinitely');
});

test('missing or malformed exact identities never infer parentage', async () => {
  const { flow, hook } = driver();
  await hook('SessionStart');
  await hook('SubagentStart', { agent_id: 'orphan', tool_use_id: 'not-a-parent-id' });
  await hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'known-dispatch' });
  await hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'unknown-dispatch', tool_response: { agentId: 'orphan' } });
  await hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'unknown-dispatch', tool_response: { agentId: 'orphan' } });
  await hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'known-dispatch', tool_response: { text: 'agentId: orphan' } });
  assert.equal(flow.resolve(childRun(flow, 'orphan')), null);
  assert.equal(rows(flow, 'AGENT').length, 1);
  assert.equal(rows(flow, 'TOOL').length, 0);
  const count = flow.states.size;
  await hook('PreToolUse', { agent_id: 'bad identity@example.com', tool_name: 'Bash', tool_use_id: 'tool-unknown' });
  await hook('SubagentStop', {});
  await hook('Stop', { session_id: '' });
  assert.equal(flow.states.size, count);
});

test('PostToolUse binds to the remembered PreToolUse caller, not a new current session run', async () => {
  const { flow, hook } = driver();
  await hook('SessionStart');
  const caller = flow.session('session-test');
  await hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'old-dispatch' });
  const replacement = { ...caller, rootSpanId: 'aaaaaaaaaaaaaaaa', runId: 'new-run',
    traceId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', sessionId: 'new-session' };
  flow.runs.set(replacement.rootSpanId, replacement);
  flow.sessions.set('session-test', replacement);
  await hook('SubagentStart', { agent_id: 'late-child' });
  await hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'old-dispatch', tool_response: { agentId: 'late-child' } });
  const child = flow.resolve(childRun(flow, 'late-child'));
  assert.equal(child.parentSpanId, caller.rootSpanId);
  assert.equal(child.traceId, caller.traceId);
});

test('parallel same tool IDs remain agent-local, including completed-before-start binding', async () => {
  const { flow, hook } = driver();
  await hook('SessionStart');
  await hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'dispatch-1' });
  await hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'dispatch-2' });
  await Promise.all(['child-1', 'child-2'].map(agent_id => hook('SubagentStart', { agent_id })));
  await Promise.all(['child-1', 'child-2'].map(agent_id => hook('PreToolUse', {
    agent_id, tool_name: 'Read', tool_use_id: 'same-native-tool-id' })));
  await Promise.all(['child-1', 'child-2'].map(agent_id => hook('PostToolUse', {
    agent_id, tool_name: 'Read', tool_use_id: 'same-native-tool-id' })));
  await Promise.all(['child-1', 'child-2'].map(agent_id => hook('SubagentStop', { agent_id })));
  assert.equal(rows(flow, 'TOOL').length, 0);
  await Promise.all(['1', '2'].map(n => hook('PostToolUse', { tool_name: 'Agent', tool_use_id: `dispatch-${n}`,
    tool_response: { agentId: `child-${n}` } })));
  const tools = rows(flow, 'TOOL');
  assert.equal(tools.length, 2);
  assert.notEqual(tools[0].id, tools[1].id);
  assert.notEqual(tools[0].parentId, tools[1].parentId);
});

test('transcript reconciliation captures cancellation without failure hook and bounded write lag', async t => {
  const file = path.join(sandbox(t), 'cancel.jsonl');
  const { flow, hook } = driver();
  transcript(file, [assistant('msg-tools', 1800000050000, { content: [
    { type: 'tool_use', id: 'cancelled-tool', name: 'Bash', input: { command: 'SYNTHETIC_PRIVATE_COMMAND' } },
    { type: 'tool_use', id: 'error-tool', name: 'Read', input: { file_path: 'SYNTHETIC_PRIVATE_PATH' } }
  ] }), { type: 'user', timestamp: 1800000050100, message: { content: [
    { type: 'tool_result', tool_use_id: 'cancelled-tool', is_error: true, content: '[Request interrupted by user for tool use]' },
    { type: 'tool_result', tool_use_id: 'error-tool', is_error: true, content: 'SYNTHETIC_PRIVATE_ERROR' }
  ] } }]);
  const last = JSON.stringify(assistant('lagged-msg', 1800000050200));
  fs.appendFileSync(file, last.slice(0, 50));
  const timer = setTimeout(() => fs.appendFileSync(file, last.slice(50) + '\n'), 5);
  t.after(() => clearTimeout(timer));
  await hook('Stop', { transcript_path: file });
  assert.deepEqual(rows(flow, 'TOOL').map(r => r.outcome), ['aborted', 'error']);
  assert.equal(rows(flow, 'GENERATION').length, 2, 'final-hook retry sees the lagging row');
  const saved = JSON.stringify([...flow.states, ...flow.records]);
  assert.ok(!saved.includes('SYNTHETIC_PRIVATE'));
});

test('replayed prompt identity does not turn completed SessionEnd into an interruption', async () => {
  const { flow, hook } = driver();
  const prompt = { prompt_id: 'stable-prompt', prompt: 'private question' };
  await hook('UserPromptSubmit', prompt);
  await hook('Stop');
  const completed = structuredClone(rows(flow, 'AGENT')[0]);
  await hook('UserPromptSubmit', prompt);
  await hook('SessionEnd');
  assert.equal(rows(flow, 'AGENT')[0].outcome, 'completed');
  assert.equal(rows(flow, 'AGENT')[0].endTime, completed.endTime);
});

test('replayed older prompt and Stop cannot overwrite newer activity or brain metadata', async () => {
  const { flow, hook } = driver();
  const old = { prompt_id: 'old-prompt', prompt: '/brain backend-engineer ABC-1' };
  await hook('UserPromptSubmit', old);
  await hook('Stop', { prompt_id: 'old-prompt' });
  await hook('UserPromptSubmit', { prompt_id: 'new-prompt', prompt: '/brain test-engineer ABC-2' });
  await hook('UserPromptSubmit', old);
  await hook('Stop', { prompt_id: 'old-prompt' });
  await hook('SessionEnd', { prompt_id: 'new-prompt' });
  assert.equal(rows(flow, 'AGENT')[0].outcome, 'interrupted');
  assert.equal(rows(flow, 'AGENT')[0].context.persona, 'test-engineer');
  assert.equal(rows(flow, 'AGENT')[0].context.ticketId, 'ABC-2');
});

test('every payload field is hostile: no content, media, errors, env, PII or content hashes in state/export', async t => {
  const dir = sandbox(t);
  const file = path.join(dir, 'synthetic.jsonl');
  const secret = 'SYNTHETIC_SECRET_canary_person@example.invalid';
  const { flow, hook } = driver();
  transcript(file, [assistant('msg-safe', 1800000040000, { content: [
    { type: 'thinking', thinking: secret, signature: secret },
    { type: 'image', source: { data: secret } },
    { type: 'tool_use', input: { command: secret } },
    { type: 'text', text: secret }
  ], usage: { input_tokens: 10, output_tokens: 1, [secret]: secret } })]);
  for (const event of HOOK_EVENTS) {
    await hook(event, { agent_id: event.startsWith('Subagent') ? 'private-child' : undefined,
      tool_name: secret, tool_use_id: 'safe-tool', model: secret, to_model: secret,
      agent_type: secret, persona: secret, ticketId: secret, prompt: secret, last_assistant_message: secret,
      error: secret, error_details: secret, reason: secret, summary: secret, env: { [secret]: secret },
      permission_mode: secret, session_title: secret, effort: { level: secret },
      tool_input: { command: secret, skill: secret, file_path: secret, prompt: secret, model: secret },
      tool_response: { content: secret, usage: { input_tokens: secret }, agentId: secret },
      command_name: secret, command_args: secret, command_source: secret,
      transcript_path: file, agent_transcript_path: file, arbitrary: secret });
  }
  const output = JSON.stringify({ states: [...flow.states], records: [...flow.records],
    runs: [...flow.runs], pending: [...flow.queue], bindings: [...flow.launches] });
  assert.ok(!output.includes(secret));
  for (const algorithm of ['sha256', 'sha1', 'md5']) {
    const hash = crypto.createHash(algorithm).update(secret).digest('hex');
    assert.ok(!output.includes(hash.slice(0, 16)), 'private content must not be hashed either');
  }
  for (const forbidden of ['last_assistant_message', 'tool_input', 'tool_response', 'thinking', 'signature', 'error_details']) {
    assert.ok(!output.includes(`"${forbidden}"`));
  }
});

test('stdin JSON parser is byte-bounded and never exposes parser excerpts', async () => {
  const input = new PassThrough();
  const pending = readPayload(input);
  input.end('{"secret": "private malformed JSON');
  await assert.rejects(pending, { message: 'Claude metadata hook input unavailable.' });
  const large = new PassThrough();
  const rejected = readPayload(large);
  large.end(Buffer.alloc(MAX_INPUT_BYTES + 1, 97));
  await assert.rejects(rejected, { message: 'Claude metadata hook input unavailable.' });
  const timeout = new PassThrough();
  await assert.rejects(readPayload(timeout, 10), { message: 'Claude metadata hook input unavailable.' });
});

test('CLI uses only stdin, emits only native Bash JSON, and fails open without payload logging', t => {
  const dir = sandbox(t);
  for (const name of ['claude.cjs', 'claude-hook.cjs', 'privacy.cjs']) {
    fs.copyFileSync(path.join(__dirname, '../runtime/langfuse', name), path.join(dir, name));
  }
  // A transport-free module in an isolated fixture, never the real flow.
  fs.writeFileSync(path.join(dir, 'flow.cjs'), `
    const crypto = require('node:crypto');
    exports.createFlow = () => {
      const state = new Map();
      const run = { rootSpanId:'1111111111111111',traceId:'22222222222222222222222222222222',
        sessionId:'test-session',nativeSessionId:'session-test',startedAt:1800000000000 };
      return { id:s=>crypto.createHash('sha256').update(s).digest('hex').slice(0,16),
        session:()=>run,resolve:r=>r,readState:k=>state.get(k),writeState:(k,v)=>state.set(k,v),
        submit:()=>{},flush:async()=>{},createToolLaunch:()=>({nonce:'testnonce'}),store:{createLaunch:()=>({nonce:'testnonce'})} };
    };
  `);
  const cli = path.join(dir, 'claude-hook.cjs');
  const run = input => spawnSync(process.execPath, [cli], { input, encoding: 'utf8', timeout: 3000 });
  const result = run(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'session-test',
    tool_use_id: 'tool-test', tool_name: 'Bash', tool_input: { command: 'echo synthetic-only' } }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse',
    updatedInput: { command: "export BRAIN_TRACE_LAUNCH_ID='testnonce'\necho synthetic-only" } } });
  for (const input of ['{private malformed secret', 'a'.repeat(MAX_INPUT_BYTES + 1)]) {
    const invalid = run(input);
    assert.equal(invalid.status, 0);
    assert.equal(invalid.stdout, '');
    assert.equal(invalid.stderr, 'Claude metadata hook unavailable.\n');
  }
  const noOutput = run(JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'session-test', last_assistant_message: 'private' }));
  assert.equal(noOutput.stdout, '');
  assert.equal(noOutput.stderr, '');
  const argsOnly = spawnSync(process.execPath, [cli, '{"prompt":"do not accept argv"}'],
    { input: '', encoding: 'utf8', timeout: 3000 });
  assert.equal(argsOnly.status, 0);
  assert.equal(argsOnly.stdout, '');
  assert.equal(argsOnly.stderr, 'Claude metadata hook unavailable.\n');
});
