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
const pn = text => check.parseNumstat(text.replace(/\n/g, '\0'));

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
  assert.deepStrictEqual(check.checkCommitMessage('Merge pull request #4 [ENG-123]', {}, { mergeCommit: true }), []);
  assert.strictEqual(check.checkCommitMessage('Merge pull request #4', {}, { mergeCommit: true }).length, 1);
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

test('size skips lockfiles, but the changelog check still sees them', () => {
  const files = pn('300\t50\tsrc/a.ts\n5\t5\tpackage-lock.json\n-\t-\tlogo.png');
  assert.deepStrictEqual(files.map(f => f.path), ['src/a.ts', 'package-lock.json', 'logo.png']);
  assert.deepStrictEqual(check.checkSize(files, '', {}), []);
  // A huge lockfile and an eleventh file that is a lockfile must not count toward the size limits.
  assert.deepStrictEqual(check.checkSize(pn('10\t0\tsrc/a.ts\n5000\t0\tpackage-lock.json'), '', {}), []);
  const tenSources = Array.from({ length: 10 }, (_, i) => `1\t0\tsrc/f${i}.ts`).join('\n');
  assert.deepStrictEqual(check.checkSize(pn(`${tenSources}\n9000\t0\tbun.lock`), '', {}), []);
});

test('a lockfile change in a service still requires that service changelog', () => {
  const files = pn('3\t0\tservices/api/package-lock.json\n1\t0\tdocs/CHANGELOG.md');
  const errors = check.checkChangelog(files, ['docs/CHANGELOG.md', 'services/api/CHANGELOG.md']);
  assert.match(errors[0], /services\/api\/CHANGELOG\.md/);
});

test('an oversized PR fails unless the body records an exception', () => {
  const big = pn('401\t0\tsrc/a.ts');
  assert.strictEqual(check.checkSize(big, '', {}).length, 1);
  assert.deepStrictEqual(check.checkSize(big, 'Size-exception: one generated migration', {}), []);
  assert.strictEqual(check.checkSize(big, 'Size-exception:', {}).length, 1);
  assert.strictEqual(check.checkSize(pn(Array(11).fill('1\t0\tx').map((l, i) => l + i).join('\n')), '', {}).length, 1);
  assert.deepStrictEqual(check.checkSize(big, '', { BRAIN_PR_MAX_LINES: '500' }), []);
});

test('a changelog line is required in the global file and in the service it touches', () => {
  const all = ['docs/CHANGELOG.md', 'services/api/CHANGELOG.md'];
  assert.strictEqual(check.checkChangelog(pn('1\t0\tsrc/a.ts'), all).length, 1);
  assert.strictEqual(check.checkChangelog(pn('1\t0\tdocs/CHANGELOG.md\n1\t0\tservices/api/src/a.ts'), all).length, 1);
  assert.deepStrictEqual(check.checkChangelog(pn('1\t0\tdocs/CHANGELOG.md\n1\t0\tservices/api/CHANGELOG.md\n1\t0\tservices/api/src/a.ts'), all), []);
});

test('merge is blocked unless open, ticketed, green, and approved', () => {
  const approval = { author: { login: 'teammate' }, state: 'APPROVED', commit: { oid: 'h1' }, authorAssociation: 'MEMBER' };
  const ok = { state: 'OPEN', title: 'ENG-1: x', headRefOid: 'h1', author: { login: 'agent' }, reviews: [approval], statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }] };
  assert.deepStrictEqual(mergeBlockers(ok).blockers, []);
  assert.strictEqual(mergeBlockers(ok).ticket, 'ENG-1');
  // approval comes from the reviews on this head, not from the repository's decision field
  assert.strictEqual(mergeBlockers({ ...ok, reviews: [] }).blockers.length, 1);
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
const { originRepo, isApproved } = require('../skills/git-workflow-and-versioning/scripts/merge-pr');

