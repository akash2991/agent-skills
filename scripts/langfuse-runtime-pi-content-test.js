'use strict';

// Real controller, policy discovery, private flow/checkpoints/outbox and SDK
// sink. Synthetic native Pi 1.3 event contracts only; no native/model process,
// transcript reads, installs, activation, auth or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createController } = require('../runtime/langfuse/pi.js');
const { createFlow } = require('../runtime/langfuse/flow.cjs');
const { configurePrivacy, CONTENT_LIMITS } = require('../runtime/langfuse/privacy.cjs');
const { flushOutbox, queueObservation } = require('../runtime/langfuse/export.cjs');
const dependencyRoot = require('./lib/langfuse-test-dependencies.js').testDependencyRoot();
const FULL = { schema: 2, enabled: true, captureMode: 'full-content', capturePolicyVersion: 1,
  redactionPolicyVersion: 1, pii: 'retain', durableRetry: true };
const META = { schema: 1, enabled: true, captureMode: 'metadata-only' };
const PII = 'Zoë 王 😀 person@example.invalid 123-45-6789 415-555-2671 https://example.invalid/person?id=17';
const SECRET = 'sk-proj-SYNTHETIC_PI_CONTENT';
const LITERAL = 'opaque-SYNTHETIC-pi-literal';
const raw = () => ({ prose: `${PII}\n${SECRET}\n${LITERAL}`, token: 'SYNTHETIC_TOKEN',
  nested: [null, '', 0, false, { text: PII, authorization: 'Bearer SYNTHETIC_AUTH' }] });
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
function fixture(t, policy = FULL) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'brain-pi-content-'));
  t.after(() => { configurePrivacy(); fs.rmSync(root, { recursive: true, force: true }); });
  configurePrivacy({ sensitiveLiterals: [LITERAL] });
  const cwd = path.join(root, 'project'), stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.agent-brain/observability'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.agent-brain/observability/pi.js'), 'throw Error("NEVER_EXECUTED");');
  const marker = next => fs.writeFileSync(path.join(cwd, '.agent-brain/tracing.json'), JSON.stringify(next));
  marker(policy);
  const flow = extra => createFlow({ harness: 'pi', cwd, stateDir, env: {},
    flushOutbox: async () => ({ accepted: 0, queued: 0, failed: 0, status: 'synthetic-offline' }), ...extra });
  const outbox = () => fs.existsSync(path.join(stateDir, 'outbox')) ? fs.readdirSync(path.join(stateDir, 'outbox'))
    .filter(file => file.endsWith('.json')).map(file => JSON.parse(fs.readFileSync(path.join(stateDir, 'outbox', file), 'utf8'))) : [];
  const records = () => outbox().map(e => e.record);
  function checkDisk() {
    for (const file of walk(stateDir)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const secret of [SECRET, LITERAL, 'SYNTHETIC_TOKEN', 'SYNTHETIC_AUTH']) assert.ok(!text.includes(secret), `${path.basename(file)}: ${secret}`);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, file);
    }
    const context = fs.readFileSync(path.join(stateDir, 'context-v1.json'), 'utf8');
    assert.ok(!context.includes('person@example.invalid'), 'ContextStore contains metadata only');
  }
  return { root, cwd, stateDir, flow, marker, outbox, records, checkDisk };
}
function harness(f, options = {}) {
  const handlers = new Map(), flow = options.flow || f.flow();
  const pi = { on: (name, handler) => handlers.set(name, handler), registerFlag() {},
    getFlag: () => options.perRun || false, registerTool() {}, getThinkingLevel: () => 'low' };
  const ctx = { cwd: f.cwd, hasUI: false, isProjectTrusted: () => options.trusted !== false,
    model: { id: 'requested-model', provider: 'synthetic-provider' },
    sessionManager: { getSessionId: () => options.session || '11111111-1111-4111-8111-111111111111' } };
  const controller = createController(pi, { flow });
  const dispatch = async (name, event) => {
    const result = await handlers.get(name)?.(event, ctx);
    assert.equal(result, undefined, `${name}: observer must never replace or decide native behavior`);
  };
  const emit = (name, fields = {}) => dispatch(name, { type: name, ...fields });
  const begin = async (prompt = `expanded ${PII}`, text = `raw ${PII}`) => {
    await emit('input', { text, source: 'interactive' });
    await emit('before_agent_start', { messageType: 'user', prompt, systemPrompt: `system ${PII}`, systemPromptOptions: { customPrompt: undefined, forceSystemPrompt: undefined, selectedTools: ['read', 'bash'],
      hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: '',
      sections: { project_context: PII }, cwd: f.cwd, contextFiles: [], skills: [] } });
    return [...controller.getRoots().values()].at(-1)?.run;
  };
  const request = async (payload = raw()) => emit('before_provider_request', { payload });
  const answer = async (content = [{ type: 'text', text: PII }], extra = {}) => emit('message_end', {
    message: { role: 'assistant', content, model: 'actual-model', provider: 'synthetic-provider',
      stopReason: 'stop', usage: { input: 12, output: 6, cacheRead: 2 }, ...extra }
  });
  const settle = async outcome => { await emit('agent_before_settle', { outcome: outcome || 'completed' }); await emit('agent_settled', { aborted: outcome === 'aborted' }); };
  // Pi agent-loop emits tool_execution_start BEFORE tool_call. Model arguments
  // are owned by assistant message toolCall IDs, never by nearest active root.
  const issue = async (calls, extra = {}) => { await request(); await answer(calls.map(c => ({ type: 'toolCall', id: c.id, name: c.name, arguments: c.args })), { stopReason: 'toolUse', ...extra }); };
  return { flow, ctx, controller, emit, dispatch, begin, request, answer, settle, issue };
}
const byType = (f, type) => f.records().filter(r => r.type === type).sort((a, b) => a.startTime - b.startTime);
const open = h => h.flow.readState(`pi-content-open:${h.ctx.sessionManager.getSessionId()}`)?.keys || [];
const captures = h => open(h).map(key => ({ key, capture: h.flow.readObservation(key) })).filter(x => x.capture);
const ack = async f => {
  const spans = [];
  const result = await flushOutbox({ stateDir: f.stateDir, env: {}, dependencyRoot, timeoutMs: 10000,
    exporterFactory: () => ({ export(batch, cb) { spans.push(...batch); cb({ code: 0 }); }, async shutdown() {} }) });
  return { result, spans };
};

