'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { RUNTIME_PATH, LEGACY_PI_PACKAGE, LEGACY_CLAUDE_PLUGIN, CLAUDE_HOOK_COMMAND, HOOK_EVENTS, planLangfuseMarker, preflightLangfuse, installLangfuse } = require('./lib/langfuse');

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

const { FULL_CAPTURE_POLICY: FULL, METADATA_CAPTURE_POLICY: META, findCapturePolicySync, isTracingAllowed } = require('../runtime/langfuse/bootstrap.js');
const markerPath = target => path.join(target, '.agent-brain/tracing.json');
const cli = (f, args) => spawnSync(process.execPath, [path.join(__dirname, 'agent-brain.js'), 'pull', '--target', f.target, ...args], {
  encoding: 'utf8', env: { ...process.env, HOME: f.home, PATH: '', PI_CODING_AGENT_DIR: f.options.agentDir, CLAUDE_CONFIG_DIR: f.options.claudeDir }
});

test('explicit full-content writes complete consent, retains it on reinstall and changes no permission/global settings', t => {
  const f = fixture(t); runtime(f.target); const calls = [], run = runner(calls);
  const globalPi = { defaultProjectTrust: 'always', packages: ['npm:unrelated'] };
  const globalClaude = { permissions: { allow: ['Read'] }, env: { KEEP: 'unchanged' } };
  const local = { permissions: { allow: ['Bash(printf *)'] }, env: { PRIVATE: 'SYNTHETIC_NO_COPY' } };
  write(path.join(f.options.agentDir, 'settings.json'), globalPi);
  write(path.join(f.options.claudeDir, 'settings.json'), globalClaude);
  write(path.join(f.target, '.claude/settings.local.json'), local);
  write(path.join(f.target, '.claude/settings.json'), { permissions: { allow: ['Read'] } });
  write(path.join(f.home, '.config/agent-brain/langfuse.json'), { secretKey: 'SYNTHETIC_NO_COPY' });
  write(path.join(f.target, '.env'), 'PRIVATE=SYNTHETIC_NO_COPY\n');
  installLangfuse(f.target, run, f.options);
  const nativeFiles = ['.pi/settings.json', '.claude/settings.json', '.claude/settings.local.json'];
  const before = nativeFiles.map(file => fs.readFileSync(path.join(f.target, file), 'utf8'));
  const message = installLangfuse(f.target, run, { ...f.options, captureMode: 'full-content' });
  assert.match(message, /full-content/); assert.match(message, /PII/); assert.match(message, /best effort/); assert.match(message, /durable/);
  assert.doesNotMatch(message, /SYNTHETIC_NO_COPY/);
  assert.deepEqual(json(markerPath(f.target)), { ...FULL, runtime: RUNTIME_PATH });
  assert.deepEqual(findCapturePolicySync(f.target), FULL, 'real discovery reads the installed marker');
  const first = fs.readFileSync(markerPath(f.target), 'utf8');
  installLangfuse(f.target, run, f.options);
  installLangfuse(f.target, run, { ...f.options, captureMode: 'full-content' });
  assert.equal(fs.readFileSync(markerPath(f.target), 'utf8'), first);
  assert.deepEqual(nativeFiles.map(file => fs.readFileSync(path.join(f.target, file), 'utf8')), before, 'only consent changes, not native permissions/hooks/extensions');
  assert.deepEqual(json(path.join(f.options.agentDir, 'settings.json')), globalPi);
  assert.deepEqual(json(path.join(f.options.claudeDir, 'settings.json')), globalClaude);
  assert.equal(fs.readFileSync(path.join(f.target, '.env'), 'utf8'), 'PRIVATE=SYNTHETIC_NO_COPY\n');
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  for (const file of [...walk(path.join(f.home, '.cache')), ...walk(path.join(f.target, '.agent-brain'))]) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes('SYNTHETIC_NO_COPY'), 'no secret copy into cache/managed runtime/marker');
  }
  assert.equal(calls.filter(([cmd]) => cmd === 'npm').length, 1);
  assert.ok(!calls.some(([cmd]) => cmd === 'pi'), 'full-content must not implicitly register a user package');
});

