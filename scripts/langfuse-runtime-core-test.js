'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { sanitizeObservation, configurePrivacy, CONTEXT_FIELDS, LIMITS } = require('../runtime/langfuse/privacy.cjs');
const { queueObservation, reserveRevisions, flushOutbox, loadCredentials, OUTBOX_LIMITS, REVISION_LIMIT } = require('../runtime/langfuse/export.cjs');
const { dependencyCacheDir, loadDependencies, LOCK_FINGERPRINT } = require('../runtime/langfuse/dependencies.cjs');
const dependencyRoot = require('./lib/langfuse-test-dependencies.js').testDependencyRoot();
const base = overrides => ({
  id: '0123456789abcdef', traceId: '0123456789abcdef0123456789abcdef', parentId: null,
  sessionId: 'pi-session-abc', nativeSessionId: '550e8400-e29b-41d4-a716-446655440000',
  type: 'GENERATION', startTime: 1700000000000, endTime: 1700000001250,
  model: 'claude-sonnet-4-5-20250929', provider: 'anthropic',
  usage: { input: 20, output: 7, cache_read_input_tokens: 4 }, cost: { input: 0.001, output: 0.002 },
  context: { projectId: 'brain', projectName: 'agent-brain', persona: 'developer', ticketId: 'AKA-1',
    runtimeName: 'pi', harness: 'pi', skillsInvoked: ['security-review'], skillsLoaded: ['coding-standards'],
    branch: 'fix/tracing', requestedModel: 'claude-sonnet-4-5', observedModel: 'claude-sonnet-4-5-20250929',
    requestedEffort: 'high', observedEffort: 'high', evidenceSource: 'native-event' },
  outcome: 'success', ...overrides
});
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-metadata-test-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function outbox(stateDir) {
  const dir = path.join(stateDir, 'outbox');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map(file => fs.readFileSync(path.join(dir, file), 'utf8')).join('\n') : '';
}
function captureFactory(capture, code = 0) {
  return () => ({ export(spans, callback) { capture.push(...spans); callback({ code }); }, async shutdown() {}, async forceFlush() {} });
}
const CANARIES = [
  'sk-lf-SYNTHETIC_CANARY_INVALID', 'ghp_SYNTHETIC_CANARY_INVALID', 'password=SYNTHETIC_ONLY',
  'synthetic.person@example.invalid', '123-45-6789', '415-555-2671',
  'heading\nsecret=SYNTHETIC_ONLY\nfooter', 'data:image/png;base64,U1lOVEhFVElD',
  'https://person:password@example.invalid/path?token=CANARY'
];
const variants = value => [value, encodeURIComponent(value), Buffer.from(value).toString('base64'),
  Buffer.from(value).toString('base64url'), Buffer.from(value).toString('hex'),
  Buffer.from(Buffer.from(value).toString('base64url')).toString('base64url')];

// All fixtures are synthetic. No test calls a real model or Langfuse, loads
// process credentials, changes global SDK state or edits global configuration.
test('strict normalized records retain safe attribution, metrics, model and separate skill evidence', () => {
  const safe = sanitizeObservation(base({ name: 'Never forward this user description', toolName: 'read_file' }));
  assert.equal(safe.name, 'generation:developer');
  assert.equal(safe.model, 'claude-sonnet-4-5-20250929');
  assert.deepEqual(safe.usage, { input: 20, output: 7, cache_read_input_tokens: 4 });
  assert.deepEqual(safe.cost, { input: 0.001, output: 0.002 });
  assert.equal(safe.context.observedEffort, 'high');
  assert.deepEqual(safe.context.skillsInvoked, ['security-review']);
  assert.deepEqual(safe.context.skillsLoaded, ['coding-standards']);
  assert.deepEqual(sanitizeObservation(safe), safe);
  assert.equal(sanitizeObservation(base({ type: 'TOOL', toolName: 'read_file' })).name, 'tool:developer:read_file');
});

