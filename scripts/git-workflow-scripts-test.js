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

// The suite is independent of the caller's shell: a project's .env loaded there must not change the results.
for (const key of ['LINEAR_TEAM', 'BRAIN_LONG_LIVED', 'CI', 'GH_HOST', 'DEFAULT_BRANCH']) delete process.env[key];
// The developer's own git config (signing, hooks, default branch) must not reach the fixtures.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

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

test('a merge commit keeps the git subject but needs the ticket id and the P3 trailers', () => {
  assert.deepStrictEqual(check.checkCommitMessage('Merge pull request #4 [ENG-123]\n\nModel: m\nThinking-effort: high\nHarness: h', {}), []);
  assert.strictEqual(check.checkCommitMessage('Merge pull request #4 [ENG-123]', {}).length, 3, 'no trailers');
  assert.strictEqual(check.checkCommitMessage('Merge pull request #4\n\nModel: m\nThinking-effort: high\nHarness: h', {}).length, 1, 'no ticket');
  // In CI the parent count is known: a one-parent commit with a merge-like subject is held to the full anatomy.
  assert.ok(check.checkCommitMessage('Merge pull request #4 [ENG-123]', {}, { isMerge: false }).length > 0);
  assert.deepStrictEqual(check.checkCommitMessage('Merge pull request #4 [ENG-123]\n\nModel: m\nThinking-effort: high\nHarness: h', {}, { isMerge: true }), []);
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

test('size counts every changed line and file, lockfiles included (P11 has no lockfile exemption)', () => {
  const files = check.parseNumstat('300\t50\tsrc/a.ts\n900\t5\tpackage-lock.json\n-\t-\tlogo.png');
  assert.deepStrictEqual(files.map(f => f.path), ['src/a.ts', 'package-lock.json', 'logo.png']);
  assert.strictEqual(check.checkSize(files, '', {}).length, 1);
  assert.deepStrictEqual(check.checkSize(files, 'Size-exception: lockfile refresh', {}), []);
  // -z output: NUL-separated records, paths unquoted
  assert.deepStrictEqual(check.parseNumstat('1\t0\tservices/api/café.ts\0').map(f => f.path), ['services/api/café.ts']);
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
  const ok = { state: 'OPEN', number: 1, title: 'ENG-1: x', reviewDecision: 'APPROVED', headRefOid: 'h1', author: { login: 'agent' },
    reviews: [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: 'h1' } }], statusCheckRollup: [{ name: 'pr-rules', conclusion: 'SUCCESS', workflowPath: '.github/workflows/pr-rules.yml', event: 'pull_request', runPrs: [1] }, { name: 'ci', conclusion: 'SUCCESS' }] };
  assert.deepStrictEqual(mergeBlockers(ok).blockers, []);
  assert.strictEqual(mergeBlockers(ok).ticket, 'ENG-1');
  assert.strictEqual(mergeBlockers({ ...ok, reviews: [] }).blockers.length, 1);
  assert.strictEqual(mergeBlockers({ ...ok, headRefOid: 'h2' }).blockers.length, 1, 'reviewDecision APPROVED does not cover a newer head');
  assert.match(mergeBlockers({ ...ok, unresolvedThreads: 2 }).blockers.join(), /2 review thread\(s\) are unresolved/);
  assert.deepStrictEqual(mergeBlockers({ ...ok, reviewDecision: null }, { reviewOptional: true }).blockers, []);
  assert.match(mergeBlockers({ ...ok, statusCheckRollup: [{ name: 'pr-rules', conclusion: 'SUCCESS', workflowPath: '.github/workflows/pr-rules.yml', event: 'pull_request', runPrs: [1] }, { name: 'ci', conclusion: 'FAILURE' }] }).blockers[0], /CI is not green: ci/);
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

test('a revert keeps the ticket and trailers; fixup and squash commits are checked before they can land', () => {
  const trailers = '\n\nModel: m\nThinking-effort: h\nHarness: c';
  assert.deepStrictEqual(checkCommitMessage('Revert "feat(x): y [ENG-1]"' + trailers, {}), []);
  assert.ok(checkCommitMessage('Revert "feat(x): y"', {}).length >= 4);
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
  assert.match(body, /node "\$CHECK" push "\$@"$/m);
});

test('the script folders are CommonJS even inside an ESM project', () => {
  for (const d of ['git-workflow-and-versioning']) {
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
  const id = { workflowPath: '.github/workflows/pr-rules.yml', event: 'pull_request', runPrs: [1] };
  const runs = latestRuns([
    { ...id, name: 'pr-rules', conclusion: 'FAILURE', startedAt: '2026-10-26T10:00:00Z' },
    { ...id, name: 'pr-rules', conclusion: 'SUCCESS', startedAt: '2026-10-26T10:05:00Z' },
    { ...id, name: 'checks', conclusion: 'SUCCESS', startedAt: '2026-10-26T10:01:00Z' },
  ]);
  assert.strictEqual(runs.length, 2);
  assert.ok(runs.every(r => r.conclusion === 'SUCCESS'));
  // checks from outside Actions carry no run identity: two providers' "test" are both kept
  assert.strictEqual(latestRuns([{ name: 'test', conclusion: 'FAILURE' }, { name: 'test', conclusion: 'SUCCESS' }]).length, 2);
});

test('an approval counts from a reviewer other than the author, on the current head only', () => {
  const author = { login: 'agent' };
  const head = 'h2';
  const rev = (login, state, oid = head) => ({ author: { login }, authorAssociation: 'MEMBER', state, commit: { oid } });
  assert.strictEqual(isApproved({ author, headRefOid: head, reviewDecision: '', reviews: [rev('agent', 'APPROVED')] }), false);
  assert.strictEqual(isApproved({ author, headRefOid: head, reviewDecision: '', reviews: [rev('r', 'APPROVED')] }), true);
  assert.strictEqual(isApproved({ author, headRefOid: head, reviewDecision: '', reviews: [rev('r', 'APPROVED', 'h1')] }), false, 'approval of an older commit');
  assert.strictEqual(isApproved({ author, headRefOid: head, reviewDecision: '', reviews: [rev('r', 'APPROVED'), rev('r', 'CHANGES_REQUESTED')] }), false);
});

test('a repository with no changelog fails P13 rather than passing silently', () => {
  assert.strictEqual(check.checkChangelog(check.parseNumstat('1\t0\tsrc/a.ts'), []).length, 1);
});

const { isPending } = require('../skills/git-workflow-and-versioning/scripts/merge-pr');
const { requiredChangelogs: reqChangelogs } = require('../skills/git-workflow-and-versioning/scripts/brain-git-check');

test('a run still in progress blocks the merge, even when an older run of the same check passed', () => {
  const view = { state: 'OPEN', number: 1, title: 'ENG-1: x', reviewDecision: 'APPROVED', statusCheckRollup: [
    { workflowName: 'ci', name: 'pr-rules', conclusion: 'SUCCESS', status: 'COMPLETED', startedAt: '2026-10-26T10:00:00Z' },
    { workflowName: 'ci', name: 'pr-rules', conclusion: '', status: 'IN_PROGRESS', startedAt: '2026-10-26T10:05:00Z', completedAt: '0001-01-01T00:00:00Z' },
  ] };
  assert.match(mergeBlockers(view).blockers.join(), /still running: pr-rules/);
  assert.ok(isPending({ status: 'QUEUED' }));
});

test('two workflows with a job of the same name are separate checks: a failing test is not hidden', () => {
  const runs = latestRuns([
    { workflowName: 'ci', name: 'test', conclusion: 'FAILURE', status: 'COMPLETED', startedAt: '2026-10-26T10:00:00Z' },
    { workflowName: 'e2e', name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED', startedAt: '2026-10-26T10:01:00Z' },
  ]);
  assert.strictEqual(runs.length, 2);
  const view = { state: 'OPEN', number: 1, title: 'ENG-1: x', reviewDecision: 'APPROVED', statusCheckRollup: runs };
  assert.match(mergeBlockers(view).blockers.join(), /CI is not green: test/);
});

test('a COMMENTED review is a reply, not a verdict: it neither approves nor overrides a request for changes', () => {
  const author = { login: 'agent' };
  const head = 'h2';
  const rev = (login, state) => ({ author: { login }, authorAssociation: 'MEMBER', state, commit: { oid: head } });
  assert.strictEqual(isApproved({ author, headRefOid: head, reviewDecision: '', reviews: [rev('r1', 'APPROVED'), rev('r1', 'COMMENTED')] }), true);
  assert.strictEqual(isApproved({ author, headRefOid: head, reviewDecision: '', reviews: [rev('r1', 'APPROVED'), rev('r2', 'CHANGES_REQUESTED'), rev('r2', 'COMMENTED')] }), false);
});

test('only github.com is inferred from origin; an unresolved alias or another host is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
  const cwd = process.cwd();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  process.chdir(dir);
  try {
    // An alias counts only when ssh resolves it to github.com; an unknown alias is refused, not guessed.
    execFileSync('git', ['remote', 'add', 'origin', 'git@github-no-such-alias-7f3:org/app.git']);
    assert.throws(() => originRepo(), /not a github\.com remote; pass --repo/);
    execFileSync('git', ['remote', 'set-url', 'origin', 'ssh://git@ssh.github.com:443/org/app.git']);
    assert.strictEqual(originRepo(), 'org/app');
    execFileSync('git', ['remote', 'set-url', 'origin', 'git@gitlab.com:org/app.git']);
    assert.throws(() => originRepo(), /not a github\.com remote/);
  } finally { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the hook accepts a local fixup or squash commit; CI does not, and an unsquashed one must not land', () => {
  assert.deepStrictEqual(checkCommitMessage('fixup! feat(x): y [ENG-1]', {}, { allowFixup: true }), []);
  assert.ok(checkCommitMessage('fixup! feat(x): y [ENG-1]', {}).length > 0);
});

test('a comma-separated scope is accepted, and git merge subjects need the ticket and trailers', () => {
  assert.deepStrictEqual(checkCommitMessage('fix(git-workflow,dev-setup,linear): x [ENG-1]\n\nModel: m\nThinking-effort: h\nHarness: c', {}), []);
  assert.deepStrictEqual(checkCommitMessage('Merge pull request #4 from o/ENG-1 [ENG-1]\n\nModel: m\nThinking-effort: high\nHarness: h', {}), []);
  assert.strictEqual(checkCommitMessage('Merge sort for reports [ENG-1]', {}).length, 4);
});

test('a direct push to the default branch is refused whatever it is called', () => {
  const line = 'refs/heads/ENG-1-ok aaaa refs/heads/master 0000000';
  assert.match(checkPushedRefs(line, {}, ['main', 'master'])[0], /direct push to master/);
});

test('the global changelog is docs/CHANGELOG.md when that is where the project keeps it; the template is not a changelog', () => {
  assert.deepStrictEqual(reqChangelogs(['backend/src/a.ts'], ['docs/CHANGELOG.md']), ['docs/CHANGELOG.md']);
  assert.deepStrictEqual(reqChangelogs(['templates/PRD.md'], ['templates/CHANGELOG.md']), []);
});

test('the commit-msg hook is exempt for fixup only, not for a merge subject without trailers', () => {
  assert.strictEqual(checkCommitMessage('Merge sort for reports [ENG-1]', {}, { allowFixup: true }).length, 4);
});

test('a queued run is newer than any finished one, so the finished pass cannot hide it', () => {
  const view = { state: 'OPEN', number: 1, title: 'ENG-1: x', reviewDecision: 'APPROVED', statusCheckRollup: [
    { workflowName: 'ci', name: 'pr-rules', conclusion: 'SUCCESS', status: 'COMPLETED', startedAt: '2026-10-26T10:00:00Z' },
    { workflowName: 'ci', name: 'pr-rules', conclusion: '', status: 'QUEUED', startedAt: '0001-01-01T00:00:00Z' },
  ] };
  assert.match(mergeBlockers(view).blockers.join(), /still running: pr-rules/);
});

test('a merge into the branch from the remote default branch needs the ticket and the trailers', () => {
  assert.deepStrictEqual(checkCommitMessage("Merge remote-tracking branch 'origin/main' into ENG-1-login\n\nModel: m\nThinking-effort: high\nHarness: h", {}), []);
  assert.ok(checkCommitMessage("Merge remote-tracking branch 'origin/main'", {}).length > 0);
});

test('a repository with only service changelogs fails P13, and a service changelog does not stand in for the global one', () => {
  assert.match(check.checkChangelog(check.parseNumstat('1\t0\tservices/api/CHANGELOG.md\n1\t0\tREADME.md'), ['services/api/CHANGELOG.md'])[0], /no global changelog/);
});

test('a branch default with a trailing newline from git is still protected', () => {
  assert.match(checkPushedRefs('refs/heads/release/stable aaaa refs/heads/release/stable 0000000', {}, ['main', 'release/stable'])[0], /direct push to release\/stable/);
});

test('a change request stays in force after a new push until its reviewer approves or dismisses it', () => {
  const author = { login: 'agent' };
  const h2 = 'h2';
  const rev = (login, state, oid) => ({ author: { login }, authorAssociation: 'MEMBER', state, commit: { oid } });
  assert.strictEqual(isApproved({ author, headRefOid: h2, reviewDecision: '', reviews: [
    rev('r1', 'CHANGES_REQUESTED', 'h1'), rev('r2', 'APPROVED', h2)] }), false);
  assert.strictEqual(isApproved({ author, headRefOid: h2, reviewDecision: '', reviews: [
    rev('r1', 'CHANGES_REQUESTED', 'h1'), rev('r1', 'APPROVED', h2), rev('r2', 'APPROVED', h2)] }), true);
});

test('only reviewers with write access count; a stranger neither approves nor blocks', () => {
  const author = { login: 'agent' };
  const rev = (login, state, authorAssociation) => ({ author: { login }, authorAssociation, state, commit: { oid: 'h' } });
  assert.strictEqual(isApproved({ author, headRefOid: 'h', reviews: [rev('x', 'APPROVED', 'NONE')] }), false);
  assert.strictEqual(isApproved({ author, headRefOid: 'h', reviews: [rev('x', 'APPROVED', 'CONTRIBUTOR')] }), false);
  assert.strictEqual(isApproved({ author, headRefOid: 'h', reviews: [rev('m', 'APPROVED', 'COLLABORATOR'), rev('x', 'CHANGES_REQUESTED', 'NONE')] }), true);
});

test('checks are keyed by workflow run: same-named workflows and push vs pull_request runs are judged separately', () => {
  const url = id => `https://github.com/o/r/actions/runs/${id}/job/1`;
  const runs = latestRuns([
    { workflowName: 'CI', name: 'test', conclusion: 'FAILURE', status: 'COMPLETED', startedAt: '2026-10-26T10:00:00Z', detailsUrl: url(1) },
    { workflowName: 'CI', name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED', startedAt: '2026-10-26T10:01:00Z', detailsUrl: url(2) },
  ]);
  assert.strictEqual(runs.length, 2);
  // A re-run keeps its run id; each job's own attempt says which is newer.
  assert.strictEqual(latestRuns([
    { workflowName: 'CI', name: 'test', conclusion: 'FAILURE', status: 'COMPLETED', jobAttempt: 1, detailsUrl: url(3) },
    { workflowName: 'CI', name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED', jobAttempt: 2, detailsUrl: url(3) },
  ]).length, 1);
  // Without attempts, both jobs of the run count: a stale failure may block, never hide.
  assert.strictEqual(latestRuns([
    { workflowName: 'CI', name: 'test', conclusion: 'FAILURE', status: 'COMPLETED', detailsUrl: url(3) },
    { workflowName: 'CI', name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED', detailsUrl: url(3) },
  ]).length, 2);
});

test('the merge title rule is the CI one: "<ticket>: <goal>"', () => {
  const view = { state: 'OPEN', number: 1, title: 'ENG-2 add y', headRefOid: 'h', author: { login: 'a' },
    reviews: [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: 'h' } }], statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }] };
  assert.match(mergeBlockers(view).blockers.join(), /PR title must be "<ticket>: <goal>"/);
});

test('a GitHub Enterprise origin is refused rather than retargeted to github.com', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghe-'));
  const cwd = process.cwd();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  process.chdir(dir);
  try {
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.enterprise.example/org/app.git']);
    assert.throws(() => originRepo(), /pass --repo <host>\/<owner>\/<name>/);
  } finally { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pushing a deletion of main is refused; deleting a feature branch is not', () => {
  const z = '0'.repeat(40);
  assert.match(check.checkPushedRefs(`(delete) ${z} refs/heads/main ${'a'.repeat(40)}\n`).join(), /deleting main is refused/);
  assert.deepStrictEqual(check.checkPushedRefs(`(delete) ${z} refs/heads/ENG-1-x ${'a'.repeat(40)}\n`), []);
});

test('a service changelog deleted by the PR is still required (P13)', () => {
  const all = ['CHANGELOG.md', 'services/api/CHANGELOG.md'];
  const files = check.parseNumstat('1\t0\tCHANGELOG.md\n0\t5\tservices/api/CHANGELOG.md\n1\t0\tservices/api/src/a.ts');
  assert.match(check.checkChangelog(files, all).join(), /services\/api\/CHANGELOG\.md/);
});

// merge-pr end to end against a fake gh: a bare repository stands in for GitHub, and `gh pr merge` performs the merge.
function mergeFixture(view) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-pr-'));
  const run = (args, cwd) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  run(['init', '-q', '--bare', '-b', 'main', 'origin.git'], root);
  const work = path.join(root, 'work');
  run(['clone', '-q', path.join(root, 'origin.git'), work], root);
  run(['commit', '-q', '--allow-empty', '-m', 'init'], work);
  run(['push', '-q', 'origin', 'HEAD:main'], work);
  run(['switch', '-q', '-c', 'ENG-1-x'], work);
  run(['commit', '-q', '--allow-empty', '-m', 'work'], work);
  run(['push', '-q', 'origin', 'ENG-1-x'], work);
  run(['switch', '-q', '--detach', 'main'], work);
  // origin names github.com/o/r. A git wrapper on PATH plays the network: it routes that URL to the bare repository,
  // invisibly to merge-pr's own URL checks (ls-remote --get-url, config), as GitHub would be reached.
  run(['remote', 'set-url', 'origin', 'https://github.com/o/r.git'], work);
  const head = run(['rev-parse', 'ENG-1-x'], work).trim();
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
case "$1 $2" in "ls-remote --get-url"|"config --get"|"config --get-regexp") exec "${realGit}" "$@";; esac
exec "${realGit}" -c "url.${path.join(root, 'origin.git')}.insteadOf=https://github.com/o/r.git" "$@"
`, { mode: 0o755 });
  fs.copyFileSync(path.join(bin, 'git'), path.join(bin, 'git-net'));
  fs.chmodSync(path.join(bin, 'git-net'), 0o755);
  const log = path.join(root, 'gh.log');
  const viewFile = path.join(root, 'view.json');
  fs.writeFileSync(viewFile, JSON.stringify({ headRefOid: head, ...view }));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs'); const { execFileSync } = require('child_process');
const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, a.join(' ') + '\\n');
if (a[0] === 'api' && a.some(x => x.endsWith('/permission'))) { process.stdout.write(JSON.stringify({ permission: a.some(x => x.includes('/stranger/')) ? 'read' : 'write' })); process.exit(0); }
if (a[0] === 'api' && a.some(x => x.includes('/actions/runs/'))) { process.stdout.write(process.env.FAKE_RUN || JSON.stringify({ path: '.github/workflows/ci.yml', event: 'pull_request', prs: [1], head: ${JSON.stringify(head)} })); process.exit(0); }
if (a[0] === 'api' && a.some(x => x.includes('/commits/'))) {
  const bare = ${JSON.stringify(path.join(root, 'origin.git'))};
  const g = args => execFileSync('git', args, { cwd: bare, encoding: 'utf8' });
  process.stdout.write(JSON.stringify({ parents: g(['rev-list', '--parents', '-n', '1', 'main']).trim().split(' ').slice(1), message: g(['log', '-1', '--format=%B', 'main']) }));
  process.exit(0);
}
if (a[0] === 'api' && a.some(x => x.startsWith('repos/') && x.split('/').length === 3)) { process.stdout.write(process.env.FAKE_AUTODELETE || 'false'); process.exit(0); }
if (a[0] === 'api' && a.some(x => x.includes('/pulls/') && x.includes('/files'))) { process.stdout.write(process.env.FAKE_FILES || '[[]]'); process.exit(0); }
if (a[0] === 'api' && a.some(x => x.startsWith('repos/') && x.split('/').length === 5 && x.includes('/pulls/'))) { process.stdout.write(process.env.FAKE_CHANGED || '0'); process.exit(0); }
if (a[0] === 'api' && a.some(x => x.includes('/pulls/') && x.includes('/commits'))) { process.stdout.write(process.env.FAKE_COMMITS || '[[]]'); process.exit(0); }
if (a[0] === 'api' && a.some(x => x.includes('lastEditedAt'))) { process.stdout.write(process.env.FAKE_EDITED || '[]'); process.exit(0); }
if (a[0] === 'api' && a.some(x => x.includes('mergeQueue'))) { process.stdout.write(process.env.FAKE_QUEUE || ''); process.exit(0); }
if (a[0] === 'api') { process.stdout.write(process.env.FAKE_UNRESOLVED || ''); process.exit(0); }
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write(process.env.FAKE_DEFAULT || 'main'); process.exit(0); }
if (a[0] === 'variable' && a[1] === 'get' && a[2] === 'LINEAR_TEAM' && !process.env.FAKE_NO_TEAM) { process.stdout.write('ENG'); process.exit(0); }
if (a[0] === 'variable' && a[1] === 'get') { if (process.env.FAKE_LONG_LIVED !== undefined) { process.stdout.write(process.env.FAKE_LONG_LIVED); process.exit(0); } process.stderr.write('variable ' + a[2] + ' was not found'); process.exit(1); }
if (a[0] === 'pr' && a[1] === 'view') {
  const v = JSON.parse(fs.readFileSync(${JSON.stringify(viewFile)}, 'utf8'));
  // The second full read is merge-pr's re-read just before merging: FAKE_RE* simulate changes made in between.
  const full = a.includes('title,body,headRefName,headRefOid,baseRefName,reviewDecision,reviews,author,statusCheckRollup,state,isCrossRepository,mergeCommit');
  const counter = ${JSON.stringify(path.join(root, 'views'))};
  const reads = full ? (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1 : 0;
  if (full) fs.writeFileSync(counter, String(reads));
  if (reads >= 2) { process.stdout.write(JSON.stringify({ ...v, baseRefName: process.env.FAKE_RETARGET || v.baseRefName, title: process.env.FAKE_RETITLE || v.title, reviews: process.env.FAKE_REREVIEW ? JSON.parse(process.env.FAKE_REREVIEW) : v.reviews, statusCheckRollup: process.env.FAKE_RECHECKS ? JSON.parse(process.env.FAKE_RECHECKS) : v.statusCheckRollup, body: process.env.FAKE_REBODY !== undefined ? process.env.FAKE_REBODY : v.body })); process.exit(0); }
  process.stdout.write(JSON.stringify(a[a.length - 1] === 'state,mergeCommit,baseRefName,title,body' ? { state: 'MERGED', mergeCommit: { oid: 'abcdef1234' }, baseRefName: process.env.FAKE_MERGED_BASE || v.baseRefName, title: process.env.FAKE_MERGED_TITLE || v.title, body: v.body } : v)); process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'merge') {
  const tmp = fs.mkdtempSync(require('os').tmpdir() + '/m-');
  const g = args => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: tmp });
  g(['clone', '-q', '-b', 'main', ${JSON.stringify(path.join(root, 'origin.git'))}, '.']);
  const val = flag => a[a.indexOf(flag) + 1];
  // like gh's --match-head-commit, merge exactly the pinned head
  g(['merge', '-q', '--no-ff', val('--match-head-commit'), '-m', val('--subject'), '-m', val('--body')]);
  g(['push', '-q', 'origin', 'HEAD:main']);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
  return { root, work, log, head, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

const PROV = ['--model', 'm', '--effort', 'high', '--harness', 'h'];

const mergeView = {
  state: 'OPEN', title: 'ENG-1: x', headRefName: 'ENG-1-x', baseRefName: 'main', isCrossRepository: false, author: { login: 'a' },
  statusCheckRollup: [{ name: 'pr-rules', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/5/job/7' }],
};

test('merge-pr merges the inspected head and deletes the local branch once the base contains it', () => {
  const f = mergeFixture(mergeView);
  const view = JSON.parse(fs.readFileSync(path.join(f.root, 'view.json'), 'utf8'));
  view.reviews = [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: f.head } }];
  fs.writeFileSync(path.join(f.root, 'view.json'), JSON.stringify(view));
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'merge-pr.js');
  execFileSync('node', [script, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8', stdio: 'pipe' });
  assert.match(fs.readFileSync(f.log, 'utf8'), new RegExp(`pr merge 1 --repo github.com/o/r --merge --match-head-commit ${f.head}`));
  assert.throws(() => execFileSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/ENG-1-x'], { cwd: f.work, stdio: 'pipe' }));
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('merge-pr leaves a same-named local branch alone when it is not the merged head', () => {
  const f = mergeFixture({ ...mergeView, isCrossRepository: true });
  const view = JSON.parse(fs.readFileSync(path.join(f.root, 'view.json'), 'utf8'));
  view.reviews = [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: f.head } }];
  fs.writeFileSync(path.join(f.root, 'view.json'), JSON.stringify(view));
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'merge-pr.js');
  const r = require('child_process').spawnSync('node', [script, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 3, 'merged, cleanup left: exit 3, not 1');
  assert.match(r.stderr, /in the fork and was not deleted/);
  execFileSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/ENG-1-x'], { cwd: f.work, stdio: 'pipe' });
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('merge-pr checks each reviewer\'s real permission: a read-only approver does not count', () => {
  const f = mergeFixture(mergeView);
  const view = JSON.parse(fs.readFileSync(path.join(f.root, 'view.json'), 'utf8'));
  // authorAssociation says MEMBER, but the permission API says read: the API wins.
  view.reviews = [{ author: { login: 'stranger' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: f.head } }];
  fs.writeFileSync(path.join(f.root, 'view.json'), JSON.stringify(view));
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'merge-pr.js');
  const r = require('child_process').spawnSync('node', [script, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no approval of the current head/);
  assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /pr merge/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a service removed from the head no longer needs its changelog; one still present does', () => {
  const all = ['CHANGELOG.md', 'services/api/CHANGELOG.md'];
  const files = check.parseNumstat('1\t0\tCHANGELOG.md\n0\t5\tservices/api/CHANGELOG.md\n0\t9\tservices/api/src/a.ts');
  assert.deepStrictEqual(check.checkChangelog(files, all, ['CHANGELOG.md', 'README.md']), []);
  assert.match(check.checkChangelog(files, all, ['CHANGELOG.md', 'services/api/src/b.ts']).join(), /services\/api\/CHANGELOG\.md/);
});

test('merge-pr does not touch local branches for a --repo that is not origin, and blocks on unresolved threads', () => {
  const f = mergeFixture(mergeView);
  const view = JSON.parse(fs.readFileSync(path.join(f.root, 'view.json'), 'utf8'));
  view.reviews = [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: f.head } }];
  fs.writeFileSync(path.join(f.root, 'view.json'), JSON.stringify(view));
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'merge-pr.js');
  const blocked = require('child_process').spawnSync('node', [script, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_UNRESOLVED: '1\n1\n' }, encoding: 'utf8' });
  assert.strictEqual(blocked.status, 1);
  assert.match(blocked.stderr, /2 review thread\(s\) are unresolved/);
  const other = require('child_process').spawnSync('node', [script, '1', '--repo', 'upstream/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.match(other.stderr, /not in origin's repository and was not deleted/);
  execFileSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/ENG-1-x'], { cwd: f.work, stdio: 'pipe' });
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a newer run of the same workflow file and event replaces an older failure; different files or events do not', () => {
  const c = (id, path, event, conclusion, t) => ({ name: 'pr-rules', conclusion, status: 'COMPLETED', startedAt: `2026-10-26T10:0${t}:00Z`,
    detailsUrl: `https://github.com/o/r/actions/runs/${id}/job/1`, workflowPath: path, event });
  // edited event after a title fix: same file and event, new run id
  assert.strictEqual(latestRuns([c(100, 'a.yml', 'pull_request', 'FAILURE', 0), c(200, 'a.yml', 'pull_request', 'SUCCESS', 1)]).length, 1);
  assert.strictEqual(latestRuns([c(100, 'a.yml', 'push', 'FAILURE', 0), c(200, 'a.yml', 'pull_request', 'SUCCESS', 1)]).length, 2);
  assert.strictEqual(latestRuns([c(100, 'a.yml', 'pull_request', 'FAILURE', 0), c(200, 'b.yml', 'pull_request', 'SUCCESS', 1)]).length, 2);
});

