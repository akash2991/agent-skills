'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { actor, classify, build, validate, toStep } = require('./lib/flow-map');

const ROOT = path.resolve(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'flow-map.json'), 'utf8'));

test('a flow is deterministic, agent, or mixed by its code and agent steps; human steps are gates', () => {
  assert.strictEqual(classify(['code', 'code']), 'deterministic');
  assert.strictEqual(classify(['agent', 'agent', 'human']), 'agent');
  assert.strictEqual(classify(['code', 'agent']), 'mixed');
  assert.strictEqual(classify(['code', 'human']), 'deterministic');
  assert.strictEqual(classify(['human']), 'human');
});

test('a det step is code today only when something runs it', () => {
  const det = toStep(['x', 'det', 'scripts/build-brain.js']);
  const bare = toStep(['x', 'det', null]);
  assert.strictEqual(actor(det, 'today'), 'code');
  assert.strictEqual(actor(bare, 'today'), 'agent');
  assert.strictEqual(actor(bare, 'target'), 'code');
  assert.strictEqual(actor(toStep(['x', 'judgment']), 'target'), 'agent');
  assert.strictEqual(actor(toStep(['x', 'human']), 'today'), 'human');
});

test('the committed data is valid and every named script exists', () => {
  assert.deepStrictEqual(validate(data, ROOT), []);
});

test('invalid data is reported: missing script, script on a judgment step, unknown area, duplicate id', () => {
  const bad = {
    areas: ['A'],
    flows: [
      { id: 'one', area: 'A', steps: [['s', 'det', 'no/such/file.js'], ['t', 'judgment', 'scripts/build-brain.js']] },
      { id: 'one', area: 'B', steps: [['u', 'weird']] },
    ],
  };
  const errors = validate(bad, ROOT).join('\n');
  assert.match(errors, /no\/such\/file\.js, which does not exist/);
  assert.match(errors, /is judgment but names a script/);
  assert.match(errors, /duplicate id/);
  assert.match(errors, /unknown area "B"/);
  assert.match(errors, /kind "weird"/);
});

test('totals add up and conversion never makes a flow less deterministic', () => {
  const model = build(data, ROOT);
  const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
  assert.strictEqual(sum(model.totals.today), model.totals.flows);
  assert.strictEqual(sum(model.totals.target), model.totals.flows);
  assert.strictEqual(sum(model.totals.stepsToday), sum(model.totals.stepsTarget));
  assert.ok(model.totals.target.agent <= model.totals.today.agent);
  assert.ok(model.totals.stepsTarget.code >= model.totals.stepsToday.code);
  for (const f of model.flows) for (const s of f.steps) if (s.today === 'code') assert.strictEqual(s.target, 'code');
});

test('docs/flow-map.html is up to date with its data', () => {
  const { render } = require('./build-flow-map');
  assert.strictEqual(fs.readFileSync(path.join(ROOT, 'docs', 'flow-map.html'), 'utf8'), render());
});

test('step text cannot close the data script element', () => {
  const { render } = require('./build-flow-map');
  assert.strictEqual((render().match(/<\/script>/g) || []).length, 2);
});
