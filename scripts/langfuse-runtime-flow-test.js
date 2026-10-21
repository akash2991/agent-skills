'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createFlow } = require('../runtime/langfuse/flow.cjs');

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

test('pane handoff is scoped to exact native session and pane; acknowledgement is startup only', t => {
  const f = fixture(t); const parentFlow = f.flow('pi');
  const parent = parentFlow.begin({ nativeSessionId: crypto.randomUUID(), cwd: f.cwd });
  const session = crypto.randomUUID(); const binding = parentFlow.store.createLaunch(parent, { launchId: `brain:claude:${session}`, multiUse: true });
  parentFlow.writeState(`pane:${binding.nonce}`, { paneId: 'w1:p2', expiresAt: Date.now() + 60000 });
  const childFlow = f.flow('claude', { BRAIN_TRACE_LAUNCH_ID: binding.nonce, HERDR_PANE_ID: 'w1:p2' });
  assert.equal(childFlow.acknowledgeSession(session), true);
  const ack = childFlow.readState(`launch-ack:${binding.nonce}`);
  assert.equal(ack.phase, 'adapter-started'); assert.equal(ack.harness, 'claude');
  const child = childFlow.begin({ nativeSessionId: session, cwd: f.cwd });
  assert.equal(child.traceId, parent.traceId); assert.equal(child.parentSpanId, parent.rootSpanId);
  assert.throws(() => childFlow.begin({ nativeSessionId: crypto.randomUUID(), cwd: f.cwd }), /Scoped launch/);
  const wrongPane = f.flow('claude', { BRAIN_TRACE_LAUNCH_ID: binding.nonce, HERDR_PANE_ID: 'w1:p3' });
  assert.throws(() => wrongPane.begin({ nativeSessionId: session, cwd: f.cwd }), /Scoped launch/);
});
