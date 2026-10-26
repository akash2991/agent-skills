'use strict';

// Real Pi controller, flow, context store, revision queue and checkpoints; only
// the transport/sink is injected. No native harness, SDK install or network.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createController } = require('../runtime/langfuse/pi.js');
const { createFlow } = require('../runtime/langfuse/flow.cjs');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const safeName = 'proj-42-auth';
const ds2Names = ['PROJ-42 auth survey (scout)', 'PROJ-42-auth (scout)'];
const unsafeNames = [
  'password', 'secret', 'bearer', 'api-key',
  'sk-lf-SYNTHETIC_DISPLAY_ONLY', 'brain@example.invalid', '123-45-6789',
  'https://example.invalid/private?token=synthetic',
  Buffer.from('brain@example.invalid').toString('base64url'),
  Buffer.from('password=DISPLAY_ONLY').toString('base64url'),
  Buffer.from('brain@example.invalid').toString('hex'),
  'brain%40example.invalid', 'x'.repeat(129)
];

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-pi-name-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  const stateDir = path.join(root, 'state');
  const put = (rel, text) => {
    const file = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  put('.agent-brain/tracing.json', JSON.stringify({ schema: 1, enabled: true, captureMode: 'metadata-only' }));
  put('.agent-brain/observability/pi.js', '// runtime discovery sentinel, never executed\n');
  put('.pi/agents/scout.md', 'Synthetic installed role\n');
  put('.pi/agents/backend-engineer.md', 'Synthetic installed role\n');
  const records = [];
  let now = Date.now();
  const clock = () => ++now;
  const make = (env = {}) => {
    const flow = createFlow({ harness: 'pi', cwd, stateDir, env, clock,
      queueObservation: record => { records.push(structuredClone(record)); return { queued: true }; },
      flushOutbox: async () => ({ accepted: 0, queued: 0, failed: 0, status: 'offline' }) });
    const handlers = new Map();
    const pi = { on: (event, fn) => handlers.set(event, fn), registerFlag() {}, getFlag: () => false, registerTool() {} };
    const nativeSessionId = crypto.randomUUID();
    const ctx = { cwd, model: { id: 'test-model', provider: 'test-provider' }, thinkingLevel: 'low',
      isProjectTrusted: () => true, sessionManager: { getSessionId: () => nativeSessionId }, hasUI: false };
    const controller = createController(pi, { flow, clock });
    return { flow, controller, ctx, nativeSessionId,
      emit: (event, data = {}) => handlers.get(event)?.(data, ctx),
      run: () => [...controller.getRoots().values()][0]?.run };
  };
  const disk = dir => fs.readdirSync(dir, { withFileTypes: true }).map(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? disk(file) : `${entry.name}\n${fs.readFileSync(file, 'utf8')}`;
  }).join('\n');
  return { make, records, cwd, stateDir, snapshot: () => `${JSON.stringify(records)}\n${disk(stateDir)}` };
}

