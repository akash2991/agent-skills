'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createController, usageDetails } = require('../runtime/langfuse/pi.js');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function harness() {
  const handlers = new Map();
  const records = [];
  const states = new Map();
  const bindings = [];
  let now = 100000;
  let runs = 0;
  let flushes = 0;
  const flow = {
    id: seed => hash(String(seed ?? ++now)).slice(0, 16),
    begin: opts => ({ ...opts, harness: 'pi', traceId: hash(`trace:${++runs}`).slice(0, 32), rootSpanId: hash(`root:${runs}`).slice(0, 16),
      sessionId: opts.nativeSessionId, nativeSessionId: opts.nativeSessionId, runId: String(runs), startedAt: now, skillsInvoked: [], skillsLoaded: [] }),
    session: () => null, resolve: run => run, update: (run, patch) => ({ ...run, ...patch }),
    captureBrainCommand: run => run,
    createToolLaunch(run) { return this.store.createLaunch(run, { multiUse: true }); },
    captureSkill: (run, event) => ({ ...run, skillsLoaded: event.success && event.toolName === 'read' ? ['test-driven-development'] : [] }),
    readState: key => states.get(key), writeState: (key, value) => states.set(key, value),
    submit: (run, batch) => records.push(...batch.map(record => structuredClone({ ...record, context: run }))),
    flush: async () => { flushes++; return { accepted: 1 }; },
    store: { createLaunch: (parent, child) => { const binding = { nonce: crypto.randomBytes(16).toString('hex'), parent, ...child }; bindings.push(binding); return binding; } }
  };
  const pi = { on: (name, handler) => { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
    registerTool: tool => { pi.contextTool = tool; }, getThinkingLevel: () => 'low' };
  const ctx = { cwd: '/synthetic/project', model: { id: 'test-model', provider: 'test-provider' }, thinkingLevel: 'low',
    sessionManager: { getSessionId: () => '11111111-1111-4111-8111-111111111111' }, hasUI: false };
  const controller = createController(pi, { flow, clock: () => ++now });
  const emit = async (type, fields = {}) => { for (const handler of handlers.get(type) || []) await handler({ type, ...fields }, ctx); };
  return { pi, flow, records, bindings, states, controller, emit, ctx, get runs() { return runs; }, get flushes() { return flushes; } };
}

const canary = 'sk-lf-BRAIN_SYNTHETIC_ONLY_PI_TEST password=NOT_REAL brain@example.invalid 000-00-0000';

test('Pi exports metadata/usage only; payloads and arguments never reach records/checkpoints', async () => {
  const h = harness();
  await h.emit('session_start');
  await h.emit('input', { text: canary });
  await h.emit('before_agent_start', { messageType: 'user', prompt: canary });
  await h.emit('before_provider_request');
  await h.emit('message_end', { message: { role: 'assistant', model: 'observed-model', provider: 'test-provider', content: [{ type: 'text', text: canary }], usage: { input: 12, output: 6, reasoning: 2, cacheRead: 3 }, stopReason: 'toolUse' } });
  await h.emit('tool_execution_start', { toolCallId: 'read-1', toolName: 'read', args: { path: '/synthetic/.agents/skills/test-driven-development/SKILL.md', secret: canary } });
  await h.emit('tool_execution_end', { toolCallId: 'read-1', toolName: 'read', result: { content: [{ type: 'text', text: canary }] }, isError: false });
  await h.emit('agent_before_settle', { outcome: 'completed' });
  await h.emit('agent_settled', { aborted: false });
  assert.ok(h.records.some(record => record.type === 'AGENT'));
  const generation = h.records.find(record => record.type === 'GENERATION');
  assert.equal(generation.model, 'observed-model');
  assert.equal(generation.usage.input, 12);
  assert.equal(generation.usage.output, 4);
  assert.equal(generation.usage.output_reasoning_tokens, 2);
  assert.ok(h.records.some(record => record.context.skillsLoaded.includes('test-driven-development')));
  assert.ok(!JSON.stringify(h.records).includes(canary));
  assert.ok(!JSON.stringify([...h.states.values()]).includes(canary));
  assert.equal(h.flushes, 1);
});

test('Bash carries only an exact non-secret launch nonce; original command is not checkpointed', async () => {
  const h = harness();
  await h.emit('before_agent_start', { messageType: 'user', prompt: canary });
  const input = { command: `printf '%s' '${canary}'` };
  await h.emit('tool_call', { toolName: 'bash', input });
  assert.ok(input.command.startsWith(`export BRAIN_TRACE_LAUNCH_ID='${h.bindings[0].nonce}'\n`));
  assert.ok(input.command.endsWith(`printf '%s' '${canary}'`));
  assert.ok(!JSON.stringify([...h.states.values(), ...h.bindings]).includes(canary));
});

