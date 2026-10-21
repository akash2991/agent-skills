'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { RUNTIME_PATH, LEGACY_PI_PACKAGE, LEGACY_CLAUDE_PLUGIN, CLAUDE_HOOK_COMMAND, HOOK_EVENTS, preflightLangfuse, installLangfuse } = require('./lib/langfuse');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-tracing-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'consumer'), home = path.join(root, 'home');
  fs.mkdirSync(target); fs.mkdirSync(home);
  const options = { home, agentDir: path.join(home, '.pi/agent'), claudeDir: path.join(home, '.claude') };
  return { root, target, home, options };
}
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function runtime(target) {
  const dir = path.join(target, RUNTIME_PATH);
  for (const file of ['pi.js', 'claude.cjs', 'bootstrap.js', 'bootstrap-claude.cjs', 'brain-trace.cjs']) write(path.join(dir, file), '// synthetic runtime fixture\n');
  write(path.join(dir, 'package.json'), { name: 'synthetic-test', version: '1.0.0', dependencies: {} });
  write(path.join(dir, 'package-lock.json'), { name: 'synthetic-test', lockfileVersion: 3, packages: {} });
  write(path.join(dir, 'dependencies.cjs'), "exports.dependencyCacheDir = ({home}) => require('node:path').join(home, 'dependency-cache');\n");
}
function runner(calls = []) {
  return (command, args, opts) => {
    calls.push([command, args, opts]);
    if (command === 'npm' || command === 'npm.cmd') write(path.join(opts.cwd, 'node_modules/@langfuse/otel/package.json'), { version: '0.0.0-synthetic' });
    return { status: 0, stdout: command === 'pi' && args[0] === '--version' ? '1.3.0' : command === 'claude' && args[0] === '--version' ? '2.1.304 (Claude Code)' : '' };
  };
}

test('metadata-only registration preserves unrelated settings and suppresses legacy exporters', t => {
  const f = fixture(t); runtime(f.target); const calls = []; const run = runner(calls);
  const otherHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo preserve-existing-hook' }] };
  write(path.join(f.target, '.pi/settings.json'), { theme: 'dark', packages: ['npm:unrelated-package', LEGACY_PI_PACKAGE] });
  write(path.join(f.target, '.claude/settings.json'), { env: { KEEP_ME: 'unchanged' }, hooks: { Stop: [otherHook] }, enabledPlugins: { 'other@example': false, [LEGACY_CLAUDE_PLUGIN]: true } });
  write(path.join(f.target, '.claude/settings.local.json'), { env: { LOCAL_PRIVATE: 'SYNTHETIC_NOT_A_REAL_SECRET' } });
  write(path.join(f.target, '.env'), 'DO_NOT_COPY=SYNTHETIC_NOT_A_REAL_SECRET\n');
  preflightLangfuse(f.target, run, f.options);
  const message = installLangfuse(f.target, run, f.options);
  assert.match(message, /metadata-only/); assert.doesNotMatch(message, /SYNTHETIC_NOT_A_REAL_SECRET/);
  const pi = json(path.join(f.target, '.pi/settings.json'));
  assert.equal(pi.theme, 'dark'); assert.ok(pi.packages.includes('npm:unrelated-package'));
  assert.ok(pi.extensions.includes('../.agent-brain/observability/pi.js'));
  assert.ok(!pi.packages.some(entry => entry === LEGACY_PI_PACKAGE || entry.source === LEGACY_PI_PACKAGE), 'project-only legacy package is removed, not downloaded again');
  const claude = json(path.join(f.target, '.claude/settings.json'));
  assert.deepEqual(claude.env, { KEEP_ME: 'unchanged' }); assert.equal(claude.enabledPlugins['other@example'], false);
  assert.equal(claude.enabledPlugins[LEGACY_CLAUDE_PLUGIN], false);
  assert.deepEqual(claude.hooks.Stop[0], otherHook);
  for (const event of HOOK_EVENTS) assert.equal(claude.hooks[event].filter(entry => entry.hooks.some(hook => hook.command === CLAUDE_HOOK_COMMAND)).length, 1);
  assert.equal(json(path.join(f.target, '.agent-brain/tracing.json')).captureMode, 'metadata-only');
  assert.equal(fs.readFileSync(path.join(f.target, '.env'), 'utf8'), 'DO_NOT_COPY=SYNTHETIC_NOT_A_REAL_SECRET\n');
  assert.deepEqual(json(path.join(f.target, '.claude/settings.local.json')), { env: { LOCAL_PRIVATE: 'SYNTHETIC_NOT_A_REAL_SECRET' } });
  assert.ok(!calls.some(([command, args]) => command === 'pi' && args[0] !== '--version'), 'default setup must not write Pi user settings');
  assert.ok(calls.some(([command, args]) => command === 'npm' && args.includes('--ignore-scripts')));
});