test('encoded and multiline secret/PII canaries in every accepted surface fail closed', () => {
  const identityFields = ['sessionId', 'nativeSessionId', 'model', 'provider', 'toolName', 'name'];
  for (const original of CANARIES) for (const canary of variants(original)) {
    for (const field of [...identityFields, 'id', 'traceId', 'parentId', 'type', 'startTime', 'endTime', 'outcome']) {
      let safe;
      try { safe = sanitizeObservation(base({ [field]: canary })); }
      catch (error) { assert.equal(error.message, 'Invalid metadata-only observation'); continue; }
      assert.ok(!JSON.stringify(safe).includes(canary), `${field}: unsafe value retained (${canary})`);
    }
    for (const field of [...CONTEXT_FIELDS, 'outcome', 'skillsInvoked', 'skillsLoaded']) {
      const value = field.startsWith('skills') ? [canary] : canary;
      const safe = sanitizeObservation(base({ context: { [field]: value } }));
      assert.ok(!JSON.stringify(safe).includes(canary), `${field}: unsafe context retained`);
    }
    for (const field of ['usage', 'cost']) {
      assert.ok(!JSON.stringify(sanitizeObservation(base({ [field]: { [canary]: 3, input: canary } }))).includes(canary));
    }
    const safe = sanitizeObservation(base({ [canary]: canary, context: { [canary]: canary } }));
    assert.ok(!JSON.stringify(safe).includes(canary));
  }
});

test('configured literal detection, budgets and identity requirements cannot silently pass', () => {
  configurePrivacy({ sensitiveLiterals: ['private-canary-identity'] });
  try {
    for (const value of variants('private-canary-identity')) assert.equal(sanitizeObservation(base({ model: value })).model, undefined);
    assert.throws(() => configurePrivacy({ sensitiveLiterals: Array(65).fill('private') }));
    assert.equal(sanitizeObservation(base({ provider: 'private-canary-identity' })).provider, undefined);
  } finally { configurePrivacy(); }
  for (const field of ['id', 'traceId', 'parentId', 'sessionId', 'nativeSessionId', 'type', 'startTime', 'endTime']) {
    const record = base(); delete record[field]; assert.throws(() => sanitizeObservation(record));
  }
  for (const change of [{ id: '0'.repeat(16) }, { traceId: '0'.repeat(32) }, { parentId: '0'.repeat(16) },
    { parentId: base().id }, { endTime: 1 }, { startTime: NaN }, { endTime: Infinity }]) assert.throws(() => sanitizeObservation(base(change)));
  assert.equal(sanitizeObservation(base({ model: 'a'.repeat(129) })).model, undefined);
  assert.equal(sanitizeObservation(base({ model: 'abcdef'.repeat(10) })).model, undefined);
  assert.equal(sanitizeObservation(base({ context: { skillsInvoked: Array(33).fill('safe') } })).context, undefined);
  assert.equal(sanitizeObservation(base({ usage: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`metric_${i}`, i])) })).usage, undefined);
});

test('unknown content, media, cycles, errors, oversized payloads and getters never get traversed or persisted', t => {
  const stateDir = sandbox(t);
  const cycle = {}; cycle.self = cycle;
  const record = base({ input: cycle, output: CANARIES, reasoning: CANARIES.join('\n'),
    toolArguments: CANARIES, toolResults: CANARIES, media: 'x'.repeat(5e6), error: new Error(CANARIES[0]),
    usage: { cyclic: cycle, input: 8 }, context: { projectId: 'safe-project', description: CANARIES, arbitrary: cycle } });
  Object.defineProperty(record, 'prompt', { enumerable: true, get() { throw new Error('content getter executed'); } });
  Object.defineProperty(record.context, 'persona', { enumerable: true, get() { throw new Error('metadata getter executed'); } });
  assert.equal(queueObservation(record, { stateDir }).queued, true);
  const bytes = outbox(stateDir);
  for (const canary of CANARIES) assert.ok(!bytes.includes(canary));
  const persisted = JSON.parse(bytes).record;
  for (const field of ['prompt', 'input', 'output', 'reasoning', 'toolArguments', 'toolResults', 'media', 'error']) assert.ok(!Object.hasOwn(persisted, field), field);
  for (const field of ['arbitrary', 'description', 'persona']) assert.ok(!Object.hasOwn(persisted.context, field), field);
  assert.ok(Buffer.byteLength(bytes) < LIMITS.recordBytes);
  assert.equal(fs.statSync(path.join(stateDir, 'outbox')).mode & 0o777, 0o700);
  for (const name of fs.readdirSync(path.join(stateDir, 'outbox'))) assert.equal(fs.statSync(path.join(stateDir, 'outbox', name)).mode & 0o777, 0o600);
  assert.equal(queueObservation(base({ sessionId: CANARIES[0] }), { stateDir }).queued, false);
});

