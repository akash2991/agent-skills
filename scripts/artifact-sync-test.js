#!/usr/bin/env node
'use strict';

// skills/documentation/scripts/artifact-sync.js: which artifacts are due, the hook's guards, the sync run, and the
// review exemption for an artifact PR. Git and the push are real (a temporary repository with a bare origin); only
// the agent and gh are faked.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const sync = require('../skills/documentation/scripts/artifact-sync');
const { parseBlastRadius } = require('../skills/git-workflow-and-versioning/scripts/brain-git-check');

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const BRANCH = 'FAC-1-feature';
const CONFIG = {
  'artifact-sync': { label: 'Sync', harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  artifacts: [
    { path: 'docs/map.md', sources: ['src/**/*.js'], then: 'cp docs/map.md docs/map.html', outputs: ['docs/map.html'] },
    { path: 'docs/page.html', sources: ['web/**'] },
    { path: 'docs/flow-map.json', sources: ['lib/**'], then: 'cp docs/flow-map.json docs/flow-map.html', outputs: ['docs/flow-map.html'] },
  ],
};

// A repository with an origin, a pushed code branch FAC-1-feature, and one pushed commit on it that changes `change`.
function repo({ change = 'src/a.js' } = {}) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-sync-'));
  dirs.push(top);
  const origin = path.join(top, 'origin.git');
  const root = path.join(top, 'proj');
  git(['init', '--bare', '-q', '-b', 'main', origin], top);
  git(['init', '-q', '-b', 'main', root], top);
  for (const [k, v] of [['user.name', 'T'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false']]) git(['config', k, v], root);
  for (const d of ['src', 'docs', 'web', 'lib']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'lib/x.js'), '1\n');
  fs.writeFileSync(path.join(root, 'docs/flow-map.json'), '{"v":1}\n');
  fs.writeFileSync(path.join(root, 'docs/flow-map.html'), '{"v":1}\n');
  fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify(CONFIG));
  fs.writeFileSync(path.join(root, 'src/a.js'), '1\n');
  fs.writeFileSync(path.join(root, 'web/app.js'), '1\n');
  fs.writeFileSync(path.join(root, 'docs/map.md'), 'v1\n');
  fs.writeFileSync(path.join(root, 'docs/map.html'), 'v1\n');
  fs.writeFileSync(path.join(root, 'docs/page.html'), '<p>v1</p>\n');
  git(['add', '-A'], root);
  git(['commit', '-qm', 'init'], root);
  git(['remote', 'add', 'origin', origin], root);
  git(['push', '-q', 'origin', 'main'], root);
  git(['fetch', '-q', 'origin'], root);
  const base = git(['rev-parse', 'HEAD'], root);
  git(['checkout', '-qb', BRANCH], root);
  fs.mkdirSync(path.dirname(path.join(root, change)), { recursive: true });
  fs.writeFileSync(path.join(root, change), '2\n');
  git(['add', '-A'], root);
  git(['commit', '-qm', 'change'], root);
  git(['push', '-q', '-u', 'origin', BRANCH], root);
  return { top, root, origin, base, head: git(['rev-parse', 'HEAD'], root) };
}

let counter = 0;
// Commit a code change on the branch and push it; returns the new head.
function pushChange(root, file = 'src/a.js') {
  fs.writeFileSync(path.join(root, file), `${++counter}\n`);
  git(['commit', '-qam', `change ${file}`], root);
  git(['push', '-q', 'origin', BRANCH], root);
  return git(['rev-parse', 'HEAD'], root);
}

const stateFile = (root, ext) => path.join(root, '.git/agent-brain/artifact-sync', `${sync.safeName(BRANCH)}.${ext}`);
const readState = root => JSON.parse(fs.readFileSync(stateFile(root, 'json'), 'utf8'));
const remote = (root, ref) => git(['ls-remote', 'origin', `refs/heads/${ref}`], root).split(/\s/)[0];
const fakeLaunch = calls => (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid: process.pid, unref() {} }; };

