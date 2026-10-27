'use strict';

// Stage 1 only: synthetic JSON, private temporary state, pinned installed SDK,
// and loopback OTLP. No adapter activation, auth-file reads, installs or models.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { sanitizeObservation, sanitizeMetadataObservation, projectContent, configurePrivacy, LIMITS, CONTENT_LIMITS } = require('../runtime/langfuse/privacy.cjs');
const { queueObservation, reserveRevisions, flushOutbox, recoverOutbox, OUTBOX_LIMITS } = require('../runtime/langfuse/export.cjs');
const dependencyRoot = require('./lib/langfuse-test-dependencies.js').testDependencyRoot();
const record = (overrides = {}) => ({
  id: '0123456789abcdef', traceId: 'a'.repeat(32), parentId: null,
  sessionId: 'synthetic-session', nativeSessionId: '550e8400-e29b-41d4-a716-446655440000',
  type: 'GENERATION', startTime: 1700000000000, endTime: 1700000001000,
  model: 'synthetic-model', context: { harness: 'pi', persona: 'developer' }, outcome: 'completed', ...overrides
});
const surface = value => ({ status: 'captured', value });
const content = (input, output = null) => ({ version: 1, captureMode: 'full-content', redactionPolicyVersion: 1,
  input: surface(input), output: surface(output) });
const full = (input, output, overrides = {}) => record({ content: content(input, output), ...overrides });
const PII = { name: 'Zoë 王', email: 'synthetic.person@example.invalid', ssn: '123-45-6789',
  phone: '415-555-2671', address: '123 Synthetic St', ip: '192.0.2.12', url: 'https://example.invalid/person?id=17' };
const PROMPT = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello\nZoë 王 😀' }, { type: 'text', text: JSON.stringify(PII) }] }],
  tools: [{ name: 'lookup', arguments: { ...PII, empty: '', missing: null, enabled: false, count: 0 } }] };
const RESPONSE = [{ type: 'text', text: PII.email }, { type: 'tool_call', id: 'call-1', arguments: { names: ['Zoë', '王'], ssn: PII.ssn } },
  { type: 'tool_result', content: [null, '', false, 0, { ...PII }] }];
function sandbox(t) {
  const stateDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'brain-content-test-'));
  fs.chmodSync(stateDir, 0o700);
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  return stateDir;
}
const names = stateDir => fs.readdirSync(path.join(stateDir, 'outbox')).filter(name => name.endsWith('.json'));
const bytes = stateDir => names(stateDir).map(name => fs.readFileSync(path.join(stateDir, 'outbox', name), 'utf8')).join('\n');
const captureFactory = (seen, code = 0) => () => ({ export(spans, cb) { seen.push(...spans); cb({ code }); }, async shutdown() {} });
const flush = (stateDir, seen = [], options = {}) => flushOutbox({ stateDir, dependencyRoot, env: {}, exporterFactory: captureFactory(seen), ...options });
const values = span => Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue ?? value.boolValue ?? value.doubleValue]));
async function serverFixture(t) {
  const received = [];
  let receipt = () => '{}';
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/public/otel/v1/traces');
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push({ body, request: JSON.parse(body.toString('utf8')) });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(receipt(received.length));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { received, setReceipt: fn => { receipt = fn; }, credentials: {
    publicKey: 'pk-lf-SYNTHETIC_ONLY', secretKey: 'sk-lf-SYNTHETIC_ONLY', syntheticLoopback: true,
    baseUrl: `http://127.0.0.1:${server.address().port}`
  } };
}

// Public handoff shape: record.content = {version:1,captureMode:'full-content',
// redactionPolicyVersion:1,input:{status:'captured',value:JSON},output:...}.
// No arbitrary native/provider objects, hidden reasoning or binary support.
test('explicit v1 content preserves PII, JSON types, empty/null, Unicode and block order; metadata stays frozen', () => {
  const safe = sanitizeObservation(full(PROMPT, RESPONSE));
  assert.deepEqual(safe.content, content(PROMPT, RESPONSE));
  assert.deepEqual(sanitizeObservation(safe), safe);
  assert.equal(safe.name, 'generation:developer');
  assert.ok(Buffer.byteLength(JSON.stringify(safe)) < CONTENT_LIMITS.recordBytes);
  assert.equal(sanitizeMetadataObservation(full(PROMPT, RESPONSE)).content, undefined);
  const snapshot = sanitizeObservation(full(PROMPT, RESPONSE));
  snapshot.content.input.value.tools[0].arguments.name = 'changed';
  assert.equal(PROMPT.tools[0].arguments.name, PII.name, 'snapshot is detached');
  const nullPrototype = Object.assign(Object.create(null), { email: PII.email });
  assert.deepEqual(projectContent(nullPrototype), surface({ email: PII.email }));
  const ordinaryDataText = `data: ${PII.email}; describe data:image/png;base64 without embedding media`;
  assert.deepEqual(projectContent(ordinaryDataText), surface(ordinaryDataText), 'ordinary data: prose is not a binary attachment');
});

