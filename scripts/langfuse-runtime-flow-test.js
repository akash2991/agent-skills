'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { createFlow, ADAPTER_LIMITS } = require('../runtime/langfuse/flow.cjs');
const { OUTBOX_LIMITS, queueObservation } = require('../runtime/langfuse/export.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-trace-flow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), stateDir = path.join(root, 'state'); fs.mkdirSync(cwd);
  const records = []; let deliveries = 0;
  const flow = (harness, env = {}) => createFlow({ harness, cwd, stateDir, env, queueObservation: record => records.push(record), flushOutbox: async () => { deliveries++; return { queued: records.length, accepted: 0, failed: 0 }; } });
  return { cwd, stateDir, records, flow, deliveries: () => deliveries };
}
const observation = (flow, run) => ({ id: flow.id(), traceId: run.traceId, parentId: run.rootSpanId, type: 'GENERATION', harness: run.harness, startTime: Date.now(), endTime: Date.now(), model: 'synthetic-model', outcome: 'completed' });

test('late native binding reparents both child and nested cross-harness descendant, never by name', async t => {
  const f = fixture(t); const parentFlow = f.flow('claude');
  const parent = parentFlow.begin({ nativeSessionId: crypto.randomUUID(), cwd: f.cwd });
  const pending = `claude:${parent.nativeSessionId}:exact-agent-id`;
  const nativeFlow = f.flow('claude');
  const child = nativeFlow.begin({ nativeSessionId: crypto.randomUUID(), cwd: f.cwd, parent, pendingIdentity: pending });
  assert.equal(nativeFlow.submit(child, [observation(nativeFlow, child)]).pending, 1);
  const binding = nativeFlow.store.createLaunch(child, { launchId: `brain:pi:${crypto.randomUUID()}`, multiUse: true });
  const piFlow = f.flow('pi', { BRAIN_TRACE_LAUNCH_ID: binding.nonce });
  const grandchild = piFlow.begin({ nativeSessionId: crypto.randomUUID(), cwd: f.cwd });
  assert.equal(piFlow.submit(grandchild, [observation(piFlow, grandchild)]).pending, 1);
  assert.equal(f.records.length, 0, 'no unresolved child may be exported as a guessed/orphan root');
  parentFlow.store.createLaunch(parent, { launchId: pending, multiUse: true });
  await parentFlow.flush();
  assert.equal(f.records.length, 2);
  assert.ok(f.records.every(record => record.traceId === parent.traceId));
  assert.ok(f.records.some(record => record.parentId === child.rootSpanId));
  assert.ok(f.records.some(record => record.parentId === grandchild.rootSpanId));
  assert.equal(f.deliveries(), 1, 'test uses an injected no-network delivery function');
});

test('unresolved native child remains pending and sanitized rather than silently becoming a new trace', async t => {
  const f = fixture(t); const flow = f.flow('pi', { PI_SUBAGENT_ID: 'exact-pending-id', PI_SUBAGENT_SESSION: '/synthetic/exact-session.jsonl' });
  const run = flow.begin({ nativeSessionId: crypto.randomUUID(), cwd: f.cwd });
  const record = { ...observation(flow, run), input: 'CANARY_PRIVATE_PROMPT', output: 'CANARY_PRIVATE_OUTPUT', error: 'CANARY_PRIVATE_ERROR' };
  assert.equal(flow.submit(run, [record]).pending, 1);
  await flow.flush(); assert.equal(f.records.length, 0);
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  for (const file of walk(f.stateDir)) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /CANARY_PRIVATE/);
});

test('ownership checkpoints persist projected handles, not native transcript paths or raw launch labels', async t => {
  const f = fixture(t), flow = f.flow('pi');
  const identity = { launchId: 'private synthetic launch label with spaces', sessionFile: '/synthetic/private session/transcript.jsonl' };
  const run = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID(), pendingIdentity: identity });
  flow.submit(run, [observation(flow, run)]);
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  for (const file of walk(f.stateDir)) {
    const bytes = fs.readFileSync(file, 'utf8');
    assert.ok(!bytes.includes(identity.launchId)); assert.ok(!bytes.includes(identity.sessionFile));
  }
  const parent = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID() });
  flow.store.createLaunch(parent, identity);
  await flow.flush();
  assert.equal(f.records.length, 1); assert.equal(f.records[0].traceId, parent.traceId);
  assert.equal(flow.resolve(run).parentSpanId, parent.rootSpanId);
});

