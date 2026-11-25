#!/usr/bin/env node
'use strict';

// skills/documentation/scripts/artifact-sync.js: which artifacts are due, the hook's guards, the sync run, and the
// artifact-only scope that exempts a PR from the double-pass review. The agent, gh, and push are faked; git is real.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const sync = require('../skills/documentation/scripts/artifact-sync');

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const CONFIG = {
  'artifact-sync': { label: 'Sync', harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  artifacts: [{ path: 'docs/map.md', sources: ['src/**/*.js'], then: 'cp docs/map.md docs/map.html', outputs: ['docs/map.html'] }],
};

// A repository with an origin, a pushed code branch FAC-1-feature, and one commit on it that changes src/.
function repo({ change = 'src/a.js' } = {}) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-sync-'));
  dirs.push(top);
  const origin = path.join(top, 'origin.git');
  const root = path.join(top, 'proj');
  git(['init', '--bare', '-q', '-b', 'main', origin], top);
  git(['init', '-q', '-b', 'main', root], top);
  for (const [k, v] of [['user.name', 'T'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false']]) git(['config', k, v], root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify(CONFIG));
  fs.writeFileSync(path.join(root, 'src/a.js'), '1\n');
  fs.writeFileSync(path.join(root, 'docs/map.md'), 'v1\n');
  fs.writeFileSync(path.join(root, 'docs/map.html'), 'v1\n');
  git(['add', '-A'], root);
  git(['commit', '-qm', 'init'], root);
  git(['remote', 'add', 'origin', origin], root);
  git(['push', '-q', 'origin', 'main'], root);
  git(['fetch', '-q', 'origin'], root);
  const base = git(['rev-parse', 'HEAD'], root);
  git(['checkout', '-qb', 'FAC-1-feature'], root);
  fs.mkdirSync(path.dirname(path.join(root, change)), { recursive: true });
  fs.writeFileSync(path.join(root, change), '2\n');
  git(['add', '-A'], root);
  git(['commit', '-qm', 'change'], root);
  git(['push', '-q', '-u', 'origin', 'FAC-1-feature'], root);
  return { top, root, base, head: git(['rev-parse', 'HEAD'], root) };
}

const fakeLaunch = calls => (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid: process.pid, unref() {} }; };

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
});

test('the hook starts one background sync per new commit, and never for the sync agent, main, or an -artifacts branch', () => {
  const { root, head } = repo();
  const calls = [];
  assert.match(sync.hook(root, { BRAIN_ARTIFACT_SYNC: '1' }, fakeLaunch(calls)), /sync agent/);
  assert.match(sync.hook(root, {}, fakeLaunch(calls)), /started the artifact sync for docs\/map\.md/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(1, 3), ['run', '--root']);
  assert.ok(calls[0].args.includes(head));
  assert.equal(calls[0].opts.env.BRAIN_ARTIFACT_SYNC, '1');
  assert.ok(calls[0].opts.detached);
  // The same head is not started twice, even after the lock is gone.
  fs.rmSync(path.join(root, '.git/agent-brain/artifact-sync/FAC-1-feature.lock'));
  assert.match(sync.hook(root, {}, fakeLaunch(calls)), /already synced or attempted/);
  git(['checkout', '-q', 'main'], root);
  assert.match(sync.hook(root, {}, fakeLaunch(calls)), /not a code branch/);
  git(['checkout', '-qb', 'FAC-1-feature-artifacts'], root);
  assert.match(sync.hook(root, {}, fakeLaunch(calls)), /not a code branch/);
  assert.equal(calls.length, 1);
});

test('a commit that touches no source is recorded as synced without starting anything', () => {
  const { root, head } = repo({ change: 'README.md' });
  const calls = [];
  assert.match(sync.hook(root, {}, fakeLaunch(calls)), /no artifact is due/);
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.git/agent-brain/artifact-sync/FAC-1-feature.json'), 'utf8')).synced, head);
});

test('an unpushed branch and a running sync start nothing', () => {
  const { root } = repo();
  git(['checkout', '-qb', 'FAC-2-local'], root);
  assert.match(sync.hook(root, {}, fakeLaunch([])), /not on origin yet/);
  git(['checkout', '-q', 'FAC-1-feature'], root);
  const lock = path.join(root, '.git/agent-brain/artifact-sync/FAC-1-feature.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
  assert.match(sync.hook(root, {}, fakeLaunch([])), /already running/);
  fs.writeFileSync(lock, '999999999');
  assert.match(sync.hook(root, {}, fakeLaunch([])), /started/, 'a dead pid is a stale lock');
});

// The fake agent edits files in its cwd, the sync worktree; gh answers list (no PR) and create (a URL).
function fakeExec(calls, edit) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    if (cmd === 'claude' || cmd === 'pi') { edit(opts.cwd); return { status: 0, stdout: '', stderr: '' }; }
    if (cmd === 'gh' && args[1] === 'list') return { status: 0, stdout: '\n' };
    if (cmd === 'gh' && args[1] === 'create') return { status: 0, stdout: 'https://example.com/pr/7\n' };
    return { status: 1, stderr: 'unexpected' };
  };
}