test('the complete encoded canary matrix stays out of persisted records and SDK exporter output', async t => {
  const stateDir = sandbox(t);
  const all = CANARIES.flatMap(variants);
  for (let i = 0; i < all.length; i++) {
    const canary = all[i];
    const context = Object.fromEntries(CONTEXT_FIELDS.map(field => [field, canary]));
    context.skillsInvoked = [canary]; context.skillsLoaded = [canary]; context[canary] = canary;
    const record = base({ id: (i + 1).toString(16).padStart(16, '0'), name: canary, model: canary,
      provider: canary, toolName: canary, context, input: canary, output: canary, reasoning: canary,
      media: canary, error: canary, toolArguments: canary, toolResults: canary,
      usage: { [canary]: 7, input: 9 }, cost: { [canary]: 7, output: 0.01 }, [canary]: canary });
    assert.equal(queueObservation(record, { stateDir }).queued, true);
  }
  const persisted = outbox(stateDir);
  const spans = [];
  while (fs.readdirSync(path.join(stateDir, 'outbox')).length) {
    const result = await flushOutbox({ stateDir, dependencyRoot, exporterFactory: captureFactory(spans) });
    assert.ok(result.accepted > 0);
  }
  const exported = JSON.stringify(spans.map(span => ({ name: span.name, attributes: span.attributes, status: span.status })));
  for (const canary of all) {
    assert.ok(!persisted.includes(canary)); assert.ok(!exported.includes(canary));
  }
});

test('private credential precedence is atomic and host validation prevents mixed-source exfiltration', t => {
  const home = sandbox(t);
  const agentDir = path.join(home, 'pi-agent');
  const shared = path.join(home, '.config/agent-brain/langfuse.json');
  const pi = path.join(agentDir, 'langfuse.json');
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); };
  const config = { publicKey: 'pk-lf-SYNTHETIC', secretKey: 'sk-lf-SYNTHETIC', baseUrl: 'https://example.invalid' };
  write(pi, config);
  assert.deepEqual(loadCredentials({ env: {}, home, agentDir }), config);
  write(shared, { ...config, baseUrl: 'https://shared.invalid' });
  assert.equal(loadCredentials({ env: {}, home, agentDir }).baseUrl, 'https://shared.invalid');
  assert.equal(loadCredentials({ env: { LANGFUSE_BASE_URL: 'https://attacker.invalid' }, home, agentDir }), null);
  const env = { LANGFUSE_PUBLIC_KEY: config.publicKey, LANGFUSE_SECRET_KEY: config.secretKey, LANGFUSE_BASE_URL: config.baseUrl };
  assert.deepEqual(loadCredentials({ env, home, agentDir }), config);
  for (const url of ['https://username:password@example.invalid', 'http://example.invalid', 'http://127.0.0.1:1234', 'https://example.invalid?token=abc', 'https://example.invalid/#secret', 'https://example.invalid/path']) {
    assert.equal(loadCredentials({ env: { ...env, LANGFUSE_BASE_URL: url }, home, agentDir }), null);
  }
  fs.chmodSync(shared, 0o644);
  assert.equal(loadCredentials({ env: {}, home, agentDir }), null);
  fs.unlinkSync(shared); fs.symlinkSync(pi, shared);
  assert.equal(loadCredentials({ env: {}, home, agentDir }), null);
});

test('dependency cache is lock-fingerprinted and independent of checkout and Pi environment', t => {
  const home = sandbox(t);
  assert.equal(dependencyCacheDir({ home }), path.join(home, '.cache/agent-brain/langfuse', LOCK_FINGERPRINT));
  assert.match(LOCK_FINGERPRINT, /^[a-f0-9]{64}$/);
  assert.equal(typeof loadDependencies({ dependencyRoot }).NodeTracerProvider, 'function');
  assert.throws(() => loadDependencies({ dependencyRoot: home }), /pinned runtime cache/);
  fs.copyFileSync(path.join(dependencyRoot, 'package.json'), path.join(home, 'package.json'));
  fs.writeFileSync(path.join(home, 'package-lock.json'), '{}');
  assert.throws(() => loadDependencies({ dependencyRoot: home }), /pinned runtime cache/);
});