test('pane handoff is scoped to exact native session and pane; acknowledgement is startup only', t => {
  const f = fixture(t); const parentFlow = f.flow('pi');
  const parent = parentFlow.begin({ nativeSessionId: crypto.randomUUID(), cwd: f.cwd });
  const session = crypto.randomUUID(); const binding = parentFlow.store.createLaunch(parent, { launchId: `brain:claude:${session}` });
  parentFlow.writeState(`pane:${binding.nonce}`, { paneId: 'w1:p2', expiresAt: Date.now() + 60000 });
  const wrongPane = f.flow('claude', { BRAIN_TRACE_LAUNCH_ID: binding.nonce, HERDR_PANE_ID: 'w1:p3' });
  const impostor = crypto.randomUUID();
  assert.equal(wrongPane.acknowledgeSession(impostor), false);
  assert.throws(() => wrongPane.begin({ nativeSessionId: impostor, cwd: f.cwd }), /Scoped launch/);
  const childFlow = f.flow('claude', { BRAIN_TRACE_LAUNCH_ID: binding.nonce, HERDR_PANE_ID: 'w1:p2' });
  assert.equal(childFlow.acknowledgeSession(session.toUpperCase()), true);
  const ack = childFlow.readState(`launch-ack:${binding.nonce}`);
  assert.equal(ack.phase, 'adapter-started'); assert.equal(ack.harness, 'claude');
  const child = childFlow.begin({ nativeSessionId: session, cwd: f.cwd });
  assert.equal(child.traceId, parent.traceId); assert.equal(child.parentSpanId, parent.rootSpanId);
  assert.throws(() => childFlow.begin({ nativeSessionId: crypto.randomUUID(), cwd: f.cwd }), /Scoped launch/);
  assert.throws(() => wrongPane.begin({ nativeSessionId: session, cwd: f.cwd }), /Scoped launch/);
});

function diskFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-disk-flow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  const stateDir = path.join(root, 'state'); let now = Date.now();
  const flow = extra => createFlow({ cwd, stateDir, env: {}, clock: () => now,
    // Offline delivery leaves the real on-disk outbox available for assertions.
    flushOutbox: async () => ({ accepted: 0, queued: 0, verified: false }), ...extra });
  const outbox = () => fs.readdirSync(path.join(stateDir, 'outbox')).map(name =>
    JSON.parse(fs.readFileSync(path.join(stateDir, 'outbox', name), 'utf8')).record);
  return { cwd, stateDir, flow, outbox, advance: ms => { now += ms; } };
}

test('late binding persists one valid ticket/provenance pair for finished and continuing children', async t => {
  for (const ownTicket of [undefined, 'TEST-19']) {
    const f = diskFixture(t), parentFlow = f.flow(), childFlow = f.flow();
    const parent = parentFlow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID(), ticketId: 'TEST-17' });
    const finished = childFlow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID(),
      pendingIdentity: 'exact-finished-child', ...(ownTicket ? { ticketId: ownTicket } : {}) });
    assert.equal(childFlow.submit(finished, [{ ...observation(childFlow, finished),
      id: finished.rootSpanId, parentId: null, type: 'AGENT', outcome: 'completed' }]).pending, 1);
    const child = childFlow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID(),
      pendingIdentity: 'exact-delayed-child', ...(ownTicket ? { ticketId: ownTicket } : {}) });
    assert.equal(child.branch, null, 'no branch ticket inference may hide unknown provenance');
    const early = observation(childFlow, child);
    assert.equal(childFlow.submit(child, [early]).pending, 1);
    parentFlow.store.createLaunch(parent, { launchId: 'exact-finished-child', multiUse: true });
    parentFlow.store.createLaunch(parent, { launchId: 'exact-delayed-child', multiUse: true });
    await parentFlow.flush();
    const resumed = f.flow(); // Subsequent completion starts with the canonical durable run.
    const current = resumed.update(child, { observedModel: 'synthetic-model' });
    assert.equal(current.ticketId, ownTicket || 'TEST-17');
    assert.equal(current.ticketSource, 'explicit');
    assert.deepEqual(resumed.store.getRun(current.runId), resumed.readState(`run:${current.rootSpanId}`).run);
    assert.equal(resumed.submit(current, [observation(resumed, current)]).queued, 1);
    assert.equal(f.outbox().length, 3);
    assert.equal(f.outbox().find(record => record.id === finished.rootSpanId).parentId, parent.rootSpanId);
    assert.ok(f.outbox().every(record => record.context.ticketId === (ownTicket || 'TEST-17')
      && record.context.ticketSource === 'explicit' && record.traceId === parent.traceId
      && record.sessionId === parent.sessionId));
  }
});