test('full consent captures raw/expanded/system and distinct provider generations plus final actor answer', async t => {
  const f = fixture(t), h = harness(f); await h.emit('session_start');
  const run = await h.begin();
  const payload = { system: [PII], messages: [{ role: 'user', content: raw() }], tools: [{ name: 'read', schema: { nullable: null } }] };
  const original = structuredClone(payload);
  await h.request(payload);
  const first = captures(h).find(x => x.capture.record.type === 'GENERATION');
  assert.equal(first.capture.record.content.output.status, 'unavailable');
  payload.system[0] = 'mutated after snapshot';
  assert.equal(first.capture.record.content.input.value.payload.system[0], PII);
  assert.equal(first.capture.record.content.input.value.finalWireGuaranteed, false);
  assert.equal(first.capture.record.content.input.value.representation, 'native-payload-boundary');
  await h.answer([{ type: 'thinking', thinking: PII }, { type: 'text', text: `${PII} ${SECRET}` }]);
  const firstDone = f.outbox().find(e => e.record.id === first.capture.record.id);
  assert.ok(firstDone.revision > first.capture.revision);
  assert.deepEqual(firstDone.record.content.input, first.capture.record.content.input);
  assert.equal(h.flow.readObservation(first.key), null, 'close follows durable handoff');
  assert.equal(firstDone.record.content.output.value.content[0].thinking, PII);
  assert.equal(firstDone.record.content.output.value.hiddenReasoningAvailable, false);
  await h.request({ second: PII, oldContext: original.messages });
  await h.answer([{ type: 'text', text: `final ${PII}` }]);
  await h.settle();
  const generations = byType(f, 'GENERATION'); assert.equal(generations.length, 2);
  assert.notEqual(generations[0].id, generations[1].id);
  assert.ok(generations.every(g => g.parentId === run.rootSpanId && g.model === 'actual-model' && g.usage.input === 12));
  const root = byType(f, 'AGENT')[0]; assert.equal(root.id, run.rootSpanId);
  const input = root.content.input.value;
  assert.equal(input.rawUserInput.value.text, `raw ${PII}`);
  assert.equal(input.prompt, `expanded ${PII}`); assert.equal(input.systemPrompt, `system ${PII}`);
  assert.equal(root.content.output.value.content[0].text, `final ${PII}`);
  assert.ok(!Object.hasOwn(root.content.input.value, 'payload'), 'actor prompt not a provider request');
  assert.equal(open(h).length, 0); f.checkDisk();
  const { result, spans } = await ack(f); assert.equal(result.accepted, 3);
  const span = spans.find(s => s.spanContext().spanId === first.capture.record.id);
  assert.deepEqual(JSON.parse(span.attributes['langfuse.observation.input']), firstDone.record.content.input.value);
  for (const secret of [SECRET, LITERAL, 'SYNTHETIC_TOKEN', 'SYNTHETIC_AUTH']) assert.ok(!JSON.stringify(spans.map(s => s.attributes)).includes(secret));
  assert.equal(queueObservation(first.capture.record, { stateDir: f.stateDir, revision: first.capture.revision }).obsolete, true, 'ACK preserves revision floor');
  assert.equal((await ack(f)).result.accepted, 0);
});