test('metadata default and context cannot opt into content and never read input/output getters', t => {
  const stateDir = sandbox(t);
  let reads = 0;
  const value = record({ context: { harness: 'pi', content: content(PROMPT, RESPONSE), captureMode: 'full-content' } });
  for (const field of ['input', 'output']) Object.defineProperty(value, field, { enumerable: true, get() { reads++; throw Error('never'); } });
  assert.equal(sanitizeObservation(value).content, undefined);
  assert.equal(queueObservation(value, { stateDir }).privacy, 'metadata-only');
  assert.equal(reads, 0);
  const persisted = JSON.parse(bytes(stateDir));
  assert.equal(persisted.schema, 2);
  assert.ok(Buffer.byteLength(bytes(stateDir)) < LIMITS.recordBytes);
  assert.ok(!bytes(stateDir).includes(PII.email));
  // Even explicit content does not use the unrelated top-level input/output.
  value.content = content(PROMPT, RESPONSE);
  assert.deepEqual(sanitizeObservation(value).content, content(PROMPT, RESPONSE));
  assert.equal(reads, 0);
});

test('policy/envelope versions, unknown fields and malformed surfaces refuse rather than downgrade', t => {
  const stateDir = sandbox(t);
  const variants = [undefined, null, {}, { ...content('', ''), version: 2 }, { ...content('', ''), captureMode: 'metadata-only' },
    { ...content('', ''), redactionPolicyVersion: 2 }, { ...content('', ''), extra: true },
    { ...content('', ''), input: {} }, { ...content('', ''), input: { status: 'truncated', value: 'prefix' } },
    { ...content('', ''), input: { status: 'captured' } }, { ...content('', ''), input: { status: 'unavailable', value: '' } },
    { ...content('', ''), input: { status: 'captured', value: '', source: 'unknown' } }];
  for (const malformed of variants) {
    assert.throws(() => sanitizeObservation(record({ content: malformed })), /Invalid full-content envelope/);
    assert.deepEqual(queueObservation(record({ content: malformed }), { stateDir }), { queued: false, reason: 'invalid_record' });
  }
  const accessor = record();
  Object.defineProperty(accessor, 'content', { enumerable: true, get() { assert.fail('envelope getter read'); } });
  assert.throws(() => sanitizeObservation(accessor), /Invalid full-content envelope/);
  const valid = content('', '');
  valid.input = { status: 'unavailable' }; valid.output = { status: 'unsupported' };
  assert.deepEqual(sanitizeObservation(record({ content: valid })).content, valid);
  for (const field of ['id', 'traceId', 'parentId', 'sessionId', 'nativeSessionId', 'type', 'startTime', 'endTime']) {
    const invalid = full(PROMPT, RESPONSE); delete invalid[field];
    assert.throws(() => sanitizeObservation(invalid), 'content never relaxes identity validation');
  }
});

test('shared clone refuses unsupported objects, getters, sparse arrays, cycles, media and unsafe keys without traversal', () => {
  const cycle = {}; cycle.self = cycle;
  const accessor = {}; Object.defineProperty(accessor, 'email', { enumerable: true, get() { assert.fail('getter executed'); } });
  const inherited = Object.create({ email: PII.email }); inherited.value = 1;
  const proxy = new Proxy({}, { ownKeys() { assert.fail('proxy trap executed'); } });
  const extras = [undefined, () => 1, Symbol('x'), 1n, NaN, Infinity, new Date(), new Map(), Buffer.from('synthetic'),
    new (class Payload { constructor() { this.email = PII.email; } })(), inherited, accessor, proxy, cycle,
    [, 'sparse'], Object.assign([], { extra: 'not JSON' }), { toJSON() { assert.fail('toJSON called'); } },
    { [Symbol('x')]: 'symbol key' }, JSON.parse('{"__proto__":{"x":1}}'), { constructor: 'unsafe' },
    'data:image/png;base64,U1lOVEhFVElD'];
  for (const bad of extras) {
    const safe = sanitizeObservation(full(bad, PII));
    assert.deepEqual(safe.content.input, { status: 'unsupported' });
    assert.deepEqual(safe.content.output, surface(PII));
    assert.deepEqual(sanitizeObservation(safe), safe);
  }
  let nested = null;
  for (let i = 0; i < CONTENT_LIMITS.depth + 2; i++) nested = [nested];
  assert.equal(projectContent(nested).status, 'refused_size');
  assert.equal(projectContent(Object.fromEntries(Array.from({ length: CONTENT_LIMITS.keys + 1 }, (_, i) => [`k${i}`, i]))).status, 'refused_size');
  let tree = [1, 2, 3, 4];
  for (let i = 0; i < 7; i++) tree = [tree, tree, tree, tree];
  assert.equal(projectContent(tree).status, 'refused_size', 'shared references cannot expand forever');
});

