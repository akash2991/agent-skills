#!/usr/bin/env node
'use strict';

// Shared by context, pane and subprocess helpers. An explicit invalid/expired
// actor never falls back to ambient state or another native session.
function resolveActor(flow, explicit, env = process.env) {
  const nonce = explicit === undefined ? env.BRAIN_TRACE_LAUNCH_ID : explicit;
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(nonce || '')) throw new Error('Exact brain actor capability required.');
  const actor = flow.actorForTool(nonce);
  if (!actor) throw new Error('Brain actor unavailable or expired; no context was guessed.');
  const resolved = flow.resolve(actor);
  // Pending native children may edit only their own metadata or prebind a
// descendant that remains deferred. This does not authorize export.
  return { nonce, current: resolved || actor, resolved };
}

function runContext(argv, options = {}) {
  const env = options.env || process.env;
  let explicit;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--actor') { rest.push(argv[i]); continue; }
    if (explicit !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('One explicit actor value required.');
    explicit = argv[++i];
  }
  const flow = options.flow || require('./flow.cjs').createFlow({ harness: 'pi', cwd: options.cwd || process.cwd(), env });
  const { current, resolved } = resolveActor(flow, explicit, env);
  const [command = 'status', ...args] = rest;
  let run = current;
  if (command === 'set') {
    const values = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--persona', '--ticket'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Expected non-secret --persona and/or --ticket identifiers.');
      if (Object.hasOwn(values, args[i])) throw new Error('Duplicate brain context option.');
      values[args[i]] = args[i + 1];
    }
    const persona = values['--persona'] || run.persona || 'unknown';
    const ticket = values['--ticket'];
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(persona) || (ticket && !/^[A-Z][A-Z0-9]{1,15}-[1-9]\d*$/.test(ticket))) throw new Error('Invalid non-secret brain context identifier.');
    if (values['--persona'] && flow.knownPersona && !flow.knownPersona(options.cwd || process.cwd(), persona)) throw new Error('Persona was not found in the installed brain; it was not attributed.');
    run = flow.captureBrainCommand(run, { commandName: 'brain', commandArgs: `${persona}${ticket ? ` --ticket ${ticket}` : ''}`, cwd: options.cwd || process.cwd() });
    if (values['--persona'] && run.persona !== persona) throw new Error('Persona was not found in the installed brain; it was not attributed.');
  } else if (command !== 'status' || args.length) throw new Error('Usage: context-cli.cjs [--actor NONCE] status | set [--persona name] [--ticket TEAM-123]');
  return { captureMode: 'metadata-only', harness: run.harness, project: run.projectName, projectId: run.projectId,
    persona: run.persona || 'UNKNOWN', ticketId: run.ticketId || 'UNKNOWN', ticketSource: run.ticketSource || 'unknown',
    runtimeName: run.runtimeName, agentName: run.agentName, sessionId: resolved ? run.sessionId : 'UNKNOWN', nativeSessionId: run.nativeSessionId, ancestryPending: !resolved,
    skillsInvoked: run.skillsInvoked || [], skillsLoaded: run.skillsLoaded || [], health: flow.readState?.('health') || { lineageLossObserved: false }, delivery: flow.readState?.('delivery') || null };
}

if (require.main === module) {
  try { console.log(JSON.stringify(runContext(process.argv.slice(2)), null, 2)); }
  catch { console.error('Brain context unavailable or invalid. Use an instrumented harness and non-secret persona/ticket identifiers.'); process.exitCode = 1; }
}
module.exports = { runContext, resolveActor };
