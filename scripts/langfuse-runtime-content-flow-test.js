'use strict';

// Synthetic private temporary stores only. No activation, native harness, auth,
// model calls, installs or network; the installed SDK uses an in-process sink.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createFlow, safeState, ADAPTER_LIMITS } = require('../runtime/langfuse/flow.cjs');
const { sanitizeObservation, configurePrivacy, CONTENT_LIMITS } = require('../runtime/langfuse/privacy.cjs');
const { queueObservation, flushOutbox } = require('../runtime/langfuse/export.cjs');
const bootstrap = require('../runtime/langfuse/bootstrap.js');
const dependencyRoot = require('./lib/langfuse-test-dependencies.js').testDependencyRoot();
const FULL = Object.freeze({ schema: 2, enabled: true, captureMode: 'full-content', capturePolicyVersion: 1,
  redactionPolicyVersion: 1, pii: 'retain', durableRetry: true });
const META = { schema: 1, enabled: true, captureMode: 'metadata-only' };
const PII = { email: 'person@example.invalid', ssn: '123-45-6789', name: 'Zoë 王 😀',
  url: 'https://example.invalid/person?id=17', phone: '415-555-2671' };
const SECRET = 'sk-proj-SYNTHETIC_FLOW_TOKEN';
const LITERAL = 'opaque-SYNTHETIC-flow-literal';
const payload = () => ({ ...PII, text: `hello\n${SECRET}`, token: 'SYNTHETIC_TOKEN_VALUE', literal: LITERAL,
  args: [{ prompt: PII.email, content: [null, '', false, 0], authorization: 'Bearer SYNTHETIC_BEARER' }] });
function marker(cwd, policy) {
  fs.mkdirSync(path.join(cwd, '.agent-brain/observability'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.agent-brain/observability/pi.js'), 'throw new Error("NO_PROJECT_CODE");');
  const file = path.join(cwd, '.agent-brain/tracing.json');
  if (policy === undefined) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, typeof policy === 'string' ? policy : JSON.stringify(policy));
  return file;
}
function fixture(t, policy = FULL) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'brain-content-flow-'));
  t.after(() => { configurePrivacy(); fs.rmSync(root, { recursive: true, force: true }); });
  const cwd = path.join(root, 'project'), stateDir = path.join(root, 'state'); fs.mkdirSync(cwd);
  marker(cwd, policy);
  const flow = extra => createFlow({ cwd, stateDir, env: {},
    flushOutbox: async () => ({ queued: 0, accepted: 0, failed: 0, verified: false }), ...extra });
  const pendingDir = path.join(stateDir, 'adapters/pending');
  const pending = () => fs.readdirSync(pendingDir).map(name => ({ file: path.join(pendingDir, name),
    batch: JSON.parse(fs.readFileSync(path.join(pendingDir, name), 'utf8')) }));
  const outbox = () => fs.readdirSync(path.join(stateDir, 'outbox')).filter(name => name.endsWith('.json'))
    .map(name => ({ file: path.join(stateDir, 'outbox', name), envelope: JSON.parse(fs.readFileSync(path.join(stateDir, 'outbox', name), 'utf8')) }));
  const begin = (flow, extra = {}) => flow.begin({ cwd, nativeSessionId: crypto.randomUUID(), ...extra });
  return { root, cwd, stateDir, flow, begin, pendingDir, pending, outbox };
}
const observation = (flow, run, extra = {}) => ({ id: flow.id(), parentId: run.rootSpanId, type: 'GENERATION',
  startTime: 1700000000000, endTime: 1700000001000, outcome: 'completed', model: 'synthetic-early', context: run, ...extra });
