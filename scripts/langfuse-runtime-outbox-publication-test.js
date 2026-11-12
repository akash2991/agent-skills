'use strict';

// Real offline process-crash probes. No installs, native hooks or credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { fork, execFileSync } = require('node:child_process');
const modulePath = path.resolve(__dirname, '../runtime/langfuse/export.cjs');
const api = require(modulePath);
const { sanitizeObservation, LIMITS } = require('../runtime/langfuse/privacy.cjs');
const { createFlow, ADAPTER_LIMITS } = require('../runtime/langfuse/flow.cjs');
const { claimLock } = require('../runtime/langfuse/locks.cjs');
const record = (overrides = {}) => ({ id: '0123456789abcdef', traceId: 'a'.repeat(32), parentId: null,
  sessionId: 'synthetic-session', nativeSessionId: '550e8400-e29b-41d4-a716-446655440000',
  type: 'GENERATION', startTime: 1700000000000, endTime: 1700000001000,
  model: 'synthetic-model', outcome: 'completed', context: { harness: 'pi' }, ...overrides });
const finalName = version => `${record().traceId}-${record().id}-${version}.json`;
const truncatedV2 = (version, revision) => {
  const bytes = JSON.stringify({ schema: 2, version, revision, record: sanitizeObservation(record()) });
  return bytes.slice(0, bytes.indexOf('"model":"') + 12);
};
const finalNames = dir => fs.readdirSync(path.join(dir, 'outbox')).filter(name => name.endsWith('.json'));
const phases = ['created', 'partial', 'fsynced', 'preRename', 'renamed'];