test('public SDK emits exact stable IDs, parent context, backdated timestamps and only safe tags/metrics', async t => {
  const stateDir = sandbox(t);
  const child = base({ id: 'fedcba9876543210', parentId: base().id, type: 'TOOL', toolName: 'read_file' });
  queueObservation(base(), { stateDir }); queueObservation(child, { stateDir });
  const spans = [];
  const result = await flushOutbox({ stateDir, dependencyRoot, exporterFactory: captureFactory(spans) });
  assert.equal(result.accepted, 2); assert.equal(result.queued, 0); assert.equal(result.failed, 0);
  assert.equal(result.verified, false); assert.equal(result.status, 'transport_accepted');
  const root = spans.find(span => span.spanContext().spanId === base().id);
  const tool = spans.find(span => span.spanContext().spanId === child.id);
  assert.equal(root.spanContext().traceId, base().traceId);
  assert.equal(root.parentSpanContext, undefined);
  assert.equal(tool.parentSpanContext.spanId, base().id);
  assert.equal(tool.spanContext().traceId, base().traceId);
  assert.equal(root.startTime[0] * 1000 + root.startTime[1] / 1e6, base().startTime);
  assert.equal(root.endTime[0] * 1000 + root.endTime[1] / 1e6, base().endTime);
  assert.equal(root.attributes['langfuse.observation.type'], 'generation');
  assert.equal(tool.attributes['langfuse.observation.type'], 'tool');
  assert.equal(root.attributes['langfuse.observation.model.name'], base().model);
  assert.deepEqual(JSON.parse(root.attributes['langfuse.observation.usage_details']), base().usage);
  assert.deepEqual(JSON.parse(root.attributes['langfuse.observation.cost_details']), base().cost);
  assert.ok(root.attributes['langfuse.trace.tags'].includes('skillsInvoked:security-review'));
  assert.ok(root.attributes['langfuse.trace.tags'].includes('skillsLoaded:coding-standards'));
  assert.deepEqual(root.resource.attributes, {});
  const exported = JSON.stringify(spans.map(span => ({ name: span.name, attributes: span.attributes, status: span.status, events: span.events, links: span.links, resource: span.resource.attributes })));
  for (const canary of CANARIES) assert.ok(!exported.includes(canary));
  assert.ok(!exported.includes('skillsUsed'));
});

test('replay coalesces older actor revisions and preserves typed IDs and AGENT semantics', async t => {
  const stateDir = sandbox(t);
  const context = { ...base().context, projectId: `project-${'a'.repeat(32)}`, worktreeId: `worktree-${'b'.repeat(32)}` };
  const latest = base({ type: 'AGENT', endTime: base().endTime + 100, outcome: 'completed', context });
  queueObservation(latest, { stateDir });
  queueObservation(base({ type: 'AGENT', outcome: 'unknown', context }), { stateDir });
  const spans = [];
  const result = await flushOutbox({ stateDir, dependencyRoot, exporterFactory: captureFactory(spans) });
  assert.equal(result.accepted, 1); assert.equal(result.queued, 0); assert.equal(spans.length, 1);
  assert.equal(spans[0].attributes['langfuse.observation.type'], 'agent');
  assert.equal(JSON.parse(spans[0].attributes['langfuse.observation.metadata.outcome']), 'completed');
  assert.equal(JSON.parse(spans[0].attributes['langfuse.observation.metadata.projectId']), context.projectId);
});

test('parallel flushes cannot post an older actor revision after a newer one', async t => {
  const stateDir = sandbox(t); const seen = [];
  queueObservation(base(), { stateDir });
  const factory = () => ({ export(spans, callback) { setTimeout(() => { seen.push(...spans.map(span => span.endTime[0] * 1000 + span.endTime[1] / 1e6)); callback({ code: 0 }); }, 30); }, async shutdown() {} });
  const first = flushOutbox({ stateDir, dependencyRoot, exporterFactory: factory });
  queueObservation(base({ endTime: base().endTime + 100 }), { stateDir });
  const second = flushOutbox({ stateDir, dependencyRoot, exporterFactory: factory });
  await Promise.all([first, second]);
  assert.deepEqual(seen, [base().endTime, base().endTime + 100]);
  assert.equal(fs.readdirSync(path.join(stateDir, 'outbox')).length, 0);
});