test('metadata schema stays frozen, explicit downgrade removes full consent and disabled marker stays disabled', t => {
  const f = fixture(t); runtime(f.target); const run = runner();
  installLangfuse(f.target, run, f.options);
  assert.deepEqual(json(markerPath(f.target)), { ...META, runtime: RUNTIME_PATH });
  installLangfuse(f.target, run, { ...f.options, captureMode: 'full-content' });
  installLangfuse(f.target, run, { ...f.options, captureMode: 'metadata-only' });
  assert.deepEqual(json(markerPath(f.target)), { ...META, runtime: RUNTIME_PATH });
  for (const policy of [META, FULL]) {
    write(markerPath(f.target), { ...policy, enabled: false });
    for (const captureMode of [undefined, 'full-content', 'metadata-only']) {
      const message = installLangfuse(f.target, run, { ...f.options, captureMode });
      assert.equal(json(markerPath(f.target)).enabled, false);
      assert.match(message, /disabled.*refusal preserved/);
      assert.equal(findCapturePolicySync(f.target), null);
      assert.equal(isTracingAllowed({ cwd: f.target, isProjectTrusted: () => true }, { perRun: true }), false);
    }
  }
  write(markerPath(f.target), { ...FULL, runtime: 'runtime/langfuse' });
  assert.deepEqual(planLangfuseMarker(f.target), { ...FULL, runtime: 'runtime/langfuse' }, 'keep native source selection');
});

test('invalid modes and marker controls fail before cache/native writes or CLI calls', t => {
  for (const captureMode of ['', null, 'full', 'FULL-CONTENT', 'full-content\n', { mode: 'full-content' }]) {
    const f = fixture(t); runtime(f.target);
    assert.throws(() => installLangfuse(f.target, () => assert.fail('no runner call'), { ...f.options, captureMode }), /Invalid capture mode/);
    assert.ok(!fs.existsSync(path.join(f.home, '.cache')));
    assert.ok(!fs.existsSync(path.join(f.target, '.pi')));
    assert.ok(!fs.existsSync(markerPath(f.target)));
  }
  const invalid = [{}, { ...META, captureMode: 'full-content' }, { ...FULL, schema: 3 }, { ...FULL, enabled: 'true' },
    { ...FULL, pii: 'redact' }, { ...FULL, durableRetry: false }, { ...FULL, runtime: '../outside' }, { ...FULL, unknownControl: true }];
  for (const key of Object.keys(FULL)) { const missing = { ...FULL }; delete missing[key]; invalid.push(missing); }
  for (const marker of invalid) {
    const f = fixture(t); runtime(f.target); write(markerPath(f.target), marker);
    const previous = fs.readFileSync(markerPath(f.target), 'utf8');
    const noRun = () => assert.fail('no CLI/install before validation');
    assert.throws(() => preflightLangfuse(f.target, noRun, f.options), /tracing marker/);
    assert.throws(() => installLangfuse(f.target, noRun, { ...f.options, captureMode: 'full-content' }), /tracing marker/);
    assert.equal(fs.readFileSync(markerPath(f.target), 'utf8'), previous);
    assert.ok(!fs.existsSync(path.join(f.home, '.cache')));
    assert.ok(!fs.existsSync(path.join(f.target, '.pi')));
    const result = cli(f, ['--langfuse', '--dry-run']);
    assert.equal(result.status, 2); assert.match(result.stderr, /tracing marker/);
    assert.ok(!fs.existsSync(path.join(f.target, 'AGENTS.md')), 'no asset pull before marker validation');
  }
});

test('CLI capture-mode controls reject invalid/missing/duplicate/unscoped input before any writes', t => {
  for (const args of [['--capture-mode', 'full-content'], ['--langfuse', '--capture-mode'],
    ['--langfuse', '--capture-mode', 'FULL-CONTENT'], ['--langfuse', '--capture-mode', 'full-content\n'],
    ['--langfuse', '--capture-mode', 'full-content', '--capture-mode', 'metadata-only']]) {
    const f = fixture(t), result = cli(f, args);
    assert.equal(result.status, 2, JSON.stringify(args)); assert.match(result.stderr, /capture-mode/);
    assert.deepEqual(fs.readdirSync(f.target), []); assert.deepEqual(fs.readdirSync(f.home), []);
  }
});

