#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { findPolicySync } = require('./bootstrap.js');
const { resolveActor } = require('./context-cli.cjs');
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function parse(argv) {
  const boundary = argv.indexOf('--');
  if (boundary < 0) throw new Error('Explicit native argument boundary required.');
  const flags = {};
  for (let i = 0; i < boundary; i += 2) {
    if (!['--actor', '--harness', '--cwd'].includes(argv[i]) || i + 1 >= boundary || !argv[i + 1] || argv[i + 1].startsWith('--') || Object.hasOwn(flags, argv[i])) throw new Error('Invalid exec option.');
    flags[argv[i]] = argv[i + 1];
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(flags['--actor'] || '') || !['pi', 'claude'].includes(flags['--harness'])) throw new Error('Explicit actor and harness required.');
  const args = argv.slice(boundary + 1);
  validateNativeArgs(flags['--harness'], args);
  return { actor: flags['--actor'], harness: flags['--harness'], cwd: flags['--cwd'], args };
}

function validateNativeArgs(harness, args) {
  // Resource/session selectors could replace the adapter or its exact fresh
  // identity. Do not turn this helper into a configuration/permission bypass.
  const common = new Set(['--cwd', '-C', '--session-id', '--session', '--session-dir', '--continue', '-c', '--resume', '-r', '--fork', '--no-session', '--settings', '--setting-sources', '--plugin-dir', '--disable-hooks', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode', '--api-key']);
  const specific = new Set(harness === 'pi'
    ? ['-e', '--extension', '-ne', '--no-extensions', '--brain-tracing', '--export', '--approve', '-a']
    : ['--fork-session', '--no-session-persistence', '--bare', '--remote', '--teleport', '--from-pr', '--resume-session-at', '--worktree', '-w', '--tmux', '--agent-id']);
  // Native -- ends native option parsing too; literal prompts thereafter are
  // preserved, including words which happen to look like reserved flags.
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.includes('\0')) throw new Error('Invalid native argument.');
  }
  for (const arg of args) {
    if (arg === '--') break;
    const name = arg.split('=', 1)[0];
    if (common.has(name) || specific.has(name) || /^-[cr].+/.test(arg) || (harness === 'pi' && /^-e.+/.test(arg)) || (harness === 'claude' && /^-w.+/.test(arg))) throw new Error('Native session/resource override refused.');
  }
  if (['install', 'remove', 'uninstall', 'update', 'config', 'auth', 'mcp', 'list'].includes(args[0])) throw new Error('Native session invocation required.');
}

function assertTarget(cwd, env) {
  if (['BRAIN_TRACING_ENABLED', 'LANGFUSE_TRACING_ENABLED'].some(key => ['false', '0'].includes(String(env[key] || '').toLowerCase()))) throw new Error('Tracing disabled.');
  if (!fs.statSync(cwd).isDirectory() || findPolicySync(cwd) === null) throw new Error('Target tracing policy refused.');
  // Absence is deliberate per-run consent, not persistent opt-in. Native
  // project trust still governs project resources; no approval flag is added.
}

const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
function claudeSettings(sessionId, cwd) {
  // Only generated identities and local code paths enter the native hook
  // command string. Native user arguments never pass through a shell.
  const command = [process.execPath, __filename, '--claude-hook', sessionId, cwd].map(quote).join(' ');
  const hooks = {};
  for (const event of require('./claude.cjs').HOOK_EVENTS) {
    hooks[event] = [{ hooks: [{ type: 'command', command, timeout: 10 }] }];
  }
  return { hooks, enabledPlugins: { 'langfuse-observability@langfuse-observability': false } };
}

async function exec(argv, options = {}) {
  const flags = parse(argv);
  const env = options.env || process.env;
  const cwd = fs.realpathSync(path.resolve(flags.cwd || options.cwd || process.cwd()));
  assertTarget(cwd, env);
  const flow = options.flow || require('./flow.cjs').createFlow({ harness: 'pi', cwd: options.cwd || process.cwd(), env });
  const { current } = resolveActor(flow, flags.actor, env);
  const nativeSessionId = crypto.randomUUID();
  const binding = flow.store.createLaunch(current, { launchId: `brain:${flags.harness}:${nativeSessionId}` });
  flow.writeState(`native-launch:${flags.harness}:${nativeSessionId}`, { nonce: binding.nonce });
  const native = ['--session-id', nativeSessionId];
  if (flags.harness === 'pi') native.push('-e', path.join(__dirname, 'pi.js'), '--brain-tracing');
  else native.push('--settings', JSON.stringify(claudeSettings(nativeSessionId, cwd)));
  native.push(...flags.args);
  const childEnv = { ...env };
  // A startup nonce/stock subagent identity from the caller is not the new
  // actor's identity. The durable exact native-session mapping wins instead.
  for (const key of ['BRAIN_TRACE_LAUNCH_ID', 'PI_SUBAGENT_ID', 'PI_SUBAGENT_SESSION', 'PI_SUBAGENT_AGENT', 'PI_SUBAGENT_NAME']) delete childEnv[key];
  return new Promise((resolve, reject) => {
    let child;
    try { child = (options.spawn || spawn)(flags.harness, native, { cwd, env: childEnv, stdio: 'inherit', shell: false }); }
    catch { reject(new Error('Native traced process could not start.')); return; }
    const handlers = new Map(SIGNALS.map(signal => [signal, () => { try { child.kill(signal); } catch {} }]));
    const cleanup = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
    for (const [signal, handler] of handlers) process.on(signal, handler);
    child.once('error', error => { cleanup(); resolve({ code: error.code === 'ENOENT' ? 127 : 126, signal: null }); });
    child.once('close', (code, signal) => { cleanup(); resolve({ code, signal }); });
  });
}

async function claudeHook(sessionId, cwd, options = {}) {
  try {
    if (!/^[a-f0-9-]{36}$/.test(sessionId || '')) return null;
    const env = options.env || process.env;
    assertTarget(cwd, env);
    const payload = await require('./claude-hook.cjs').readPayload(options.input || process.stdin);
    if (payload?.session_id !== sessionId || typeof payload.cwd !== 'string') return null;
    assertTarget(payload.cwd, env);
    // The native settings belong only to this run. The adapter reads the exact
    // mapping; native children retain their independent pending identities.
    return await require('./claude.cjs').handleClaudeHook(payload, { env, ...options });
  } catch { return null; } // Telemetry must not block native permission checks.
}

function exitWithResult(result) {
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 1;
}
if (require.main === module) {
  if (process.argv[2] === '--claude-hook') {
    claudeHook(process.argv[3], process.argv[4]).then(output => {
      if (output) process.stdout.write(JSON.stringify(output));
      process.exit(0);
    }, () => process.exit(0));
  } else {
    exec(process.argv.slice(2)).then(exitWithResult).catch(() => { console.error('Traced exec refused or unavailable; no context was guessed.'); process.exitCode = 1; });
  }
}
module.exports = { exec, parse, assertTarget, claudeSettings, claudeHook, exitWithResult };
