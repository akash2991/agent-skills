'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { plan, usedHostPorts, freePorts, shellQuote } = require('../skills/development-setup/scripts/new-worktree');

// Port claims live under the user's home: the tests use a scratch home (inherited by the scripts they spawn), never the real one.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-home-'));
process.on('exit', () => fs.rmSync(process.env.HOME, { recursive: true, force: true }));

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
  const out = execFileSync('node', [script, 'create', 'ENG-7-demo', '--owner', 'tester', '--persona', 'backend-engineer'], { cwd: repo, encoding: 'utf8' });
  assert.match(out, /export COMPOSE_PROJECT_NAME='eng-7-demo'/);
  assert.ok(fs.existsSync(path.join(parent, 'ENG-7-demo', '.git')));
  assert.strictEqual(run(['rev-parse', '--abbrev-ref', 'HEAD'], path.join(parent, 'ENG-7-demo')).trim(), 'ENG-7-demo');
  // from inside the worktree the main checkout is still found
  execFileSync('node', [script, 'remove', 'ENG-7-demo', '--owner', 'tester'], { cwd: path.join(parent, 'ENG-7-demo'), encoding: 'utf8', stdio: 'pipe' }).toString();
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
  const a = portsOf(execFileSync('node', [script, 'create', 'ENG-8-a', '--owner', 'tester', '--persona', 'web-engineer', '--ports', '2'], { cwd: repo, encoding: 'utf8' }));
  const b = portsOf(execFileSync('node', [script, 'create', 'ENG-9-b', '--owner', 'tester', '--persona', 'web-engineer', '--ports', '2'], { cwd: repo, encoding: 'utf8' }));
  assert.strictEqual(a.length, 2);
  assert.strictEqual(b.length, 2);
  assert.deepStrictEqual(a.filter(p => b.includes(p)), []);
  execFileSync('node', [script, 'remove', 'ENG-8-a', '--owner', 'tester'], { cwd: repo, encoding: 'utf8' });
  execFileSync('node', [script, 'remove', 'ENG-9-b', '--owner', 'tester'], { cwd: repo, encoding: 'utf8' });
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
  execFileSync('node', [script, 'create', 'ENG-11-again', '--owner', 'tester', '--persona', 'scout'], { cwd: repo, encoding: 'utf8' });
  const again = execFileSync('node', [script, 'create', 'ENG-11-again', '--owner', 'tester', '--persona', 'scout'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
  const script = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'new-worktree.js');
  const create = () => execFileSync('node', [script, 'create', 'ENG-13-ports', '--owner', 'tester', '--persona', 'scout', '--ports', '2'],
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

test('create needs a persona, which goes into the agent name', () => {
  const script = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'new-worktree.js');
  for (const args of [[], ['--persona'], ['--persona', 'Backend Engineer']]) {
    const r = require('child_process').spawnSync('node', [script, 'create', 'ENG-12-p', '--owner', 'tester', ...args, '--dry-run'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2, args.join(' '));
    assert.match(r.stderr, /--persona/);
  }
});

test('remove works only on what the ledger holds for this owner, with a clean worktree, and keeps the branch', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const repo = path.join(parent, 'app');
  const run = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  fs.mkdirSync(repo);
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const script = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'new-worktree.js');
  const node = (args, cwd = repo) => spawnSync('node', [script, ...args], { cwd, encoding: 'utf8' });

  assert.strictEqual(node(['create', 'ENG-21-mine', '--persona', 'backend-engineer', '--owner', 'alice']).status, 0);
  const wt = path.join(parent, 'ENG-21-mine');

  // another owner cannot remove it
  let r = node(['remove', 'ENG-21-mine', '--owner', 'bob']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /belongs to alice/);
  assert.ok(fs.existsSync(wt));

  // uncommitted work stops the removal
  fs.writeFileSync(path.join(wt, 'scratch.txt'), 'x');
  r = node(['remove', 'ENG-21-mine', '--owner', 'alice']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /uncommitted or untracked/);
  fs.rmSync(path.join(wt, 'scratch.txt'));

  // a worktree the ledger does not know about is not removed
  run(['worktree', 'add', '-q', '-b', 'ENG-22-theirs', path.join(parent, 'ENG-22-theirs'), 'main']);
  r = node(['remove', 'ENG-22-theirs', '--owner', 'alice']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /not in the ledger/);
  assert.ok(fs.existsSync(path.join(parent, 'ENG-22-theirs')));

  // the owner, with a clean worktree, removes it; the branch stays
  r = node(['remove', 'ENG-21-mine', '--owner', 'alice']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(wt));
  assert.ok(run(['branch', '--list', 'ENG-21-mine']).includes('ENG-21-mine'));
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
  const script = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'new-worktree.js');
  const node = args => spawnSync('node', [script, ...args], { cwd: repo, encoding: 'utf8' });

  assert.strictEqual(node(['create', 'ENG-30-x', '--persona', 'be', '--owner', 'alice']).status, 0);
  // another owner's create is refused, whether or not the directory exists
  let r = node(['create', 'ENG-30-x', '--persona', 'be', '--owner', 'mallory']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /belongs to alice/);
  // an owner is required
  r = node(['create', 'ENG-31-y', '--persona', 'be']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--owner <name> is required/);
  // a corrupt ledger stops every command rather than reading as empty
  fs.writeFileSync(path.join(repo, '.git', 'brain-env-ledger.json'), '{"ENG-30-x": ');
  r = node(['remove', 'ENG-30-x', '--owner', 'alice']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /does not parse/);
  assert.ok(fs.existsSync(path.join(parent, 'ENG-30-x')));
  fs.rmSync(parent, { recursive: true, force: true });
});

const SCRIPT = path.join(__dirname, '..', 'skills', 'development-setup', 'scripts', 'new-worktree.js');

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
  const createArgs = ['create', 'ENG-1-demo', '--owner', 'tester', '--persona', 'web-engineer', '--ports', '1'];
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

  assert.strictEqual(run(a, ['remove', 'ENG-1-demo', '--owner', 'tester']).status, 0);
  const after = JSON.parse(fs.readFileSync(claimsFile, 'utf8'));
  assert.deepStrictEqual(Object.values(after).map(envs => envs['ENG-1-demo']), [[Number(portB)]]);

  // ports stay exclusive across repositories: repository a's next claim cannot take b's port
  const next = run(a, ['create', 'ENG-2-other', '--owner', 'tester', '--persona', 'web-engineer', '--ports', '1']);
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

test('a remove that waits for the lifecycle lock checks ownership under it, so another owner\'s environment is not deleted', async () => {
  const { parent, repo } = makeRepo('race-');
  const node = args => spawnSync('node', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(node(['create', 'ENG-40-x', '--persona', 'be', '--owner', 'alice']).status, 0);
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
  const r = spawn(process.execPath, [SCRIPT, 'remove', 'ENG-40-x', '--owner', 'alice'], { cwd: repo, stdio: 'pipe' });
  r.stderr.on('data', d => { stderr += d; });
  let removeCode = null;
  const removeExit = new Promise(resolve => r.on('exit', code => { removeCode = code; resolve(code); }));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.strictEqual(removeCode, null, 'remove ran while the lifecycle lock was held');

  await holderExit;
  assert.strictEqual(await removeExit, 1, stderr);
  assert.match(stderr, /belongs to bob, not alice/);
  assert.ok(fs.existsSync(path.join(parent, 'ENG-40-x')), 'the environment was deleted under the other owner');
  fs.rmSync(parent, { recursive: true, force: true });
});