test('all tool JSON, original model args versus Bash execution mutation, native results/errors and nested/parallel parents', async t => {
  const f = fixture(t), h = harness(f); await h.begin();
  const args = { command: `printf '${PII}'` };
  await h.issue([{ id: 'bash-1', name: 'bash', args }, { id: 'code', name: 'codemode', args: raw() }]);
  const modelArgs = structuredClone(args);
  await h.emit('tool_execution_start', { toolCallId: 'bash-1', toolName: 'bash', args });
  const before = captures(h).find(x => x.capture.record.type === 'TOOL');
  await h.emit('tool_call', { toolCallId: 'bash-1', toolName: 'bash', input: args });
  assert.ok(args.command.startsWith('export BRAIN_TRACE_LAUNCH_ID='), 'existing nonce injection remains unchanged');
  const injectedNonce = /='([^']+)'/.exec(args.command)[1];
  await h.emit('tool_execution_start', { toolCallId: 'code', toolName: 'codemode', args: raw() });
  await h.emit('tool_execution_start', { toolCallId: 'code/1', parentToolCallId: 'code', toolName: 'lookup', args: { values: [null, '', false, 0, PII] } });
  const result = { content: [{ type: 'text', text: PII }, { type: 'text', text: '' }], details: raw(), structuredContent: { data: [null, '', false, 0, PII] } };
  const original = structuredClone(result);
  await h.emit('tool_execution_end', { toolCallId: 'code/1', parentToolCallId: 'code', toolName: 'lookup', result, isError: true });
  assert.deepEqual(result, original, 'capture never modifies native result');
  await h.emit('tool_execution_end', { toolCallId: 'bash-1', toolName: 'bash', result, isError: false });
  await h.emit('tool_execution_end', { toolCallId: 'code', toolName: 'codemode', result: { content: [] }, isError: false });
  const tools = byType(f, 'TOOL'), bash = tools.find(r => r.toolName === 'bash');
  assert.deepEqual(bash.content.input.value.modelArguments.value, modelArgs);
  assert.equal(bash.content.input.value.executionArguments.status, 'unsupported', 'never persist injected runtime capability');
  assert.deepEqual(bash.content.output.value.result.structuredContent.data, [null, '', false, 0, PII]);
  assert.equal(bash.id, before.capture.record.id);
  const done = f.outbox().find(e => e.record.id === bash.id); assert.ok(done.revision > before.capture.revision);
  const child = tools.find(r => r.toolName === 'lookup'), parent = tools.find(r => r.toolName === 'codemode');
  assert.equal(child.parentId, parent.id); assert.equal(child.outcome, 'error');
  assert.equal(child.content.input.value.modelArguments.status, 'unavailable', 'nested execution is not a model-issued call');
  assert.deepEqual(child.content.input.value.executionArguments.value.values, [null, '', false, 0, PII]);
  await h.emit('session_shutdown');
  for (const file of walk(f.stateDir)) {
    const body = fs.readFileSync(file, 'utf8');
    // The nonce is legitimate in metadata-only launch/context state, NOT in observations.
    if (body.includes('"content"')) assert.ok(!body.includes(injectedNonce));
  }
  f.checkDisk();
});

test('late tool completion stays with its issuing actor, not the newer active root; session-scoped IDs do not collide', async t => {
  const f = fixture(t), h = harness(f), a = await h.begin('actor A');
  await h.issue([{ id: 'reused', name: 'lookup', args: { actor: 'A', text: PII } }]);
  await h.emit('tool_execution_start', { toolCallId: 'reused', toolName: 'lookup', args: { actor: 'A' } });
  const b = await h.begin('actor B'); await h.request({ actor: 'B' }); await h.answer();
  await h.emit('tool_execution_end', { toolCallId: 'reused', toolName: 'lookup', result: { content: [{ type: 'text', text: PII }] }, isError: false });
  const tool = byType(f, 'TOOL')[0]; assert.equal(tool.parentId, a.rootSpanId); assert.equal(tool.context.runId, a.runId);
  assert.notEqual(tool.parentId, b.rootSpanId);
  const second = harness(f, { session: '22222222-2222-4222-8222-222222222222' });
  const c = await second.begin('actor C'); await second.issue([{ id: 'reused', name: 'lookup', args: { actor: 'C' } }]);
  await second.emit('tool_execution_start', { toolCallId: 'reused', toolName: 'lookup', args: {} });
  await second.emit('tool_execution_end', { toolCallId: 'reused', toolName: 'lookup', result: {}, isError: false });
  const other = byType(f, 'TOOL').find(r => r.parentId === c.rootSpanId); assert.ok(other); assert.notEqual(other.id, tool.id);
  f.checkDisk();
});