const SECRETS = [
  'sk-lf-SYNTHETIC_TOKEN', 'pk-lf-SYNTHETIC_TOKEN', 'sk-proj-SYNTHETIC_TOKEN', 'ghp_SYNTHETIC_TOKEN', 'github_pat_SYNTHETIC_TOKEN',
  'xoxb-SYNTHETIC-TOKEN', 'AKIAABCDEFGHIJKLMNOP', 'ASIAABCDEFGHIJKLMNOP', 'AIzaSYNTHETICabcdefghijklmnop',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGlj',
  'Bearer SYNTHETIC_BEARER', 'Basic U1lOVEhFVElDOk9OTFk=',
  'password="SYNTHETIC\nMULTILINE"', 'api_key=SYNTHETIC_KEY', 'access_token=SYNTHETIC_ACCESS',
  'https://synthetic-user:synthetic-pass@example.invalid/path?token=SYNTHETIC_QUERY',
  '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE\n-----END PRIVATE KEY-----',
  'opaque-SYNTHETIC-literal', 'escaped-"SYNTHETIC"-\\literal\nvalue'
];
function secretPayload() {
  return { ...PII, secrets: SECRETS, password: { mustNotSurvive: 'SYNTHETIC_PASSWORD_VALUE' },
    Authorization: 'SYNTHETIC_HEADER', api_key: 'SYNTHETIC_KEY_VALUE', aws_secret_access_key: 'SYNTHETIC_AWS_VALUE',
    'opaque-SYNTHETIC-literal': 'key is redacted too', ordinary: { ...PII } };
}
const literalConfiguration = () => configurePrivacy({ sensitiveLiterals: SECRETS.slice(-2) });
const assertDiskNoSecrets = stateDir => {
  for (const entry of fs.readdirSync(stateDir, { withFileTypes: true })) {
    const file = path.join(stateDir, entry.name);
    if (entry.isDirectory()) assertDiskNoSecrets(file);
    else assertNoSecrets(fs.readFileSync(file, 'utf8'));
  }
};
const assertNoSecrets = text => {
  for (const secret of SECRETS) assert.ok(!text.includes(secret) && !text.includes(JSON.stringify(secret).slice(1, -1)), secret);
  for (const token of ['SYNTHETIC_BEARER', 'U1lOVEhFVElDOk9OTFk=', 'SYNTHETIC_PRIVATE', 'SYNTHETIC_PASSWORD_VALUE', 'SYNTHETIC_HEADER',
    'SYNTHETIC_KEY_VALUE', 'SYNTHETIC_AWS_VALUE', 'synthetic-user', 'synthetic-pass', 'SYNTHETIC_QUERY', 'SYNTHETIC_ACCESS', 'MULTILINE']) assert.ok(!text.includes(token), token);
};

test('credential patterns and explicit decoded literals/keys are redacted idempotently while PII remains', () => {
  literalConfiguration();
  try {
    const safe = sanitizeObservation(full(secretPayload(), secretPayload()));
    assert.equal(safe.content.input.status, 'credential_redacted');
    assert.equal(safe.content.output.status, 'credential_redacted');
    assertNoSecrets(JSON.stringify(safe));
    for (const [key, value] of Object.entries(PII)) assert.equal(safe.content.input.value[key], value);
    assert.deepEqual(sanitizeObservation(safe), safe);
    assert.deepEqual(projectContent(projectContent(secretPayload()).value).value, safe.content.input.value);
    const collision = { 'opaque-SYNTHETIC-literal': 1, '[REDACTED]': 2 };
    assert.equal(projectContent(collision).status, 'unsupported', 'redacted key collisions cannot silently drop JSON');
  } finally { configurePrivacy(); }
});