const contentRecord = (flow, run, extra = {}) => observation(flow, run, { content: flow.createContent({ input: payload(), output: payload() }), ...extra });
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
function noSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [SECRET, LITERAL, 'SYNTHETIC_TOKEN_VALUE', 'SYNTHETIC_BEARER']) assert.ok(!text.includes(secret), secret);
}
function checkDisk(f) {
  for (const file of walk(f.stateDir)) {
    noSecrets(fs.readFileSync(file, 'utf8'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, file);
  }
}
function checkPII(content) {
  for (const [key, value] of Object.entries(PII)) assert.equal(content.input.value[key], value);
  assert.equal(content.input.status, 'credential_redacted');
  assert.deepEqual(content.input.value.args[0].content, [null, '', false, 0]);
}
const sink = seen => () => ({ export(spans, callback) { seen.push(...spans); callback({ code: 0 }); }, async shutdown() {} });
const ack = (f, seen = []) => flushOutbox({ stateDir: f.stateDir, env: {}, dependencyRoot, exporterFactory: sink(seen), timeoutMs: 10000 });

test('flow forwards per-capture runtime literals without global reconfiguration; metadata mode reads neither body nor options', t => {
  const f = fixture(t), flow = f.flow(), nonce = 'SYNTHETIC_FLOW_CAPABILITY_'.repeat(2);
  configurePrivacy({ sensitiveLiterals: [LITERAL] });
  const envelope = flow.createContent({ input: { echo: nonce, pii: PII, literal: LITERAL } }, { additionalSensitiveLiterals: [nonce] });
  assert.equal(envelope.input.status, 'credential_redacted'); assert.equal(envelope.input.value.echo, '[REDACTED]');
  assert.deepEqual(envelope.input.value.pii, PII); assert.equal(envelope.input.value.literal, '[REDACTED]');
  assert.equal(flow.createContent({ input: nonce }).input.value, nonce);
  const getter = {}; Object.defineProperty(getter, 'additionalSensitiveLiterals', { get() { assert.fail('option getter'); } });
  assert.equal(flow.createContent({ input: PII }, getter).input.status, 'unsupported');
  const bomb = new Proxy({}, { getOwnPropertyDescriptor() { assert.fail('metadata body/options access'); }, ownKeys() { assert.fail('metadata options access'); } });
  marker(f.cwd, META);
  assert.equal(flow.createContent(bomb, bomb), undefined);
});

test('dispatch handoff uses parent original grant after downgrade, typed child ownership/revision and no child-body consent', t => {
  const f = fixture(t), flow = f.flow(), parent = f.begin(flow), key = 'synthetic-dispatch';
  configurePrivacy({ sensitiveLiterals: [LITERAL] });
  const source = flow.captureObservation(parent, observation(flow, parent, { type: 'TOOL', toolName: 'subagent',
    content: flow.createContent({ input: payload(), output: { actualResult: PII } }) }));
  flow.writeObservation(key, source);
  const identity = { launchId: 'native-metadata-child' };
  flow.store.createLaunch(parent, identity);
  marker(f.cwd, META);
  const childFlow = f.flow({ env: { PI_SUBAGENT_ID: identity.launchId } }), child = f.begin(childFlow);
  assert.equal(childFlow.captureMode(), 'metadata-only');
  const body = {}; Object.defineProperty(body, 'input', { get() { assert.fail('child body consent widened'); } });
  assert.equal(childFlow.createContent(body), undefined);
  const result = childFlow.closeDispatchObservation(key, identity); assert.equal(result.queued, 1);
  assert.equal(flow.readObservation(key), null);
  const queued = f.outbox()[0].envelope;
  assert.equal(queued.record.type, 'SPAN'); assert.equal(queued.record.parentId, child.rootSpanId);
  assert.equal(queued.record.nativeSessionId, child.nativeSessionId); assert.equal(queued.record.context.runId, child.runId);
  assert.ok(Number.isSafeInteger(queued.revision)); assert.deepEqual(queued.record.content, source.record.content);
  assert.equal(childFlow.createContent(body), undefined); checkDisk(f);
});

test('dispatch exact-binding helper refuses guessed parent edges, wrong parent, multi-use and ambiguous native publications', t => {
  const f = fixture(t), flow = f.flow(), parent = f.begin(flow), key = 'unproven-dispatch';
  const source = flow.captureObservation(parent, observation(flow, parent, { type: 'TOOL', toolName: 'subagent',
    content: flow.createContent({ input: PII, output: { actual: true } }) }));
  flow.writeObservation(key, source);
  f.begin(flow, { parent }); // A parent edge alone is not exact launch proof.
  for (const identity of [{ launchId: 'no-native-child' }, { launchId: 'multi-use' }, { launchId: 'wrong-parent' }, { launchId: 'ambiguous' }]) {
    const wrongParent = identity.launchId === 'wrong-parent' ? f.begin(flow) : parent;
    flow.store.createLaunch(wrongParent, { ...identity, ...(identity.launchId === 'multi-use' ? { multiUse: true } : {}) });
    if (identity.launchId !== 'no-native-child') {
      const cf = f.flow({ env: { PI_SUBAGENT_ID: identity.launchId } }), c = f.begin(cf);
      if (identity.launchId === 'ambiguous') f.begin(cf, { nativeSessionId: c.nativeSessionId });
    }
    const result = flow.closeDispatchObservation(key, identity);
    assert.equal(result.unsupported, true, identity.launchId);
    assert.deepEqual(flow.readObservation(key), source);
  }
  assert.equal(f.outbox().length, 0); checkDisk(f);
});

test('schema-2 consent requires every versioned fact; shared discovery preserves old API tri-state', t => {
  const f = fixture(t), entry = path.join(f.cwd, '.agent-brain/observability/pi.js');
  assert.equal(bootstrap.findPolicySync(f.cwd), entry);
  assert.equal(bootstrap.findRuntimeSync(f.cwd), entry);
  assert.deepEqual(bootstrap.findCapturePolicySync(f.cwd), FULL);
  assert.equal(f.flow().captureMode(), 'full-content');
  for (const key of Object.keys(FULL)) {
    const missing = { ...FULL }; delete missing[key]; marker(f.cwd, missing);
    assert.equal(bootstrap.findPolicySync(f.cwd), null, key);
    assert.equal(bootstrap.findCapturePolicySync(f.cwd), null, key);
    assert.equal(f.flow().captureMode(), 'disabled', key);
  }
  for (const malformed of ['null', '{', { ...FULL, pii: 'redact' }, { ...FULL, durableRetry: false },
    { ...FULL, capturePolicyVersion: 2 }, { ...FULL, redactionPolicyVersion: 2 }, { ...FULL, enabled: false },
    { ...FULL, runtime: '../escape' }, { ...META, captureMode: 'full-content' }, { ...FULL, captureMode: 'metadata-only' }]) {
    marker(f.cwd, malformed);
    assert.equal(bootstrap.findCapturePolicySync(f.cwd), null);
    assert.equal(bootstrap.findRuntimeSync(f.cwd), null);
  }
  marker(f.cwd, META);
  assert.deepEqual(bootstrap.findCapturePolicySync(f.cwd), META);
  assert.equal(f.flow().captureMode(), 'metadata-only');
  marker(f.cwd, undefined); fs.mkdirSync(path.join(f.cwd, '.git'));
  assert.equal(bootstrap.findPolicySync(f.cwd), undefined);
  assert.equal(bootstrap.findCapturePolicySync(f.cwd), undefined);
  assert.equal(f.flow({ perRun: true }).captureMode(), 'metadata-only');
  assert.equal(f.flow({ capturePolicy: 'full-content' }).captureMode(), 'metadata-only', 'a label is not consent');
  assert.equal(f.flow({ capturePolicy: { captureMode: 'full-content' } }).captureMode(), 'metadata-only');
  assert.equal(f.flow({ capturePolicy: FULL }).captureMode(), 'full-content', 'explicit typed injection seam');
});

test('full-content discovery retains Git/principal boundaries, explicit refusals, trust and FIFO safety', t => {
  const f = fixture(t), child = path.join(f.root, 'child'); fs.mkdirSync(child);
  const gitdir = path.join(f.cwd, '.git/worktrees/child'); fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(child, '.git'), `gitdir: ${gitdir}\n`);
  assert.deepEqual(bootstrap.findCapturePolicySync(child), FULL);
  assert.equal(bootstrap.isTracingAllowed({ cwd: child, isProjectTrusted: () => false }), false);
  const file = marker(child, { ...FULL, enabled: false });
  assert.equal(bootstrap.findCapturePolicySync(child), null, 'no principal fallback on refusal');
  fs.writeFileSync(file, '{'); assert.equal(bootstrap.findCapturePolicySync(child), null);
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(f.cwd, '.agent-brain/tracing.json'), file);
  assert.equal(bootstrap.findCapturePolicySync(child), null, 'no-follow declaration read');
  fs.unlinkSync(file);
  const fifo = spawnSync('mkfifo', [file], { encoding: 'utf8', timeout: 5000 }); assert.equal(fifo.status, 0, fifo.stderr);
  const before = Date.now(); assert.equal(bootstrap.findCapturePolicySync(child), null);
  assert.ok(Date.now() - before < 1000, 'FIFO declaration cannot block'); fs.unlinkSync(file);
  fs.unlinkSync(path.join(child, '.git')); fs.mkdirSync(path.join(child, '.git'));
  assert.equal(bootstrap.findCapturePolicySync(child), undefined, 'normal Git boundary stops parent search');
  for (const key of ['BRAIN_TRACING_ENABLED', 'LANGFUSE_TRACING_ENABLED']) {
    const flow = f.flow({ env: { [key]: '0' } });
    assert.equal(flow.captureMode(), 'disabled'); assert.equal(flow.createContent({ input: payload() }), undefined);
  }
});