test('only <ticket>-<slug> is a ticket branch: main, the default branch, and release/* never are', () => {
  for (const b of ['main', 'trunk', 'release/1.4', 'staging']) assert.ok(!check.isTicketBranch(b, {}), b);
  assert.ok(check.isTicketBranch('ENG-1-x', {}));
});

test('merge-pr from a long-lived head merges without --delete-branch and keeps the local branch', () => {
  const f = mergeFixture({ ...mergeView, headRefName: 'release/1.4' });
  const run = (args) => execFileSync('git', args, { cwd: f.work, encoding: 'utf8' });
  run(['branch', 'release/1.4', f.head]);
  const view = JSON.parse(fs.readFileSync(path.join(f.root, 'view.json'), 'utf8'));
  view.reviews = [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: f.head } }];
  fs.writeFileSync(path.join(f.root, 'view.json'), JSON.stringify(view));
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'merge-pr.js');
  const out = execFileSync('node', [script, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8', stdio: 'pipe' });
  assert.match(out, /is not a ticket branch and stays/);
  const merge = fs.readFileSync(f.log, 'utf8').split('\n').find(l => l.startsWith('pr merge'));
  assert.doesNotMatch(merge, /--delete-branch/);
  run(['rev-parse', '--verify', '--quiet', 'refs/heads/release/1.4']);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a reviewer login the permission API rejects is not a writer, and merge-pr does not crash', () => {
  const f = mergeFixture(mergeView);
  const view = JSON.parse(fs.readFileSync(path.join(f.root, 'view.json'), 'utf8'));
  view.reviews = [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: f.head } },
    { author: { login: 'gone-bot' }, authorAssociation: 'NONE', state: 'CHANGES_REQUESTED', commit: { oid: f.head } }];
  fs.writeFileSync(path.join(f.root, 'view.json'), JSON.stringify(view));
  const ghPath = path.join(f.root, 'bin', 'gh');
  fs.writeFileSync(ghPath, fs.readFileSync(ghPath, 'utf8').replace("if (a[0] === 'api' && a.some(x => x.endsWith('/permission')))",
    "if (a[0] === 'api' && a.some(x => x.includes('/gone-bot/'))) { process.stderr.write('HTTP 404'); process.exit(1); }\nif (a[0] === 'api' && a.some(x => x.endsWith('/permission')))"));
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'merge-pr.js');
  const r = require('child_process').spawnSync('node', [script, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('pr mode run from a subdirectory still requires the service changelog, and a PR\'s .gitattributes cannot hide lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prmode-'));
  const g = (args, cwd = dir) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(dir, 'svc/api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# c\n');
  fs.writeFileSync(path.join(dir, 'svc/api/CHANGELOG.md'), '# c\n');
  fs.writeFileSync(path.join(dir, 'svc/api/a.js'), '1\n');
  g(['add', '-A']); g(['commit', '-q', '-m', 'init']);
  g(['switch', '-q', '-c', 'ENG-1-x']);
  fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), '- x\n');
  fs.writeFileSync(path.join(dir, 'svc/api/big.js'), 'x\n'.repeat(600));
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.js -diff\n');
  g(['add', '-A']); g(['commit', '-q', '-m', 'work']);
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const r = require('child_process').spawnSync('node', [script, 'pr', '--base', 'main', '--title', 'ENG-1: x'], { cwd: path.join(dir, 'svc'), encoding: 'utf8', env: { ...process.env, CI: '1', LINEAR_TEAM: 'ENG' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /svc\/api\/CHANGELOG\.md/);
  assert.match(r.stderr, /PR changes \d{3,} lines/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P13 counts a lockfile-only change, and a global changelog moved to docs/ is accepted at its new place', () => {
  const all = ['CHANGELOG.md', 'docs/CHANGELOG.md', 'services/api/CHANGELOG.md'];
  const lock = check.parseNumstat('1\t0\tdocs/CHANGELOG.md\n3\t3\tservices/api/package-lock.json');
  assert.match(check.checkChangelog(lock, all, ['docs/CHANGELOG.md', 'services/api/package-lock.json']).join(), /services\/api\/CHANGELOG\.md/);
  const moved = check.parseNumstat('0\t3\tCHANGELOG.md\n4\t0\tdocs/CHANGELOG.md');
  assert.deepStrictEqual(check.checkChangelog(moved, all, ['docs/CHANGELOG.md']), []);
});

test('merge-pr deletes only the verified commit: a branch that moves after the check survives', () => {
  const f = mergeFixture(mergeView);
  const view = JSON.parse(fs.readFileSync(path.join(f.root, 'view.json'), 'utf8'));
  view.reviews = [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: f.head } }];
  fs.writeFileSync(path.join(f.root, 'view.json'), JSON.stringify(view));
  // A git wrapper that advances the branch with an unpublished commit while merge-pr fetches.
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(f.root, 'bin', 'git'), `#!/bin/sh
if [ "$1" = fetch ]; then "${path.join(f.root, 'bin', 'git-net')}" "$@" || exit $?; t=$("${realGit}" commit-tree -p ENG-1-x -m late "$("${realGit}" rev-parse ENG-1-x^{tree})"); "${realGit}" update-ref refs/heads/ENG-1-x "$t"; exit 0; fi
exec "${path.join(f.root, 'bin', 'git-net')}" "$@"
`, { mode: 0o755 });
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'merge-pr.js');
  const r = require('child_process').spawnSync('node', [script, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, /not deleted/);
  execFileSync(realGit, ['rev-parse', '--verify', '--quiet', 'refs/heads/ENG-1-x'], { cwd: f.work, stdio: 'pipe' });
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('optional review still respects a writer\'s change request, and a pr-rules check must be present', () => {
  const base = { state: 'OPEN', number: 1, title: 'ENG-1: x', headRefOid: 'h', author: { login: 'a' }, statusCheckRollup: [{ name: 'pr-rules', conclusion: 'SUCCESS', workflowPath: '.github/workflows/pr-rules.yml', event: 'pull_request', runPrs: [1] }] };
  const cr = { ...base, reviews: [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'CHANGES_REQUESTED', commit: { oid: 'h' } }] };
  assert.match(mergeBlockers(cr, { reviewOptional: true }).blockers.join(), /requested changes/);
  assert.deepStrictEqual(mergeBlockers({ ...base, reviews: [] }, { reviewOptional: true }).blockers, []);
  assert.match(mergeBlockers({ ...base, reviews: [], statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }] }, { reviewOptional: true }).blockers.join(), /no passing pr-rules Actions check/);
});

