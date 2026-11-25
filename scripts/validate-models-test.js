#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const { validate } = require('./validate-models');

const ROOT = path.resolve(__dirname, '..');
const sandboxes = [];

const GATE = {
  independent: [
    { label: 'GPT-6.2 Sol', harness: 'pi', model: 'openai-codex/gpt-6.2-sol', effort: 'high' },
    { label: 'Opus 5.5', harness: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  ],
  synthesis: { label: 'GPT-6.2 Astra', harness: 'pi', model: 'openai-codex/gpt-6.2-astra', effort: 'high' },
  'artifact-sync': { label: 'Sonnet 5.5', harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  artifacts: [{ path: 'docs/map.json', sources: ['scripts/**/*.js'], then: 'node build.js', outputs: ['docs/map.html'] }],
};
const SYNC = GATE['artifact-sync'];
const PROJECT = { 'code-reviewer': { label: 'GPT-6.2 Sol', harness: 'pi', model: 'openai-codex/gpt-6.2-sol', effort: 'medium' }, 'artifact-sync': SYNC, artifacts: [] };
const GATE_PROSE = '2. **Two independent review passes.** One per entry in `models.json`.\n3. **Third-agent synthesis.** The `synthesis` entry in `models.json`.\n';
const PROJECT_PROSE = 'Start it, except for a `code-reviewer`, on its entry in `models.json`.\n';

function sandbox({ gate = GATE, project = PROJECT, agents = GATE_PROSE, projectAgents = PROJECT_PROSE } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-models-test-'));
  sandboxes.push(root);
  fs.mkdirSync(path.join(root, 'project'));
  const write = (rel, v) => fs.writeFileSync(path.join(root, rel), typeof v === 'string' ? v : JSON.stringify(v));
  write('models.json', gate);
  write('project/models.json', project);
  write('AGENTS.md', agents);
  write('project/AGENTS.md', projectAgents);
  fs.mkdirSync(path.join(root, 'docs'));
  write('docs/map.json', '{}');
  write('docs/map.html', '');
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
  const errors = validate(sandbox({ agents: `${GATE_PROSE}one using **GPT-6.2 Sol**\n` }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^AGENTS\.md:3: names a model \(.*"gpt-6\.2-sol"/);
  assert.match(validate(sandbox({ projectAgents: `${PROJECT_PROSE}run openai-codex/gpt-6.2-astra\n` })).join('\n'), /project\/AGENTS\.md:2/);
});

test('a model-like name not in the config still fails', () => {
  for (const text of ['on **GPT-6.1 Sol**', 'using Opus 5.5', 'model claude-sonnet-5-5', 'gpt-7-nova', 'Fable 5.2',
    'Use GPT 6.1 Sol.', 'Use Claude Opus.', 'opus5.5', 'Opus-5.5', 'GPT\u20116.1', 'gpt\u00a06.2 sol']) {
    assert.equal(validate(sandbox({ agents: `${GATE_PROSE}${text}\n` })).length, 1, text);
  }
});

test('the reviewer-selection lines must point to the config', () => {
  assert.match(validate(sandbox({ agents: 'no pointer\n' })).join('\n'), /AGENTS\.md: cannot find the reviewer-selection instruction containing \*\*Two independent/);
  const elsewhere = GATE_PROSE.replace('One per entry in `models.json`.', 'Two of them.') + 'See models.json.\n';
  assert.match(validate(sandbox({ agents: elsewhere })).join('\n'), /^AGENTS\.md:1: the reviewer-selection instruction must point/m);
  assert.match(validate(sandbox({ projectAgents: 'except for a `code-reviewer` on the defaults.\nmodels.json\n' })).join('\n'), /project\/AGENTS\.md:1: the reviewer-selection/);
});

test('config shape errors are reported', () => {
  const cases = [
    [{ ...GATE, independent: [GATE.independent[0]] }, /exactly two/],
    [{ ...GATE, independent: [...GATE.independent, GATE.synthesis] }, /exactly two/],
    [{ ...GATE, independent: [GATE.independent[0], { ...GATE.independent[1], effort: 'minimal' }] }, /independent\[1\]\.effort: "minimal" is not one of claude's/],
    [{ ...GATE, synthesis: { ...GATE.synthesis, harness: 'constructor' } }, /harness: "constructor" is not one of pi, claude/],
    [null, /^models\.json: must be an object$/m],
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
  assert.match(validate(sandbox({ project: null })).join('\n'), /^project\/models\.json: must be an object$/m);
  assert.match(validate(sandbox({ project: '{not json' })).join('\n'), /project\/models\.json: invalid JSON/);
  assert.match(validate(sandbox({ project: { 'code-reviewer': { ...PROJECT['code-reviewer'], harness: 'claude', model: 'claude-opus-5-5', effort: 'minimal' } } })).join('\n'), /code-reviewer\.effort: "minimal" is not one of claude's/);
});

test('an effort one harness accepts and another refuses is judged per harness', () => {
  assert.deepEqual(validate(sandbox({ project: { ...PROJECT, 'code-reviewer': { ...PROJECT['code-reviewer'], effort: 'minimal' } } })), []);
});

test('the artifact-sync entry is required and checked like a reviewer', () => {
  const { 'artifact-sync': _gone, ...gate } = GATE;
  assert.match(validate(sandbox({ gate })).join('\n'), /^models\.json\.artifact-sync: must be an object/m);
  assert.match(validate(sandbox({ project: { ...PROJECT, 'artifact-sync': { ...SYNC, effort: 'minimal' } } })).join('\n'), /project\/models\.json\.artifact-sync\.effort/);
  assert.match(validate(sandbox({ agents: `${GATE_PROSE}docs are kept by Sonnet 5.5\n` })).join('\n'), /AGENTS\.md:3: names a model/);
});

test('artifacts are checked: shape, paths, and existence in this repository only', () => {
  const art = GATE.artifacts[0];
  const cases = [
    [undefined, /artifacts: must be an array/],
    [[{ ...art, path: '../x' }], /artifacts\[0\]\.path: required repository-relative/],
    [[{ ...art, path: 'models.json' }], /models\.json is config, never an artifact/],
    [[art, art], /mapped twice/],
    [[{ ...art, sources: [] }], /sources: required non-empty array/],
    [[{ ...art, then: '' }], /then: must be a non-empty command/],
    [[{ ...art, outputs: ['/abs'] }], /outputs: must be an array of repository-relative paths/],
    [[{ path: 'docs/map.json', sources: ['x'], outputs: ['docs/map.html'] }], /only a then command writes outputs/],
    [[{ ...art, extra: 1 }], /unknown field\(s\) extra/],
    [[{ ...art, path: 'docs/missing.md' }], /docs\/missing\.md does not exist/],
  ];
  for (const [artifacts, re] of cases) assert.match(validate(sandbox({ gate: { ...GATE, artifacts } })).join('\n'), re, String(re));
  // A project's artifacts are its own files, so the brain does not check that they exist.
  assert.deepEqual(validate(sandbox({ project: { ...PROJECT, artifacts: [{ path: 'docs/HLD.md', sources: ['src/**'] }] } })), []);
});
