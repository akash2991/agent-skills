'use strict';

// Explicit native wiring suite: downloads pinned SDKs, but performs no model
// calls or Langfuse requests. Native config/trust/cache stores are temporary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const test = require('node:test');
const { LEGACY_CLAUDE_PLUGIN, CLAUDE_HOOK_COMMAND } = require('./lib/langfuse');

function rpc(cwd, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('pi', ['--mode', 'rpc', '--no-session', '--no-context-files', '--no-skills', '--no-prompt-templates', '--model', 'openai-codex/gpt-6.1-sol'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', stderr = '', response;
    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('Native Pi initialization timed out')); }, 15000);
    proc.stderr.on('data', data => { stderr += data; });
    proc.stdout.on('data', data => {
      buffer += data.toString(); let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        let item; try { item = JSON.parse(buffer.slice(0, index)); } catch { /* Native protocol diagnostics are checked below. */ }
        buffer = buffer.slice(index + 1);
        if (item?.type === 'response' && item.id === 'state') { response = item; proc.stdin.end(); }
      }
    });
    proc.on('error', reject);
    proc.on('close', code => { clearTimeout(timer); if (code !== 0 || !response?.success) reject(new Error(`Native Pi initialization failed (exit ${code}; no model called). ${stderr.slice(0,500)}`)); else resolve(response.data); });
    proc.stdin.write(JSON.stringify({ id: 'state', type: 'get_state' }) + '\n');
  });
}

