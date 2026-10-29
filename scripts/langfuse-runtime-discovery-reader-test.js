'use strict';

// Offline regression: real writerless FIFOs, plus deterministic filesystem races.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bootstrap = require('../runtime/langfuse/bootstrap.js');
const { loadDependencies } = require('../runtime/langfuse/dependencies.cjs');
const assets = path.resolve(__dirname, '../runtime/langfuse');

function fifo(file) {
  const made = spawnSync('mkfifo', [file], { encoding: 'utf8', timeout: 1000 });
  assert.equal(made.status, 0, made.stderr);
}

if (process.argv[2] === '--worker') {
  const [root, target, scenario, family] = process.argv.slice(3);
  const open = fs.openSync; const read = fs.readSync;
  let targetFd; let changed = false; let reads = 0;
  function replace(kind) {
    fs.renameSync(target, `${target}.saved`);
    if (kind === 'fifo') fifo(target);
    else if (kind === 'symlink') fs.symlinkSync(`${target}.saved`, target);
    else fs.copyFileSync(`${target}.saved`, target);
    changed = true;
  }
  fs.openSync = function (file, ...args) {
    if (file === target && scenario.endsWith('-race')) replace(scenario.slice(0, -5));
    if (file === target && scenario === 'open-denied') throw Object.assign(new Error('synthetic permission refusal'), { code: 'EACCES' });
    if (file === target && scenario === 'open-missing') fs.unlinkSync(target);
    const fd = open.call(this, file, ...args);
    if (file === target) targetFd = fd;
    return fd;
  };
  fs.readSync = function (fd, ...args) {
    const count = read.call(this, fd, ...args);
    if (fd === targetFd) {
      reads++;
      if (!changed && scenario === 'post-replace') replace('regular');
      if (!changed && scenario === 'post-grow') { fs.appendFileSync(target, 'x'); changed = true; }
      if (!changed && scenario === 'post-truncate') { fs.truncateSync(target, 0); changed = true; }
    }
    return count;
  };
  let result;
  if (family === 'discovery') {
    const policy = bootstrap.findPolicySync(path.join(root, 'child'));
    result = policy === undefined ? 'absent' : policy === null ? 'refused' : 'valid';
  } else {
    try { loadDependencies({ dependencyRoot: root }); result = 'valid'; }
    catch (error) { assert.match(error.message, /pinned runtime cache/); result = 'refused'; }
  }
  console.log(JSON.stringify({ result, reads, changed }));
} else {
  const test = require('node:test');
  function fixture(t, kind) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-discovery-reader-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let target; let family;
    if (['marker', 'git', 'commondir'].includes(kind)) {
      family = 'discovery';
      const child = path.join(root, 'child'); const principal = path.join(root, 'principal');
      fs.mkdirSync(child);
      const gitdir = path.join(principal, '.git/worktrees/child');
      fs.mkdirSync(gitdir, { recursive: true });
      fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
      fs.writeFileSync(path.join(child, '.git'), `gitdir: ${gitdir}\n`);
      const markerRoot = kind === 'marker' ? child : principal;
      fs.mkdirSync(path.join(markerRoot, '.agent-brain/observability'), { recursive: true });
      fs.writeFileSync(path.join(markerRoot, '.agent-brain/tracing.json'), JSON.stringify({ schema: 1, enabled: true, captureMode: 'metadata-only' }));
      fs.writeFileSync(path.join(markerRoot, '.agent-brain/observability/pi.js'), 'throw new Error("must not execute");');
      target = kind === 'marker' ? path.join(child, '.agent-brain/tracing.json')
        : kind === 'git' ? path.join(child, '.git') : path.join(gitdir, 'commondir');
    } else {
      family = 'cache';
      for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(assets, name), path.join(root, name));
      // Confined local mocks test successful manifest validation without installs.
      for (const name of ['@opentelemetry/api', '@opentelemetry/sdk-trace-node', '@opentelemetry/resources', '@langfuse/otel']) {
        const dir = path.join(root, 'node_modules', name); fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.js'), 'exports.LangfuseSpanProcessor = class {};');
      }
      target = path.join(root, kind);
      fs.chmodSync(target, 0o644); // Normal npm metadata is accepted.
    }
    return { root, target, family };
  }
  for (const kind of ['marker', 'git', 'commondir', 'package-lock.json', 'package.json']) {
    for (const scenario of ['regular', 'fifo', 'fifo-race', 'symlink', 'symlink-race', 'regular-race', 'post-replace', 'post-grow', 'post-truncate', 'oversize', 'mismatch', 'absent', 'open-denied', 'open-missing']) {
      test(`${kind}: ${scenario} returns promptly and preserves unsafe artifacts`, t => {
        const f = fixture(t, kind); const { target } = f;
        const original = fs.readFileSync(target);
        if (scenario === 'fifo' || scenario === 'symlink') {
          fs.renameSync(target, `${target}.saved`);
          if (scenario === 'fifo') fifo(target); else fs.symlinkSync(`${target}.saved`, target);
        } else if (scenario === 'oversize') fs.writeFileSync(target, Buffer.alloc(Math.max(4097, original.length + 1), 32));
        else if (scenario === 'mismatch') fs.writeFileSync(target, Buffer.alloc(original.length, kind === 'commondir' ? 32 : 120));
        else if (scenario === 'absent') fs.unlinkSync(target);
        const started = Date.now();
        const child = spawnSync(process.execPath, [__filename, '--worker', f.root, target, scenario, f.family], {
          encoding: 'utf8', timeout: 1200, killSignal: 'SIGKILL', env: { PATH: process.env.PATH }
        });
        assert.equal(child.error, undefined, `${kind}/${scenario}: ${child.error}`);
        assert.equal(child.signal, null, child.stderr);
        assert.equal(child.status, 0, child.stderr);
        assert.ok(Date.now() - started < 1200, 'reader returned without external timeout/kill');
        const output = JSON.parse(child.stdout);
        const expected = scenario === 'regular' ? 'valid'
          : scenario === 'absent' && f.family === 'discovery' ? 'absent' : 'refused';
        assert.equal(output.result, expected);
        if (['fifo', 'symlink', 'fifo-race', 'symlink-race', 'regular-race', 'oversize'].includes(scenario)) assert.equal(output.reads, 0);
        if (scenario.includes('race') || scenario === 'post-replace' || ['fifo', 'symlink'].includes(scenario)) {
          assert.deepEqual(fs.readFileSync(`${target}.saved`), original);
          const stat = fs.lstatSync(target);
          if (scenario.startsWith('fifo')) assert.ok(stat.isFIFO());
          if (scenario.startsWith('symlink')) assert.ok(stat.isSymbolicLink());
        }
      });
    }
  }
  test('existing byte-validated SDK remains loadable when prepared (no download)', t => {
    let root;
    try { root = require('./lib/langfuse-test-dependencies.js').testDependencyRoot(); }
    catch { t.skip('No existing pinned SDK cache; local confined mock positive cases ran'); return; }
    assert.equal(typeof loadDependencies({ dependencyRoot: root }).NodeTracerProvider, 'function');
  });
  test('cache module resolution remains confined to cache node_modules', t => {
    const f = fixture(t, 'package.json');
    const moduleDir = path.join(f.root, 'node_modules/@opentelemetry/api');
    const outside = path.join(f.root, 'outside'); fs.renameSync(moduleDir, outside); fs.symlinkSync(outside, moduleDir);
    assert.throws(() => loadDependencies({ dependencyRoot: f.root }), /pinned runtime cache/);
  });
}
