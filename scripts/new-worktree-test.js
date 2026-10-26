'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { plan, usedHostPorts, freePorts } = require('../skills/development-setup/scripts/new-worktree');

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
  const out = execFileSync('node', [script, 'create', 'ENG-7-demo'], { cwd: repo, encoding: 'utf8' });
  assert.match(out, /export COMPOSE_PROJECT_NAME=eng-7-demo/);
  assert.ok(fs.existsSync(path.join(parent, 'ENG-7-demo', '.git')));
  assert.strictEqual(run(['rev-parse', '--abbrev-ref', 'HEAD'], path.join(parent, 'ENG-7-demo')).trim(), 'ENG-7-demo');
  // from inside the worktree the main checkout is still found
  execFileSync('node', [script, 'remove', 'ENG-7-demo'], { cwd: path.join(parent, 'ENG-7-demo'), encoding: 'utf8', stdio: 'pipe' }).toString();
  assert.ok(!fs.existsSync(path.join(parent, 'ENG-7-demo')));
  fs.rmSync(parent, { recursive: true, force: true });
});
