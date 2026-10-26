'use strict';

const { safeIdentity } = require('./privacy.cjs');

// Harness display names are optional, not ownership or persona evidence. Keep
// only the intersection of privacy-safe identities and strict context labels;
// never normalize, parse, hash, or checkpoint unsupported display prose.
function optionalLabel(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_.:+-]{0,127}$/i.test(value)
    && !/(?:password|secret|bearer|api[_-]?key|sk-[a-z0-9]{12})/i.test(value)
    ? safeIdentity(value) : undefined;
}

function usageDetails(usage = {}) {
  const finite = value => Number.isFinite(value) && value >= 0 ? value : 0;
  const output = finite(usage.output);
  const reasoning = finite(usage.reasoning);
  const split = reasoning > 0 && reasoning <= output;
  return {
    input: finite(usage.input), output: split ? output - reasoning : output,
    ...(split ? { output_reasoning_tokens: reasoning } : {}),
    cache_read_input_tokens: finite(usage.cacheRead), cache_creation_input_tokens: finite(usage.cacheWrite)
  };
}

function createController(pi, options = {}) {
  let flow = options.flow;
  let lastContext;
  let active;
  let rawInput;
  const { isTracingAllowed } = require('./bootstrap.js');
  // Pi 1.3 parses registered boolean flags separately from resource discovery.
  // Only this deliberate per-process switch permits a marker-absent target;
  // neither registering the extension nor a lineage nonce grants consent.
  pi.registerFlag?.('brain-tracing', {
    description: 'Opt this Pi run into metadata-only tracing when no project declaration exists; refusal and trust/kill switches still win.',
    type: 'boolean', default: false
  });
  const allowed = ctx => isTracingAllowed(ctx, { enabled: options.enabled !== false, perRun: pi.getFlag?.('brain-tracing') === true });
  const roots = new Map();
  const tools = new Map();
  const clock = options.clock || Date.now;
  const runStates = () => [...roots.values()];
  const nativeId = ctx => ctx.sessionManager.getSessionId();
  const effort = ctx => ctx.thinkingLevel || pi.getThinkingLevel?.();
  const current = () => active && roots.get(active);
  const optionalPersona = (value, cwd) => optionalLabel(value) && flow.knownPersona?.(cwd, value) ? value : undefined;
  const setStatus = text => { if (lastContext?.hasUI) lastContext.ui.setStatus('brain-tracing', text); };
  const observe = (event, handler) => pi.on(event, async (data, ctx) => {
    if (ctx) lastContext = ctx;
    if (!allowed(ctx || lastContext)) {
      if (event === 'session_start') setStatus('brain tracing: off');
      if (event === 'session_shutdown') cleanup();
      return undefined;
    }
    try { return await handler(data, ctx); }
    catch {
      try { flow?.writeState('health', { ...(flow.readState('health') || {}), captureFailureObserved: true }); } catch {}
      setStatus('brain tracing: metadata-only; telemetry unavailable'); return undefined;
    }
  });
  const ensure = ctx => {
    if (!flow) flow = require('./flow.cjs').createFlow({ harness: 'pi', cwd: ctx.cwd, env: { ...process.env }, clock });
    return flow;
  };
  const rootRecord = (state, outcome = state.outcome || 'unknown') => ({
    id: state.run.rootSpanId, traceId: state.run.traceId, parentId: state.run.parentSpanId || null,
    sessionId: state.run.sessionId, nativeSessionId: state.run.nativeSessionId,
    type: 'AGENT', startTime: state.start, endTime: state.endedAt || clock(), outcome, context: state.run
  });
  const pendingId = file => flow.id(`child-session:${file}`);
  const saveRoot = state => flow.writeState(`pi-root:${state.run.rootSpanId}`, { pending: [...state.pending], endedAt: state.endedAt, outcome: state.outcome });
  const submitRoot = (state, outcome) => {
    ensure(lastContext);
    saveRoot(state);
    return flow.submit(state.run, [rootRecord(state, outcome)]);
  };

  function begin(ctx, event = {}) {
    ensure(ctx);
    if (event.messageType === 'custom' || event.message?.customType === 'subagent_result') {
      const details = event.message?.details;
      const file = details?.sessionFile || details?.sessionPath;
      const saved = typeof file === 'string' && flow.readState(`pi-child-parent:${file}`);
      if (saved?.run) {
        let state = roots.get(saved.run.rootSpanId);
        if (!state) {
          const checkpoint = flow.readState(`pi-root:${saved.run.rootSpanId}`);
          state = { run: flow.resolve(saved.run) || saved.run, start: saved.run.startedAt ? new Date(saved.run.startedAt).getTime() : clock(), pending: new Set(checkpoint?.pending || []), outcome: 'unknown' };
          roots.set(state.run.rootSpanId, state);
        }
        state.pending.delete(pendingId(file));
        state.endedAt = undefined; state.outcome = 'unknown';
        saveRoot(state);
        active = state.run.rootSpanId;
        return state;
      }
    }
    const previous = flow.session(nativeId(ctx));
    let run = flow.begin({ nativeSessionId: nativeId(ctx), cwd: ctx.cwd,
      persona: optionalPersona(process.env.PI_SUBAGENT_AGENT, ctx.cwd) || previous?.persona,
      agentName: optionalLabel(process.env.PI_SUBAGENT_NAME),
      ...(previous?.ticketSource === 'explicit' ? { ticketId: previous.ticketId } : {}),
      requestedModel: ctx.model?.id, requestedEffort: effort(ctx) });
    if (rawInput) run = flow.captureBrainCommand(run, { text: rawInput, cwd: ctx.cwd });
    else if (typeof event.prompt === 'string') run = flow.captureBrainCommand(run, { text: event.prompt, cwd: ctx.cwd });
    const requestedSkill = /^\/skill:([a-z][a-z0-9-]{0,79})(?:\s|$)/.exec(rawInput || '')?.[1];
    const expandedSkill = typeof event.prompt === 'string' ? /^<skill name="([a-z][a-z0-9-]{0,79})" location="/.exec(event.prompt)?.[1] : null;
    if (requestedSkill && expandedSkill === requestedSkill) run = flow.captureSkill(run, { toolName: 'Skill', input: { skill: requestedSkill }, invoked: true, success: true, cwd: ctx.cwd });
    rawInput = undefined;
    const state = { run, start: run.startedAt ? new Date(run.startedAt).getTime() : clock(), pending: new Set(), outcome: 'unknown' };
    roots.set(run.rootSpanId, state); active = run.rootSpanId;
    submitRoot(state, 'unknown');
    return state;
  }

  function closeGeneration(state, outcome, message = {}) {
    const generation = state?.generation;
    if (!generation) return;
    const actualModel = message.responseModel || message.model || lastContext?.model?.id;
    const observedEffort = message.thinkingLevel || effort(lastContext || {});
    state.run = flow.update(state.run, { ...(actualModel ? { observedModel: actualModel } : {}), ...(observedEffort ? { observedEffort } : {}) });
    flow.submit(state.run, [{ id: generation.id, traceId: state.run.traceId, parentId: state.run.rootSpanId,
      sessionId: state.run.sessionId, nativeSessionId: state.run.nativeSessionId, type: 'GENERATION',
      startTime: generation.start, endTime: clock(), model: actualModel, provider: message.provider || lastContext?.model?.provider,
      usage: usageDetails(message.usage), ...(message.usage?.cost ? { cost: message.usage.cost } : {}),
      outcome, context: state.run }]);
    state.generation = null;
  }

  const start = ctx => {
    lastContext = ctx;
    if (!allowed(ctx)) return false;
    ensure(ctx);
    flow.acknowledgeSession?.(nativeId(ctx));
    // Consume startup lineage in this adapter. Only a freshly bound tool call
    // may propagate another nonce; descendants must not reuse a grandparent's.
    if (!options.flow) delete process.env.BRAIN_TRACE_LAUNCH_ID;
    setStatus('brain tracing: metadata-only');
    return true;
  };
  observe('session_start', (_event, ctx) => start(ctx));
  observe('input', event => { rawInput = typeof event.text === 'string' ? event.text : undefined; });
  observe('before_agent_start', (event, ctx) => { begin(ctx, event); });
  observe('before_provider_request', (_event, ctx) => {
    const state = current() || begin(ctx);
    if (state.generation) closeGeneration(state, 'interrupted');
    state.generation = { id: flow.id(), start: clock() };
  });
  observe('message_end', event => {
    const state = current();
    const message = event.message;
    if (message?.customType === 'subagent_result') {
      const file = message.details?.sessionFile || message.details?.sessionPath;
      const saved = typeof file === 'string' && flow?.readState(`pi-child-parent:${file}`);
      const waiting = saved?.run && roots.get(saved.run.rootSpanId);
      if (waiting) { waiting.pending.delete(pendingId(file)); saveRoot(waiting); }
    }
    if (message?.role === 'assistant' && state) {
      const outcome = message.stopReason === 'aborted' ? 'aborted' : message.stopReason === 'error' ? 'error' : 'completed';
      state.outcome = outcome;
      closeGeneration(state, outcome, message);
    }
  });
  observe('tool_call', (event, ctx) => {
    const state = current() || begin(ctx);
    if (event.toolName === 'bash' && typeof event.input?.command === 'string') {
      const binding = flow.createToolLaunch(state.run);
      // Only a non-secret exact lineage nonce crosses the subprocess boundary.
      // No credentials, prompt, or arbitrary context is added to argv/env.
      if (!/^[a-z0-9_-]{32,128}$/i.test(binding.nonce || '')) throw new Error('Invalid launch binding');
      event.input.command = `export BRAIN_TRACE_LAUNCH_ID='${binding.nonce}'\n${event.input.command}`;
    }
  });
  observe('tool_execution_start', (event, ctx) => {
    const state = current() || begin(ctx);
    tools.set(event.toolCallId, { state, id: flow.id(`${state.run.rootSpanId}:tool:${event.toolCallId}`),
      parentId: event.parentToolCallId ? tools.get(event.parentToolCallId)?.id || state.run.rootSpanId : state.run.rootSpanId,
      start: clock(), name: event.toolName,
      // Tool arguments remain in process memory only until completion.
      args: /^(read|Skill|skill)$/.test(event.toolName) ? event.args : undefined });
  });
  observe('tool_execution_end', (event, ctx) => {
    const tool = tools.get(event.toolCallId);
    if (!tool) return;
    tools.delete(event.toolCallId);
    const state = tool.state;
    if (/^(subagent|subagent_resume)$/.test(tool.name) && !event.isError) {
      const details = event.result?.details || {};
      const file = details.sessionFile || details.sessionPath;
      if (typeof details.id === 'string' && typeof file === 'string') {
        const persona = optionalPersona(details.agent, ctx.cwd);
        const agentName = optionalLabel(details.name);
        flow.store.createLaunch(flow.resolve(state.run) || state.run, { launchId: details.id,
          // A resumed invocation reuses its transcript file but has a new exact
          // launch ID. Do not rebind the immutable original file capability.
          child: { ...(persona ? { persona } : {}), ...(agentName ? { agentName } : {}) } });
        flow.writeState(`pi-child-parent:${file}`, { run: state.run });
        if (details.status === 'started') state.pending.add(pendingId(file));
        saveRoot(state);
        return; // Actual child AGENT replaces the successful dispatch TOOL.
      }
    }
    const failed = event.isError || (/^(subagent|subagent_resume)$/.test(tool.name) && Boolean(event.result?.details?.error));
    if (tool.args) state.run = flow.captureSkill(state.run, { toolName: tool.name, input: tool.args, cwd: ctx.cwd, success: !failed });
    flow.submit(state.run, [{ id: tool.id, traceId: state.run.traceId, parentId: tool.parentId,
      sessionId: state.run.sessionId, nativeSessionId: state.run.nativeSessionId, type: 'TOOL', toolName: tool.name,
      startTime: tool.start, endTime: clock(), outcome: failed ? 'error' : 'completed', context: state.run }]);
  });
  observe('model_select', (event, ctx) => { const state = current(); if (state) state.run = flow.update(state.run, { requestedModel: event.model?.id || ctx.model?.id }); });
  observe('thinking_level_select', (event, ctx) => { const state = current(); if (state) state.run = flow.update(state.run, { requestedEffort: event.level || event.thinkingLevel || effort(ctx) }); });
  observe('agent_before_settle', event => { const state = current(); if (state && ['completed', 'aborted', 'error'].includes(event.outcome)) state.outcome = event.outcome; });
  observe('agent_settled', async event => {
    const state = current(); if (!state) return;
    if (event.aborted) state.outcome = 'aborted';
    closeGeneration(state, state.outcome === 'completed' ? 'interrupted' : state.outcome);
    if (!state.pending.size && ['completed', 'aborted', 'error'].includes(state.outcome)) state.endedAt = clock();
    submitRoot(state, state.pending.size && !event.aborted ? 'unknown' : state.outcome);
    const delivery = await flow.flush({ timeoutMs: 2500 });
    setStatus(state.pending.size ? 'brain tracing: metadata-only; awaiting child'
      : delivery?.accepted > 0 ? 'brain tracing: metadata-only; transport accepted (not ingestion verified)'
        : ['state_unavailable', 'invalid_outbox', 'failure'].includes(delivery?.status) ? 'brain tracing: metadata-only; telemetry unavailable'
          : 'brain tracing: metadata-only; no acknowledged export');
  });
  for (const eventName of ['session_compact', 'session_compact_failed', 'session_tree']) {
    observe(eventName, event => {
      const state = current(); if (!state) return;
      const usage = event.compactionEntry?.usage || event.summaryEntry?.usage;
      if (!usage && eventName !== 'session_compact_failed') return;
      flow.submit(state.run, [{ id: flow.id(), traceId: state.run.traceId, parentId: state.run.rootSpanId,
        sessionId: state.run.sessionId, nativeSessionId: state.run.nativeSessionId, type: 'GENERATION',
        startTime: clock(), endTime: clock(), model: lastContext?.model?.id,
        usage: usageDetails(usage), outcome: eventName === 'session_compact_failed' ? 'error' : 'completed', context: state.run }]);
    });
  }
  observe('session_shutdown', async () => {
    for (const tool of tools.values()) {
      flow.submit(tool.state.run, [{ id: tool.id, traceId: tool.state.run.traceId, parentId: tool.parentId,
        sessionId: tool.state.run.sessionId, nativeSessionId: tool.state.run.nativeSessionId, type: 'TOOL', toolName: tool.name,
        startTime: tool.start, endTime: clock(), outcome: 'interrupted', context: tool.state.run }]);
    }
    for (const state of runStates()) {
      closeGeneration(state, 'interrupted');
      submitRoot(state, state.pending.size || !['completed', 'error', 'aborted'].includes(state.outcome) ? 'interrupted' : state.outcome);
    }
    if (flow) await flow.flush({ timeoutMs: 2500 });
    cleanup();
  });

  function cleanup() {
    roots.clear(); tools.clear(); active = undefined; rawInput = undefined;
    flow = undefined;
    const guard = Symbol.for('agent-brain.observability.controller');
    if (globalThis[guard]?.owner === roots) delete globalThis[guard];
  }

  const contextTool = {
    name: 'brain_context', label: 'Brain context',
    description: 'Set or query the active brain persona and ticket for this session. Only non-secret identifiers; never include task content or credentials.',
    parameters: { type: 'object', properties: { persona: { type: 'string' }, ticketId: { type: 'string' } }, additionalProperties: false },
    execute: async (_id, args, _signal, _onUpdate, ctx) => {
      if (!allowed(ctx)) return { content: [{ type: 'text', text: 'Brain tracing is disabled or requires project trust.' }], details: undefined };
      lastContext = ctx;
      ensure(ctx);
      const state = current() || begin(ctx);
      state.run = flow.resolve(state.run) || state.run;
      const persona = args.persona || state.run.persona || 'unknown';
      if (!/^[a-z][a-z0-9-]{0,79}$/.test(persona) || (args.ticketId && !/^[A-Z][A-Z0-9]{1,15}-[1-9]\d*$/.test(args.ticketId))) {
        return { content: [{ type: 'text', text: 'Invalid non-secret brain context identifiers.' }], details: undefined, isError: true };
      }
      if (args.persona && flow.knownPersona && !flow.knownPersona(ctx.cwd, args.persona)) return { content: [{ type: 'text', text: 'Persona was not found in the installed brain; it was not attributed.' }], details: undefined, isError: true };
      if (args.persona || args.ticketId) state.run = flow.captureBrainCommand(state.run, { commandName: 'brain', commandArgs: `${persona}${args.ticketId ? ` --ticket ${args.ticketId}` : ''}`, cwd: ctx.cwd });
      const result = { persona: state.run.persona || 'UNKNOWN', ticketId: state.run.ticketId || 'UNKNOWN', ticketSource: state.run.ticketSource || 'unknown',
        runtimeName: state.run.runtimeName, agentName: state.run.agentName, project: state.run.projectName, projectId: state.run.projectId,
        nativeSessionId: state.run.nativeSessionId, sessionId: flow.resolve(state.run)?.sessionId || 'UNKNOWN', ancestryPending: !flow.resolve(state.run),
        skillsInvoked: state.run.skillsInvoked || [], skillsLoaded: state.run.skillsLoaded || [],
        health: flow.readState?.('health') || { lineageLossObserved: false }, delivery: flow.readState?.('delivery') || null, harness: 'pi', captureMode: 'metadata-only' };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    }
  };
  if (pi.registerTool && !globalThis[Symbol.for('agent-brain.observability.context-tool-proxy')]) pi.registerTool(contextTool);
  return { start, getFlow: () => flow, getRoots: () => roots, getContextTool: () => contextTool };
}

module.exports = function brainObservability(pi) {
  const guard = Symbol.for('agent-brain.observability.controller');
  if (globalThis[guard]) return globalThis[guard].controller;
  const controller = createController(pi);
  globalThis[guard] = { controller, owner: controller.getRoots() };
  return controller;
};
module.exports.createController = createController;
module.exports.usageDetails = usageDetails;