test('per-capture runtime literals and command grammar redact values only, preserve PII/types and revalidate idempotently', () => {
  configurePrivacy({ sensitiveLiterals: ['GLOBAL_SYNTHETIC_LITERAL'] });
  try {
    const capability = 'RuntimeCapability_'.repeat(3), other = 'OtherCapability_'.repeat(3);
    const command = `export BRAIN_TRACE_LAUNCH_ID='${capability}'\nbrain-trace --actor "${other}" status; echo person@example.invalid`;
    const payload = { command, echo: capability, nested: [null, 0, false, '', ...Object.values(PII)],
      BRAIN_TRACE_LAUNCH_ID: other, prose: 'Use --actor ACTOR or --actor NONCE; BRAIN_TRACE_LAUNCH_ID=NONCE. data: ordinary prose.',
      global: 'GLOBAL_SYNTHETIC_LITERAL' };
    const options = { additionalSensitiveLiterals: [capability] };
    const safe = projectContent(payload, options);
    assert.equal(safe.status, 'credential_redacted');
    assert.equal(safe.value.command, `export BRAIN_TRACE_LAUNCH_ID='[REDACTED]'\nbrain-trace --actor "[REDACTED]" status; echo person@example.invalid`);
    assert.equal(safe.value.echo, '[REDACTED]'); assert.equal(safe.value.BRAIN_TRACE_LAUNCH_ID, '[REDACTED]');
    assert.deepEqual(safe.value.nested, payload.nested); assert.equal(safe.value.prose, payload.prose);
    assert.equal(safe.value.global, '[REDACTED]');
    assert.deepEqual(projectContent(safe.value, options).value, safe.value);
    assert.deepEqual(projectContent(safe.value).value, safe.value, 'wire revalidation needs no runtime secret list');
    assert.equal(projectContent(capability).value, capability, 'per-capture list never becomes global configuration');
    assert.equal(projectContent('GLOBAL_SYNTHETIC_LITERAL').value, '[REDACTED]');
    assert.equal(projectContent({ [capability]: 1, '[REDACTED]': 2 }, options).status, 'unsupported');
    for (const token of ['x'.repeat(32), 'y'.repeat(128)]) {
      assert.equal(projectContent(`--actor=${token}; BRAIN_TRACE_LAUNCH_ID=${token}`).value,
        '--actor=[REDACTED]; BRAIN_TRACE_LAUNCH_ID=[REDACTED]');
    }
  } finally { configurePrivacy(); }
});

test('per-capture option/accessor/proxy/budget refusal neither executes getters nor resets configured defenses', () => {
  configurePrivacy({ sensitiveLiterals: ['GLOBAL_SYNTHETIC_LITERAL'] });
  try {
    let reads = 0;
    const getter = {}; Object.defineProperty(getter, 'additionalSensitiveLiterals', { get() { reads++; throw Error('OPTIONS_GETTER'); } });
    const array = []; Object.defineProperty(array, '0', { get() { reads++; throw Error('LITERAL_GETTER'); } });
    const proxy = new Proxy({}, { ownKeys() { reads++; throw Error('OPTIONS_PROXY'); }, getPrototypeOf() { reads++; throw Error('OPTIONS_PROXY'); } });
    for (const options of [null, getter, proxy, { unrelated: [] }, { additionalSensitiveLiterals: array },
      { additionalSensitiveLiterals: new Proxy([], { get() { reads++; throw Error('ARRAY_PROXY'); } }) },
      { additionalSensitiveLiterals: ['NONCE'] }, { additionalSensitiveLiterals: ['a'.repeat(129)] },
      { additionalSensitiveLiterals: new Array(1) }]) {
      assert.equal(projectContent(PII, options).status, 'unsupported');
    }
    assert.equal(reads, 0);
    assert.equal(projectContent(PII, { additionalSensitiveLiterals: Array(CONTENT_LIMITS.additionalLiterals + 1).fill('a'.repeat(32)) }).status, 'refused_size');
    assert.equal(projectContent('GLOBAL_SYNTHETIC_LITERAL').value, '[REDACTED]');
    assert.equal(projectContent('a'.repeat(CONTENT_LIMITS.recordBytes + 1), { additionalSensitiveLiterals: ['a'.repeat(32)] }).status, 'refused_size', 'redaction cannot bypass original size budget');
  } finally { configurePrivacy(); }
});

