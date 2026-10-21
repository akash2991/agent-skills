#!/usr/bin/env node
'use strict';

function runContext(argv, options = {}) {
  const env = options.env || process.env;
  const nonce = env.BRAIN_TRACE_LAUNCH_ID;
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(nonce || '')) throw new Error('No exact active brain launch binding. Run this operation inside an instrumented harness tool.');
  const flow = options.flow || require('./flow.cjs').createFlow({ harness: 'pi', cwd: options.cwd || process.cwd(), env });
  const binding = flow.store.resolveLaunch({ nonce });
  const resolved = binding && flow.resolve(binding.parent);
  // A native Claude child may not know its caller until its Agent tool returns.
  // It can still update its own metadata through an exact tool-minted actor
  // capability; this does not unblock lineage or observation export.
  const current = resolved || flow.actorForTool?.(nonce);
  if (!current) throw new Error('Active brain context is unresolved; no context was guessed.');
  const [command = 'status', ...args] = argv;
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
  } else if (command !== 'status' || args.length) throw new Error('Usage: context-cli.cjs status | set [--persona name] [--ticket TEAM-123]');
  return { captureMode: 'metadata-only', harness: run.harness, project: run.projectName, projectId: run.projectId,
    persona: run.persona || 'UNKNOWN', ticketId: run.ticketId || 'UNKNOWN', ticketSource: run.ticketSource || 'unknown',
    runtimeName: run.runtimeName, agentName: run.agentName, sessionId: resolved ? run.sessionId : 'UNKNOWN', nativeSessionId: run.nativeSessionId, ancestryPending: !resolved,
    skillsInvoked: run.skillsInvoked || [], skillsLoaded: run.skillsLoaded || [], health: flow.readState?.('health') || { lineageLossObserved: false }, delivery: flow.readState?.('delivery') || null };
}

if (require.main === module) {
  try { console.log(JSON.stringify(runContext(process.argv.slice(2)), null, 2)); }
  catch { console.error('Brain context unavailable or invalid. Use an instrumented harness and non-secret persona/ticket identifiers.'); process.exitCode = 1; }
}
module.exports = { runContext };