async function withMetadata(name, agent, fn) {
  const before = { PI_SUBAGENT_NAME: process.env.PI_SUBAGENT_NAME, PI_SUBAGENT_AGENT: process.env.PI_SUBAGENT_AGENT };
  try {
    for (const [key, value] of Object.entries({ PI_SUBAGENT_NAME: name, PI_SUBAGENT_AGENT: agent })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function start(h) {
  await h.emit('session_start');
  await h.emit('before_agent_start', { messageType: 'user', prompt: 'Synthetic task, not metadata' });
  assert.equal(h.controller.getRoots().size, 1, 'optional UI metadata must not disable actor creation');
}
async function finish(h) {
  await h.emit('before_provider_request');
  await h.emit('message_end', { message: { role: 'assistant', model: 'test-model', stopReason: 'stop', usage: { input: 2, output: 1 } } });
  await h.emit('agent_settled', { aborted: false });
}
function noCaptureFailure(...actors) {
  for (const h of actors) assert.notEqual(h.flow.readState('health')?.captureFailureObserved, true);
}
function omitted(f, name) {
  const snapshot = f.snapshot();
  assert.ok(!snapshot.includes(name), 'unsupported label must not be exported or checkpointed');
  assert.ok(!snapshot.includes(hash(name)), 'unsupported label must not become a hashed identity or key');
}

for (const name of [safeName, ...ds2Names, ...unsafeNames]) {
  test(`Pi real startup captures with optional display name ${JSON.stringify(name)}`, async t => {
    const f = fixture(t);
    const h = f.make();
    await withMetadata(name, 'scout', async () => {
      await start(h);
      assert.equal(process.env.PI_SUBAGENT_NAME, name, 'visible harness name is untouched');
      assert.equal(h.run().agentName, name === safeName ? name : null);
      assert.equal(h.run().persona, 'scout', 'only explicit installed role evidence supplies persona');
      assert.equal(h.run().ticketId, null, 'display ticket is not parsed');
      await finish(h);
    });
    assert.ok(f.records.some(record => record.type === 'AGENT' && record.id === h.run().rootSpanId));
    assert.ok(f.records.some(record => record.type === 'GENERATION'));
    assert.ok(f.records.every(record => record.context.persona === 'scout'));
    if (name !== safeName) {
      omitted(f, name);
      assert.ok(f.records.every(record => !Object.hasOwn(record.context, 'agentName')), 'export projection omits unsupported names entirely');
    } else assert.ok(f.records.some(record => record.context.agentName === name));
    noCaptureFailure(h);
  });
}

for (const { name, startupName } of [
  ...[safeName, ...ds2Names, ...unsafeNames].map(name => ({ name, startupName: name })),
  ...ds2Names.map(name => ({ name, startupName: undefined }))
]) {
  test(`Pi real dispatch/deferred descendant binding survives optional display name ${JSON.stringify(name)}${startupName === undefined ? ' without startup label' : ''}`, async t => {
    const f = fixture(t);
    const parent = f.make();
    await withMetadata(undefined, undefined, async () => {
      await start(parent);
      const result = await parent.controller.getContextTool().execute('context', { persona: 'backend-engineer', ticketId: 'TEST-17' }, undefined, undefined, parent.ctx);
      assert.equal(result.details.ticketId, 'TEST-17');
    });
    const originalParent = parent.run();
    await parent.emit('tool_execution_start', { toolName: 'subagent', toolCallId: 'dispatch', args: { name } });
    const launchId = 'exact-synthetic-child';
    const child = f.make({ PI_SUBAGENT_ID: launchId });
    let descendant;
    await withMetadata(startupName, undefined, async () => {
      await start(child);
      assert.equal(child.run().persona, null, 'name prose is not persona evidence');
      assert.equal(child.flow.resolve(child.run()), null);
      const input = { command: 'true' };
      await child.emit('tool_call', { toolName: 'bash', input });
      const nonce = /^export BRAIN_TRACE_LAUNCH_ID='([a-z0-9_-]{32,128})'/i.exec(input.command)?.[1];
      assert.ok(nonce, 'real tool launch issues an exact descendant capability');
      descendant = f.make({ BRAIN_TRACE_LAUNCH_ID: nonce });
      await start(descendant);
      assert.equal(descendant.flow.resolve(descendant.run()), null, 'descendant cannot escape unresolved ancestry');
      await finish(descendant);
      await finish(child);
    });
    const originalChild = child.run();
    const originalDescendant = descendant.run();
    assert.equal(f.records.length, 0, 'all child/descendant terminal records stay deferred until exact dispatch binding');
    const pendingDir = path.join(f.stateDir, 'adapters/pending');
    const captured = fs.readdirSync(pendingDir).flatMap(file => JSON.parse(fs.readFileSync(path.join(pendingDir, file), 'utf8')).records);
    assert.equal(captured.length, 4, 'both actors retain real root and generation records');
    const details = { id: launchId, name, agent: 'scout', sessionFile: path.join(f.cwd, 'synthetic-child.jsonl'), status: 'started' };
    const unchanged = structuredClone(details);
    await parent.emit('tool_execution_end', { toolName: 'subagent', toolCallId: 'dispatch', isError: false, result: { details } });
    assert.deepEqual(details, unchanged, 'visible dispatch name is untouched');
    const binding = parent.flow.store.resolveLaunch({ launchId });
    assert.ok(binding, 'optional label must not prevent publishing exact native launch alias');
    assert.equal(binding.parent.rootSpanId, originalParent.rootSpanId);
    assert.equal(binding.child.persona, 'scout');
    assert.equal(binding.child.agentName, name === safeName ? name : null);
    assert.equal(parent.flow.store.inspectLaunch({ sessionFile: details.sessionFile }), null, 'transcript file is not rebound as a capability');
    const pendingKey = parent.flow.id(`child-session:${details.sessionFile}`);
    assert.ok([...parent.controller.getRoots().values()][0].pending.has(pendingKey));
    await parent.flow.flush({ timeoutMs: 10000 });
    const resolvedChild = child.flow.resolve(originalChild);
    const resolvedDescendant = descendant.flow.resolve(originalDescendant);
    for (const record of captured) assert.ok(f.records.some(exported => exported.id === record.id && exported.type === record.type), 'deferred observation IDs are unchanged');
    for (const [original, resolved] of [[originalChild, resolvedChild], [originalDescendant, resolvedDescendant]]) {
      assert.ok(resolved);
      for (const key of ['rootSpanId', 'runId', 'nativeSessionId']) assert.equal(resolved[key], original[key], `stable ${key}`);
      assert.equal(resolved.traceId, originalParent.traceId);
      assert.equal(resolved.sessionId, originalParent.sessionId);
      assert.equal(resolved.ticketId, 'TEST-17', 'ticket inherits exactly from actual bound parent, never PROJ-42 display prose');
      assert.equal(resolved.ticketSource, 'explicit');
      assert.ok(f.records.some(record => record.id === original.rootSpanId && record.type === 'AGENT' && record.traceId === originalParent.traceId));
      assert.ok(f.records.some(record => record.type === 'GENERATION' && record.nativeSessionId === original.nativeSessionId));
    }
    assert.equal(resolvedChild.parentSpanId, originalParent.rootSpanId);
    assert.equal(resolvedChild.persona, 'scout', 'explicit details.agent is installed role evidence');
    assert.equal(resolvedDescendant.parentSpanId, originalChild.rootSpanId);
    assert.equal(resolvedDescendant.persona, null, 'no role guessing from display name or parent persona');
    assert.equal(parent.flow.store.claimLaunch({ launchId }, { claimId: `pi:${crypto.randomUUID()}` }), null, 'exact ownership cannot be stolen after binding');
    await parent.emit('message_end', { message: { customType: 'subagent_result', details } });
    assert.equal([...parent.controller.getRoots().values()][0].pending.size, 0);
    if (name !== safeName) omitted(f, name);
    else assert.ok(f.records.some(record => record.context.agentName === name));
    noCaptureFailure(parent, child, descendant);
  });
}

test('unsupported optional role evidence is omitted, not inferred from display names; strict context stays strict', async t => {
  const f = fixture(t);
  for (const agent of ['not-installed', 'scout (role)', 'brain@example.invalid']) {
    const h = f.make();
    await withMetadata(ds2Names[0], agent, async () => { await start(h); await finish(h); });
    assert.equal(h.run().persona, null);
    assert.equal(h.run().agentName, null);
    assert.equal(h.run().ticketId, null);
    await h.emit('tool_execution_start', { toolName: 'subagent_resume', toolCallId: 'resume' });
    const launchId = `resume-${crypto.randomUUID()}`;
    await h.emit('tool_execution_end', { toolCallId: 'resume', result: { details: {
      id: launchId, name: ds2Names[1], agent, sessionFile: path.join(f.cwd, 'shared.jsonl'), status: 'started'
    } } });
    const binding = h.flow.store.resolveLaunch({ launchId });
    assert.ok(binding);
    assert.equal(binding.child.persona, null);
    assert.equal(binding.child.agentName, null);
    omitted(f, agent);
    noCaptureFailure(h);
  }
  assert.ok(f.records.every(record => !Object.hasOwn(record.context, 'persona')));
  const h = f.make();
  assert.throws(() => h.flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID(), agentName: ds2Names[0] }), /Invalid tracing context/);
  await withMetadata(undefined, undefined, () => start(h));
  assert.throws(() => h.flow.store.createLaunch(h.run(), { launchId: 'strict-control', child: { agentName: ds2Names[1] } }), /Invalid tracing context/);
  assert.throws(() => h.flow.update(h.run(), { requestedEffort: 'not a token' }), /Invalid tracing context/);
  noCaptureFailure(h);
});