test('changed late-bound historical turns preserve the active turn and captured generation semantics', async t => {
  for (const resolveFirst of [false, true]) for (const ownFacts of [false, true]) {
    const f = diskFixture(t), flow = f.flow({ harness: ownFacts ? 'claude' : 'pi' });
    const parent = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID(), ticketId: 'TEST-17' });
    const nativeSessionId = crypto.randomUUID();
    let first = flow.begin({ cwd: f.cwd, nativeSessionId, pendingIdentity: 'changed-exact-child',
      requestedModel: 'synthetic/early-model', requestedEffort: 'low',
      ...(ownFacts ? { persona: 'scout', ticketId: 'TEST-19' } : {}) });
    first = flow.update(first, { observedModel: 'synthetic/early-model', observedEffort: 'low',
      evidenceSource: 'native-event', skillsLoaded: ownFacts ? ['early-skill'] : [] });
    const early = { ...observation(flow, first), context: first };
    assert.equal(flow.submit(first, [early]).pending, 1);
    flow.update(first, { requestedModel: 'synthetic/later-model', requestedEffort: 'high',
      observedModel: 'synthetic/later-model', observedEffort: 'high', evidenceSource: 'command',
      skillsLoaded: ['later-skill'], skillsInvoked: ['later-invocation'] });
    const second = flow.begin({ cwd: f.cwd, nativeSessionId });
    const active = () => flow.store.getSession(flow.harness, nativeSessionId).runId;
    assert.equal(active(), second.runId);
    flow.store.createLaunch(parent, { launchId: 'changed-exact-child',
      child: { persona: 'backend-engineer', agentName: 'builder' }, multiUse: true });
    assert.equal(active(), second.runId);
    if (resolveFirst) {
      assert.equal(flow.resolve(first).ticketId, ownFacts ? 'TEST-19' : 'TEST-17');
      assert.equal(active(), second.runId, 'explicit resolution may not select A over B');
    }
    await flow.flush();
    assert.equal(active(), second.runId, 'flush-time resolution may not select A over B');
    assert.equal(flow.store.getRun(first.runId).requestedEffort, 'high');
    assert.equal(flow.store.getRun(first.runId).observedEffort, 'high');
    // The immediate submit path must also honor a supplied capture snapshot,
    // rather than overwrite it with the run's latest resolved metadata.
    const immediate = { ...early, id: flow.id() };
    assert.equal(flow.submit(first, [immediate]).queued, 1);
    assert.equal(active(), second.runId);
    assert.equal(f.outbox().length, 2);
    for (const record of f.outbox()) {
      assert.equal(record.traceId, parent.traceId);
      assert.equal(record.sessionId, parent.sessionId);
      assert.equal(record.parentId, first.rootSpanId);
      assert.equal(record.context.runId, first.runId);
      assert.equal(record.context.parentSessionId, parent.nativeSessionId);
      assert.equal(record.context.ticketId, ownFacts ? 'TEST-19' : 'TEST-17');
      assert.equal(record.context.ticketSource, 'explicit');
      assert.equal(record.context.persona, ownFacts ? 'scout' : 'backend-engineer');
      assert.equal(record.context.agentName, 'builder');
      assert.equal(record.context.requestedModel, 'synthetic/early-model');
      assert.equal(record.context.observedModel, 'synthetic/early-model');
      assert.equal(record.context.requestedEffort, 'low');
      assert.equal(record.context.observedEffort, 'low');
      assert.equal(record.context.evidenceSource, 'native-event');
      assert.deepEqual(record.context.skillsLoaded, ownFacts ? ['early-skill'] : undefined);
      assert.equal(record.context.skillsInvoked, undefined, 'later skill use cannot become earlier evidence');
    }
  }
});

test('legacy checkpoints remain readable and resolving historical turns does not select them as active', t => {
  const f = diskFixture(t), flow = f.flow();
  const parent = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID(), ticketId: 'TEST-17' });
  const nativeSessionId = crypto.randomUUID();
  const first = flow.begin({ cwd: f.cwd, nativeSessionId, parent });
  const legacy = flow.readState(`run:${first.rootSpanId}`);
  fs.writeFileSync(flow.stateFile(`run:${first.rootSpanId}`), JSON.stringify(legacy), { mode: 0o600 });
  const second = flow.begin({ cwd: f.cwd, nativeSessionId, parent });
  assert.equal(flow.resolve(first).rootSpanId, first.rootSpanId);
  assert.equal(flow.store.getSession('pi', nativeSessionId).rootSpanId, second.rootSpanId);
  assert.equal(flow.readState(`run:${first.rootSpanId}`).run.ticketSource, 'explicit');
});