test('default metadata never reads native bodies and generic state remains strict under either policy', t => {
  for (const policy of [META, undefined]) {
    const f = fixture(t, policy || META);
    if (policy === undefined) marker(f.cwd, undefined);
    const flow = f.flow(), run = f.begin(flow);
    let reads = 0;
    const body = {}; Object.defineProperty(body, 'input', { get() { reads++; assert.fail('body getter'); } });
    assert.equal(flow.createContent(body), undefined);
    const record = observation(flow, run);
    for (const field of ['input', 'output', 'content']) Object.defineProperty(record, field,
      { enumerable: true, get() { reads++; assert.fail('native body getter'); } });
    assert.equal(flow.submit(run, [record]).queued, 1);
    const capture = flow.captureObservation(run, record);
    assert.equal(capture.record.content, undefined); assert.equal(reads, 0);
    assert.equal(f.outbox()[0].envelope.schema, 2);
    assert.throws(() => flow.writeState('raw', { content: payload() }), /Raw tracing payload/);
    assert.throws(() => flow.writeState('raw', { args: {} }), /Raw tracing payload/);
    assert.throws(() => flow.writeState('raw', { label: PII.email }), /Sensitive/);
    assert.throws(() => flow.writeState('raw', { label: 'x'.repeat(8193) }), /Sensitive/);
  }
  const f = fixture(t), flow = f.flow(), run = f.begin(flow), capture = flow.captureObservation(run, contentRecord(flow, run));
  assert.throws(() => safeState(capture), /Raw tracing payload/);
  assert.throws(() => flow.writeState('typed-through-generic', capture), /Raw tracing payload/);
  assert.throws(() => flow.writeObservation('invented', JSON.parse(JSON.stringify(capture))), /Use captureObservation/);
});

