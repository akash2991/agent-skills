#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const { validate } = require('./validate-review-models');

const ROOT = path.resolve(__dirname, '..');
const sandboxes = [];

const GATE = {
  independent: [
    { label: 'GPT-6.2 Sol', harness: 'pi', model: 'openai-codex/gpt-6.2-sol', effort: 'high' },
    { label: 'Opus 5.5', harness: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  ],
  synthesis: { label: 'GPT-6.2 Astra', harness: 'pi', model: 'openai-codex/gpt-6.2-astra', effort: 'high' },
};
const PROJECT = { 'code-reviewer': { label: 'GPT-6.2 Sol', harness: 'pi', model: 'openai-codex/gpt-6.2-sol', effort: 'medium' } };
const PROSE = 'Reviewers use the models in `review-models.json`.\n';

function sandbox({ gate = GATE, project = PROJECT, agents = PROSE, projectAgents = PROSE } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-review-models-test-'));
  sandboxes.push(root);
  fs.mkdirSync(path.join(root, 'project'));
  const write = (rel, v) => fs.writeFileSync(path.join(root, rel), typeof v === 'string' ? v : JSON.stringify(v));
  write('review-models.json', gate);
  write('project/review-models.json', project);
  write('AGENTS.md', agents);
  write('project/AGENTS.md', projectAgents);
  return root;
}

afterEach(() => { while (sandboxes.length) fs.rmSync(sandboxes.pop(), { recursive: true, force: true }); });

test('the repository passes', () => {
  assert.deepEqual(validate(ROOT), []);
});

test('a valid sandbox passes', () => {
  assert.deepEqual(validate(sandbox()), []);
});

test('a configured label or id in prose fails, with its line', () => {
  const errors = validate(sandbox({ agents: `${PROSE}one using **GPT-6.2 Sol**\n` }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^AGENTS\.md:2: names a model \(.*"gpt-6\.2 sol"/);
  assert.match(validate(sandbox({ projectAgents: `${PROSE}run openai-codex/gpt-6.2-astra\n` })).join('\n'), /project\/AGENTS\.md:2/);
});

test('a model-like name not in the config still fails', () => {
  for (const text of ['on **GPT-6.1 Sol**', 'using Opus 5.5', 'model claude-sonnet-5-5', 'gpt-7-nova', 'Fable 5.2']) {
    assert.equal(validate(sandbox({ agents: `${PROSE}${text}\n` })).length, 1, text);
  }
});

test('prose must point to the config', () => {
  assert.match(validate(sandbox({ agents: 'no pointer\n' })).join('\n'), /AGENTS\.md: must point to review-models\.json/);
});

test('config shape errors are reported', () => {
  const cases = [
    [{ ...GATE, independent: [GATE.independent[0]] }, /at least two/],
    [{ ...GATE, independent: [GATE.independent[0], GATE.independent[0]] }, /different models/],
    [{ ...GATE, synthesis: { ...GATE.synthesis, harness: 'codex' } }, /harness: "codex"/],
    [{ ...GATE, synthesis: { ...GATE.synthesis, model: 'gpt-6.2-astra' } }, /not an exact pi model id/],
    [{ ...GATE, synthesis: { ...GATE.synthesis, effort: 'huge' } }, /effort: "huge"/],
    [{ ...GATE, synthesis: { ...GATE.synthesis, label: '' } }, /synthesis\.label: required/],
    [{ ...GATE, extra: 1 }, /unknown field\(s\) extra/],
    ['{not json', /invalid JSON/],
  ];
  for (const [gate, re] of cases) assert.match(validate(sandbox({ gate })).join('\n'), re);
  assert.match(validate(sandbox({ project: { 'code-reviewer': { ...PROJECT['code-reviewer'], model: 'opus' } } })).join('\n'), /code-reviewer\.model/);
  assert.match(validate(sandbox({ project: {} })).join('\n'), /code-reviewer: must be an object/);
});