test('restart retries known requests/tools under original owner, grant, IDs and revisions without reading native history', async t => {
  const f = fixture(t), h = harness(f); await h.begin();
  await h.issue([{ id: 'unfinished', name: 'lookup', args: raw() }]);
  await h.emit('tool_execution_start', { toolCallId: 'unfinished', toolName: 'lookup', args: raw() });
  await h.request({ newObservedRequest: raw(), oldConversation: [PII] });
  const saved = captures(h); assert.equal(saved.length, 3);
  assert.ok(saved.every(x => x.capture.record.content.output.status === 'unavailable' || x.capture.record.type === 'AGENT'));
  f.checkDisk(); f.marker(META);
  const restarted = harness(f); restarted.ctx.sessionManager.getBranch = () => assert.fail('no transcript reparse/backfill');
  await restarted.emit('session_start');
  for (const { key, capture } of saved) {
    const queued = f.outbox().find(e => e.record.id === capture.record.id);
    assert.ok(queued, key); assert.equal(queued.revision, capture.revision);
    assert.deepEqual(queued.record.content, capture.record.content); assert.equal(queued.record.outcome, 'interrupted');
    assert.equal(restarted.flow.readObservation(key), null);
    assert.equal(queued.record.context.runId, capture.owner.runId);
  }
  assert.equal(open(restarted).length, 0);
  const count = f.outbox().length; await restarted.emit('session_start'); assert.equal(f.outbox().length, count);
  f.checkDisk(); assert.equal((await ack(f)).result.accepted, count);
});

test('shutdown and abort/error preserve partial input and native error/stop information without invented model or usage', async t => {
  for (const stopReason of ['aborted', 'error']) {
    const f = fixture(t), h = harness(f); await h.begin(); await h.request(raw());
    await h.answer([{ type: 'text', text: '' }], { stopReason, errorMessage: `${PII} ${SECRET}` });
    await h.settle(stopReason); const g = byType(f, 'GENERATION')[0];
    assert.equal(g.outcome, stopReason); assert.ok(g.content.output.value.errorMessage.includes(PII)); f.checkDisk();
  }
  const f = fixture(t), h = harness(f); await h.begin(); await h.request(raw());
  await h.emit('session_shutdown'); const g = byType(f, 'GENERATION')[0];
  assert.equal(g.outcome, 'interrupted'); assert.equal(g.content.output.status, 'unavailable');
  assert.ok(!Object.hasOwn(g, 'model')); assert.ok(!Object.hasOwn(g, 'usage')); f.checkDisk();
});

test('native truncation remains explicit, without expanding artifact paths or URLs', async t => {
  const f = fixture(t), h = harness(f); await h.begin();
  await h.issue([{ id: 'truncated', name: 'read', args: { path: '/never/read/this' } }], { stopReason: 'length' });
  await h.emit('tool_execution_start', { toolCallId: 'truncated', toolName: 'read', args: { path: '/never/read/this' } });
  const result = { content: [{ type: 'text', text: `${PII}\nOutput truncated; /never/read/this https://example.invalid/not-fetched` }],
    details: { truncation: { truncated: true, totalLines: 9000, outputLines: 2000 }, fullOutputPath: '/never/read/this' } };
  await h.emit('tool_execution_end', { toolCallId: 'truncated', toolName: 'read', result, isError: true });
  const g = byType(f, 'GENERATION')[0], tool = byType(f, 'TOOL')[0];
  assert.equal(g.content.output.value.nativeTruncated, true);
  assert.equal(tool.content.output.value.nativeTruncated, true); assert.equal(tool.content.output.value.artifactExpansion, false);
  assert.deepEqual(tool.content.output.value.result, result); f.checkDisk();
});

test('record budget refuses whole surfaces, native binary is unsupported, missing payload stays unavailable', async t => {
  const f = fixture(t), h = harness(f); await h.begin();
  await h.request({ text: 'é'.repeat(CONTENT_LIMITS.recordBytes) }); await h.answer();
  await h.request({ content: [{ type: 'image', mimeType: 'image/png', data: 'SYNTHETIC_BASE64' }] }); await h.answer();
  await h.emit('before_provider_request'); await h.answer(); await h.settle();
  const gs = byType(f, 'GENERATION');
  assert.equal(gs[0].content.input.status, 'refused_size'); assert.ok(!Object.hasOwn(gs[0].content.input, 'value'));
  assert.equal(gs[1].content.input.status, 'unsupported'); assert.equal(gs[2].content.input.status, 'unavailable');
  for (const r of f.records()) assert.ok(Buffer.byteLength(JSON.stringify(r)) <= CONTENT_LIMITS.recordBytes);
  f.checkDisk();
});

