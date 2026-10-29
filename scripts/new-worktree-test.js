'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { plan, usedHostPorts, freePorts, shellQuote } = require('../skills/development-setup/scripts/new-worktree');

test('the worktree sits beside the main checkout and the compose project is lowercase', () => {
  assert.deepStrictEqual(plan('ENG-123-login', '/work/app'), {
    name: 'ENG-123-login', branch: 'ENG-123-login', worktree: '/work/ENG-123-login', composeProject: 'eng-123-login',
  });
});

test('names that are not <TICKET>-<slug> are refused', () => {
  for (const bad of ['login', 'eng-123-login', 'ENG-123', 'ENG-123-Login', '../ENG-1-x']) {
    assert.throws(() => plan(bad, '/work/app'), /not <TICKET>-<slug>/, bad);
  }
});

test('a worktree inside a harness directory is refused', () => {
  assert.throws(() => plan('ENG-1-x', '/home/me/.claude/app'), /harness or brain directory/);
});

test('host ports are read from docker ps, including ranges', () => {
  const used = usedHostPorts('0.0.0.0:5432->5432/tcp, :::5432->5432/tcp\n0.0.0.0:3000-3002->3000-3002/tcp\n');
  assert.deepStrictEqual([...used].sort(), [3000, 3001, 3002, 5432]);
});

test('free ports skip the ones in use', async () => {
  assert.deepStrictEqual(await freePorts(2, new Set([20000]), 20000, 20010), [20001, 20002]);
});

test('create and remove make a sibling worktree on a new branch', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  const repo = path.join(parent, 'app');
  const run = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  fs.mkdirSync(repo);
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const script = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'new-worktree.js');
  const out = execFileSync('node', [script, 'create', 'ENG-7-demo', '--persona', 'backend-engineer'], { cwd: repo, encoding: 'utf8' });
  assert.match(out, /export COMPOSE_PROJECT_NAME='eng-7-demo'/);
  assert.ok(fs.existsSync(path.join(parent, 'ENG-7-demo', '.git')));
  assert.strictEqual(run(['rev-parse', '--abbrev-ref', 'HEAD'], path.join(parent, 'ENG-7-demo')).trim(), 'ENG-7-demo');
  // from inside the worktree the main checkout is still found
  execFileSync('node', [script, 'remove', 'ENG-7-demo'], { cwd: path.join(parent, 'ENG-7-demo'), encoding: 'utf8', stdio: 'pipe' }).toString();
  assert.ok(!fs.existsSync(path.join(parent, 'ENG-7-demo')));
  fs.rmSync(parent, { recursive: true, force: true });
});

test('exported values survive the shell verbatim, spaces and metacharacters included', () => {
  const dir = "/work/my app; printf INJECTED/it's";
  const out = execFileSync('sh', ['-c', `eval "export WORKTREE=${shellQuote(dir)}"; printf %s "$WORKTREE"`], { encoding: 'utf8' });
  assert.strictEqual(out, dir);
});

test('agents created one after another claim disjoint host ports', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-'));
  const repo = path.join(parent, 'app');
  const run = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  fs.mkdirSync(repo);
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const script = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'new-worktree.js');
  const portsOf = out => out.split('\n').filter(l => /HOST_PORT_/.test(l)).map(l => l.split('=')[1].replace(/'/g, ''));
  const a = portsOf(execFileSync('node', [script, 'create', 'ENG-8-a', '--persona', 'web-engineer', '--ports', '2'], { cwd: repo, encoding: 'utf8' }));
  const b = portsOf(execFileSync('node', [script, 'create', 'ENG-9-b', '--persona', 'web-engineer', '--ports', '2'], { cwd: repo, encoding: 'utf8' }));
  assert.strictEqual(a.length, 2);
  assert.strictEqual(b.length, 2);
  assert.deepStrictEqual(a.filter(p => b.includes(p)), []);
  execFileSync('node', [script, 'remove', 'ENG-8-a'], { cwd: repo, encoding: 'utf8' });
  execFileSync('node', [script, 'remove', 'ENG-9-b'], { cwd: repo, encoding: 'utf8' });
  fs.rmSync(parent, { recursive: true, force: true });
});

test('the port lock admits one holder at a time and releases after the critical section', async () => {
  const { withLock } = require('../skills/development-setup/scripts/new-worktree');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
  const file = path.join(dir, 'claims.json');
  const order = [];
  await Promise.all([
    withLock(file, async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 150)); order.push('a-end'); }),
    withLock(file, async () => { order.push('b-start'); order.push('b-end'); }),
  ]);
  assert.deepStrictEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
  assert.strictEqual(fs.existsSync(`${file}.lock`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('running create again for the same ticket reuses the worktree', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-'));
  const repo = path.join(parent, 'app');
  const run = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  fs.mkdirSync(repo);
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const script = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'new-worktree.js');
  execFileSync('node', [script, 'create', 'ENG-11-again', '--persona', 'scout'], { cwd: repo, encoding: 'utf8' });
  const again = execFileSync('node', [script, 'create', 'ENG-11-again', '--persona', 'scout'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(again, /export AGENT_NAME='ENG-11-again \(scout\)'/);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('create needs a persona, which goes into the agent name', () => {
  const script = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'new-worktree.js');
  for (const args of [[], ['--persona'], ['--persona', 'Backend Engineer']]) {
    const r = require('child_process').spawnSync('node', [script, 'create', 'ENG-12-p', ...args, '--dry-run'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2, args.join(' '));
    assert.match(r.stderr, /--persona/);
  }
});
