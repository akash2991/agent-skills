'use strict';

// Grid test for the Claude tracing hooks. Instead of one test per known bug,
// every reachable combination of entrypoint × stall × kill × state is run,
// and the owner's hard rules are checked in each cell:
//   I1 a hook returns within its cap (when nothing kills it);
//   I2 no process the hook started outlives it (the uploader only by its
//      own lifetime);
//   I3 no tracing state changes after the hook has ended;
//   I4 a full state still asks for delivery, so it drains on its own;
//   I5 no prompt or tool content reaches disk (metadata-only mode).
// Not covered here: attribution between concurrent sessions (each cell is
// one session); the ordering tests in the bounds suite cover that.
// Stalls are finite. A long stall outlasts every cap, so a process that
// wrongly survives is caught alive (I2). A short stall ends before the
// event's own lifetime, so a process that wrongly survives its killed hook
// resumes and writes state (I3).
// Synthetic fixtures only; delivery never reaches a real host.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const runtime = path.join(__dirname, '../runtime/langfuse');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-grid-')));
const INLINE_MS = 1000;      // the event cap for unkilled cells
const LIFETIME_MS = 2000;    // the uploader's lifetime
const STALL_MS = 3500;       // longer than every cap
const SHORT_STALL_MS = 600;  // shorter than the event's own lifetime
const GRACE_MS = 1500;       // time allowed for kills to land
const SESSION = () => crypto.randomUUID();
const CANARY = 'GRID_SYNTHETIC_CONTENT_CANARY_7f3a';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await sleep(50); }
  return check();
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Loaded into every node process a hook starts (NODE_OPTIONS is inherited):
// records each process and its role, stalls discovery in the supervised child
// when asked, and stops the uploader at once when a cell checks I3 (the
// uploader legitimately writes after the hook and is checked separately).
const tracker = path.join(root, 'tracker.cjs');
fs.writeFileSync(tracker, `'use strict';
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.GRID_PIDS;
// Worker threads load this too; only a process's main thread records it.
if (dir && require('node:worker_threads').isMainThread) {
  const argv = process.argv.slice(1);
  const role = argv.includes('--agent-brain-detached') ? (argv.includes('flush') ? 'uploader' : 'event')
    : argv.some(arg => arg === '--agent-brain-hook-child' || arg === '--claude-hook-child') ? 'child' : 'entry';
  try { fs.writeFileSync(path.join(dir, 'pid-' + process.pid), role); } catch {}
  if (role === 'uploader' && process.env.GRID_NO_UPLOADER === '1') process.exit(0);
  if (role === 'child' && process.env.GRID_STALL === 'discovery') {
    const lstat = fs.lstatSync;
    fs.lstatSync = (target, ...rest) => {
      if (String(target).endsWith('tracing.json')) {
        try { fs.writeFileSync(path.join(dir, 'stalled'), 'discovery'); } catch {}
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${STALL_MS});
      }
      return lstat(target, ...rest);
    };
  }
}
`);