test('full-content dry-run reports consent without writes and omission reports existing policy honestly', t => {
  const f = fixture(t);
  const explicit = cli(f, ['--langfuse', '--capture-mode', 'full-content', '--dry-run']);
  assert.equal(explicit.status, 0, explicit.stderr); assert.match(explicit.stdout, /full-content/);
  assert.match(explicit.stdout, /PII/); assert.match(explicit.stdout, /best-effort/); assert.match(explicit.stdout, /durable/);
  assert.deepEqual(fs.readdirSync(f.target), []); assert.deepEqual(fs.readdirSync(f.home), []);
  write(markerPath(f.target), FULL);
  const retained = cli(f, ['--langfuse', '--dry-run']);
  assert.equal(retained.status, 0, retained.stderr); assert.match(retained.stdout, /full-content/);
  assert.deepEqual(json(markerPath(f.target)), FULL);
  write(markerPath(f.target), { ...FULL, enabled: false });
  const disabled = cli(f, ['--langfuse', '--dry-run']);
  assert.equal(disabled.status, 0, disabled.stderr); assert.match(disabled.stdout, /disabled.*refusal preserved/);
  assert.equal(json(markerPath(f.target)).enabled, false);
});

test('ordinary pull preserves full-content declarations, native discovery layout and unrelated settings', t => {
  const { pullInstall } = require('./lib/pull-install');
  const f = fixture(t);
  pullInstall({ target: f.target });
  installLangfuse(f.target, runner(), { ...f.options, captureMode: 'full-content' });
  const files = ['.pi/settings.json', '.claude/settings.json', '.agent-brain/tracing.json'];
  const before = files.map(file => fs.readFileSync(path.join(f.target, file), 'utf8'));
  pullInstall({ target: f.target });
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(f.target, file), 'utf8')), before);
  assert.deepEqual(findCapturePolicySync(f.target), FULL);
  assert.deepEqual(fs.readFileSync(path.join(f.target, '.agents/skills/coding-standards/SKILL.md')), fs.readFileSync(path.join(__dirname, '../skills/coding-standards/SKILL.md')));
  assert.deepEqual(fs.readFileSync(path.join(f.target, '.claude/skills/coding-standards/SKILL.md')), fs.readFileSync(path.join(__dirname, '../skills/coding-standards/SKILL.md')));
  for (const dir of ['.pi/skills', '.hermes/skills', '.gemini/skills', '.codex/skills']) assert.ok(!fs.existsSync(path.join(f.target, dir)), dir);
});

test('context status uses real current full/metadata/disabled policy, never stored content or an old grant', t => {
  const { createFlow } = require('../runtime/langfuse/flow.cjs');
  const { runContext } = require('../runtime/langfuse/context-cli.cjs');
  const f = fixture(t); runtime(f.target); fs.mkdirSync(path.join(f.target, '.git'));
  write(markerPath(f.target), FULL);
  const env = {}, flow = createFlow({ cwd: f.target, stateDir: path.join(f.root, 'state'), env });
  const run = flow.begin({ cwd: f.target, nativeSessionId: '550e8400-e29b-41d4-a716-446655440000' });
  const { nonce } = flow.createToolLaunch(run);
  const status = () => runContext(['--actor', nonce, 'status'], { cwd: f.target, flow, env });
  for (const policy of [FULL, META, { ...FULL, enabled: false }, { ...FULL, pii: 'redact' }]) {
    write(markerPath(f.target), policy);
    const expected = policy.enabled && policy.pii !== 'redact' ? policy : null;
    assert.equal(status().captureMode, expected?.captureMode || 'disabled');
    assert.deepEqual(status().capturePolicy, expected);
  }
  write(markerPath(f.target), FULL);
  for (const key of ['BRAIN_TRACING_ENABLED', 'LANGFUSE_TRACING_ENABLED']) {
    env[key] = 'false'; assert.equal(status().captureMode, 'disabled'); assert.equal(status().capturePolicy, null); delete env[key];
  }
  assert.equal(isTracingAllowed({ cwd: f.target, isProjectTrusted: () => false }), false);
  fs.unlinkSync(markerPath(f.target));
  assert.equal(status().captureMode, 'metadata-only', 'old absent-marker per-run flag is not full consent');
  assert.deepEqual(status().capturePolicy, META);
  assert.ok(!Object.hasOwn(status(), 'content'));
});
