'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { plan, usedHostPorts, freePorts, shellQuote } = require('../skills/development-setup/scripts/agent-env');

// Port claims live under the user's home: the tests use a scratch home (inherited by the scripts they spawn), never the real one.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-home-'));
process.on('exit', () => fs.rmSync(process.env.HOME, { recursive: true, force: true }));

// Docker and the package managers are fakes on PATH, so the Compose and install steps run the same with or without a
// Docker daemon. The fake keeps Compose state in FAKE_DOCKER_STATE ({ up, projects: { <p>: { containers: [{ id, dir }],
// volumes, networks } }, daemon }) and logs every call to FAKE_TOOL_LOG. By default Docker is down.
const FAKES = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-fakes-'));
process.on('exit', () => fs.rmSync(FAKES, { recursive: true, force: true }));
fs.writeFileSync(path.join(FAKES, 'docker'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (process.env.FAKE_TOOL_LOG) fs.appendFileSync(process.env.FAKE_TOOL_LOG, 'docker ' + args.join(' ') + '\\n');
const file = process.env.FAKE_DOCKER_STATE;
const state = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { up: false, projects: {} };
if (!state.up) { console.error('Cannot connect to the Docker daemon'); process.exit(1); }
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const projectOf = () => { const f = args[args.indexOf('--filter') + 1] || ''; return f.split('com.docker.compose.project=')[1]; };
const project = p => (state.projects[p] = state.projects[p] || { containers: [], volumes: [], networks: [] });
if (args[0] === 'info') {
  if (process.env.FAKE_DOCKER_ON_INFO) require('child_process').execSync(process.env.FAKE_DOCKER_ON_INFO, { stdio: 'ignore' });
  console.log(state.daemon || 'daemon-a');
  process.exit(0);
}
if (args[0] === 'ps' && !args.includes('--filter')) process.exit(0);
if (args[0] === 'ps') { for (const c of project(projectOf()).containers) console.log(c.id + '\\t' + c.dir); process.exit(0); }
if (args[0] === 'volume') { for (const v of project(projectOf()).volumes) console.log(v); process.exit(0); }
if (args[0] === 'network') { for (const n of project(projectOf()).networks) console.log(n); process.exit(0); }
if (args[0] === 'compose') {
  const p = args[args.indexOf('-p') + 1];
  if (args.includes('up')) {
    const dir = fs.realpathSync(process.cwd());
    project(p).containers = [{ id: 'c-' + p, dir }];
    project(p).volumes = [p + '_data'];
    project(p).networks = [p + '_default'];
  }
  if (args.includes('down')) delete state.projects[p];
  save();
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
for (const tool of ['npm', 'pnpm', 'yarn', 'bun', 'uv', 'poetry']) {
  fs.writeFileSync(path.join(FAKES, tool), `#!/bin/sh\n[ -n "$FAKE_TOOL_LOG" ] && echo "${tool} $* in $PWD" >> "$FAKE_TOOL_LOG"\nexit 0\n`, { mode: 0o755 });
}
process.env.PATH = `${FAKES}${path.delimiter}${process.env.PATH}`;

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

test('spawn and teardown make a sibling worktree on a new branch', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  const repo = path.join(parent, 'app');
  const run = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  fs.mkdirSync(repo);
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const script = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'agent-env.js');
  const out = execFileSync('node', [script, 'spawn', 'ENG-7-demo', '--owner', 'tester', '--persona', 'backend-engineer'], { cwd: repo, encoding: 'utf8' });
  assert.match(out, /export COMPOSE_PROJECT_NAME='eng-7-demo'/);
  assert.ok(fs.existsSync(path.join(parent, 'ENG-7-demo', '.git')));
  assert.strictEqual(run(['rev-parse', '--abbrev-ref', 'HEAD'], path.join(parent, 'ENG-7-demo')).trim(), 'ENG-7-demo');
  // from inside the worktree the main checkout is still found
  execFileSync('node', [script, 'teardown', 'ENG-7-demo', '--owner', 'tester'], { cwd: path.join(parent, 'ENG-7-demo'), encoding: 'utf8', stdio: 'pipe' }).toString();
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
  const script = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'agent-env.js');
  const portsOf = out => out.split('\n').filter(l => /HOST_PORT_/.test(l)).map(l => l.split('=')[1].replace(/'/g, ''));
  const a = portsOf(execFileSync('node', [script, 'spawn', 'ENG-8-a', '--owner', 'tester', '--persona', 'web-engineer', '--ports', '2'], { cwd: repo, encoding: 'utf8' }));
  const b = portsOf(execFileSync('node', [script, 'spawn', 'ENG-9-b', '--owner', 'tester', '--persona', 'web-engineer', '--ports', '2'], { cwd: repo, encoding: 'utf8' }));
  assert.strictEqual(a.length, 2);
  assert.strictEqual(b.length, 2);
  assert.deepStrictEqual(a.filter(p => b.includes(p)), []);
  execFileSync('node', [script, 'teardown', 'ENG-8-a', '--owner', 'tester'], { cwd: repo, encoding: 'utf8' });
  execFileSync('node', [script, 'teardown', 'ENG-9-b', '--owner', 'tester'], { cwd: repo, encoding: 'utf8' });
  fs.rmSync(parent, { recursive: true, force: true });
});

test('the port lock admits one holder at a time and releases after the critical section', async () => {
  const { withLock } = require('../skills/development-setup/scripts/agent-env');
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

test('running spawn again for the same ticket reuses the worktree', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-'));
  const repo = path.join(parent, 'app');
  const run = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  fs.mkdirSync(repo);
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const script = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'agent-env.js');
  execFileSync('node', [script, 'spawn', 'ENG-11-again', '--owner', 'tester', '--persona', 'scout'], { cwd: repo, encoding: 'utf8' });
  const again = execFileSync('node', [script, 'spawn', 'ENG-11-again', '--owner', 'tester', '--persona', 'scout'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(again, /export AGENT_NAME='ENG-11-again \(scout\)'/);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('reusing a worktree keeps the host ports it already claimed, even while a service holds one', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-ports-'));
  const repo = path.join(parent, 'app');
  const run = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  fs.mkdirSync(repo);
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const script = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'agent-env.js');
  const create = () => execFileSync('node', [script, 'spawn', 'ENG-13-ports', '--owner', 'tester', '--persona', 'scout', '--ports', '2'],
    { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const port = (out, n) => out.match(new RegExp(`HOST_PORT_${n}='(\\d+)'`))[1];
  const first = create();
  // A running service holds the first port on localhost, as a dev server would.
  const service = net.createServer();
  await new Promise((resolve, reject) => service.once('error', reject).listen(Number(port(first, 1)), '127.0.0.1', resolve));
  try {
    const again = create();
    assert.strictEqual(port(again, 1), port(first, 1));
    assert.strictEqual(port(again, 2), port(first, 2));
  } finally {
    await new Promise(resolve => service.close(resolve));
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('spawn needs a persona, which goes into the agent name', () => {
  const script = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'agent-env.js');
  for (const args of [[], ['--persona'], ['--persona', 'Backend Engineer']]) {
    const r = require('child_process').spawnSync('node', [script, 'spawn', 'ENG-12-p', '--owner', 'tester', ...args, '--dry-run'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2, args.join(' '));
    assert.match(r.stderr, /--persona/);
  }
});

test('teardown works only on what the ledger holds for this owner, with a clean worktree', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const repo = path.join(parent, 'app');
  const run = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  fs.mkdirSync(repo);
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const script = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'agent-env.js');
  const node = (args, cwd = repo) => spawnSync('node', [script, ...args], { cwd, encoding: 'utf8' });

  assert.strictEqual(node(['spawn', 'ENG-21-mine', '--persona', 'backend-engineer', '--owner', 'alice']).status, 0);
  const wt = path.join(parent, 'ENG-21-mine');

  // another owner cannot tear it down
  let r = node(['teardown', 'ENG-21-mine', '--owner', 'bob']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /belongs to alice/);
  assert.ok(fs.existsSync(wt));

  // uncommitted work stops the removal
  fs.writeFileSync(path.join(wt, 'scratch.txt'), 'x');
  r = node(['teardown', 'ENG-21-mine', '--owner', 'alice']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /uncommitted or untracked/);
  fs.rmSync(path.join(wt, 'scratch.txt'));

  // a worktree the ledger does not know about is not torn down
  run(['worktree', 'add', '-q', '-b', 'ENG-22-theirs', path.join(parent, 'ENG-22-theirs'), 'main']);
  r = node(['teardown', 'ENG-22-theirs', '--owner', 'alice']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /not in the ledger/);
  assert.ok(fs.existsSync(path.join(parent, 'ENG-22-theirs')));

  // the owner, with a clean worktree, tears it down; spawn created the branch and it has merged, so it goes too
  r = node(['teardown', 'ENG-21-mine', '--owner', 'alice']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(wt));
  assert.strictEqual(run(['branch', '--list', 'ENG-21-mine']), '');
  const ledger = JSON.parse(fs.readFileSync(path.join(repo, '.git', 'brain-env-ledger.json'), 'utf8'));
  assert.strictEqual(ledger['ENG-21-mine'], undefined);

  fs.rmSync(parent, { recursive: true, force: true });
});

test('a second owner cannot take over an environment, reuse it, or read a corrupt ledger into an empty one', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-'));
  const repo = path.join(parent, 'app');
  const run = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  fs.mkdirSync(repo);
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const script = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'agent-env.js');
  const node = args => spawnSync('node', [script, ...args], { cwd: repo, encoding: 'utf8' });

  assert.strictEqual(node(['spawn', 'ENG-30-x', '--persona', 'be', '--owner', 'alice']).status, 0);
  // another owner's spawn is refused, whether or not the directory exists
  let r = node(['spawn', 'ENG-30-x', '--persona', 'be', '--owner', 'mallory']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /belongs to alice/);
  // an owner is required
  r = node(['spawn', 'ENG-31-y', '--persona', 'be']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--owner <name> is required/);
  // a corrupt ledger stops every command rather than reading as empty
  fs.writeFileSync(path.join(repo, '.git', 'brain-env-ledger.json'), '{"ENG-30-x": ');
  r = node(['teardown', 'ENG-30-x', '--owner', 'alice']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /does not parse/);
  assert.ok(fs.existsSync(path.join(parent, 'ENG-30-x')));
  fs.rmSync(parent, { recursive: true, force: true });
});

const SCRIPT = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'agent-env.js');

function makeRepo(prefix) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(parent, 'app');
  fs.mkdirSync(repo);
  const run = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return { parent, repo };
}

test('two repositories with the same environment name get different ports, and removing one keeps the other claim', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const env = { ...process.env, HOME: home };
  const a = makeRepo('claims-a-');
  const b = makeRepo('claims-b-');
  const run = (repo, args) => spawnSync('node', [SCRIPT, ...args], { cwd: repo.repo, encoding: 'utf8', env });
  const createArgs = ['spawn', 'ENG-1-demo', '--owner', 'tester', '--persona', 'web-engineer', '--ports', '1'];
  const ra = run(a, createArgs);
  const rb = run(b, createArgs);
  assert.strictEqual(ra.status, 0, ra.stderr);
  assert.strictEqual(rb.status, 0, rb.stderr);
  const portA = ra.stdout.match(/HOST_PORT_1='(\d+)'/)[1];
  const portB = rb.stdout.match(/HOST_PORT_1='(\d+)'/)[1];
  assert.notStrictEqual(portA, portB);

  const claimsFile = path.join(home, '.agent-brain', 'port-claims.json');
  const claims = JSON.parse(fs.readFileSync(claimsFile, 'utf8'));
  assert.strictEqual(Object.keys(claims).length, 2, 'one claim map per repository');

  assert.strictEqual(run(a, ['teardown', 'ENG-1-demo', '--owner', 'tester']).status, 0);
  const after = JSON.parse(fs.readFileSync(claimsFile, 'utf8'));
  assert.deepStrictEqual(Object.values(after).map(envs => envs['ENG-1-demo']), [[Number(portB)]]);

  // ports stay exclusive across repositories: repository a's next claim cannot take b's port
  const next = run(a, ['spawn', 'ENG-2-other', '--owner', 'tester', '--persona', 'web-engineer', '--ports', '1']);
  assert.strictEqual(next.status, 0, next.stderr);
  assert.notStrictEqual(next.stdout.match(/HOST_PORT_1='(\d+)'/)[1], portB);

  fs.rmSync(a.parent, { recursive: true, force: true });
  fs.rmSync(b.parent, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('separate processes contending for one lock never overlap, and a lock left by a dead pid is reclaimed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contend-'));
  const file = path.join(dir, 'claims.json');
  const log = path.join(dir, 'log.txt');
  const worker = path.join(dir, 'worker.js');
  fs.writeFileSync(worker, `
    const { withLock } = require(${JSON.stringify(SCRIPT)});
    const fs = require('fs');
    const [file, log, rounds] = process.argv.slice(2);
    (async () => {
      for (let i = 0; i < Number(rounds); i++) {
        await withLock(file, async () => {
          fs.appendFileSync(log, 'enter ' + process.pid + '\\n');
          await new Promise(r => setTimeout(r, 30));
          fs.appendFileSync(log, 'leave ' + process.pid + '\\n');
        });
      }
    })().catch(e => { console.error(e); process.exit(1); });
  `);
  const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid;
  fs.writeFileSync(`${file}.lock`, `${dead} 0 0`);

  const workers = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, file, log, '3'], { stdio: 'pipe' });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
  }));
  await Promise.all(workers);

  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 36);
  for (let i = 0; i < lines.length; i += 2) {
    const [enter, pidIn] = lines[i].split(' ');
    const [leave, pidOut] = lines[i + 1].split(' ');
    assert.strictEqual(enter, 'enter', lines.join('\n'));
    assert.strictEqual(leave, 'leave', lines.join('\n'));
    assert.strictEqual(pidIn, pidOut, `critical sections overlapped: ${lines[i]} / ${lines[i + 1]}`);
  }
  assert.strictEqual(fs.existsSync(`${file}.lock`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a teardown that waits for the lifecycle lock checks ownership under it, so another owner\'s environment is not deleted', async () => {
  const { parent, repo } = makeRepo('race-');
  const node = args => spawnSync('node', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(node(['spawn', 'ENG-40-x', '--persona', 'be', '--owner', 'alice']).status, 0);
  const ledgerFile = path.join(repo, '.git', 'brain-env-ledger.json');
  const lifecycle = path.join(repo, '.git', 'brain-env-lifecycle');
  const held = path.join(parent, 'held');
  // A separate process holds the lifecycle lock and, while holding it, hands the environment to bob.
  const holder = `
    const { withLock } = require(${JSON.stringify(SCRIPT)});
    const fs = require('fs');
    withLock(${JSON.stringify(lifecycle)}, async () => {
      fs.writeFileSync(${JSON.stringify(held)}, '');
      await new Promise(r => setTimeout(r, 1000));
      const ledger = JSON.parse(fs.readFileSync(${JSON.stringify(ledgerFile)}, 'utf8'));
      ledger['ENG-40-x'].owner = 'bob';
      fs.writeFileSync(${JSON.stringify(ledgerFile)}, JSON.stringify(ledger));
    }).then(() => process.exit(0), e => { console.error(e); process.exit(1); });
  `;
  const h = spawn(process.execPath, ['-e', holder], { stdio: 'pipe' });
  const holderExit = new Promise(resolve => h.on('exit', resolve));
  for (let i = 0; !fs.existsSync(held); i++) {
    assert.ok(i < 300, 'holder never took the lock');
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  let stderr = '';
  const r = spawn(process.execPath, [SCRIPT, 'teardown', 'ENG-40-x', '--owner', 'alice'], { cwd: repo, stdio: 'pipe' });
  r.stderr.on('data', d => { stderr += d; });
  let removeCode = null;
  const removeExit = new Promise(resolve => r.on('exit', code => { removeCode = code; resolve(code); }));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.strictEqual(removeCode, null, 'teardown ran while the lifecycle lock was held');

  await holderExit;
  assert.strictEqual(await removeExit, 1, stderr);
  assert.match(stderr, /belongs to bob, not alice/);
  assert.ok(fs.existsSync(path.join(parent, 'ENG-40-x')), 'the environment was deleted under the other owner');
  fs.rmSync(parent, { recursive: true, force: true });
});

test('a contender that judged a lock dead cannot remove the live lock that replaced it', () => {
  const { reclaimStale } = require(SCRIPT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replace-'));
  const lock = path.join(dir, 'claims.json.lock');
  const dead = `${spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid} 0 0`;
  fs.writeFileSync(lock, dead);
  // contender A reclaims the dead lock; a live holder then publishes its own
  assert.strictEqual(reclaimStale(lock, dead), true);
  assert.ok(!fs.existsSync(lock));
  const live = `${process.pid} 1 1`;
  fs.writeFileSync(lock, live);
  // contender B judged the same dead token before A acted, and arrives late
  reclaimStale(lock, dead);
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), live);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a reclaim marker is never expired by age, so a suspended reclaimer keeps its right to the dead lock', () => {
  const { reclaimStale } = require(SCRIPT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-'));
  const lock = path.join(dir, 'claims.json.lock');
  const dead = `${spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid} 0 0`;
  fs.writeFileSync(lock, dead);
  const digest = require('crypto').createHash('sha256').update(dead).digest('hex').slice(0, 16);
  const marker = `${lock}.reclaim-${digest}`;
  fs.writeFileSync(marker, 'suspended reclaimer');
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(marker, old, old);
  assert.strictEqual(reclaimStale(lock, dead), false);
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), dead);
  assert.ok(fs.existsSync(marker));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a legacy flat claim keeps its ports for a repository that spawns the same environment name', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-home-'));
  fs.mkdirSync(path.join(home, '.agent-brain'));
  fs.writeFileSync(path.join(home, '.agent-brain', 'port-claims.json'), JSON.stringify({ 'ENG-1-demo': [20000] }));
  const repo = makeRepo('legacy-');
  const r = spawnSync('node', [SCRIPT, 'spawn', 'ENG-1-demo', '--owner', 'tester', '--persona', 'web-engineer', '--ports', '1'],
    { cwd: repo.repo, encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.notStrictEqual(r.stdout.match(/HOST_PORT_1='(\d+)'/)[1], '20000');
  fs.rmSync(repo.parent, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

const gitIn = (cwd, args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
const commitFile = (cwd, name, text) => { fs.writeFileSync(path.join(cwd, name), text); gitIn(cwd, ['add', name]); gitIn(cwd, ['commit', '-q', '-m', name]); };
const ledgerOf = repo => JSON.parse(fs.readFileSync(path.join(repo, '.git', 'brain-env-ledger.json'), 'utf8'));

function fakeTools(state = { up: false, projects: {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-state-'));
  const stateFile = path.join(dir, 'state.json');
  const log = path.join(dir, 'log.txt');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  return {
    env: { ...process.env, FAKE_DOCKER_STATE: stateFile, FAKE_TOOL_LOG: log },
    state: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    setState: s => fs.writeFileSync(stateFile, JSON.stringify(s)),
    log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function runner(repo, env = process.env) {
  return args => spawnSync('node', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8', env });
}

test('teardown waits for the merge; --abandon keeps the unmerged branch, and a resumed session spawns on it again', () => {
  const { parent, repo } = makeRepo('merge-');
  const node = runner(repo);
  const wt = path.join(parent, 'ENG-50-work');
  assert.strictEqual(node(['spawn', 'ENG-50-work', '--owner', 'a', '--persona', 'be']).status, 0);
  commitFile(wt, 'work.txt', 'w');
  let r = node(['teardown', 'ENG-50-work', '--owner', 'a']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /has not merged into main/);
  assert.ok(fs.existsSync(wt));
  r = node(['teardown', 'ENG-50-work', '--owner', 'a', '--abandon']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept: it has not merged/);
  assert.ok(!fs.existsSync(wt));
  const tip = gitIn(repo, ['rev-parse', 'ENG-50-work']);
  r = node(['spawn', 'ENG-50-work', '--owner', 'a', '--persona', 'be']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(gitIn(wt, ['rev-parse', 'HEAD']), tip);
  // This spawn found the branch already there, so even after the merge teardown leaves it alone.
  gitIn(repo, ['merge', '--no-ff', '-q', '-m', 'merge', 'ENG-50-work']);
  r = node(['teardown', 'ENG-50-work', '--owner', 'a']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept: spawn did not create it/);
  assert.notStrictEqual(gitIn(repo, ['branch', '--list', 'ENG-50-work']), '');
  fs.rmSync(parent, { recursive: true, force: true });
});

test('after the merge teardown deletes the branch spawn created, and a resumed session spawns a fresh one from the base', () => {
  const { parent, repo } = makeRepo('resume-');
  const node = runner(repo);
  const wt = path.join(parent, 'ENG-51-done');
  assert.strictEqual(node(['spawn', 'ENG-51-done', '--owner', 'a', '--persona', 'be']).status, 0);
  commitFile(wt, 'done.txt', 'd');
  gitIn(repo, ['merge', '--no-ff', '-q', '-m', 'merge', 'ENG-51-done']);
  let r = node(['teardown', 'ENG-51-done', '--owner', 'a']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /branch ENG-51-done deleted/);
  assert.strictEqual(gitIn(repo, ['branch', '--list', 'ENG-51-done']), '');
  assert.strictEqual(ledgerOf(repo)['ENG-51-done'], undefined);
  r = node(['spawn', 'ENG-51-done', '--owner', 'a', '--persona', 'be']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(gitIn(wt, ['rev-parse', 'HEAD']), gitIn(repo, ['rev-parse', 'main']));
  assert.strictEqual(ledgerOf(repo)['ENG-51-done'].branchCreated, true);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('a worktree deleted by hand is restored by spawn on the same branch, which stays spawn\'s', () => {
  const { parent, repo } = makeRepo('restore-');
  const node = runner(repo);
  const wt = path.join(parent, 'ENG-52-lost');
  assert.strictEqual(node(['spawn', 'ENG-52-lost', '--owner', 'a', '--persona', 'be']).status, 0);
  commitFile(wt, 'lost.txt', 'l');
  const tip = gitIn(wt, ['rev-parse', 'HEAD']);
  fs.rmSync(wt, { recursive: true, force: true });
  const r = node(['spawn', 'ENG-52-lost', '--owner', 'a', '--persona', 'be']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /restored/);
  assert.strictEqual(gitIn(wt, ['rev-parse', 'HEAD']), tip);
  assert.strictEqual(ledgerOf(repo)['ENG-52-lost'].branchCreated, true);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('a branch that existed before spawn is never deleted by teardown', () => {
  const { parent, repo } = makeRepo('theirs-');
  const node = runner(repo);
  gitIn(repo, ['branch', 'ENG-53-theirs']);
  assert.strictEqual(node(['spawn', 'ENG-53-theirs', '--owner', 'a', '--persona', 'be']).status, 0);
  const r = node(['teardown', 'ENG-53-theirs', '--owner', 'a']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept: spawn did not create it/);
  assert.notStrictEqual(gitIn(repo, ['branch', '--list', 'ENG-53-theirs']), '');
  fs.rmSync(parent, { recursive: true, force: true });
});

test('spawn copies an ignored .env once and never over the worktree\'s own; an .env git would commit is not copied', () => {
  const { parent, repo } = makeRepo('env-');
  const node = runner(repo);
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=main\n');
  // Not ignored yet: copying it would leave a secret git could commit.
  let r = node(['spawn', 'ENG-54-plain', '--owner', 'a', '--persona', 'be']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /not copied/);
  assert.ok(!fs.existsSync(path.join(parent, 'ENG-54-plain', '.env')));
  commitFile(repo, '.gitignore', '.env\n');
  const wt = path.join(parent, 'ENG-55-env');
  r = node(['spawn', 'ENG-55-env', '--owner', 'a', '--persona', 'be']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'SECRET=main\n');
  fs.writeFileSync(path.join(wt, '.env'), 'SECRET=mine\n');
  assert.strictEqual(node(['spawn', 'ENG-55-env', '--owner', 'a', '--persona', 'be']).status, 0);
  assert.strictEqual(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'SECRET=mine\n');
  // The ignored .env does not block teardown, and the main checkout's stays.
  r = node(['teardown', 'ENG-55-env', '--owner', 'a']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(repo, '.env'), 'utf8'), 'SECRET=main\n');
  fs.rmSync(parent, { recursive: true, force: true });
});

test('spawn installs from the root lockfiles once per environment, and stdout stays a list of exports', () => {
  const { parent, repo } = makeRepo('install-');
  commitFile(repo, 'package-lock.json', '{}');
  commitFile(repo, 'yarn.lock', '');
  commitFile(repo, 'uv.lock', '');
  const tools = fakeTools();
  const node = runner(repo, tools.env);
  let r = node(['spawn', 'ENG-56-deps', '--owner', 'a', '--persona', 'be']);
  assert.strictEqual(r.status, 0, r.stderr);
  for (const line of r.stdout.trim().split('\n')) assert.match(line, /^export [A-Z_0-9]+=/);
  const installs = () => tools.log().split('\n').filter(l => /^(npm|yarn|uv) /.test(l));
  // One installer per ecosystem: npm wins over yarn for JavaScript, uv for Python.
  assert.deepStrictEqual(installs().map(l => l.split(' in ')[0]), ['npm ci', 'uv sync --frozen']);
  assert.match(installs()[0], /ENG-56-deps$/);
  assert.strictEqual(node(['spawn', 'ENG-56-deps', '--owner', 'a', '--persona', 'be']).status, 0);
  assert.strictEqual(installs().length, 2, 'a resumed spawn does not install again');
  assert.strictEqual(node(['spawn', 'ENG-57-skip', '--owner', 'a', '--persona', 'be', '--no-install']).status, 0);
  assert.strictEqual(installs().length, 2);
  tools.cleanup();
  fs.rmSync(parent, { recursive: true, force: true });
});

const composeClaims = env => {
  const file = path.join(env.HOME, '.agent-brain', 'compose-claims.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
};

function scratchHome(env) {
  return { ...env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'brain-home-')) };
}

test('spawn reserves the Compose project and brings it up from the worktree; teardown brings down exactly that project', () => {
  const { parent, repo } = makeRepo('compose-');
  commitFile(repo, 'compose.yaml', 'services: {}\n');
  const tools = fakeTools({ up: true, projects: { other: { containers: [{ id: 'o1', dir: '/elsewhere' }], volumes: ['other_data'], networks: [] } } });
  const env = scratchHome(tools.env);
  const node = runner(repo, env);
  const wt = path.join(parent, 'ENG-60-stack');
  let r = node(['spawn', 'ENG-60-stack', '--owner', 'a', '--persona', 'be', '--ports', '1']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(tools.log(), /docker compose -p eng-60-stack up -d/);
  assert.deepStrictEqual(tools.state().projects['eng-60-stack'].containers, [{ id: 'c-eng-60-stack', dir: fs.realpathSync(wt) }]);
  assert.strictEqual(composeClaims(env)['eng-60-stack'].env, 'ENG-60-stack');
  r = node(['teardown', 'ENG-60-stack', '--owner', 'a']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(tools.log(), /docker compose -p eng-60-stack down --volumes --remove-orphans/);
  assert.strictEqual(tools.state().projects['eng-60-stack'], undefined);
  assert.deepStrictEqual(tools.state().projects.other.volumes, ['other_data'], 'another project is untouched');
  assert.deepStrictEqual(composeClaims(env), {});
  assert.ok(!fs.existsSync(wt));
  tools.cleanup();
  fs.rmSync(parent, { recursive: true, force: true });
});

test('two repositories with one environment name: the second cannot take the Compose name, and the first never touches the second\'s volume', () => {
  const a = makeRepo('same-a-');
  const b = makeRepo('same-b-');
  commitFile(b.repo, 'compose.yaml', 'services: {}\n');
  const tools = fakeTools({ up: true, projects: {} });
  const env = scratchHome(tools.env);
  // A has no compose file, so it reserves nothing; B reserves the name when it brings its stack up.
  assert.strictEqual(runner(a.repo, env)(['spawn', 'ENG-70-same', '--owner', 'a', '--persona', 'be']).status, 0);
  assert.strictEqual(runner(b.repo, env)(['spawn', 'ENG-70-same', '--owner', 'b', '--persona', 'be']).status, 0);
  // B stops its containers but keeps its data volume, as `docker compose down` does.
  const s = tools.state();
  s.projects['eng-70-same'].containers = [];
  tools.setState(s);
  const r = runner(a.repo, env)(['teardown', 'ENG-70-same', '--owner', 'a']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /not touched: it is reserved by ENG-70-same in /);
  assert.deepStrictEqual(tools.state().projects['eng-70-same'].volumes, ['eng-70-same_data'], 'B\'s volume survives');
  assert.doesNotMatch(tools.log(), /eng-70-same down/);
  // A third repository with a compose file is refused the reserved name before it creates anything.
  const c = makeRepo('same-c-');
  commitFile(c.repo, 'compose.yaml', 'services: {}\n');
  const rc = runner(c.repo, env)(['spawn', 'ENG-70-same', '--owner', 'c', '--persona', 'be']);
  assert.strictEqual(rc.status, 1);
  assert.match(rc.stderr, /is reserved by ENG-70-same in .*same-b-/);
  assert.ok(!fs.existsSync(path.join(c.parent, 'ENG-70-same')));
  tools.cleanup();
  for (const x of [a, b, c]) fs.rmSync(x.parent, { recursive: true, force: true });
});

test('a Compose project with containers from elsewhere, or resources spawn did not make, is neither reserved nor torn down', () => {
  const { parent, repo } = makeRepo('foreign-');
  commitFile(repo, 'compose.yaml', 'services: {}\n');
  const tools = fakeTools({ up: true, projects: {
    'eng-61-shared': { containers: [{ id: 'x1', dir: '/elsewhere' }], volumes: [], networks: [] },
    'eng-63-left': { containers: [], volumes: ['eng-63-left_data'], networks: [] },
  } });
  const env = scratchHome(tools.env);
  const node = runner(repo, env);
  let r = node(['spawn', 'ENG-61-shared', '--owner', 'a', '--persona', 'be']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /did not create/);
  assert.ok(!fs.existsSync(path.join(parent, 'ENG-61-shared')), 'nothing was created');
  r = node(['spawn', 'ENG-63-left', '--owner', 'a', '--persona', 'be']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /did not create/);
  // A foreign container that joins the reserved project after spawn stops teardown before anything is removed.
  assert.strictEqual(node(['spawn', 'ENG-62-mine', '--owner', 'a', '--persona', 'be']).status, 0);
  const s = tools.state();
  s.projects['eng-62-mine'].containers.push({ id: 'x2', dir: '/elsewhere' });
  tools.setState(s);
  r = node(['teardown', 'ENG-62-mine', '--owner', 'a']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /started outside/);
  assert.doesNotMatch(tools.log(), /eng-62-mine down/);
  assert.ok(fs.existsSync(path.join(parent, 'ENG-62-mine')));
  tools.cleanup();
  fs.rmSync(parent, { recursive: true, force: true });
});

test('a reserved project is not torn down blind: Docker off, or another daemon, refuses before anything is removed', () => {
  const { parent, repo } = makeRepo('docker-off-');
  commitFile(repo, 'compose.yaml', 'services: {}\n');
  const tools = fakeTools({ up: true, projects: {} });
  const env = scratchHome(tools.env);
  const node = runner(repo, env);
  assert.strictEqual(node(['spawn', 'ENG-65-on', '--owner', 'a', '--persona', 'be']).status, 0);
  tools.setState({ ...tools.state(), up: false });
  let r = node(['teardown', 'ENG-65-on', '--owner', 'a']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Docker is not reachable/);
  tools.setState({ ...tools.state(), up: true, daemon: 'daemon-b' });
  r = node(['teardown', 'ENG-65-on', '--owner', 'a']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /reserved on Docker daemon daemon-a, not daemon-b/);
  assert.ok(fs.existsSync(path.join(parent, 'ENG-65-on')));
  tools.cleanup();
  fs.rmSync(parent, { recursive: true, force: true });
});

test('a compose file with Docker off fails spawn after the worktree is recorded, so teardown can clean it up', () => {
  const { parent, repo } = makeRepo('compose-off-');
  commitFile(repo, 'compose.yaml', 'services: {}\n');
  const tools = fakeTools({ up: false, projects: {} });
  const node = runner(repo, tools.env);
  let r = node(['spawn', 'ENG-66-half', '--owner', 'a', '--persona', 'be']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /needs Docker/);
  assert.ok(ledgerOf(repo)['ENG-66-half']);
  assert.strictEqual(node(['spawn', 'ENG-66-half', '--owner', 'a', '--persona', 'be', '--no-compose']).status, 0);
  r = node(['teardown', 'ENG-66-half', '--owner', 'a']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(parent, 'ENG-66-half')));
  tools.cleanup();
  fs.rmSync(parent, { recursive: true, force: true });
});

test('restore and teardown drop only this environment\'s registration; an unrelated stale one survives', () => {
  const { parent, repo } = makeRepo('prune-');
  const node = runner(repo);
  const stale = path.join(parent, 'ENG-80-theirs');
  gitIn(repo, ['worktree', 'add', '-q', '-b', 'ENG-80-theirs', stale, 'main']);
  fs.rmSync(stale, { recursive: true, force: true });
  const wt = path.join(parent, 'ENG-81-mine');
  assert.strictEqual(node(['spawn', 'ENG-81-mine', '--owner', 'a', '--persona', 'be']).status, 0);
  fs.rmSync(wt, { recursive: true, force: true });
  assert.strictEqual(node(['spawn', 'ENG-81-mine', '--owner', 'a', '--persona', 'be']).status, 0);
  fs.rmSync(wt, { recursive: true, force: true });
  const r = node(['teardown', 'ENG-81-mine', '--owner', 'a']);
  assert.strictEqual(r.status, 0, r.stderr);
  const listed = gitIn(repo, ['worktree', 'list', '--porcelain']);
  const real = p => path.join(fs.realpathSync(parent), path.basename(p));
  assert.ok(listed.includes(`worktree ${real(stale)}`), 'the unrelated registration is still there');
  assert.ok(!listed.includes(`worktree ${real(wt)}`));
  fs.rmSync(parent, { recursive: true, force: true });
});

test('a worktree or branch recreated by hand at the same name is not spawn\'s: reuse and teardown refuse it, and the branch is kept', () => {
  const { parent, repo } = makeRepo('replaced-');
  const node = runner(repo);
  const wt = path.join(parent, 'ENG-82-swap');
  assert.strictEqual(node(['spawn', 'ENG-82-swap', '--owner', 'a', '--persona', 'be']).status, 0);
  // Someone removes spawn's worktree and makes their own at the same path, on the same branch.
  gitIn(repo, ['worktree', 'remove', wt]);
  gitIn(repo, ['worktree', 'add', '-q', wt, 'ENG-82-swap']);
  let r = node(['spawn', 'ENG-82-swap', '--owner', 'a', '--persona', 'be']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /not the one spawn made/);
  r = node(['teardown', 'ENG-82-swap', '--owner', 'a']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /not the one spawn made/);
  assert.ok(fs.existsSync(wt));
  gitIn(repo, ['worktree', 'remove', wt]);
  // The branch is deleted and recreated by hand from an unrelated commit: a restore does not count it as spawn's.
  gitIn(repo, ['branch', '-D', 'ENG-82-swap']);
  commitFile(repo, 'other.txt', 'o');
  gitIn(repo, ['checkout', '-q', '--orphan', 'tmp']);
  gitIn(repo, ['commit', '-q', '--allow-empty', '-m', 'unrelated']);
  gitIn(repo, ['branch', 'ENG-82-swap']);
  gitIn(repo, ['checkout', '-q', 'main']);
  r = node(['spawn', 'ENG-82-swap', '--owner', 'a', '--persona', 'be']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(ledgerOf(repo)['ENG-82-swap'].branchCreated, false);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('teardown deletes only the merged tip it checked: a branch that moved on is kept and P7 is reported open', () => {
  const { parent, repo } = makeRepo('moved-');
  commitFile(repo, 'compose.yaml', 'services: {}\n');
  const tools = fakeTools({ up: true, projects: {} });
  const env = scratchHome(tools.env);
  const node = runner(repo, env);
  const wt = path.join(parent, 'ENG-83-moved');
  assert.strictEqual(node(['spawn', 'ENG-83-moved', '--owner', 'a', '--persona', 'be']).status, 0);
  // The branch is merged; then, after teardown resolved its tip, a commit lands on it (here: while Docker is asked).
  const r = runner(repo, { ...env, FAKE_DOCKER_ON_INFO: `git -C '${wt}' -c user.name=t -c user.email=t@t commit -q --allow-empty -m late` })(['teardown', 'ENG-83-moved', '--owner', 'a']);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stdout, /kept: it moved past the merged commit/);
  assert.match(r.stderr, /P7 is not complete/);
  assert.notStrictEqual(gitIn(repo, ['branch', '--list', 'ENG-83-moved']), '', 'the unmerged commit survives');
  assert.strictEqual(ledgerOf(repo)['ENG-83-moved'], undefined, 'the rest of the cleanup finished');
  tools.cleanup();
  fs.rmSync(parent, { recursive: true, force: true });
});

test('a failed worktree add is recorded, so teardown removes what it left behind', () => {
  const { parent, repo } = makeRepo('hook-');
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const node = runner(repo);
  let r = node(['spawn', 'ENG-84-hook', '--owner', 'a', '--persona', 'be']);
  assert.strictEqual(r.status, 1);
  assert.ok(ledgerOf(repo)['ENG-84-hook'].mark, 'the registration the failed add left is marked as spawn\'s');
  fs.rmSync(path.join(repo, '.git', 'hooks', 'post-checkout'));
  r = node(['teardown', 'ENG-84-hook', '--owner', 'a']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(parent, 'ENG-84-hook')));
  assert.strictEqual(gitIn(repo, ['branch', '--list', 'ENG-84-hook']), '');
  fs.rmSync(parent, { recursive: true, force: true });
});

test('a locked worktree stops teardown before the Compose volumes go, and a failed port release keeps the entry for a retry', () => {
  const { parent, repo } = makeRepo('locked-');
  commitFile(repo, 'compose.yaml', 'services: {}\n');
  const tools = fakeTools({ up: true, projects: {} });
  const env = scratchHome(tools.env);
  const node = runner(repo, env);
  const wt = path.join(parent, 'ENG-85-lock');
  assert.strictEqual(node(['spawn', 'ENG-85-lock', '--owner', 'a', '--persona', 'be', '--ports', '1']).status, 0);
  gitIn(repo, ['worktree', 'lock', wt]);
  let r = node(['teardown', 'ENG-85-lock', '--owner', 'a']);
  assert.strictEqual(r.status, 1);
  assert.deepStrictEqual(tools.state().projects['eng-85-lock'].volumes, ['eng-85-lock_data'], 'the snapshot volume survives');
  gitIn(repo, ['worktree', 'unlock', wt]);
  // The claims file cannot be read: teardown stops before the ledger entry goes, and the next run finishes.
  const claims = path.join(env.HOME, '.agent-brain', 'port-claims.json');
  const good = fs.readFileSync(claims, 'utf8');
  fs.writeFileSync(claims, '{');
  r = node(['teardown', 'ENG-85-lock', '--owner', 'a']);
  assert.strictEqual(r.status, 1);
  assert.ok(ledgerOf(repo)['ENG-85-lock'], 'the entry stays while its claims are held');
  fs.writeFileSync(claims, good);
  r = node(['teardown', 'ENG-85-lock', '--owner', 'a']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(ledgerOf(repo)['ENG-85-lock'], undefined);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(claims, 'utf8')), {});
  tools.cleanup();
  fs.rmSync(parent, { recursive: true, force: true });
});

test('a resumed spawn keeps its ports without --ports, refuses a different count, and reinstalls a restored or changed checkout', () => {
  const { parent, repo } = makeRepo('resume-env-');
  commitFile(repo, 'package-lock.json', '{}');
  const tools = fakeTools();
  const node = runner(repo, tools.env);
  const wt = path.join(parent, 'ENG-86-keep');
  const first = node(['spawn', 'ENG-86-keep', '--owner', 'a', '--persona', 'be', '--ports', '2']);
  assert.strictEqual(first.status, 0, first.stderr);
  const ports = out => out.match(/HOST_PORT_\d+='\d+'/g);
  const again = node(['spawn', 'ENG-86-keep', '--owner', 'a', '--persona', 'be']);
  assert.strictEqual(again.status, 0, again.stderr);
  assert.deepStrictEqual(ports(again.stdout), ports(first.stdout));
  assert.strictEqual(ledgerOf(repo)['ENG-86-keep'].ports.length, 2);
  const fewer = node(['spawn', 'ENG-86-keep', '--owner', 'a', '--persona', 'be', '--ports', '1']);
  assert.strictEqual(fewer.status, 1);
  assert.match(fewer.stderr, /holds 2 host ports/);
  const installs = () => tools.log().split('\n').filter(l => l.startsWith('npm ')).length;
  assert.strictEqual(installs(), 1);
  fs.rmSync(wt, { recursive: true, force: true });
  assert.strictEqual(node(['spawn', 'ENG-86-keep', '--owner', 'a', '--persona', 'be']).status, 0);
  assert.strictEqual(installs(), 2, 'a restored checkout installs again');
  fs.writeFileSync(path.join(wt, 'package-lock.json'), '{"changed":true}');
  assert.strictEqual(node(['spawn', 'ENG-86-keep', '--owner', 'a', '--persona', 'be']).status, 0);
  assert.strictEqual(installs(), 3, 'a changed lockfile installs again');
  tools.cleanup();
  fs.rmSync(parent, { recursive: true, force: true });
});

test('the copied .env leaves out AWS credentials (DS4) and keeps everything else', () => {
  const { parent, repo } = makeRepo('aws-');
  commitFile(repo, '.gitignore', '.env\n');
  fs.writeFileSync(path.join(repo, '.env'), 'EXPO_TOKEN=e\nAWS_ACCESS_KEY_ID=AKIAEXAMPLE\nexport AWS_SECRET_ACCESS_KEY=s\nAWS_REGION=us-east-1\nAWS_PROFILE=prod\n');
  const r = runner(repo)(['spawn', 'ENG-87-aws', '--owner', 'a', '--persona', 'be']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /without AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_PROFILE/);
  assert.strictEqual(fs.readFileSync(path.join(parent, 'ENG-87-aws', '.env'), 'utf8'), 'EXPO_TOKEN=e\nAWS_REGION=us-east-1\n');
  fs.rmSync(parent, { recursive: true, force: true });
});

test('unknown flags, a missing value, and teardown --dry-run are refused before anything runs', () => {
  const { parent, repo } = makeRepo('flags-');
  const node = runner(repo);
  assert.strictEqual(node(['spawn', 'ENG-88-f', '--owner', 'a', '--persona', 'be']).status, 0);
  for (const args of [['teardown', 'ENG-88-f', '--owner', 'a', '--dry-run'], ['teardown', 'ENG-88-f', '--owner'],
    ['spawn', 'ENG-88-f', '--owner', 'a', '--persona', 'be', '--ports', 'two'], ['spawn', 'ENG-88-f', '--owner', 'a', '--persona', 'be', '--force'],
    ['teardown', 'ENG-88-f', '--owner', 'a', '--keep', 'yes']]) {
    const r = node(args);
    assert.strictEqual(r.status, 2, args.join(' '));
  }
  assert.ok(fs.existsSync(path.join(parent, 'ENG-88-f')), 'nothing was torn down');
  fs.rmSync(parent, { recursive: true, force: true });
});

test('an environment recorded by new-worktree.js is adopted with its branch and Compose project kept', () => {
  const { parent, repo } = makeRepo('legacy-env-');
  const wt = path.join(parent, 'ENG-89-old');
  gitIn(repo, ['worktree', 'add', '-q', '--no-track', '-b', 'ENG-89-old', wt, 'main']);
  fs.writeFileSync(path.join(repo, '.git', 'brain-env-ledger.json'), JSON.stringify({ 'ENG-89-old': {
    owner: 'a', branch: 'ENG-89-old', worktree: wt, ports: [], composeProject: 'eng-89-old', createdAt: '2026-11-01T00:00:00Z' } }));
  const node = runner(repo);
  assert.strictEqual(node(['spawn', 'ENG-89-old', '--owner', 'a', '--persona', 'be']).status, 0);
  const r = node(['teardown', 'ENG-89-old', '--owner', 'a']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept: spawn did not create it/);
  assert.ok(!fs.existsSync(wt));
  fs.rmSync(parent, { recursive: true, force: true });
});
