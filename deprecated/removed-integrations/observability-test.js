#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const emitter = require('../../templates/observability/emit');
const dashboard = require('../../templates/observability/dashboard');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-brain-observability-'));
}

test('emitEvent appends a normalized metadata-only event', () => {
  const dir = tempDir();
  const eventFile = path.join(dir, 'events.jsonl');
  const event = emitter.emitEvent({
    schema_version: '1.0',
    type: 'skill.loaded',
    agent_id: 'staff-ENG-42-1',
    session_id: 'session-1',
    artifact: {
      kind: 'skill',
      name: 'test-driven-development',
      path: 'skills/test-driven-development/SKILL.md',
      bytes: 1200,
      tokens: 310,
      token_measurement: 'exact'
    }
  }, { eventFile, now: () => '2026-09-12T10:15:00.000Z', id: () => 'event-1' });

  assert.equal(event.event_id, 'event-1');
  assert.equal(event.timestamp, '2026-09-12T10:15:00.000Z');
  assert.deepEqual(emitter.readEvents(eventFile), [event]);
});

test('emitEvent rejects content payloads and leaves the event file unchanged', () => {
  const dir = tempDir();
  const eventFile = path.join(dir, 'events.jsonl');

  assert.throws(() => emitter.emitEvent({
    schema_version: '1.0',
    type: 'turn.completed',
    agent_id: 'ceo',
    session_id: 'session-1',
    prompt: 'secret prompt'
  }, { eventFile }), /unsupported field "prompt"/);
  assert.equal(fs.existsSync(eventFile), false);
});

test('validateEvent enforces nested enum values from the event contract', () => {
  const base = {
    schema_version: '1.0', event_id: 'event-1', timestamp: '2026-09-12T10:15:00.000Z',
    type: 'tool.completed', agent_id: 'ceo', session_id: 'session-1'
  };
  assert.throws(
    () => emitter.validateEvent({ ...base, tool: { name: 'git', outcome: 'maybe' } }),
    /unsupported tool outcome/
  );
  assert.throws(
    () => emitter.validateEvent({ ...base, usage: { source: 'guess' } }),
    /unsupported usage source/
  );
});

