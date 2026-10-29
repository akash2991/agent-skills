'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { METADATA_CAPTURE_POLICY, FULL_CAPTURE_POLICY } = require('../../runtime/langfuse/bootstrap.js');

const RUNTIME_PATH = '.agent-brain/observability';
const LEGACY_PI_PACKAGE = 'npm:@langfuse/pi-observability-plugin@0.1.2';
const LEGACY_CLAUDE_PLUGIN = 'langfuse-observability@langfuse-observability';
const CLAUDE_HOOK_COMMAND = 'node "$HOME/.cache/agent-brain/bootstrap/bootstrap-claude.cjs"';
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'SessionEnd', 'PostModelSwitch'];
const OLD_PI = /^npm:@langfuse\/pi-observability-plugin(?:@|$)/;
const OLD_CLAUDE = /^langfuse-observability@/;
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const sourceOf = entry => typeof entry === 'string' ? entry : entry?.source;

function readSettings(file, missingValue = {}) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe native settings');
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('Native settings must contain valid JSON (contents omitted)'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Native settings must be an object');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return missingValue;
    throw error;
  }
}

function checkNativeSettings(target, options = {}) {
  for (const rel of ['.pi', '.claude', '.agent-brain']) {
    const file = path.join(target, rel);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe harness/settings path');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const pi = readSettings(path.join(target, '.pi/settings.json'));
  const claude = readSettings(path.join(target, '.claude/settings.json'));
  const local = readSettings(path.join(target, '.claude/settings.local.json'));
  if (pi.packages !== undefined && !Array.isArray(pi.packages)) throw new Error('Pi packages must be an array');
  for (const settings of [claude, local]) {
    for (const key of ['enabledPlugins', 'hooks']) if (settings[key] !== undefined && (!settings[key] || typeof settings[key] !== 'object' || Array.isArray(settings[key]))) throw new Error('Invalid Claude plugin/hook settings');
  }
  if (Object.entries(local.enabledPlugins || {}).some(([key, enabled]) => OLD_CLAUDE.test(key) && enabled === true)) {
    throw new Error('Legacy Claude Langfuse is enabled by a local override. Disable that exporter before tracing setup.');
  }
  const home = options.home || os.homedir();
  const agentDir = options.agentDir || process.env.PI_CODING_AGENT_DIR || path.join(home, '.pi/agent');
  const globalPi = readSettings(path.join(agentDir, 'settings.json'));
  const globalClaude = readSettings(path.join(options.claudeDir || process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'));
  for (const settings of [pi, globalPi]) {
    for (const key of ['packages', 'extensions']) if (settings[key] !== undefined && !Array.isArray(settings[key])) throw new Error('Invalid Pi resource settings');
    if ((settings.packages || []).some(entry => typeof sourceOf(entry) !== 'string')) throw new Error('Invalid Pi package entry');
  }
  for (const settings of [pi, globalPi]) if ((settings.extensions || []).some(value => typeof value === 'string' && !value.startsWith('-') && value.includes('@langfuse/pi-observability-plugin'))) {
    throw new Error('A direct legacy Pi Langfuse extension conflicts with protected tracing. Disable it explicitly first.');
  }
  for (const settings of [claude, local, globalClaude]) {
    for (const entries of Object.values(settings.hooks || {})) {
      if (!Array.isArray(entries)) throw new Error('Invalid native hook collection');
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) throw new Error('Invalid native hook handler');
        for (const hook of entry.hooks) if (typeof hook.command === 'string' && /langfuse_hook\.py/.test(hook.command)) {
          throw new Error('A legacy Python Langfuse hook conflicts with protected tracing. Remove it explicitly first.');
        }
      }
    }
  }
  return { pi, claude, local, globalPi, globalClaude, home, agentDir };
}

// Validate before asset pulls, dependency preparation or native registration.
// Existing refusal stays a refusal; choosing a policy never clears enabled:false.
function planLangfuseMarker(target, options = {}) {
  if (options.captureMode !== undefined && !['metadata-only', 'full-content'].includes(options.captureMode)) {
    throw new Error('Invalid capture mode; expected metadata-only or full-content.');
  }
  const old = readSettings(path.join(target, '.agent-brain/tracing.json'), null);
  if (old) {
    const expected = old.schema === 1 ? METADATA_CAPTURE_POLICY : old.schema === 2 ? FULL_CAPTURE_POLICY : null;
    if (!expected || typeof old.enabled !== 'boolean'
      || Object.entries(expected).some(([key, value]) => key !== 'enabled' && old[key] !== value)
      || Object.keys(old).some(key => !Object.hasOwn(expected, key) && key !== 'runtime')
      || (old.runtime !== undefined && ![RUNTIME_PATH, 'runtime/langfuse'].includes(old.runtime))) {
      throw new Error('Invalid or unsupported tracing marker; reconcile explicitly before setup (contents omitted).');
    }
  }
  const mode = options.captureMode || old?.captureMode || 'metadata-only';
  return { ...(mode === 'full-content' ? FULL_CAPTURE_POLICY : METADATA_CAPTURE_POLICY),
    enabled: old?.enabled !== false, runtime: old?.runtime || RUNTIME_PATH };
}

function preflightLangfuse(target, run = spawnSync, options = {}) {
  checkNativeSettings(target, options);
  planLangfuseMarker(target, options);
  for (const [command, label] of [['pi', 'Pi'], ['claude', 'Claude Code']]) {
    const result = run(command, ['--version'], { cwd: target, encoding: 'utf8', timeout: 10000 });
    if (result.error || result.status !== 0) throw new Error(`--langfuse requires ${label} on PATH. No brain files were changed.`);
    const version = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(result.stdout || '');
    const minimum = command === 'pi' ? [1, 3, 0] : [2, 1, 304];
    const actual = version && version.slice(1).map(Number);
    if (!actual || actual[0] < minimum[0] || (actual[0] === minimum[0] && (actual[1] < minimum[1] || (actual[1] === minimum[1] && actual[2] < minimum[2])))) {
      throw new Error(`Protected tracing requires ${label} ${minimum.join('.')} or newer. No brain files were changed.`);
    }
  }
}

function privateDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== 'win32' && stat.mode & 0o077)) throw new Error('Unsafe private tracing cache');
  return dir;
}