test('a newer SKIPPED run does not hide an older failure of the same job', () => {
  const id = { workflowPath: 'ci.yml', event: 'pull_request', name: 'test', status: 'COMPLETED' };
  const runs = latestRuns([{ ...id, conclusion: 'FAILURE', startedAt: '2026-10-26T10:00:00Z' }, { ...id, conclusion: 'SKIPPED', startedAt: '2026-10-26T10:05:00Z' }]);
  assert.strictEqual(runs[0].conclusion, 'FAILURE');
});

test('P11 counts a rename once; BRAIN_LONG_LIVED and amend!/Reapply are honoured; .env comments are stripped', () => {
  const renamed = check.parseNumstatRenames('0\t0\t\0old.js\0new.js\0' + '1\t0\tCHANGELOG.md\0');
  assert.deepStrictEqual(renamed.map(f => [f.path, f.lines]), [['new.js', 0], ['CHANGELOG.md', 1]]);
  assert.deepStrictEqual(check.checkBranchName('staging', { BRAIN_LONG_LIVED: '^(staging|develop)$' }), []);
  assert.strictEqual(check.checkBranchName('staging', {}).length, 1);
  assert.deepStrictEqual(check.checkCommitMessage('amend! feat: x [ENG-1]', {}, { allowFixup: true }), []);
  const reapply = 'Reapply "feat: x [ENG-1]"\n\nENG-1\n\nModel: m\nThinking-effort: high\nHarness: h';
  assert.deepStrictEqual(check.checkCommitMessage(reapply, {}), []);
});

test('the commits and push CLI paths read real git: parent counts, origin/HEAD, stdin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  const g = (args, cwd = dir) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  g(['init', '-q', '-b', 'trunk']); g(['commit', '-q', '--allow-empty', '-m', 'init']);
  g(['switch', '-q', '-c', 'ENG-1-x']);
  g(['commit', '-q', '--allow-empty', '-m', 'Merge pull request #9 [ENG-1]']);
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const commits = require('child_process').spawnSync('node', [script, 'commits', '--base', 'trunk'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: '1', LINEAR_TEAM: 'ENG' } });
  assert.strictEqual(commits.status, 1, 'a one-parent "Merge pull request" commit is held to the anatomy');
  g(['update-ref', 'refs/remotes/origin/trunk', 'trunk']); g(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
  const sha = g(['rev-parse', 'HEAD']).trim();
  const push = require('child_process').spawnSync('node', [script, 'push'], { cwd: dir, encoding: 'utf8', input: `refs/heads/ENG-1-x ${sha} refs/heads/trunk ${'0'.repeat(40)}\n` });
  assert.strictEqual(push.status, 1);
  assert.match(push.stderr, /direct push to trunk is refused/);
  assert.doesNotMatch(push.stderr, /fatal/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('merge-pr refuses unknown options and missing provenance, puts the trailers in the merge commit, and deletes the remote branch only at the merged head', () => {
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'merge-pr.js');
  for (const args of [['1', '--dry-run', ...PROV], ['1'], ['1', '--model', 'm']]) {
    assert.strictEqual(require('child_process').spawnSync('node', [script, ...args], { encoding: 'utf8' }).status, 2, args.join(' '));
  }
  const f = mergeFixture(mergeView);
  const view = JSON.parse(fs.readFileSync(path.join(f.root, 'view.json'), 'utf8'));
  view.reviews = [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: f.head } }];
  fs.writeFileSync(path.join(f.root, 'view.json'), JSON.stringify(view));
  // Another agent pushes to the branch after the review: the remote branch must survive the cleanup.
  const other = path.join(f.root, 'other');
  execFileSync('git', ['clone', '-q', '-b', 'ENG-1-x', path.join(f.root, 'origin.git'), other]);
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'late'], { cwd: other });
  execFileSync('git', ['push', '-q', 'origin', 'ENG-1-x'], { cwd: other });
  const r = require('child_process').spawnSync('node', [script, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, /remote branch ENG-1-x not deleted/);
  execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: path.join(f.root, 'origin.git'), stdio: 'pipe' });
  assert.match(fs.readFileSync(f.log, 'utf8'), /--body Model: m\nThinking-effort: high\nHarness: h/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a delayed job of an older workflow run does not outrank a newer run', () => {
  const id = { workflowPath: 'ci.yml', event: 'pull_request', name: 'test', status: 'COMPLETED' };
  const runs = latestRuns([
    { ...id, conclusion: 'SUCCESS', runCreated: '2026-10-26T10:00:00Z', startedAt: '2026-10-26T10:05:00Z' },
    { ...id, conclusion: 'FAILURE', runCreated: '2026-10-26T10:01:00Z', startedAt: '2026-10-26T10:01:30Z' },
  ]);
  assert.strictEqual(runs[0].conclusion, 'FAILURE');
});

function approvedFixture(view = mergeView) {
  const f = mergeFixture(view);
  const v = JSON.parse(fs.readFileSync(path.join(f.root, 'view.json'), 'utf8'));
  v.reviews = [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: f.head } }];
  fs.writeFileSync(path.join(f.root, 'view.json'), JSON.stringify(v));
  return f;
}
const mergeScript = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'merge-pr.js');
function patchGh(f, before, line) {
  const p = path.join(f.root, 'bin', 'gh');
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(src.includes(before), 'fake gh patch point not found');
  fs.writeFileSync(p, src.replace(before, line + '\n' + before));
}

test('a separate pushurl never receives the remote deletion', () => {
  const f = approvedFixture();
  const fork = path.join(f.root, 'fork.git');
  execFileSync('git', ['clone', '-q', '--bare', path.join(f.root, 'origin.git'), fork]);
  execFileSync('git', ['config', 'remote.origin.pushurl', fork], { cwd: f.work });
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: fork, stdio: 'pipe' });
  assert.throws(() => execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: path.join(f.root, 'origin.git'), stdio: 'pipe' }));
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('an unreadable protection state keeps the branch and reports cleanup left', () => {
  const f = approvedFixture();
  patchGh(f, "if (a[0] === 'api' && a.some(x => x.includes('/actions/runs/')))", "if (a[0] === 'api' && a.some(x => x.includes('/branches/'))) { process.stderr.write('HTTP 503'); process.exit(1); }");
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 3, r.stderr);
  execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: path.join(f.root, 'origin.git'), stdio: 'pipe' });
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a skipped pr-rules check does not count as the rules having run', () => {
  const view = { state: 'OPEN', number: 1, title: 'ENG-1: x', headRefOid: 'h', author: { login: 'a' },
    reviews: [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: 'h' } }],
    statusCheckRollup: [{ name: 'pr-rules', conclusion: 'SKIPPED' }, { name: 'test', conclusion: 'SUCCESS' }] };
  assert.match(mergeBlockers(view).blockers.join(), /no passing pr-rules Actions check/);
});

