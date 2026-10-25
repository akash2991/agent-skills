'use strict';

// Synthetic, offline fixtures only. No SDK discovery, home configuration,
// credentials, model calls, dependency preparation or network transport.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { sanitizeObservation, configurePrivacy, CONTEXT_FIELDS, LIMITS } = require('../runtime/langfuse/privacy.cjs');
const { createFlow } = require('../runtime/langfuse/flow.cjs');
const { queueObservation } = require('../runtime/langfuse/export.cjs');
const fields = ['skillsInvoked', 'skillsLoaded'];
const names = count => Array.from({ length: count }, (_, i) => `skill-${String(i).padStart(3, '0')}`);
const base = context => ({ id: '0123456789abcdef', traceId: '0123456789abcdef0123456789abcdef', parentId: null,
  sessionId: 'synthetic-session', nativeSessionId: crypto.randomUUID(), type: 'GENERATION',
  startTime: 1700000000000, endTime: 1700000001000, context });
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-skill-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function records(stateDir) {
  return fs.readdirSync(path.join(stateDir, 'outbox')).map(file =>
    JSON.parse(fs.readFileSync(path.join(stateDir, 'outbox', file), 'utf8')).record);
}
function stable(record) {
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= LIMITS.recordBytes);
  assert.deepEqual(sanitizeObservation(record), record);
  assert.deepEqual(sanitizeObservation(sanitizeObservation(record)), record);
}

test('32/33/128/129 entries retain both bounded prefixes with stable enum diagnostics', t => {
  const stateDir = sandbox(t);
  for (const count of [32, 33, 128, 129]) {
    const input = { ...base(Object.fromEntries(fields.map(field => [field, names(count)]))),
      id: count.toString(16).padStart(16, '0') };
    const safe = sanitizeObservation(input);
    for (const field of fields) {
      assert.deepEqual(safe.context[field], names(32));
      assert.equal(safe.context[`${field}Status`], count > 128 ? 'refused' : count > 32 ? 'truncated' : undefined);
    }
    stable(safe);
    assert.equal(queueObservation(input, { stateDir }).queued, true);
    let queued = records(stateDir).find(record => record.id === input.id && record.traceId === input.traceId);
    assert.deepEqual(queued, safe);
    // Exercise actual queue admission/versioning again on the projected record.
    assert.equal(queueObservation(queued, { stateDir }).queued, true);
    queued = records(stateDir).find(record => record.id === input.id && record.traceId === input.traceId);
    assert.deepEqual(queued, safe);
  }
});

test('actual capture and durable store preserve earlier evidence at 32/33/128 and overflow refusal', t => {
  const root = sandbox(t), cwd = path.join(root, 'project'), stateDir = path.join(root, 'state');
  fs.mkdirSync(cwd);
  const options = { cwd, stateDir, harness: 'pi', env: {},
    flushOutbox: async () => ({ accepted: 0, queued: 0, verified: false }) };
  let flow = createFlow(options);
  let run = flow.begin({ cwd, nativeSessionId: crypto.randomUUID() });
  for (let i = 0; i < 128; i++) {
    const skill = names(i + 1)[i];
    run = flow.captureSkill(run, { success: true, toolName: 'Skill', input: { skill } });
    run = flow.captureSkill(run, { success: true, toolName: 'Read', input: { path: `.agents/skills/${skill}/SKILL.md` } });
    if (![32, 33, 128].includes(i + 1)) continue;
    flow = createFlow(options); // Reload the durable store rather than trusting the returned capture.
    run = flow.store.getRun(run.runId);
    for (const field of fields) assert.deepEqual(run[field], names(i + 1));
    const record = { ...base(run), id: flow.id(), traceId: run.traceId, parentId: run.rootSpanId };
    assert.equal(flow.submit(run, [record]).queued, 1);
    const queued = records(stateDir).find(item => item.id === record.id);
    for (const field of fields) {
      assert.deepEqual(queued.context[field], names(32));
      assert.equal(queued.context[`${field}Status`], i + 1 > 32 ? 'truncated' : undefined);
    }
    stable(queued);
  }
  // Context rejects an oversized union atomically. Existing flow capture caps
  // at 128; neither path may destroy the previous durable evidence.
  for (const field of fields) {
    assert.throws(() => flow.update(run, { [field]: names(129) }));
    assert.deepEqual(flow.store.getRun(run.runId)[field], names(128));
  }
  run = flow.captureSkill(run, { success: true, toolName: 'Skill', input: { skill: 'skill-128' } });
  run = flow.captureSkill(run, { success: true, toolName: 'Read', input: { path: '.agents/skills/skill-128/SKILL.md' } });
  for (const field of fields) assert.deepEqual(run[field], names(128));
  const record = { ...base(run), id: flow.id(), traceId: run.traceId, parentId: run.rootSpanId };
  assert.equal(flow.submit(run, [record]).queued, 1);
  for (const field of fields) assert.equal(records(stateDir).find(item => item.id === record.id).context[`${field}Status`], 'truncated');
});