test('invalid redaction configuration refuses content without replacing the previous metadata defense', () => {
  configurePrivacy({ sensitiveLiterals: ['SYNTHETIC_OLD'] });
  try {
    assert.throws(() => configurePrivacy({ sensitiveLiterals: ['bad'] }));
    assert.equal(sanitizeObservation(record({ model: 'SYNTHETIC_OLD' })).model, undefined);
    assert.deepEqual(sanitizeObservation(full(PII, null)).content.input, { status: 'unavailable' });
    assert.throws(() => configurePrivacy(null));
    assert.deepEqual(projectContent(PII), { status: 'unavailable' });
    const options = {};
    Object.defineProperty(options, 'sensitiveLiterals', { get() { assert.fail('configuration getter'); } });
    assert.throws(() => configurePrivacy(options));
  } finally { configurePrivacy(); }
  assert.deepEqual(projectContent(PII), surface(PII));
});

test('canonical record cap minus/equal/plus, multibyte and escaping are complete or explicitly refused', () => {
  const overhead = Buffer.byteLength(JSON.stringify(sanitizeObservation(full('', null))));
  const size = CONTENT_LIMITS.recordBytes - overhead;
  for (const delta of [-1, 0, 1]) {
    const safe = sanitizeObservation(full('x'.repeat(size + delta), null));
    if (delta <= 0) {
      assert.equal(Buffer.byteLength(JSON.stringify(safe)), CONTENT_LIMITS.recordBytes + delta);
      assert.equal(safe.content.input.value.length, size + delta);
    } else {
      assert.deepEqual(safe.content.input, { status: 'refused_size' });
      assert.deepEqual(safe.content.output, { status: 'refused_size' });
    }
    assert.deepEqual(sanitizeObservation(safe), safe);
  }
  for (const payload of ['王'.repeat(CONTENT_LIMITS.recordBytes / 2), '\u0000'.repeat(CONTENT_LIMITS.recordBytes / 4),
    '\\"'.repeat(CONTENT_LIMITS.recordBytes / 2), 'x'.repeat(CONTENT_LIMITS.recordBytes + 1)]) {
    assert.deepEqual(sanitizeObservation(full(payload, null)).content.input, { status: 'refused_size' });
  }
  const both = sanitizeObservation(full('x'.repeat(140000), 'y'.repeat(140000)));
  assert.deepEqual(both.content.input, { status: 'refused_size' });
  assert.deepEqual(both.content.output, { status: 'refused_size' });
});

test('schema-3 disk publication, offline replay and pinned SDK loopback preserve typed PII with no credentials on disk/wire', async t => {
  const stateDir = sandbox(t), local = await serverFixture(t);
  literalConfiguration();
  try {
    const source = full({ prompt: PROMPT, credentials: secretPayload() }, { response: RESPONSE, credentials: secretPayload() });
    const expected = sanitizeObservation(source);
    assert.equal(queueObservation(source, { stateDir }).privacy, 'full-content');
    const stored = bytes(stateDir), envelope = JSON.parse(stored);
    assert.equal(envelope.schema, 3); assert.deepEqual(envelope.record, expected);
    assertNoSecrets(stored); assertDiskNoSecrets(stateDir);
    for (const name of names(stateDir)) assert.equal(fs.statSync(path.join(stateDir, 'outbox', name)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(stateDir, 'outbox')).mode & 0o777, 0o700);
    const offline = await flushOutbox({ stateDir, dependencyRoot, credentials: null, env: {} });
    assert.equal(offline.status, 'offline'); assert.equal(bytes(stateDir), stored);
    assert.deepEqual(recoverOutbox({ stateDir }).records, [expected]);
    const result = await flushOutbox({ stateDir, dependencyRoot, credentials: local.credentials, env: {} });
    assert.equal(result.status, 'transport_accepted'); assert.equal(result.accepted, 1); assert.equal(result.verified, false);
    assert.equal(names(stateDir).length, 0);
    assert.equal(local.received.length, 1);
    const wire = local.received[0]; assertNoSecrets(wire.body.toString());
    const span = wire.request.resourceSpans[0].scopeSpans[0].spans[0], attrs = values(span);
    assert.equal(span.spanId, source.id); assert.equal(span.traceId, source.traceId);
    assert.deepEqual(JSON.parse(attrs['langfuse.observation.input']), expected.content.input.value);
    assert.deepEqual(JSON.parse(attrs['langfuse.observation.output']), expected.content.output.value);
    assert.equal(JSON.parse(attrs['langfuse.observation.metadata.privacy']), 'full-content');
    assert.equal(JSON.parse(attrs['langfuse.observation.metadata.inputStatus']), 'credential_redacted');
    assert.equal(JSON.parse(attrs['langfuse.observation.metadata.captureVersion']), 1);
    assert.equal(JSON.parse(attrs['langfuse.observation.metadata.harness']), 'pi');
  } finally { configurePrivacy(); }
});

