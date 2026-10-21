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