test('summarize builds the organization tree and aggregates usage without inventing values', () => {
  const registry = [
    { agent_id: 'ceo', role: 'ceo', parent: 'user', status: 'RUNNING', runtime: 'herdr', runtime_ref: 'chief' },
    { agent_id: 'pm-ENG-42-1', role: 'product-manager', parent: 'ceo', status: 'RUNNING', runtime: 'herdr', runtime_ref: 'pm' },
    { agent_id: 'staff-ENG-42-1', role: 'backend-staff-engineer', parent: 'pm-ENG-42-1', status: 'WAITING', runtime: '', runtime_ref: '' }
  ];
  const events = [
    { schema_version: '1.0', event_id: '1', timestamp: '2026-09-12T10:00:00Z', type: 'agent.started', agent_id: 'ceo', session_id: 's', parent_agent_id: 'user' },
    { schema_version: '1.0', event_id: '2', timestamp: '2026-09-12T10:01:00Z', type: 'skill.loaded', agent_id: 'pm-ENG-42-1', session_id: 's', artifact: { kind: 'skill', name: 'prd-writing', bytes: 800, tokens: 200, token_measurement: 'exact' } },
    { schema_version: '1.0', event_id: '3', timestamp: '2026-09-12T10:02:00Z', type: 'document.loaded', agent_id: 'pm-ENG-42-1', session_id: 's', artifact: { kind: 'document', path: 'SPEC.md', bytes: 400, token_measurement: 'unknown' } },
    { schema_version: '1.0', event_id: '4', timestamp: '2026-09-12T10:03:00Z', type: 'turn.completed', agent_id: 'pm-ENG-42-1', session_id: 's', turn: { number: 1, duration_ms: 1500, outcome: 'success' }, context: { input_tokens: 900, window_tokens: 200000, token_measurement: 'exact' } },
    { schema_version: '1.0', event_id: '5', timestamp: '2026-09-12T10:04:00Z', type: 'model.completed', agent_id: 'pm-ENG-42-1', session_id: 's', model: 'claude-fable-5-1', usage: { input_tokens: 900, output_tokens: 120, cost_usd: 0.04, source: 'provider' } },
    { schema_version: '1.0', event_id: '6', timestamp: '2026-09-12T10:05:00Z', type: 'tool.completed', agent_id: 'pm-ENG-42-1', session_id: 's', tool: { name: 'linear.create_issue', outcome: 'error', duration_ms: 50 } }
  ];

  const summary = dashboard.summarize(registry, events, Date.parse('2026-09-12T10:06:00Z'));
  assert.equal(summary.agents.length, 3);
  assert.equal(summary.tree[0].agent_id, 'ceo');
  assert.equal(summary.tree[0].children[0].agent_id, 'pm-ENG-42-1');
  assert.equal(summary.tree[0].children[0].children[0].agent_id, 'staff-ENG-42-1');

  const pm = summary.agents.find(agent => agent.agent_id === 'pm-ENG-42-1');
  assert.deepEqual(pm.skills, ['prd-writing']);
  assert.deepEqual(pm.documents, ['SPEC.md']);
  assert.equal(pm.skill_context_tokens, 200);
  assert.equal(pm.document_context_tokens, 'UNKNOWN');
  assert.equal(pm.latest_context_input_tokens, 900);
  assert.equal(pm.context_window_tokens, 200000);
  assert.equal(pm.turns, 1);
  assert.equal(pm.tool_calls, 1);
  assert.equal(pm.tool_failures, 1);
  assert.equal(pm.model_input_tokens, 900);
  assert.equal(pm.model_output_tokens, 120);
  assert.equal(pm.cost_usd, 0.04);

  const staff = summary.agents.find(agent => agent.agent_id === 'staff-ENG-42-1');
  assert.equal(staff.model_input_tokens, 'UNKNOWN');
  assert.equal(staff.cost_usd, 'UNKNOWN');
});

test('controlAgent maps explicit actions to Herdr argv and protects interrupts', () => {
  const agent = { agent_id: 'ceo', runtime: 'herdr', runtime_ref: 'chief' };
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
  };

  dashboard.controlAgent(agent, { action: 'focus' }, run);
  dashboard.controlAgent(agent, { action: 'steer', text: 'Check the failing test.' }, run);
  assert.throws(() => dashboard.controlAgent(agent, { action: 'interrupt' }, run), /requires --confirm/);
  dashboard.controlAgent(agent, { action: 'interrupt', confirm: true }, run);

  assert.deepEqual(calls, [
    ['herdr', ['agent', 'focus', 'chief']],
    ['herdr', ['agent', 'prompt', 'chief', 'Check the failing test.']],
    ['herdr', ['agent', 'send-keys', 'chief', 'ctrl+c']]
  ]);
});

test('controlAgent resolves and closes a Herdr pane only for a confirmed stop', () => {
  const agent = { agent_id: 'ceo', runtime: 'herdr', runtime_ref: 'chief' };
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'agent' && args[1] === 'get') {
      return { status: 0, stdout: '{"result":{"agent":{"pane_id":"w1:p2"}}}\n', stderr: '' };
    }
    return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
  };

  assert.throws(() => dashboard.controlAgent(agent, { action: 'stop' }, run), /requires --confirm/);
  dashboard.controlAgent(agent, { action: 'stop', confirm: true }, run);
  assert.deepEqual(calls, [
    ['herdr', ['agent', 'get', 'chief']],
    ['herdr', ['pane', 'close', 'w1:p2']]
  ]);
});

test('controlAgent refuses agents without a supported runtime binding', () => {
  assert.throws(
    () => dashboard.controlAgent({ agent_id: 'ceo', runtime: '', runtime_ref: '' }, { action: 'focus' }),
    /no Herdr runtime binding/
  );
});