test('a remote branch GitHub already deleted after the merge is P7 done, not cleanup left', () => {
  const f = approvedFixture();
  patchGh(f, "  fs.rmSync(tmp, { recursive: true, force: true });\n  process.exit(0);", "  execFileSync('git', ['update-ref', '-d', 'refs/heads/ENG-1-x'], { cwd: " + JSON.stringify(path.join(f.root, 'origin.git')) + " });");
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a merge queue on the base is refused before anything changes', () => {
  const f = approvedFixture();
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_QUEUE: 'MQ_1' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /has a merge queue/);
  assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /pr merge/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('--repo github.com/o/r is origin\'s own repository, and a checked-out branch gets an accurate message', () => {
  const f = approvedFixture();
  execFileSync('git', ['worktree', 'add', '-q', path.join(f.root, 'ENG-1-x'), 'ENG-1-x'], { cwd: f.work });
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'github.com/o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, /remove that worktree/);
  assert.match(r.stdout, /cleanup of ENG-1-x is incomplete/);
  assert.throws(() => execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: path.join(f.root, 'origin.git'), stdio: 'pipe' }), 'the remote branch was deleted: origin is the target');
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('pr-rules.yml passes LINEAR_TEAM and BRAIN_LONG_LIVED from repository variables, and the checker honours them', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'templates', 'pr-rules.yml'), 'utf8');
  assert.match(yml, /^\s+LINEAR_TEAM: \$\{\{ vars\.LINEAR_TEAM \}\}$/m);
  assert.match(yml, /^\s+BRAIN_LONG_LIVED: \$\{\{ vars\.BRAIN_LONG_LIVED \}\}$/m);
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const r = require('child_process').spawnSync('node', [script, 'branch', 'develop'], { encoding: 'utf8', env: { ...process.env, CI: '1', LINEAR_TEAM: 'ENG', BRAIN_LONG_LIVED: '^(staging|develop)$' } });
  assert.strictEqual(r.status, 0, r.stderr);
});

test('a pushInsteadOf rewrite of origin leaves the remote branch alone', () => {
  const f = approvedFixture();
  const elsewhere = path.join(f.root, 'elsewhere.git');
  execFileSync('git', ['clone', '-q', '--bare', path.join(f.root, 'origin.git'), elsewhere]);
  execFileSync('git', ['config', `url.${elsewhere}.pushInsteadOf`, 'https://github.com/o/'], { cwd: f.work });
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, /pushInsteadOf/);
  for (const bare of [elsewhere, path.join(f.root, 'origin.git')]) execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: bare, stdio: 'pipe' });
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('re-run attempts of one run are judged by each job\'s own attempt, whatever the array order', () => {
  const id = { workflowPath: 'ci.yml', event: 'pull_request', name: 'B', status: 'COMPLETED', runCreated: '2026-10-26T10:00:00Z', detailsUrl: 'https://github.com/o/r/actions/runs/77/job/1' };
  const a1 = { ...id, conclusion: 'SUCCESS', jobAttempt: 1 };
  const a2 = { ...id, conclusion: 'FAILURE', jobAttempt: 2 };
  for (const order of [[a1, a2], [a2, a1]]) assert.deepStrictEqual(latestRuns(order).map(c => c.conclusion), ['FAILURE']);
});

test('the .env of the main checkout serves a ticket worktree, and a missing message file is bad usage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-'));
  const main = path.join(dir, 'app');
  fs.mkdirSync(main);
  const g = (args, cwd = main) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']); g(['commit', '-q', '--allow-empty', '-m', 'init']);
  fs.writeFileSync(path.join(main, '.env'), 'BRAIN_LONG_LIVED=^(staging)$\n');
  g(['worktree', 'add', '-q', path.join(dir, 'ENG-1-x'), '-b', 'ENG-1-x']);
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const env = { ...process.env }; delete env.CI; delete env.BRAIN_LONG_LIVED; delete env.LINEAR_TEAM;
  const r = require('child_process').spawnSync('node', [script, 'branch', 'staging'], { cwd: path.join(dir, 'ENG-1-x'), encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(require('child_process').spawnSync('node', [script, 'commit-msg', path.join(dir, 'nope')], { encoding: 'utf8' }).status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a merge not made by merge-pr, and a protected ticket branch, are reported as incomplete', () => {
  const f = approvedFixture();
  patchGh(f, "if (a[0] === 'pr' && a[1] === 'merge') {", "if (a[0] === 'pr' && a[1] === 'merge' && !process.env.FAKE_DONE) { process.stderr.write('auto-merge already enabled'); process.exit(1); }");
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, /merged, but not by this run, and its merge commit does not meet the rules; the branches were kept/);
  execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: path.join(f.root, 'origin.git'), stdio: 'pipe' });
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('an insteadOf rule that rewrites origin leaves the remote branch alone', () => {
  const f = approvedFixture();
  const wrong = path.join(f.root, 'wrong.git');
  execFileSync('git', ['clone', '-q', '--bare', path.join(f.root, 'origin.git'), wrong]);
  execFileSync('git', ['config', `url.${wrong}.insteadOf`, 'https://github.com/o/r.git'], { cwd: f.work });
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, /insteadOf rule rewrites/);
  execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: wrong, stdio: 'pipe' });
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('one ticket per PR: branch, title, and commits must agree', () => {
  const ok = { branch: 'ENG-1-feature', title: 'ENG-1: feature', messages: ['feat: a [ENG-1]', "Merge branch 'main' into ENG-1-feature\n\nENG-1"] };
  assert.deepStrictEqual(check.checkOneTicket(ok, {}), []);
  const mixed = { branch: 'ENG-1-feature', title: 'ENG-3: feature', messages: ['feat: a [ENG-2]', 'fix: b [ENG-4]'] };
  assert.match(check.checkOneTicket(mixed, {}).join(), /one ticket per PR: ENG-1 \(branch\) vs ENG-3 \(title\) vs ENG-2 \(commit 1\) vs ENG-4 \(commit 2\)/);
  assert.deepStrictEqual(check.checkOneTicket({ branch: 'release/1.4', title: 'ENG-7: backport', messages: ['fix: x [ENG-7]'] }, {}), []);
});

test('the merge commit is verified before cleanup; a re-run on a merged PR cleans up; an unreadable outcome is exit 4', () => {
  // first run: the state cannot be read after the merge call
  const f = approvedFixture();
  patchGh(f, "if (a[0] === 'pr' && a[1] === 'view') {", "if (a[0] === 'pr' && a[1] === 'view' && a[a.length - 1] === 'state,mergeCommit,baseRefName,title,body' && !fs.existsSync(" + JSON.stringify(path.join(f.root, 'ok')) + ")) { process.stderr.write('HTTP 503'); process.exit(1); }");
  const first = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(first.status, 4, first.stderr);
  execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: path.join(f.root, 'origin.git'), stdio: 'pipe' });
  // second run: the PR reads as MERGED; the merge commit is verified, then the branches go
  fs.writeFileSync(path.join(f.root, 'ok'), '');
  const view = JSON.parse(fs.readFileSync(path.join(f.root, 'view.json'), 'utf8'));
  fs.writeFileSync(path.join(f.root, 'view.json'), JSON.stringify({ ...view, state: 'MERGED' }));
  const second = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(second.status, 0, second.stderr);
  assert.strictEqual((fs.readFileSync(f.log, 'utf8').match(/^pr merge/gm) || []).length, 1, 'merged once');
  assert.throws(() => execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: path.join(f.root, 'origin.git'), stdio: 'pipe' }));
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a squash merge (one parent) does not pass as P15, and the branches are kept', () => {
  const f = approvedFixture();
  patchGh(f, "if (a[0] === 'pr' && a[1] === 'merge') {", "if (a[0] === 'pr' && a[1] === 'merge') { const tmp = fs.mkdtempSync(require('os').tmpdir() + '/m-'); const g = args => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: tmp }); g(['clone', '-q', '-b', 'main', " + JSON.stringify(path.join(f.root, 'origin.git')) + ", '.']); g(['commit', '-q', '--allow-empty', '-m', 'squashed [ENG-1]']); g(['push', '-q', 'origin', 'HEAD:main']); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }");
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, /is not a merge commit of the inspected head/);
  execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: path.join(f.root, 'origin.git'), stdio: 'pipe' });
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a not-yet-started job of a re-run attempt is newest whatever the array order', () => {
  const id = { workflowPath: 'ci.yml', event: 'pull_request', name: 'B', runCreated: '2026-10-26T10:00:00Z', detailsUrl: 'https://github.com/o/r/actions/runs/77/job/1' };
  const done = { ...id, status: 'COMPLETED', conclusion: 'SUCCESS', jobAttempt: 1 };
  const queued = { ...id, status: 'QUEUED', jobAttempt: 2 };
  for (const order of [[done, queued], [queued, done]]) assert.ok(isPending(latestRuns(order)[0]));
});

test('two jobs with the same name in one run and attempt are siblings: either failing blocks', () => {
  const id = { workflowPath: 'ci.yml', event: 'pull_request', name: 'test', status: 'COMPLETED', runCreated: '2026-10-26T10:00:00Z', jobAttempt: 1 };
  const runs = latestRuns([{ ...id, conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/9/job/1' }, { ...id, conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/9/job/2' }]);
  assert.strictEqual(runs.length, 2);
  const view = { state: 'OPEN', number: 1, title: 'ENG-1: x', headRefOid: 'h', author: { login: 'a' }, reviews: [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: 'h' } }],
    statusCheckRollup: [{ name: 'pr-rules', conclusion: 'SUCCESS', workflowPath: '.github/workflows/pr-rules.yml', event: 'pull_request', runPrs: [1] }, ...runs] };
  assert.match(mergeBlockers(view).blockers.join(), /CI is not green: test/);
});

test('deleting a service changelog while the service stays fails P13', () => {
  const all = ['CHANGELOG.md', 'services/api/CHANGELOG.md'];
  const files = check.parseNumstat('1\t0\tCHANGELOG.md\n0\t5\tservices/api/CHANGELOG.md');
  assert.match(check.checkChangelog(files, all, ['CHANGELOG.md', 'services/api/app.js']).join(), /services\/api\/CHANGELOG\.md/);
});

test('merge-pr re-checks one ticket at merge time: a retitle after a green pr-rules run is caught', () => {
  const view = { state: 'OPEN', number: 1, title: 'ENG-2: x', headRefName: 'ENG-1-x', headRefOid: 'h', author: { login: 'a' },
    commitMessages: ['feat: x [ENG-1]'],
    reviews: [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: 'h' } }], statusCheckRollup: [{ name: 'pr-rules', conclusion: 'SUCCESS', workflowPath: '.github/workflows/pr-rules.yml', event: 'pull_request', runPrs: [1] }] };
  assert.match(mergeBlockers(view).blockers.join(), /one ticket per PR/);
});

test('one ticket: a release promotion checks only its title; reverts and merges are attributed to their own ticket', () => {
  assert.deepStrictEqual(check.checkOneTicket({ branch: 'release/1.0', title: 'ENG-3: release 1.0', messages: ['Merge pull request #1 [ENG-1]', 'Merge pull request #2 [ENG-2]'] }, {}), []);
  const revert = 'Revert "feat(b): add b [ENG-2]"\n\nUndo for [ENG-5]\n\nModel: m';
  assert.deepStrictEqual(check.checkOneTicket({ branch: 'ENG-5-undo', title: 'ENG-5: undo b', messages: [revert] }, {}), []);
  assert.deepStrictEqual(check.checkOneTicket({ branch: 'ENG-2-b', title: 'ENG-2: b', messages: ["Merge branch 'ENG-1-a' into ENG-2-b\n\nENG-2"] }, {}), []);
});

test('a worktree .env without a key falls back to the main checkout for that key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv2-'));
  const main = path.join(dir, 'app');
  fs.mkdirSync(main);
  const g = (args, cwd = main) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']); g(['commit', '-q', '--allow-empty', '-m', 'init']);
  fs.writeFileSync(path.join(main, '.env'), 'LINEAR_TEAM=ENG\n');
  const wt = path.join(dir, 'ENG-1-x');
  g(['worktree', 'add', '-q', wt, '-b', 'ENG-1-x']);
  fs.writeFileSync(path.join(wt, '.env'), 'PORT=3001\n');
  fs.writeFileSync(path.join(dir, 'msg'), 'feat(a): x [ABC-1]\n\nModel: m\nThinking-effort: h\nHarness: c\n');
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const env = { ...process.env }; delete env.CI; delete env.LINEAR_TEAM; delete env.BRAIN_LONG_LIVED;
  assert.strictEqual(require('child_process').spawnSync('node', [script, 'commit-msg', path.join(dir, 'msg')], { cwd: wt, encoding: 'utf8', env }).status, 1, 'ABC is not the ENG team');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('local cleanup removes the deleted branch\'s tracking config', () => {
  const f = approvedFixture();
  execFileSync('git', ['config', 'branch.ENG-1-x.remote', 'origin'], { cwd: f.work });
  const ok = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.throws(() => execFileSync('git', ['config', '--get', 'branch.ENG-1-x.remote'], { cwd: f.work, stdio: 'pipe' }));
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a pr-rules pass from before the last title, body, or base change does not count', () => {
  const base = { state: 'OPEN', number: 1, title: 'ENG-1: x', headRefOid: 'h', author: { login: 'a' },
    reviews: [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: 'h' } }],
    statusCheckRollup: [{ name: 'pr-rules', conclusion: 'SUCCESS', workflowPath: '.github/workflows/pr-rules.yml', event: 'pull_request', runPrs: [1], runCreated: '2026-10-26T10:00:00Z', startedAt: '2026-10-26T10:06:00Z' }] };
  // a Size-exception removed from the body, a retitle, or a new base all move metadataChangedAt; a job that started
  // after the edit still checked the run's older snapshot
  assert.match(mergeBlockers({ ...base, metadataChangedAt: '2026-10-26T10:05:00Z' }).blockers.join(), /pr-rules last passed before/);
  assert.deepStrictEqual(mergeBlockers({ ...base, metadataChangedAt: '2026-10-26T09:55:00Z' }).blockers, []);
});