test('typed whole-observation checkpoints project before disk, retain PII and restart under original grant/identity', async t => {
  const f = fixture(t); configurePrivacy({ sensitiveLiterals: [LITERAL] });
  let flow = f.flow(); const run = f.begin(flow), key = 'open-generation';
  const raw = payload();
  const record = observation(flow, run, { content: { version: 1, captureMode: 'full-content', redactionPolicyVersion: 1,
    input: { status: 'captured', value: raw }, output: { status: 'unavailable' } } });
  const open = flow.captureObservation(run, record);
  noSecrets(open); checkPII(open.record.content);
  raw.email = 'changed@example.invalid';
  assert.equal(open.record.content.input.value.email, PII.email, 'capture is a detached snapshot');
  assert.throws(() => { open.record.content.input.value.email = 'mutated'; }, TypeError);
  flow.writeObservation(key, open); checkDisk(f);
  assert.equal(flow.readState(key), null, 'generic reader cannot infer/promote a content checkpoint');
  const disk = JSON.parse(fs.readFileSync(flow.stateFile(key), 'utf8'));
  assert.equal(disk.checkpointVersion, 2); assert.equal(disk.ownerRoot, run.rootSpanId);
  assert.equal(disk.state.revision, open.revision); assert.deepEqual(disk.state.captureGrant, FULL);
  const later = f.begin(flow);
  assert.notEqual(later.runId, run.runId);
  assert.throws(() => flow.writeObservation(key, flow.captureObservation(later, contentRecord(flow, later))), /identity mismatch/);
  // Marker removal stops NEW content capture, not durable retries under the
  // original capture grant. No old native transcripts are read or backfilled.
  marker(f.cwd, undefined); flow = f.flow();
  const recovered = flow.readObservation(key);
  assert.deepEqual(recovered, open); assert.equal(flow.captureMode(), 'metadata-only');
  const seen = [];
  assert.equal(flow.closeObservation(key).queued, 1);
  assert.equal(flow.readObservation(key), null);
  const queued = f.outbox()[0].envelope;
  assert.equal(queued.schema, 3); assert.equal(queued.revision, open.revision);
  assert.equal(queued.record.context.runId, run.runId); assert.equal(queued.record.parentId, run.rootSpanId);
  assert.equal(queued.record.id, open.record.id); assert.deepEqual(queued.record.content, open.record.content);
  const result = await ack(f, seen); assert.equal(result.accepted, 1); assert.equal(result.verified, false);
  noSecrets(seen[0].attributes);
  assert.deepEqual(JSON.parse(seen[0].attributes['langfuse.observation.input']), open.record.content.input.value);
  checkDisk(f);
  const context = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'context-v1.json'), 'utf8'));
  assert.ok(!JSON.stringify(context).includes(PII.email), 'ContextStore stays metadata-only');
});