test('pending capture diagnostics survive restart, late binding, and real outbox admission', async t => {
  const root = sandbox(t), cwd = path.join(root, 'project'), stateDir = path.join(root, 'state');
  fs.mkdirSync(cwd);
  const options = { cwd, stateDir, harness: 'pi', env: {},
    flushOutbox: async () => ({ accepted: 0, queued: 0, verified: false }) };
  let flow = createFlow(options);
  const parent = flow.begin({ cwd, nativeSessionId: crypto.randomUUID() });
  let child = flow.begin({ cwd, nativeSessionId: crypto.randomUUID(), pendingIdentity: 'exact-skill-child' });
  child = flow.update(child, { skillsInvoked: names(128), skillsLoaded: names(128) });
  const record = { ...base(child), id: flow.id(), traceId: child.traceId, parentId: child.rootSpanId };
  assert.equal(flow.submit(child, [record]).pending, 1);
  const pendingDir = path.join(stateDir, 'adapters', 'pending');
  const pending = JSON.parse(fs.readFileSync(path.join(pendingDir, fs.readdirSync(pendingDir)[0]), 'utf8')).records[0];
  for (const field of fields) {
    assert.deepEqual(pending.context[field], names(32));
    assert.equal(pending.context[`${field}Status`], 'truncated');
  }
  stable(pending);
  flow = createFlow(options);
  flow.store.createLaunch(parent, { launchId: 'exact-skill-child', multiUse: true });
  await flow.flush();
  const queued = records(stateDir).find(item => item.id === record.id);
  assert.equal(queued.traceId, parent.traceId);
  for (const field of fields) {
    assert.deepEqual(queued.context[field], names(32));
    assert.equal(queued.context[`${field}Status`], 'truncated');
  }
  stable(queued);
});

test('wide valid names and maximal metadata fit the byte budget without losing all prior evidence', () => {
  const wide = names(128).map(name => `${name}-${'z'.repeat(118)}`);
  assert.equal(wide[0].length, 128);
  const context = Object.fromEntries(CONTEXT_FIELDS.map(field => [field, 'z'.repeat(128)]));
  for (const field of fields) context[field] = wide;
  const metrics = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`metric_${String(i).padStart(2, '0')}_${'z'.repeat(38)}`, 1e12]));
  const safe = sanitizeObservation({ ...base(context), model: 'z'.repeat(128), provider: 'z'.repeat(128), toolName: 'z'.repeat(128), usage: metrics, cost: metrics });
  for (const field of fields) {
    assert.ok(safe.context[field].length > 0 && safe.context[field].length <= 32);
    assert.ok(safe.context[field].every(name => wide.includes(name)));
    assert.equal(safe.context[`${field}Status`], 'truncated');
  }
  stable(safe);
});

test('private, invalid, getter and arbitrary diagnostic values never enter projected or queued evidence', t => {
  const stateDir = sandbox(t);
  const canaries = ['password=SYNTHETIC_ONLY', 'synthetic.person@example.invalid', 'private-skill-canary'];
  configurePrivacy({ sensitiveLiterals: [canaries[2]] });
  try {
    for (const field of fields) {
      const privateValues = canaries.flatMap(value => [value, encodeURIComponent(value),
        Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'),
        Buffer.from(value).toString('hex'),
        Buffer.from(Buffer.from(value).toString('base64url')).toString('base64url')]);
      const list = ['prior-valid', ...privateValues, null];
      Object.defineProperty(list, String(list.length), { get() { throw new Error('must not read'); } });
      const safe = sanitizeObservation(base({ [field]: list, [`${field}Status`]: canaries[0], arbitraryStatus: canaries[0] }));
      assert.deepEqual(safe.context, { [field]: ['prior-valid'], [`${field}Status`]: 'filtered' });
      stable(safe);
      assert.equal(queueObservation(safe, { stateDir }).queued, true);
      for (const record of records(stateDir)) for (const canary of privateValues) assert.ok(!JSON.stringify(record).includes(canary));
      for (const status of ['filtered', 'truncated', 'refused']) {
        const replay = sanitizeObservation(base({ [field]: ['prior-valid'], [`${field}Status`]: status }));
        assert.equal(replay.context[`${field}Status`], status); stable(replay);
      }
      const empty = sanitizeObservation(base({ [field]: [] }));
      assert.equal(empty.context, undefined);
      const invalid = sanitizeObservation(base({ [field]: [canaries[0]] }));
      assert.deepEqual(invalid.context, { [`${field}Status`]: 'filtered' });
      const refused = sanitizeObservation(base({ [field]: { private: canaries[0] } }));
      assert.deepEqual(refused.context, { [`${field}Status`]: 'refused' });
      const oversized = ['prior-valid']; oversized.length = 1e9;
      const bounded = sanitizeObservation(base({ [field]: oversized }));
      assert.deepEqual(bounded.context, { [field]: ['prior-valid'], [`${field}Status`]: 'refused' });
      stable(bounded);
      for (const status of [canaries[0], {}, ['truncated'], true, 1]) {
        assert.equal(sanitizeObservation(base({ [`${field}Status`]: status })).context, undefined);
      }
    }
  } finally { configurePrivacy(); }
});