test('deferred suffix advances durably after queue capacity and a thrown interrupted transfer', async t => {
  const f = diskFixture(t); let flow = f.flow();
  const run = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID() });
  const records = Array.from({ length: 600 }, () => observation(flow, run));
  assert.deepEqual(flow.submit(run, records), { queued: OUTBOX_LIMITS.records, pending: 600 - OUTBOX_LIMITS.records });
  const pendingDir = path.join(f.stateDir, 'adapters', 'pending');
  const received = new Set();
  const acknowledgeDisk = () => {
    for (const record of f.outbox()) received.add(record.id);
    for (const name of fs.readdirSync(path.join(f.stateDir, 'outbox'))) fs.unlinkSync(path.join(f.stateDir, 'outbox', name));
  };
  acknowledgeDisk();
  let queued = 0;
  flow = f.flow({ queueObservation: (record, opts) => {
    if (++queued === 18) throw new Error('synthetic transfer interruption');
    return queueObservation(record, opts);
  } });
  await flow.flush({ timeoutMs: 10000 });
  const suffix = JSON.parse(fs.readFileSync(path.join(pendingDir, fs.readdirSync(pendingDir)[0]), 'utf8'));
  assert.equal(suffix.records.length, 600 - OUTBOX_LIMITS.records - 17);
  assert.equal(suffix.records[0].id, records[OUTBOX_LIMITS.records + 17].id);
  // Simulate death after the claim was written, before its final rename.
  const pending = fs.readdirSync(pendingDir)[0];
  fs.renameSync(path.join(pendingDir, pending), path.join(pendingDir, `${pending}.${crypto.randomUUID()}.claim`));
  // Fsync and process-identity lookups are real work; allow bounded additional
  // passes on loaded CI rather than assuming 600 durable writes fit five slices.
  for (let pass = 0; pass < 20 && fs.readdirSync(pendingDir).length; pass++) {
    acknowledgeDisk(); flow = f.flow(); await flow.flush({ timeoutMs: 10000 });
  }
  acknowledgeDisk();
  assert.equal(received.size, 600);
  assert.equal(fs.readdirSync(pendingDir).length, 0);
});

test('unticketed legacy pending payloads remain intact with explicit blocked-replay health', async t => {
  const f = diskFixture(t); let flow = f.flow();
  const run = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID(), pendingIdentity: 'legacy-exact-child' });
  flow.submit(run, [observation(flow, run)]);
  const pendingDir = path.join(f.stateDir, 'adapters', 'pending');
  const file = path.join(pendingDir, fs.readdirSync(pendingDir)[0]);
  const batch = JSON.parse(fs.readFileSync(file, 'utf8')); delete batch.revisions;
  fs.writeFileSync(file, JSON.stringify(batch));
  const before = fs.readFileSync(file, 'utf8');
  f.advance(ADAPTER_LIMITS.retentionMs + 1);
  flow = f.flow(); await flow.flush();
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'unprovable capture order cannot authorize a send or data deletion');
  assert.deepEqual(flow.readState('health'), { replayBlocked: true, reason: 'pending_revision_missing' });
});