test('completion is a new capture revision; obsolete checkpoints and policy downgrades cannot overwrite it', t => {
  const f = fixture(t), flow = f.flow(), run = f.begin(flow), key = 'open-tool';
  const root = flow.captureObservation(run, contentRecord(flow, run, { id: run.rootSpanId, type: 'AGENT', parentId: undefined }));
  assert.equal(root.record.parentId, null, 'root edge is run-owned even when omitted by callers');
  const initial = contentRecord(flow, run, { type: 'TOOL', toolName: 'Read' });
  const first = flow.captureObservation(run, initial); flow.writeObservation(key, first);
  const next = flow.captureObservation(run, { ...initial, endTime: initial.endTime + 1,
    content: { ...first.record.content, output: flow.createContent({ output: { answer: PII.email } }).output } });
  flow.writeObservation(key, next);
  assert.ok(next.revision > first.revision); assert.deepEqual(flow.readObservation(key), next);
  assert.throws(() => flow.writeObservation(key, first), /Obsolete/);
  marker(f.cwd, META);
  const metadata = flow.captureObservation(run, { ...initial, endTime: next.record.endTime });
  assert.throws(() => flow.writeObservation(key, metadata), /policy cannot change/);
  assert.equal(flow.closeObservation(key).queued, 1);
  const stored = f.outbox()[0].envelope;
  assert.equal(stored.revision, next.revision); assert.deepEqual(stored.record.content, next.record.content);
});

test('unresolved exact bindings and descendants retain capture facts, content and tickets through rebase/restart', async t => {
  const f = fixture(t); configurePrivacy({ sensitiveLiterals: [LITERAL] });
  const parentFlow = f.flow({ harness: 'claude' }), parent = f.begin(parentFlow, { ticketId: 'TEST-17' });
  const childFlow = f.flow({ harness: 'claude' });
  let child = f.begin(childFlow, { pendingIdentity: 'exact-content-child', requestedModel: 'early-model', requestedEffort: 'low' });
  child = childFlow.update(child, { skillsLoaded: ['early-skill'], evidenceSource: 'native-event' });
  const childCapture = childFlow.captureObservation(child, contentRecord(childFlow, child));
  childFlow.writeObservation('child-open', childCapture);
  assert.equal(childFlow.closeObservation('child-open').pending, 1);
  const binding = childFlow.store.createLaunch(child, { launchId: 'exact-descendant', multiUse: true });
  const grandFlow = f.flow({ harness: 'pi', env: { BRAIN_TRACE_LAUNCH_ID: binding.nonce } });
  const grand = f.begin(grandFlow), grandCapture = grandFlow.captureObservation(grand, contentRecord(grandFlow, grand));
  assert.equal(grandFlow.submitCaptured([grandCapture]).pending, 1);
  assert.equal(f.outbox().length, 0); checkDisk(f);
  const originalTickets = new Map(f.pending().flatMap(({ batch }) => batch.records.map((record, i) => [record.id, batch.revisions[i]])));
  for (const { batch } of f.pending()) {
    assert.equal(batch.pendingVersion, 2); assert.deepEqual(batch.captureGrants, [FULL]); checkPII(batch.records[0].content);
  }
  childFlow.update(child, { requestedModel: 'later-model', requestedEffort: 'high', skillsLoaded: ['later-skill'] });
  parentFlow.store.createLaunch(parent, { launchId: 'exact-content-child', multiUse: true,
    child: { persona: 'backend-engineer', agentName: 'builder' } });
  marker(f.cwd, META); await f.flow().flush({ timeoutMs: 10000 });
  assert.equal(f.pending().length, 0);
  const queued = f.outbox().map(item => item.envelope); assert.equal(queued.length, 2);
  for (const envelope of queued) {
    const source = envelope.record.id === childCapture.record.id ? childCapture : grandCapture;
    assert.equal(envelope.revision, originalTickets.get(source.record.id));
    assert.equal(envelope.record.traceId, parent.traceId); assert.equal(envelope.record.sessionId, parent.sessionId);
    assert.equal(envelope.record.parentId, source.owner.rootSpanId);
    assert.equal(envelope.record.context.runId, source.owner.runId);
    assert.deepEqual(envelope.record.content, source.record.content);
  }
  const early = queued.find(item => item.record.id === childCapture.record.id).record;
  assert.equal(early.model, 'synthetic-early'); assert.equal(early.context.requestedModel, 'early-model');
  assert.equal(early.context.requestedEffort, 'low'); assert.deepEqual(early.context.skillsLoaded, ['early-skill']);
  assert.equal(early.context.ticketId, 'TEST-17'); assert.equal(early.context.persona, 'backend-engineer');
  checkDisk(f);
});