test('metadata/absent-marker per-run mode never invokes body getters or silently upgrades scope', async t => {
  for (const declared of [true, false]) {
    const f = fixture(t, META);
    if (!declared) fs.unlinkSync(path.join(f.cwd, '.agent-brain/tracing.json'));
    const h = harness(f, { perRun: true });
    let reads = 0;
    const native = fields => {
      const event = { ...fields };
      for (const key of ['text', 'prompt', 'systemPrompt', 'systemPromptOptions', 'images', 'payload', 'content', 'args', 'result']) {
        Object.defineProperty(event, key, { enumerable: true, get() { reads++; throw Error('BODY_GETTER'); } });
      }
      return event;
    };
    // Do not use emit's spread, which would itself invoke the synthetic getters.
    const handlers = new Map();
    const pi = { on: (name, fn) => handlers.set(name, fn), registerFlag() {}, getFlag: () => true, registerTool() {} };
    const controller = createController(pi, { flow: h.flow });
    for (const [name, event] of [['input', native({})], ['before_agent_start', native({ messageType: 'user' })],
      ['before_provider_request', native({})], ['tool_execution_start', native({ toolCallId: 'read', toolName: 'read' })],
      ['tool_execution_end', native({ toolCallId: 'read', toolName: 'read', isError: false })]]) {
      assert.equal(await handlers.get(name)(event, h.ctx), undefined);
    }
    await handlers.get('message_end')({ message: { role: 'assistant', stopReason: 'stop', model: 'actual-model' } }, h.ctx);
    await handlers.get('agent_settled')({ aborted: false }, h.ctx);
    assert.equal(reads, 0); assert.ok(f.records().every(r => !r.content));
    assert.equal((await controller.getContextTool().execute('id', {}, undefined, undefined, h.ctx)).details.captureMode, 'metadata-only');
    assert.ok(!h.flow.readState('health')?.captureFailureObserved); f.checkDisk();
  }
});

test('a narrower event cwd cannot inherit the full-content startup grant', async t => {
  const f = fixture(t), h = harness(f); await h.begin();
  const nested = path.join(f.cwd, 'nested');
  fs.mkdirSync(path.join(nested, '.agent-brain/observability'), { recursive: true });
  fs.writeFileSync(path.join(nested, '.agent-brain/tracing.json'), JSON.stringify(META));
  fs.writeFileSync(path.join(nested, '.agent-brain/observability/pi.js'), '// discovery sentinel');
  h.ctx.cwd = nested;
  let reads = 0;
  const event = { type: 'before_provider_request' };
  Object.defineProperty(event, 'payload', { get() { reads++; throw Error('NARROWER_SCOPE'); } });
  await h.dispatch('before_provider_request', event); await h.answer(); await h.settle();
  assert.equal(reads, 0); assert.ok(byType(f, 'GENERATION').every(g => !g.content));
  assert.equal((await h.controller.getContextTool().execute('id', {}, undefined, undefined, h.ctx)).details.captureMode, 'metadata-only');
  f.checkDisk();
});

test('native trust, malformed declaration and process kill are checked before body access/capture', async t => {
  const f = fixture(t), h = harness(f, { trusted: false });
  const bomb = {}; Object.defineProperty(bomb, 'payload', { enumerable: true, get() { assert.fail('refused body access'); } });
  // Trust gate does not even construct a root.
  await h.emit('before_agent_start', { messageType: 'user', prompt: PII }); assert.equal(h.controller.getRoots().size, 0);
  const k = harness(f); await k.begin(); const before = captures(k);
  const old = process.env.BRAIN_TRACING_ENABLED;
  try { process.env.BRAIN_TRACING_ENABLED = '0'; await k.emit('before_provider_request', { payload: bomb }); await k.emit('session_shutdown'); }
  finally { if (old === undefined) delete process.env.BRAIN_TRACING_ENABLED; else process.env.BRAIN_TRACING_ENABLED = old; }
  assert.equal(k.controller.getRoots().size, 0); assert.equal(f.records().length, 0);
  for (const { key, capture } of before) assert.deepEqual(k.flow.readObservation(key), capture);
  for (const declaration of [JSON.stringify({ ...FULL, enabled: false }), '{']) {
    fs.writeFileSync(path.join(f.cwd, '.agent-brain/tracing.json'), declaration);
    const refused = harness(f); assert.equal(await refused.begin(), undefined);
    assert.equal(refused.controller.getRoots().size, 0); assert.equal(f.records().length, 0);
  }
});

test('no inferred generation or tool owner; compaction usage does not invent provider content/model', async t => {
  const f = fixture(t), h = harness(f);
  await h.request(raw()); await h.answer(); assert.equal(f.records().length, 0);
  await h.begin(); await h.answer();
  await h.emit('tool_execution_start', { toolCallId: 'unknown', toolName: 'subagent', args: raw() });
  await h.emit('tool_execution_end', { toolCallId: 'unknown', toolName: 'subagent', result: raw(), isError: false });
  assert.equal(byType(f, 'TOOL').length, 0); assert.equal(h.flow.readState('health').piToolOwnershipUnavailable, true);
  await h.emit('session_compact', { compactionEntry: { usage: { input: 4, output: 2 }, summary: PII } });
  const g = byType(f, 'GENERATION')[0]; assert.equal(g.content.input.status, 'unavailable');
  assert.equal(g.content.output.status, 'unavailable'); assert.ok(!g.model); assert.equal(g.usage.input, 4);
});

