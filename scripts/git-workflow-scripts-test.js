'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const check = require('../skills/git-workflow-and-versioning/scripts/brain-git-check');
const { mergeBlockers } = require('../skills/git-workflow-and-versioning/scripts/merge-pr');
const { install, MARKER } = require('../skills/git-workflow-and-versioning/scripts/install-hooks');
const { checkCommitMessage } = check;

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

const { checkPushedRefs, checkChangelog, parseNumstat: numstat, ticketSource } = require('../skills/git-workflow-and-versioning/scripts/brain-git-check');
const { hookBody } = require('../skills/git-workflow-and-versioning/scripts/install-hooks');
const { originRepo } = require('../skills/git-workflow-and-versioning/scripts/merge-pr');

test('a deleted changelog does not satisfy P13; an added line does', () => {
  assert.strictEqual(checkChangelog(numstat('0\t100\tCHANGELOG.md')).length, 1);
  assert.deepStrictEqual(checkChangelog(numstat('2\t0\tCHANGELOG.md')), []);
});

test('pre-push checks the refs being pushed, not the checked-out branch', () => {
  const push = (ref, sha = 'abc1234') => `${ref} ${sha} ${ref} 0000000`;
  assert.deepStrictEqual(checkPushedRefs(push('refs/heads/ENG-1-ok'), {}), []);
  assert.strictEqual(checkPushedRefs(push('refs/heads/feature/x'), {}).length, 1);
  assert.deepStrictEqual(checkPushedRefs(push('refs/tags/v1.0.0'), {}), []);
  assert.deepStrictEqual(checkPushedRefs(push('refs/heads/main'), {}), []);
  assert.deepStrictEqual(checkPushedRefs(push('refs/heads/release/1.2'), {}), []);
  assert.deepStrictEqual(checkPushedRefs('refs/heads/gone 0000000000 refs/heads/gone abc1234', {}), []);
});

test('revert and autosquash subjects are not held to the commit anatomy', () => {
  assert.deepStrictEqual(checkCommitMessage('Revert "feat(x): y [ENG-1]"', {}), []);
  assert.deepStrictEqual(checkCommitMessage('fixup! feat(x): y [ENG-1]', {}), []);
});

test('the ticket check in merge and in the commit check share one pattern', () => {
  assert.strictEqual(ticketSource({ LINEAR_TEAM: 'ENG' }), 'ENG-\\d+');
  assert.ok(ticketSource({}).startsWith('[A-Z]'));
});

test('the hook skips with a warning when the check script is missing from the checkout', () => {
  const body = hookBody('pre-push', 'skills/x/brain-git-check.js');
  assert.match(body, /if \[ ! -f "\$CHECK" \]; then .* exit 0; fi/);
  assert.match(body, /node "\$CHECK" push$/m);
});

test('the script folders are CommonJS even inside an ESM project', () => {
  for (const d of ['git-workflow-and-versioning', 'linear', 'development-setup']) {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'skills', d, 'scripts', 'package.json'), 'utf8'));
    assert.strictEqual(pkg.type, 'commonjs', d);
  }
});

test('merge-pr derives the repository from origin, not the default repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:akash2991/agent-skills.git'], { cwd: dir });
  const cwd = process.cwd();
  process.chdir(dir);
  try { assert.strictEqual(originRepo(), 'akash2991/agent-skills'); }
  finally { process.chdir(cwd); fs.rmSync(dir, { recursive: true }); }
});