// A project the installed bootstrap discovers: a git root with a metadata-only
// tracing declaration and this runtime. git is a fake that can stall the
// event's work process (it ignores SIGTERM, like a stuck native call), for
// a long or a short time.
function project(stall) {
  const dir = fs.mkdtempSync(path.join(root, 'cell-'));
  const proj = path.join(dir, 'project'), bin = path.join(dir, 'bin'), pids = path.join(dir, 'pids');
  const stateDir = path.join(dir, 'state');
  for (const sub of [path.join(proj, '.git'), path.join(proj, '.agent-brain'), path.join(proj, 'runtime'), bin, pids]) {
    fs.mkdirSync(sub, { recursive: true });
  }
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.symlinkSync(runtime, path.join(proj, 'runtime/langfuse'));
  fs.writeFileSync(path.join(proj, '.agent-brain/tracing.json'),
    JSON.stringify({ schema: 1, enabled: true, captureMode: 'metadata-only', runtime: 'runtime/langfuse' }));
  const seconds = { event: STALL_MS / 1000, 'event-short': SHORT_STALL_MS / 1000 }[stall];
  // Only the first call stalls (the runtime calls git several times), so a
  // survivor of a short stall resumes at once.
  const stallGit = `[ -e "$GRID_PIDS/stalled" ] && exit 128\ntrap '' TERM\necho git > "$GRID_PIDS/pid-$$"\ntouch "$GRID_PIDS/stalled"\nsleep ${seconds}\nexit 0`;
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n${seconds ? stallGit : 'exit 128'}\n`, { mode: 0o755 });
  return { dir, proj, bin, pids, stateDir };
}

const ENTRYPOINTS = {
  bootstrap: { supervised: true, args: () => [path.join(runtime, 'bootstrap-claude.cjs')] },
  exec: { supervised: true, args: (session, proj) => [path.join(runtime, 'exec.cjs'), '--claude-hook', session, proj] },
  direct: { supervised: false, args: () => [path.join(runtime, 'claude-hook.cjs')] }
};

function tracked(cell) {
  return fs.readdirSync(cell.pids).filter(name => name.startsWith('pid-'))
    .map(name => ({ pid: Number(name.slice(4)), role: fs.readFileSync(path.join(cell.pids, name), 'utf8') }));
}
// Every file under the state directory with its size and mtime.
function snapshot(dir) {
  const out = {};
  const walk = current => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else try { const stat = fs.statSync(file); out[path.relative(dir, file)] = `${stat.size}:${stat.mtimeMs}`; } catch { /* gone */ }
    }
  };
  walk(dir);
  return out;
}
const changes = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter(file => before[file] !== after[file]);

const cleanup = new Set();
test.after(async () => {
  for (const pid of cleanup) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(200);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Runs one cell and checks the invariants that apply to it.
async function runCell({ entry, stall = 'none', kill = 'none', state = 'normal' }) {
  const cell = project(stall);
  const session = SESSION();
  const ep = ENTRYPOINTS[entry];
  // The cap is under test only in unkilled normal cells. Elsewhere a generous
  // cap lets the event reach its stall, or deliver, even on a loaded machine.
  const inline = state === 'normal' && kill === 'none' ? INLINE_MS : 5000;
  let server;
  const env = { ...process.env, NODE_OPTIONS: `--require ${tracker}`, GRID_PIDS: cell.pids, GRID_STALL: stall,
    GRID_NO_UPLOADER: state === 'normal' ? '1' : '0', PATH: `${cell.bin}${path.delimiter}${process.env.PATH}`,
    BRAIN_TRACE_STATE_DIR: cell.stateDir, BRAIN_TRACE_HOOK_INLINE_MS: String(inline),
    BRAIN_TRACE_HOOK_LIFETIME_MS: String(LIFETIME_MS),
    LANGFUSE_PUBLIC_KEY: 'pk-lf-synthetic', LANGFUSE_SECRET_KEY: 'sk-lf-synthetic', LANGFUSE_BASE_URL: 'https://127.0.0.1:9' };
  delete env.BRAIN_TRACE_HOOK_DEADLINE;
  delete env.BRAIN_TRACING_ENABLED;
  delete env.LANGFUSE_TRACING_ENABLED;
  if (state === 'full') {
    // Fresh ownerless checkpoints fill the adapter cap: nothing can be
    // reclaimed or quarantined, so every capture is refused.
    const { ADAPTER_LIMITS } = require('../runtime/langfuse/flow.cjs');
    const adapters = path.join(cell.stateDir, 'adapters');
    fs.mkdirSync(path.join(adapters, 'pending'), { recursive: true, mode: 0o700 });
    for (let i = 0; i < ADAPTER_LIMITS.files; i++) {
      fs.writeFileSync(path.join(adapters, `${crypto.randomBytes(32).toString('hex')}.json`), JSON.stringify({ nonce: 'legacy' }), { mode: 0o600 });
    }
  }
  if (state === 'slow-network') {
    // Accepts TLS connections and never answers: every upload hangs.
    server = net.createServer(socket => { socket.on('error', () => {}); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    env.LANGFUSE_BASE_URL = `https://127.0.0.1:${server.address().port}`;
  }
  const payload = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: session, cwd: cell.proj,
    tool_use_id: `toolu_${crypto.randomBytes(4).toString('hex')}`, tool_name: 'Bash',
    tool_input: { command: CANARY }, tool_response: { stdout: CANARY }, duration_ms: 1 });
  const started = Date.now();
  const hook = spawn(process.execPath, ep.args(session, cell.proj), { env, stdio: ['pipe', 'ignore', 'ignore'] });
  cleanup.add(hook.pid);
  const exited = new Promise(resolve => hook.once('exit', () => resolve(Date.now())));
  hook.stdin.on('error', () => {});
  hook.stdin.end(payload);
  let ended, atEnd;
  try {
    if (kill !== 'none') {
      assert.ok(await until(() => fs.existsSync(path.join(cell.pids, 'stalled')), 8000), 'the stall was reached');
      await sleep(100);
      hook.kill(kill);
      ended = await exited;
      // A killed hook's processes get a moment to die; what they wrote until
      // then is the hook's. Anything later belongs to a survivor.
      await sleep(250);
      atEnd = snapshot(cell.stateDir);
    } else {
      ended = await exited;
      await sleep(250);
      atEnd = snapshot(cell.stateDir);
      // I1: the cap, plus the supervisor's second, plus slack for load.
      const bound = inline + (ep.supervised ? 1000 : 0) + GRACE_MS;
      assert.ok(ended - started <= bound, `I1: the hook took ${ended - started} ms (bound ${bound} ms)`);
    }
    for (const { pid } of tracked(cell)) cleanup.add(pid);
    // I2: everything but the uploader is gone shortly after the hook ended.
    const survivors = () => tracked(cell).filter(p => p.role !== 'uploader' && alive(p.pid));
    assert.ok(await until(() => survivors().length === 0, GRACE_MS),
      `I2: still alive after the hook ended: ${JSON.stringify(survivors())}`);
    if (state === 'normal') {
      // I3: nothing changes after the hook ended, including once every stall
      // would have ended and a wrongly surviving process resumed.
      await sleep(Math.max(0, started + STALL_MS + 1000 - Date.now()));
      const changed = changes(atEnd, snapshot(cell.stateDir));
      assert.deepEqual(changed, [], `I3: state changed after the hook ended: ${changed}`);
    } else {
      // Every event here requests delivery (I4 for a full state). The
      // uploader is spawned just before the hook returns and records itself
      // once node has booted, so wait for it.
      assert.ok(await until(() => tracked(cell).some(p => p.role === 'uploader'), 5000),
        `I4: no uploader started: ${JSON.stringify(tracked(cell))}`);
      // I2 for the uploader: it may outlive the hook, but only for its lifetime.
      const uploaders = () => tracked(cell).filter(p => p.role === 'uploader' && alive(p.pid));
      assert.ok(await until(() => uploaders().length === 0, LIFETIME_MS + GRACE_MS),
        `I2: the uploader outlived its lifetime: ${JSON.stringify(uploaders())}`);
    }
    if (state === 'full') {
      // I4: the refused capture still asked for delivery (the uploader is checked above).
      assert.ok(fs.existsSync(path.join(cell.stateDir, 'claude-flush-request')), 'I4: no delivery request');
    }
    // I5: metadata-only mode never writes prompt or tool content.
    const leaked = [];
    const scan = current => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) scan(file);
        else try { if (fs.readFileSync(file, 'utf8').includes(CANARY)) leaked.push(path.relative(cell.stateDir, file)); } catch { /* gone */ }
      }
    };
    scan(cell.stateDir);
    assert.deepEqual(leaked, [], 'I5: content reached disk');
  } finally {
    server?.close();
  }
}

// The grid. Stalls without a kill are ended by the caps; with a kill, the
// hook is killed while stalled. Discovery exists only behind a supervisor.
const cells = [];
for (const entry of Object.keys(ENTRYPOINTS)) {
  cells.push({ entry });
  for (const stall of ENTRYPOINTS[entry].supervised ? ['discovery', 'event'] : ['event']) {
    for (const kill of ['none', 'SIGTERM', 'SIGKILL']) cells.push({ entry, stall, kill });
  }
  // A short event stall ends inside the cap, so only the killed rows differ.
  for (const kill of ['SIGTERM', 'SIGKILL']) cells.push({ entry, stall: 'event-short', kill });
  cells.push({ entry, state: 'full' });
  cells.push({ entry, state: 'slow-network' });
}

test.describe('Claude hook grid: the hard rules hold in every cell', { concurrency: 4 }, () => {
  for (const cell of cells) {
    const name = [cell.entry, `stall=${cell.stall || 'none'}`, `kill=${cell.kill || 'none'}`, `state=${cell.state || 'normal'}`].join(' ');
    test(name, () => runCell(cell));
  }
});
