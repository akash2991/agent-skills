'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { nativePersona } = require('./lib/persona-tools');
const { createController } = require('../runtime/langfuse/pi.js');
const { createFlow } = require('../runtime/langfuse/flow.cjs');
const { ContextStore } = require('../runtime/langfuse/context.cjs');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-persona-context-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(cwd, '.agent-brain/observability'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.agent-brain/tracing.json'), JSON.stringify({ schema: 1, enabled: true, captureMode: 'metadata-only' }));
  fs.writeFileSync(path.join(cwd, '.agent-brain/observability/pi.js'), '// discovery sentinel; never executed');
  const source = fs.readFileSync(path.join(__dirname, '../agents/product-manager.md'), 'utf8');
  const piPersona = nativePersona(source, 'pi');
  fs.mkdirSync(path.join(cwd, '.pi/agents'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pi/agents/product-manager.md'), piPersona);
  return { cwd, stateDir, source, piPersona };
}
function harness(f, flow) {
  const registered = new Map();
  const controller = createController({ on() {}, registerFlag() {}, registerTool: tool => registered.set(tool.name, tool) }, { flow });
  const ctx = { cwd: f.cwd, model: { id: 'synthetic-model', provider: 'synthetic-provider' }, thinkingLevel: 'low', hasUI: false,
    isProjectTrusted: () => true, sessionManager: { getSessionId: () => '550e8400-e29b-41d4-a716-446655440000' } };
  return { controller, registered, ctx };
}
test('materialized shell-less Pi persona selects the actual context operation and can establish a new ticket without Bash', async t => {
  const f = fixture(t);
  const flow = createFlow({ harness: 'pi', cwd: f.cwd, stateDir: f.stateDir, env: {}, flushOutbox: async () => ({ accepted: 0 }) });
  const h = harness(f, flow);
  const names = f.piPersona.match(/^tools: (.*)$/m)[1].split(',').map(name => name.trim());
  assert.equal(names.includes('bash'), false);
  assert.equal(names.filter(name => name === 'brain_context').length, 1);
  // Synthetic registry intersection matches the inspected native SDK contract;
  // this exercises the real registered runtime operation, not native inference.
  const active = names.flatMap(name => h.registered.has(name) ? [h.registered.get(name)] : []);
  assert.equal(active.length, 1);
  assert.equal(active[0], h.controller.getContextTool());
  const first = await active[0].execute('context', { persona: 'product-manager', ticketId: 'TEST-17' }, undefined, undefined, h.ctx);
  assert.equal(first.details.persona, 'product-manager');
  assert.equal(first.details.ticketId, 'TEST-17');
  const next = await active[0].execute('context', { ticketId: 'TEST-18' }, undefined, undefined, h.ctx);
  assert.equal(next.details.ticketId, 'TEST-18');
  assert.equal(next.details.ticketSource, 'explicit');
  const absent = new Map();
  assert.deepEqual(names.filter(name => absent.has(name)), [], 'the declaration does not register/enable tracing when the extension is absent');
  assert.doesNotMatch(nativePersona(f.source, 'claude'), /^tools:.*\bBash\b/m);
});
test('materialized context declaration still obeys native trust, explicit refusal and kill switches', async t => {
  const f = fixture(t);
  const untouched = new Proxy({}, { get() { throw new Error('disabled operation must not touch capture state'); } });
  const h = harness(f, untouched);
  const tool = h.controller.getContextTool();
  const invoke = ctx => tool.execute('context', { persona: 'product-manager', ticketId: 'TEST-17' }, undefined, undefined, ctx);
  assert.equal((await invoke({ ...h.ctx, isProjectTrusted: () => false })).details, undefined);
  fs.writeFileSync(path.join(f.cwd, '.agent-brain/tracing.json'), JSON.stringify({ schema: 1, enabled: false, captureMode: 'metadata-only' }));
  assert.equal((await invoke(h.ctx)).details, undefined);
  fs.writeFileSync(path.join(f.cwd, '.agent-brain/tracing.json'), JSON.stringify({ schema: 1, enabled: true, captureMode: 'metadata-only' }));
  const previous = process.env.BRAIN_TRACING_ENABLED;
  try { process.env.BRAIN_TRACING_ENABLED = 'false'; assert.equal((await invoke(h.ctx)).details, undefined); }
  finally { if (previous === undefined) delete process.env.BRAIN_TRACING_ENABLED; else process.env.BRAIN_TRACING_ENABLED = previous; }
  assert.equal(fs.existsSync(f.stateDir), false);
});
test('shell-less Claude metadata distinguishes exact inherited, explicit new and unknown tickets without a shell grant', t => {
  const f = fixture(t), store = new ContextStore({ stateDir: f.stateDir });
  const begin = extra => store.createRun({ cwd: f.cwd, harness: 'claude', nativeSessionId: crypto.randomUUID(), ...extra });
  assert.doesNotMatch(nativePersona(f.source, 'claude'), /^tools:.*\bBash\b/m);
  const parent = begin({ ticketId: 'TEST-17' });
  const inherited = begin({ parent, persona: 'product-manager' });
  assert.equal(inherited.parentSpanId, parent.rootSpanId);
  assert.equal(inherited.ticketId, 'TEST-17');
  assert.equal(inherited.ticketSource, 'explicit');
  assert.equal(store.getRun(inherited.runId).ticketId, 'TEST-17', 'no unavailable child operation silently establishes a different ticket');
  const explicit = begin({ parent, persona: 'product-manager', ticketId: 'TEST-18' });
  assert.equal(explicit.ticketId, 'TEST-18', 'supported explicit launch metadata is distinct from inheritance');
  assert.equal(store.getRun(parent.runId).ticketId, 'TEST-17');
  const unknownParent = begin({});
  const unknown = begin({ parent: unknownParent, persona: 'product-manager' });
  assert.equal(unknown.ticketId, null);
  assert.equal(unknown.ticketSource, 'unknown');
});