test('slow deferred enqueue leaves egress time and an exact durable suffix across restart', async t => {
  const f = diskFixture(t); let flow = f.flow();
  const parent = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID(), ticketId: 'TEST-17' });
  const run = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID(), pendingIdentity: 'slow-exact-child' });
  const records = Array.from({ length: 80 }, () => observation(flow, run));
  flow.submit(run, records);
  // A second real deferred batch verifies the budget stops the outer walk too.
  const later = observation(flow, run);
  flow.submit(run, [later]);
  flow.store.createLaunch(parent, { launchId: 'slow-exact-child', multiUse: true });
  const pendingDir = path.join(f.stateDir, 'adapters', 'pending');
  const expected = new Set([...records, later].map(record => record.id));
  let expiredEnqueues = 0;
  const zeroBudget = f.flow({ queueObservation: () => { expiredEnqueues++; return { queued: false }; },
    flushOutbox: async () => assert.fail('expired flush must not deliver') });
  assert.equal((await zeroBudget.flush({ timeoutMs: 0 })).status, 'timeout');
  assert.equal(fs.readdirSync(pendingDir).length, 2);
  let calls = 0, remaining, elapsedAtDelivery;
  flow = f.flow({ queueObservation: (record, opts) => {
    calls++;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
    return queueObservation(record, opts);
  }, flushOutbox: async opts => {
    remaining = opts.timeoutMs; elapsedAtDelivery = Date.now() - started;
    return { queued: f.outbox().length, accepted: 0, verified: false };
  } });
  const started = Date.now();
  const result = await flow.flush({ timeoutMs: 1000 });
  assert.ok(calls > 0 && calls < expected.size, 'transfer must make bounded progress');
  assert.ok(remaining > 100 && elapsedAtDelivery < 900, 'egress receives usable deadline budget');
  assert.ok(result.deferred > 0);
  const transferred = new Set(f.outbox().map(record => record.id));
  const retained = fs.readdirSync(pendingDir).flatMap(name =>
    JSON.parse(fs.readFileSync(path.join(pendingDir, name), 'utf8')).records.map(record => record.id));
  assert.equal(retained.length, expected.size - calls);
  assert.deepEqual(new Set([...transferred, ...retained]), expected);
  assert.ok(retained.every(id => !transferred.has(id)), 'only the untransferred suffix remains durable');
  assert.ok(fs.readdirSync(pendingDir).every(name => name.endsWith('.json')), 'deadline leaves no live claim');
  await f.flow().flush({ timeoutMs: 10000 });
  assert.equal(fs.readdirSync(pendingDir).length, 0);
  const queued = f.outbox();
  assert.deepEqual(new Set(queued.map(record => record.id)), expected);
  assert.equal(queued.length, expected.size, 'budget retries must not replay the committed prefix');
  assert.equal(expiredEnqueues, 0, 'expired transfer must not enqueue');
});