test('offline, exporter failures, throws and timeouts retain metadata-only replay with stable IDs', async t => {
  for (const mode of ['failure', 'throw', 'reject', 'timeout', 'factory-timeout', 'queued-not-acked']) {
    const stateDir = path.join(sandbox(t), mode);
    queueObservation(base({ input: CANARIES[0] }), { stateDir });
    const before = outbox(stateDir);
    const factory = mode === 'factory-timeout' ? () => new Promise(() => {}) : () => ({
      export(spans, cb) {
        if (mode === 'throw') throw new Error(CANARIES[0]);
        if (mode === 'reject') return Promise.reject(new Error(CANARIES[0]));
        if (mode === 'failure') cb({ code: 1, error: new Error(CANARIES[0]) });
        // Resolving export() is NOT an acknowledgement.
        if (mode === 'queued-not-acked') return Promise.resolve();
      }, async shutdown() {}
    });
    const start = Date.now();
    const result = await flushOutbox({ stateDir, dependencyRoot, exporterFactory: factory, timeoutMs: 250 });
    assert.equal(result.accepted, 0); assert.equal(result.queued, 1); assert.equal(result.failed, 1);
    assert.ok(Date.now() - start < 1000);
    assert.equal(outbox(stateDir), before);
    assert.ok(!JSON.stringify(result).includes(CANARIES[0]));
    const replay = [];
    const success = await flushOutbox({ stateDir, dependencyRoot, exporterFactory: captureFactory(replay) });
    assert.equal(success.accepted, 1); assert.equal(replay[0].spanContext().spanId, base().id);
  }
  const stateDir = sandbox(t);
  queueObservation(base(), { stateDir });
  const before = outbox(stateDir);
  const offline = await flushOutbox({ stateDir, credentials: null, dependencyRoot });
  assert.equal(offline.status, 'offline'); assert.equal(offline.attempted, 0); assert.equal(outbox(stateDir), before);
});

test('late callbacks cannot delete retries; acknowledgements remove only their exact version', async t => {
  const stateDir = sandbox(t);
  queueObservation(base(), { stateDir });
  let callback;
  // Give process-identity/SDK setup time under parallel test load; this test
  // requires an actually started export, then deliberately withholds its ACK.
  await flushOutbox({ stateDir, dependencyRoot, timeoutMs: 1000, exporterFactory: () => ({ export(spans, cb) { callback = cb; }, async shutdown() {} }) });
  assert.equal(typeof callback, 'function', 'the exporter must start before testing a late acknowledgement');
  const before = outbox(stateDir);
  callback({ code: 0 });
  assert.equal(outbox(stateDir), before);
  const result = await flushOutbox({ stateDir, dependencyRoot, exporterFactory: () => ({
    export(spans, cb) { queueObservation(base({ endTime: base().endTime + 100 }), { stateDir }); cb({ code: 0 }); cb({ code: 0 }); }, async shutdown() {}
  }) });
  assert.equal(result.accepted, 1); assert.equal(result.queued, 1);
  assert.ok(outbox(stateDir).includes(String(base().endTime + 100)));
  const tampered = await flushOutbox({ stateDir, dependencyRoot, exporterFactory: () => ({
    export(spans, cb) {
      const file = path.join(stateDir, 'outbox', fs.readdirSync(path.join(stateDir, 'outbox'))[0]);
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
      envelope.record.endTime++;
      fs.writeFileSync(file, JSON.stringify(envelope));
      cb({ code: 0 });
    }, async shutdown() {}
  }) });
  assert.equal(tampered.accepted, 0); assert.equal(tampered.queued, 1);
});

