'use strict';

// Explicit opt-in integration suite: uses installed CLIs and downloads upstream
// plugins. No model calls or Langfuse credentials are required. All config and
// trust stores are temporary; never alter the user's saved trust decisions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { CLAUDE_PLUGIN, CLAUDE_VERSION, LANGFUSE_PACKAGE } = require('./lib/langfuse');

test('both native managers preserve consumer settings, hooks, secrets, and repeatability', { timeout: 240000 }, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-langfuse-native-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'consumer');
  const pi = path.join(sandbox, 'pi-agent');
  const claude = path.join(sandbox, 'claude-config');
  for (const dir of [path.join(root, '.pi'), path.join(root, '.claude'), pi, claude]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(pi, 'trust.json'), JSON.stringify({ [fs.realpathSync(root)]: true }));
  const globalSettings = { env: { KEEP_NATIVE_TEST_SETTING: 'preserve' } };
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify(globalSettings));
  fs.writeFileSync(path.join(root, '.pi/settings.json'), JSON.stringify({ theme: 'dark', packages: [], defaultThinkingLevel: 'low' }));
  const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'echo preserve-test-hook' }] }] };
  fs.writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify({ hooks, env: { KEEP_ME: 'preserve' }, enabledPlugins: { 'keep-disabled@example': false } }));
  fs.writeFileSync(path.join(root, '.env'), 'PRESERVE_ME=private-test-placeholder\n');
  fs.writeFileSync(path.join(root, '.claude/settings.local.json'), JSON.stringify({ env: { KEEP_LOCAL: 'preserve' } }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: pi, CLAUDE_CONFIG_DIR: claude };
  const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const run = args => {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'agent-brain.js'), 'pull', '--target', root, ...args], {
      env, encoding: 'utf8', timeout: 120000
    });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  for (let i = 0; i < 2; i++) {
    run(['--langfuse']);
    const piSettings = json(path.join(root, '.pi/settings.json'));
    assert.equal(piSettings.theme, 'dark');
    assert.equal(piSettings.defaultThinkingLevel, 'low');
    assert.deepEqual(piSettings.packages, [LANGFUSE_PACKAGE]);
    const settings = json(path.join(root, '.claude/settings.json'));
    assert.deepEqual(settings.hooks, hooks);
    assert.deepEqual(settings.env, { KEEP_ME: 'preserve' });
    assert.equal(settings.enabledPlugins[CLAUDE_PLUGIN], true);
    assert.equal(settings.enabledPlugins['keep-disabled@example'], false);
    assert.equal(settings.extraKnownMarketplaces['langfuse-observability'].source.ref, `v${CLAUDE_VERSION}`);
  }
  const before = ['.pi/settings.json', '.claude/settings.json', '.claude/settings.local.json', '.env'].map(rel => [rel, fs.readFileSync(path.join(root, rel), 'utf8')]);
  run([]);
  for (const [rel, contents] of before) assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), contents);
  const state = json(path.join(root, '.agent-brain/install-state.json'));
  assert.ok(!state.files.some(f => ['.pi/settings.json', '.claude/settings.json'].includes(f.path) || f.path.startsWith('.pi/npm/')));
  assert.deepEqual(json(path.join(claude, 'settings.json')), globalSettings, 'do not globally enable a plugin');
  assert.deepEqual(json(path.join(pi, 'trust.json')), { [fs.realpathSync(root)]: true }, 'do not change even isolated trust decisions');
});
