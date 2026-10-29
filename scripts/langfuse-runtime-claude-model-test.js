'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createFlow } = require('../runtime/langfuse/flow.cjs');
const { handleClaudeHook } = require('../runtime/langfuse/claude.cjs');

function fixture(t) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-claude-model-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const records = [], sessionId = crypto.randomUUID();
  let now = Date.now();
  const flow = createFlow({ harness: 'claude', cwd, stateDir: path.join(cwd, 'state'), env: {},
    clock: () => ++now,
    queueObservation: record => { records.push(record); return { queued: true }; },
    flushOutbox: async () => ({ accepted: 0, verified: false }) });
  const hook = (event, extra = {}) => handleClaudeHook({ cwd, session_id: sessionId,
    hook_event_name: event, ...extra }, { flow, clock: () => ++now });
  return { cwd, records, flow, sessionId, hook };
}

for (const name of ['claude-opus-4-6', 'claude-opus-5-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']) {
  test(`known context-window suffix is canonical across real hook/state/export boundaries: ${name}`, async t => {
    const { cwd, records, flow, sessionId, hook } = fixture(t);
    await hook('SessionStart', { model: `${name}[1m]` });
    assert.equal(flow.session(sessionId).requestedModel, name);
    await hook('PostModelSwitch', { to_model: `${name}[1m]` });
    const file = path.join(cwd, 'transcript.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'assistant', timestamp: Date.now(), message: {
      id: 'exact-native-message', model: `${name}[1m]`, usage: { input_tokens: 2, output_tokens: 3 },
      content: [{ type: 'text', text: 'CANARY_PRIVATE_COMPLETION' }] } }) + '\n');
    await hook('Stop', { transcript_path: file });
    assert.equal(flow.session(sessionId).observedModel, name);
    const generations = records.filter(record => record.type === 'GENERATION');
    assert.equal(generations.length, 1);
    assert.equal(generations[0].model, name);
    assert.deepEqual(generations[0].usage, { input: 2, output: 3 });
    await hook('SessionEnd', { transcript_path: file });
    assert.equal(records.filter(record => record.type === 'GENERATION').length, 1, 'cursor advances without replaying a rejected row');
    assert.equal(JSON.stringify(records).includes('[1m]'), false);
    assert.equal(JSON.stringify(records).includes('CANARY_PRIVATE_COMPLETION'), false);
  });
}

test('unknown or unsafe model variants are omitted without aborting reconciliation', async t => {
  const { cwd, records, hook } = fixture(t);
  await hook('SessionStart', { model: 'claude-opus-4-6[unsupported]' });
  await hook('PostModelSwitch', { to_model: 'CANARY_PRIVATE_PROVIDER' });
  const file = path.join(cwd, 'transcript.jsonl');
  fs.writeFileSync(file, ['claude-opus-4-6[unsupported]', 'CANARY_PRIVATE_PROVIDER', 'claude-sonnet-4-6[1m]'].map((model, i) => JSON.stringify({
    type: 'assistant', timestamp: Date.now(), message: { id: `native-message-${i}`, model,
      usage: { input_tokens: 1, output_tokens: 1 }, content: [] }
  })).join('\n') + '\n');
  await hook('Stop', { transcript_path: file });
  const generations = records.filter(record => record.type === 'GENERATION');
  assert.equal(generations.length, 3);
  assert.equal(generations[0].model, undefined);
  assert.equal(generations[1].model, undefined);
  assert.equal(generations[2].model, 'claude-sonnet-4-6');
  assert.equal(JSON.stringify(records).includes('CANARY_PRIVATE_PROVIDER'), false);
});

test('known to unsupported switch invalidates current attribution across restart without rewriting history', async t => {
  const f = fixture(t);
  await f.hook('SessionStart', { model: 'claude-opus-5-5[1m]' });
  const transcript = path.join(f.cwd, 'historical.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: Date.now(), message: {
    id: 'historical-native-message', model: 'claude-opus-5-5', usage: { input_tokens: 2, output_tokens: 3 }, content: []
  } }) + '\n');
  await f.hook('PostModelSwitch', { to_model: 'unrecognized-gateway-model' });
  assert.equal(f.flow.session(f.sessionId).requestedModel, null);
  assert.equal(f.flow.session(f.sessionId).observedModel, null);
  // A new process reopens the actual durable checkpoint; no in-memory model
  // variable can hide a stale value. Reconcile previously unread history too.
  const flow = createFlow({ harness: 'claude', cwd: f.cwd, stateDir: path.join(f.cwd, 'state'), env: {},
    queueObservation: record => { f.records.push(record); return { queued: true }; },
    flushOutbox: async () => ({ accepted: 0, verified: false }) });
  await handleClaudeHook({ cwd: f.cwd, session_id: f.sessionId, hook_event_name: 'Stop', transcript_path: transcript }, { flow });
  const actor = f.records.filter(record => record.type === 'AGENT').at(-1);
  assert.equal(actor.model, undefined);
  assert.equal(actor.context.requestedModel, undefined);
  assert.equal(actor.context.observedModel, undefined);
  const generation = f.records.find(record => record.type === 'GENERATION');
  assert.equal(generation.model, 'claude-opus-5-5');
  assert.equal(generation.context.observedModel, 'claude-opus-5-5');
  assert.deepEqual(generation.usage, { input: 2, output: 3 });
  const files = fs.readdirSync(path.join(f.cwd, 'state', 'adapters')).filter(name => name.endsWith('.json'));
  assert.ok(files.every(name => !fs.readFileSync(path.join(f.cwd, 'state', 'adapters', name), 'utf8').includes('unrecognized-gateway-model')));
});

test('unsupported to known switch restores current model and ordinary hooks retain it', async t => {
  const { hook, records, flow, sessionId } = fixture(t);
  await hook('SessionStart', { model: 'claude-opus-5-5' });
  await hook('PostModelSwitch', { to_model: 'unrecognized-gateway-model' });
  await hook('Stop');
  assert.equal(records.filter(record => record.type === 'AGENT').at(-1).model, undefined);
  await hook('PostModelSwitch', { to_model: 'claude-sonnet-4-6[1m]' });
  await hook('Stop');
  const actor = records.filter(record => record.type === 'AGENT').at(-1);
  assert.equal(actor.model, 'claude-sonnet-4-6');
  assert.equal(actor.context.requestedModel, 'claude-sonnet-4-6');
  assert.equal(flow.session(sessionId).requestedModel, 'claude-sonnet-4-6');
  assert.equal(JSON.stringify(records).includes('unrecognized-gateway-model'), false);
});
