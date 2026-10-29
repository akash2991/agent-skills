'use strict';

// Actual FIFOs, no writer, and deterministic lstat/open races in bounded child
// processes. A timeout is a failed test, never an expected way to reject a FIFO.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const { ContextStore } = require('../runtime/langfuse/context.cjs');
const { reconcileTranscript } = require('../runtime/langfuse/claude.cjs');
const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const stateBytes = JSON.stringify({ version: 1, sessions: {}, runs: {}, launches: {}, pending: {} });
const rowBytes = JSON.stringify({ type: 'assistant', timestamp: 1800000000000,
  message: { id: 'msg-reader', model: 'claude-sonnet-4-5', usage: { input_tokens: 1 } } }) + '\n';
const fingerprint = file => {
  const stat = fs.lstatSync(file);
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid,
    nlink: stat.nlink, size: stat.size, mtimeMs: stat.mtimeMs,
    ...(stat.isSymbolicLink() ? { target: fs.readlinkSync(file) } : {}) };
};
const foreignOwner = stat => Object.assign(Object.create(stat), { uid: process.getuid() + 1 });

function probe(root, reader, scenario) {
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const store = new ContextStore({ stateDir });
  const file = reader === 'context' ? store.file : path.join(root, 'transcript.jsonl');
  const original = path.join(root, 'original');
  const other = path.join(root, 'other');
  const bytes = reader === 'context' ? stateBytes : rowBytes;
  const regular = target => fs.writeFileSync(target, bytes, { mode: 0o600 });
  const fifo = target => execFileSync('mkfifo', ['-m', '600', target], { stdio: 'ignore' });
  regular(file);
  let unsafe = fingerprint(file);
  const makeUnsafe = kind => {
    if (['fifo', 'symlink', 'directory', 'regular', 'missing'].includes(kind)) {
      fs.renameSync(file, original);
      if (kind === 'fifo') fifo(file);
      if (kind === 'symlink') { regular(other); fs.symlinkSync(other, file); }
      if (kind === 'directory') fs.mkdirSync(file, { mode: 0o700 });
      if (kind === 'regular') regular(file);
    } else if (kind === 'hardlink') fs.linkSync(file, other);
    else if (kind === 'mode') fs.chmodSync(file, 0o644);
    else if (kind === 'oversize') fs.truncateSync(file, 8 * 1024 * 1024 + 1);
    unsafe = kind === 'missing' ? undefined : fingerprint(file);
  };
  const [phase, kind] = scenario.split(':');
  if (phase === 'pre' && kind !== 'owner') makeUnsafe(kind);
  const raw = { lstat: fs.lstatSync, open: fs.openSync, fstat: fs.fstatSync,
    readFile: fs.readFileSync, read: fs.readSync, close: fs.closeSync };
  let inspected = false, opened = false, inspectedBeforeOpen = false, openFlags, fd, closed = false, reads = 0;
  fs.lstatSync = function (target, ...args) {
    const stat = raw.lstat.call(fs, target, ...args);
    if (target === file) {
      inspected = true;
      if (phase === 'pre' && kind === 'owner') return foreignOwner(stat);
    }
    return stat;
  };
  fs.openSync = function (target, flags, ...args) {
    const targetRead = target === file && !opened;
    if (targetRead) {
      opened = true;
      inspectedBeforeOpen = inspected;
      openFlags = flags;
      if (phase === 'swap') makeUnsafe(kind);
    }
    const result = raw.open.call(fs, target, flags, ...args);
    if (targetRead) fd = result;
    return result;
  };
  fs.fstatSync = function (target, ...args) {
    if (target === fd && phase === 'fd' && kind !== 'owner') makeUnsafe(kind);
    const stat = raw.fstat.call(fs, target, ...args);
    return target === fd && phase === 'fd' && kind === 'owner' ? foreignOwner(stat) : stat;
  };
  fs.readFileSync = function (target, ...args) {
    if (target === file || target === fd) reads++;
    return raw.readFile.call(fs, target, ...args);
  };
  fs.readSync = function (target, ...args) {
    if (target === fd) reads++;
    return raw.read.call(fs, target, ...args);
  };
  fs.closeSync = function (target, ...args) {
    if (target === fd) closed = true;
    return raw.close.call(fs, target, ...args);
  };
  const cursor = { inode: -1, offset: 0 };
  const states = new Map([['cursor', cursor]]);
  let generations = 0;
  const flow = { id: () => 'reader', readState: () => cursor,
    writeState: (key, value) => states.set(key, value), update: run => run,
    submit: (_run, records) => { generations += records.length; } };
  const run = { nativeSessionId: SESSION };
  let refused;
  try {
    if (reader === 'context') assert.throws(() => store.getSession('pi', SESSION),
      /Unsafe tracing state file|ELOOP|ENOENT/, 'unsafe canonical state must refuse');
    else reconcileTranscript(flow, run, file);
    refused = true;
  } finally {
    fs.lstatSync = raw.lstat;
    fs.openSync = raw.open;
    fs.fstatSync = raw.fstat;
    fs.readFileSync = raw.readFile;
    fs.readSync = raw.read;
    fs.closeSync = raw.close;
  }
  assert.equal(refused, true);
  assert.equal(reads, 0, 'no unsafe bytes may be read, including from a FIFO with no writer');
  if (fd !== undefined) assert.equal(closed, true, 'refused descriptor must be closed');
  if (phase === 'pre') assert.equal(opened, false, 'unsafe initial path must not be opened');
  else {
    assert.equal(opened, true, 'race must reach the descriptor boundary');
    assert.equal(inspectedBeforeOpen, true, 'path must be inspected before opening');
    assert.ok(openFlags & fs.constants.O_NOFOLLOW, 'open must not follow symlinks');
    assert.ok(openFlags & fs.constants.O_NONBLOCK, 'replacement FIFOs must not block');
  }
  if (unsafe) assert.deepEqual(fingerprint(file), unsafe, 'unsafe artifact must remain unchanged');
  if (fs.existsSync(original)) assert.equal(fs.readFileSync(original, 'utf8'), bytes, 'original canonical bytes preserved');
  if (kind === 'symlink') assert.equal(fs.readFileSync(other, 'utf8'), bytes, 'symlink target unchanged');
  if (kind === 'missing') assert.equal(fs.existsSync(file), false, 'disappearance must not publish empty state');
  assert.equal(generations, 0);
  assert.ok([...states.values()].every(value => value === cursor), 'unavailable transcript must not advance cursor');
  if (reader === 'context') {
    assert.deepEqual(fs.readdirSync(path.join(stateDir, 'context-claims')), [], 'refusal must release the context lock');
    assert.ok(!fs.existsSync(path.join(stateDir, '.context-v1.tmp')), 'refusal must not publish a snapshot');
  }
  // Test-owned cleanup only, after preservation assertions. The runtime never
  // removes these unsafe artifacts. A subsequent normal read must recover.
  fs.rmSync(file, { recursive: true, force: true });
  regular(file);
  if (reader === 'context') assert.equal(store.getSession('pi', SESSION), null);
  else {
    reconcileTranscript(flow, run, file);
    assert.equal(generations, 1);
    assert.ok([...states.values()].some(value => value.offset === Buffer.byteLength(bytes)));
  }
  process.stdout.write('returned-refused-preserved-recovered\n');
}

