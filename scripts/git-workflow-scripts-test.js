'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const check = require('../skills/git-workflow-and-versioning/scripts/brain-git-check');
const { mergeBlockers } = require('../skills/git-workflow-and-versioning/scripts/merge-pr');
const { install, MARKER } = require('../skills/git-workflow-and-versioning/scripts/install-hooks');

const GOOD = [
  'feat(login): add the login form [ENG-123]',
  '',
  'why: users need to sign in',
  '',
  'Model: claude-opus-5-5',
  'Thinking-effort: high',
  'Harness: claude-code',
].join('\n');

test('a complete commit message passes', () => {
  assert.deepStrictEqual(check.checkCommitMessage(GOOD, {}), []);
});

test('a commit message without ticket id or trailers fails with one error per gap', () => {
  const errors = check.checkCommitMessage('fix: stuff', {});
  assert.strictEqual(errors.length, 4);
  assert.match(errors[0], /subject must be/);
  assert.ok(errors.some(e => /Thinking-effort/.test(e)));
});

test('comment lines from git are ignored', () => {
  assert.deepStrictEqual(check.checkCommitMessage(`${GOOD}\n# Please enter the commit message`, {}), []);
});

test('LINEAR_TEAM narrows the ticket pattern', () => {
  assert.strictEqual(check.checkCommitMessage(GOOD, { LINEAR_TEAM: 'ENG' }).length, 0);
  assert.strictEqual(check.checkCommitMessage(GOOD, { LINEAR_TEAM: 'OPS' }).length, 1);
});

test('a merge commit needs only the ticket id', () => {
  assert.deepStrictEqual(check.checkCommitMessage('Merge pull request #4 [ENG-123]', {}), []);
  assert.strictEqual(check.checkCommitMessage('Merge pull request #4', {}).length, 1);
});

test('branch names are <ticket>-<slug>', () => {
  assert.deepStrictEqual(check.checkBranchName('ENG-123-login-form', {}), []);
  for (const bad of ['main', 'eng-123-login', 'ENG-123', 'ENG-123-Login', 'feature/login']) {
    assert.strictEqual(check.checkBranchName(bad, {}).length, 1, bad);
  }
});

test('PR titles start with the ticket id', () => {
  assert.deepStrictEqual(check.checkPrTitle('ENG-123: add login', {}), []);
  assert.strictEqual(check.checkPrTitle('add login', {}).length, 1);
  assert.strictEqual(check.checkPrTitle(undefined, {}).length, 1);
});

test('size counts changed lines and files, skipping lockfiles', () => {
  const files = check.parseNumstat('300\t50\tsrc/a.ts\n5\t5\tpackage-lock.json\n-\t-\tlogo.png');
  assert.deepStrictEqual(files.map(f => f.path), ['src/a.ts', 'logo.png']);
  assert.deepStrictEqual(check.checkSize(files, '', {}), []);
});

test('an oversized PR fails unless the body records an exception', () => {
  const big = check.parseNumstat('401\t0\tsrc/a.ts');
  assert.strictEqual(check.checkSize(big, '', {}).length, 1);
  assert.deepStrictEqual(check.checkSize(big, 'Size-exception: one generated migration', {}), []);
  assert.strictEqual(check.checkSize(big, 'Size-exception:', {}).length, 1);
  assert.strictEqual(check.checkSize(check.parseNumstat(Array(11).fill('1\t0\tx').map((l, i) => l + i).join('\n')), '', {}).length, 1);
  assert.deepStrictEqual(check.checkSize(big, '', { BRAIN_PR_MAX_LINES: '500' }), []);
});

test('a changelog line is required in any CHANGELOG.md', () => {
  assert.strictEqual(check.checkChangelog(check.parseNumstat('1\t0\tsrc/a.ts')).length, 1);
  assert.deepStrictEqual(check.checkChangelog(check.parseNumstat('1\t0\tservices/api/CHANGELOG.md')), []);
});

test('merge is blocked unless open, ticketed, green, and approved', () => {
  const ok = { state: 'OPEN', title: 'ENG-1: x', reviewDecision: 'APPROVED', statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }] };
  assert.deepStrictEqual(mergeBlockers(ok).blockers, []);
  assert.strictEqual(mergeBlockers(ok).ticket, 'ENG-1');
  assert.strictEqual(mergeBlockers({ ...ok, reviewDecision: 'REVIEW_REQUIRED' }).blockers.length, 1);
  assert.deepStrictEqual(mergeBlockers({ ...ok, reviewDecision: null }, { reviewOptional: true }).blockers, []);
  assert.match(mergeBlockers({ ...ok, statusCheckRollup: [{ name: 'ci', conclusion: 'FAILURE' }] }).blockers[0], /CI is not green: ci/);
  assert.strictEqual(mergeBlockers({ ...ok, title: 'x', state: 'MERGED' }).blockers.length, 2);
});

test('hooks install once and never overwrite a foreign hook', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-'));
  fs.writeFileSync(path.join(dir, 'pre-push'), '#!/bin/sh\necho mine\n');
  const first = install(dir, 'skills/x/brain-git-check.js');
  assert.match(first[0], /commit-msg: installed/);
  assert.match(first[1], /pre-push: skipped/);
  assert.ok(fs.readFileSync(path.join(dir, 'commit-msg'), 'utf8').includes(MARKER));
  assert.match(install(dir, 'skills/x/brain-git-check.js')[0], /installed/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'pre-push'), 'utf8'), '#!/bin/sh\necho mine\n');
  fs.rmSync(dir, { recursive: true });
});