test('Herdr result binds exact child IDs and a custom continuation reuses its original parent', async () => {
  const h = harness();
  await h.emit('before_agent_start', { messageType: 'user', prompt: 'synthetic task' });
  const parent = [...h.controller.getRoots().values()][0].run;
  await h.emit('tool_execution_start', { toolName: 'subagent', toolCallId: 'dispatch-1', args: { task: canary } });
  const details = { id: 'launch-1', name: 'synthetic-test', agent: 'backend-engineer', sessionFile: '/synthetic/child.jsonl', status: 'started' };
  await h.emit('tool_execution_end', { toolName: 'subagent', toolCallId: 'dispatch-1', isError: false, result: { details } });
  assert.equal(h.bindings[0].launchId, 'launch-1');
  assert.equal(h.bindings[0].sessionFile, undefined, 'a resumed invocation may reuse the transcript but not its original parent capability');
  assert.equal(h.bindings[0].parent.rootSpanId, parent.rootSpanId);
  await h.emit('agent_settled', { aborted: false });
  await h.emit('before_agent_start', { messageType: 'custom', message: { customType: 'subagent_result', details } });
  await h.emit('before_provider_request');
  await h.emit('message_end', { message: { role: 'assistant', model: 'test-model', stopReason: 'stop', usage: { input: 1, output: 1 } } });
  await h.emit('agent_before_settle', { outcome: 'completed' });
  await h.emit('agent_settled', { aborted: false });
  assert.equal(h.runs, 1);
  assert.ok(!h.records.some(record => record.type === 'TOOL' && record.toolName === 'subagent'));
  assert.equal(h.records.at(-1).id, parent.rootSpanId);
  assert.equal(h.records.at(-1).outcome, 'completed');
});

test('abort and reload do not falsely label unfinished work as completed', async () => {
  const h = harness();
  await h.emit('before_agent_start', { messageType: 'user', prompt: 'test' });
  await h.emit('before_provider_request');
  await h.emit('agent_settled', { aborted: true });
  assert.equal(h.records.at(-1).outcome, 'aborted');
  await h.emit('tool_execution_start', { toolName: 'read', toolCallId: 'unfinished', args: { path: canary } });
  await h.emit('session_shutdown', { reason: 'reload' });
  assert.ok(h.records.some(record => record.type === 'TOOL' && record.outcome === 'interrupted'));
  assert.ok(h.records.some(record => record.type === 'GENERATION' && record.outcome === 'aborted'));
  assert.equal(h.flushes, 2);
  assert.equal(h.controller.getRoots().size, 0);
});

test('nested tool calls use their actual tool parent rather than the generation', async () => {
  const h = harness();
  await h.emit('before_agent_start', { messageType: 'user', prompt: 'test' });
  await h.emit('tool_execution_start', { toolName: 'codemode', toolCallId: 'code' });
  await h.emit('tool_execution_start', { toolName: 'read', toolCallId: 'code/1', parentToolCallId: 'code' });
  await h.emit('tool_execution_end', { toolName: 'read', toolCallId: 'code/1', result: {}, isError: false });
  await h.emit('tool_execution_end', { toolName: 'codemode', toolCallId: 'code', result: {}, isError: false });
  const child = h.records.find(record => record.type === 'TOOL' && record.toolName === 'read');
  const parent = h.records.find(record => record.type === 'TOOL' && record.toolName === 'codemode');
  assert.equal(child.parentId, parent.id);
});

test('native subagent error envelopes are failures without exporting their contents', async () => {
  const h = harness();
  await h.emit('before_agent_start', { messageType: 'user', prompt: 'test' });
  await h.emit('tool_execution_start', { toolName: 'subagent', toolCallId: 'launch' });
  await h.emit('tool_execution_end', { toolName: 'subagent', toolCallId: 'launch', isError: false, result: { details: { error: canary } } });
  assert.equal(h.records.find(record => record.type === 'TOOL').outcome, 'error');
  assert.equal(JSON.stringify(h.records).includes(canary), false);
});

test('shutdown does not extend a completed actor span into idle time', async () => {
  const h = harness();
  await h.emit('before_agent_start', { messageType: 'user', prompt: 'test' });
  await h.emit('before_provider_request');
  await h.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', model: 'test-model', usage: {} } });
  await h.emit('agent_settled', { aborted: false });
  const endTime = h.records.filter(record => record.type === 'AGENT').at(-1).endTime;
  await h.emit('session_shutdown', { reason: 'exit' });
  assert.equal(h.records.filter(record => record.type === 'AGENT').at(-1).endTime, endTime);
});

test('reasoning counts never create negative output usage', () => {
  assert.equal(usageDetails({ output: 1, reasoning: 2 }).output, 1);
  assert.equal(usageDetails({ output: 1, reasoning: 2 }).output_reasoning_tokens, undefined);
});