test('end to end: merge-pr refuses after an edit newer than the pr-rules pass', () => {
  const f = approvedFixture({ ...mergeView, statusCheckRollup: [{ name: 'pr-rules', conclusion: 'SUCCESS', workflowPath: '.github/workflows/pr-rules.yml', event: 'pull_request', runPrs: [1], runCreated: '2026-10-26T10:00:00Z', startedAt: '2026-10-26T10:06:00Z' }] });
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_EDITED: '["2026-10-26T10:05:00Z"]' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /pr-rules last passed before/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a release promotion passes pr mode end to end, while a mixed-ticket feature branch fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-'));
  const g = (args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# c\n'); g(['add', '-A']); g(['commit', '-q', '-m', 'init']);
  const T = '\n\nModel: m\nThinking-effort: h\nHarness: c';
  g(['switch', '-q', '-c', 'release/1.0']);
  for (const t of ['ENG-1', 'ENG-2']) { fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), `- ${t}\n`); g(['commit', '-q', '-am', `feat: ${t} [${t}]${T}`]); }
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const run = (branch, title) => require('child_process').spawnSync('node', [script, 'pr', '--base', 'main', '--branch', branch, '--title', title], { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: '1', LINEAR_TEAM: 'ENG' } });
  assert.strictEqual(run('release/1.0', 'ENG-3: release 1.0').status, 0);
  g(['branch', '-m', 'ENG-1-mixed']);
  assert.match(run('ENG-1-mixed', 'ENG-1: mixed').stderr, /one ticket per PR/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reapply is attributed like revert', () => {
  const msg = 'Reapply "feat(b): add b [ENG-2]"\n\nBack for [ENG-6]';
  assert.deepStrictEqual(check.checkOneTicket({ branch: 'ENG-6-b', title: 'ENG-6: b again', messages: [msg] }, {}), []);
});

test('every gh command names the host, so GH_HOST cannot redirect it', () => {
  const f = approvedFixture();
  const r = require('child_process').spawnSync('node', [mergeScript, '1', ...PROV], { cwd: f.work, env: { ...f.env, GH_HOST: 'enterprise.example' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  for (const line of fs.readFileSync(f.log, 'utf8').split('\n').filter(l => /^(pr|repo|variable) /.test(l))) assert.match(line, /--repo github\.com\/o\/r|repo view github\.com\/o\/r|--org o$/, line);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a change of origin during the run stops cleanup', () => {
  const f = approvedFixture();
  const other = path.join(f.root, 'other.git');
  execFileSync('git', ['clone', '-q', '--bare', path.join(f.root, 'origin.git'), other]);
  patchGh(f, "  fs.rmSync(tmp, { recursive: true, force: true });\n  process.exit(0);", "  execFileSync('git', ['remote', 'set-url', 'origin', " + JSON.stringify(other) + "], { cwd: " + JSON.stringify(f.work) + " });");
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, /origin changed during the run/);
  execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: other, stdio: 'pipe' });
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a partial re-run of one of two same-named jobs keeps the other job\'s failure', () => {
  const id = { workflowPath: 'ci.yml', event: 'pull_request', name: 'test', status: 'COMPLETED', runCreated: '2026-10-26T10:00:00Z' };
  const url = j => `https://github.com/o/r/actions/runs/9/job/${j}`;
  const runs = latestRuns([
    { ...id, conclusion: 'FAILURE', jobAttempt: 1, detailsUrl: url(1) },
    { ...id, conclusion: 'SUCCESS', jobAttempt: 1, detailsUrl: url(2) },
    { ...id, conclusion: 'SUCCESS', jobAttempt: 2, detailsUrl: url(3) },
  ]);
  assert.ok(runs.some(c => c.conclusion === 'FAILURE'));
});

test('an unprotected long-lived head is refused when the repository deletes head branches on merge', () => {
  const f = approvedFixture({ ...mergeView, headRefName: 'release/1.4' });
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_AUTODELETE: 'true' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /deletes head branches on merge/);
  assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /^pr merge/m);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a dismissed review withdraws its reviewer\'s verdict rather than reviving an older change request', () => {
  const rev = (state, oid) => ({ author: { login: 'w' }, authorAssociation: 'MEMBER', state, commit: { oid } });
  const view = { state: 'OPEN', number: 1, title: 'ENG-1: x', headRefOid: 'h2', author: { login: 'a' }, reviews: [rev('CHANGES_REQUESTED', 'h0'), rev('DISMISSED', 'h1')],
    statusCheckRollup: [{ name: 'pr-rules', conclusion: 'SUCCESS', workflowPath: '.github/workflows/pr-rules.yml', event: 'pull_request', runPrs: [1] }] };
  assert.deepStrictEqual(mergeBlockers(view, { reviewOptional: true }).blockers, []);
});

test('merge-pr reads full commit messages: a long subject keeps its trailing ticket', () => {
  const f = approvedFixture();
  const long = 'fix(api): stop retrying ENG-7 webhooks forever when the upstream returns 410 for good [ENG-1]';
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_COMMITS: JSON.stringify([[{ commit: { message: long } }]]) }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('.env.example parses in a shell and through dotenv', () => {
  const ex = fs.readFileSync(path.join(__dirname, '..', 'project', '.env.example'), 'utf8').replace(/^# (BRAIN_LONG_LIVED=)/m, '$1');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envex-'));
  fs.writeFileSync(path.join(dir, '.env'), ex);
  const out = execFileSync('bash', ['-ec', 'set -a; . ./.env; printf %s "$BRAIN_LONG_LIVED"'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(out, '^(staging|develop)$');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a partial re-run of either sibling keeps every job of the run: a fixed failure still needs a full re-run', () => {
  const id = { workflowPath: 'ci.yml', event: 'pull_request', name: 'test', status: 'COMPLETED', runCreated: '2026-10-26T10:00:00Z' };
  const url = j => `https://github.com/o/r/actions/runs/9/job/${j}`;
  const runs = latestRuns([
    { ...id, conclusion: 'FAILURE', jobAttempt: 1, detailsUrl: url(1) },
    { ...id, conclusion: 'SUCCESS', jobAttempt: 1, detailsUrl: url(2) },
    { ...id, conclusion: 'SUCCESS', jobAttempt: 2, detailsUrl: url(3) },
  ]);
  assert.strictEqual(runs.length, 3, 'the re-run cannot say which sibling it replaced');
});

test('a change request after a dismissed approval still blocks; a dismissed approval never counts', () => {
  const rev = (state, oid) => ({ author: { login: 'w' }, authorAssociation: 'MEMBER', state, commit: { oid } });
  const base = { state: 'OPEN', number: 1, title: 'ENG-1: x', headRefOid: 'h2', author: { login: 'a' }, statusCheckRollup: [{ name: 'pr-rules', conclusion: 'SUCCESS', workflowPath: '.github/workflows/pr-rules.yml', event: 'pull_request', runPrs: [1] }] };
  assert.match(mergeBlockers({ ...base, reviews: [rev('DISMISSED', 'h1'), rev('CHANGES_REQUESTED', 'h2')] }, { reviewOptional: true }).blockers.join(), /requested changes/);
  assert.match(mergeBlockers({ ...base, reviews: [rev('APPROVED', 'h2'), rev('DISMISSED', 'h2')] }).blockers.join(), /no approval of the current head/);
});

test('an invalid pattern on an unprotected head with automatic deletion refuses the merge', () => {
  const f = approvedFixture({ ...mergeView, headRefName: 'staging' });
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, BRAIN_LONG_LIVED: '([', FAKE_AUTODELETE: 'true' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /deletes head branches on merge/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('the default branch is long-lived for P5 and the one-ticket rule, whatever its name', () => {
  assert.deepStrictEqual(check.checkBranchName('trunk', { DEFAULT_BRANCH: 'trunk' }), []);
  assert.deepStrictEqual(check.checkOneTicket({ branch: 'trunk', title: 'ENG-3: promote', messages: ['feat: a [ENG-1]', 'feat: b [ENG-2]'] }, { DEFAULT_BRANCH: 'trunk' }), []);
  const yml = fs.readFileSync(path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'templates', 'pr-rules.yml'), 'utf8');
  assert.match(yml, /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
});

test('CI refuses to run without LINEAR_TEAM; git\'s other merge subjects are merges; a fork head named main is not long-lived', () => {
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const r = require('child_process').spawnSync('node', [script, 'branch', 'ENG-1-x'], { encoding: 'utf8', env: { ...process.env, CI: '1' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /LINEAR_TEAM is not set/);
  const T = '\n\nENG-1\n\nModel: m\nThinking-effort: h\nHarness: c';
  for (const subject of ["Merge commit 'abc123' into ENG-1-x", "Merge tag 'v1.0' into ENG-1-x", "Merge branches 'a' and 'b' into ENG-1-x"]) {
    assert.deepStrictEqual(check.checkCommitMessage(subject + T, {}), [], subject);
  }
  const fork = { HEAD_REPO: 'someone/r', REPO: 'o/r' };
  assert.match(check.checkOneTicket({ branch: 'main', title: 'ENG-1: x', messages: ['feat: a [ENG-1]', 'feat: b [ENG-2]'] }, fork).join(), /one ticket per PR/);
  assert.strictEqual(check.checkBranchName('main', fork).length, 1);
});

test('merge-pr keeps a head that is not a ticket branch, refuses a PR that edits its own pr-rules workflow, and caps commits', () => {
  const view = { state: 'OPEN', number: 1, title: 'ENG-1: x', headRefOid: 'h', author: { login: 'a' },
    reviews: [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: 'h' } }],
    statusCheckRollup: [{ name: 'pr-rules', conclusion: 'SUCCESS', workflowPath: '.github/workflows/pr-rules.yml', event: 'pull_request', runPrs: [1] }],
    changedFiles: ['.github/workflows/pr-rules.yml'] };
  assert.match(mergeBlockers(view).blockers.join(), /changes \.github\/workflows\//);
  assert.match(mergeBlockers({ ...view, changedFiles: [], commitMessages: Array(250).fill('feat: x [ENG-1]') }).blockers.join(), /250 or more commits/);
  const f = approvedFixture({ ...mergeView, headRefName: 'staging' });
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /staging is not a ticket branch and stays/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('an explicit [TICKET] is the owner even when prose holds a ticket-shaped token', () => {
  const revert = 'Revert "feat(b): add b [ENG-2]"\n\nThis broke UTF-8 input. [ENG-1]';
  assert.deepStrictEqual(check.checkOneTicket({ branch: 'ENG-1-fix', title: 'ENG-1: fix', messages: [revert] }, {}), []);
  assert.deepStrictEqual(check.checkOneTicket({ branch: 'ENG-1-fix', title: 'ENG-1: fix', messages: ['chore: note SHA-256 sums\n\n[ENG-1]'] }, {}), []);
});

test('a pr-rules commit status, or a check whose run is unknown, does not count; a truncated file list blocks', () => {
  const base = { state: 'OPEN', number: 1, title: 'ENG-1: x', headRefOid: 'h', author: { login: 'a' },
    reviews: [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: 'h' } }] };
  assert.match(mergeBlockers({ ...base, statusCheckRollup: [{ context: 'pr-rules', state: 'SUCCESS' }] }).blockers.join(), /no passing pr-rules Actions check/);
  assert.match(mergeBlockers({ ...base, statusCheckRollup: [{ name: 'pr-rules', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/1' }] }).blockers.join(), /no passing pr-rules Actions check/);
  const ok = { ...base, statusCheckRollup: [{ name: 'pr-rules', conclusion: 'SUCCESS', workflowPath: '.github/workflows/pr-rules.yml', event: 'pull_request', runPrs: [1] }] };
  assert.match(mergeBlockers({ ...ok, changedFilesIncomplete: true }).blockers.join(), /could not be read in full/);
});

test('provenance values must be one non-blank line each', () => {
  for (const bad of [' ', 'a\nModel: x']) {
    assert.strictEqual(require('child_process').spawnSync('node', [mergeScript, '1', '--model', bad, '--effort', 'e', '--harness', 'h'], { encoding: 'utf8' }).status, 2, JSON.stringify(bad));
  }
});

test('a push never deletes a long-lived branch; install-hooks notes a relative hooksPath', () => {
  const z = '0'.repeat(40);
  assert.match(check.checkPushedRefs(`(delete) ${z} refs/heads/release/1.0 ${'a'.repeat(40)}\n`, {}).join(), /long-lived branch release\/1\.0 is refused/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: dir });
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'install-hooks.js');
  const out = execFileSync('node', [script], { cwd: dir, encoding: 'utf8' });
  assert.match(out, /relative, so these hooks cover this worktree only/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the changed-file list is complete or blocks: 101 files with the workflow last, a rename out of workflows, a short count', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ filename: `.agents/skills/x/f${i}.md` }));
  for (const [pages, total, why] of [
    [[many, [{ filename: '.github/workflows/pr-rules.yml' }]], 101, /changes \.github\/workflows\//],
    [[[{ filename: 'ci/old.yml', previous_filename: '.github/workflows/pr-rules.yml' }]], 1, /changes \.github\/workflows\//],
    [[many], 101, /could not be read in full/],
  ]) {
    const f = approvedFixture();
    const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_FILES: JSON.stringify(pages), FAKE_CHANGED: String(total) }, encoding: 'utf8' });
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, why);
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('the commands the installed skills give point at files the installer puts there', () => {
  const { pullInstall } = require('./lib/pull-install');
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-'));
  pullInstall({ sourceRoot: path.join(__dirname, '..'), target });
  for (const skill of ['git-workflow-and-versioning', 'github']) {
    const body = fs.readFileSync(path.join(target, '.agents/skills', skill, 'SKILL.md'), 'utf8');
    const paths = [...body.matchAll(/`(\.agents\/skills\/git-workflow-and-versioning\/(?:scripts|templates)\/[\w.-]+)/g)].map(m => m[1]);
    assert.ok(paths.length, skill);
    for (const p of paths) assert.ok(fs.existsSync(path.join(target, p)), `${skill}: ${p}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
});

test('with a relative hooksPath, a linked worktree gets its own hooks from install-hooks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpw-'));
  const main = path.join(dir, 'app');
  fs.mkdirSync(main);
  const g = (args, cwd = main) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']); g(['commit', '-q', '--allow-empty', '-m', 'init']);
  g(['config', 'core.hooksPath', '.githooks']);
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'install-hooks.js');
  // the installed hooks look for the checker at its path in the checkout
  const checker = path.join(main, 'skills', 'git-workflow-and-versioning', 'scripts');
  fs.mkdirSync(checker, { recursive: true });
  execFileSync('node', [script], { cwd: main, encoding: 'utf8' });
  const wt = path.join(dir, 'ENG-1-x');
  g(['worktree', 'add', '-q', wt, '-b', 'ENG-1-x']);
  assert.ok(!fs.existsSync(path.join(wt, '.githooks', 'commit-msg')), 'a new worktree starts without hooks');
  const out = execFileSync('node', [script], { cwd: wt, encoding: 'utf8' });
  assert.match(out, /relative, so these hooks cover this worktree only/);
  assert.ok(fs.existsSync(path.join(wt, '.githooks', 'commit-msg')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a ticket-shaped branch configured long-lived is kept, and an unreadable variable keeps it too', () => {
  const f = approvedFixture();
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, BRAIN_LONG_LIVED: '^ENG-1-x$' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /ENG-1-x is not a ticket branch and stays/);
  execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: path.join(f.root, 'origin.git'), stdio: 'pipe' });
  execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: f.work, stdio: 'pipe' });
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a truncated file list is caught even when a rename adds names', () => {
  const recs = Array.from({ length: 99 }, (_, i) => ({ filename: `a/f${i}.md` }));
  recs.push({ filename: 'b/new.md', previous_filename: 'b/old.md' });
  const f = approvedFixture();
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_FILES: JSON.stringify([recs]), FAKE_CHANGED: '101' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /could not be read in full/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('moving the global changelog to the other place, with another docs change, passes P13', () => {
  const all = ['CHANGELOG.md', 'docs/CHANGELOG.md'];
  const files = check.parseNumstat('0\t9\tdocs/CHANGELOG.md\n10\t0\tCHANGELOG.md\n1\t1\tdocs/README.md');
  assert.deepStrictEqual(check.checkChangelog(files, all, ['CHANGELOG.md', 'docs/README.md']), []);
});

test('an unreadable BRAIN_LONG_LIVED variable keeps a ticket branch and exits 3', () => {
  const f = approvedFixture();
  patchGh(f, "if (a[0] === 'variable' && a[1] === 'get')", "if (a[0] === 'variable' && a[1] === 'get' && process.env.FAKE_VAR_FAIL) { process.stderr.write('HTTP 500'); process.exit(1); }");
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_VAR_FAIL: '1' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, /BRAIN_LONG_LIVED could not be read/);
  execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: path.join(f.root, 'origin.git'), stdio: 'pipe' });
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('dotenv stops at the first closing quote: an apostrophe in a comment does not leak into the value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.env'), "BRAIN_LONG_LIVED='^(staging|develop)$'   # don't push here directly\n");
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const env = { ...process.env }; delete env.CI; delete env.BRAIN_LONG_LIVED;
  assert.strictEqual(require('child_process').spawnSync('node', [script, 'branch', 'develop'], { cwd: dir, encoding: 'utf8', env }).status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('install-hooks refuses an absolute hooksPath outside the repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghp-'));
  const repo = path.join(dir, 'r'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'core.hooksPath', path.join(dir, 'global-hooks')], { cwd: repo });
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'install-hooks.js');
  const r = require('child_process').spawnSync('node', [script], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'global-hooks', 'commit-msg')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('merge-pr needs LINEAR_TEAM and drops the remote-tracking ref of the deleted branch', () => {
  const f = approvedFixture();
  const none = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_NO_TEAM: '1' }, encoding: 'utf8' });
  assert.strictEqual(none.status, 1);
  assert.match(none.stderr, /LINEAR_TEAM is not set/);
  execFileSync('git', ['update-ref', 'refs/remotes/origin/ENG-1-x', f.head], { cwd: f.work });
  const ok = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.throws(() => execFileSync('git', ['rev-parse', '--verify', 'refs/remotes/origin/ENG-1-x'], { cwd: f.work, stdio: 'pipe' }));
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a ticket-shaped default branch is kept', () => {
  const f = approvedFixture();
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_DEFAULT: 'ENG-1-x' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /not a ticket branch and stays/);
  execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: path.join(f.root, 'origin.git'), stdio: 'pipe' });
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('quoted .env values with quotes in their comments, for both keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dq2-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.env'), 'LINEAR_TEAM="ENG" # the "core" team\nBRAIN_LONG_LIVED="^(staging)$" # it\'s shared\n');
  fs.writeFileSync(path.join(dir, 'msg'), 'feat(a): x [ENG-1]\n\nModel: m\nThinking-effort: h\nHarness: c\n');
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const env = { ...process.env }; delete env.CI; delete env.BRAIN_LONG_LIVED; delete env.LINEAR_TEAM;
  const run = args => require('child_process').spawnSync('node', [script, ...args], { cwd: dir, encoding: 'utf8', env, input: `(delete) ${'0'.repeat(40)} refs/heads/staging ${'a'.repeat(40)}\n` });
  assert.strictEqual(run(['commit-msg', path.join(dir, 'msg')]).status, 0, 'LINEAR_TEAM read as ENG');
  assert.strictEqual(run(['push']).status, 1, 'deleting staging is refused');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('install-hooks refuses a global core.hooksPath (isolated global config)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcfg-'));
  const repo = path.join(dir, 'r'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const globalCfg = path.join(dir, 'gitconfig');
  fs.writeFileSync(globalCfg, `[core]\n\thooksPath = ${path.join(dir, 'shared-hooks')}\n`);
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'install-hooks.js');
  const r = require('child_process').spawnSync('node', [script], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: globalCfg } });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /outside this repository|global git config/);
  assert.ok(!fs.existsSync(path.join(dir, 'shared-hooks', 'commit-msg')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('another PR\'s run on the same head neither passes nor supersedes this PR\'s pr-rules', () => {
  const run = (id, prs, conclusion, created) => ({ name: 'pr-rules', conclusion, status: 'COMPLETED', detailsUrl: `https://github.com/o/r/actions/runs/${id}/job/1`,
    workflowPath: '.github/workflows/pr-rules.yml', event: 'pull_request', runPrs: prs, runHead: 'h', runCreated: created });
  const view = { state: 'OPEN', number: 1, title: 'ENG-1: x', headRefOid: 'h', author: { login: 'a' },
    reviews: [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: 'h' } }],
    statusCheckRollup: [run(4, [1], 'FAILURE', '2026-10-26T10:00:00Z'), run(5, [999], 'SUCCESS', '2026-10-26T10:05:00Z')] };
  const b = mergeBlockers(view).blockers.join();
  assert.match(b, /CI is not green: pr-rules/);
});