test('run commits only the artifacts on <branch>-artifacts, runs then, and opens a PR into the code branch', () => {
  const { root, base, head } = repo();
  const calls = [];
  const out = sync.run({ root, branch: 'FAC-1-feature', base, head },
    { spawnSync: fakeExec(calls, cwd => fs.writeFileSync(path.join(cwd, 'docs/map.md'), 'v2\n')), push: () => {} });
  assert.match(out, /committed on FAC-1-feature-artifacts; PR https:\/\/example\.com\/pr\/7/);
  const agent = calls.find(c => c.cmd === 'claude');
  assert.ok(agent.args.includes('claude-sonnet-5-5') && agent.args.includes('medium'));
  assert.match(agent.args[1], /docs\/map\.md\n {2}changed sources: src\/a\.js/);
  const wt = agent.cwd;
  assert.equal(git(['branch', '--show-current'], wt), 'FAC-1-feature-artifacts');
  assert.equal(fs.readFileSync(path.join(wt, 'docs/map.html'), 'utf8'), 'v2\n', 'the then command ran');
  const message = git(['log', '-1', '--format=%B'], wt);
  assert.match(message, /^docs\(artifacts\): bring 1 artifact up to date with [0-9a-f]{7} \[FAC-1\]$/m);
  for (const t of ['Model: claude-sonnet-5-5', 'Thinking-effort: medium', 'Harness: claude']) assert.ok(message.includes(t), t);
  assert.deepEqual(git(['diff', '--name-only', `${head}...HEAD`], wt).split('\n').sort(), ['docs/map.html', 'docs/map.md']);
  const create = calls.find(c => c.cmd === 'gh' && c.args[1] === 'create');
  assert.deepEqual(create.args.slice(2, 6), ['--base', 'FAC-1-feature', '--head', 'FAC-1-feature-artifacts']);
  assert.match(create.args[create.args.indexOf('--title') + 1], /^FAC-1: artifacts for FAC-1-feature at /);
  assert.ok(!fs.existsSync(path.join(root, '.git/agent-brain/artifact-sync/FAC-1-feature.lock')), 'the lock is released');
  // The code checkout was never touched.
  assert.equal(fs.readFileSync(path.join(root, 'docs/map.md'), 'utf8'), 'v1\n');
  assert.equal(git(['status', '--porcelain'], root), '');
});

test('run refuses to commit when the agent edits anything but its artifacts', () => {
  const { root, base, head } = repo();
  const calls = [];
  assert.throws(() => sync.run({ root, branch: 'FAC-1-feature', base, head }, {
    spawnSync: fakeExec(calls, cwd => { fs.writeFileSync(path.join(cwd, 'docs/map.md'), 'v2\n'); fs.writeFileSync(path.join(cwd, 'src/a.js'), 'hacked\n'); }),
    push: () => { throw new Error('must not push'); },
  }), /not its artifacts, nothing committed: src\/a\.js/);
  const wt = calls.find(c => c.cmd === 'claude').cwd;
  assert.equal(git(['rev-parse', 'HEAD'], wt), head, 'nothing was committed');
  assert.match(JSON.parse(fs.readFileSync(path.join(root, '.git/agent-brain/artifact-sync/FAC-1-feature.json'), 'utf8')).error, /not its artifacts/);
});

test('a second run reuses the worktree, merges the new head, and leaves an unchanged artifact alone', () => {
  const { root, base, head } = repo();
  const deps = calls => ({ spawnSync: fakeExec(calls, cwd => fs.writeFileSync(path.join(cwd, 'docs/map.md'), 'v2\n')), push: () => {} });
  sync.run({ root, branch: 'FAC-1-feature', base, head }, deps([]));
  fs.writeFileSync(path.join(root, 'src/a.js'), '3\n');
  git(['commit', '-qam', 'more'], root);
  const head2 = git(['rev-parse', 'HEAD'], root);
  const calls = [];
  assert.match(sync.run({ root, branch: 'FAC-1-feature', base: head, head: head2 }, deps(calls)), /already current/);
  const wt = calls.find(c => c.cmd === 'claude').cwd;
  assert.equal(git(['merge-base', '--is-ancestor', head2, 'HEAD'], wt), '');
});

test('scope: an artifact-only change is exempt; code or models.json in it is not', () => {
  const { root, base, head } = repo();
  sync.run({ root, branch: 'FAC-1-feature', base, head }, { spawnSync: fakeExec([], cwd => fs.writeFileSync(path.join(cwd, 'docs/map.md'), 'v2\n')), push: () => {} });
  let s = sync.scope(root, 'FAC-1-feature', 'FAC-1-feature-artifacts');
  assert.deepEqual(s.outside, []);
  assert.equal(s.changed.length, 2);
  git(['checkout', '-q', 'FAC-1-feature'], root);
  git(['checkout', '-qb', 'FAC-1-widen'], root);
  fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ ...CONFIG, artifacts: [{ path: 'src/a.js', sources: ['x'] }] }));
  fs.writeFileSync(path.join(root, 'src/a.js'), 'sneaky\n');
  git(['commit', '-qam', 'widen'], root);
  s = sync.scope(root, 'FAC-1-feature', 'FAC-1-widen');
  assert.deepEqual(s.outside.sort(), ['models.json', 'src/a.js'], "the base's config decides, so a PR cannot widen its own exemption");
});

test('the brain repository maps its flow map, and the hook script is wired for Claude and Pi', () => {
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
  require('../skills/documentation/scripts/artifact-sync-pi.js')({ on: (event, fn) => calls.push(event) });
  assert.deepEqual(calls, ['agent_end']);
});