test('SDK round trips all scalar JSON types, ordered arrays and refusal diagnostics without nullifying content', async t => {
  const stateDir = sandbox(t), seen = [];
  const samples = [null, '', false, true, 0, -12.5, PII.email, [], {}, RESPONSE];
  for (let i = 0; i < samples.length; i++) {
    assert.equal(queueObservation(full(samples[i], samples[i], { id: (i + 1).toString(16).padStart(16, '0') }), { stateDir }).queued, true);
  }
  const diagnostic = full('x'.repeat(CONTENT_LIMITS.recordBytes + 1), Buffer.from('synthetic'), { id: 'f'.repeat(16) });
  assert.equal(queueObservation(diagnostic, { stateDir }).queued, true);
  const result = await flush(stateDir, seen);
  assert.equal(result.accepted, samples.length + 1);
  for (let i = 0; i < samples.length; i++) {
    const attrs = seen.find(span => span.spanContext().spanId === (i + 1).toString(16).padStart(16, '0')).attributes;
    assert.deepEqual(JSON.parse(attrs['langfuse.observation.input']), samples[i]);
    assert.deepEqual(JSON.parse(attrs['langfuse.observation.output']), samples[i]);
  }
  const attrs = seen.find(span => span.spanContext().spanId === diagnostic.id).attributes;
  assert.equal(attrs['langfuse.observation.input'], undefined);
  assert.equal(attrs['langfuse.observation.output'], undefined);
  assert.equal(JSON.parse(attrs['langfuse.observation.metadata.inputStatus']), 'refused_size');
  assert.equal(JSON.parse(attrs['langfuse.observation.metadata.outputStatus']), 'unsupported');
});