if (process.argv[2] === '--probe') {
  probe(...process.argv.slice(3));
} else {
  for (const reader of ['context', 'transcript']) {
    const scenarios = ['pre:fifo', 'swap:fifo', 'swap:regular', 'pre:symlink', 'swap:symlink',
      'pre:directory', 'swap:directory', 'swap:missing'];
    if (reader === 'context') scenarios.push('pre:hardlink', 'pre:mode', 'pre:owner', 'pre:oversize',
      'fd:hardlink', 'fd:mode', 'fd:owner', 'fd:oversize');
    for (const scenario of scenarios) test(`${reader}: ${scenario} refuses without blocking, preserves artifacts and recovers`, t => {
      const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'brain-reader-'));
      fs.chmodSync(root, 0o700);
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const child = spawnSync(process.execPath, [__filename, '--probe', root, reader, scenario], {
        timeout: 4000, killSignal: 'SIGKILL', encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      assert.ifError(child.error); // ETIMEDOUT is always a failure; no FIFO writer is started.
      assert.equal(child.signal, null);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, 'returned-refused-preserved-recovered\n');
    });
  }

  test('native transcript retains its regular-file mode/link/size contract and bounded incremental scan', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'brain-reader-contract-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(file, rowBytes, { mode: 0o644 });
    fs.linkSync(file, path.join(root, 'alias'));
    fs.truncateSync(file, 32 * 1024 * 1024 + 1);
    let next, generations = 0;
    const flow = { id: () => 'reader', readState: () => undefined, update: run => run,
      writeState: (_key, value) => { if (value.offset !== undefined) next = value; },
      submit: (_run, records) => { generations += records.length; } };
    reconcileTranscript(flow, { nativeSessionId: SESSION }, file);
    assert.equal(generations, 1, 'native transcripts are not subject to private canonical-state mode/link limits');
    assert.equal(next.offset, 32 * 1024 * 1024, 'large native transcripts remain incrementally bounded');
    assert.equal(next.discarding, true);
    assert.equal(fs.statSync(file).size, 32 * 1024 * 1024 + 1);
  });
}
