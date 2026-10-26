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

// A deliberately bounded caller grammar, not a forwarding proxy for arbitrary
// native/extension options. Unknown options fail closed, including all session,
// trust, permission, MCP, plugin and resource-loading controls and their aliases.
// Built-in --tools selects tools, not permission grants; native authorization
// still applies. Generated adapter/session options are added only AFTER parse().
const NATIVE_GRAMMAR = {
  pi: {
    flags: new Set(['--print', '-p', '--verbose', '--offline', '--no-tools', '-nt', '--no-builtin-tools', '-nbt', '--no-mcp', '--no-skills', '-ns', '--no-prompt-templates', '-np', '--no-context-files', '-nc', '--no-themes', '--help', '-h', '--version', '-v']),
    values: new Set(['--provider', '--model', '--models', '--thinking', '--mode', '--name', '-n', '--system-prompt', '--append-system-prompt', '--tools', '-t', '--exclude-tools', '-xt', '--tui-mode'])
  },
  claude: {
    flags: new Set(['--print', '-p', '--verbose', '--include-partial-messages', '--include-hook-events', '--replay-user-messages', '--forward-subagent-text', '--disable-slash-commands', '--help', '-h', '--version', '-v']),
    values: new Set(['--model', '--fallback-model', '--effort', '--max-turns', '--max-budget-usd', '--output-format', '--input-format', '--json-schema', '--system-prompt', '--append-system-prompt', '--name', '-n', '--tools'])
  }
};
const ADMIN_COMMANDS = new Set(['install', 'remove', 'uninstall', 'update', 'config', 'auth', 'mcp', 'list', 'help', 'agents', 'attach', 'auto-mode', 'doctor', 'gateway', 'import', 'logs', 'plugin', 'plugins', 'purge', 'respawn', 'rm', 'setup-token', 'stop', 'kill', 'ultrareview', 'upgrade']);

function validateNativeArgs(harness, args) {
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.includes('\0')) throw new Error('Invalid native argument.');
  }
  const grammar = NATIVE_GRAMMAR[harness];
  let positionalSeen = false;
  const positional = arg => {
    // Reserve the first bare command word even after known options. To send
    // that word as a literal prompt, use native --. Never inspect prompt text.
    if (!positionalSeen && ADMIN_COMMANDS.has(arg)) throw new Error('Native session invocation required.');
    positionalSeen = true;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // This boundary is meaningful only at option position, not as the value
    // of a required-value option. Both native parsers consume those values.
    if (arg === '--') break;
    if (!arg.startsWith('-') || arg === '-') { positional(arg); continue; }
    if (grammar.flags.has(arg)) {
      // Pi's print flag consumes an optional message (including ---text), but
      // not an @file or another option. Claude's print flag is boolean only.
      const next = args[i + 1];
      if (harness === 'pi' && ['-p', '--print'].includes(arg) && next !== undefined && !next.startsWith('@') && (!next.startsWith('-') || next.startsWith('---'))) {
        positional(next); i++;
      }
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals < 0 ? arg : arg.slice(0, equals);
    // Pi 1.3 parses built-in values only in split form, whereas Claude's long
    // value options also accept =value. No short clusters/attached values are
    // supported, even when a particular native version would expand them.
    if (!grammar.values.has(name) || (equals >= 0 && (harness !== 'claude' || !name.startsWith('--')))) throw new Error('Native session/resource override or unsupported option refused.');
    if (equals < 0) {
      if (i + 1 === args.length) throw new Error('Native option value required.');
      const value = args[++i];
      // These Pi options do not consume a flag-looking invalid value. Do not
      // accidentally hide a following override in a parser-disagreement gap.
      if (harness === 'pi' && ((name === '--mode' && !['text', 'json', 'rpc'].includes(value)) || (name === '--tui-mode' && !['regular', 'fullscreen'].includes(value)))) throw new Error('Unsupported native option value.');
      // Claude --tools is variadic in split form, but =value is not. Support
      // one comma-separated value only, followed by an option, --, or EOF;
      // otherwise a would-be prompt/command is actually another tool value.
      if (harness === 'claude' && name === '--tools' && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) throw new Error('Ambiguous native tool values refused; use a comma-separated value and native -- before prompts.');
    }
  }
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