test('content failure never removes existing Bash lineage transport or changes a native permission/return decision', async t => {
  const f = fixture(t), flow = f.flow(), h = harness(f, { flow });
  const create = flow.createContent;
  flow.createContent = () => { throw Error('SYNTHETIC_CONTENT_UNAVAILABLE'); };
  await h.begin(); await h.request();
  const input = { command: `printf '${PII}'` };
  await h.answer([{ type: 'toolCall', id: 'bash-failure', name: 'bash', arguments: input }]);
  await h.emit('tool_execution_start', { toolCallId: 'bash-failure', toolName: 'bash', args: input });
  await h.emit('tool_call', { toolCallId: 'bash-failure', toolName: 'bash', input });
  assert.ok(input.command.startsWith('export BRAIN_TRACE_LAUNCH_ID='));
  assert.ok(input.command.endsWith(`printf '${PII}'`));
  assert.equal(flow.readState('health').captureFailureObserved, true);
  assert.equal(byType(f, 'TOOL').length, 0, 'lineage fallback is not capture ownership');
  flow.createContent = create; await h.emit('session_shutdown'); f.checkDisk();
});

test('durable handoff failure preserves the completed revision and input; shutdown retries without downgrading output', async t => {
  const f = fixture(t), flow = f.flow(), h = harness(f, { flow }); await h.begin(); await h.request(raw());
  const originalClose = flow.closeObservation;
  let fail = true; flow.closeObservation = key => { if (fail) throw Error('SYNTHETIC_HANDOFF_FAILURE'); return originalClose(key); };
  await h.answer();
  const saved = captures(h).find(x => x.capture.record.type === 'GENERATION');
  assert.equal(saved.capture.record.outcome, 'completed'); assert.equal(h.flow.readState('health').captureFailureObserved, true);
  fail = false; await h.emit('session_shutdown');
  const done = f.outbox().find(e => e.record.id === saved.capture.record.id);
  assert.equal(done.revision, saved.capture.revision); assert.deepEqual(done.record.content, saved.capture.record.content);
  assert.equal(done.record.outcome, 'completed'); f.checkDisk();
});

test('successful dispatch remains a child AGENT; unsupported typed dispatch attachment is explicit, not a duplicate TOOL', async t => {
  const f = fixture(t), h = harness(f), parent = await h.begin();
  await h.issue([{ id: 'dispatch', name: 'subagent', args: { task: PII } }]);
  await h.emit('tool_execution_start', { toolCallId: 'dispatch', toolName: 'subagent', args: { task: PII } });
  const details = { id: 'exact-child-launch', sessionFile: '/synthetic/child.jsonl', status: 'started', name: 'child' };
  await h.emit('tool_execution_end', { toolCallId: 'dispatch', toolName: 'subagent', result: { details }, isError: false });
  assert.equal(h.flow.readState('health').piDispatchContentUnsupported, true);
  const index = h.flow.readState(`pi-content-open:${parent.nativeSessionId}`);
  assert.equal(index.blocked.length, 1); assert.equal(h.flow.readObservation(index.blocked[0]).record.content.output.status, 'unsupported');
  const child = harness(f, { session: '22222222-2222-4222-8222-222222222222', flow: f.flow({ env: { PI_SUBAGENT_ID: details.id } }) });
  const run = await child.begin('child own prompt'); await child.request({ child: PII }); await child.answer(); await child.settle();
  assert.equal(run.parentSpanId, parent.rootSpanId);
  const childRoot = byType(f, 'AGENT').find(r => r.id === run.rootSpanId); assert.equal(childRoot.content.input.value.prompt, 'child own prompt');
  await h.settle();
  await h.emit('before_agent_start', { messageType: 'custom', message: { customType: 'subagent_result', details } });
  await h.request({ resumed: PII }); await h.answer(); await h.settle();
  assert.equal(h.controller.getRoots().size, 1); assert.equal(byType(f, 'TOOL').length, 0);
  assert.equal(byType(f, 'AGENT').find(r => r.id === parent.rootSpanId).outcome, 'completed');
  await h.emit('session_shutdown');
  const restart = harness(f); await restart.emit('session_start'); assert.equal(byType(f, 'TOOL').length, 0);
  assert.equal(restart.flow.readState(`pi-content-open:${parent.nativeSessionId}`).blocked.length, 1); f.checkDisk();
});