test('queue capacity, bounded flushes, tampered records and unsafe state paths fail closed', async t => {
  const stateDir = sandbox(t);
  for (let i = 0; i < OUTBOX_LIMITS.records; i++) assert.equal(queueObservation(base({ id: (i + 1).toString(16).padStart(16, '0') }), { stateDir }).queued, true);
  assert.deepEqual(queueObservation(base(), { stateDir }), { queued: false, reason: 'capacity' });
  const spans = [];
  const result = await flushOutbox({ stateDir, dependencyRoot, exporterFactory: captureFactory(spans) });
  assert.equal(result.attempted, OUTBOX_LIMITS.flush); assert.equal(result.queued, OUTBOX_LIMITS.records - OUTBOX_LIMITS.flush);
  const file = path.join(stateDir, 'outbox', fs.readdirSync(path.join(stateDir, 'outbox'))[0]);
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8')); envelope.record.output = CANARIES[0];
  fs.writeFileSync(file, JSON.stringify(envelope));
  const second = await flushOutbox({ stateDir, dependencyRoot, exporterFactory: captureFactory([]) });
  assert.ok(second.invalid >= 1); assert.ok(fs.existsSync(file));
  const home = sandbox(t); const target = sandbox(t); const link = path.join(home, 'state'); fs.symlinkSync(target, link);
  assert.equal(queueObservation(base(), { stateDir: link }).queued, false);
  const held = require('../runtime/langfuse/locks.cjs').claimLock(target, 'queue');
  try { assert.deepEqual(queueObservation(base(), { stateDir: target }), { queued: false, reason: 'busy' }); }
  finally { held.release(); }
  fs.chmodSync(target, 0o755); assert.equal(queueObservation(base(), { stateDir: target }).queued, false);
});

test('local synthetic HTTP transport uses safe OTLP and requires real callback success, not queueing', async t => {
  const stateDir = sandbox(t);
  let responseBody = '{}', status = 200;
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), url: req.url });
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(responseBody);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const credentials = { publicKey: 'pk-lf-SYNTHETIC_ONLY', secretKey: 'sk-lf-SYNTHETIC_ONLY', baseUrl: `http://127.0.0.1:${server.address().port}`, syntheticLoopback: true };
  queueObservation(base({ prompt: CANARIES, error: CANARIES, images: CANARIES }), { stateDir });
  const rejectedConfig = await flushOutbox({ stateDir, dependencyRoot, credentials: { ...credentials, syntheticLoopback: false } });
  assert.equal(rejectedConfig.status, 'offline'); assert.equal(requests.length, 0);
  status = 503;
  assert.equal((await flushOutbox({ stateDir, dependencyRoot, credentials })).accepted, 0);
  status = 200; responseBody = '{"partialSuccess":{"rejectedSpans":1}}';
  assert.equal((await flushOutbox({ stateDir, dependencyRoot, credentials })).accepted, 0);
  responseBody = '{}';
  const accepted = await flushOutbox({ stateDir, dependencyRoot, credentials });
  assert.equal(accepted.accepted, 1); assert.equal(accepted.verified, false);
  assert.equal(requests.length, 3);
  const wire = requests[2];
  assert.equal(wire.url, '/api/public/otel/v1/traces');
  for (const canary of CANARIES) assert.ok(!wire.body.includes(canary));
  assert.ok(!wire.body.includes(credentials.secretKey));
  const span = JSON.parse(wire.body).resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.spanId, base().id); assert.equal(span.traceId, base().traceId);
  assert.equal(span.startTimeUnixNano, String(BigInt(base().startTime) * 1000000n));
  for (const [body, succeeds] of [
    [{ data: { id: 'synthetic-receipt', timestamp: '2026-01-01T00:00:00Z', name: 'synthetic-ingestion', payload: {} } }, true],
    [{ partialSuccess: { rejectedSpans: '0' } }, true],
    [{ error: 'SYNTHETIC_REJECTION' }, false]
  ]) {
    queueObservation(base(), { stateDir }); responseBody = JSON.stringify(body);
    const result = await flushOutbox({ stateDir, dependencyRoot, credentials });
    assert.equal(result.accepted > 0, succeeds);
    assert.equal(result.verified, false);
  }
});