function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o644;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe native settings path');
    mode = stat.mode & 0o777;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: 'wx' });
  fs.renameSync(temp, file);
}

function prepareCache(target, settings, run, options) {
  const runtime = path.join(target, RUNTIME_PATH);
  for (const file of ['package.json', 'package-lock.json', 'pi.js', 'claude.cjs', 'bootstrap.js', 'bootstrap-claude.cjs']) {
    const stat = fs.lstatSync(path.join(runtime, file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Brain tracing runtime is incomplete; pull updated assets before setup.');
  }
  const { dependencyCacheDir } = require(path.join(runtime, 'dependencies.cjs'));
  const cache = privateDir(options.dependencyRoot || dependencyCacheDir({ home: settings.home }));
  const lock = fs.readFileSync(path.join(runtime, 'package-lock.json'));
  const fingerprint = hash(lock);
  let ready;
  try { ready = JSON.parse(fs.readFileSync(path.join(cache, 'brain-ready.json'), 'utf8')).fingerprint === fingerprint
    && fs.readFileSync(path.join(cache, 'package-lock.json')).equals(lock)
    && fs.readFileSync(path.join(cache, 'package.json')).equals(fs.readFileSync(path.join(runtime, 'package.json')))
    && fs.existsSync(path.join(cache, 'node_modules/@langfuse/otel/package.json')); } catch { ready = false; }
  if (!ready) {
    fs.copyFileSync(path.join(runtime, 'package.json'), path.join(cache, 'package.json'));
    fs.copyFileSync(path.join(runtime, 'package-lock.json'), path.join(cache, 'package-lock.json'));
    const result = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: cache, encoding: 'utf8', timeout: 120000 });
    if (result.error || result.status !== 0) throw new Error('Brain files installed, but protected tracing dependencies failed. No native tracing registration was changed; retry setup.');
    atomicJSON(path.join(cache, 'brain-ready.json'), { schema: 1, fingerprint });
    fs.chmodSync(path.join(cache, 'brain-ready.json'), 0o600);
  }
  const bootstrap = privateDir(path.join(settings.home, '.cache/agent-brain/bootstrap'));
  for (const file of ['bootstrap.js', 'bootstrap-claude.cjs', 'brain-trace.cjs']) {
    const dest = path.join(bootstrap, file);
    try { if (fs.lstatSync(dest).isSymbolicLink()) throw new Error('Unsafe bootstrap cache'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.writeFileSync(dest, fs.readFileSync(path.join(runtime, file)), { mode: 0o600 });
    fs.chmodSync(dest, 0o600);
  }
  atomicJSON(path.join(bootstrap, 'package.json'), { name: 'agent-brain-worktree-bootstrap', version: '1.0.0', private: true, pi: { extensions: ['./bootstrap.js'] } });
  fs.chmodSync(path.join(bootstrap, 'package.json'), 0o600);
  return { cache, bootstrap };
}

function installLangfuse(target, run = spawnSync, options = {}) {
  const settings = checkNativeSettings(target, options);
  const markerPolicy = planLangfuseMarker(target, options);
  const { bootstrap } = prepareCache(target, settings, run, options);
  const runtimeSource = '../.agent-brain/observability';
  const packages = (settings.pi.packages || []).filter(entry => {
    const source = sourceOf(entry);
    return !(typeof source === 'string' && (OLD_PI.test(source) || source === runtimeSource || source === './.agent-brain/observability'));
  });
  if ((settings.globalPi.packages || []).some(entry => OLD_PI.test(sourceOf(entry)))) {
    packages.push({ source: LEGACY_PI_PACKAGE, autoload: false, extensions: [], skills: [], prompts: [], themes: [] });
  }
  const extension = '../.agent-brain/observability/pi.js';
  const extensions = (settings.pi.extensions || []).filter(value => value !== extension && value !== './.agent-brain/observability/pi.js');
  extensions.push(extension);
  // Register a native extension file, not the SDK package directory: Pi's
  // local-package resolver otherwise installs SDK dependencies at startup.
  const pi = { ...settings.pi, packages, extensions };
  const disabled = { ...settings.claude.enabledPlugins, [LEGACY_CLAUDE_PLUGIN]: false };
  for (const key of [...Object.keys(settings.globalClaude.enabledPlugins || {}), ...Object.keys(disabled)]) if (OLD_CLAUDE.test(key)) disabled[key] = false;
  const hooks = structuredClone(settings.claude.hooks || {});
  for (const event of HOOK_EVENTS) {
    const other = (hooks[event] || []).map(entry => ({ ...entry, hooks: (entry.hooks || []).filter(hook => hook.command !== CLAUDE_HOOK_COMMAND) })).filter(entry => entry.hooks.length);
    other.push({ hooks: [{ type: 'command', command: CLAUDE_HOOK_COMMAND, timeout: event === 'SessionEnd' ? 10 : 8 }] });
    hooks[event] = other;
  }
  const claude = { ...settings.claude, enabledPlugins: disabled, hooks };
  const marker = path.join(target, '.agent-brain/tracing.json');
  atomicJSON(path.join(target, '.pi/settings.json'), pi);
  atomicJSON(path.join(target, '.claude/settings.json'), claude);
  atomicJSON(marker, markerPolicy);
  if (options.worktreeBootstrap) {
    for (const entry of settings.globalPi.packages || []) {
      const source = sourceOf(entry);
      if (typeof source === 'string' && OLD_PI.test(source)) {
        const removed = run('pi', ['remove', source], { cwd: target, encoding: 'utf8', timeout: 120000 });
        if (removed.error || removed.status !== 0) throw new Error('Project tracing configured, but legacy user-level exporter removal failed. Do not claim safe worktree tracing; reconcile native Pi packages.');
      }
    }
    const installed = run('pi', ['install', bootstrap], { cwd: target, encoding: 'utf8', timeout: 120000 });
    if (installed.error || installed.status !== 0) throw new Error('Project tracing configured, but the explicit user-level worktree bootstrap failed. Retry --langfuse --worktree-bootstrap after native Pi reconciliation.');
  }
  const policyNotice = markerPolicy.captureMode === 'full-content'
    ? 'Full-content consent: available prompt/response/tool JSON includes PII. Credential redaction is best effort, not a guarantee. Private durable content may retry after marker removal/downgrade; kill switches stop delivery. Limits and unavailable native fields apply.'
    : 'Metadata-only policy: new prompt/response/tool bodies are not captured. Previously consented content may still retry; kill switches stop delivery.';
  return `Brain tracing: first-party Pi extension and Claude hooks registered; ${markerPolicy.enabled ? markerPolicy.captureMode : `disabled (configured ${markerPolicy.captureMode}; existing refusal preserved)`}.\n${policyNotice}\nLegacy project exporters are disabled; no credentials were copied.\n${options.worktreeBootstrap ? 'Explicit project-gated Pi user bootstrap installed for old worktree bases; known legacy user package removed if present.' : 'For old worktree bases without the adapter, explicitly add --worktree-bootstrap (changes native Pi user package registration).'}\nConfigure shared private credentials and restart both harnesses. Registration/transport acceptance is not proof of Langfuse ingestion.\nDisable both adapters for a run with BRAIN_TRACING_ENABLED=false.`;
}

module.exports = { RUNTIME_PATH, LEGACY_PI_PACKAGE, LEGACY_CLAUDE_PLUGIN, CLAUDE_HOOK_COMMAND, HOOK_EVENTS, checkNativeSettings, planLangfuseMarker, preflightLangfuse, installLangfuse };
