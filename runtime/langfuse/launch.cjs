#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function parse(argv) {
  const result = {};
  const allowed = new Set(['--pane', '--harness', '--name', '--cwd', '--model', '--effort', '--persona', '--ticket', '--parent-session', '--parent-harness', '--timeout']);
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--') || Object.hasOwn(result, argv[i])) throw new Error('Invalid launch option');
    result[argv[i]] = argv[i + 1];
  }
  if (!/^[a-zA-Z0-9_.:-]{1,120}$/.test(result['--pane'] || '') || !['pi', 'claude'].includes(result['--harness'])
    || !/^[a-z][a-z0-9_-]{0,31}$/.test(result['--name'] || '')) throw new Error('Explicit pane, harness and native agent name required');
  if (result['--persona'] && !/^[a-z][a-z0-9-]{0,79}$/.test(result['--persona'])) throw new Error('Invalid persona');
  if (result['--ticket'] && !/^[A-Z][A-Z0-9]{1,15}-[1-9]\d*$/.test(result['--ticket'])) throw new Error('Invalid ticket');
  if (result['--model'] && (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(result['--model']) || /(?:[sp]k-|:\/\/)/.test(result['--model']))) throw new Error('Invalid non-secret model identifier');
  if (result['--effort'] && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(result['--effort'])) throw new Error('Invalid effort');
  if (result['--timeout'] && (!/^\d+$/.test(result['--timeout']) || +result['--timeout'] < 1000 || +result['--timeout'] > 60000)) throw new Error('Invalid timeout');
  return result;
}

async function launch(argv, options = {}) {
  const flags = parse(argv);
  const env = options.env || process.env;
  if (env.HERDR_ENV !== '1') throw new Error('Herdr launch requires an existing Herdr session');
  const run = options.run || spawnSync;
  const harness = flags['--harness'];
  const cwd = path.resolve(flags['--cwd'] || process.cwd());
  const flow = options.flow || require('./flow.cjs').createFlow({ harness: flags['--parent-harness'] || 'pi', cwd, env });
  const binding = env.BRAIN_TRACE_LAUNCH_ID ? flow.store.resolveLaunch({ nonce: env.BRAIN_TRACE_LAUNCH_ID }) : null;
  const actor = env.BRAIN_TRACE_LAUNCH_ID && flow.actorForTool?.(env.BRAIN_TRACE_LAUNCH_ID);
  const parent = binding?.parent || actor || (flags['--parent-session'] && flow.store.getSession(flags['--parent-harness'] || 'pi', flags['--parent-session']));
  const resolvedParent = parent && flow.resolve(parent);
  const launchParent = resolvedParent || actor;
  if (!launchParent) throw new Error('Exact parent context required; no active-parent guesses');
  const info = run('herdr', ['pane', 'process-info', '--pane', flags['--pane']], { encoding: 'utf8', timeout: 5000, env });
  let pane;
  try { pane = JSON.parse(info.stdout).result.process_info; } catch { throw new Error('Unable to inspect target pane'); }
  if (info.status !== 0 || pane.pane_id !== flags['--pane'] || pane.foreground_processes?.length !== 1
    || pane.foreground_processes[0].pid !== pane.shell_pid) throw new Error('Target pane must be at an idle shell prompt');
  const actualCwd = pane.foreground_processes[0].cwd;
  if (typeof actualCwd !== 'string' || fs.realpathSync(actualCwd) !== fs.realpathSync(cwd)) throw new Error('Target pane cwd does not match the explicit launch cwd');
  if (flags['--persona']) {
    const role = path.join(cwd, harness === 'pi' ? '.pi/agents' : '.claude/agents', `${flags['--persona']}.md`);
    if (!fs.statSync(role).isFile()) throw new Error('Requested native persona is not installed in target worktree');
  }
  const sessionId = crypto.randomUUID();
  const child = flow.store.createLaunch(launchParent, { launchId: `brain:${harness}:${sessionId}`,
    child: { agentName: flags['--name'], ...(flags['--persona'] ? { persona: flags['--persona'] } : {}), ...(flags['--ticket'] ? { ticketId: flags['--ticket'] } : {}) } });
  flow.writeState(`pane:${child.nonce}`, { paneId: flags['--pane'], expiresAt: child.expiresAt,
    nativeSessionHash: crypto.createHash('sha256').update(sessionId).digest('hex') });
  flow.writeState(`native-launch:${harness}:${sessionId}`, { nonce: child.nonce });
  const native = ['--session-id', sessionId];
  if (flags['--model']) native.push('--model', flags['--model']);
  if (flags['--effort']) {
    const effort = harness === 'claude' && ['off', 'minimal'].includes(flags['--effort']) ? 'low' : flags['--effort'];
    native.push(harness === 'pi' ? '--thinking' : '--effort', effort);
  }
  if (harness === 'pi') {
    native.push('-e', path.join(__dirname, 'pi.js'));
    if (flags['--persona']) native.push('--append-system-prompt', path.join(cwd, '.pi/agents', `${flags['--persona']}.md`));
  } else {
    const command = 'node "$HOME/.cache/agent-brain/bootstrap/bootstrap-claude.cjs"';
    const hooks = {};
    for (const event of ['SessionStart', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'SessionEnd', 'PostModelSwitch']) {
      hooks[event] = [{ hooks: [{ type: 'command', command, timeout: 10 }] }];
    }
    native.push('--settings', JSON.stringify({ hooks, enabledPlugins: { 'langfuse-observability@langfuse-observability': false } }));
    if (flags['--persona']) native.push('--agent', flags['--persona']);
  }
  const timeout = +(flags['--timeout'] || 30000);
  const result = run('herdr', ['agent', 'start', flags['--name'], '--kind', harness, '--pane', flags['--pane'], '--timeout', String(timeout), '--', ...native], {
    encoding: 'utf8', timeout: timeout + 5000, env
  });
  if (result.error || result.status !== 0) return { status: 'startup-unconfirmed', paneId: flags['--pane'], harness, nativeSessionId: sessionId,
    note: 'Inspect the named pane for approval/startup state; do not blindly resubmit. No trace delivery is claimed.' };
  const ack = flow.readState(`launch-ack:${child.nonce}`);
  return { status: ack ? 'adapter-started' : 'native-ready-adapter-unconfirmed', paneId: flags['--pane'], harness,
    nativeSessionId: sessionId, sessionId: resolvedParent?.sessionId || 'UNKNOWN', traceId: resolvedParent?.traceId || 'UNKNOWN', ancestryPending: !resolvedParent,
    note: 'Native readiness/adapter acknowledgement is not proof of Langfuse ingestion. Prompt this agent through the normal Herdr agent surface.' };
}

if (require.main === module) {
  launch(process.argv.slice(2)).then(result => { console.log(JSON.stringify(result, null, 2)); if (result.status !== 'adapter-started') process.exitCode = 1; })
    .catch(() => { console.error('Traced launch refused or unavailable. Require an exact parent, an idle owned pane, matching cwd and valid non-secret options.'); process.exitCode = 1; });
}
module.exports = { launch, parse };