test('pre-push protects the remote\'s own default branch even without origin/HEAD', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdef-'));
  const bare = path.join(dir, 'r.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'release/stable', bare]);
  const work = path.join(dir, 'w'); fs.mkdirSync(work);
  const g = args => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: work, encoding: 'utf8' });
  g(['init', '-q', '-b', 'release/stable']); g(['commit', '-q', '--allow-empty', '-m', 'x']); g(['remote', 'add', 'origin', bare]); g(['push', '-q', 'origin', 'release/stable']);
  const sha = g(['rev-parse', 'HEAD']).trim();
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const r = require('child_process').spawnSync('node', [script, 'push', 'origin', bare], { cwd: work, encoding: 'utf8', input: `refs/heads/release/stable ${sha} refs/heads/release/stable ${'0'.repeat(40)}\n` });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /direct push to release\/stable is refused/);
  const gone = require('child_process').spawnSync('node', [script, 'push', 'origin', path.join(dir, 'missing.git')], { cwd: work, encoding: 'utf8', input: '' });
  assert.strictEqual(gone.status, 1, 'an unreadable remote default fails closed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a relative hooksPath that leaves the repository is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhp-'));
  const repo = path.join(dir, 'r'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'core.hooksPath', '../shared-hooks'], { cwd: repo });
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'install-hooks.js');
  const r = require('child_process').spawnSync('node', [script], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'shared-hooks', 'commit-msg')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an empty LINEAR_TEAM in .env does not hide the repository variable; --review-optional leaves a trailer; no fatal: noise', () => {
  const f = approvedFixture();
  fs.writeFileSync(path.join(f.work, '.env'), 'LINEAR_TEAM=\n');
  const v = JSON.parse(fs.readFileSync(path.join(f.root, 'view.json'), 'utf8'));
  fs.writeFileSync(path.join(f.root, 'view.json'), JSON.stringify({ ...v, reviews: [] }));
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', '--review-optional', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /fatal:/);
  assert.match(fs.readFileSync(f.log, 'utf8'), /Review: optional \(per the ticket\)/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('the run block of pr-rules.yml passes a compliant PR and fails a bad one, end to end', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'templates', 'pr-rules.yml'), 'utf8');
  const lines = yml.split('\n');
  const start = lines.findIndex(l => /^\s+run: \|\s*$/.test(l));
  const indent = lines[start + 1].match(/^\s*/)[0].length;
  const block = [];
  for (const l of lines.slice(start + 1)) { if (l.trim() && l.match(/^\s*/)[0].length < indent) break; block.push(l.slice(indent)); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prrules-'));
  const g = (args, cwd) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  g(['init', '-q', '--bare', '-b', 'main', path.join(dir, 'o.git')], dir);
  const w = path.join(dir, 'w');
  g(['clone', '-q', path.join(dir, 'o.git'), w], dir);
  const dest = path.join(w, '.agents/skills/git-workflow-and-versioning/scripts');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['brain-git-check.js', 'package.json']) fs.copyFileSync(path.join(__dirname, '..', 'skills/git-workflow-and-versioning/scripts', f), path.join(dest, f));
  fs.writeFileSync(path.join(w, 'CHANGELOG.md'), '# c\n');
  g(['add', '-A'], w); g(['commit', '-q', '-m', 'init'], w); g(['push', '-q', 'origin', 'HEAD:main'], w);
  g(['switch', '-q', '-c', 'ENG-1-x'], w);
  fs.appendFileSync(path.join(w, 'CHANGELOG.md'), '- x\n');
  g(['commit', '-q', '-am', 'feat(a): x [ENG-1]\n\nModel: m\nThinking-effort: h\nHarness: c'], w);
  g(['fetch', '-q', 'origin'], w);
  const run = title => require('child_process').spawnSync('bash', ['-eo', 'pipefail', '-c', block.join('\n')], { cwd: w, encoding: 'utf8',
    env: { ...process.env, CI: 'true', LINEAR_TEAM: 'ENG', PR_TITLE: title, PR_BODY: '', HEAD_REF: 'ENG-1-x', BASE_REF: 'main', HEAD_SHA: g(['rev-parse', 'HEAD'], w).trim(),
      DEFAULT_BRANCH: 'main', HEAD_REPO: 'o/r', REPO: 'o/r', RUNNER_TEMP: dir } });
  const good = run('ENG-1: x');
  assert.strictEqual(good.status, 0, good.stderr);
  const bad = run('no ticket');
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /PR title must be/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a newer run of the same PR supersedes its own older failure', () => {
  const run = (id, conclusion, created) => ({ name: 'pr-rules', conclusion, status: 'COMPLETED', detailsUrl: `https://github.com/o/r/actions/runs/${id}/job/1`,
    workflowPath: '.github/workflows/pr-rules.yml', event: 'pull_request', runPrs: [1], runHead: 'h', runCreated: created });
  const view = { state: 'OPEN', number: 1, title: 'ENG-1: x', headRefOid: 'h', author: { login: 'a' },
    reviews: [{ author: { login: 'r' }, authorAssociation: 'MEMBER', state: 'APPROVED', commit: { oid: 'h' } }],
    statusCheckRollup: [run(4, 'FAILURE', '2026-10-26T10:00:00Z'), run(6, 'SUCCESS', '2026-10-26T10:05:00Z')] };
  assert.deepStrictEqual(mergeBlockers(view).blockers, []);
});

test('a hooks directory that is a symlink out of the repository is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shp-'));
  const repo = path.join(dir, 'r'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.mkdirSync(path.join(dir, 'outside'));
  fs.symlinkSync(path.join(dir, 'outside'), path.join(repo, '.githooks'));
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repo });
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'install-hooks.js');
  const r = require('child_process').spawnSync('node', [script], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'outside', 'commit-msg')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pre-push protects a non-origin remote\'s default even when origin/HEAD is cached and stale', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-'));
  const bare = path.join(dir, 'u.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'trunk', bare]);
  const work = path.join(dir, 'w'); fs.mkdirSync(work);
  const g = args => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: work, encoding: 'utf8' });
  g(['init', '-q', '-b', 'trunk']); g(['commit', '-q', '--allow-empty', '-m', 'x']);
  g(['remote', 'add', 'upstream', bare]); g(['push', '-q', 'upstream', 'trunk']);
  g(['update-ref', 'refs/remotes/origin/main', 'HEAD']); g(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  const sha = g(['rev-parse', 'HEAD']).trim();
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const r = require('child_process').spawnSync('node', [script, 'push', 'upstream', bare], { cwd: work, encoding: 'utf8', input: `refs/heads/trunk ${sha} refs/heads/trunk ${'0'.repeat(40)}\n` });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /direct push to trunk is refused/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an origin with several URLs is refused, not guessed', () => {
  const f = approvedFixture();
  execFileSync('git', ['config', '--add', 'remote.origin.url', 'https://github.com/backup/r.git'], { cwd: f.work });
  const r = require('child_process').spawnSync('node', [mergeScript, '1', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /origin has 2 URLs/);
  assert.ok(!fs.existsSync(f.log) || !/^pr merge/m.test(fs.readFileSync(f.log, 'utf8')));
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a symbolic ticket ref is never deleted through to the branch it points at', () => {
  const f = approvedFixture();
  const g = args => execFileSync('git', args, { cwd: f.work, encoding: 'utf8' });
  g(['update-ref', 'refs/heads/main', f.head]);
  g(['branch', '-D', 'ENG-1-x']);
  g(['symbolic-ref', 'refs/heads/ENG-1-x', 'refs/heads/main']);
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, /symbolic ref; left alone/);
  g(['rev-parse', '--verify', 'refs/heads/main']);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a push run for another ref does not supersede this branch\'s failing push run', () => {
  const run = (id, branch, conclusion, created) => ({ name: 'test', conclusion, status: 'COMPLETED', detailsUrl: `https://github.com/o/r/actions/runs/${id}/job/1`,
    workflowPath: '.github/workflows/ci.yml', event: 'push', runBranch: branch, runCreated: created });
  const runs = latestRuns([run(1, 'ENG-1-x', 'FAILURE', '2026-10-26T10:00:00Z'), run(2, 'v1.0', 'SUCCESS', '2026-10-26T10:05:00Z')]);
  assert.ok(runs.some(c => c.conclusion === 'FAILURE'));
});