test('native discovery covers principal and old worktree; migration preserves settings and ordinary updates', { timeout: 240000 }, async t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-trace-native-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'consumer'), old = path.join(sandbox, 'old-worktree'), home = path.join(sandbox, 'home');
  const agent = path.join(home, '.pi/agent'), claude = path.join(home, '.claude');
  for (const dir of [root, home, agent, claude, path.join(root, '.pi/extensions')]) fs.mkdirSync(dir, { recursive: true });
  const exec = (command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 120000, ...options });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  exec('git', ['init', '-q']); exec('git', ['config', 'user.email', 'brain-test@example.invalid']); exec('git', ['config', 'user.name', 'Brain Test']);
  fs.writeFileSync(path.join(root, 'README.md'), 'Synthetic native discovery fixture.\n');
  // Same factory-time kill switch as the legacy plugin, without its SDK or
  // credentials. This proves suppression ordering without exporting content.
  fs.writeFileSync(path.join(root, '.pi/extensions/legacy-test.js'), `const fs=require('node:fs'); module.exports=function(){fs.appendFileSync(process.env.BRAIN_TEST_LOAD_ORDER_FILE,process.env.LANGFUSE_TRACING_ENABLED==='false'?'disabled\\n':'UNSAFE\\n');};\n`);
  exec('git', ['add', '.']); exec('git', ['commit', '-qm', 'synthetic old base']);
  exec('git', ['worktree', 'add', '--detach', old, 'HEAD']);
  t.after(() => spawnSync('git', ['worktree', 'remove', '--force', old], { cwd: root, encoding: 'utf8' }));
  const trust = { [fs.realpathSync(root)]: true, [fs.realpathSync(old)]: true };
  fs.writeFileSync(path.join(agent, 'trust.json'), JSON.stringify(trust));
  const globalSettings = { env: { KEEP_NATIVE_TEST_SETTING: 'preserve' } };
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify(globalSettings));
  fs.writeFileSync(path.join(root, '.pi/settings.json'), JSON.stringify({ theme: 'dark', packages: [] }));
  fs.mkdirSync(path.join(root, '.claude'));
  const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'echo preserve-test-hook' }] }] };
  fs.writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify({ hooks, env: { KEEP_ME: 'preserve' }, enabledPlugins: { 'keep-disabled@example': false } }));
  fs.writeFileSync(path.join(root, '.env'), 'PRESERVE_ME=private-test-placeholder\n');
  fs.writeFileSync(path.join(root, '.claude/settings.local.json'), JSON.stringify({ env: { KEEP_LOCAL: 'preserve' } }));
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, CLAUDE_CONFIG_DIR: claude,
    BRAIN_TRACE_STATE_DIR: path.join(home, 'tracing-state'), BRAIN_TEST_LOAD_ORDER_FILE: path.join(home, 'factory-order.txt'),
    BRAIN_TRACING_ENABLED: 'true', LANGFUSE_TRACING_ENABLED: 'true' };
  for (const key of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL', 'LANGFUSE_HOST', 'BRAIN_TRACE_LAUNCH_ID']) delete env[key];
  const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const pull = args => exec(process.execPath, [path.join(__dirname, 'agent-brain.js'), 'pull', '--target', root, ...args], { env });
  for (let i = 0; i < 2; i++) {
    pull(['--langfuse', '--worktree-bootstrap']);
    const pi = json(path.join(root, '.pi/settings.json'));
    assert.equal(pi.theme, 'dark'); assert.equal(pi.extensions.filter(entry => entry === '../.agent-brain/observability/pi.js').length, 1);
    const settings = json(path.join(root, '.claude/settings.json'));
    assert.deepEqual(settings.hooks.Stop[0], hooks.Stop[0]); assert.deepEqual(settings.env, { KEEP_ME: 'preserve' });
    assert.equal(settings.enabledPlugins['keep-disabled@example'], false); assert.equal(settings.enabledPlugins[LEGACY_CLAUDE_PLUGIN], false);
    assert.equal(settings.hooks.Stop.filter(entry => entry.hooks.some(hook => hook.command === CLAUDE_HOOK_COMMAND)).length, 1);
  }
  const before = ['.pi/settings.json', '.claude/settings.json', '.claude/settings.local.json', '.env', '.agent-brain/tracing.json'].map(rel => [rel, fs.readFileSync(path.join(root, rel), 'utf8')]);
  pull([]);
  for (const [rel, contents] of before) assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), contents);
  const state = json(path.join(root, '.agent-brain/install-state.json'));
  assert.ok(state.files.some(file => file.path === '.agent-brain/observability/pi.js'));
  assert.ok(!state.files.some(file => ['.pi/settings.json', '.claude/settings.json', '.agent-brain/tracing.json'].includes(file.path)));
  assert.deepEqual(json(path.join(claude, 'settings.json')), globalSettings);
  assert.deepEqual(json(path.join(agent, 'trust.json')), trust);
  // Instrument only this temporary installed fixture: discovery must not even
  // evaluate the principal adapter when the old worktree explicitly refuses.
  const adapterPath = path.join(root, '.agent-brain/observability/pi.js');
  const loads = path.join(home, 'adapter-loads.txt');
  fs.writeFileSync(adapterPath, fs.readFileSync(adapterPath, 'utf8').replace("'use strict';",
    `'use strict';\nrequire('node:fs').appendFileSync(${JSON.stringify(loads)}, 'loaded\\n');`));
  await rpc(root, env);
  await rpc(old, env);
  assert.equal(fs.readFileSync(loads, 'utf8').split('\n').filter(Boolean).length, 2);
  assert.ok(!fs.existsSync(path.join(root, '.agent-brain/observability/node_modules')), 'native startup must not install SDKs into the managed runtime');
  const order = fs.readFileSync(env.BRAIN_TEST_LOAD_ORDER_FILE, 'utf8');
  assert.ok(!order.includes('UNSAFE'), 'legacy factory must never enable itself in an opted-in worktree');
  assert.ok(order.split('\n').filter(Boolean).length >= 2);
  assert.ok(!fs.existsSync(path.join(old, '.agent-brain/observability')), 'old worktree must use trusted principal bootstrap, not new copied files');
  const marker = path.join(old, '.agent-brain/tracing.json');
  const subdir = path.join(old, 'nested/deeper');
  fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.mkdirSync(subdir, { recursive: true });
  const baselineLoads = fs.readFileSync(loads, 'utf8');
  for (const declaration of [JSON.stringify({ schema: 1, enabled: false, captureMode: 'metadata-only' }), '{']) {
    fs.writeFileSync(marker, declaration);
    for (const cwd of [old, subdir]) {
      await rpc(cwd, env);
      assert.equal(fs.readFileSync(loads, 'utf8'), baselineLoads, 'explicit refusal must not evaluate principal runtime');
    }
  }
  // Removing the declaration restores supported old-base fallback.
  fs.rmSync(marker);
  await rpc(subdir, env);
  assert.equal(fs.readFileSync(loads, 'utf8'), baselineLoads + 'loaded\n');
});
