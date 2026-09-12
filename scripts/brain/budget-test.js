#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const emitter = require('../../templates/observability/emit');
const budget = require('../../templates/observability/budget');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-brain-budget-'));
  const registryDir = path.join(dir, 'registry'); fs.mkdirSync(registryDir);
  fs.writeFileSync(path.join(registryDir, 'BUDGET.md'), fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'registry', 'BUDGET.md'), 'utf8')
    .replace('| ceo | user | 100000 | 100000 | UNKNOWN | company | (project start) | company budget; CEO keeps an unallocated reserve for itself, PMs, EMs, and hires |',
      '| ceo | user | 100000 | 100000 | UNKNOWN | company | t0 | company |\n| em-api-1 | ceo | 40000 | 40000 | UNKNOWN | team api | t0 | |\n| staff-ENG-42-1 | em-api-1 | 10000 | 10000 | UNKNOWN | ENG-42 | t0 | |'));
  fs.writeFileSync(path.join(registryDir, 'AGENT_REGISTRY.md'), '## Active\n\n| agent_id | role | parent | status |\n|---|---|---|---|\n| ceo | ceo | user | RUNNING |\n| em-api-1 | engineering-manager | ceo | RUNNING |\n| staff-ENG-42-1 | backend-staff-engineer | em-api-1 | RUNNING |\n| staff-ENG-43-1 | backend-staff-engineer | em-api-1 | RUNNING |\n\n## Closed\n\n| agent_id | role | parent | result |\n|---|---|---|---|\n');
  const eventFile = path.join(dir, 'events.jsonl');
  const usage = (agent, input, output) => emitter.emitEvent({ schema_version: '1.0', type: 'model.completed', agent_id: agent, session_id: 's', usage: { input_tokens: input, output_tokens: output, source: 'provider' } }, { eventFile });
  usage('staff-ENG-42-1', 9000, 2000); usage('staff-ENG-43-1', 20000, 5000); usage('ceo', 1000, 500);
  return { registryDir, eventFile };
}

test('budget roll-up follows the registry parent tree and flags exhaustion', () => {
  const { registryDir, eventFile } = fixture();
  const s = budget.summarize({ ledger: budget.loadLedger(registryDir), tree: budget.loadTree(registryDir), events: emitter.readEvents(eventFile) });
  const by = Object.fromEntries(s.holders.map(h => [h.holder, h]));
  assert.equal(by['staff-ENG-42-1'].spent.input_tokens, 9000);
  assert.equal(by['staff-ENG-42-1'].status, 'WARN');            // 90% input
  assert.equal(by['em-api-1'].spent.input_tokens, 29000);        // subtree: 42 + 43
  assert.equal(by['em-api-1'].status, 'OK');                     // 72.5%
  assert.equal(by['ceo'].spent.input_tokens, 30000);             // whole company
  assert.equal(by['ceo'].remaining.output_tokens, 100000 - 7500);
  assert.deepEqual(s.unbudgeted_agents_with_spend, []);          // 43 is covered by em-api-1
});

test('exhaustion and over-allocation are reported', () => {
  const { registryDir, eventFile } = fixture();
  emitter.emitEvent({ schema_version: '1.0', type: 'model.completed', agent_id: 'staff-ENG-42-1', session_id: 's', usage: { input_tokens: 2000, output_tokens: 0, source: 'provider' } }, { eventFile });
  const s = budget.summarize({ ledger: budget.loadLedger(registryDir), tree: budget.loadTree(registryDir), events: emitter.readEvents(eventFile) });
  assert.equal(s.holders.find(h => h.holder === 'staff-ENG-42-1').status, 'EXHAUSTED');
  const led = budget.loadLedger(registryDir);
  led.allocations.push({ holder: 'staff-ENG-43-1', granted_by: 'em-api-1', input_tokens: '35000', output_tokens: '1000', cost_usd: 'UNKNOWN', scope: 'ENG-43' });
  const s2 = budget.summarize({ ledger: led, tree: budget.loadTree(registryDir), events: emitter.readEvents(eventFile) });
  assert.equal(s2.holders.find(h => h.holder === 'em-api-1').over_allocated, true);
});

test('budget.changed events validate and unknown fields are rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-brain-budget-ev-'));
  const eventFile = path.join(dir, 'events.jsonl');
  const ev = emitter.emitEvent({ schema_version: '1.0', type: 'budget.changed', agent_id: 'em-api-1', session_id: 's', budget: { action: 'allocate', holder: 'staff-ENG-42-1', granted_by: 'em-api-1', input_tokens: 10000, output_tokens: 10000 } }, { eventFile });
  assert.equal(ev.budget.action, 'allocate');
  assert.throws(() => emitter.validateEvent({ schema_version: '1.0', event_id: 'x', timestamp: '2026-09-12T00:00:00Z', type: 'budget.changed', agent_id: 'a', session_id: 's', budget: { action: 'steal', holder: 'b' } }), /unsupported budget action/);
});