test('a deleted changelog does not satisfy P13; an added line does', () => {
  assert.strictEqual(checkChangelog(pn('0\t100\tdocs/CHANGELOG.md')).length, 1);
  assert.deepStrictEqual(checkChangelog(pn('2\t0\tdocs/CHANGELOG.md')), []);
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
  const all = ['docs/CHANGELOG.md', 'services/api/CHANGELOG.md', 'services/web/CHANGELOG.md'];
  assert.deepStrictEqual(requiredChangelogs(['services/api/src/a.ts'], all).sort(), ['docs/CHANGELOG.md', 'services/api/CHANGELOG.md']);
  assert.deepStrictEqual(requiredChangelogs(['README.md'], all), ['docs/CHANGELOG.md']);
  const onlyService = check.checkChangelog(pn('3\t0\tservices/api/CHANGELOG.md\n1\t0\tservices/api/src/a.ts'), all);
  assert.match(onlyService[0], /CHANGELOG\.md/);
  assert.deepStrictEqual(check.checkChangelog(pn('1\t0\tdocs/CHANGELOG.md\n2\t0\tservices/api/CHANGELOG.md\n1\t0\tservices/api/src/a.ts'), all), []);
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

test('an approval counts from a reviewer other than the author, on the current head only', () => {
  const author = { login: 'agent' };
  const head = 'h2';
  const rev = (login, state, oid = head) => ({ author: { login }, state, commit: { oid }, authorAssociation: 'MEMBER' });
  assert.strictEqual(isApproved({ author, headRefOid: head, reviewDecision: '', reviews: [rev('agent', 'APPROVED')] }), false);
  assert.strictEqual(isApproved({ author, headRefOid: head, reviewDecision: '', reviews: [rev('r', 'APPROVED')] }), true);
  assert.strictEqual(isApproved({ author, headRefOid: head, reviewDecision: '', reviews: [rev('r', 'APPROVED', 'h1')] }), false, 'approval of an older commit');
  assert.strictEqual(isApproved({ author, headRefOid: head, reviewDecision: '', reviews: [rev('r', 'APPROVED'), rev('r', 'CHANGES_REQUESTED')] }), false);
});

test('a repository with no changelog fails P13 rather than passing silently', () => {
  assert.strictEqual(check.checkChangelog(pn('1\t0\tsrc/a.ts'), []).length, 1);
});

const { isPending } = require('../skills/git-workflow-and-versioning/scripts/merge-pr');
const { requiredChangelogs: reqChangelogs } = require('../skills/git-workflow-and-versioning/scripts/brain-git-check');

test('a run still in progress blocks the merge, even when an older run of the same check passed', () => {
  const view = { state: 'OPEN', title: 'ENG-1: x', reviewDecision: 'APPROVED', statusCheckRollup: [
    { workflowName: 'ci', name: 'pr-rules', conclusion: 'SUCCESS', status: 'COMPLETED', startedAt: '2026-10-26T10:00:00Z' },
    { workflowName: 'ci', name: 'pr-rules', conclusion: '', status: 'IN_PROGRESS', startedAt: '2026-10-26T10:05:00Z', completedAt: '0001-01-01T00:00:00Z' },
  ] };
  assert.match(mergeBlockers(view).blockers.join(), /still running: pr-rules/);
  assert.ok(isPending({ status: 'QUEUED' }));
});

test('two workflows with a job of the same name are separate checks: a failing test is not hidden', () => {
  const runs = [
    { workflowName: 'ci', name: 'test', conclusion: 'FAILURE', status: 'COMPLETED', startedAt: '2026-10-26T10:00:00Z' },
    { workflowName: 'e2e', name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED', startedAt: '2026-10-26T10:01:00Z' },
  ];
  const view = { state: 'OPEN', title: 'ENG-1: x', reviewDecision: 'APPROVED', statusCheckRollup: runs };
  assert.match(mergeBlockers(view).blockers.join(), /CI is not green: test/);
});

test('a COMMENTED review is a reply, not a verdict: it neither approves nor overrides a request for changes', () => {
  const author = { login: 'agent' };
  const head = 'h2';
  const rev = (login, state) => ({ author: { login }, state, commit: { oid: head }, authorAssociation: 'MEMBER' });
  assert.strictEqual(isApproved({ author, headRefOid: head, reviewDecision: '', reviews: [rev('r1', 'APPROVED'), rev('r1', 'COMMENTED')] }), true);
  assert.strictEqual(isApproved({ author, headRefOid: head, reviewDecision: '', reviews: [rev('r1', 'APPROVED'), rev('r2', 'CHANGES_REQUESTED'), rev('r2', 'COMMENTED')] }), false);
});

test('an SSH host alias is read as GitHub; a non-GitHub host is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
  const cwd = process.cwd();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  process.chdir(dir);
  try {
    execFileSync('git', ['remote', 'add', 'origin', 'git@github-work:org/app.git']);
    assert.strictEqual(originRepo(), 'org/app');
    execFileSync('git', ['remote', 'set-url', 'origin', 'ssh://git@ssh.github.com:443/org/app.git']);
    assert.strictEqual(originRepo(), 'org/app');
    execFileSync('git', ['remote', 'set-url', 'origin', 'git@gitlab.com:org/app.git']);
    assert.throws(() => originRepo(), /not a GitHub remote/);
  } finally { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the hook accepts a local fixup or squash commit; CI does not, and an unsquashed one must not land', () => {
  assert.deepStrictEqual(checkCommitMessage('fixup! feat(x): y [ENG-1]', {}, { allowFixup: true }), []);
  assert.ok(checkCommitMessage('fixup! feat(x): y [ENG-1]', {}).length > 0);
});

test('a comma-separated scope is accepted, and git merge subjects need no trailers but a ticket', () => {
  assert.deepStrictEqual(checkCommitMessage('fix(git-workflow,dev-setup,linear): x [ENG-1]\n\nModel: m\nThinking-effort: h\nHarness: c', {}), []);
  assert.deepStrictEqual(checkCommitMessage('Merge pull request #4 from o/ENG-1 [ENG-1]', {}, { mergeCommit: true }), []);
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
  const view = { state: 'OPEN', title: 'ENG-1: x', reviewDecision: 'APPROVED', statusCheckRollup: [
    { workflowName: 'ci', name: 'pr-rules', conclusion: 'SUCCESS', status: 'COMPLETED', startedAt: '2026-10-26T10:00:00Z' },
    { workflowName: 'ci', name: 'pr-rules', conclusion: '', status: 'QUEUED', startedAt: '0001-01-01T00:00:00Z' },
  ] };
  assert.match(mergeBlockers(view).blockers.join(), /still running: pr-rules/);
});

test('a merge into the branch from the remote default branch needs no trailers, only the ticket', () => {
  assert.deepStrictEqual(checkCommitMessage("Merge remote-tracking branch 'origin/main' into ENG-1-login", {}, { mergeCommit: true }), []);
  assert.ok(checkCommitMessage("Merge remote-tracking branch 'origin/main'", {}, { mergeCommit: true }).length > 0);
});

test('a repository with only service changelogs fails P13, and a service changelog does not stand in for the global one', () => {
  assert.match(check.checkChangelog(pn('1\t0\tservices/api/CHANGELOG.md\n1\t0\tREADME.md'), ['services/api/CHANGELOG.md'])[0], /no global changelog/);
});

test('a branch default with a trailing newline from git is still protected', () => {
  assert.match(checkPushedRefs('refs/heads/release/stable aaaa refs/heads/release/stable 0000000', {}, ['main', 'release/stable'])[0], /direct push to release\/stable/);
});

test('a change request stays in force after a new push until its reviewer approves or dismisses it', () => {
  const author = { login: 'agent' };
  const h2 = 'h2';
  const rev = (login, state, oid) => ({ author: { login }, state, commit: { oid }, authorAssociation: 'MEMBER' });
  assert.strictEqual(isApproved({ author, headRefOid: h2, reviewDecision: '', reviews: [
    rev('r1', 'CHANGES_REQUESTED', 'h1'), rev('r2', 'APPROVED', h2)] }), false);
  assert.strictEqual(isApproved({ author, headRefOid: h2, reviewDecision: '', reviews: [
    rev('r1', 'CHANGES_REQUESTED', 'h1'), rev('r1', 'APPROVED', h2), rev('r2', 'APPROVED', h2)] }), true);
});

test('a root CHANGELOG.md is not the global changelog: a generated root file never satisfies P13', () => {
  assert.match(check.checkChangelog(pn('2\t0\tCHANGELOG.md\n1\t0\tsrc/a.ts'), ['CHANGELOG.md'])[0], /no global changelog \(docs\/CHANGELOG\.md\)/);
  assert.strictEqual(check.checkChangelog(pn('2\t0\tdocs/CHANGELOG.md\n1\t0\tsrc/a.ts'), ['CHANGELOG.md', 'docs/CHANGELOG.md']).length, 0);
});

test('a service changelog the PR deletes is still required, from the base branch list', () => {
  const base = ['docs/CHANGELOG.md', 'services/api/CHANGELOG.md'];
  const head = ['docs/CHANGELOG.md'];
  const req = check.requiredChangelogs(['services/api/src/a.ts'], [...new Set([...head, ...base])]);
  assert.deepStrictEqual(req.sort(), ['docs/CHANGELOG.md', 'services/api/CHANGELOG.md']);
});

const { listChangelogs } = check;

test('a service removed by the PR is not required; a service that stays is, with its docs/ changelog too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
  const run = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q', '-b', 'main']);
  const put = (f, body = 'x') => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); };
  put('docs/CHANGELOG.md'); put('services/old/CHANGELOG.md'); put('services/old/a.ts'); put('services/api/docs/CHANGELOG.md'); put('services/api/a.ts');
  run(['add', '-A']); run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base']);
  run(['rm', '-q', '-r', 'services/old']); run(['add', '-A']);
  run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'head']);
  const cwd = process.cwd(); process.chdir(dir);
  try {
    const found = listChangelogs('HEAD~1', 'HEAD').sort();
    assert.deepStrictEqual(found, ['docs/CHANGELOG.md', 'services/api/docs/CHANGELOG.md']);
  } finally { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a changelog in a service docs/ folder is the one required for that service', () => {
  assert.deepStrictEqual(check.requiredChangelogs(['services/api/src/a.ts'], ['docs/CHANGELOG.md', 'services/api/docs/CHANGELOG.md']).sort(),
    ['docs/CHANGELOG.md', 'services/api/docs/CHANGELOG.md']);
});

