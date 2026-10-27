'use strict';

const { safeIdentity, CONTENT_LIMITS } = require('./privacy.cjs');
const { types: { isProxy } } = require('node:util');

// Pi's typed native records commonly have own optional fields set to undefined
// (normalized prompt options, tool result details, text signatures). Their JSON
// boundary representation omits those OBJECT fields. Do that without invoking
// getters/toJSON or coercing array entries; all actual JSON values and ordering
// survive. This is not a redactor: shared createContent still projects/redacts
// and measures the exact serialized record before any persistence.
function nativeJSON(value) {
  const ancestors = new Set();
  let nodes = 0, bytes = 0;
  const fail = status => { throw Object.assign(new Error('Native JSON unavailable'), { contentStatus: status }); };
  function visit(raw, depth) {
    if (++nodes > CONTENT_LIMITS.nodes || depth > CONTENT_LIMITS.depth) fail('refused_size');
    if (typeof raw === 'string') {
      if (raw.length > CONTENT_LIMITS.recordBytes) fail('refused_size');
      bytes += Buffer.byteLength(raw);
      if (bytes > CONTENT_LIMITS.recordBytes) fail('refused_size');
      return raw;
    }
    if (raw === null || typeof raw === 'boolean' || (typeof raw === 'number' && Number.isFinite(raw))) return raw;
    if (!raw || typeof raw !== 'object' || isProxy(raw) || ancestors.has(raw)) fail('unsupported');
    const array = Array.isArray(raw), proto = Object.getPrototypeOf(raw);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail('unsupported');
    const keys = Reflect.ownKeys(raw);
    if (keys.length > CONTENT_LIMITS.keys + (array ? 1 : 0)) fail('refused_size');
    if (array && keys.length !== raw.length + 1) fail('unsupported');
    ancestors.add(raw);
    const result = array ? [] : {};
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)
        || (array && !/^(?:0|[1-9][0-9]*)$/.test(key))) fail('unsupported');
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('unsupported');
      if (!array && descriptor.value === undefined) continue;
      result[key] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(raw);
    return result;
  }
  return visit(value, 0);
}

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
  let inputCapture;
  // Projected content lives only in typed observation checkpoints, never runs,
  // launch bindings or generic adapter state. Native IDs are session-scoped.
  const calls = new Map();
  const requests = new Map();
  const openKeys = new Map();
  const blockedKeys = new Map();
  const mintedCapabilities = new Set();
  let capabilityBudgetExceeded = false;
  const { isTracingAllowed, findCapturePolicySync } = require('./bootstrap.js');
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
  const nativeId = ctx => ctx.sessionManager.getSessionId().toLowerCase();
  const effort = ctx => ctx.thinkingLevel || pi.getThinkingLevel?.();
  const current = () => active && roots.get(active);
  const mode = () => {
    const captured = flow?.captureMode?.() || 'metadata-only';
    // Flow is session-scoped, but Pi can supply a different event/tool cwd.
    // Its broader startup policy must not override a narrower native target.
    if (captured !== 'full-content') return captured;
    const policy = lastContext?.cwd && findCapturePolicySync(lastContext.cwd);
    return policy?.captureMode === 'full-content' ? captured : policy === null ? 'disabled' : 'metadata-only';
  };
  const callKey = (ctx, id) => `${nativeId(ctx)}:${id}`;
  // Own data only: metadata attribution must not invoke body accessors.
  const data = (object, key) => object && Object.getOwnPropertyDescriptor(object, key)?.value;
  const present = (object, keys) => Object.fromEntries(keys.filter(key => data(object, key) !== undefined).map(key => [key, data(object, key)]));
  function content(surfaces) {
    if (mode() !== 'full-content') return undefined; // Consent BEFORE evaluating bodies.
    const raw = surfaces(), json = {}, failures = {};
    for (const field of ['input', 'output']) if (Object.hasOwn(raw, field)) {
      try { json[field] = nativeJSON(data(raw, field)); }
      catch (error) { failures[field] = { status: error.contentStatus || 'unsupported' }; }
    }
    const projected = flow.createContent(json);
    // The shared credential redactor does not yet understand runtime actor
    // capabilities. Refuse the entire affected surface, not a leaking prefix.
    // Also exclude native binary blocks; this adapter makes no media guarantee.
    const unsafe = /BRAIN_TRACE_LAUNCH_ID|--actor(?:[=\s]|\\[nr])|"type":"(?:image|audio|file)"|"(?:image_url|inlineData)":/i;
    const result = { ...projected, ...failures };
    for (const field of ['input', 'output']) if (Object.hasOwn(result[field], 'value')) {
      const json = JSON.stringify(result[field].value);
      if (capabilityBudgetExceeded || unsafe.test(json) || [...mintedCapabilities].some(nonce => json.includes(nonce))) result[field] = { status: 'unsupported' };
    }
    return result;
  }
  const indexKey = session => `pi-content-open:${session}`;
  const keySet = (map, session) => { if (!map.has(session)) map.set(session, new Set()); return map.get(session); };
  const saveIndex = session => flow.writeState(indexKey(session), { keys: [...keySet(openKeys, session)], blocked: [...keySet(blockedKeys, session)] });
  function checkpoint(key, run, record, envelope) {
    const capture = flow.captureObservation(run, { ...record, content: envelope });
    // Publish the metadata discovery index first. A failed body publication
    // leaves a harmless missing key, never an undiscoverable private body.
    if (!keySet(blockedKeys, run.nativeSessionId).has(key)) keySet(openKeys, run.nativeSessionId).add(key);
    saveIndex(run.nativeSessionId);
    flow.writeObservation(key, capture);
    return capture;
  }
  function handoff(key, session) {
    session ||= flow.readObservation(key)?.owner.nativeSessionId;
    if (session && keySet(blockedKeys, session).has(key)) return { queued: 0, pending: 0, unsupported: true };
    const result = flow.closeObservation(key); // Deletes ONLY after durable queue/pending handoff.
    if (session && !flow.readObservation(key)) { keySet(openKeys, session).delete(key); saveIndex(session); }
    return result;
  }
  function finishContent(key, run, record, output) {
    const saved = flow.readObservation(key);
    if (!saved) return;
    if (['completed', 'error', 'aborted'].includes(saved.record.outcome) && record.outcome === 'interrupted') return handoff(key);
    // A later metadata grant cannot upgrade or strip the original content.
    // Retry the checkpoint under its ORIGINAL grant without reading new bodies.
    if (mode() !== saved.captureGrant.captureMode) return handoff(key);
    const next = output ? content(() => ({ output: output() })) : undefined;
    const envelope = { ...saved.record.content, ...(next ? { output: next.output } : {}) };
    checkpoint(key, run, record, envelope);
    return handoff(key);
  }
  function appendRootInput(state, field, value) {
    if (!state?.contentKey || mode() !== 'full-content') return false;
    const saved = flow.readObservation(state.contentKey);
    if (!saved?.record.content.input.value) return false;
    const input = saved.record.content.input.value;
    checkpoint(state.contentKey, state.run, rootRecord(state, 'interrupted'), {
      ...saved.record.content, input: content(() => ({ input: { ...input, [field]: [...(input[field] || []), value] } })).input
    });
    return true;
  }
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
      setStatus(`brain tracing: ${mode()}; telemetry unavailable`); return undefined;
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
  const saveRoot = state => flow.writeState(`pi-root:${state.run.rootSpanId}`, { pending: [...state.pending], endedAt: state.endedAt, outcome: state.outcome, contentKey: state.contentKey });
  const submitRoot = (state, outcome) => {
    ensure(lastContext);
    saveRoot(state);
    if (state.contentKey) {
      const saved = flow.readObservation(state.contentKey);
      if (!saved) return;
      const terminal = !state.pending.size && ['completed', 'aborted', 'error', 'interrupted'].includes(outcome);
      if (mode() !== saved.captureGrant.captureMode) return terminal ? handoff(state.contentKey) : undefined;
      // An open root is recoverable as interrupted, not falsely completed.
      const record = rootRecord(state, terminal ? outcome : 'interrupted');
      checkpoint(state.contentKey, state.run, record, saved.record.content);
      if (terminal) return handoff(state.contentKey);
      return;
    }
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
          state = { run: flow.resolve(saved.run) || saved.run, start: saved.run.startedAt ? new Date(saved.run.startedAt).getTime() : clock(), pending: new Set(checkpoint?.pending || []), outcome: 'unknown', contentKey: checkpoint?.contentKey };
          if (state.contentKey && !flow.readObservation(state.contentKey)) flow.writeState('health', {
            ...(flow.readState('health') || {}), piClosedRootContentUnavailable: true
          });
          roots.set(state.run.rootSpanId, state);
        }
        state.pending.delete(pendingId(file));
        state.endedAt = undefined; state.outcome = 'unknown';
        saveRoot(state);
        active = state.run.rootSpanId;
        return state;
      }
    }
    const previousState = current();
    if (previousState?.generation) closeGeneration(previousState, 'interrupted');
    const previous = flow.session(nativeId(ctx));
    let run = flow.begin({ nativeSessionId: nativeId(ctx), cwd: ctx.cwd,
      persona: optionalPersona(process.env.PI_SUBAGENT_AGENT, ctx.cwd) || previous?.persona,
      agentName: optionalLabel(process.env.PI_SUBAGENT_NAME),
      ...(previous?.ticketSource === 'explicit' ? { ticketId: previous.ticketId } : {}),
      requestedModel: ctx.model?.id, requestedEffort: effort(ctx) });
    if (rawInput) run = flow.captureBrainCommand(run, { text: rawInput, cwd: ctx.cwd });
    else if (typeof data(event, 'prompt') === 'string') run = flow.captureBrainCommand(run, { text: data(event, 'prompt'), cwd: ctx.cwd });
    const requestedSkill = /^\/skill:([a-z][a-z0-9-]{0,79})(?:\s|$)/.exec(rawInput || '')?.[1];
    const expandedSkill = typeof data(event, 'prompt') === 'string' ? /^<skill name="([a-z][a-z0-9-]{0,79})" location="/.exec(data(event, 'prompt'))?.[1] : null;
    if (requestedSkill && expandedSkill === requestedSkill) run = flow.captureSkill(run, { toolName: 'Skill', input: { skill: requestedSkill }, invoked: true, success: true, cwd: ctx.cwd });
    rawInput = undefined;
    const state = { run, start: run.startedAt ? new Date(run.startedAt).getTime() : clock(), pending: new Set(), outcome: 'unknown' };
    roots.set(run.rootSpanId, state); active = run.rootSpanId;
    if (mode() === 'full-content') {
      state.contentKey = `pi-content-root:${run.rootSpanId}`;
      checkpoint(state.contentKey, run, rootRecord(state, 'interrupted'), content(() => ({ input: {
        source: 'before_agent_start', boundaryOnly: true, representation: 'native-json', undefinedObjectFields: 'omitted',
        rawUserInput: inputCapture?.input || { status: 'unavailable' },
        ...present(event, ['messageType', 'prompt', 'systemPrompt', 'systemPromptOptions', 'images', 'message'])
      } })));
    }
    inputCapture = undefined;
    submitRoot(state, 'unknown');
    return state;
  }

  function closeGeneration(state, outcome, message) {
    const generation = state?.generation;
    if (!generation) return;
    const actualModel = message?.model;
    const observedEffort = message?.thinkingLevel;
    state.run = flow.update(state.run, { ...(actualModel ? { observedModel: actualModel } : {}), ...(observedEffort ? { observedEffort } : {}) });
    const record = { id: generation.id, traceId: state.run.traceId, parentId: state.run.rootSpanId,
      sessionId: state.run.sessionId, nativeSessionId: state.run.nativeSessionId, type: 'GENERATION',
      startTime: generation.start, endTime: clock(), model: actualModel, provider: message?.provider,
      ...(message?.usage ? { usage: usageDetails(message.usage), ...(message.usage.cost ? { cost: message.usage.cost } : {}) } : {}),
      outcome, context: state.run };
    if (generation.contentKey) finishContent(generation.contentKey, state.run, record, message ? () => ({
      source: 'message_end', nativeTruncated: message.stopReason === 'length',
      thinkingAvailability: 'native-surfaced-only', hiddenReasoningAvailable: false,
      ...present(message, ['role', 'content', 'stopReason', 'errorMessage'])
    }) : undefined);
    else flow.submit(state.run, [record]);
    requests.delete(state.run.nativeSessionId);
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
    if (flow.readObservation && !roots.size) {
      // No transcript replay. Retry only captures named by our private metadata
      // index, with their original owner, grant and revision after restart.
      const session = nativeId(ctx), index = flow.readState(indexKey(session));
      for (const key of index?.blocked || []) keySet(blockedKeys, session).add(key);
      // Load the ENTIRE suffix before any handoff rewrites the index. A crash
      // after transferring its prefix must not strand later body checkpoints.
      for (const key of index?.keys || []) keySet(openKeys, session).add(key);
      for (const key of index?.keys || []) {
        const capture = flow.readObservation(key);
        // A known deferred child can resume this actor after restart. Keep its
        // projected prompt until that exact continuation, not an old transcript.
        if (capture?.record.type === 'AGENT' && flow.readState(`pi-root:${capture.owner.rootSpanId}`)?.pending?.length) continue;
        handoff(key, session);
      }
    }
    setStatus(`brain tracing: ${mode()}`);
    return true;
  };
  observe('session_start', (_event, ctx) => { start(ctx); });
  observe('input', (event, ctx) => {
    ensure(ctx);
    rawInput = typeof data(event, 'text') === 'string' ? data(event, 'text') : undefined;
    inputCapture = content(() => ({ input: { boundary: 'input', ...present(event, ['text', 'images', 'source', 'streamingBehavior']) } }));
    const state = current();
    if (data(event, 'streamingBehavior') && state?.run.nativeSessionId === nativeId(ctx)
      && appendRootInput(state, 'additionalUserInputs', inputCapture?.input)) {
      rawInput = undefined; inputCapture = undefined;
    }
  });
  observe('before_agent_start', (event, ctx) => { begin(ctx, event); });
  observe('before_provider_request', (event, ctx) => {
    // Pi's agent loop serializes requests then message_end. There is no native
    // request ID: bind the pending request to its session AT this boundary,
    // never borrow an active root when a completion/tool arrives later.
    const state = current();
    if (!state || state.run.nativeSessionId !== nativeId(ctx)) return;
    if (state.generation) closeGeneration(state, 'interrupted');
    const generation = state.generation = { id: flow.id(), start: clock() };
    requests.set(nativeId(ctx), state);
    if (mode() === 'full-content') {
      generation.contentKey = `pi-content-generation:${generation.id}`;
      const descriptor = Object.getOwnPropertyDescriptor(event, 'payload');
      checkpoint(generation.contentKey, state.run, { id: generation.id, parentId: state.run.rootSpanId,
        type: 'GENERATION', startTime: generation.start, endTime: generation.start, outcome: 'interrupted' },
      content(() => !descriptor ? {} : !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined ? { input: undefined } : { input: {
        source: 'before_provider_request', representation: 'native-payload-boundary', undefinedObjectFields: 'omitted', finalWireGuaranteed: false, payload: descriptor.value
      } }));
    }
  });
  observe('message_end', (event, ctx) => {
    const message = event.message;
    const state = requests.get(nativeId(ctx));
    if (message?.role === 'user' && current()?.run.nativeSessionId === nativeId(ctx) && mode() === 'full-content') {
      appendRootInput(current(), 'observedUserMessages', content(() => ({ input: present(message, ['role', 'content', 'timestamp']) })).input);
    }
    if (message?.customType === 'subagent_result') {
      const file = message.details?.sessionFile || message.details?.sessionPath;
      const saved = typeof file === 'string' && flow?.readState(`pi-child-parent:${file}`);
      const waiting = saved?.run && roots.get(saved.run.rootSpanId);
      if (waiting) { waiting.pending.delete(pendingId(file)); saveRoot(waiting); }
    }
    if (message?.role === 'assistant' && state) {
      const outcome = message.stopReason === 'aborted' ? 'aborted' : message.stopReason === 'error' ? 'error' : 'completed';
      state.outcome = outcome;
      if (mode() === 'full-content') {
        // Tool call IDs on the finalized assistant message are exact ownership
        // evidence, including calls Pi refuses after native output truncation.
        for (const block of Array.isArray(message.content) ? message.content : []) if (block.type === 'toolCall' && typeof block.id === 'string') {
          calls.set(callKey(ctx, block.id), { state, modelArguments: content(() => ({ input: block.arguments }))?.input });
        }
        if (state.contentKey) {
          const saved = flow.readObservation(state.contentKey);
          if (saved) checkpoint(state.contentKey, state.run, rootRecord(state, 'interrupted'), {
            ...saved.record.content, output: content(() => ({ output: { source: 'message_end',
              nativeTruncated: message.stopReason === 'length', thinkingAvailability: 'native-surfaced-only',
              hiddenReasoningAvailable: false, ...present(message, ['role', 'content', 'stopReason', 'errorMessage']) } })).output
          });
        }
      }
      closeGeneration(state, outcome, message);
    }
  });
  observe('tool_call', (event, ctx) => {
    const key = callKey(ctx, event.toolCallId);
    const tool = tools.get(key);
    // Preserve the pre-existing lineage transport even if content capture or
    // native call ownership is unavailable. This fallback is NOT evidence for
    // a TOOL observation; only execution_start's exact binding may capture it.
    const state = tool?.state || calls.get(key)?.state || current() || begin(ctx);
    if (event.toolName === 'bash' && typeof event.input?.command === 'string') {
      const binding = flow.createToolLaunch(state.run);
      // Only a non-secret exact lineage nonce crosses the subprocess boundary.
      // No credentials, prompt, or arbitrary context is added to argv/env.
      if (!/^[a-z0-9_-]{32,128}$/i.test(binding.nonce || '')) throw new Error('Invalid launch binding');
      if (mintedCapabilities.size < 4096) mintedCapabilities.add(binding.nonce);
      else capabilityBudgetExceeded = true;
      event.input.command = `export BRAIN_TRACE_LAUNCH_ID='${binding.nonce}'\n${event.input.command}`;
    }
    // execution_start precedes tool_call in Pi 1.3. Save the later execution
    // arguments separately without confusing them with model-issued arguments.
    if (tool?.contentKey && mode() === 'full-content') {
      const saved = flow.readObservation(tool.contentKey);
      const execution = content(() => ({ input: event.input })).input;
      if (saved?.record.content.input.value) checkpoint(tool.contentKey, state.run, toolRecord(tool, 'interrupted'), {
        ...saved.record.content, input: content(() => ({ input: { ...saved.record.content.input.value,
          executionArguments: execution, executionArgumentsBoundary: 'tool_call', finalExecutionArgumentsGuaranteed: false } })).input
      });
    }
  });
  const toolRecord = (tool, outcome) => ({ id: tool.id, parentId: tool.parentId, type: 'TOOL', toolName: tool.name,
    startTime: tool.start, endTime: clock(), outcome });
  observe('tool_execution_start', (event, ctx) => {
    const key = callKey(ctx, event.toolCallId);
    const parent = event.parentToolCallId && tools.get(callKey(ctx, event.parentToolCallId));
    const issued = calls.get(key);
    const state = parent?.state || issued?.state || (mode() !== 'full-content' ? current() || begin(ctx) : undefined);
    if (!state) {
      flow?.writeState('health', { ...(flow.readState('health') || {}), piToolOwnershipUnavailable: true });
      return;
    }
    const tool = { state, id: flow.id(`${state.run.rootSpanId}:tool:${event.toolCallId}`),
      parentId: parent?.id || state.run.rootSpanId, start: clock(), name: event.toolName,
      // Existing read/Skill context evidence, not general payload persistence.
      args: /^(read|Skill|skill)$/.test(event.toolName) ? data(event, 'args') : undefined };
    tools.set(key, tool);
    calls.delete(key);
    if (mode() === 'full-content') {
      tool.contentKey = `pi-content-tool:${tool.id}`;
      checkpoint(tool.contentKey, state.run, toolRecord(tool, 'interrupted'), content(() => ({ input: {
        source: 'tool_execution_start', modelArguments: issued?.modelArguments || { status: 'unavailable' },
        executionArgumentsBoundary: 'tool_execution_start', finalExecutionArgumentsGuaranteed: false,
        executionArguments: content(() => Object.hasOwn(event, 'args') ? { input: data(event, 'args') } : {}).input
      } })));
    }
  });
  observe('tool_execution_end', (event, ctx) => {
    const key = callKey(ctx, event.toolCallId);
    const tool = tools.get(key);
    if (!tool) return;
    const state = tool.state;
    if (/^(subagent|subagent_resume)$/.test(tool.name) && !event.isError) {
      const details = event.result?.details || {};
      const file = details.sessionFile || details.sessionPath;
      if (typeof details.id === 'string' && typeof file === 'string') {
        if (tool.contentKey) {
          // Classify BEFORE publishing the child binding or updating its body.
          // Even a crash here must not replay the open dispatch as a TOOL.
          keySet(openKeys, state.run.nativeSessionId).delete(tool.contentKey);
          keySet(blockedKeys, state.run.nativeSessionId).add(tool.contentKey); saveIndex(state.run.nativeSessionId);
        }
        const persona = optionalPersona(details.agent, ctx.cwd);
        const agentName = optionalLabel(details.name);
        flow.store.createLaunch(flow.resolve(state.run) || state.run, { launchId: details.id,
          // A resumed invocation reuses its transcript file but has a new exact
          // launch ID. Do not rebind the immutable original file capability.
          child: { ...(persona ? { persona } : {}), ...(agentName ? { agentName } : {}) } });
        flow.writeState(`pi-child-parent:${file}`, { run: state.run });
        if (details.status === 'started') state.pending.add(pendingId(file));
        saveRoot(state);
        if (tool.contentKey) {
          // Flow has no typed child-dispatch attachment API. Never stash a
          // body on a launch/run or overwrite the child's prompt/answer.
          // Explicitly retain a body-free unsupported result on this private
          // checkpoint, NOT a duplicate successful dispatch TOOL export.
          const saved = flow.readObservation(tool.contentKey);
          checkpoint(tool.contentKey, state.run, toolRecord(tool, 'unknown'), {
            ...saved.record.content, output: { status: 'unsupported' }
          });
          flow.writeState('health', { ...(flow.readState('health') || {}), piDispatchContentUnsupported: true });
        }
        tools.delete(key);
        return; // Actual child AGENT replaces the successful dispatch TOOL.
      }
    }
    const failed = event.isError || (/^(subagent|subagent_resume)$/.test(tool.name) && Boolean(event.result?.details?.error));
    if (tool.args) state.run = flow.captureSkill(state.run, { toolName: tool.name, input: tool.args, cwd: ctx.cwd, success: !failed });
    if (tool.contentKey) finishContent(tool.contentKey, state.run, toolRecord(tool, failed ? 'error' : 'completed'),
      () => ({ source: 'tool_execution_end', ...present(event, ['result', 'isError']),
        completeness: 'native-provided-only', artifactExpansion: false,
        nativeTruncated: Boolean(data(data(data(event, 'result'), 'details'), 'truncation')?.truncated) }));
    else flow.submit(state.run, [{ ...toolRecord(tool, failed ? 'error' : 'completed'), traceId: state.run.traceId,
      sessionId: state.run.sessionId, nativeSessionId: state.run.nativeSessionId, context: state.run }]);
    tools.delete(key);
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
    setStatus(state.pending.size ? `brain tracing: ${mode()}; awaiting child`
      : delivery?.accepted > 0 ? `brain tracing: ${mode()}; transport accepted (not ingestion verified)`
        : ['state_unavailable', 'invalid_outbox', 'failure'].includes(delivery?.status) ? `brain tracing: ${mode()}; telemetry unavailable`
          : `brain tracing: ${mode()}; no acknowledged export`);
  });
  for (const eventName of ['session_compact', 'session_compact_failed', 'session_tree']) {
    observe(eventName, event => {
      const state = current(); if (!state) return;
      const usage = event.compactionEntry?.usage || event.summaryEntry?.usage;
      if (!usage && eventName !== 'session_compact_failed') return;
      flow.submit(state.run, [{ id: flow.id(), traceId: state.run.traceId, parentId: state.run.rootSpanId,
        sessionId: state.run.sessionId, nativeSessionId: state.run.nativeSessionId, type: 'GENERATION',
        startTime: clock(), endTime: clock(),
        ...(usage ? { usage: usageDetails(usage) } : {}),
        ...(mode() === 'full-content' ? { content: content(() => ({})) } : {}),
        outcome: eventName === 'session_compact_failed' ? 'error' : 'completed', context: state.run }]);
    });
  }
  observe('session_shutdown', async () => {
    try {
      for (const tool of tools.values()) {
        if (tool.contentKey) finishContent(tool.contentKey, tool.state.run, toolRecord(tool, 'interrupted'));
        else flow.submit(tool.state.run, [{ ...toolRecord(tool, 'interrupted'), traceId: tool.state.run.traceId,
          sessionId: tool.state.run.sessionId, nativeSessionId: tool.state.run.nativeSessionId, context: tool.state.run }]);
      }
      for (const state of runStates()) {
        closeGeneration(state, 'interrupted');
        submitRoot(state, state.pending.size || !['completed', 'error', 'aborted'].includes(state.outcome) ? 'interrupted' : state.outcome);
      }
      if (flow) await flow.flush({ timeoutMs: 2500 });
    } catch {
      try { flow?.writeState('health', { ...(flow.readState('health') || {}), captureFailureObserved: true }); } catch {}
    } finally { cleanup(); }
  });

  function cleanup() {
    roots.clear(); tools.clear(); calls.clear(); requests.clear(); openKeys.clear(); blockedKeys.clear();
    mintedCapabilities.clear(); capabilityBudgetExceeded = false;
    active = undefined; rawInput = undefined; inputCapture = undefined;
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
        health: flow.readState?.('health') || { lineageLossObserved: false }, delivery: flow.readState?.('delivery') || null, harness: 'pi', captureMode: mode() };
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
