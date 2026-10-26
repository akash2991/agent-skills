'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { checkMove, renderUpdate, BLOCKER_TYPES } = require('../skills/linear/scripts/linear-status');

const workflow = require('../skills/linear/workflow.json');
const base = {
  persona: 'backend-engineer', model: 'claude-opus-5-5', effort: 'high', harness: 'claude-code',
  field: 'State', from: 'In Progress', to: 'In Review', reason: 'PR raised', evidence: 'npm test → pass', next: 'reviewer reviews',
};

test('every transition names real states and none leaves a terminal state', () => {
  const names = new Set(workflow.states.map(s => s.name));
  for (const [from, tos] of Object.entries(workflow.transitions)) {
    assert.ok(names.has(from), from);
    assert.notStrictEqual(workflow.states.find(s => s.name === from).type, 'completed');
    for (const to of tos) assert.ok(names.has(to), `${from} → ${to}`);
  }
});

test('the typical paths in SKILL.md need no skip reason', () => {
  const paths = [
    ['Triage', 'Todo', 'In Progress', 'In Review', 'Merged', 'Done'],
    ['Triage', 'Spec', 'Design', 'Planned'],
  ];
  for (const p of paths) {
    for (let i = 0; i < p.length - 1; i++) assert.ok(checkMove(p[i], p[i + 1]).ok, `${p[i]} → ${p[i + 1]}`);
  }
});

test('a skip is legal only with a reason and names what it passed over', () => {
  assert.strictEqual(checkMove('Todo', 'In Review').ok, false);
  const move = checkMove('Todo', 'In Review', { reason: 'one-shot override' });
  assert.deepStrictEqual(move, { ok: true, skipped: ['In Progress'] });
});

test('Blocked comes from any live state and returns only to the state it left', () => {
  assert.ok(checkMove('In Progress', 'Blocked').ok);
  assert.strictEqual(checkMove('Done', 'Blocked').ok, false);
  assert.strictEqual(checkMove('Blocked', 'In Progress').ok, false);
  assert.ok(checkMove('Blocked', 'In Progress', { left: 'In Progress' }).ok);
  assert.strictEqual(checkMove('Blocked', 'QA', { left: 'In Progress' }).ok, false);
});

test('terminal states have no way out; cancel is always possible before them', () => {
  assert.match(checkMove('Done', 'In Progress').error, /new bug/);
  assert.ok(checkMove('Backlog', 'Canceled').ok);
  assert.ok(checkMove('In Review', 'Duplicate').ok);
  assert.strictEqual(checkMove('Canceled', 'Todo').ok, false);
});

test('unknown states and no-op moves are rejected', () => {
  assert.match(checkMove('Nope', 'Todo').error, /unknown/);
  assert.match(checkMove('Todo', 'Todo').error, /already/);
});

test('a status update renders in the shape of the template', () => {
  const { text } = renderUpdate({ ...base, pr: 'https://github.com/o/r/pull/1', review: 'opened' });
  const template = fs.readFileSync(path.join(__dirname, '..', 'skills', 'linear', 'templates', 'status-update.md'), 'utf8');
  const labels = block => [...block.matchAll(/^- ([A-Za-z ]+?)(?: \(|:)/gm)].map(m => m[1]);
  const templateBlock = template.match(/```markdown\n([\s\S]*?)```/)[1];
  assert.deepStrictEqual(labels(text), labels(templateBlock).filter(l => l !== 'Blocker'));
  assert.match(text, /^- Change: State In Progress → In Review$/m);
  assert.match(text, /^- PR: https:\/\/github.com\/o\/r\/pull\/1 — review: opened$/m);
});

test('the same input renders the same text', () => {
  assert.strictEqual(renderUpdate(base).text, renderUpdate({ ...base }).text);
});

test('a skip is written into the Change line', () => {
  const { text } = renderUpdate({ ...base, from: 'Todo', to: 'In Review', skipReason: 'user asked for a one-shot' });
  assert.match(text, /Change: State Todo → In Review \(skipped In Progress: user asked for a one-shot\)/);
});

test('a Blocked update needs the whole blocker block, and only a Blocked update may carry one', () => {
  const blocked = { ...base, to: 'Blocked' };
  assert.strictEqual(renderUpdate(blocked).errors.length, 4);
  const full = { ...blocked, blockerType: BLOCKER_TYPES[2], blockerDependency: 'ENG-9', blockerRequirement: 'contract merged', blockerOwner: 'product-manager' };
  assert.match(renderUpdate(full).text, /  - Owner: product-manager$/);
  assert.match(renderUpdate({ ...base, blockerOwner: 'x' }).errors[0], /only belong on a move to Blocked/);
  assert.match(renderUpdate({ ...full, blockerType: 'laziness' }).errors[0], /blocker type must be one of/);
});

test('an illegal move or a missing field cannot be rendered', () => {
  assert.ok(renderUpdate({ ...base, from: 'Todo', to: 'Done' }).errors[0].match(/skips states/));
  assert.ok(renderUpdate({ ...base, reason: '' }).errors.includes('missing reason'));
  assert.match(renderUpdate({ ...base, review: 'lgtm' }).errors[0], /review must be/);
});

test('a Blocked issue returns only to a live state other than Blocked', () => {
  assert.match(checkMove('Blocked', 'Done', { left: 'Done' }).error, /must be a live state/);
  assert.strictEqual(checkMove('Blocked', 'Blocked', { left: 'Blocked' }).ok, false);
  assert.ok(checkMove('Blocked', 'Todo', { left: 'Todo' }).ok);
});

test('the state field is recognised in any spelling, so a lowercase name cannot skip the checks', () => {
  const illegal = { ...base, field: ' state ', from: 'Done', to: 'In Progress' };
  assert.match(renderUpdate(illegal).errors[0], /has no way out/);
  const blocked = { ...base, field: 'state', to: 'Blocked' };
  assert.match(renderUpdate(blocked).errors.join(), /a Blocked update needs blockerType/);
});

test('the states a move jumps over follow the legal path, not the order of the list', () => {
  assert.deepStrictEqual(checkMove('Triage', 'In Progress', { reason: 'r' }).skipped, ['Todo']);
  assert.deepStrictEqual(checkMove('In Progress', 'Spec', { reason: 'r' }).skipped, []);
});

test('a clean move does not claim to skip states, even when a skip reason is given', () => {
  const { text } = renderUpdate({ ...base, from: 'In Review', to: 'Merged', skipReason: 'none' });
  assert.doesNotMatch(text, /skipped/);
});
