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
  for (const bad of ['feature/x', 'eng-123-login', 'ENG-123', 'ENG-123-Login', 'feature/login']) {
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

test('a changelog line is required in the global file and in the service it touches', () => {
  const all = ['CHANGELOG.md', 'services/api/CHANGELOG.md'];
  assert.strictEqual(check.checkChangelog(check.parseNumstat('1\t0\tsrc/a.ts'), all).length, 1);
  assert.strictEqual(check.checkChangelog(check.parseNumstat('1\t0\tCHANGELOG.md\n1\t0\tservices/api/src/a.ts'), all).length, 1);
  assert.deepStrictEqual(check.checkChangelog(check.parseNumstat('1\t0\tCHANGELOG.md\n1\t0\tservices/api/CHANGELOG.md\n1\t0\tservices/api/src/a.ts'), all), []);
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
const { originRepo, latestRuns, isApproved } = require('../skills/git-workflow-and-versioning/scripts/merge-pr');

test('a deleted changelog does not satisfy P13; an added line does', () => {
  assert.strictEqual(checkChangelog(numstat('0\t100\tCHANGELOG.md')).length, 1);
  assert.deepStrictEqual(checkChangelog(numstat('2\t0\tCHANGELOG.md')), []);
});

test('pre-push judges the remote ref being updated, not the local name', () => {
  const line = (local, remote, sha = 'abc1234') => `${local} ${sha} ${remote} 0000000`;
  assert.deepStrictEqual(checkPushedRefs(line('refs/heads/ENG-1-ok', 'refs/heads/ENG-1-ok'), {}), []);
  // git push -u origin HEAD: the local name is HEAD, the remote name is what is judged
  assert.strictEqual(checkPushedRefs(line('HEAD', 'refs/heads/badbranch'), {}).length, 1);
  // git push origin HEAD:bad-name
  assert.strictEqual(checkPushedRefs(line('HEAD', 'refs/heads/bad-name'), {}).length, 1);
  // a direct push to main is refused, whatever the local name
  assert.match(checkPushedRefs(line('refs/heads/ENG-1-ok', 'refs/heads/main'), {})[0], /direct push to main/);
  assert.deepStrictEqual(checkPushedRefs(line('refs/tags/v1.0.0', 'refs/tags/v1.0.0'), {}), []);
  assert.deepStrictEqual(checkPushedRefs(line('refs/heads/release/1.2', 'refs/heads/release/1.2'), {}), []);
  assert.deepStrictEqual(checkPushedRefs('(delete) 0000000000 refs/heads/gone abc1234', {}), []);
});

test('a dependency bot is exempt by login only; a GitHub App that opens agent PRs is not', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'templates', 'pr-rules.yml'), 'utf8');
  assert.match(yml, /dependabot\[bot\]/);
  assert.doesNotMatch(yml, /user\.type != 'Bot'/);
});

test('a git revert subject is exempt; fixup and squash commits are checked before they can land', () => {
  assert.deepStrictEqual(checkCommitMessage('Revert "feat(x): y [ENG-1]"', {}), []);
  assert.ok(checkCommitMessage('fixup! feat(x): y [ENG-1]', {}).length > 0);
  assert.ok(checkCommitMessage('squash! does not exist', {}).length > 0);
});

test('a changelog is required in the global file and in each service the change touches', () => {
  const { requiredChangelogs } = check;
  const all = ['CHANGELOG.md', 'services/api/CHANGELOG.md', 'services/web/CHANGELOG.md'];
  assert.deepStrictEqual(requiredChangelogs(['services/api/src/a.ts'], all).sort(), ['CHANGELOG.md', 'services/api/CHANGELOG.md']);
  assert.deepStrictEqual(requiredChangelogs(['README.md'], all), ['CHANGELOG.md']);
  const onlyService = check.checkChangelog(check.parseNumstat('3\t0\tservices/api/CHANGELOG.md\n1\t0\tservices/api/src/a.ts'), all);
  assert.match(onlyService[0], /CHANGELOG\.md/);
  assert.deepStrictEqual(check.checkChangelog(check.parseNumstat('1\t0\tCHANGELOG.md\n2\t0\tservices/api/CHANGELOG.md\n1\t0\tservices/api/src/a.ts'), all), []);
});

test('a release branch and main are not held to the branch name', () => {
  assert.deepStrictEqual(check.checkBranchName('release/1.2', {}), []);
  assert.deepStrictEqual(check.checkBranchName('main', {}), []);
});

test('the hook quotes its check path, so a path that holds a command substitution runs nothing', () => {
  const body = hookBody('commit-msg', 'a/$(touch x)/c.js');
  assert.match(body, /CHECK="\$ROOT"\/'a\/\$\(touch x\)\/c\.js'/);
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

test('only the newest run of each check counts: a re-run after a fix clears the old failure', () => {
  const runs = latestRuns([
    { name: 'pr-rules', conclusion: 'FAILURE', completedAt: '2026-10-26T10:00:00Z' },
    { name: 'pr-rules', conclusion: 'SUCCESS', completedAt: '2026-10-26T10:05:00Z' },
    { name: 'checks', conclusion: 'SUCCESS', completedAt: '2026-10-26T10:01:00Z' },
  ]);
  assert.strictEqual(runs.length, 2);
  assert.ok(runs.every(r => r.conclusion === 'SUCCESS'));
});

test('an approval counts from a reviewer other than the author; a later change request blocks it', () => {
  const author = { login: 'agent' };
  assert.strictEqual(isApproved({ author, reviewDecision: '', reviews: [{ author: { login: 'agent' }, state: 'APPROVED' }] }), false);
  assert.strictEqual(isApproved({ author, reviewDecision: '', reviews: [{ author: { login: 'reviewer' }, state: 'APPROVED' }] }), true);
  assert.strictEqual(isApproved({ author, reviewDecision: '', reviews: [
    { author: { login: 'reviewer' }, state: 'APPROVED' }, { author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' }] }), false);
  assert.strictEqual(isApproved({ author, reviewDecision: 'APPROVED', reviews: [] }), true);
});

test('a repository with no changelog fails P13 rather than passing silently', () => {
  assert.strictEqual(check.checkChangelog(check.parseNumstat('1\t0\tsrc/a.ts'), []).length, 1);
});