test('exact serialized pending packing splits near-cap records with grant overhead and preserves refused suffix', async t => {
  const f = fixture(t), flow = f.flow(), parent = f.begin(flow);
  const child = f.begin(flow, { pendingIdentity: 'exact-large-child' });
  const base = observation(flow, child, { traceId: child.traceId, sessionId: child.sessionId,
    nativeSessionId: child.nativeSessionId, content: flow.createContent({ input: '' }) });
  const overhead = Buffer.byteLength(JSON.stringify(sanitizeObservation(base)));
  const target = CONTENT_LIMITS.recordBytes - 8;
  const content = flow.createContent({ input: 'é'.repeat(Math.floor((target - overhead) / 2)) });
  const records = Array.from({ length: 10 }, () => ({ ...base, id: flow.id(), content }));
  assert.equal(flow.submit(child, records).pending, 10);
  const files = f.pending(); assert.ok(files.length >= 4, 'four near-cap records plus grants exceed 1MiB');
  for (const { file, batch } of files) {
    assert.ok(fs.statSync(file).size <= 1024 * 1024);
    assert.ok(batch.records.length <= 3); assert.equal(batch.records.length, batch.captureGrants.length);
    assert.equal(fs.statSync(file).size, Buffer.byteLength(JSON.stringify(batch)));
    assert.ok(batch.records.every(record => record.content.input.status === 'captured'));
  }
  flow.store.createLaunch(parent, { launchId: 'exact-large-child', multiUse: true });
  let calls = 0;
  await f.flow({ queueObservation: (record, options) => ++calls > 2 ? { queued: false, reason: 'capacity' }
    : queueObservation(record, options) }).flush({ timeoutMs: 10000 });
  assert.equal(f.outbox().length, 2);
  const remaining = f.pending().flatMap(({ batch }) => batch.records);
  assert.equal(remaining.length, 8);
  assert.deepEqual(new Set([...remaining, ...f.outbox().map(item => item.envelope.record)].map(record => record.id)), new Set(records.map(record => record.id)));
  await f.flow().flush({ timeoutMs: 10000 });
  assert.equal(f.pending().length, 0); assert.equal(f.outbox().length, 10);
  assert.equal((await ack(f)).accepted, 10);
});

test('capture tickets and rich envelopes survive enqueue/suffix crash; revision floor rejects obsolete replay after ACK', async t => {
  const f = fixture(t); configurePrivacy({ sensitiveLiterals: [LITERAL] });
  const flow = f.flow(), parent = f.begin(flow), child = f.begin(flow, { pendingIdentity: 'exact-crash-child' });
  const captures = Array.from({ length: 8 }, () => flow.captureObservation(child, contentRecord(flow, child)));
  assert.equal(flow.submitCaptured(captures).pending, captures.length);
  flow.store.createLaunch(parent, { launchId: 'exact-crash-child', multiUse: true });
  const script = `
    const {createFlow}=require(${JSON.stringify(require.resolve('../runtime/langfuse/flow.cjs'))});
    const {queueObservation}=require(${JSON.stringify(require.resolve('../runtime/langfuse/export.cjs'))});
    let calls=0;
    createFlow({cwd:${JSON.stringify(f.cwd)},stateDir:${JSON.stringify(f.stateDir)},env:{},queueObservation:(r,o)=>{
      const result=queueObservation(r,o); if(result.queued && ++calls===3) process.exit(23); return result;
    },flushOutbox:async()=>({accepted:0})}).flush({timeoutMs:10000});
  `;
  const died = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH } });
  assert.equal(died.status, 23, died.stderr); assert.equal(f.outbox().length, 3);
  assert.ok(f.pending().some(item => item.file.endsWith('.claim')));
  const old = f.flow().readState(`run:${child.rootSpanId}`).run;
  const recovered = f.flow(); await recovered.flush({ timeoutMs: 10000 });
  assert.equal(f.pending().length, 0); assert.equal(f.outbox().length, captures.length + 1);
  for (const { envelope } of f.outbox()) {
    const original = captures.find(item => item.record.id === envelope.record.id);
    assert.equal(envelope.revision, original.revision); assert.deepEqual(envelope.record.content, original.record.content);
  }
  const newer = recovered.captureObservation(old, { ...captures[0].record, content: recovered.createContent({ input: PII, output: 'newer' }) });
  assert.equal(recovered.submitCaptured([newer]).queued, 1);
  const seen = []; assert.equal((await ack(f, seen)).accepted, captures.length);
  const latest = seen.find(span => span.spanContext().spanId === newer.record.id);
  assert.equal(JSON.parse(latest.attributes['langfuse.observation.output']), 'newer');
  assert.equal(queueObservation(captures[0].record, { stateDir: f.stateDir, revision: captures[0].revision }).obsolete, true);
  checkDisk(f);
});