test('exact deferred children and descendants retain projected content/tickets through later binding and restart', async t => {
  const f = fixture(t), parent = harness(f), p = await parent.begin();
  const child = harness(f, { session: '22222222-2222-4222-8222-222222222222', flow: f.flow({ env: { PI_SUBAGENT_ID: 'late-child' } }) });
  const c = await child.begin('child prompt'); await child.request(raw()); await child.answer(); await child.settle();
  const binding = child.flow.createToolLaunch(c);
  const grand = harness(f, { session: '33333333-3333-4333-8333-333333333333', flow: f.flow({ env: { BRAIN_TRACE_LAUNCH_ID: binding.nonce } }) });
  const g = await grand.begin('grandchild prompt'); await grand.request(raw()); await grand.answer(); await grand.settle();
  const pendingDir = path.join(f.stateDir, 'adapters/pending');
  const pending = fs.readdirSync(pendingDir).map(file => JSON.parse(fs.readFileSync(path.join(pendingDir, file), 'utf8')));
  const originals = new Map(pending.flatMap(batch => batch.records.map((record, i) => [record.id, { record, revision: batch.revisions[i] }])));
  assert.equal(originals.size, 4); assert.equal(f.records().length, 0);
  parent.flow.store.createLaunch(p, { launchId: 'late-child', multiUse: true }); f.marker(META);
  await f.flow().flush({ timeoutMs: 10000 });
  assert.equal(fs.readdirSync(pendingDir).length, 0); assert.equal(f.records().length, 4);
  for (const envelope of f.outbox()) {
    const original = originals.get(envelope.record.id);
    assert.equal(envelope.revision, original.revision); assert.deepEqual(envelope.record.content, original.record.content);
    assert.equal(envelope.record.traceId, p.traceId); assert.equal(envelope.record.sessionId, p.sessionId);
    assert.ok([c.runId, g.runId].includes(envelope.record.context.runId));
  }
  assert.equal(byType(f, 'AGENT').find(r => r.id === g.rootSpanId).parentId, c.rootSpanId);
  f.checkDisk(); assert.equal((await ack(f)).result.accepted, 4);
});

test('actual native optional-undefined fields have JSON boundary semantics, while accessors/classes/cycles refuse without evaluation', async t => {
  const f = fixture(t), h = harness(f); await h.begin();
  await h.request({ messages: [{ role: 'user', content: PII }], optional: undefined });
  await h.answer([{ type: 'text', text: PII, textSignature: undefined }]);
  const generation = byType(f, 'GENERATION')[0];
  assert.equal(generation.content.input.value.undefinedObjectFields, 'omitted');
  assert.ok(!Object.hasOwn(generation.content.input.value.payload, 'optional'));
  assert.deepEqual(generation.content.output.value.content, [{ type: 'text', text: PII }]);
  const root = captures(h).find(x => x.capture.record.type === 'AGENT').capture.record;
  assert.equal(root.content.input.value.prompt, `expanded ${PII}`, 'native normalized prompt options do not destroy the prompt');
  assert.deepEqual(root.content.input.value.systemPromptOptions.sections, { project_context: PII });
  assert.ok(!Object.hasOwn(root.content.input.value.systemPromptOptions, 'customPrompt'));
  let reads = 0;
  const accessor = { type: 'before_provider_request' };
  Object.defineProperty(accessor, 'payload', { enumerable: true, get() { reads++; throw Error('MUST_NOT_EVALUATE'); } });
  await h.dispatch('before_provider_request', accessor); await h.answer();
  const cycle = {}; cycle.self = cycle;
  for (const payload of [cycle, new Date(), { value: NaN }, { content: [undefined] }]) { await h.request(payload); await h.answer(); }
  assert.equal(reads, 0);
  for (const g of byType(f, 'GENERATION').slice(1)) assert.equal(g.content.input.status, 'unsupported');
  await h.settle(); f.checkDisk();
});

test('runtime actor arguments and echoed locally minted capabilities are refused, never exported as credentials', async t => {
  const f = fixture(t), h = harness(f); await h.begin();
  const args = { command: `printf '${PII}'` };
  await h.issue([{ id: 'bash', name: 'bash', args }]);
  await h.emit('tool_execution_start', { toolCallId: 'bash', toolName: 'bash', args });
  await h.emit('tool_call', { toolCallId: 'bash', toolName: 'bash', input: args });
  const nonce = /='([^']+)'/.exec(args.command)[1];
  await h.emit('tool_execution_end', { toolCallId: 'bash', toolName: 'bash', isError: false,
    result: { content: [{ type: 'text', text: nonce }], details: undefined } });
  const tool = byType(f, 'TOOL')[0]; assert.equal(tool.content.output.status, 'unsupported');
  await h.request({ command: `brain-trace context --actor ${'a'.repeat(32)} status` }); await h.answer();
  assert.equal(byType(f, 'GENERATION').at(-1).content.input.status, 'unsupported');
  await h.settle();
  for (const envelope of f.outbox()) assert.ok(!JSON.stringify(envelope.record).includes(nonce));
  f.checkDisk();
});