test('a stored commit subject starting with # is checked as stored', () => {
  const msg = '# Not a conventional subject\nfeat(a): x [ENG-1]\n\nModel: m\nThinking-effort: h\nHarness: c';
  assert.deepStrictEqual(check.checkCommitMessage(msg, {}), [], 'the hook strips editor comments');
  assert.ok(check.checkCommitMessage(msg, {}, { stripComments: false }).length > 0, 'CI does not');
});

test('several origin URLs with an explicit --repo merge that repository and leave local refs alone', () => {
  const f = approvedFixture();
  execFileSync('git', ['config', '--add', 'remote.origin.url', 'https://github.com/backup/r.git'], { cwd: f.work });
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'github.com/o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.match(fs.readFileSync(f.log, 'utf8'), /pr merge 1 .*--repo github\.com\/o\/r/);
  assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /backup\/r/);
  execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: f.work, stdio: 'pipe' });
  assert.notStrictEqual(r.status, 1, r.stderr);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a symbolic remote-tracking ref is removed without deleting the branch it points at', () => {
  const f = approvedFixture();
  const g = args => execFileSync('git', args, { cwd: f.work, encoding: 'utf8' });
  g(['update-ref', 'refs/heads/main', f.head]);
  g(['update-ref', '-d', 'refs/remotes/origin/ENG-1-x']);
  g(['symbolic-ref', 'refs/remotes/origin/ENG-1-x', 'refs/heads/main']);
  require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(g(['rev-parse', '--verify', 'refs/heads/main']).trim(), f.head);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('push runs of two branches at one SHA stay apart; a rerun on the same ref supersedes', () => {
  const run = (id, branch, conclusion, created) => ({ name: 'test', conclusion, status: 'COMPLETED', detailsUrl: `https://github.com/o/r/actions/runs/${id}/job/1`,
    workflowPath: '.github/workflows/ci.yml', event: 'push', runBranch: branch, runCreated: created });
  assert.ok(latestRuns([run(1, 'ENG-1-x', 'FAILURE', '2026-10-26T10:00:00Z'), run(2, 'ENG-2-y', 'SUCCESS', '2026-10-26T10:05:00Z')]).some(c => c.conclusion === 'FAILURE'));
  assert.ok(!latestRuns([run(1, 'ENG-1-x', 'FAILURE', '2026-10-26T10:00:00Z'), run(3, 'ENG-1-x', 'SUCCESS', '2026-10-26T10:05:00Z')]).some(c => c.conclusion === 'FAILURE'));
});

test('the commits check reads a stored commit as stored; the hook still drops editor comments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hashsubj-'));
  const g = args => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']); g(['commit', '-q', '--allow-empty', '-m', 'init']); g(['switch', '-q', '-c', 'ENG-1-x']);
  g(['commit', '-q', '--allow-empty', '--cleanup=verbatim', '-m', '# Not a conventional subject\nfeat(a): x [ENG-1]\n\nModel: m\nThinking-effort: h\nHarness: c']);
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const env = { ...process.env, LINEAR_TEAM: 'ENG' };
  assert.strictEqual(require('child_process').spawnSync('node', [script, 'commits', '--base', 'main'], { cwd: dir, env, encoding: 'utf8' }).status, 1);
  fs.writeFileSync(path.join(dir, 'msg'), 'feat(a): x [ENG-1]\n\nModel: m\nThinking-effort: h\nHarness: c\n# Please enter the commit message\n');
  assert.strictEqual(require('child_process').spawnSync('node', [script, 'commit-msg', path.join(dir, 'msg')], { cwd: dir, env, encoding: 'utf8' }).status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a tie in run creation time goes to the higher run id', () => {
  const run = (id, conclusion) => ({ name: 'test', conclusion, status: 'COMPLETED', detailsUrl: `https://github.com/o/r/actions/runs/${id}/job/1`,
    workflowPath: '.github/workflows/ci.yml', event: 'push', runBranch: 'ENG-1-x', runCreated: '2026-10-26T10:00:00Z' });
  assert.deepStrictEqual(latestRuns([run(7, 'SUCCESS'), run(8, 'FAILURE')]).map(c => c.conclusion), ['FAILURE']);
  assert.deepStrictEqual(latestRuns([run(8, 'FAILURE'), run(7, 'SUCCESS')]).map(c => c.conclusion), ['FAILURE']);
});

test('a symlinked default .git/hooks outside the repository is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhs-'));
  const repo = path.join(dir, 'r'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.mkdirSync(path.join(dir, 'shared-hooks'));
  fs.rmSync(path.join(repo, '.git', 'hooks'), { recursive: true, force: true });
  fs.symlinkSync(path.join(dir, 'shared-hooks'), path.join(repo, '.git', 'hooks'));
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'install-hooks.js');
  const r = require('child_process').spawnSync('node', [script], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'shared-hooks', 'commit-msg')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a PR retargeted after the checks is not merged; one merged into another base keeps its branches', () => {
  const f = approvedFixture();
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_RETARGET: 'release/1.0' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /now targets release\/1\.0, not main/);
  assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /^pr merge/m);
  const m = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_MERGED_BASE: 'release/1.0' }, encoding: 'utf8' });
  assert.strictEqual(m.status, 3, m.stderr);
  assert.match(m.stderr, /merged into release\/1\.0, not main/);
  execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: path.join(f.root, 'origin.git'), stdio: 'pipe' });
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('BRAIN_LONG_LIVED matches whole names, and an invalid pattern is reported', () => {
  const env = { BRAIN_LONG_LIVED: 'staging|develop', LINEAR_TEAM: 'ENG' };
  assert.ok(check.isLongLived('develop', env));
  assert.ok(!check.isLongLived('ENG-12-develop-login', env));
  assert.ok(check.checkBranchName('my-develop-hack', env).length > 0);
  assert.ok(check.isLongLived('main', { BRAIN_LONG_LIVED: '^(staging|develop)$' }));
  assert.ok(check.isLongLived('staging', { BRAIN_LONG_LIVED: '^(staging|develop)$' }));
  assert.match(check.longLivedPatternError({ BRAIN_LONG_LIVED: '^(staging' }), /not a valid regular expression/);
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const r = require('child_process').spawnSync('node', [script, 'branch', 'staging'], { encoding: 'utf8', env: { ...process.env, BRAIN_LONG_LIVED: '^(staging', LINEAR_TEAM: 'ENG' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /BRAIN_LONG_LIVED is not a valid regular expression/);
});

test('the commit-msg hook ignores the verbose diff below the scissors line', () => {
  const msg = 'Revert "feat(a): x"\n\nModel: m\nThinking-effort: h\nHarness: c\n# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\ndiff --git a/x b/x\n+feat(a): y [ENG-9]\n';
  assert.ok(check.checkCommitMessage(msg, { LINEAR_TEAM: 'ENG' }).some(e => /revert commit/.test(e)));
});

test('a tie in creation time keeps a newer pending run in front of an older pass', () => {
  const run = (id, status, conclusion) => ({ name: 'test', status, conclusion, detailsUrl: `https://github.com/o/r/actions/runs/${id}/job/1`,
    workflowPath: '.github/workflows/ci.yml', event: 'push', runBranch: 'ENG-1-x', runCreated: '2026-10-26T10:00:00Z' });
  for (const order of [[run(7, 'COMPLETED', 'SUCCESS'), run(8, 'QUEUED', null)], [run(8, 'QUEUED', null), run(7, 'COMPLETED', 'SUCCESS')]]) {
    assert.deepStrictEqual(latestRuns(order).map(c => c.status), ['QUEUED']);
  }
});

test('a title edited during the checks stops the merge', () => {
  const f = approvedFixture();
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_RETITLE: 'ENG-2: unrelated ticket' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /changed \(title\) during the checks/);
  assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /^pr merge/m);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('install-hooks never writes through a symlinked hook file, and restores the execute bit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfs-'));
  const repo = path.join(dir, 'r'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'install-hooks.js');
  const run = () => require('child_process').spawnSync('node', [script], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(run().status, 0);
  const hook = path.join(repo, '.git', 'hooks', 'commit-msg');
  fs.chmodSync(hook, 0o644);
  assert.strictEqual(run().status, 0);
  assert.strictEqual(fs.statSync(hook).mode & 0o777, 0o755);
  const shared = path.join(dir, 'shared-commit-msg');
  fs.copyFileSync(hook, shared);
  const before = fs.readFileSync(shared, 'utf8') + '# shared\n';
  fs.writeFileSync(shared, before);
  fs.rmSync(hook); fs.symlinkSync(shared, hook);
  const r = run();
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /symlink/);
  assert.strictEqual(fs.readFileSync(shared, 'utf8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P11 counts lines of a file the base marks -diff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodiff-'));
  const g = args => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, '.gitattributes'), 'package-lock.json -diff\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# c\n');
  g(['add', '-A']); g(['commit', '-q', '-m', 'init']); g(['switch', '-q', '-c', 'ENG-1-x']);
  fs.writeFileSync(path.join(dir, 'package-lock.json'), Array.from({ length: 2000 }, (_, i) => `"l${i}"`).join('\n') + '\n');
  fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), '- x\n');
  g(['add', '-A']); g(['commit', '-q', '-m', 'feat(a): x [ENG-1]\n\nModel: m\nThinking-effort: h\nHarness: c']);
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const r = require('child_process').spawnSync('node', [script, 'pr', '--base', 'main', '--title', 'ENG-1: x', '--branch', 'ENG-1-x'], { cwd: dir, encoding: 'utf8', env: { ...process.env, LINEAR_TEAM: 'ENG', PR_BODY: '' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /P11/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('trailers count only in the last paragraph', () => {
  const ok = 'feat(x): y [ENG-1]\n\nBody.\n\nModel: a\nThinking-effort: b\nHarness: c';
  assert.deepStrictEqual(check.checkCommitMessage(ok, { LINEAR_TEAM: 'ENG' }), []);
  const late = 'feat(x): y [ENG-1]\n\nModel: a\nThinking-effort: b\nHarness: c\n\nThis paragraph follows the trailers.';
  assert.strictEqual(check.checkCommitMessage(late, { LINEAR_TEAM: 'ENG' }).filter(e => /missing trailer/.test(e)).length, 3);
});

test('the commit-msg hook treats a "Merge branch" subject as a merge only while git is merging', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'msg'), 'Merge branch cleanup into utils [ENG-1]\n\nModel: m\nThinking-effort: h\nHarness: c\n');
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const run = () => require('child_process').spawnSync('node', [script, 'commit-msg', path.join(dir, 'msg')], { cwd: dir, encoding: 'utf8', env: { ...process.env, LINEAR_TEAM: 'ENG' } });
  assert.strictEqual(run().status, 1, 'an ordinary commit with a merge-like subject gets the subject check');
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'a'.repeat(40) + '\n');
  assert.strictEqual(run().status, 0, 'during a merge it is a merge');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a body edit (a removed size exception) during the checks stops the merge; an edit during the merge keeps the branches', () => {
  const f = approvedFixture();
  const v = JSON.parse(fs.readFileSync(path.join(f.root, 'view.json'), 'utf8'));
  fs.writeFileSync(path.join(f.root, 'view.json'), JSON.stringify({ ...v, body: 'Size-exception: generated client' }));
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_REBODY: '' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /changed \(body\) during the checks/);
  const m = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_MERGED_TITLE: 'ENG-2: other' }, encoding: 'utf8' });
  assert.strictEqual(m.status, 3, m.stderr);
  assert.match(m.stderr, /title changed while it was being merged/);
  execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: path.join(f.root, 'origin.git'), stdio: 'pipe' });
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a file:// origin naming github.com is not taken for a GitHub repository', () => {
  const f = approvedFixture();
  execFileSync('git', ['remote', 'set-url', 'origin', `file://github.com${path.join(f.root, 'o', 'r.git')}`], { cwd: f.work });
  const r = require('child_process').spawnSync('node', [mergeScript, '1', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /not a GitHub transport/);
  assert.ok(!fs.existsSync(f.log) || !/^pr merge/m.test(fs.readFileSync(f.log, 'utf8')));
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a changelog moved unchanged adds no line (P13)', () => {
  const files = [{ path: 'CHANGELOG.md', added: 0 }, { path: 'docs/CHANGELOG.md', added: 120 }, { path: 'src/a.js', added: 5 }];
  const renamed = [{ path: 'docs/CHANGELOG.md', added: 0 }, { path: 'src/a.js', added: 5 }];
  assert.ok(check.checkChangelog(files, ['CHANGELOG.md'], ['docs/CHANGELOG.md', 'src/a.js'], renamed).length > 0);
  const edited = [{ path: 'docs/CHANGELOG.md', added: 1 }, { path: 'src/a.js', added: 5 }];
  assert.deepStrictEqual(check.checkChangelog(files, ['CHANGELOG.md'], ['docs/CHANGELOG.md', 'src/a.js'], edited), []);
});