test('near-cap escaped records bypass ambient SDK truncation and dynamically pack actual <=1MiB OTLP requests', async t => {
  const stateDir = sandbox(t), local = await serverFixture(t);
  // Worst-case extra wire escaping: lots of quote/backslash characters, plus
  // control characters, UTF-8 and line breaks. The payload exceeds common SDK
  // attribute length defaults; compare every byte, not only a prefix.
  const pattern = '\\"\u0000\n王😀';
  const overhead = Buffer.byteLength(JSON.stringify(sanitizeObservation(full('', null))));
  const escapedUnit = Buffer.byteLength(JSON.stringify(pattern)) - 2;
  const payload = pattern.repeat(Math.floor((CONTENT_LIMITS.recordBytes - overhead) / escapedUnit));
  const expected = sanitizeObservation(full(payload, null));
  assert.equal(expected.content.input.status, 'captured');
  for (let i = 1; i <= 8; i++) assert.equal(queueObservation(full(payload, null, { id: i.toString(16).padStart(16, '0') }), { stateDir }).queued, true);
  const prior = { value: process.env.OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT, count: process.env.OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT };
  process.env.OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT = '32'; process.env.OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT = '3';
  try {
    const result = await flushOutbox({ stateDir, dependencyRoot, credentials: local.credentials, env: {}, timeoutMs: 10000 });
    assert.equal(result.accepted, 8); assert.equal(result.queued, 0);
    assert.ok(local.received.length > 1, 'content batch must split before the 1MiB transport cap');
    let count = 0;
    for (const { body, request } of local.received) {
      assert.ok(body.length <= 1024 * 1024);
      for (const span of request.resourceSpans[0].scopeSpans[0].spans) {
        count++;
        assert.equal(JSON.parse(values(span)['langfuse.observation.input']), payload);
      }
    }
    assert.equal(count, 8);
  } finally {
    for (const [key, value] of [['OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT', prior.value], ['OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT', prior.count]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('outbox 4MiB capacity remains bounded with full records and admits after ACK progress', async t => {
  const stateDir = sandbox(t);
  const overhead = Buffer.byteLength(JSON.stringify(sanitizeObservation(full('', null))));
  const payload = 'x'.repeat(CONTENT_LIMITS.recordBytes - overhead);
  let admitted = 0, last;
  for (let i = 1; i <= 20; i++) {
    last = queueObservation(full(payload, null, { id: i.toString(16).padStart(16, '0') }), { stateDir });
    if (!last.queued) break;
    admitted++;
  }
  assert.equal(last.reason, 'capacity'); assert.equal(admitted, 15);
  const diskBytes = names(stateDir).reduce((sum, name) => sum + fs.statSync(path.join(stateDir, 'outbox', name)).size, 0);
  assert.ok(diskBytes <= OUTBOX_LIMITS.bytes);
  const result = await flush(stateDir);
  assert.equal(result.accepted, admitted); assert.equal(result.queued, 0);
  assert.equal(queueObservation(full(payload, null), { stateDir }).queued, true);
});

test('split requests ACK only successful exact versions; malformed/partial receipts retain rejected content', async t => {
  const stateDir = sandbox(t), local = await serverFixture(t);
  const payload = '\\"'.repeat(62000);
  for (let i = 1; i <= 6; i++) assert.equal(queueObservation(full(payload, PII, { id: i.toString(16).padStart(16, '0') }), { stateDir }).queued, true);
  local.setReceipt(index => index === 1 ? '{}' : '{"partialSuccess":{"rejectedSpans":1}}');
  const first = await flushOutbox({ stateDir, dependencyRoot, credentials: local.credentials, env: {} });
  assert.ok(first.accepted > 0 && first.failed > 0);
  assert.equal(first.queued, first.failed);
  const retained = bytes(stateDir);
  local.setReceipt(() => 'not-json');
  const malformed = await flushOutbox({ stateDir, dependencyRoot, credentials: local.credentials, env: {} });
  assert.equal(malformed.accepted, 0); assert.equal(bytes(stateDir), retained);
  local.setReceipt(() => '{}');
  const retry = await flushOutbox({ stateDir, dependencyRoot, credentials: local.credentials, env: {} });
  assert.equal(retry.accepted, first.failed); assert.equal(retry.queued, 0);
});

test('same-time content revisions, floors, replay failures and ACK retain complete latest typed payload', async t => {
  const stateDir = sandbox(t), seen = [];
  const older = full(PROMPT, 'old'), newer = full(PROMPT, RESPONSE);
  const [oldRevision, newRevision] = reserveRevisions([older, newer], { stateDir });
  assert.equal(queueObservation(newer, { stateDir, revision: newRevision }).queued, true);
  assert.equal(queueObservation(older, { stateDir, revision: oldRevision }).queued, true);
  const before = bytes(stateDir);
  const failed = await flush(stateDir, seen, { exporterFactory: captureFactory(seen, 1) });
  assert.equal(failed.accepted, 0); assert.equal(bytes(stateDir), before);
  assert.equal(queueObservation(older, { stateDir, revision: oldRevision }).obsolete, true);
  const replay = await flush(stateDir, seen);
  assert.equal(replay.accepted, 1); assert.equal(replay.queued, 0);
  assert.equal(seen.length, 2);
  for (const span of seen) assert.deepEqual(JSON.parse(span.attributes['langfuse.observation.output']), RESPONSE);
});

test('mixed canonical metadata/content replay never promotes schema 2; unsupported/truncated new finals stay intact', async t => {
  const stateDir = sandbox(t), seen = [];
  assert.equal(queueObservation(record(), { stateDir }).queued, true);
  assert.equal(queueObservation(full(PROMPT, RESPONSE, { id: 'f'.repeat(16) }), { stateDir }).queued, true);
  const mixed = await flush(stateDir, seen);
  assert.equal(mixed.accepted, 2);
  const metadata = seen.find(span => span.spanContext().spanId === record().id).attributes;
  assert.equal(metadata['langfuse.observation.input'], undefined);
  assert.equal(JSON.parse(metadata['langfuse.observation.metadata.privacy']), 'metadata-only');
  assert.equal(metadata['langfuse.environment'], 'metadata-only');
  assert.equal(metadata['langfuse.release'], 'metadata-only');
  for (const variant of ['promoted', 'legacy-raw', 'content-as-v2', 'unsupported-policy', 'unsupported-schema', 'truncated']) {
    const dir = path.join(sandbox(t), variant);
    assert.equal(queueObservation(variant === 'promoted' || variant === 'legacy-raw' ? record() : full(PROMPT, RESPONSE), { stateDir: dir }).queued, true);
    const file = path.join(dir, 'outbox', names(dir)[0]);
    const envelope = JSON.parse(fs.readFileSync(file));
    if (variant === 'promoted') envelope.schema = 3;
    if (variant === 'legacy-raw') envelope.record.content = content(PROMPT, RESPONSE);
    if (variant === 'content-as-v2') envelope.schema = 2;
    if (variant === 'unsupported-policy') envelope.record.content.version = 2;
    if (variant === 'unsupported-schema') envelope.schema = 4;
    const stored = variant === 'truncated' ? JSON.stringify(envelope).slice(0, -20) : JSON.stringify(envelope);
    fs.writeFileSync(file, stored);
    const result = await flush(dir);
    assert.equal(result.accepted, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), stored);
    assert.equal(result.status, variant === 'truncated' ? 'legacy_outbox_inspection_required' : 'invalid_outbox');
  }
});

test('large v3 orphan slots are bounded uncommitted publications, never promoted; ambiguous oversized legacy slots remain', t => {
  const stateDir = sandbox(t);
  const projected = sanitizeObservation(full('x'.repeat(220000), RESPONSE));
  const [revision] = reserveRevisions([projected], { stateDir });
  const dir = path.join(stateDir, 'outbox');
  const slot = path.join(dir, '.outbox-v1.tmp');
  const envelope = JSON.stringify({ schema: 3, version: 'b'.repeat(32), revision, record: projected });
  for (const stored of [envelope.slice(0, 20000), envelope]) {
    fs.writeFileSync(slot, stored, { mode: 0o600 });
    const recovered = recoverOutbox({ stateDir });
    assert.equal(recovered.recovered, 1); assert.deepEqual(recovered.records, []);
    assert.equal(fs.existsSync(slot), false); assert.deepEqual(names(stateDir), []);
  }
  const legacy = '{'.padEnd(LIMITS.recordBytes + 513, ' ');
  fs.writeFileSync(slot, legacy, { mode: 0o600 });
  assert.throws(() => recoverOutbox({ stateDir }), /publication preserved/);
  assert.equal(fs.readFileSync(slot, 'utf8'), legacy);
});

function injectedExporter({ filesystem = {}, dependencies } = {}) {
  const file = require.resolve('../runtime/langfuse/export.cjs');
  const localRequire = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: id => id === 'node:fs' ? { ...fs, ...filesystem }
      : id === './dependencies.cjs' && dependencies ? dependencies : localRequire(id),
    module, exports: module.exports, process, Buffer, URL, AbortController, JSON,
    SharedArrayBuffer, Int32Array, Atomics, setTimeout, clearTimeout
  }, { filename: file });
  return module.exports;
}

test('every managed disk write is redacted before publication, not only after replay', t => {
  const stateDir = sandbox(t), writes = [];
  literalConfiguration();
  try {
    const api = injectedExporter({ filesystem: { writeFileSync(fd, data, ...rest) {
      writes.push(Buffer.from(data).toString('utf8'));
      return fs.writeFileSync(fd, data, ...rest);
    } } });
    assert.equal(api.queueObservation(full(secretPayload(), secretPayload()), { stateDir }).queued, true);
    assert.ok(writes.length >= 2, 'ledger and outbox publication must both be exercised');
    for (const stored of writes) assertNoSecrets(stored);
    assertDiskNoSecrets(stateDir);
  } finally { configurePrivacy(); }
});

test('wire revalidation explicitly fails a changed SDK input instead of ACKing a truncated prefix', async t => {
  const stateDir = sandbox(t), seen = [];
  assert.equal(queueObservation(full(PROMPT, RESPONSE), { stateDir }).queued, true);
  const stored = bytes(stateDir);
  const realDependencies = require('../runtime/langfuse/dependencies.cjs');
  const sdk = realDependencies.loadDependencies({ dependencyRoot });
  class TruncatingProvider extends sdk.NodeTracerProvider {
    getTracer(...args) {
      const tracer = super.getTracer(...args);
      return { startSpan(...args) {
        const span = tracer.startSpan(...args), end = span.end.bind(span);
        span.end = (...args) => { span.setAttribute('langfuse.observation.input', '"prefix"'); return end(...args); };
        return span;
      } };
    }
  }
  const api = injectedExporter({ dependencies: { loadDependencies: () => ({ ...sdk, NodeTracerProvider: TruncatingProvider }) } });
  const failed = await api.flushOutbox({ stateDir, dependencyRoot, env: {}, exporterFactory: captureFactory(seen) });
  assert.equal(failed.reason, 'sdk_content_mismatch'); assert.equal(failed.accepted, 0);
  assert.equal(seen.length, 0); assert.equal(bytes(stateDir), stored);
  assert.equal((await flush(stateDir, seen)).accepted, 1);
  assert.deepEqual(JSON.parse(seen[0].attributes['langfuse.observation.input']), PROMPT);
});
