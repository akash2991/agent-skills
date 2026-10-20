'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { LANGFUSE_PACKAGE, CLAUDE_PLUGIN, CLAUDE_VERSION, CLAUDE_MARKETPLACE, preflightLangfuse, installLangfuse } = require('./lib/langfuse');

function target(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-langfuse-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function nativeSuccess(root, calls = []) {
  return (command, args, opts) => {
    calls.push([command, args, opts]);
    let stdout = '';
    if (command === 'claude' && args.join(' ') === 'plugin marketplace list --json') {
      stdout = JSON.stringify([{ name: 'langfuse-observability', source: 'github', repo: 'langfuse/Claude-Observability-Plugin', ref: `v${CLAUDE_VERSION}` }]);
    }
    if (command === 'claude' && args.join(' ') === 'plugin list --json') {
      stdout = JSON.stringify([{ id: CLAUDE_PLUGIN, version: CLAUDE_VERSION, scope: 'project', enabled: true, projectPath: root }]);
    }
    return { status: 0, stdout };
  };
}

test('native project registration sets up both pinned plugins with bounded calls and no shell', t => {
  const root = target(t);
  const calls = [];
  const run = nativeSuccess(root, calls);
  preflightLangfuse(root, run);
  assert.match(installLangfuse(root, run), /not proof of trace delivery/);
  assert.deepEqual(calls.map(c => c.slice(0, 2)), [
    ['pi', ['--version']], ['claude', ['--version']], ['uv', ['--version']],
    ['pi', ['install', '--local', LANGFUSE_PACKAGE]],
    ['claude', ['plugin', 'marketplace', 'add', CLAUDE_MARKETPLACE, '--scope', 'project', '--json']],
    ['claude', ['plugin', 'marketplace', 'list', '--json']],
    ['claude', ['plugin', 'install', CLAUDE_PLUGIN, '--scope', 'project', '--json']],
    ['claude', ['plugin', 'list', '--json']]
  ]);
  for (const [, args, opts] of calls) {
    assert.equal(opts.cwd, root);
    assert.equal(opts.shell, undefined);
    assert.ok(opts.timeout > 0);
    assert.ok(!args.includes('--approve') && !args.includes('--yes') && !args.includes('--config'));
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('preflight refuses either missing CLI without writing', t => {
  for (const missing of ['pi', 'claude']) {
    const root = target(t);
    assert.throws(() => preflightLangfuse(root, command => command === missing ? { error: { code: 'ENOENT' } } : { status: 0 }), /requires (Pi|Claude Code)/);
    assert.deepEqual(fs.readdirSync(root), []);
  }
});

test('Claude hook runtime falls back to verified Python SDK; neither runtime is an error', t => {
  const root = target(t);
  const calls = [];
  preflightLangfuse(root, (command, args) => {
    calls.push([command, args]);
    return command === 'uv' ? { status: 1 } : { status: 0 };
  });
  assert.equal(calls.at(-1)[0], 'python3');
  assert.match(calls.at(-1)[1][1], /importlib.metadata/);
  assert.throws(() => preflightLangfuse(root, command => ({ status: ['uv', 'python3'].includes(command) ? 1 : 0 })), /requires uv/);
});

test('preflight rejects malformed settings for both harnesses without invoking CLIs or echoing contents', t => {
  for (const harness of ['.pi', '.claude']) {
    const root = target(t);
    fs.mkdirSync(path.join(root, harness));
    const settings = path.join(root, harness, 'settings.json');
    for (const value of ['{"SECRET":', 'null', '[]', harness === '.pi' ? '{"packages":{}}' : '{"enabledPlugins":[]}', ...(harness === '.claude' ? ['{"extraKnownMarketplaces":null}'] : [])]) {
      fs.writeFileSync(settings, value);
      assert.throws(() => preflightLangfuse(root, () => assert.fail('must not invoke a CLI')), error => !error.message.includes('SECRET'));
      assert.equal(fs.readFileSync(settings, 'utf8'), value);
    }
  }
});

test('preflight refuses symlinked settings and harness directories', t => {
  for (const harness of ['.pi', '.claude']) {
    const root = target(t);
    const outside = target(t);
    fs.symlinkSync(outside, path.join(root, harness), 'dir');
    assert.throws(() => preflightLangfuse(root), /unsafe path/);
    fs.unlinkSync(path.join(root, harness));
    fs.mkdirSync(path.join(root, harness));
    fs.writeFileSync(path.join(outside, 'settings.json'), '{}');
    fs.symlinkSync(path.join(outside, 'settings.json'), path.join(root, harness, 'settings.json'));
    assert.throws(() => preflightLangfuse(root), /unsafe path/);
  }
});

test('Pi installer failures report partial success, never third-party output', t => {
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

test('valid BOM-prefixed settings are unchanged for native installers', t => {
  const root = target(t);
  for (const harness of ['.pi', '.claude']) {
    fs.mkdirSync(path.join(root, harness));
    fs.writeFileSync(path.join(root, harness, 'settings.json'), '\uFEFF{}');
  }
  preflightLangfuse(root, nativeSuccess(root));
  for (const harness of ['.pi', '.claude']) assert.equal(fs.readFileSync(path.join(root, harness, 'settings.json'), 'utf8'), '\uFEFF{}');
});

test('Claude installation failures describe partial setup without leaking output', t => {
  const root = target(t);
  for (const failed of ['plugin marketplace add', 'plugin install']) {
    const run = nativeSuccess(root);
    assert.throws(() => installLangfuse(root, (command, args, opts) => command === 'claude' && args.join(' ').startsWith(failed)
      ? { status: 1, stderr: 'SECRET' } : run(command, args, opts)), error => {
      assert.match(error.message, /Brain files and Pi tracing installed, but Claude/);
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    });
  }
});

test('marketplace mismatch or malformed output never installs an unrelated Claude plugin', t => {
  const root = target(t);
  for (const stdout of ['SECRET', '{}', '[null]', JSON.stringify([{ name: 'langfuse-observability', source: 'github', repo: 'someone/else', ref: `v${CLAUDE_VERSION}` }])]) {
    const calls = [];
    const run = nativeSuccess(root, calls);
    assert.throws(() => installLangfuse(root, (command, args, opts) => args.join(' ') === 'plugin marketplace list --json'
      ? { status: 0, stdout } : run(command, args, opts)), error => !error.message.includes('SECRET'));
    assert.ok(!calls.some(([command, args]) => command === 'claude' && args[1] === 'install'));
  }
});

test('Claude verification requires this project, pinned version, enabled plugin and project scope', t => {
  const root = target(t);
  const expected = { id: CLAUDE_PLUGIN, version: CLAUDE_VERSION, scope: 'project', enabled: true, projectPath: root };
  for (const override of [{ version: '0.1.0' }, { scope: 'user' }, { enabled: false }, { projectPath: target(t) }]) {
    const run = nativeSuccess(root);
    assert.throws(() => installLangfuse(root, (command, args, opts) => args.join(' ') === 'plugin list --json'
      ? { status: 0, stdout: JSON.stringify([{ ...expected, ...override }]) } : run(command, args, opts)), /not enabled at version/);
  }
});

test('pull --langfuse --dry-run describes both plugins, neither invokes CLIs nor writes files', t => {
  const root = target(t);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'agent-brain.js'), 'pull', '--target', root, '--langfuse', '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, PATH: '' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would register npm:@langfuse\/pi-observability-plugin@0\.1\.2/);
  assert.ok(result.stdout.includes(CLAUDE_PLUGIN) && result.stdout.includes(CLAUDE_MARKETPLACE));
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