test('a non-ASCII path is read as its real name from NUL-delimited output', () => {
  const files = check.parseNumstat('2\t0\tservices/caf\u00e9/a.ts\0');
  assert.strictEqual(files[0].path, 'services/caf\u00e9/a.ts');
});

test('a single-parent commit titled like a merge is held to the anatomy', () => {
  const errors = checkCommitMessage("Merge branch 'ENG-1-work' into main", {}, { mergeCommit: false });
  assert.ok(errors.length >= 4, errors.join('; '));
});

test('an approval counts only from a reviewer with a standing role in the repository', () => {
  const author = { login: 'agent' };
  const head = 'h2';
  const rev = (login, state, association) => ({ author: { login }, state, commit: { oid: head }, authorAssociation: association });
  assert.strictEqual(isApproved({ author, headRefOid: head, reviewDecision: '', reviews: [rev('stranger', 'APPROVED', 'NONE')] }), false);
  assert.strictEqual(isApproved({ author, headRefOid: head, reviewDecision: '', reviews: [rev('teammate', 'APPROVED', 'COLLABORATOR')] }), true);
});

test('any failed run on the head blocks the merge, even one a later run superseded', () => {
  const view = { state: 'OPEN', title: 'ENG-1: x', reviewDecision: 'APPROVED', statusCheckRollup: [
    { workflowName: 'ci', name: 'pr-rules', conclusion: 'FAILURE', status: 'COMPLETED', startedAt: '2026-10-26T10:00:00Z' },
    { workflowName: 'ci', name: 'pr-rules', conclusion: 'SUCCESS', status: 'COMPLETED', startedAt: '2026-10-26T10:05:00Z' },
  ] };
  assert.match(mergeBlockers(view).blockers.join(), /CI is not green: pr-rules/);
});