// The fake agent edits files in its cwd, the sync worktree; gh answers list (no PR) and create (a URL).
function fakeExec(calls, edit, gh = {}) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    if (cmd === 'claude' || cmd === 'pi') { edit(opts.cwd); return { status: 0, stdout: '', stderr: '' }; }
    if (cmd === 'gh' && args[1] === 'list') return gh.list || { status: 0, stdout: '[]' };
    if (cmd === 'gh' && args[1] === 'create') return { status: 0, stdout: 'https://example.com/pr/7\n' };
    return { status: 1, stderr: 'unexpected' };
  };
}
const edit = cwd => fs.writeFileSync(path.join(cwd, 'docs/map.md'), `v2 ${++counter}\n`);
const runIt = (r, opts = {}) => sync.run({ root: r.root, branch: BRANCH, base: opts.base || r.base, head: opts.head || r.head },
  { spawnSync: fakeExec(opts.calls || [], opts.edit || edit, opts.gh), repo: 'o/r', ...opts.deps });

test('globs are repository-relative', () => {
  const m = (g, f) => sync.globToRegExp(g).test(f);
  assert.ok(m('src/**/*.js', 'src/a.js'));
  assert.ok(m('src/**/*.js', 'src/x/y/a.js'));
  assert.ok(!m('src/*.js', 'src/x/a.js'));
  assert.ok(m('**/*.md', 'README.md'));
  assert.ok(!m('*.md', 'docs/a.md'));
  assert.ok(m('skills/*/SKILL.md', 'skills/linear/SKILL.md'));
  assert.ok(!m('a.js', 'a_js'));
  assert.ok(m('file?.txt', 'file1.txt'));
});

test('an artifact is due only for a changed source that is not itself or its output', () => {
  const art = CONFIG.artifacts[0];
  assert.deepEqual(sync.dueEntries([art], ['README.md']), []);
  assert.deepEqual(sync.dueEntries([{ ...art, sources: ['docs/**'] }], ['docs/map.md', 'docs/map.html']), []);
  assert.deepEqual(sync.dueEntries([art], ['src/a.js', 'docs/x'])[0].changed, ['src/a.js']);
  assert.equal(sync.ticketOf('FAC-39-artifact-sync'), 'FAC-39');
  assert.equal(sync.ticketOf('feature/x'), null);
  assert.notEqual(sync.safeName('a/b'), sync.safeName('a_b'), 'two branches never share a state file');
});

test('the hook starts one background sync per pushed head, and never for the sync agent, main, or an -artifacts branch', () => {
  const r = repo();
  const calls = [];
  assert.match(sync.hook(r.root, { BRAIN_ARTIFACT_SYNC: '1' }, fakeLaunch(calls)), /sync agent/);
  assert.match(sync.hook(r.root, {}, fakeLaunch(calls)), /started the artifact sync for docs\/map\.md/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(1, 3), ['run', '--root']);
  assert.ok(calls[0].args.includes(r.head));
  assert.equal(calls[0].opts.env.BRAIN_ARTIFACT_SYNC, '1');
  assert.ok(calls[0].opts.detached);
  fs.rmSync(stateFile(r.root, 'lock'));
  assert.match(sync.hook(r.root, {}, fakeLaunch(calls)), /already synced or attempted/);
  git(['checkout', '-q', 'main'], r.root);
  assert.match(sync.hook(r.root, {}, fakeLaunch(calls)), /not a code branch/);
  git(['checkout', '-qb', `${BRANCH}-artifacts`], r.root);
  assert.match(sync.hook(r.root, {}, fakeLaunch(calls)), /not a code branch/);
  assert.equal(calls.length, 1);
});