test('the hook accepts amending a valid merge commit, and an empty LINEAR_TEAM falls back to .env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-'));
  const g = args => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']); g(['commit', '-q', '--allow-empty', '-m', 'a']);
  g(['switch', '-q', '-c', 'ENG-1-x']); g(['commit', '-q', '--allow-empty', '-m', 'b']); g(['switch', '-q', 'main']); g(['commit', '-q', '--allow-empty', '-m', 'c']);
  g(['merge', '-q', '--no-ff', 'ENG-1-x', '-m', "Merge branch 'ENG-1-x' [ENG-1]", '-m', 'Model: m\nThinking-effort: h\nHarness: c']);
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  fs.writeFileSync(path.join(dir, 'msg'), g(['log', '-1', '--format=%B']));
  const env = { ...process.env, LINEAR_TEAM: 'ENG' };
  assert.strictEqual(require('child_process').spawnSync('node', [script, 'commit-msg', path.join(dir, 'msg')], { cwd: dir, env, encoding: 'utf8' }).status, 0);
  fs.writeFileSync(path.join(dir, '.env'), 'LINEAR_TEAM=ENG\n');
  fs.writeFileSync(path.join(dir, 'msg2'), 'feat(a): x [OPS-1]\n\nModel: m\nThinking-effort: h\nHarness: c\n');
  const e = { ...process.env, LINEAR_TEAM: '' }; delete e.CI;
  assert.strictEqual(require('child_process').spawnSync('node', [script, 'commit-msg', path.join(dir, 'msg2')], { cwd: dir, env: e, encoding: 'utf8' }).status, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('end to end: moving CHANGELOG.md to docs/ unchanged does not satisfy P13', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clmv-'));
  const g = args => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), Array.from({ length: 30 }, (_, i) => `- entry ${i}`).join('\n') + '\n');
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'a\n');
  g(['add', '-A']); g(['commit', '-q', '-m', 'init']); g(['switch', '-q', '-c', 'ENG-1-x']);
  fs.mkdirSync(path.join(dir, 'docs')); g(['mv', 'CHANGELOG.md', 'docs/CHANGELOG.md']);
  fs.appendFileSync(path.join(dir, 'src', 'a.js'), 'b\n');
  g(['commit', '-q', '-am', 'feat(a): x [ENG-1]\n\nModel: m\nThinking-effort: h\nHarness: c']);
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const run = () => require('child_process').spawnSync('node', [script, 'pr', '--base', 'main', '--title', 'ENG-1: x', '--branch', 'ENG-1-x'], { cwd: dir, encoding: 'utf8', env: { ...process.env, LINEAR_TEAM: 'ENG', PR_BODY: '' } });
  const r = run();
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /P13/);
  fs.appendFileSync(path.join(dir, 'docs', 'CHANGELOG.md'), '- x\n');
  g(['commit', '-q', '-am', 'docs(changelog): x [ENG-1]\n\nModel: m\nThinking-effort: h\nHarness: c']);
  assert.strictEqual(run().status, 0, 'a moved changelog with a new line passes');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('LINEAR_TEAM takes a comma list of keys and reports any other value', () => {
  assert.deepStrictEqual(check.checkBranchName('OPS-2-x', { LINEAR_TEAM: 'ENG,OPS' }), []);
  assert.ok(check.checkBranchName('WEB-2-x', { LINEAR_TEAM: 'ENG,OPS' }).length > 0);
  assert.match(check.teamError({ LINEAR_TEAM: 'eng' }), /must be Linear team keys/);
  assert.strictEqual(check.teamError({ LINEAR_TEAM: 'ENG, OPS' }), null);
});

test('a review submitted during the checks stops the merge', () => {
  const f = approvedFixture();
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_REREVIEW: JSON.stringify([{ author: { login: 'w' }, state: 'CHANGES_REQUESTED' }]) }, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /just before merging: /);
  assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /^pr merge/m);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('CI that fails during the checks stops the merge', () => {
  const f = approvedFixture();
  const v = JSON.parse(fs.readFileSync(path.join(f.root, 'view.json'), 'utf8'));
  const failed = (v.statusCheckRollup || []).map(c => ({ ...c, conclusion: 'FAILURE' }));
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: { ...f.env, FAKE_RECHECKS: JSON.stringify(failed) }, encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /just before merging: .*CI/);
  assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /^pr merge/m);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('after a merge, a new ordinary commit with a merge-like subject still gets the subject check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-'));
  const g = args => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']); g(['commit', '-q', '--allow-empty', '-m', 'a']);
  g(['switch', '-q', '-c', 'ENG-1-x']); g(['commit', '-q', '--allow-empty', '-m', 'b']); g(['switch', '-q', 'main']); g(['commit', '-q', '--allow-empty', '-m', 'c']);
  g(['merge', '-q', '--no-ff', 'ENG-1-x', '-m', "Merge branch 'ENG-1-x' [ENG-1]", '-m', 'Model: m\nThinking-effort: h\nHarness: c']);
  fs.writeFileSync(path.join(dir, 'msg'), 'Merge branch cleanup into utils [ENG-1]\n\nModel: m\nThinking-effort: h\nHarness: c\n');
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  assert.strictEqual(require('child_process').spawnSync('node', [script, 'commit-msg', path.join(dir, 'msg')], { cwd: dir, env: { ...process.env, LINEAR_TEAM: 'ENG' }, encoding: 'utf8' }).status, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an origin path with extra components is not inferred', () => {
  const f = approvedFixture();
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/a/b/c.git'], { cwd: f.work });
  const r = require('child_process').spawnSync('node', [mergeScript, '1', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /does not name a host\/owner\/name repository|not a github\.com remote/);
  const { originRepo } = require('../skills/git-workflow-and-versioning/scripts/merge-pr');
  const cwd = process.cwd();
  try {
    process.chdir(f.work);
    for (const ok of ['https://github.com/o/r.git', 'git@github.com:o/r.git', 'ssh://git@github.com/o/r', 'https://github.com/o/r/']) {
      execFileSync('git', ['remote', 'set-url', 'origin', ok], { cwd: f.work });
      assert.strictEqual(originRepo(), 'o/r', ok);
    }
  } finally { process.chdir(cwd); }
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a global core.hooksPath inside this repository is still refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghin-'));
  const repo = path.join(dir, 'a'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const globalCfg = path.join(dir, 'gitconfig');
  fs.writeFileSync(globalCfg, `[core]\n\thooksPath = ${path.join(repo, '.githooks')}\n`);
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'install-hooks.js');
  const r = require('child_process').spawnSync('node', [script], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: globalCfg } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /global git config/);
  assert.ok(!fs.existsSync(path.join(repo, '.githooks', 'commit-msg')));
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: repo });
  fs.writeFileSync(globalCfg, '');
  assert.strictEqual(require('child_process').spawnSync('node', [script], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: globalCfg } }).status, 0, 'a local one is fine');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a service changelog touched without an added line fails P13', () => {
  const files = [{ path: 'CHANGELOG.md', added: 1 }, { path: 'services/api/CHANGELOG.md', added: 0 }];
  const all = ['CHANGELOG.md', 'services/api/CHANGELOG.md'];
  const head = ['CHANGELOG.md', 'services/api/CHANGELOG.md', 'services/api/a.js'];
  assert.match(check.checkChangelog(files, all, head).join(), /services\/api\/CHANGELOG\.md/);
  assert.deepStrictEqual(check.checkChangelog([{ path: 'CHANGELOG.md', added: 1 }, { path: 'services/api/CHANGELOG.md', added: 1 }], all, head), []);
});

test('merge-pr refuses a PR that changes its own scripts', () => {
  const v = { ...mergeView, changedFiles: ['.agents/skills/git-workflow-and-versioning/scripts/merge-pr.js'] };
  assert.match(mergeBlockers(v).blockers.join(), /changes the git-workflow scripts/);
});

test('P11 fails closed when git cannot read attributes from the empty tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oldgit-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--attr-source" ] && { echo "unknown option: --attr-source" >&2; exit 129; }; done\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  const repo = path.join(dir, 'r'); fs.mkdirSync(repo);
  const g = args => execFileSync(realGit, ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '# c\n'); g(['add', '-A']); g(['commit', '-q', '-m', 'init']);
  g(['switch', '-q', '-c', 'ENG-1-x']);
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.js -diff\n');
  fs.writeFileSync(path.join(repo, 'a.js'), 'x\n'.repeat(500)); fs.appendFileSync(path.join(repo, 'CHANGELOG.md'), '- x\n');
  g(['add', '-A']); g(['commit', '-q', '-m', 'feat(a): x [ENG-1]\n\nModel: m\nThinking-effort: h\nHarness: c']);
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const r = require('child_process').spawnSync('node', [script, 'pr', '--base', 'main', '--title', 'ENG-1: x', '--branch', 'ENG-1-x'], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LINEAR_TEAM: 'ENG', PR_BODY: '' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /needs --attr-source, git 2\.40/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a reworded merge subject fails the hook (documented) but passes the stored-commit check CI runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-'));
  const g = args => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']); g(['commit', '-q', '--allow-empty', '-m', 'a']); g(['branch', 'base']);
  g(['switch', '-q', '-c', 'ENG-1-x']); g(['commit', '-q', '--allow-empty', '-m', 'feat(a): b [ENG-1]\n\nModel: m\nThinking-effort: h\nHarness: c']);
  g(['switch', '-q', 'main']); g(['commit', '-q', '--allow-empty', '-m', 'feat(a): c [ENG-1]\n\nModel: m\nThinking-effort: h\nHarness: c']);
  g(['merge', '-q', '--no-ff', 'ENG-1-x', '-m', "Merge branch 'ENG-1-x' [ENG-1]", '-m', 'Model: m\nThinking-effort: h\nHarness: c']);
  const msg = "Merge branch 'ENG-1-x' after review [ENG-1]\n\nModel: m\nThinking-effort: h\nHarness: c\n";
  fs.writeFileSync(path.join(dir, 'msg'), msg);
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const env = { ...process.env, LINEAR_TEAM: 'ENG' };
  assert.strictEqual(require('child_process').spawnSync('node', [script, 'commit-msg', path.join(dir, 'msg')], { cwd: dir, env, encoding: 'utf8' }).status, 1);
  g(['commit', '-q', '--amend', '--no-verify', '-F', path.join(dir, 'msg')]);
  assert.strictEqual(require('child_process').spawnSync('node', [script, 'commits', '--base', 'base'], { cwd: dir, env, encoding: 'utf8' }).status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('git trailer semantics: prose inside the last paragraph means no trailers', () => {
  const msg = 'feat(x): y [ENG-1]\n\nModel: m\nThinking-effort: high\nHarness: h\nThis is prose, not a trailer.';
  assert.strictEqual(check.checkCommitMessage(msg, { LINEAR_TEAM: 'ENG' }).filter(e => /missing trailer/.test(e)).length, 3);
  const co = 'feat(x): y [ENG-1]\n\nModel: m\nThinking-effort: high\nHarness: h\nCo-Authored-By: A <a@b>';
  assert.deepStrictEqual(check.checkCommitMessage(co, { LINEAR_TEAM: 'ENG' }), []);
});

test('an already-merged PR whose merge commit names another ticket keeps its branches', () => {
  const f = approvedFixture();
  patchGh(f, "if (a[0] === 'pr' && a[1] === 'view') {", "if (a[0] === 'api' && a.some(x => /\\/commits\\/abcdef1234$/.test(x))) { process.stdout.write(JSON.stringify({ parents: ['p0', " + JSON.stringify(f.head) + "], message: 'Merge pull request #1 [ENG-999]\\n\\nModel: m\\nThinking-effort: h\\nHarness: c' })); process.exit(0); }");
  const v = JSON.parse(fs.readFileSync(path.join(f.root, 'view.json'), 'utf8'));
  fs.writeFileSync(path.join(f.root, 'view.json'), JSON.stringify({ ...v, state: 'MERGED', mergeCommit: { oid: 'abcdef1234' } }));
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, /does not name this PR's ticket ENG-1/);
  execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ENG-1-x'], { cwd: path.join(f.root, 'origin.git'), stdio: 'pipe' });
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('cleanup never fetches through a symbolic origin/<base> onto a local branch', () => {
  const f = approvedFixture();
  const g = args => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: f.work, encoding: 'utf8' });
  g(['branch', 'private-work', f.head]);
  g(['commit', '-q', '--allow-empty', '-m', 'private']);
  const tip = g(['rev-parse', 'HEAD']).trim();
  g(['update-ref', 'refs/heads/private-work', tip]);
  g(['reset', '-q', '--hard', 'HEAD~1']);
  g(['update-ref', '-d', 'refs/remotes/origin/main']);
  g(['symbolic-ref', 'refs/remotes/origin/main', 'refs/heads/private-work']);
  const wt = path.join(f.root, 'private-wt');
  g(['worktree', 'add', '-q', wt, 'private-work']);
  require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.strictEqual(g(['rev-parse', 'refs/heads/private-work']).trim(), tip);
  assert.strictEqual(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim(), tip);
  assert.strictEqual(g(['for-each-ref', 'refs/merge-pr/']).trim(), '', 'the scratch ref is gone');
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('an explicit GitHub Enterprise --repo that origin names exactly can clean up', () => {
  const f = approvedFixture();
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.enterprise.example/o/r.git'], { cwd: f.work });
  const { originRepo } = require('../skills/git-workflow-and-versioning/scripts/merge-pr');
  const cwd = process.cwd();
  try { process.chdir(f.work); assert.throws(() => originRepo(), /not a github\.com remote/); } finally { process.chdir(cwd); }
  const r = require('child_process').spawnSync('node', [mergeScript, '1', '--repo', 'github.enterprise.example/o/r', ...PROV], { cwd: f.work, env: f.env, encoding: 'utf8' });
  assert.match(r.stderr + r.stdout, /merged #1/, r.stderr);
  assert.doesNotMatch(r.stderr, /not in origin.s repository/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('a bare repository\'s parent .env is never read from its worktrees', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-'));
  const bare = path.join(dir, 'app.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = path.join(dir, 'seed');
  execFileSync('git', ['clone', '-q', bare, seed]);
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: seed });
  execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: seed });
  execFileSync('git', ['worktree', 'add', '-q', path.join(dir, 'ENG-1-x'), 'main'], { cwd: bare });
  fs.writeFileSync(path.join(dir, '.env'), 'LINEAR_TEAM=OTHERPROJ\nBRAIN_LONG_LIVED=\n');
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const out = require('child_process').spawnSync('node', ['-e', `const c=require(${JSON.stringify(script)});const e={};c.loadDotenv(e);process.stdout.write(JSON.stringify(e))`], { cwd: path.join(dir, 'ENG-1-x'), encoding: 'utf8', env: { ...process.env, CI: '' } });
  assert.strictEqual(out.stdout, '{}', 'neither key comes from outside the checkouts');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the stored-commit check (CI) applies git trailer semantics too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const g = args => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']); g(['commit', '-q', '--allow-empty', '-m', 'a']); g(['switch', '-q', '-c', 'ENG-1-x']);
  g(['commit', '-q', '--allow-empty', '-m', 'feat(x): y [ENG-1]\n\nModel: m\nThinking-effort: high\nHarness: h\nThis is prose, not a trailer.']);
  const script = path.join(__dirname, '..', 'skills', 'git-workflow-and-versioning', 'scripts', 'brain-git-check.js');
  const r = require('child_process').spawnSync('node', [script, 'commits', '--base', 'main'], { cwd: dir, encoding: 'utf8', env: { ...process.env, LINEAR_TEAM: 'ENG' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /missing trailer "Model/);
  fs.rmSync(dir, { recursive: true, force: true });
});