test('an exact deferred continuation after controller restart preserves the original actor prompt and adds the new final answer', async t => {
  const f = fixture(t), h = harness(f), parent = await h.begin('original actor prompt');
  await h.issue([{ id: 'dispatch', name: 'subagent', args: { task: PII } }]);
  await h.emit('tool_execution_start', { toolCallId: 'dispatch', toolName: 'subagent', args: { task: PII } });
  const details = { id: 'exact-restart-child', sessionFile: '/synthetic/restart-child.jsonl', status: 'started' };
  await h.emit('tool_execution_end', { toolCallId: 'dispatch', toolName: 'subagent', result: { details }, isError: false });
  await h.settle(); await h.emit('session_shutdown');
  const key = `pi-content-root:${parent.rootSpanId}`, saved = h.flow.readObservation(key);
  assert.ok(saved); assert.equal(saved.record.content.input.value.prompt, 'original actor prompt');
  const restarted = harness(f); await restarted.emit('session_start');
  assert.deepEqual(restarted.flow.readObservation(key), saved, 'known pending child keeps its projected actor checkpoint');
  await restarted.emit('before_agent_start', { messageType: 'custom', message: { customType: 'subagent_result', details } });
  await restarted.request({ continuation: PII }); await restarted.answer([{ type: 'text', text: `resumed ${PII}` }]); await restarted.settle();
  const root = byType(f, 'AGENT').find(r => r.id === parent.rootSpanId);
  assert.equal(root.content.input.value.prompt, 'original actor prompt');
  assert.equal(root.content.output.value.content[0].text, `resumed ${PII}`);
  assert.equal(root.outcome, 'completed'); assert.equal(restarted.flow.readObservation(key), null);
  assert.equal(byType(f, 'TOOL').length, 0); f.checkDisk();
});

test('steering input and newly observed user messages stay on the live actor, with no transcript backfill', async t => {
  const f = fixture(t), h = harness(f); await h.begin();
  await h.emit('input', { text: `steer ${PII} ${SECRET}`, source: 'interactive', streamingBehavior: 'steer' });
  const message = { role: 'user', content: [{ type: 'text', text: `expanded steering ${PII}` }], timestamp: Date.now() };
  await h.emit('message_end', { message }); await h.request({ messages: [message] }); await h.answer(); await h.settle();
  const root = byType(f, 'AGENT')[0].content.input.value;
  assert.equal(root.prompt, `expanded ${PII}`);
  assert.equal(root.additionalUserInputs.length, 1);
  assert.ok(root.additionalUserInputs[0].value.text.includes(`steer ${PII}`));
  assert.equal(root.additionalUserInputs[0].status, 'credential_redacted');
  assert.deepEqual(root.observedUserMessages[0].value.content, message.content); f.checkDisk();
});

test('recovery failure after a transferred prefix retains the exact indexed suffix for the next restart', async t => {
  const f = fixture(t), h = harness(f); await h.begin();
  await h.issue([{ id: 'pending', name: 'lookup', args: raw() }]);
  await h.emit('tool_execution_start', { toolCallId: 'pending', toolName: 'lookup', args: raw() });
  await h.request(raw());
  const original = captures(h), flow = f.flow(), close = flow.closeObservation;
  let calls = 0;
  flow.closeObservation = key => { if (++calls === 2) throw Error('SYNTHETIC_RECOVERY_FAILURE'); return close(key); };
  const partial = harness(f, { flow }); await partial.emit('session_start');
  assert.equal(flow.readState('health').captureFailureObserved, true);
  assert.equal(f.records().length, 2, 'one previously completed generation plus one transferred open capture');
  const suffix = open(partial); assert.equal(suffix.length, original.length - 1);
  assert.ok(suffix.every(key => flow.readObservation(key)), 'failed recovery cannot erase discovery of unprocessed checkpoints');
  const restart = harness(f); await restart.emit('session_start'); assert.equal(open(restart).length, 0);
  for (const { key, capture } of original) {
    assert.equal(restart.flow.readObservation(key), null);
    assert.equal(f.outbox().find(e => e.record.id === capture.record.id).revision, capture.revision);
  }
  f.checkDisk();
});

test('shutdown failure releases in-memory state and keeps indexed known input for a fresh controller retry', async t => {
  const f = fixture(t), flow = f.flow(), h = harness(f, { flow }); await h.begin(); await h.request(raw());
  const saved = captures(h), close = flow.closeObservation;
  flow.closeObservation = () => { throw Error('SYNTHETIC_OFFLINE_FAILURE'); };
  await h.emit('session_shutdown');
  assert.equal(h.controller.getRoots().size, 0); assert.equal(flow.readState('health').captureFailureObserved, true);
  const retained = saved.map(({ key, capture }) => {
    const after = flow.readObservation(key);
    assert.equal(after.record.id, capture.record.id);
    assert.deepEqual(after.record.content, capture.record.content);
    assert.deepEqual(after.owner, capture.owner); assert.deepEqual(after.captureGrant, capture.captureGrant);
    assert.ok(after.revision >= capture.revision, 'shutdown may capture a new interrupted revision before handoff fails');
    return { key, capture: after };
  });
  flow.closeObservation = close;
  const restarted = harness(f); await restarted.emit('session_start');
  for (const { key, capture } of retained) {
    assert.equal(restarted.flow.readObservation(key), null);
    const queued = f.outbox().find(e => e.record.id === capture.record.id);
    assert.deepEqual(queued.record.content, capture.record.content); assert.equal(queued.revision, capture.revision);
  }
  f.checkDisk();
});
