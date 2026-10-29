'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ruleIds, uncovered } = require('./check-rule-coverage');

test('rule IDs come from the convention skills\' tables', () => {
  const ids = ruleIds();
  assert.ok(ids.includes('P1') && ids.includes('M1') && ids.includes('DS2') && ids.includes('L1'));
});

test('a rule is covered only when a flow step cites it in its rule field', () => {
  const map = { flows: [{ steps: [['x', 'det', null, 'P1 DS2'], ['y', 'judgment', null, '']] }] };
  assert.deepStrictEqual(uncovered(['P1', 'DS2', 'M1'], map), ['M1']);
  // a mention in the step text does not count
  const sneaky = { flows: [{ steps: [['Rule P1 applies here', 'det', null, '']] }] };
  assert.deepStrictEqual(uncovered(['P1'], sneaky), ['P1']);
});