test('process death between enqueue and suffix persistence replays only the crash-boundary ID', async t => {
  const f = diskFixture(t), flow = f.flow();
  const parent = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID() });
  const run = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID(), pendingIdentity: 'crash-exact-child' });
  const records = Array.from({ length: 20 }, () => observation(flow, run));
  flow.submit(run, records);
  flow.store.createLaunch(parent, { launchId: 'crash-exact-child', multiUse: true });
  const script = `
    const {createFlow}=require(${JSON.stringify(require.resolve('../runtime/langfuse/flow.cjs'))});
    const {queueObservation}=require(${JSON.stringify(require.resolve('../runtime/langfuse/export.cjs'))});
    let count=0;
    createFlow({stateDir:${JSON.stringify(f.stateDir)},env:{},queueObservation:(record,opts)=>{
      const result=queueObservation(record,opts);
      if(result.queued && ++count===7) process.exit(23);
      return result;
    },flushOutbox:async()=>({accepted:0})}).flush();
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH } });
  assert.equal(child.status, 23, child.stderr);
  assert.equal(f.outbox().length, 7);
  await f.flow().flush();
  const queued = f.outbox();
  assert.equal(new Set(queued.map(record => record.id)).size, records.length);
  assert.equal(queued.length, records.length + 1, 'at-least-once replay is confined to the enqueue/checkpoint crash boundary');
  assert.equal(fs.readdirSync(path.join(f.stateDir, 'adapters', 'pending')).length, 0);
});

test('aggregate checkpoint file and byte limits refuse safely, then reclaim expired state', async t => {
  const f = diskFixture(t); let flow = f.flow();
  const usage = () => {
    const dir = path.join(f.stateDir, 'adapters');
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.json'));
    return { files: files.length, bytes: files.reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0) };
  };
  // Prefill a restart fixture with valid private checkpoints, then exercise
  // real flow admission against directory usage, not ContextStore's own caps.
  flow.writeState('checkpoint:0', { completedAt: 0 });
  for (let i = 1; i < ADAPTER_LIMITS.files - 4; i++) fs.copyFileSync(flow.stateFile('checkpoint:0'), flow.stateFile(`checkpoint:${i}`));
  flow = f.flow();
  flow.writeState(`checkpoint:${ADAPTER_LIMITS.files - 4}`, { completedAt: 1 });
  assert.throws(() => flow.writeState('over-file-limit', { completedAt: 1 }), /capacity/);
  flow.writeState('health', { captureFailureObserved: true });
  flow.writeState('delivery', { verified: false });
  flow.writeState('checkpoint:0', { completedAt: 2 });
  assert.ok(usage().files <= ADAPTER_LIMITS.files);
  f.advance(ADAPTER_LIMITS.retentionMs + 1); flow = f.flow();
  // A bounded flush may spend its whole slice scanning under load. Zero is a
  // deterministic exhausted slice: it must not reclaim or pretend to finish.
  await flow.flush({ timeoutMs: 0 });
  assert.deepEqual(flow.readState('checkpoint:0'), { completedAt: 2 });
  // Capacity admission uses the real collector without a transfer deadline.
  // Force pressure at the known full directory, proving eventual reclamation
  // rather than assuming 2048 filesystem entries fit one timed flush slice.
  flow.writeState('reclaimed-file-slot', { completedAt: 3 });
  assert.equal(flow.readState('checkpoint:0'), null);
  assert.deepEqual(flow.readState('health'), { captureFailureObserved: true }, 'loss diagnostics must not expire with ordinary checkpoints');
  assert.ok(usage().files <= 3);
  assert.deepEqual(flow.readState('reclaimed-file-slot'), { completedAt: 3 });
  const block = Array(110).fill('a'.repeat(8192));
  for (let i = 0; i < 36; i++) flow.writeState(`large:${i}`, { counters: block });
  assert.throws(() => flow.writeState('over-byte-limit', { counters: block }), /capacity/);
  assert.ok(usage().bytes <= ADAPTER_LIMITS.bytes);
  f.advance(ADAPTER_LIMITS.retentionMs + 1); flow = f.flow();
  await flow.flush({ timeoutMs: 0 });
  assert.ok(flow.readState('large:0'));
  flow.writeState('reclaimed-byte-slot', { counters: block });
  assert.equal(flow.readState('large:0'), null);
  assert.deepEqual(flow.readState('reclaimed-byte-slot'), { counters: block });
  assert.ok(usage().bytes < 1024 * 1024, 'only the new admitted block and diagnostics remain');
});

test('checkpoint expiry preserves live sessions, unresolved descendants and outbox replay dependencies', async t => {
  const f = diskFixture(t); let flow = f.flow();
  const expired = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID() });
  flow.writeState('expired-generation', { id: flow.id(), usage: { input: 1 } });
  const live = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID() });
  flow.writeState('live-tool', { id: flow.id(), toolName: 'Read' });
  const capability = flow.createToolLaunch(live);
  const unresolved = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID(), pendingIdentity: 'exact-unresolved' });
  flow.writeState('unresolved-generation', { id: flow.id() });
  const lateToolActor = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID() });
  const ancestor = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID() });
  flow.writeState('ancestor-generation', { id: flow.id() });
  const deferredDescendant = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID(), parent: ancestor });
  const replay = flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID() });
  flow.writeState('replay-generation', { id: flow.id() });
  flow.submit(replay, [observation(flow, replay)]);
  f.advance(ADAPTER_LIMITS.retentionMs - 1000);
  flow.update(live, { observedModel: 'synthetic-model' });
  flow.resolve(lateToolActor);
  flow.writeState('recent-tool-reference', { id: flow.id(), caller: { rootSpanId: lateToolActor.rootSpanId } });
  flow.submit(unresolved, [observation(flow, unresolved)]); // New deferred dependency on an older run.
  flow.remember(deferredDescendant, { pendingIdentity: 'exact-new-pause' });
  flow.submit(deferredDescendant, [observation(flow, deferredDescendant)]);
  f.advance(2000); flow = f.flow(); await flow.flush();
  assert.equal(flow.store.getRun(expired.runId), null);
  assert.equal(flow.readState(`run:${expired.rootSpanId}`), null);
  assert.equal(flow.readState('expired-generation'), null);
  assert.ok(flow.readState('live-tool'));
  assert.ok(flow.readState('unresolved-generation'));
  assert.ok(flow.readState('replay-generation'));
  assert.ok(flow.readState(`run:${unresolved.rootSpanId}`));
  assert.ok(flow.readState(`run:${replay.rootSpanId}`));
  assert.ok(flow.readState(`run:${ancestor.rootSpanId}`), 'deferred descendants pin expired exact ancestors');
  assert.ok(flow.readState('ancestor-generation'));
  assert.equal(flow.store.getRun(lateToolActor.runId), null);
  assert.ok(flow.readState(`run:${lateToolActor.rootSpanId}`), 'recent tool checkpoints pin actors beyond ContextStore TTL');
  // An expired capability cannot become usable because its checkpoint survives.
  assert.equal(flow.actorForTool(capability.nonce), null);
  assert.equal(flow.resolve(unresolved), null);
  assert.equal(f.outbox().length, 1);
});
