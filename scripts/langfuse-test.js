'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { LANGFUSE_PACKAGE, preflightLangfuse, installLangfuse } = require('./lib/langfuse');

function target(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-langfuse-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('native project registration uses a pinned package, bounded timeout and no shell', t => {
  const root = target(t);
  const calls = [];
  const run = (...args) => { calls.push(args); return { status: 0 }; };
  preflightLangfuse(root, run);
  assert.match(installLangfuse(root, run), /not proof of trace delivery/);
  assert.deepEqual(calls.map(c => c.slice(0, 2)), [
    ['pi', ['--version']], ['pi', ['install', '--local', LANGFUSE_PACKAGE]]
  ]);
  for (const [, , opts] of calls) {
    assert.equal(opts.cwd, root);
    assert.equal(opts.shell, undefined);
    assert.ok(opts.timeout > 0);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('preflight refuses missing Pi and malformed settings without writing', t => {
  const root = target(t);
  assert.throws(() => preflightLangfuse(root, () => ({ error: { code: 'ENOENT' } })), /requires Pi/);
  fs.mkdirSync(path.join(root, '.pi'));
  const settings = path.join(root, '.pi/settings.json');
  for (const value of ['{', 'null', '[]', '{"packages":{}}']) {
    fs.writeFileSync(settings, value);
    assert.throws(() => preflightLangfuse(root, () => assert.fail('must not invoke Pi')));
    assert.equal(fs.readFileSync(settings, 'utf8'), value);
  }
});

test('preflight refuses symlinked settings and .pi directories', t => {
  const root = target(t);
  const outside = target(t);
  fs.symlinkSync(outside, path.join(root, '.pi'), 'dir');
  assert.throws(() => preflightLangfuse(root), /unsafe path/);
  fs.unlinkSync(path.join(root, '.pi'));
  fs.mkdirSync(path.join(root, '.pi'));
  fs.writeFileSync(path.join(outside, 'settings.json'), '{}');
  fs.symlinkSync(path.join(outside, 'settings.json'), path.join(root, '.pi/settings.json'));
  assert.throws(() => preflightLangfuse(root), /unsafe path/);
});

test('native installer failures report partial success, never third-party output', t => {
  const root = target(t);
  for (const result of [{ status: 1, stderr: 'SECRET' }, { error: { code: 'ETIMEDOUT' }, stdout: 'SECRET' }]) {
    assert.throws(() => installLangfuse(root, () => result), error => {
      assert.match(error.message, /Brain files installed, but/);
      assert.doesNotMatch(error.message, /SECRET/);
      assert.match(error.message, /pi install --local/);
      return true;
    });
  }
});

test('trust refusals require a user decision, never an automatic approve flag', t => {
  const root = target(t);
  assert.throws(() => installLangfuse(root, (_command, args) => {
    assert.ok(!args.includes('--approve'));
    return { status: 1, stderr: 'Project is not trusted. Use --approve to modify local package config.' };
  }), /make your trust decision/);
});

test('valid BOM-prefixed settings are left unchanged for the native installer', t => {
  const root = target(t);
  fs.mkdirSync(path.join(root, '.pi'));
  const settings = '\uFEFF{"packages":[],"theme":"dark"}';
  fs.writeFileSync(path.join(root, '.pi/settings.json'), settings);
  preflightLangfuse(root, () => ({ status: 0 }));
  assert.equal(fs.readFileSync(path.join(root, '.pi/settings.json'), 'utf8'), settings);
});

test('pull --langfuse --dry-run neither invokes Pi nor writes files', t => {
  const root = target(t);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'agent-brain.js'), 'pull', '--target', root, '--langfuse', '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, PATH: '' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would register npm:@langfuse\/pi-observability-plugin@0\.1\.2/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('pull --langfuse with no Pi leaves target unchanged', t => {
  const root = target(t);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'agent-brain.js'), 'pull', '--target', root, '--langfuse'], {
    encoding: 'utf8', env: { ...process.env, PATH: '' }
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires Pi/);
  assert.deepEqual(fs.readdirSync(root), []);
});