test('legacy metadata and new content replay together; unversioned historical content stays blocked and untouched', async t => {
  const f = fixture(t), flow = f.flow(), parent = f.begin(flow), child = f.begin(flow, { pendingIdentity: 'exact-legacy-child' });
  const metaCapture = f.flow({ capturePolicy: META }).captureObservation(child, observation(flow, child));
  flow.store.createLaunch(parent, { launchId: 'exact-legacy-child', multiUse: true });
  // A true pre-v2 metadata batch remains supported, with its original ticket.
  const legacyFile = path.join(f.pendingDir, `${crypto.randomUUID()}.json`);
  const legacy = { runId: child.rootSpanId, records: [metaCapture.record], revisions: [metaCapture.revision], createdAt: Date.now() };
  fs.writeFileSync(legacyFile, JSON.stringify(legacy), { mode: 0o600 });
  const historical = path.join(f.pendingDir, `${crypto.randomUUID()}.json`);
  fs.writeFileSync(historical, JSON.stringify({ ...legacy, records: [{ ...metaCapture.record,
    content: { version: 1, captureMode: 'full-content', redactionPolicyVersion: 1,
      input: { status: 'captured', value: 'HISTORICAL_PRIVATE_NEVER_AUTHORIZED' }, output: { status: 'unavailable' } } }] }), { mode: 0o600 });
  const before = fs.readFileSync(historical, 'utf8');
  const full = flow.captureObservation(parent, contentRecord(flow, parent)); flow.writeObservation('full-open', full);
  const oldStateFile = flow.stateFile('old-unversioned-open');
  fs.writeFileSync(oldStateFile, JSON.stringify({ checkpointVersion: 1, updatedAt: Date.now(), state: full }), { mode: 0o600 });
  assert.throws(() => flow.readObservation('old-unversioned-open'), /Unversioned/);
  assert.equal(flow.closeObservation('full-open').queued, 1);
  await flow.flush({ timeoutMs: 10000 });
  assert.equal(fs.readFileSync(historical, 'utf8'), before);
  assert.deepEqual(flow.readState('health'), { replayBlocked: true, reason: 'pending_capture_policy_missing' });
  const queued = f.outbox().map(item => item.envelope);
  assert.deepEqual(new Set(queued.map(item => item.schema)), new Set([2, 3]));
  assert.ok(queued.every(item => !JSON.stringify(item).includes('HISTORICAL_PRIVATE')));
  const seen = []; assert.equal((await ack(f, seen)).accepted, 2);
  assert.ok(seen.some(span => span.attributes['langfuse.observation.metadata.privacy'] === '"metadata-only"'));
  assert.ok(seen.some(span => span.attributes['langfuse.observation.metadata.privacy'] === '"full-content"'));
});

test('typed replay refuses policy/version/owner tampering and preserves unsupported private bytes', async t => {
  const f = fixture(t), flow = f.flow(), parent = f.begin(flow), run = f.begin(flow, { pendingIdentity: 'exact-tamper-child' });
  const capture = flow.captureObservation(run, contentRecord(flow, run));
  flow.writeObservation('typed-checkpoint', capture); assert.equal(flow.submitCaptured([capture]).pending, 1);
  flow.store.createLaunch(parent, { launchId: 'exact-tamper-child', multiUse: true });
  const [{ file, batch }] = f.pending();
  for (const change of [value => { value.captureGrants[0].redactionPolicyVersion = 2; },
    value => { value.records[0].content.version = 2; }, value => { value.owner.runId = crypto.randomUUID(); }]) {
    const modified = JSON.parse(JSON.stringify(batch)); change(modified);
    const bytes = JSON.stringify(modified); fs.writeFileSync(file, bytes);
    await flow.flush({ timeoutMs: 10000 });
    assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.equal(f.outbox().length, 0);
    assert.deepEqual(flow.readState('health'), { replayBlocked: true, reason: 'pending_capture_invalid' });
  }
  const checkpointFile = flow.stateFile('typed-checkpoint');
  const envelope = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
  envelope.state.record.content.input.value.email = 'not-a-canonical-secret sk-proj-SYNTHETIC_RAW';
  const bytes = JSON.stringify(envelope); fs.writeFileSync(checkpointFile, bytes);
  assert.throws(() => flow.readObservation('typed-checkpoint'), /Noncanonical/);
  assert.equal(fs.readFileSync(checkpointFile, 'utf8'), bytes, 'never repair/promote private bytes on read');
});