if (process.argv[2] === '--worker') {
  const f = JSON.parse(process.argv[3]);
  function barrier(phase) {
    if (phase !== f.phase) return;
    process.send({ barrier: phase });
    assert.equal(fs.readSync(0, Buffer.alloc(1), 0, 1, null), 1);
  }
  try {
    if (f.operation === 'legacy') {
      const lock = claimLock(f.stateDir, 'queue'); assert.equal(lock.blocked(), false);
      const file = path.join(f.stateDir, 'outbox', finalName('b'.repeat(32)));
      const bytes = Buffer.from(JSON.stringify({ schema: 2, version: 'b'.repeat(32), revision: f.revision,
        record: sanitizeObservation(record()) }));
      const fd = fs.openSync(file, 'wx', 0o600); barrier('created');
      // Keep a complete identity/revision prefix so this historical truncation
      // has evidence beyond a parse error; early cuts are tested as ambiguous.
      const half = bytes.indexOf('"model":"') + 12;
      fs.writeSync(fd, bytes, 0, half); barrier('partial');
      fs.writeSync(fd, bytes, half); fs.fsyncSync(fd); barrier('fsynced');
      fs.closeSync(fd); lock.release();
    } else {
      const slot = f.operation === 'checkpoint' ? path.join(f.stateDir, 'adapters', '.checkpoint-v1.tmp')
        : f.operation === 'revision' ? path.join(f.stateDir, '.revisions-v1.tmp')
          : path.join(f.stateDir, 'outbox', '.outbox-v1.tmp');
      const open = fs.openSync, write = fs.writeFileSync, sync = fs.fsyncSync, rename = fs.renameSync;
      let targetFd;
      fs.openSync = (file, flags, ...rest) => {
        const fd = open(file, flags, ...rest);
        if (file === slot && (flags & fs.constants.O_CREAT)) { targetFd = fd; barrier('created'); }
        return fd;
      };
      fs.writeFileSync = (fd, data, ...rest) => {
        if (fd === targetFd && f.phase === 'partial') {
          const bytes = Buffer.from(data), half = Math.floor(bytes.length / 2);
          fs.writeSync(fd, bytes, 0, half); barrier('partial');
          fs.writeSync(fd, bytes, half); return;
        }
        return write(fd, data, ...rest);
      };
      fs.fsyncSync = fd => { const result = sync(fd); if (fd === targetFd) barrier('fsynced'); return result; };
      fs.renameSync = (from, to) => {
        if (from === slot) barrier('preRename');
        const result = rename(from, to);
        if (from === slot) barrier('renamed');
        return result;
      };
      const result = f.operation === 'checkpoint'
        ? createFlow({ stateDir: f.stateDir, env: {} }).writeState('crash-checkpoint', { completedAt: 2 })
        : f.operation === 'revision' ? api.reserveRevisions([record()], { stateDir: f.stateDir })
          : api.queueObservation(record(), { stateDir: f.stateDir, revision: f.revision });
      if (f.operation === 'outbox') assert.equal(result.queued, true);
    }
    process.send({ done: true }, () => process.disconnect());
  } catch (error) { console.error(error); process.exitCode = 1; process.disconnect(); }
} else {
  const dependencyRoot = require('./lib/langfuse-test-dependencies.js').testDependencyRoot();
  function fixture(t) {
    const stateDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'brain-outbox-publication-'));
    fs.chmodSync(stateDir, 0o700);
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const [revision] = api.reserveRevisions([record()], { stateDir });
    return { stateDir, revision };
  }
  function worker(t, f) {
    const child = fork(__filename, ['--worker', JSON.stringify(f)], {
      env: { PATH: process.env.PATH }, stdio: ['pipe', 'ignore', 'pipe', 'ipc']
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes; });
    const first = new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject);
      child.once('exit', (code, signal) => { if (code || signal) reject(new Error(stderr || `${code}/${signal}`)); });
    });
    const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    return { child, first, exit };
  }
  async function killAt(t, f, phase, operation = 'outbox') {
    const w = worker(t, { ...f, phase, operation });
    assert.deepEqual(await w.first, { barrier: phase });
    if (operation === 'outbox' && phase !== 'renamed') {
      assert.deepEqual(finalNames(f.stateDir), f.expectedFinals || []);
      const bytes = fs.readFileSync(path.join(f.stateDir, 'outbox', '.outbox-v1.tmp'));
      if (phase === 'created') assert.equal(bytes.length, 0);
      else if (phase === 'partial') { assert.ok(bytes.length > 0); assert.throws(() => JSON.parse(bytes)); }
      else assert.equal(JSON.parse(bytes).record.id, record().id);
    }
    w.child.kill('SIGKILL');
    assert.deepEqual(await w.exit, { code: null, signal: 'SIGKILL' });
  }
  const flush = (f, capture = [], code = 0) => api.flushOutbox({ stateDir: f.stateDir, dependencyRoot,
    exporterFactory: () => ({ export(spans, cb) { capture.push(...spans); cb({ code }); }, async shutdown() {} }) });
  const injected = (overrides, file = modulePath) => {
    const localRequire = createRequire(file), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      require: id => id === 'node:fs' ? { ...fs, ...overrides } : localRequire(id), module, exports: module.exports,
      process, Buffer, URL, AbortController, SharedArrayBuffer, Int32Array, Atomics, setTimeout, clearTimeout
    }, { filename: file });
    return module.exports;
  };

  for (const phase of phases) test(`outbox ${phase}: actual SIGKILL exposes only complete committed records`, { timeout: 30000 }, async t => {
    const f = fixture(t), ledger = fs.readFileSync(path.join(f.stateDir, 'revisions-v1.json'));
    await killAt(t, f, phase);
    const seen = [], result = await flush(f, seen, 1);
    assert.equal(result.accepted, 0);
    assert.equal(result.recovered, phase === 'renamed' ? 0 : 1);
    assert.equal(result.attempted, phase === 'renamed' ? 1 : 0);
    assert.equal(finalNames(f.stateDir).length, phase === 'renamed' ? 1 : 0);
    assert.equal(fs.existsSync(path.join(f.stateDir, 'outbox', '.outbox-v1.tmp')), false);
    if (phase !== 'renamed') assert.deepEqual(fs.readFileSync(path.join(f.stateDir, 'revisions-v1.json')), ledger);
    else { assert.equal(seen.length, 1); assert.equal((await flush(f)).accepted, 1); }
    assert.equal(api.queueObservation(record(), f).queued, true);
    assert.equal((await flush(f)).accepted, 1);
  });

  for (const phase of phases) test(`revision ${phase}: SIGKILL never promotes or rolls back ledger floors`, { timeout: 30000 }, async t => {
    const f = fixture(t);
    assert.equal(api.queueObservation(record(), f).queued, true);
    await flush(f, [], 1); // Durable pre-send floor, deliberately no ACK.
    const ledger = path.join(f.stateDir, 'revisions-v1.json'), before = fs.readFileSync(ledger);
    await killAt(t, f, phase, 'revision');
    api.recoverOutbox(f);
    const after = fs.readFileSync(ledger);
    if (phase !== 'renamed') assert.deepEqual(after, before);
    else {
      const old = Object.values(JSON.parse(before).entries)[0], head = Object.values(JSON.parse(after).entries)[0];
      assert.equal(head.allocated, old.allocated + 1); assert.deepEqual(head.floor, old.floor);
    }
    assert.equal(fs.existsSync(path.join(f.stateDir, '.revisions-v1.tmp')), false);
    assert.equal(finalNames(f.stateDir).length, 1, 'unACKed canonical record survives ledger recovery');
    assert.equal((await flush(f)).accepted, 1);
  });

  for (const phase of phases) test(`checkpoint ${phase}: SIGKILL has one bounded slot and preserves committed checkpoint`, { timeout: 30000 }, async t => {
    const f = fixture(t), flow = createFlow({ stateDir: f.stateDir, env: {} });
    flow.writeState('crash-checkpoint', { completedAt: 1 });
    await killAt(t, f, phase, 'checkpoint');
    const restart = createFlow({ stateDir: f.stateDir, env: {} });
    restart.writeState('after-crash', { completedAt: 3 });
    assert.deepEqual(restart.readState('crash-checkpoint'), { completedAt: phase === 'renamed' ? 2 : 1 });
    assert.equal(fs.existsSync(path.join(f.stateDir, 'adapters', '.checkpoint-v1.tmp')), false);
  });

  test('repeated crashes at full record admission recover before capacity checks, including offline flush', { timeout: 60000 }, async t => {
    const f = fixture(t);
    // Fill 255 distinct committed records cheaply with legitimate ledger tickets.
    const records = Array.from({ length: api.OUTBOX_LIMITS.records - 1 }, (_, i) => record({ id: (i + 2).toString(16).padStart(16, '0') }));
    const revisions = api.reserveRevisions(records, f);
    records.forEach((r, i) => assert.equal(api.queueObservation(r, { ...f, revision: revisions[i] }).queued, true));
    f.expectedFinals = finalNames(f.stateDir);
    for (let i = 0; i < 12; i++) {
      await killAt(t, f, phases[i % 4]);
      const names = fs.readdirSync(path.join(f.stateDir, 'outbox'));
      assert.equal(names.length, api.OUTBOX_LIMITS.records);
      assert.ok(names.reduce((sum, name) => sum + fs.statSync(path.join(f.stateDir, 'outbox', name)).size, 0) <= api.OUTBOX_LIMITS.bytes);
    }
    const offline = await api.flushOutbox({ ...f, credentials: null });
    assert.equal(offline.status, 'offline'); assert.equal(offline.recovered, 1); assert.equal(offline.accepted, 0);
    assert.equal(api.queueObservation(record(), f).queued, true);
    assert.equal(finalNames(f.stateDir).length, api.OUTBOX_LIMITS.records);
    assert.equal(api.queueObservation(record(), f).reason, 'capacity');
    assert.equal((await flush(f)).accepted, api.OUTBOX_LIMITS.flush);
  });

  test('repeated ledger and checkpoint crashes reuse fixed slots without promotion', { timeout: 60000 }, async t => {
    const f = fixture(t), ledger = path.join(f.stateDir, 'revisions-v1.json'), before = fs.readFileSync(ledger);
    const flow = createFlow({ stateDir: f.stateDir, env: {} }); flow.writeState('crash-checkpoint', { completedAt: 1 });
    for (let i = 0; i < 8; i++) {
      await killAt(t, f, phases[i % 4], 'revision');
      assert.deepEqual(fs.readFileSync(ledger), before);
      await killAt(t, f, phases[i % 4], 'checkpoint');
      assert.equal(fs.readdirSync(path.join(f.stateDir, 'adapters')).filter(name => name.endsWith('.tmp')).length, 1);
      assert.deepEqual(flow.readState('crash-checkpoint'), { completedAt: 1 });
    }
    api.recoverOutbox(f); flow.writeState('recovered', { completedAt: 3 });
    assert.equal(fs.existsSync(path.join(f.stateDir, '.revisions-v1.tmp')), false);
    assert.equal(fs.existsSync(path.join(f.stateDir, 'adapters', '.checkpoint-v1.tmp')), false);
  });

  for (const phase of ['created', 'partial', 'fsynced']) test(`legacy final ${phase}: actual SIGKILL distinguishes interrupted bytes from valid unACKed data`, { timeout: 30000 }, async t => {
    const f = fixture(t); await killAt(t, f, phase, 'legacy');
    const file = path.join(f.stateDir, 'outbox', finalName('b'.repeat(32)));
    const result = await api.flushOutbox({ ...f, credentials: null });
    assert.equal(result.recovered ?? 0, phase === 'partial' ? 1 : 0);
    assert.equal(fs.existsSync(file), phase !== 'partial');
    assert.equal(result.accepted, 0);
    if (phase === 'created') {
      assert.equal(result.status, 'legacy_outbox_inspection_required');
      assert.equal(fs.readFileSync(file).length, 0, 'ambiguous historical empty final is not deletion authority');
    } else if (phase === 'fsynced') assert.equal((await flush(f)).accepted, 1);
    else assert.equal(api.queueObservation(record(), f).queued, true);
  });

  test('a paused live publisher excludes queue and recovery, regardless of ancient mtime', { timeout: 30000 }, async t => {
    const f = fixture(t), w = worker(t, { ...f, phase: 'partial', operation: 'outbox' });
    assert.deepEqual(await w.first, { barrier: 'partial' });
    const slot = path.join(f.stateDir, 'outbox', '.outbox-v1.tmp'), before = fs.readFileSync(slot);
    fs.utimesSync(slot, 1, 1); w.child.kill('SIGSTOP');
    assert.equal(api.queueObservation(record(), f).reason, 'busy');
    assert.equal((await api.flushOutbox({ ...f, credentials: null, timeoutMs: 150 })).accepted, 0);
    assert.throws(() => api.recoverOutbox({ ...f, deadlineAt: Date.now() + 150 }));
    assert.deepEqual(fs.readFileSync(slot), before);
    w.child.kill('SIGKILL'); assert.deepEqual(await w.exit, { code: null, signal: 'SIGKILL' });
    assert.equal(api.recoverOutbox(f).recovered, 1);
  });

  for (const kind of ['mode', 'uid', 'fd-uid', 'symlink', 'hardlink', 'fifo', 'directory', 'oversize', 'replacement']) {
    for (const target of ['outbox', 'revision', 'legacy']) test(`${target} recovery preserves unsafe ${kind} artifacts`, async t => {
      const f = fixture(t), file = target === 'revision' ? path.join(f.stateDir, '.revisions-v1.tmp')
        : path.join(f.stateDir, 'outbox', target === 'legacy' ? finalName('c'.repeat(32)) : '.outbox-v1.tmp');
      const other = path.join(f.stateDir, 'outside'); fs.writeFileSync(other, 'preserve', { mode: 0o600 });
      if (kind === 'symlink') fs.symlinkSync(other, file);
      else if (kind === 'hardlink') fs.linkSync(other, file);
      else if (kind === 'fifo') execFileSync('mkfifo', ['-m', '600', file]);
      else if (kind === 'directory') fs.mkdirSync(file, { mode: 0o700 });
      else {
        fs.writeFileSync(file, '{', { mode: kind === 'mode' ? 0o644 : 0o600 });
        if (kind === 'oversize') fs.truncateSync(file, (target === 'revision' ? 4 * 1024 * 1024 : LIMITS.recordBytes + 512) + 1);
      }
      let custom = api;
      if (kind === 'uid') custom = injected({ lstatSync(p, ...rest) {
        const stat = fs.lstatSync(p, ...rest); if (p === file) stat.uid = process.getuid() + 1; return stat;
      } });
      if (kind === 'fd-uid') {
        const targetStat = fs.lstatSync(file);
        custom = injected({ fstatSync(fd, ...rest) {
          const stat = fs.fstatSync(fd, ...rest);
          if (stat.dev === targetStat.dev && stat.ino === targetStat.ino) stat.uid = process.getuid() + 1;
          return stat;
        } });
      }
      if (kind === 'replacement') {
        let replaced = false;
        custom = injected({ openSync(p, ...rest) {
          if (p === file && !replaced) { replaced = true; fs.renameSync(file, `${file}.saved`); fs.writeFileSync(file, 'replacement', { mode: 0o600 }); }
          return fs.openSync(p, ...rest);
        } });
      }
      const result = custom.queueObservation(record(), f);
      assert.equal(result.queued, false); assert.equal(result.reason, 'outbox_inspection_required');
      assert.ok(fs.lstatSync(file)); assert.equal(fs.readFileSync(other, 'utf8'), 'preserve');
      if (kind === 'replacement') assert.equal(fs.readFileSync(file, 'utf8'), 'replacement');
    });
  }

  test('parseable legacy, unsupported, noncanonical and unticketed records remain byte-exact and invalid; unknown names refuse', async t => {
    for (const variant of ['schema1', 'unsupported', 'unticketed', 'noncanonical', 'null']) {
      const f = fixture(t); assert.equal(api.queueObservation(record(), f).queued, true);
      const file = path.join(f.stateDir, 'outbox', finalNames(f.stateDir)[0]);
      const envelope = JSON.parse(fs.readFileSync(file));
      if (variant === 'schema1') { envelope.schema = 1; delete envelope.revision; }
      if (variant === 'unsupported') envelope.schema = 3;
      if (variant === 'unticketed') envelope.revision = 99;
      const bytes = variant === 'null' ? 'null' : JSON.stringify(envelope, null, variant === 'noncanonical' ? 2 : 0);
      fs.writeFileSync(file, bytes);
      const before = fs.readFileSync(path.join(f.stateDir, 'revisions-v1.json'));
      const result = await flush(f);
      assert.equal(result.status, 'invalid_outbox'); assert.equal(result.invalid, 1); assert.equal(result.accepted, 0);
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
      assert.deepEqual(fs.readFileSync(path.join(f.stateDir, 'revisions-v1.json')), before);
    }
    const f = fixture(t), file = path.join(f.stateDir, 'outbox', 'unknown.tmp');
    fs.writeFileSync(file, '{', { mode: 0o600 });
    assert.equal((await flush(f)).status, 'outbox_inspection_required');
    assert.equal(fs.readFileSync(file, 'utf8'), '{');
  });

  test('syntax errors alone never authorize historical deletion: ambiguity, mismatches and unallocated tickets remain intact', async t => {
    const version = 'c'.repeat(32);
    const variants = ['', '{', 'arbitrary malformed data', '{"schema":1,',
      truncatedV2('d'.repeat(32), 1), truncatedV2(version, 999),
      truncatedV2(version, 1).replace(record().id, 'f'.repeat(16)),
      truncatedV2(version, 1).replace('"type":"GENERATION"', '"type":"UNSUPPORTED"'),
      truncatedV2(version, 1).replace('"model":"', '"prompt":"'),
      truncatedV2(version, 1).replace('"startTime":1700000000000', '"startTime":0'),
      truncatedV2(version, 1) + '\\q"',
      truncatedV2(version, 1).replace('"revision":1', '"revision":0')];
    for (const bytes of variants) {
      const f = fixture(t), file = path.join(f.stateDir, 'outbox', finalName(version));
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      const ledger = fs.readFileSync(path.join(f.stateDir, 'revisions-v1.json'));
      const result = await api.flushOutbox({ ...f, credentials: null });
      assert.equal(result.status, 'legacy_outbox_inspection_required');
      assert.equal(result.accepted, 0);
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
      assert.deepEqual(fs.readFileSync(path.join(f.stateDir, 'revisions-v1.json')), ledger);
      assert.equal(api.queueObservation(record(), f).reason, 'legacy_outbox_inspection_required');
    }
  });

  test('legacy identity literals must pass projection before revision lookup or recovery', async t => {
    const f = fixture(t), version = 'c'.repeat(32), file = path.join(f.stateDir, 'outbox', finalName(version));
    const bytes = truncatedV2(version, f.revision);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const { configurePrivacy } = require('../runtime/langfuse/privacy.cjs');
    configurePrivacy({ sensitiveLiterals: [record().nativeSessionId] });
    try {
      const result = await api.flushOutbox({ ...f, credentials: null });
      assert.equal(result.status, 'legacy_outbox_inspection_required');
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    } finally { configurePrivacy(); }
  });

  test('missing/corrupt canonical ledger is never silently recreated from orphan or queued data', async t => {
    for (const missing of [true, false]) {
      const f = fixture(t); assert.equal(api.queueObservation(record(), f).queued, true);
      const ledger = path.join(f.stateDir, 'revisions-v1.json'), before = fs.readFileSync(ledger);
      fs.writeFileSync(path.join(f.stateDir, '.revisions-v1.tmp'), before, { mode: 0o600 });
      if (missing) fs.unlinkSync(ledger); else fs.writeFileSync(ledger, '{');
      const bytes = fs.readFileSync(path.join(f.stateDir, 'outbox', finalNames(f.stateDir)[0]));
      assert.equal(api.queueObservation(record(), f).queued, false);
      assert.equal((await flush(f)).accepted, 0);
      assert.equal(fs.existsSync(ledger), !missing);
      if (!missing) assert.equal(fs.readFileSync(ledger, 'utf8'), '{');
      assert.deepEqual(fs.readFileSync(path.join(f.stateDir, 'outbox', finalNames(f.stateDir)[0])), bytes);
    }
  });

  test('temporary record bytes count against admission and parseable legacy bytes are never treated as free capacity', t => {
    const f = fixture(t), dir = path.join(f.stateDir, 'outbox'), maximum = LIMITS.recordBytes + 512;
    // Valid JSON, deliberately not a supported envelope: safe to count, NOT to delete.
    const bytes = JSON.stringify('z'.repeat(maximum - 2));
    const count = Math.floor(api.OUTBOX_LIMITS.bytes / maximum);
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, finalName(i.toString(16).padStart(32, '0'))), bytes, { mode: 0o600 });
    const remainder = api.OUTBOX_LIMITS.bytes - count * maximum;
    fs.writeFileSync(path.join(dir, finalName('f'.repeat(32))), JSON.stringify('z'.repeat(remainder - 2)), { mode: 0o600 });
    assert.equal(api.queueObservation(record(), f).reason, 'capacity');
    assert.equal(fs.existsSync(path.join(dir, '.outbox-v1.tmp')), false);
    assert.equal(fs.readdirSync(dir).length, count + 1);
    assert.equal(fs.readFileSync(path.join(dir, finalName('0'.repeat(32))), 'utf8'), bytes);
  });

  for (const operation of ['outbox', 'revision']) for (const failure of ['write', 'fsync', 'rename', 'directory-fsync']) {
    test(`${operation} ${failure} failure preserves canonical state and never leaves a partial final`, t => {
      const f = fixture(t), slot = operation === 'revision' ? path.join(f.stateDir, '.revisions-v1.tmp')
        : path.join(f.stateDir, 'outbox', '.outbox-v1.tmp');
      const ledger = path.join(f.stateDir, 'revisions-v1.json'), before = fs.readFileSync(ledger);
      let targetFd, directoryFd;
      const custom = injected({
        openSync(p, flags, ...rest) {
          const fd = fs.openSync(p, flags, ...rest);
          if (p === slot && (flags & fs.constants.O_CREAT)) targetFd = fd;
          else if (p === path.dirname(slot) && !(flags & fs.constants.O_CREAT)) directoryFd = fd;
          return fd;
        },
        writeFileSync(fd, data, ...rest) {
          if (fd === targetFd && failure === 'write') { fs.writeSync(fd, Buffer.from(data).subarray(0, 12)); throw new Error('synthetic failure'); }
          return fs.writeFileSync(fd, data, ...rest);
        },
        fsyncSync(fd) {
          if ((fd === targetFd && failure === 'fsync') || (fd === directoryFd && failure === 'directory-fsync')) throw new Error('synthetic failure');
          return fs.fsyncSync(fd);
        },
        renameSync(from, to) { if (from === slot && failure === 'rename') throw new Error('synthetic failure'); return fs.renameSync(from, to); }
      });
      if (operation === 'revision') assert.throws(() => custom.reserveRevisions([record()], f));
      else assert.equal(custom.queueObservation(record(), f).queued, false);
      assert.equal(fs.existsSync(slot), false);
      if (operation === 'revision' && failure === 'directory-fsync') {
        assert.equal(Object.values(JSON.parse(fs.readFileSync(ledger)).entries)[0].allocated, f.revision + 1);
      } else assert.deepEqual(fs.readFileSync(ledger), before);
      const names = finalNames(f.stateDir);
      assert.equal(names.length, operation === 'outbox' && failure === 'directory-fsync' ? 1 : 0);
      for (const name of names) assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir, 'outbox', name))).record.id, record().id);
      assert.equal(api.queueObservation(record(), f).queued, true);
    });
  }

  test('ACK cleanup refuses a same-byte replacement inode and does not delete it as the accepted version', async t => {
    const f = fixture(t); assert.equal(api.queueObservation(record(), f).queued, true);
    const file = path.join(f.stateDir, 'outbox', finalNames(f.stateDir)[0]);
    const bytes = fs.readFileSync(file);
    const result = await api.flushOutbox({ ...f, dependencyRoot, exporterFactory: () => ({
      export(spans, cb) { fs.renameSync(file, `${file}.saved`); fs.writeFileSync(file, bytes, { mode: 0o600 }); cb({ code: 0 }); }, async shutdown() {}
    }) });
    assert.equal(result.accepted, 0); assert.deepEqual(fs.readFileSync(file), bytes);
  });

  test('bounded legacy partial recovery progresses across scan refusal without deleting valid legacy JSON', async t => {
    const f = fixture(t), dir = path.join(f.stateDir, 'outbox');
    for (let i = 0; i < api.OUTBOX_LIMITS.scan + 10; i++) {
      const version = i.toString(16).padStart(32, '0');
      fs.writeFileSync(path.join(dir, finalName(version)), truncatedV2(version, f.revision), { mode: 0o600 });
    }
    let result = api.queueObservation(record(), f);
    assert.equal(result.reason, 'recovery_pending');
    const remaining = fs.readdirSync(dir).length;
    // The wall-clock budget may stop a loaded run before the entry bound.
    // Both limits must make progress; do not assume 512 inspections fit 500ms.
    assert.ok(remaining > 0 && remaining < api.OUTBOX_LIMITS.scan + 10);
    for (let retry = 0; !result.queued && retry < 16; retry++) {
      assert.equal(result.reason, 'recovery_pending');
      result = api.queueObservation(record(), f);
    }
    assert.equal(result.queued, true);
    assert.equal(finalNames(f.stateDir).length, 1);
  });

  test('real legacy partial crash no longer pins expired unreferenced adapter checkpoints; valid legacy still blocks GC', { timeout: 30000 }, async t => {
    const f = fixture(t); let now = Date.now();
    let flow = createFlow({ stateDir: f.stateDir, env: {}, clock: () => now, flushOutbox: async () => ({ status: 'offline', queued: 0, accepted: 0, failed: 0 }) });
    flow.writeState('expired', { completedAt: 1 });
    await killAt(t, f, 'partial', 'legacy');
    now += ADAPTER_LIMITS.retentionMs + 1;
    flow = createFlow({ stateDir: f.stateDir, env: {}, clock: () => now, flushOutbox: async () => ({ status: 'offline', queued: 0, accepted: 0, failed: 0 }) });
    const recovered = await flow.flush({ timeoutMs: 3000 });
    assert.equal(recovered.recovered, 1); assert.equal(recovered.accepted, 0);
    assert.equal(flow.readState('delivery').recovered, 1);
    assert.equal(flow.readState('expired'), null);
    assert.deepEqual(finalNames(f.stateDir), []);
    flow.writeState('preserved-by-legacy', { completedAt: 2 });
    const legacy = path.join(f.stateDir, 'outbox', finalName('d'.repeat(32)));
    fs.writeFileSync(legacy, '{}', { mode: 0o600 }); now += ADAPTER_LIMITS.retentionMs + 1;
    await flow.flush({ timeoutMs: 3000 });
    assert.deepEqual(flow.readState('preserved-by-legacy'), { completedAt: 2 });
    assert.equal(fs.readFileSync(legacy, 'utf8'), '{}');
  });

  test('collector retains queue ownership through checkpoint deletion, excluding new references', async t => {
    const f = fixture(t); let now = Date.now();
    const original = createFlow({ stateDir: f.stateDir, env: {}, clock: () => now });
    original.writeState('expired-lock-probe', { completedAt: 1 });
    const victim = original.stateFile('expired-lock-probe'); now += ADAPTER_LIMITS.retentionMs + 1;
    let admission;
    const custom = injected({ unlinkSync(file) {
      if (file === victim) admission = api.queueObservation(record(), f);
      return fs.unlinkSync(file);
    } }, require.resolve('../runtime/langfuse/flow.cjs'));
    const flow = custom.createFlow({ stateDir: f.stateDir, env: {}, clock: () => now,
      flushOutbox: async () => ({ status: 'offline', queued: 0, accepted: 0, failed: 0 }) });
    await flow.flush({ timeoutMs: 3000 });
    assert.equal(admission?.reason, 'busy');
    assert.equal(fs.existsSync(victim), false);
    assert.equal(api.queueObservation(record(), f).queued, true, 'both queue and adapter locks released after collection');
    flow.writeState('after-collection', { completedAt: 2 });
  });

  for (const kind of ['mode', 'uid', 'fd-uid', 'symlink', 'hardlink', 'fifo', 'directory', 'oversize', 'replacement']) {
    test(`checkpoint recovery preserves unsafe ${kind} slot`, t => {
      const f = fixture(t), flowPath = require.resolve('../runtime/langfuse/flow.cjs');
      createFlow({ stateDir: f.stateDir, env: {} });
      const file = path.join(f.stateDir, 'adapters', '.checkpoint-v1.tmp'), other = path.join(f.stateDir, 'other');
      fs.writeFileSync(other, 'preserve', { mode: 0o600 });
      if (kind === 'symlink') fs.symlinkSync(other, file);
      else if (kind === 'hardlink') fs.linkSync(other, file);
      else if (kind === 'fifo') execFileSync('mkfifo', ['-m', '600', file]);
      else if (kind === 'directory') fs.mkdirSync(file, { mode: 0o700 });
      else { fs.writeFileSync(file, '{', { mode: kind === 'mode' ? 0o644 : 0o600 }); if (kind === 'oversize') fs.truncateSync(file, 1024 * 1024 + 1); }
      const overrides = {};
      if (kind === 'uid') overrides.lstatSync = (p, ...rest) => { const stat = fs.lstatSync(p, ...rest); if (p === file) stat.uid++; return stat; };
      if (kind === 'fd-uid') {
        const target = fs.lstatSync(file);
        overrides.fstatSync = (fd, ...rest) => { const stat = fs.fstatSync(fd, ...rest); if (stat.dev === target.dev && stat.ino === target.ino) stat.uid++; return stat; };
      }
      if (kind === 'replacement') {
        let replaced = false;
        overrides.openSync = (p, ...rest) => {
          if (p === file && !replaced) { replaced = true; fs.renameSync(file, `${file}.saved`); fs.writeFileSync(file, 'replacement', { mode: 0o600 }); }
          return fs.openSync(p, ...rest);
        };
      }
      const custom = injected(overrides, flowPath).createFlow({ stateDir: f.stateDir, env: {} });
      assert.throws(() => custom.writeState('refused', { completedAt: 1 }), /offline inspection/);
      assert.ok(fs.lstatSync(file)); assert.equal(fs.readFileSync(other, 'utf8'), 'preserve');
    });
  }

  test('checkpoint recovery covers old adapter, pending and claim temporary names but never canonical pending records', t => {
    const f = fixture(t), flow = createFlow({ stateDir: f.stateDir, env: {} }), uuid = crypto.randomUUID();
    const dir = path.join(f.stateDir, 'adapters'), pending = path.join(dir, 'pending');
    const artifacts = [path.join(dir, `${'e'.repeat(64)}.json.${uuid}.tmp`), path.join(pending, `${uuid}.json.${uuid}.tmp`),
      path.join(pending, `${uuid}.json.${uuid}.claim.${uuid}.tmp`)];
    for (const file of artifacts) fs.writeFileSync(file, '{', { mode: 0o600 });
    const canonical = path.join(pending, `${uuid}.json`); fs.writeFileSync(canonical, '{"records":[]}', { mode: 0o600 });
    flow.writeState('after-legacy', { completedAt: 1 });
    for (const file of artifacts) assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(canonical, 'utf8'), '{"records":[]}');
    const unknown = path.join(pending, 'unknown.tmp'); fs.writeFileSync(unknown, '', { mode: 0o600 });
    assert.throws(() => flow.writeState('refused', { completedAt: 1 }), /offline inspection/);
    assert.ok(fs.existsSync(unknown));
  });
}