test('repeat setup is idempotent and the shared dependency cache is reused', t => {
  const f = fixture(t); runtime(f.target); const calls = []; const run = runner(calls);
  installLangfuse(f.target, run, f.options);
  const first = fs.readFileSync(path.join(f.target, '.claude/settings.json'), 'utf8');
  installLangfuse(f.target, run, f.options);
  assert.equal(fs.readFileSync(path.join(f.target, '.claude/settings.json'), 'utf8'), first);
  assert.equal(calls.filter(([command]) => command === 'npm').length, 1);
  assert.equal(json(path.join(f.target, '.pi/settings.json')).extensions.filter(entry => entry === '../.agent-brain/observability/pi.js').length, 1);
});

test('user bootstrap and legacy-user-package removal require explicit option', t => {
  const f = fixture(t); runtime(f.target); const calls = []; const run = runner(calls);
  write(path.join(f.options.agentDir, 'settings.json'), { theme: 'dark', packages: [LEGACY_PI_PACKAGE, 'npm:keep'] });
  installLangfuse(f.target, run, { ...f.options, worktreeBootstrap: true });
  const guard = json(path.join(f.target, '.pi/settings.json')).packages.find(entry => entry.source === LEGACY_PI_PACKAGE);
  assert.equal(guard.autoload, false); assert.deepEqual(guard.extensions, []);
  assert.ok(calls.some(([command, args]) => command === 'pi' && args[0] === 'remove' && args[1] === LEGACY_PI_PACKAGE && !args.includes('--local')));
  assert.ok(calls.some(([command, args]) => command === 'pi' && args[0] === 'install' && args[1].endsWith('/bootstrap') && !args.includes('--local')));
  assert.deepEqual(json(path.join(f.options.agentDir, 'settings.json')), { theme: 'dark', packages: [LEGACY_PI_PACKAGE, 'npm:keep'] }, 'mock runner has no implicit file edits');
  for (const [, args] of calls) assert.ok(!args.includes('--approve') && !args.includes('--api-key'));
});

test('preflight requires both current CLIs, but no Python/uv runtime', t => {
  const f = fixture(t); const calls = [];
  preflightLangfuse(f.target, runner(calls), f.options);
  assert.deepEqual(calls.map(row => row[0]), ['pi', 'claude']);
  for (const missing of ['pi', 'claude']) assert.throws(() => preflightLangfuse(f.target, command => command === missing ? { status: 1 } : { status: 0, stdout: '9.9.9' }, f.options), /requires/);
  assert.throws(() => preflightLangfuse(f.target, () => ({ status: 0, stdout: '1.0.0' }), f.options), /or newer/);
});

test('conflicting local overrides/direct extensions/manual hooks fail before writes', t => {
  for (const which of ['local', 'extension', 'hook']) {
    const f = fixture(t);
    if (which === 'local') write(path.join(f.target, '.claude/settings.local.json'), { enabledPlugins: { [LEGACY_CLAUDE_PLUGIN]: true } });
    if (which === 'extension') write(path.join(f.target, '.pi/settings.json'), { extensions: ['/synthetic/@langfuse/pi-observability-plugin/src/index.ts'] });
    if (which === 'hook') write(path.join(f.options.claudeDir, 'settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'python3 ~/.claude/hooks/langfuse_hook.py' }] }] } });
    assert.throws(() => preflightLangfuse(f.target, () => assert.fail('must not invoke a CLI'), f.options), /legacy|Legacy/);
    assert.ok(!fs.existsSync(path.join(f.target, '.agent-brain')));
  }
});

test('malformed settings and symlinked paths fail without echoing content', t => {
  const f = fixture(t);
  write(path.join(f.target, '.claude/settings.json'), '{"PRIVATE_CANARY":');
  assert.throws(() => preflightLangfuse(f.target, runner(), f.options), error => !error.message.includes('PRIVATE_CANARY'));
  fs.unlinkSync(path.join(f.target, '.claude/settings.json'));
  const outside = path.join(f.root, 'outside'); write(outside, '{}');
  fs.symlinkSync(outside, path.join(f.target, '.claude/settings.json'));
  assert.throws(() => preflightLangfuse(f.target, runner(), f.options), /Unsafe/);
});

test('failed dependency installation changes no native registration and hides third-party output', t => {
  const f = fixture(t); runtime(f.target);
  assert.throws(() => installLangfuse(f.target, () => ({ status: 1, stderr: 'PRIVATE_CANARY' }), f.options), error => !error.message.includes('PRIVATE_CANARY'));
  assert.ok(!fs.existsSync(path.join(f.target, '.pi/settings.json')));
  assert.ok(!fs.existsSync(path.join(f.target, '.claude/settings.json')));
});

test('dry run describes project and explicit user bootstrap without invoking CLIs/writing', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'agent-brain.js'), 'pull', '--target', f.target, '--langfuse', '--worktree-bootstrap', '--dry-run'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /metadata-only/); assert.match(result.stdout, /Pi user bootstrap/);
  assert.deepEqual(fs.readdirSync(f.target), []);
});

test('bootstrap flag cannot be accidentally used without tracing opt-in', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'agent-brain.js'), 'pull', '--target', f.target, '--worktree-bootstrap'], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /requires --langfuse/);
  assert.deepEqual(fs.readdirSync(f.target), []);
});