test('the hook syncs only the published tip, never local commits that are not pushed', () => {
  const r = repo();
  fs.writeFileSync(path.join(r.root, 'src/a.js'), 'local only\n');
  git(['commit', '-qam', 'unpushed'], r.root);
  assert.equal(sync.plan(r.root, {}).head, r.head);
  const calls = [];
  sync.hook(r.root, {}, fakeLaunch(calls));
  assert.ok(calls[0].args.includes(r.head) && !calls[0].args.includes(git(['rev-parse', 'HEAD'], r.root)));
});

test('a head that touches no source is recorded as synced without starting anything', () => {
  const r = repo({ change: 'README.md' });
  const calls = [];
  assert.match(sync.hook(r.root, {}, fakeLaunch(calls)), /no artifact is due/);
  assert.equal(calls.length, 0);
  assert.equal(readState(r.root).synced, r.head);
});

test('an unpushed branch, a running sync, or a stale lock start nothing; a stale lock is reported, never taken over', () => {
  const r = repo();
  git(['checkout', '-qb', 'FAC-2-local'], r.root);
  assert.match(sync.hook(r.root, {}, fakeLaunch([])), /not on origin yet/);
  git(['checkout', '-q', BRANCH], r.root);
  const lock = stateFile(r.root, 'lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
  assert.match(sync.hook(r.root, {}, fakeLaunch([])), /already running/);
  fs.writeFileSync(lock, '999999999');
  assert.match(sync.hook(r.root, {}, fakeLaunch([])), /stale lock .* remove .*\.lock to resume/);
  assert.equal(fs.readFileSync(lock, 'utf8'), '999999999');
  fs.rmSync(lock);
  assert.match(sync.hook(r.root, {}, fakeLaunch([])), /started/);
  assert.match(fs.readFileSync(lock, 'utf8'), /^starting:[0-9a-f]{16}$/);
});

test('run publishes one validated commit on the pushed tip to <branch>-artifacts and opens a PR into the code branch', () => {
  const r = repo();
  const calls = [];
  assert.match(runIt(r, { calls }), /artifacts [0-9a-f]{7} on FAC-1-feature-artifacts; PR https:\/\/example\.com\/pr\/7/);
  const agent = calls.find(c => c.cmd === 'claude');
  assert.ok(agent.args.includes('claude-sonnet-5-5') && agent.args.includes('medium'));
  assert.match(agent.args[1], /docs\/map\.md\n {2}changed sources: src\/a\.js/);
  assert.ok(!fs.existsSync(agent.cwd), 'the private worktree is removed after the run');
  const published = remote(r.root, `${BRANCH}-artifacts`);
  git(['fetch', '-q', 'origin'], r.root);
  assert.equal(git(['rev-parse', `${published}^`], r.root), r.head, 'one commit, on the pushed tip');
  assert.deepEqual(git(['diff', '--name-only', r.head, published], r.root).split('\n').sort(), ['docs/map.html', 'docs/map.md']);
  assert.equal(git(['show', `${published}:docs/map.html`], r.root), git(['show', `${published}:docs/map.md`], r.root), 'the then command ran');
  const message = git(['log', '-1', '--format=%B', published], r.root);
  assert.match(message, /^docs\(artifacts\): bring 1 artifact up to date with [0-9a-f]{7} \[FAC-1\]$/m);
  for (const t of ['Model: claude-sonnet-5-5', 'Thinking-effort: medium', 'Harness: claude']) assert.ok(message.includes(t), t);
  const create = calls.find(c => c.cmd === 'gh' && c.args[1] === 'create');
  assert.deepEqual(create.args.slice(4, 8), ['--base', BRANCH, '--head', `${BRANCH}-artifacts`]);
  assert.deepEqual(parseBlastRadius(create.args[create.args.indexOf('--body') + 1]), { level: 'low', error: null });
  const list = calls.find(c => c.cmd === 'gh' && c.args[1] === 'list');
  assert.ok(list.args.includes('--base') && list.args.includes(BRANCH));
  for (const c of calls.filter(x => x.cmd === 'gh')) assert.deepEqual(c.args.slice(2, 4), ['--repo', 'o/r'], 'every gh call names the repository');
  assert.equal(readState(r.root).published, published);
  assert.equal(readState(r.root).synced, r.head);
  assert.ok(!fs.existsSync(stateFile(r.root, 'lock')), 'the lock is released');
  assert.equal(fs.readFileSync(path.join(r.root, 'docs/map.md'), 'utf8'), 'v1\n', 'the code checkout is never touched');
  assert.equal(git(['status', '--porcelain'], r.root), '');
});

test('run refuses an agent that edits outside its artifacts, commits, or checks out a branch; nothing is pushed', () => {
  for (const [bad, re] of [
    [cwd => { edit(cwd); fs.writeFileSync(path.join(cwd, 'src/a.js'), 'hacked\n'); }, /not its artifacts, nothing published: src\/a\.js/],
    [cwd => { edit(cwd); git(['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qam', 'sneak'], cwd); }, /moved HEAD or checked out a branch/],
    [cwd => git(['checkout', '-qb', 'elsewhere'], cwd), /moved HEAD or checked out a branch/],
  ]) {
    const r = repo();
    assert.throws(() => runIt(r, { edit: bad }), re);
    assert.equal(remote(r.root, `${BRANCH}-artifacts`), '', 'nothing pushed');
    assert.match(readState(r.root).error, re);
  }
});

test('a commit-time change outside the artifacts is caught on the commit itself', () => {
  const r = repo();
  // A pre-commit hook that slips a code file into the commit.
  fs.writeFileSync(path.join(r.root, '.git/hooks/pre-commit'), '#!/bin/sh\necho sneaky > src/hook.js && git add src/hook.js\n', { mode: 0o755 });
  assert.throws(() => runIt(r), /the artifact commit changes more than its artifacts; not pushed: src\/hook\.js/);
  assert.equal(remote(r.root, `${BRANCH}-artifacts`), '');
});

test('run refuses when the code branch moved on origin, or the artifact branch holds commits it did not publish', () => {
  const r = repo();
  pushChange(r.root);
  assert.throws(() => runIt(r), /is at [0-9a-f]{7} on origin, not [0-9a-f]{7}/);
  const r2 = repo();
  git(['push', '-q', 'origin', `${r2.base}:refs/heads/${BRANCH}-artifacts`], r2.root);
  assert.throws(() => runIt(r2), /which this sync did not publish; not overwritten/);
  assert.equal(remote(r2.root, `${BRANCH}-artifacts`), r2.base, 'left as it was');
});

test("a later head replaces the sync's own earlier publication; a no-edit run publishes nothing", () => {
  const r = repo();
  runIt(r);
  const first = remote(r.root, `${BRANCH}-artifacts`);
  const head2 = pushChange(r.root);
  runIt(r, { base: r.head, head: head2 });
  const second = remote(r.root, `${BRANCH}-artifacts`);
  assert.notEqual(second, first);
  git(['fetch', '-q', 'origin'], r.root);
  assert.equal(git(['rev-parse', `${second}^`], r.root), head2);
  const head3 = pushChange(r.root);
  assert.match(runIt(r, { base: head2, head: head3, edit: () => {} }), /already current/);
  assert.equal(remote(r.root, `${BRANCH}-artifacts`), second);
});

test('failures are recorded and fail closed: a failed push or gh lookup marks nothing synced', () => {
  const r = repo();
  assert.throws(() => runIt(r, { deps: { push: () => { throw new Error('network down'); } } }), /network down/);
  assert.notEqual(readState(r.root).synced, r.head);
  assert.throws(() => runIt(r, { gh: { list: { status: 1, stderr: 'HTTP 502' } } }), /gh pr list failed: HTTP 502/);
  assert.notEqual(readState(r.root).synced, r.head);
  // The hook shows the last error instead of silently retrying the same head.
  fs.writeFileSync(stateFile(r.root, 'json'), JSON.stringify({ ...readState(r.root), attempted: r.head }));
  assert.match(sync.plan(r.root, {}).skip, /last error: .*gh pr list failed/);
});

test('run takes only its own reservation, or a free lock when started by hand, and releases only its own', () => {
  const r = repo();
  const lock = stateFile(r.root, 'lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '1');
  assert.throws(() => runIt(r), /another sync holds/);
  assert.equal(fs.readFileSync(lock, 'utf8'), '1');
  fs.writeFileSync(lock, 'starting:aaaa');
  const run = token => sync.run({ root: r.root, branch: BRANCH, base: r.base, head: r.head, token }, { spawnSync: fakeExec([], edit), repo: 'o/r' });
  assert.throws(() => run('bbbb'), /not this sync's reservation/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'starting:aaaa');
  run('aaaa');
  assert.ok(!fs.existsSync(lock));
});

test('a hook that finds nothing due writes state only under the lock, and releases it', () => {
  const r = repo({ change: 'README.md' });
  const lock = stateFile(r.root, 'lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
  assert.match(sync.hook(r.root, {}, fakeLaunch([])), /already running/);
  assert.ok(!fs.existsSync(stateFile(r.root, 'json')), 'nothing written while another sync holds the lock');
  fs.rmSync(lock);
  assert.match(sync.hook(r.root, {}, fakeLaunch([])), /no artifact is due/);
  assert.ok(!fs.existsSync(lock));
});

test('an unmerged publication is not dropped: the next sync redoes it with the new work', () => {
  const r = repo();
  runIt(r);
  // A later push changes a different artifact's source while the first artifact PR is still open.
  const head2 = pushChange(r.root, 'web/app.js');
  const p = sync.plan(r.root, {});
  assert.equal(p.base, r.base, 'the baseline does not move past an unmerged publication');
  assert.deepEqual(p.due.map(d => d.path).sort(), ['docs/map.md', 'docs/page.html']);
  const calls = [];
  runIt(r, { base: p.base, head: head2, calls, edit: cwd => { edit(cwd); fs.writeFileSync(path.join(cwd, 'docs/page.html'), '<p>v2</p>\n'); } });
  const second = remote(r.root, `${BRANCH}-artifacts`);
  git(['fetch', '-q', 'origin'], r.root);
  assert.deepEqual(git(['diff', '--name-only', head2, second], r.root).split('\n').sort(), ['docs/map.html', 'docs/map.md', 'docs/page.html']);
  // Once the artifact PR is merged into the code branch, the baseline moves to the head it was made for.
  git(['merge', '-q', '--no-edit', second], r.root);
  git(['push', '-q', 'origin', BRANCH], r.root);
  git(['fetch', '-q', 'origin'], r.root);
  const after = sync.plan(r.root, {});
  assert.equal(after.base, head2);
  assert.deepEqual(after.due, []);
});

test('run computes its own baseline: a too-recent base handed to it cannot drop unmerged work', () => {
  const r = repo();
  runIt(r);
  const head2 = pushChange(r.root, 'web/app.js');
  // Handed the previous head as base, run still includes the unmerged docs/map.md work.
  const calls = [];
  runIt(r, { base: r.head, head: head2, calls, edit: cwd => { edit(cwd); fs.writeFileSync(path.join(cwd, 'docs/page.html'), '<p>v2</p>\n'); } });
  assert.match(calls.find(c => c.cmd === 'claude').args[1], /docs\/map\.md[\s\S]*docs\/page\.html|docs\/page\.html[\s\S]*docs\/map\.md/);
  git(['fetch', '-q', 'origin'], r.root);
  assert.deepEqual(git(['diff', '--name-only', head2, remote(r.root, `${BRANCH}-artifacts`)], r.root).split('\n').sort(), ['docs/map.html', 'docs/map.md', 'docs/page.html']);
});

test('a run that edits nothing does not move the baseline past an unmerged publication', () => {
  const r = repo();
  runIt(r);
  const first = remote(r.root, `${BRANCH}-artifacts`);
  const head2 = pushChange(r.root, 'web/app.js');
  assert.match(runIt(r, { head: head2, edit: () => {} }), /already current/);
  const head3 = pushChange(r.root, 'web/app.js');
  const p = sync.plan(r.root, {});
  assert.equal(p.base, r.base, 'the baseline still precedes the unmerged publication');
  assert.deepEqual(p.due.map(d => d.path).sort(), ['docs/map.md', 'docs/page.html']);
  runIt(r, { head: head3, edit: cwd => { edit(cwd); fs.writeFileSync(path.join(cwd, 'docs/page.html'), '<p>v3</p>\n'); } });
  const third = remote(r.root, `${BRANCH}-artifacts`);
  assert.notEqual(third, first);
  git(['fetch', '-q', 'origin'], r.root);
  assert.ok(git(['diff', '--name-only', head3, third], r.root).split('\n').includes('docs/map.md'), 'the earlier map.md work is carried, not dropped');
});

test('a PR head that lags the push is retried before it counts as a mismatch', () => {
  const r = repo();
  let lists = 0;
  const exec = (cmd, args, opts) => {
    if (cmd === 'gh' && args[1] === 'list') {
      lists++;
      const head = lists < 3 ? 'f'.repeat(40) : remote(r.root, `${BRANCH}-artifacts`);
      return { status: 0, stdout: JSON.stringify([{ url: 'u', headRefName: `${BRANCH}-artifacts`, baseRefName: BRANCH, headRefOid: head, isCrossRepository: false }]) };
    }
    return fakeExec([], edit)(cmd, args, opts);
  };
  assert.match(sync.run({ root: r.root, branch: BRANCH, base: r.base, head: r.head }, { spawnSync: exec, repo: 'o/r', sleep: () => {} }), /PR u/);
  assert.equal(lists, 3);
});

test('run refuses when it cannot establish the baseline itself, whatever base it is handed', () => {
  const r = repo();
  git(['update-ref', '-d', 'refs/remotes/origin/main'], r.root);
  git(['branch', '-D', 'main'], r.root);
  assert.throws(() => runIt(r, { base: r.base }), /cannot establish where FAC-1-feature's outstanding artifact work starts/);
  assert.equal(remote(r.root, `${BRANCH}-artifacts`), '', 'nothing published');
});

test('with a publication outstanding and no default-branch ref, a manual run refuses and leaves the publication alone', () => {
  const r = repo();
  runIt(r);
  const first = remote(r.root, `${BRANCH}-artifacts`);
  git(['update-ref', '-d', 'refs/remotes/origin/main'], r.root);
  git(['branch', '-D', 'main'], r.root);
  const head2 = pushChange(r.root, 'web/app.js');
  assert.throws(() => runIt(r, { base: r.head, head: head2, edit: cwd => fs.writeFileSync(path.join(cwd, 'docs/page.html'), '<p>v2</p>\n') }), /cannot establish where/);
  assert.equal(remote(r.root, `${BRANCH}-artifacts`), first);
  assert.notEqual(readState(r.root).synced, head2);
});

test('a mode change is refused, and so is a code branch that moved while the agent worked', () => {
  const r = repo();
  assert.throws(() => runIt(r, { edit: cwd => { edit(cwd); fs.chmodSync(path.join(cwd, 'docs/map.md'), 0o755); } }),
    /changes more than its artifacts; not pushed: docs\/map\.md \(M 100644->100755\)/);
  const r2 = repo();
  assert.throws(() => runIt(r2, { edit: cwd => { edit(cwd); pushChange(r2.root); } }), /on origin, not/);
  assert.equal(remote(r2.root, `${BRANCH}-artifacts`), '');
});

test('an open PR for the artifact branch at another commit is an error, not a match', () => {
  const r = repo();
  const list = { status: 0, stdout: JSON.stringify([{ url: 'u', headRefName: `${BRANCH}-artifacts`, baseRefName: BRANCH, headRefOid: 'f'.repeat(40), isCrossRepository: false }]) };
  assert.throws(() => runIt(r, { gh: { list }, deps: { sleep: () => {} } }), /the open PR for FAC-1-feature-artifacts is at fffffff, not the pushed/);
  assert.notEqual(readState(r.root).synced, r.head);
});

test('originRepo reads owner/name from a GitHub origin and refuses anything else', () => {
  const r = repo();
  assert.throws(() => sync.originRepo(r.root), /is not a GitHub repository/);
  git(['remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git'], r.root);
  assert.equal(sync.originRepo(r.root), 'acme/widgets');
  git(['remote', 'set-url', 'origin', 'https://github.com/acme/widgets'], r.root);
  assert.equal(sync.originRepo(r.root), 'acme/widgets');
});

// A published sync of the JSON artifact, the one kind that may skip review.
function publishedFlow() {
  const r = repo({ change: 'lib/x.js' });
  runIt(r, { edit: cwd => fs.writeFileSync(path.join(cwd, 'docs/flow-map.json'), '{"v":2}\n') });
  git(['fetch', '-q', 'origin'], r.root);
  const published = readState(r.root).published;
  const view = (over = {}) => ({ prView: () => ({ base: BRANCH, baseSha: r.head, head: `${BRANCH}-artifacts`, headSha: published, headRepo: 'o/r', baseRepo: 'o/r', state: 'open', ...over }) });
  return { r, published, view };
}
const forge = (r, files) => {
  git(['checkout', '-q', '--detach', readState(r.root).published], r.root);
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(r.root, f), text);
  git(['commit', '-qam', 'hand'], r.root);
  const sha = git(['rev-parse', 'HEAD'], r.root);
  fs.writeFileSync(stateFile(r.root, 'json'), JSON.stringify({ ...readState(r.root), published: sha }));
  return sha;
};

test("scope --pr: exempt only for this clone's published commit on <base>-artifacts, from the same repository", () => {
  const { r, published, view } = publishedFlow();
  assert.deepEqual(sync.prScope(r.root, 1, view()).reasons, []);
  assert.match(sync.prScope(r.root, 1, view({ head: 'FAC-1-other' })).reasons.join(), /is not FAC-1-feature-artifacts/);
  assert.match(sync.prScope(r.root, 1, view({ headRepo: 'fork/r' })).reasons.join(), /head fork\/r is not the base repository o\/r/);
  assert.match(sync.prScope(r.root, 1, view({ state: 'closed' })).reasons.join(), /the PR is closed/);
  assert.match(sync.prScope(r.root, 1, view({ headSha: r.head })).reasons.join(), /not the commit this clone's sync published/);
  assert.ok(published);
});

test('merge --pr merges only a green, re-confirmed flow-map PR, at exactly the checked head', () => {
  const { r, published, view } = publishedFlow();
  const green = [{ name: 'checks', bucket: 'pass' }, { name: 'test-plugin-install', bucket: 'pass' }];
  const merges = [];
  const deps = (over = {}) => ({ ...view(), repo: 'o/r', checks: () => green, merge: (n, head) => { merges.push(head); return true; }, ...over });
  assert.deepEqual(sync.mergeExempt(r.root, 1, deps()), { merged: published, reasons: [] });
  assert.deepEqual(merges, [published]);
  for (const [checks, re] of [
    [[], /the checks job has not passed/],
    [[{ name: 'checks', bucket: 'pending' }], /checks job has not passed[\s\S]*checks \(pending\)|checks not green: checks \(pending\)/],
    [[{ name: 'checks', bucket: 'pass' }, { name: 'other', bucket: 'fail' }], /checks not green: other \(fail\)/],
  ]) {
    const out = sync.mergeExempt(r.root, 1, deps({ checks: () => checks }));
    assert.equal(out.merged, null);
    assert.match(out.reasons.join('\n'), re);
  }
  // The base moves between the first scope and the second, to a commit the PR still scopes cleanly against: the
  // earlier verdict is not used.
  git(['checkout', '-q', BRANCH], r.root);
  const base2 = pushChange(r.root, 'src/a.js');
  let views = 0;
  const moving = () => ({ ...view().prView(), baseSha: ++views === 1 ? r.head : base2 });
  const out = sync.mergeExempt(r.root, 1, deps({ prView: moving }));
  assert.equal(out.merged, null);
  assert.match(out.reasons.join(), /base or head changed while its checks were read/);
  assert.equal(merges.length, 1, 'nothing else merged');
});

test('scope --pr: a hand-edited flow-map page on the published branch is not exempt', () => {
  const { r, view } = publishedFlow();
  const sha = forge(r, { 'docs/flow-map.html': '<script>x</script>\n' });
  // The forged commit is recorded as published here only to reach the path check; it still must pass CI to merge.
  assert.deepEqual(sync.prScope(r.root, 1, view({ headSha: sha })).reasons, []);
  assert.equal(sync.mergeExempt(r.root, 1, { ...view({ headSha: sha }), repo: 'o/r', checks: () => [{ name: 'checks', bucket: 'fail' }], merge: () => true }).merged, null);
});

test('scope: only the flow map is exempt; Markdown, HTML, models.json and both ends of a rename are not', () => {
  const r = repo();
  git(['checkout', '-qb', 'x'], r.root);
  fs.writeFileSync(path.join(r.root, 'docs/page.html'), '<script>evil()</script>\n');
  fs.writeFileSync(path.join(r.root, 'docs/map.md'), 'ok\n');
  fs.writeFileSync(path.join(r.root, 'docs/flow-map.json'), '{"v":3}\n');
  git(['commit', '-qam', 'pages'], r.root);
  assert.deepEqual(sync.scope(r.root, BRANCH, 'x').outside.sort(), ['docs/map.md', 'docs/page.html']);
  git(['checkout', '-q', BRANCH], r.root);
  git(['checkout', '-qb', 'y'], r.root);
  git(['rm', '-q', 'docs/flow-map.json'], r.root);
  git(['mv', 'src/a.js', 'docs/flow-map.json'], r.root);
  fs.writeFileSync(path.join(r.root, 'models.json'), JSON.stringify({ ...CONFIG, artifacts: [{ path: 'src/a.js', sources: ['x'] }] }));
  git(['commit', '-qam', 'rename'], r.root);
  assert.deepEqual(sync.scope(r.root, BRANCH, 'y').outside.sort(), ['models.json', 'src/a.js']);
  assert.deepEqual([...sync.exemptPaths([{ path: 'x.json', sources: ['a'], then: 'b', outputs: ['models.json'] }, { path: 'z.md', sources: ['a'] }])], []);
  assert.deepEqual([...sync.exemptPaths(CONFIG.artifacts)].sort(), ['docs/flow-map.html', 'docs/flow-map.json']);
});

test('the brain repository maps its artifacts, and the hook is wired for Claude and Pi', () => {
  const ROOT = path.resolve(__dirname, '..');
  const models = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.json'), 'utf8'));
  assert.ok(models.artifacts.some(a => a.path === 'docs/flow-map.json' && a.outputs.includes('docs/flow-map.html')));
  const claude = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
  for (const event of ['Stop', 'SubagentStop']) {
    assert.ok(claude.hooks[event].some(e => e.hooks.some(h => h.command.includes('skills/documentation/scripts/artifact-sync.js'))), event);
  }
  const pi = JSON.parse(fs.readFileSync(path.join(ROOT, '.pi/settings.json'), 'utf8'));
  assert.ok(pi.extensions.includes('../skills/documentation/scripts/artifact-sync-pi.js'));
  const calls = [];
  require('../skills/documentation/scripts/artifact-sync-pi.js')({ on: event => calls.push(event) });
  assert.deepEqual(calls, ['agent_end']);
});
