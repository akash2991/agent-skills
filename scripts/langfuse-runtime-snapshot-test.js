'use strict';

// Offline process-crash tests. No production hooks, SDK setup, or live calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { fork, execFileSync } = require('node:child_process');
const test = require('node:test');
const modulePath = path.resolve(__dirname, '../runtime/langfuse/context.cjs');
const { ContextStore } = require(modulePath);
const { claimLock } = require('../runtime/langfuse/locks.cjs');
const SLOT = '.context-v1.tmp', MAX_BYTES = 8 * 1024 * 1024;
const legacyName = i => `.context-${i.toString(16).padStart(32, '0')}.tmp`;
const snapshots = dir => fs.readdirSync(dir).filter(name => name.startsWith('.context-') && name.endsWith('.tmp'));

if (process.argv[2] === '--worker') {
  const f = JSON.parse(process.argv[3]);
  let stopped = false;
  function barrier(phase) {
    if (phase !== f.phase || stopped) return;
    stopped = true;
    process.send({ barrier: phase });
    const byte = Buffer.alloc(1);
    assert.equal(fs.readSync(0, byte, 0, 1, null), 1);
  }
  try {
    const store = new ContextStore({ stateDir: f.stateDir });
    if (f.operation === 'read') {
      process.send({ started: true });
      let result;
      try { result = { run: store.getRun(f.run.runId) }; }
      catch (error) { result = { error: error.message }; }
      process.send({ done: result }, () => process.disconnect());
    } else if (f.legacy) {
      // Exact old publication protocol: the SAME exclusive lock, random slot,
      // fsync, rename. An ancient mtime is deliberately not ownership evidence.
      const lock = claimLock(f.stateDir, 'context');
      assert.equal(lock.blocked(), false);
      const temporary = path.join(f.stateDir, legacyName(1));
      const state = JSON.parse(fs.readFileSync(store.file));
      state.runs[f.run.runId].run.persona = 'builder';
      const fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); fs.closeSync(fd);
      fs.utimesSync(temporary, 1, 1);
      barrier('legacy');
      fs.renameSync(temporary, store.file);
      lock.release();
      process.send({ done: true }, () => process.disconnect());
    } else {
      const temporary = path.join(f.stateDir, SLOT);
      const open = fs.openSync, write = fs.writeFileSync, sync = fs.fsyncSync, rename = fs.renameSync;
      let snapshotFd;
      fs.openSync = (file, flags, ...rest) => {
        const fd = open(file, flags, ...rest);
        if (file === temporary && (flags & fs.constants.O_CREAT)) {
          snapshotFd = fd;
          barrier('created');
        }
        return fd;
      };
      fs.writeFileSync = (fd, data, ...rest) => {
        if (fd === snapshotFd && f.phase === 'partial') {
          const bytes = Buffer.from(data);
          fs.writeSync(fd, bytes, 0, Math.floor(bytes.length / 2));
          barrier('partial');
          fs.writeSync(fd, bytes, Math.floor(bytes.length / 2));
          return;
        }
        return write(fd, data, ...rest);
      };
      fs.fsyncSync = fd => { const result = sync(fd); if (fd === snapshotFd) barrier('fsynced'); return result; };
      fs.renameSync = (from, to) => {
        if (from === temporary) barrier('preRename');
        const result = rename(from, to);
        if (from === temporary) barrier('renamed');
        return result;
      };
      const run = store.updateRun(f.run, { persona: 'builder' });
      process.send({ done: { run } }, () => process.disconnect());
    }
  } catch (error) { console.error(error); process.exitCode = 1; process.disconnect(); }
} else {
  function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'brain-snapshot-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
    const stateDir = path.join(root, 'state');
    const store = new ContextStore({ stateDir });
    const run = store.createRun({ harness: 'pi', nativeSessionId: crypto.randomUUID(), cwd, persona: 'lead' });
    return { root, cwd, stateDir, store, run };
  }
  function worker(t, f) {
    const child = fork(__filename, ['--worker', JSON.stringify(f)], {
      env: { PATH: process.env.PATH }, stdio: ['pipe', 'ignore', 'pipe', 'ipc']
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let stderr = '', last;
    child.stderr.on('data', bytes => { stderr += bytes; });
    const first = new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject);
      child.once('exit', (code, signal) => { if (code || signal) reject(new Error(stderr || `worker exited ${code}/${signal}`)); });
    });
    child.on('message', message => { last = message; });
    const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    return { child, first, exit, async done() {
      await first;
      assert.deepEqual(await exit, { code: 0, signal: null }, stderr);
      assert.ok(last && Object.hasOwn(last, 'done'), stderr);
      return last.done;
    } };
  }
  async function killedAt(t, f, phase) {
    const publisher = worker(t, { stateDir: f.stateDir, run: f.run, phase });
    assert.deepEqual(await publisher.first, { barrier: phase });
    const stat = fs.statSync(path.join(f.stateDir, SLOT));
    assert.ok(stat.size <= MAX_BYTES);
    if (phase === 'created') assert.equal(stat.size, 0);
    else if (phase === 'partial') assert.throws(() => JSON.parse(fs.readFileSync(path.join(f.stateDir, SLOT))));
    else assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir, SLOT))).runs[f.run.runId].run.persona, 'builder');
    publisher.child.kill('SIGKILL');
    assert.deepEqual(await publisher.exit, { code: null, signal: 'SIGKILL' });
    return stat.size;
  }

  for (const phase of ['created', 'partial', 'fsynced', 'preRename']) {
    test(`snapshot ${phase}: actual SIGKILL preserves canonical and restart discards uncommitted bytes`, { timeout: 30000 }, async t => {
      const f = fixture(t), canonical = fs.readFileSync(f.store.file);
      await killedAt(t, f, phase);
      assert.deepEqual(fs.readFileSync(f.store.file), canonical);
      assert.deepEqual(snapshots(f.stateDir), [SLOT]);
      const recovered = new ContextStore({ stateDir: f.stateDir });
      assert.deepEqual(recovered.getRun(f.run.runId), f.run);
      assert.deepEqual(fs.readFileSync(f.store.file), canonical, 'orphan is never promoted');
      assert.deepEqual(snapshots(f.stateDir), []);
      assert.deepEqual(fs.readdirSync(path.join(f.stateDir, 'context-claims')), []);
    });
  }

  test('actual SIGKILL immediately after rename retains the new canonical, never rolls it back', { timeout: 30000 }, async t => {
    const f = fixture(t);
    const publisher = worker(t, { stateDir: f.stateDir, run: f.run, phase: 'renamed' });
    assert.deepEqual(await publisher.first, { barrier: 'renamed' });
    assert.deepEqual(snapshots(f.stateDir), []);
    const committed = fs.readFileSync(f.store.file);
    assert.equal(JSON.parse(committed).runs[f.run.runId].run.persona, 'builder');
    publisher.child.kill('SIGKILL');
    assert.deepEqual(await publisher.exit, { code: null, signal: 'SIGKILL' });
    assert.equal(new ContextStore({ stateDir: f.stateDir }).getRun(f.run.runId).persona, 'builder');
    assert.deepEqual(fs.readFileSync(f.store.file), committed);
  });

  test('repeated interrupted restarts never allocate a second snapshot or exceed the 8 MiB temporary bound', { timeout: 60000 }, async t => {
    const f = fixture(t), canonical = fs.readFileSync(f.store.file);
    // No successful recovery transaction between kills: each new publisher
    // itself must reclaim its predecessor before writing the SAME fixed slot.
    for (let i = 0; i < 12; i++) {
      await killedAt(t, f, ['created', 'partial', 'fsynced', 'preRename'][i % 4]);
      assert.deepEqual(fs.readFileSync(f.store.file), canonical);
      const files = snapshots(f.stateDir);
      assert.deepEqual(files, [SLOT]);
      assert.ok(files.reduce((sum, name) => sum + fs.statSync(path.join(f.stateDir, name)).size, 0) <= MAX_BYTES);
    }
    assert.deepEqual(new ContextStore({ stateDir: f.stateDir }).getRun(f.run.runId), f.run);
    assert.deepEqual(snapshots(f.stateDir), []);
  });

  test('near-capacity snapshots retain the same one-file/8 MiB crash bound', { timeout: 60000 }, async t => {
    const f = fixture(t), state = JSON.parse(fs.readFileSync(f.store.file));
    const template = { run: { ...f.run, skillsLoaded: Array.from({ length: 128 }, (_, i) => `skill-${i}-${'x'.repeat(80)}`) },
      expiresAt: Date.now() + 7 * 24 * 3600000 };
    const entryBytes = Buffer.byteLength(JSON.stringify(template)) + 40;
    const count = Math.floor((MAX_BYTES - 32768 - Buffer.byteLength(JSON.stringify(state))) / entryBytes);
    assert.ok(count < 2048);
    for (let i = 0; i < count; i++) {
      const runId = crypto.randomUUID();
      state.runs[runId] = { ...template, run: { ...template.run, runId } };
    }
    const canonical = Buffer.from(JSON.stringify(state));
    assert.ok(canonical.length > MAX_BYTES - 65536 && canonical.length <= MAX_BYTES);
    fs.writeFileSync(f.store.file, canonical);
    for (const phase of ['fsynced', 'preRename', 'fsynced', 'preRename']) {
      const bytes = await killedAt(t, f, phase);
      assert.ok(bytes > MAX_BYTES - 65536 && bytes <= MAX_BYTES);
      assert.deepEqual(snapshots(f.stateDir), [SLOT]);
      assert.deepEqual(fs.readFileSync(f.store.file), canonical);
    }
    assert.deepEqual(f.store.getRun(f.run.runId), f.run);
    assert.deepEqual(snapshots(f.stateDir), []);
  });

  for (const legacy of [false, true]) {
    test(`${legacy ? 'legacy random' : 'fixed'} snapshot: a live paused publisher is never cleaned or stolen by age`, { timeout: 30000 }, async t => {
      const f = fixture(t), canonical = fs.readFileSync(f.store.file);
      const publisher = worker(t, { stateDir: f.stateDir, run: f.run, phase: legacy ? 'legacy' : 'fsynced', legacy });
      assert.deepEqual(await publisher.first, { barrier: legacy ? 'legacy' : 'fsynced' });
      const temporary = path.join(f.stateDir, legacy ? legacyName(1) : SLOT);
      const inode = fs.statSync(temporary).ino, bytes = fs.readFileSync(temporary);
      fs.utimesSync(temporary, 1, 1);
      const contender = worker(t, { stateDir: f.stateDir, run: f.run, operation: 'read' });
      assert.deepEqual(await contender.first, { started: true });
      assert.match((await contender.done()).error, /busy|budget/i);
      assert.equal(fs.statSync(temporary).ino, inode);
      assert.deepEqual(fs.readFileSync(temporary), bytes);
      assert.deepEqual(fs.readFileSync(f.store.file), canonical);
      publisher.child.stdin.end('x');
      await publisher.done();
      assert.equal(f.store.getRun(f.run.runId).persona, 'builder', 'the paused owner can still commit');
      assert.deepEqual(snapshots(f.stateDir), []);
    });
  }

  test('safe legacy snapshots (empty, partial and complete) are discarded, including after a real legacy publisher dies', { timeout: 30000 }, async t => {
    const f = fixture(t), canonical = fs.readFileSync(f.store.file);
    const publisher = worker(t, { stateDir: f.stateDir, run: f.run, phase: 'legacy', legacy: true });
    await publisher.first;
    publisher.child.kill('SIGKILL');
    assert.deepEqual(await publisher.exit, { code: null, signal: 'SIGKILL' });
    fs.writeFileSync(path.join(f.stateDir, legacyName(2)), '', { mode: 0o600 });
    fs.writeFileSync(path.join(f.stateDir, legacyName(3)), '{', { mode: 0o600 });
    assert.deepEqual(f.store.getRun(f.run.runId), f.run);
    assert.deepEqual(fs.readFileSync(f.store.file), canonical);
    assert.deepEqual(snapshots(f.stateDir), []);
  });

  test('missing canonical never authorizes promotion of a valid orphan', t => {
    const f = fixture(t), canonical = fs.readFileSync(f.store.file);
    fs.unlinkSync(f.store.file);
    fs.writeFileSync(path.join(f.stateDir, SLOT), canonical, { mode: 0o600 });
    fs.writeFileSync(path.join(f.stateDir, legacyName(1)), canonical, { mode: 0o600 });
    assert.equal(f.store.getRun(f.run.runId), null);
    assert.deepEqual(snapshots(f.stateDir), []);
  });

  test('legacy backlog makes bounded retry progress without admitting a new snapshot or mutating canonical', t => {
    const f = fixture(t), canonical = fs.readFileSync(f.store.file);
    for (let i = 0; i < 700; i++) fs.writeFileSync(path.join(f.stateDir, legacyName(i)), '{', { mode: 0o600 });
    let pending = 700, refusals = 0;
    for (;;) {
      try { assert.deepEqual(f.store.getRun(f.run.runId), f.run); break; }
      catch (error) {
        assert.equal(error.code, 'CONTEXT_SNAPSHOT_RECOVERY_PENDING');
        assert.match(error.message, /retry.*stop all controllers.*offline/);
        const remaining = snapshots(f.stateDir).length;
        assert.ok(remaining < pending && pending - remaining <= 256);
        assert.ok(!fs.existsSync(path.join(f.stateDir, SLOT)));
        assert.deepEqual(fs.readFileSync(f.store.file), canonical);
        pending = remaining;
        assert.ok(++refusals < 5);
      }
    }
    assert.ok(refusals >= 2);
    assert.deepEqual(snapshots(f.stateDir), []);
  });

  test('unrelated root flood is explicit bounded refusal, not an unbounded scan or bypass of legacy accounting', t => {
    const f = fixture(t), canonical = fs.readFileSync(f.store.file);
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(f.stateDir, `unrelated-${i}`), '');
    let reads = 0;
    const Store = injected({ opendirSync: target => {
      const handle = fs.opendirSync(target);
      return { readSync: () => { reads++; return handle.readSync(); }, closeSync: () => handle.closeSync() };
    } });
    assert.throws(() => new Store({ stateDir: f.stateDir }).getRun(f.run.runId), { code: 'CONTEXT_SNAPSHOT_RECOVERY_PENDING' });
    assert.equal(reads, 257, '256 inspected entries plus a single EOF lookahead; no full readdir');
    assert.deepEqual(fs.readFileSync(f.store.file), canonical);
    assert.deepEqual(snapshots(f.stateDir), []);
  });

  for (const name of [SLOT, legacyName(1)]) {
    for (const unsafe of ['symlink', 'hardlink', 'directory', 'fifo', 'mode', 'size']) {
      test(`${name}: unsafe ${unsafe} is preserved with explicit offline disposition`, t => {
        const f = fixture(t), canonical = fs.readFileSync(f.store.file), file = path.join(f.stateDir, name);
        const target = path.join(f.root, 'target');
        fs.writeFileSync(target, 'unrelated', { mode: 0o600 });
        if (unsafe === 'symlink') fs.symlinkSync(target, file);
        else if (unsafe === 'hardlink') fs.linkSync(target, file);
        else if (unsafe === 'directory') fs.mkdirSync(file, { mode: 0o700 });
        else if (unsafe === 'fifo') execFileSync('mkfifo', ['-m', '600', file]);
        else {
          fs.writeFileSync(file, '{', { mode: unsafe === 'mode' ? 0o644 : 0o600 });
          if (unsafe === 'size') fs.truncateSync(file, MAX_BYTES + 1);
        }
        const before = fs.lstatSync(file);
        for (let i = 0; i < 2; i++) {
          assert.throws(() => f.store.getRun(f.run.runId), error => error.code === 'CONTEXT_SNAPSHOT_UNSAFE' && /preserved.*offline.*stopping/.test(error.message));
          assert.equal(fs.lstatSync(file).ino, before.ino);
          assert.deepEqual(fs.readFileSync(f.store.file), canonical);
          assert.equal(fs.readFileSync(target, 'utf8'), 'unrelated');
        }
      });
    }
  }

  function injected(filesystem) {
    const module = { exports: {} }, nativeRequire = createRequire(modulePath);
    vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), {
      module, process, Buffer, Atomics, SharedArrayBuffer,
      require: name => name === 'node:fs' ? { ...fs, ...filesystem } : nativeRequire(name)
    }, { filename: modulePath });
    return module.exports.ContextStore;
  }

  for (const stage of ['write', 'fsync', 'rename']) {
    test(`snapshot ${stage} failure cleans only its own slot and retains canonical`, t => {
      const f = fixture(t), file = path.join(f.stateDir, SLOT), canonical = fs.readFileSync(f.store.file);
      let snapshotFd;
      const Store = injected({
        openSync: (target, flags, ...rest) => {
          const fd = fs.openSync(target, flags, ...rest);
          if (target === file && flags & fs.constants.O_CREAT) snapshotFd = fd;
          return fd;
        },
        writeFileSync: (fd, data, ...rest) => {
          if (stage === 'write' && fd === snapshotFd) { fs.writeSync(fd, '{'); throw new Error('injected write'); }
          return fs.writeFileSync(fd, data, ...rest);
        },
        fsyncSync: fd => {
          if (stage === 'fsync' && fd === snapshotFd) throw new Error('injected fsync');
          return fs.fsyncSync(fd);
        },
        renameSync: (from, to) => {
          if (stage === 'rename' && from === file) throw new Error('injected rename');
          return fs.renameSync(from, to);
        }
      });
      assert.throws(() => new Store({ stateDir: f.stateDir })._transaction(state => {
        state.runs[f.run.runId].run.persona = 'builder';
      }), /injected/);
      assert.deepEqual(snapshots(f.stateDir), []);
      assert.deepEqual(fs.readFileSync(f.store.file), canonical);
      assert.deepEqual(f.store.getRun(f.run.runId), f.run);
    });
  }

  for (const name of [SLOT, legacyName(1)]) {
    for (const stage of ['lstat', 'fstat']) {
      test(`${name}: planted foreign uid at ${stage} is refused without privileged ownership changes`, t => {
        const f = fixture(t), file = path.join(f.stateDir, name), canonical = fs.readFileSync(f.store.file);
        fs.writeFileSync(file, '{', { mode: 0o600 });
        const actual = fs.statSync(file);
        const foreign = stat => Object.assign(Object.create(stat), { uid: process.getuid() + 1 });
        const Store = injected(stage === 'lstat' ? {
          lstatSync: target => { const stat = fs.lstatSync(target); return target === file ? foreign(stat) : stat; }
        } : {
          fstatSync: fd => { const stat = fs.fstatSync(fd); return stat.ino === actual.ino && stat.dev === actual.dev ? foreign(stat) : stat; }
        });
        assert.throws(() => new Store({ stateDir: f.stateDir }).getRun(f.run.runId), { code: 'CONTEXT_SNAPSHOT_UNSAFE' });
        assert.equal(fs.lstatSync(file).ino, actual.ino);
        assert.deepEqual(fs.readFileSync(f.store.file), canonical);
      });
    }
  }

  test('unknown snapshot names are ambiguous, preserved and explicitly refused', t => {
    const f = fixture(t), file = path.join(f.stateDir, '.context-unknown.tmp');
    fs.writeFileSync(file, '{', { mode: 0o600 });
    assert.throws(() => f.store.getRun(f.run.runId), { code: 'CONTEXT_SNAPSHOT_UNSAFE' });
    assert.equal(fs.readFileSync(file, 'utf8'), '{');
  });

  test('snapshot cleanup checks inode identity and never unlinks a replacement', t => {
    const f = fixture(t), file = path.join(f.stateDir, SLOT), saved = path.join(f.root, 'saved');
    const canonical = fs.readFileSync(f.store.file);
    fs.writeFileSync(file, '{', { mode: 0o600 });
    let reads = 0;
    const Store = injected({ openSync: (target, flags, ...rest) => {
      if (target === file && ++reads === 2) {
        fs.renameSync(file, saved);
        fs.writeFileSync(file, 'replacement', { mode: 0o600 });
      }
      return fs.openSync(target, flags, ...rest);
    } });
    assert.throws(() => new Store({ stateDir: f.stateDir }).getRun(f.run.runId), { code: 'CONTEXT_SNAPSHOT_UNSAFE' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'replacement');
    assert.equal(fs.readFileSync(saved, 'utf8'), '{');
    assert.deepEqual(fs.readFileSync(f.store.file), canonical);
  });

  test('TTL pruning also removes old fixed and random snapshot metadata, regardless of their mtime', t => {
    const f = fixture(t), canonical = fs.readFileSync(f.store.file);
    for (const name of [SLOT, legacyName(1), legacyName(2)]) {
      const file = path.join(f.stateDir, name);
      fs.writeFileSync(file, canonical, { mode: 0o600 });
      fs.utimesSync(file, name === SLOT ? 1 : new Date(), new Date());
    }
    const later = new ContextStore({ stateDir: f.stateDir, now: () => Date.now() + 30 * 24 * 3600000 });
    assert.equal(later.getRun(f.run.runId), null);
    assert.deepEqual(snapshots(f.stateDir), []);
    const state = JSON.parse(fs.readFileSync(f.store.file));
    for (const kind of ['runs', 'sessions', 'launches', 'pending']) assert.deepEqual(state[kind], {});
    assert.ok(!fs.readFileSync(f.store.file, 'utf8').includes(f.run.runId));
  });
}
