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
  for (const d of ['src', 'docs', 'web']) fs.mkdirSync(path.join(root, d));
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
    if (cmd === 'gh' && args[1] === 'list') return gh.list || { status: 0, stdout: '\n' };
    if (cmd === 'gh' && args[1] === 'create') return { status: 0, stdout: 'https://example.com/pr/7\n' };
    return { status: 1, stderr: 'unexpected' };
  };
}
const edit = cwd => fs.writeFileSync(path.join(cwd, 'docs/map.md'), `v2 ${++counter}\n`);
const runIt = (r, opts = {}) => sync.run({ root: r.root, branch: BRANCH, base: opts.base || r.base, head: opts.head || r.head },
  { spawnSync: fakeExec(opts.calls || [], opts.edit || edit, opts.gh), ...opts.deps });

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

test('an unpushed branch and a running sync start nothing; a dead holder is taken over', () => {
  const r = repo();
  git(['checkout', '-qb', 'FAC-2-local'], r.root);
  assert.match(sync.hook(r.root, {}, fakeLaunch([])), /not on origin yet/);
  git(['checkout', '-q', BRANCH], r.root);
  const lock = stateFile(r.root, 'lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
  assert.match(sync.hook(r.root, {}, fakeLaunch([])), /already running/);
  fs.writeFileSync(lock, '999999999');
  assert.match(sync.hook(r.root, {}, fakeLaunch([])), /started/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'starting');
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
  assert.deepEqual(create.args.slice(2, 6), ['--base', BRANCH, '--head', `${BRANCH}-artifacts`]);
  assert.deepEqual(parseBlastRadius(create.args[create.args.indexOf('--body') + 1]), { level: 'low', error: null });
  const list = calls.find(c => c.cmd === 'gh' && c.args[1] === 'list');
  assert.ok(list.args.includes('--base') && list.args.includes(BRANCH));
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

test('run takes only a free or "starting" lock, and releases only its own', () => {
  const r = repo();
  const lock = stateFile(r.root, 'lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '1');
  assert.throws(() => runIt(r), /another sync holds/);
  assert.equal(fs.readFileSync(lock, 'utf8'), '1');
  fs.writeFileSync(lock, 'starting');
  runIt(r);
  assert.ok(!fs.existsSync(lock));
});

test("scope --pr: exempt only for this clone's published commit on <base>-artifacts", () => {
  const r = repo();
  runIt(r);
  git(['fetch', '-q', 'origin'], r.root);
  const published = readState(r.root).published;
  const view = (over = {}) => ({ prView: () => ({ base: BRANCH, baseSha: r.head, head: `${BRANCH}-artifacts`, headSha: published, ...over }) });
  assert.deepEqual(sync.prScope(r.root, 1, view()).reasons, []);
  assert.match(sync.prScope(r.root, 1, view({ head: 'FAC-1-other' })).reasons.join(), /is not FAC-1-feature-artifacts/);
  // A hand-made commit on the artifact branch, even one touching only the map's paths, is not the sync's.
  git(['checkout', '-q', '--detach', published], r.root);
  fs.writeFileSync(path.join(r.root, 'docs/map.md'), 'hand edit\n');
  git(['commit', '-qam', 'hand'], r.root);
  assert.match(sync.prScope(r.root, 1, view({ headSha: git(['rev-parse', 'HEAD'], r.root) })).reasons.join(), /not the commit this clone's sync published/);
});

test('scope: an HTML artifact, models.json, and both ends of a rename keep the normal review', () => {
  const r = repo();
  git(['checkout', '-qb', 'x'], r.root);
  fs.writeFileSync(path.join(r.root, 'docs/page.html'), '<script>evil()</script>\n');
  fs.writeFileSync(path.join(r.root, 'docs/map.md'), 'ok\n');
  git(['commit', '-qam', 'html'], r.root);
  assert.deepEqual(sync.scope(r.root, BRANCH, 'x').outside, ['docs/page.html']);
  git(['checkout', '-q', BRANCH], r.root);
  git(['checkout', '-qb', 'y'], r.root);
  git(['rm', '-q', 'docs/map.md'], r.root);
  git(['mv', 'src/a.js', 'docs/map.md'], r.root);
  fs.writeFileSync(path.join(r.root, 'models.json'), JSON.stringify({ ...CONFIG, artifacts: [{ path: 'src/a.js', sources: ['x'] }] }));
  git(['commit', '-qam', 'rename'], r.root);
  assert.deepEqual(sync.scope(r.root, BRANCH, 'y').outside.sort(), ['models.json', 'src/a.js']);
  assert.ok(!sync.exemptPaths([{ path: 'x.md', sources: ['a'], then: 'b', outputs: ['models.json'] }]).has('models.json'));
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