test('durable pre-send floors reject older replay after uncertain ACK and retain exact retry', async t => {
  const stateDir = sandbox(t), seen = [];
  const older = base({ outcome: 'completed' }), newer = base({ outcome: 'aborted' });
  const [oldRevision, newRevision] = reserveRevisions([older, newer], { stateDir });
  assert.ok(newRevision > oldRevision, 'same-timestamp metadata revisions use synchronized capture order');
  queueObservation(newer, { stateDir, revision: newRevision });
  const uncertain = await flushOutbox({ stateDir, dependencyRoot, timeoutMs: 500, exporterFactory: () => ({
    export(spans) { seen.push(...spans); }, async shutdown() {}
  }) });
  assert.equal(uncertain.accepted, 0);
  assert.equal(queueObservation(older, { stateDir, revision: oldRevision }).obsolete, true);
  const retry = await flushOutbox({ stateDir, dependencyRoot, exporterFactory: captureFactory(seen) });
  assert.equal(retry.accepted, 1);
  assert.equal(seen.length, 2, 'uncertain delivery remains at-least-once');
  assert.ok(seen.every(span => JSON.parse(span.attributes['langfuse.observation.metadata.outcome']) === 'aborted'));
  assert.equal(queueObservation(older, { stateDir, revision: oldRevision }).obsolete, true);
  assert.equal(fs.readdirSync(path.join(stateDir, 'outbox')).length, 0);
});

test('unticketed legacy outbox records stay intact instead of being assigned replay-time chronology', async t => {
  const stateDir = sandbox(t);
  queueObservation(base(), { stateDir });
  const file = path.join(stateDir, 'outbox', fs.readdirSync(path.join(stateDir, 'outbox'))[0]);
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  envelope.schema = 1; delete envelope.revision;
  fs.writeFileSync(file, JSON.stringify(envelope));
  fs.unlinkSync(path.join(stateDir, 'revisions-v1.json'));
  const before = outbox(stateDir), seen = [];
  const result = await flushOutbox({ stateDir, dependencyRoot, exporterFactory: captureFactory(seen) });
  assert.equal(result.status, 'invalid_outbox'); assert.equal(result.invalid, 1);
  assert.equal(result.accepted, 0); assert.equal(seen.length, 0);
  assert.equal(outbox(stateDir), before);
});

test('revision capacity refuses without evicting floors; an orphan publication slot is recovered', t => {
  const stateDir = sandbox(t);
  const entries = Object.fromEntries(Array.from({ length: REVISION_LIMIT }, (_, i) =>
    [i.toString(16).padStart(64, '0'), { allocated: 1, floor: { revision: 1, endTime: 1700000001250 } }]));
  const ledger = path.join(stateDir, 'revisions-v1.json');
  fs.writeFileSync(ledger, JSON.stringify({ schema: 1, entries }), { mode: 0o600 });
  const before = fs.readFileSync(ledger, 'utf8');
  assert.deepEqual(queueObservation(base(), { stateDir }), { queued: false, reason: 'revision_capacity' });
  assert.equal(fs.readFileSync(ledger, 'utf8'), before);
  fs.unlinkSync(ledger);
  fs.writeFileSync(path.join(stateDir, '.revisions-v1.tmp'), 'interrupted synthetic publication', { mode: 0o600 });
  assert.equal(queueObservation(base(), { stateDir }).queued, true);
  assert.equal(fs.existsSync(path.join(stateDir, '.revisions-v1.tmp')), false);
});

test('API emits no raw content or arbitrary errors to stdout/stderr', t => {
  const stateDir = sandbox(t);
  const script = `const e=require(${JSON.stringify(require.resolve('../runtime/langfuse/export.cjs'))}); const r=${JSON.stringify(base({ input: CANARIES[0] }))}; e.queueObservation(r,{stateDir:${JSON.stringify(stateDir)}}); e.flushOutbox({stateDir:${JSON.stringify(stateDir)},dependencyRoot:${JSON.stringify(dependencyRoot)},exporterFactory:()=>({export(s,cb){cb({code:1,error:new Error(${JSON.stringify(CANARIES[0])})})},async shutdown(){}})}).then(r=>console.log(JSON.stringify(r)));`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, LANGFUSE_DEBUG: 'true' } });
  assert.equal(child.status, 0, child.stderr);
  for (const canary of CANARIES) assert.ok(!(child.stdout + child.stderr + outbox(stateDir)).includes(canary));
});
