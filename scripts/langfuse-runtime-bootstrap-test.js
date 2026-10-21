'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const bootstrap = require('../runtime/langfuse/bootstrap.js');
const { main: claudeBootstrap } = require('../runtime/langfuse/bootstrap-claude.cjs');
const { launch, parse } = require('../runtime/langfuse/launch.cjs');

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-trace-bootstrap-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function runtime(root, enabled = true) {
  fs.mkdirSync(path.join(root, '.agent-brain/observability'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agent-brain/tracing.json'), JSON.stringify({ schema: 1, enabled, captureMode: 'metadata-only' }));
  const entry = path.join(root, '.agent-brain/observability/pi.js');
  fs.writeFileSync(entry, 'throw new Error("PROJECT_CODE_MUST_NOT_RUN");');
  return entry;
}

test('pure filesystem bootstrap resolves an old worktree to opted-in principal runtime', t => {
  const root = temp(t); const principal = path.join(root, 'principal'); const child = path.join(root, 'old-child');
  fs.mkdirSync(child); const entry = runtime(principal);
  const gitdir = path.join(principal, '.git/worktrees/old-child'); fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n'); fs.writeFileSync(path.join(child, '.git'), `gitdir: ${gitdir}\n`);
  assert.equal(bootstrap.findRuntimeSync(child), entry);
});

test('actual Claude and Pi old-worktree bootstraps honor declarations from root and subdirectory', t => {
  const root = fs.realpathSync(temp(t)); const principal = path.join(root, 'principal'); const child = path.join(root, 'old-child');
  fs.mkdirSync(principal);
  const git = args => {
    const result = spawnSync('git', args, { cwd: principal, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q']);
  git(['-c', 'user.name=Bootstrap Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'old base']);
  git(['worktree', 'add', '--detach', child, 'HEAD']);
  const entry = runtime(principal);
  fs.writeFileSync(entry, `module.exports = pi => {
    globalThis.runtimeLoads++;
    if (!globalThis[Symbol.for('agent-brain.observability.context-tool-proxy')]) pi.registerTool({name:'brain_context'});
    return { start: async () => { globalThis.runtimeStarts++; } };
  };`);
  fs.writeFileSync(path.join(path.dirname(entry), 'claude.cjs'), 'exports.handleClaudeHook = async () => ({loaded:true});');
  const subdir = path.join(child, 'nested/deeper'); fs.mkdirSync(subdir, { recursive: true });
  const marker = path.join(child, '.agent-brain/tracing.json'); fs.mkdirSync(path.dirname(marker));
  const piScript = `
    globalThis.runtimeLoads = 0; globalThis.runtimeStarts = 0;
    const handlers = {}; const tools = [];
    require(${JSON.stringify(require.resolve('../runtime/langfuse/bootstrap.js'))})({
      on: (name, fn) => { handlers[name] = fn; }, registerTool: tool => tools.push(tool.name)
    });
    const suppressed = process.env.LANGFUSE_TRACING_ENABLED;
    handlers.session_start({}, {cwd:process.cwd(),isProjectTrusted:()=>process.env.TEST_TRUSTED==='true'})
      .then(() => { console.log(JSON.stringify({loads:globalThis.runtimeLoads, starts:globalThis.runtimeStarts,
        tools, suppressed, restored:process.env.LANGFUSE_TRACING_ENABLED})); handlers.session_shutdown?.(); });
  `;
  const declarations = [
    ['absent', null],
    ['disabled', JSON.stringify({ schema: 1, enabled: false, captureMode: 'metadata-only' })],
    ['malformed', '{'],
    ['missing adapter', JSON.stringify({ schema: 1, enabled: true, captureMode: 'metadata-only' })],
    ['invalid value', 'null'],
    ['invalid schema', JSON.stringify({ schema: 2, enabled: true, captureMode: 'metadata-only' })],
    ['invalid runtime', JSON.stringify({ schema: 1, enabled: true, captureMode: 'metadata-only', runtime: '../escape' })]
  ];
  for (const [name, declaration] of declarations) {
    if (declaration === null) fs.rmSync(marker, { force: true }); else fs.writeFileSync(marker, declaration);
    const allowed = declaration === null;
    for (const cwd of [child, subdir]) {
      assert.equal(bootstrap.findRuntimeSync(cwd), allowed ? entry : null, `${name}: sync discovery`);
      assert.equal(bootstrap.findRuntime(cwd), allowed ? entry : null, `${name}: Git discovery`);
      const env = { PATH: process.env.PATH, LANGFUSE_TRACING_ENABLED: 'true', TEST_TRUSTED: 'true' };
      const claude = spawnSync(process.execPath, [require.resolve('../runtime/langfuse/bootstrap-claude.cjs')], {
        cwd, env, input: JSON.stringify({ cwd, hook_event_name: 'Stop' }), encoding: 'utf8', timeout: 10000
      });
      assert.equal(claude.status, 0, claude.stderr);
      assert.equal(claude.stdout, allowed ? '{"loaded":true}' : '', `${name}: Claude executable`);
      for (const trusted of [true, false]) {
        const pi = spawnSync(process.execPath, ['-e', piScript], {
          cwd, env: { ...env, TEST_TRUSTED: String(trusted) }, encoding: 'utf8', timeout: 10000
        });
        assert.equal(pi.status, 0, pi.stderr);
        assert.deepEqual(JSON.parse(pi.stdout), {
          loads: allowed && trusted ? 1 : 0, starts: allowed && trusted ? 1 : 0,
          tools: allowed ? ['brain_context'] : [], suppressed: allowed ? 'false' : 'true', restored: 'true'
        }, `${name}: Pi factory/start (trusted=${trusted})`);
      }
    }
  }

  // An opted-in Git root must not override a more-specific declaration at cwd
  // or an intermediate ancestor. Exercise the real consumers, not only lookup.
  const childEntry = runtime(child);
  fs.copyFileSync(entry, childEntry);
  fs.copyFileSync(path.join(path.dirname(entry), 'claude.cjs'), path.join(path.dirname(childEntry), 'claude.cjs'));
  for (const declarationRoot of [path.join(child, 'nested'), subdir]) {
    const nestedMarker = path.join(declarationRoot, '.agent-brain/tracing.json');
    fs.mkdirSync(path.dirname(nestedMarker), { recursive: true });
    const deeper = path.join(declarationRoot, 'descendant'); fs.mkdirSync(deeper, { recursive: true });
    for (const [name, declaration] of declarations.filter(([, value]) => value !== null)) {
      fs.writeFileSync(nestedMarker, declaration);
      for (const cwd of [declarationRoot, deeper]) {
        const label = `${name}: nested declaration at ${path.relative(child, declarationRoot)}, cwd=${path.relative(child, cwd)}`;
        assert.equal(bootstrap.findRuntimeSync(cwd), null, `${label}: sync discovery`);
        assert.equal(bootstrap.findRuntime(cwd), null, `${label}: Git discovery`);
        const env = { PATH: process.env.PATH, LANGFUSE_TRACING_ENABLED: 'true' };
        const claude = spawnSync(process.execPath, [require.resolve('../runtime/langfuse/bootstrap-claude.cjs')], {
          cwd, env, input: JSON.stringify({ cwd, hook_event_name: 'Stop' }), encoding: 'utf8', timeout: 10000
        });
        assert.equal(claude.status, 0, claude.stderr);
        assert.equal(claude.stdout, '', `${label}: Claude executable`);
        for (const trusted of [true, false]) {
          const pi = spawnSync(process.execPath, ['-e', piScript], {
            cwd, env: { ...env, TEST_TRUSTED: String(trusted) }, encoding: 'utf8', timeout: 10000
          });
          assert.equal(pi.status, 0, pi.stderr);
          assert.deepEqual(JSON.parse(pi.stdout), {
            loads: 0, starts: 0, tools: [], suppressed: 'true', restored: 'true'
          }, `${label}: Pi factory/start (trusted=${trusted})`);
        }
      }
    }
    fs.rmSync(nestedMarker);
    assert.equal(bootstrap.findRuntimeSync(deeper), childEntry, 'absent nested marker permits root opt-in');
    assert.equal(bootstrap.findRuntime(deeper), childEntry, 'Git discovery agrees after nested marker removal');
  }
});

test('untrusted project code is never executed and legacy suppression is restored', async t => {
  const root = temp(t); runtime(root);
  const cwd = process.cwd(); const original = process.env.LANGFUSE_TRACING_ENABLED;
  const guard = Symbol.for('agent-brain.observability.controller'); delete globalThis[guard];
  try {
    process.chdir(root);
    let handler; bootstrap({ on: (_name, fn) => { handler = fn; } });
    assert.equal(process.env.LANGFUSE_TRACING_ENABLED, 'false');
    await handler({}, { cwd: root, isProjectTrusted: () => false });
    assert.equal(process.env.LANGFUSE_TRACING_ENABLED, original);
    assert.equal(globalThis[guard], undefined);
  } finally { process.chdir(cwd); if (original === undefined) delete process.env.LANGFUSE_TRACING_ENABLED; else process.env.LANGFUSE_TRACING_ENABLED = original; }
});

test('a marker on an unrelated secondary worktree does not opt in this repository', t => {
  const root = temp(t); const child = path.join(root, 'child'); const principal = path.join(root, 'principal'); const other = path.join(root, 'other');
  fs.mkdirSync(child); fs.mkdirSync(principal); runtime(other);
  const git = (_cmd, args) => args.includes('list') ? `worktree ${principal}\n\nworktree ${other}\n` : `${child}\n`;
  assert.equal(bootstrap.findRuntime(child, git), null);
});

test('Claude bootstrap is gated, bounded and honors common kill switch without invoking adapter', async () => {
  let calls = 0;
  const options = { findRuntime: () => '/synthetic/runtime/pi.js', adapter: { handleClaudeHook: async () => { calls++; return {}; } }, env: {} };
  await claudeBootstrap(JSON.stringify({ cwd: '/synthetic', hook_event_name: 'Stop' }), options);
  assert.equal(calls, 1);
  await claudeBootstrap(JSON.stringify({ cwd: '/synthetic' }), { ...options, env: { BRAIN_TRACING_ENABLED: 'false' } });
  await claudeBootstrap(JSON.stringify({ cwd: '/synthetic' }), { ...options, findRuntime: () => null });
  assert.equal(calls, 1);
  assert.equal(await claudeBootstrap('x'.repeat(8 * 1024 * 1024 + 1), options), null);
});

test('explicit Herdr helper binds exact child session and passes native resource arguments, not secrets', async t => {
  const cwd = temp(t); const states = new Map(); const calls = []; const launches = [];
  const parent = { traceId: 'a'.repeat(32), rootSpanId: 'b'.repeat(16), sessionId: '11111111-1111-4111-8111-111111111111' };
  const flow = { resolve: run => run, readState: key => states.get(key), writeState: (key, value) => states.set(key, value),
    store: { resolveLaunch: () => ({ parent }), createLaunch: (p, value) => { const binding = { parent: p, nonce: 'c'.repeat(32), ...value }; launches.push(binding); return binding; } } };
  const run = (command, args) => {
    calls.push([command, args]);
    if (args.includes('process-info')) return { status: 0, stdout: JSON.stringify({ result: { process_info: { pane_id: 'w1:p7', shell_pid: 42, foreground_processes: [{ pid: 42, cwd }] } } }) };
    states.set(`launch-ack:${'c'.repeat(32)}`, { phase: 'adapter-started' });
    return { status: 0, stdout: '{}' };
  };
  const result = await launch(['--pane', 'w1:p7', '--harness', 'pi', '--name', 'synthetic-test', '--cwd', cwd, '--model', 'openai-codex/gpt-6.1-sol', '--effort', 'low'], {
    env: { HERDR_ENV: '1', BRAIN_TRACE_LAUNCH_ID: 'd'.repeat(32) }, flow, run
  });
  assert.equal(result.status, 'adapter-started');
  const args = calls[1][1];
  assert.equal(args[0], 'agent'); assert.equal(args[1], 'start');
  assert.equal(args[args.indexOf('--session-id') + 1], result.nativeSessionId);
  assert.ok(args.includes('-e') && args.some(value => value.endsWith('/runtime/langfuse/pi.js')));
  assert.equal(launches[0].launchId, `brain:pi:${result.nativeSessionId}`);
  assert.equal(launches[0].parent.rootSpanId, parent.rootSpanId);
  assert.equal(states.get(`pane:${'c'.repeat(32)}`).paneId, 'w1:p7');
});

test('launch helper refuses busy panes and arbitrary native/credential arguments', async t => {
  assert.throws(() => parse(['--api-key', 'SYNTHETIC']), /Invalid/);
  const cwd = temp(t); let bound = false;
  const flow = { store: { resolveLaunch: () => ({ parent: {} }), createLaunch: () => { bound = true; } }, resolve: value => value };
  await assert.rejects(launch(['--pane', 'w1:p7', '--harness', 'claude', '--name', 'test', '--cwd', cwd], { env: { HERDR_ENV: '1', BRAIN_TRACE_LAUNCH_ID: 'x'.repeat(32) }, flow,
    run: () => ({ status: 0, stdout: JSON.stringify({ result: { process_info: { pane_id: 'w1:p7', shell_pid: 42, foreground_processes: [{ pid: 99, cwd }] } } }) }) }), /idle shell/);
  assert.equal(bound, false);
});