test('typed content uses the aggregate byte ceiling, including the publication slot and diagnostic reserve', t => {
  const f = fixture(t), flow = f.flow({ queueObservation: () => ({ queued: false }) }), run = f.begin(flow);
  const capture = flow.captureObservation(run, observation(flow, run, { content: flow.createContent({ input: 'x'.repeat(250000) }) }));
  flow.writeObservation('byte-open', capture);
  const source = flow.stateFile('byte-open'), bytes = fs.statSync(source).size;
  const adapterDir = path.join(f.stateDir, 'adapters');
  const size = () => walk(adapterDir).reduce((total, file) => total + fs.statSync(file).size, 0);
  const ordinaryLimit = ADAPTER_LIMITS.bytes - 1024 * 1024 - 8192;
  let i = 0;
  while (size() + bytes <= ordinaryLimit) fs.copyFileSync(source, flow.stateFile(`byte-copy:${i++}`));
  assert.throws(() => flow.closeObservation('byte-open'), /capacity/);
  assert.deepEqual(flow.readObservation('byte-open'), capture);
  assert.deepEqual(flow.readState('health'), { lineageLossObserved: true, reason: 'pending_capacity' });
  flow.writeState('delivery', { verified: false });
  assert.ok(size() + 1024 * 1024 <= ADAPTER_LIMITS.bytes);
});

test('kill switches stop typed closure and deferred delivery without deleting captured records', async t => {
  const f = fixture(t), flow = f.flow(), run = f.begin(flow);
  const capture = flow.captureObservation(run, contentRecord(flow, run)); flow.writeObservation('killed', capture);
  for (const name of ['BRAIN_TRACING_ENABLED', 'LANGFUSE_TRACING_ENABLED']) {
    let sends = 0;
    const disabled = f.flow({ env: { [name]: 'false' }, queueObservation: () => { sends++; }, flushOutbox: async () => { sends++; } });
    assert.equal(disabled.closeObservation('killed').disabled, true);
    assert.equal((await disabled.flush()).disabled, true); assert.equal(sends, 0);
    assert.deepEqual(disabled.readObservation('killed'), capture);
  }
  marker(f.cwd, { ...FULL, enabled: false });
  assert.equal(f.flow().captureMode(), 'disabled');
  assert.equal(f.flow().closeObservation('killed').queued, 1, 'original durableRetry is not retroactively revoked by marker');
});

test('failed suffix retention is explicit, keeps the open checkpoint, and reserves health diagnostics at capacity', t => {
  const f = fixture(t); configurePrivacy({ sensitiveLiterals: [LITERAL] });
  const flow = f.flow({ queueObservation: () => ({ queued: false, reason: 'capacity' }) }), run = f.begin(flow);
  const capture = flow.captureObservation(run, contentRecord(flow, run)); flow.writeObservation('open-capacity', capture);
  flow.writeState('prefill', { updatedAt: Date.now() });
  const adapterDir = path.join(f.stateDir, 'adapters');
  // Saturate ordinary file slots without creating thousands of context runs.
  let n = fs.readdirSync(adapterDir).filter(name => name.endsWith('.json')).length;
  for (let i = 0; n < ADAPTER_LIMITS.files - 3; i++, n++) fs.copyFileSync(flow.stateFile('prefill'), flow.stateFile(`prefill:${i}`));
  assert.throws(() => flow.closeObservation('open-capacity'), /capacity/);
  assert.deepEqual(flow.readObservation('open-capacity'), capture);
  assert.deepEqual(flow.readState('health'), { lineageLossObserved: true, reason: 'pending_capacity' });
  flow.writeState('delivery', { verified: false });
  assert.ok(walk(adapterDir).length + 1 <= ADAPTER_LIMITS.files, 'fixed temporary slot remains reserved');
  checkDisk(f);
});
