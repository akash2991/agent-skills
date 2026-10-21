'use strict';

// Claude's payloads and JSONL are private inputs. Only the explicit metadata
// projection below may cross the flow/state boundary; never checkpoint a row.
const fs = require('node:fs');
const path = require('node:path');
const { safeIdentity } = require('./privacy.cjs');

const HOOK_EVENTS = Object.freeze([
  'SessionStart', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse',
  'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Stop',
  'StopFailure', 'SessionEnd', 'PostModelSwitch'
]);
const TOOLS = new Set(['Agent', 'Task', 'Bash', 'PowerShell', 'Read', 'Write', 'Edit',
  'MultiEdit', 'Glob', 'Grep', 'Skill', 'WebFetch', 'WebSearch', 'NotebookEdit',
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput',
  'TaskStop', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'ToolSearch',
  'SubagentHandback', 'EndConversation']);
// Native agent_type is untrusted free text. Brain roles are verified against
// installed/source persona files by the flow, never a duplicate role registry.
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const USAGE_KEYS = { input_tokens: 'input', output_tokens: 'output',
  cache_creation_input_tokens: 'cache_creation_input_tokens', cache_read_input_tokens: 'cache_read_input_tokens' };
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;

function identity(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : null;
}
function model(value) {
  // Do not accept arbitrary gateway labels (or synthetic assistant rows) as
  // metadata. Unknown model names are deliberately omitted, not hashed.
  if (typeof value !== 'string' || value.length > 132 || !/^claude-(?:opus|sonnet|haiku)(?:-\d{1,8}){1,4}(?:\[1m\])?$/.test(value)) return undefined;
  // [1m] selects a context window, not a different foundation model. Strip
  // the known native suffix before crossing the shared metadata schema.
  const canonical = value.replace(/\[1m\]$/, '');
  return canonical.length <= 128 && safeIdentity(canonical) ? canonical : undefined;
}
function hasRuntimeModel(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    !['<synthetic>', 'synthetic'].includes(value);
}
function requestedModel(value) {
  return ['opus', 'sonnet', 'haiku', 'inherit'].includes(value) ? value : model(value);
}
function toolName(value) {
  return TOOLS.has(value) ? value : safeIdentity(value) || 'Tool';
}
function agentName(value, knownPersona) {
  return knownPersona ? value : safeIdentity(value);
}
function timestamp(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(n) && n > 0 && n < 8640000000000000 ? n : undefined;
}
function usage(value) {
  const result = {};
  for (const [native, canonical] of Object.entries(USAGE_KEYS)) {
    if (Number.isSafeInteger(value?.[native]) && value[native] >= 0) result[canonical] = value[native];
  }
  // TTL buckets are a breakdown of the aggregate, not additional tokens.
  // Exporting both makes Langfuse sum the same cache-write tokens twice.
  if (result.cache_creation_input_tokens === undefined) {
    const buckets = ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'].map(key => value?.cache_creation?.[key]);
    if (buckets.some(Number.isSafeInteger) && buckets.every(number => number === undefined || (Number.isSafeInteger(number) && number >= 0))) {
      result.cache_creation_input_tokens = buckets.reduce((sum, number) => sum + (number || 0), 0);
    }
  }
  return result;
}
function namespace(sessionId, childId) { return `claude:${sessionId}:${childId}`; }
function childSession(flow, sessionId, childId) {
  // A deterministic native child identity, not a hash of payload content.
  const hex = require('node:crypto').createHash('sha256').update(namespace(sessionId, childId)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function key(flow, kind, ...ids) { return `claude:${kind}:${flow.id(JSON.stringify(ids))}`; }
function callerIdentity(run) {
  // A Pre/Post pair belongs to this run, even if the native session's current
  // run changes meanwhile. Copy only the shared flow's safe identity metadata.
  return Object.fromEntries(['rootSpanId', 'traceId', 'parentSpanId', 'sessionId',
    'nativeSessionId', 'runId', 'projectId', 'startedAt', 'persona', 'ticketId',
    'agentName', 'requestedModel', 'requestedEffort', 'pendingIdentity']
    .filter(k => run[k] !== undefined).map(k => [k, run[k]]));
}
function record(run, fields) {
  return { traceId: run.traceId, parentId: run.rootSpanId, sessionId: run.sessionId,
    nativeSessionId: run.nativeSessionId, ...fields };
}
function agentRecord(run, now, terminal, actualModel) {
  const startTime = timestamp(run.startedAt) || now;
  return record(run, { id: run.rootSpanId, parentId: run.parentSpanId || null,
    type: 'AGENT', name: 'Claude agent', startTime,
    endTime: Math.max(startTime, terminal?.endTime || now), outcome: terminal?.outcome || 'unknown',
    ...(actualModel ? { model: actualModel, provider: 'anthropic' } : {}) });
}

// Read bounded chunks, retaining incomplete lines ONLY in process memory. The
// cursor points just past the last newline, so an asynchronously appended tail
// is re-read by the next hook. Per-message state is independent of this cursor.
function scanTranscript(file, cursor, visit) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return cursor;
    const resume = cursor?.inode === stat.ino && cursor.offset <= stat.size;
    let offset = resume ? cursor.offset : 0;
    let committed = offset;
    let line = Buffer.alloc(0);
    let oversized = resume && cursor.discarding === true;
    const buffer = Buffer.alloc(65536);
    const limit = Math.min(stat.size, offset + MAX_SCAN_BYTES);
    while (offset < limit) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, limit - offset), offset);
      if (!n) break;
      let start = 0;
      for (let i = 0; i < n; i++) {
        if (buffer[i] !== 10) continue;
        if (!oversized && line.length + i - start <= MAX_LINE_BYTES) {
          const text = Buffer.concat([line, buffer.subarray(start, i)]).toString('utf8');
          let row;
          try { row = JSON.parse(text); } catch { /* Never log parser excerpts. */ }
          if (row && typeof row === 'object') visit(row, offset + i + 1);
        }
        committed = offset + i + 1;
        line = Buffer.alloc(0);
        oversized = false;
        start = i + 1;
      }
      if (line.length + n - start > MAX_LINE_BYTES) oversized = true;
      if (!oversized) line = Buffer.concat([line, buffer.subarray(start, n)]);
      offset += n;
    }
    return { offset: oversized ? offset : committed, inode: stat.ino,
      ...(oversized ? { discarding: true } : {}) };
  } catch { return cursor; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function reconcileToolMetadata(flow, run, row, time) {
  const blocks = Array.isArray(row.message?.content) ? row.message.content : [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use' && identity(block.id) && hasRuntimeModel(row.message?.model)) {
      const stateKey = key(flow, 'tool', run.nativeSessionId, block.id);
      const previous = flow.readState(stateKey);
      if (!previous) flow.writeState(stateKey, {
        id: flow.id(`claude:tool:${run.nativeSessionId}:${block.id}`),
        toolName: toolName(block.name), startTime: time
      });
    }
    if (block.type !== 'tool_result' || !identity(block.tool_use_id)) continue;
    const stateKey = key(flow, 'tool', run.nativeSessionId, block.tool_use_id);
    const previous = flow.readState(stateKey);
    if (!previous) continue; // Never invent a tool identity/name from its result.
    // Cancellation can bypass PostToolUseFailure. Recognize only the native
    // marker, in memory; never store the result or a digest of it.
    const aborted = block.is_error === true && typeof block.content === 'string' &&
      ['[Request interrupted by user]', '[Request interrupted by user for tool use]'].includes(block.content);
    const outcome = aborted ? 'aborted' : block.is_error === true ? 'error' : 'completed';
    const state = { ...previous, endTime: previous.endTime || time,
      outcome: previous.outcome === 'aborted' ? 'aborted' :
        previous.outcome === 'error' && outcome === 'completed' ? 'error' : outcome };
    flow.writeState(stateKey, state);
    if (['Agent', 'Task'].includes(previous.toolName) && outcome === 'completed') continue;
    const caller = previous.caller ? flow.resolve(previous.caller) || previous.caller : run;
    flow.submit(caller, [record(caller, { id: state.id, type: 'TOOL',
      name: state.toolName, toolName: state.toolName, startTime: state.startTime,
      endTime: state.endTime, outcome: state.outcome })]);
  }
}

function reconcileTranscript(flow, run, file, childId) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return;
  const cursorKey = key(flow, 'cursor', run.nativeSessionId, file);
  const cursor = flow.readState(cursorKey);
  const generations = new Map();
  const next = scanTranscript(file, cursor, (row, position) => {
    // Main transcripts can carry sidechain records. Never attribute these to
    // the root or infer a child from its name/path/most recent dispatch.
    if (row.agentId && row.agentId !== childId) return;
    if (!childId && row.isSidechain) return;
    const time = timestamp(row.timestamp);
    if (!time) return;
    if (row.type === 'user' || row.type === 'assistant') reconcileToolMetadata(flow, run, row, time);
    if (row.type !== 'assistant' || !identity(row.message?.id)) return;
    if (!hasRuntimeModel(row.message.model)) return;
    const actualModel = model(row.message.model);
    run = flow.update(run, { observedModel: actualModel || null });
    const id = flow.id(`claude:generation:${run.nativeSessionId}:${row.message.id}`);
    const stateKey = key(flow, 'generation', run.nativeSessionId, id);
    const previous = flow.readState(stateKey);
    // Replayed hooks may race. Older rows must not overwrite the latest usage.
    const latest = !previous || time > previous.lastRowTime ||
      (time === previous.lastRowTime && position >= previous.position);
    const state = {
      id, startTime: Math.min(previous?.startTime || time, time),
      endTime: Math.max(previous?.endTime || time, time),
      lastRowTime: latest ? time : previous.lastRowTime,
      position: latest ? position : previous.position,
      model: latest ? actualModel : previous.model,
      usage: latest ? { ...(previous?.usage || {}), ...usage(row.message.usage) } : previous.usage
    };
    flow.writeState(stateKey, state);
    generations.set(id, record(run, { id, type: 'GENERATION', name: 'Claude generation',
      startTime: state.startTime, endTime: state.endTime,
      ...(state.model ? { model: state.model, provider: 'anthropic' } : {}),
      usage: state.usage, outcome: 'completed' }));
  });
  if (generations.size) flow.submit(run, [...generations.values()]);
  if (next) flow.writeState(cursorKey, next);
}

async function boundedFlush(flow, timeoutMs = 2500) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => flow.flush({ timeoutMs })),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs + Math.min(1000, timeoutMs)); })
    ]);
  } finally { clearTimeout(timer); }
}

/** Handle one native hook. Returns only a PreToolUse input update, or null.
 * A supplied flow makes this module usable without loading the transport. */
async function handleClaudeHook(payload, options = {}) {
  const env = options.env || process.env;
  if (['BRAIN_TRACING_ENABLED', 'LANGFUSE_TRACING_ENABLED'].some(key => ['false', '0'].includes(String(env[key] || '').toLowerCase()))) return null;
  if (!payload || !HOOK_EVENTS.includes(payload.hook_event_name)) return null;
  const sessionId = identity(payload.session_id);
  if (!sessionId) return null;
  const event = payload.hook_event_name;
  // An explicitly malformed child identity must not fall back to the root.
  if (payload.agent_id !== undefined && !identity(payload.agent_id)) return null;
  const childId = identity(payload.agent_id);
  if ((event === 'SubagentStart' || event === 'SubagentStop') && !childId) return null;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const flow = options.flow || require('./flow.cjs').createFlow({ harness: 'claude', cwd, env });
  const now = options.clock ? options.clock() : Date.now();
  const nativeSessionId = childId ? childSession(flow, sessionId, childId) : sessionId;
  const pendingIdentity = childId ? namespace(sessionId, childId) : undefined;
  const knownPersona = flow.knownPersona?.(cwd, payload.agent_type) === true;
  let run = flow.session(nativeSessionId) || flow.begin({ nativeSessionId, cwd,
    ...(pendingIdentity ? { pendingIdentity } : {}), agentName: agentName(payload.agent_type, knownPersona) });
  // Only the shared flow may resolve/rebase ancestry. SubagentStart's agent_id
  // is the NEW child, never evidence of its caller or dispatch tool ID.
  run = flow.resolve(run) || run;
  if (!run.persona && knownPersona) {
    run = flow.update(run, { persona: payload.agent_type, agentName: payload.agent_type });
  }
  const modelKey = key(flow, 'model', nativeSessionId);
  const observedModel = event === 'SessionStart' ? model(payload.model) :
    event === 'PostModelSwitch' ? model(payload.to_model) : undefined;
  if (observedModel) {
    flow.writeState(modelKey, { model: observedModel });
    run = flow.update(run, { requestedModel: observedModel });
  }
  const actualModel = observedModel || model(flow.readState(modelKey)?.model);
  const effort = EFFORTS.has(payload.effort?.level) ? payload.effort.level : undefined;
  if (effort) run = flow.update(run, { requestedEffort: effort });

  if (event === 'UserPromptSubmit' || event === 'UserPromptExpansion') {
    const promptId = identity(payload.prompt_id);
    // Identified prompts can be deduplicated. Native versions that omit the
    // identifier still emit a fresh Submit for each turn; reusing the previous
    // marker would falsely keep a second, interrupted turn completed. Expansion
    // belongs to the existing Submit when no prompt identifier is supplied.
    const activityKey = key(flow, 'activity', nativeSessionId);
    const current = flow.readState(activityKey);
    const promptKey = promptId ? key(flow, 'prompt', nativeSessionId, promptId) : activityKey;
    const priorActivity = promptId ? flow.readState(promptKey) : event === 'UserPromptExpansion' ? current : undefined;
    const activity = priorActivity || { startedAt: now,
      ...(promptId ? { promptId: flow.id(promptId) } : {}) };
    flow.writeState(promptKey, activity);
    if (!current || activity.startedAt >= current.startedAt) {
      flow.writeState(activityKey, activity);
      run = flow.captureBrainCommand(run, event === 'UserPromptExpansion'
        ? { commandName: payload.command_name, commandArgs: payload.command_args, cwd }
        : { text: payload.prompt, cwd });
      if (event === 'UserPromptExpansion' && payload.expansion_type === 'slash_command' &&
        flow.knownSkill?.(cwd, payload.command_name)) {
        run = flow.captureSkill(run, { toolName: 'Skill', input: { skill: payload.command_name },
          cwd, success: true, invoked: true });
      }
    }
  }

  let output = null;
  const toolId = identity(payload.tool_use_id);
  if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event) && toolId) {
    const stateKey = key(flow, 'tool', nativeSessionId, toolId);
    const prior = flow.readState(stateKey);
    const name = prior?.toolName || toolName(payload.tool_name);
    const dispatch = name === 'Agent' || name === 'Task';
    const id = flow.id(`claude:tool:${nativeSessionId}:${toolId}`);
    if (event === 'PreToolUse') {
      if (!prior?.caller) flow.writeState(stateKey, { ...prior, id, toolName: name,
        startTime: prior?.startTime || now, caller: callerIdentity(run) });
      if (name === 'Bash' && typeof payload.tool_input?.command === 'string') {
        // One reusable launch binding per exact native tool call, including
        // calls inside unresolved children. No prompt/context enters the shell.
        const launchKey = key(flow, 'bash-launch', nativeSessionId, toolId);
        let launch = flow.readState(launchKey);
        if (!launch) {
          const binding = flow.createToolLaunch(run);
          if (identity(binding?.nonce)) {
            launch = { nonce: binding.nonce };
            flow.writeState(launchKey, launch);
          }
        }
        if (launch) {
          const prefix = `export BRAIN_TRACE_LAUNCH_ID='${launch.nonce}'\n`;
          const command = payload.tool_input.command;
          output = { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: {
            ...payload.tool_input, command: command.startsWith(prefix) ? command : prefix + command
          } } };
        }
      }
      if (name === 'Skill') run = flow.captureSkill(run, { toolName: 'Skill',
        input: payload.tool_input, cwd, success: false, invoked: true });
    } else {
      const outcome = event === 'PostToolUseFailure'
        ? payload.is_interrupt === true ? 'aborted' : 'error' : 'completed';
      const endTime = prior?.endTime || now;
      const duration = Number.isFinite(payload.duration_ms) && payload.duration_ms >= 0
        ? Math.min(payload.duration_ms, now) : 0;
      const startTime = prior?.startTime || now - duration;
      const caller = prior?.caller ? flow.resolve(prior.caller) || prior.caller : run;
      flow.writeState(stateKey, { id, toolName: name, startTime, endTime, outcome,
        ...(prior?.caller ? { caller: prior.caller } : {}) });
      if (dispatch && event === 'PostToolUse') {
        const observedChild = identity(payload.tool_response?.agentId);
        // No pre-hook means no remembered exact caller. Missing/old response
        // schemas are conservative: do not guess, and do not double-count a
        // successful Agent dispatch as a TOOL.
        if (prior?.caller && observedChild) {
          const childNative = childSession(flow, sessionId, observedChild);
          const launchId = namespace(sessionId, observedChild);
          flow.store.createLaunch(caller, { launchId, multiUse: true });
          let child = flow.session(childNative) || flow.begin({ nativeSessionId: childNative,
            cwd, pendingIdentity: launchId });
          child = flow.remember(child, { pendingIdentity: launchId });
          child = flow.resolve(child) || child;
          const requested = requestedModel(payload.tool_input?.model);
          if (requested) child = flow.update(child, { requestedModel: requested });
          child = flow.captureBrainCommand(child, { text: payload.tool_input?.prompt, cwd });
          const terminal = flow.readState(key(flow, 'terminal', childNative));
          flow.submit(child, [agentRecord(child, now, terminal,
            flow.readState(key(flow, 'model', childNative))?.model)]);
        }
      } else {
        flow.submit(caller, [record(caller, { id, type: 'TOOL', name, toolName: name,
          startTime, endTime, outcome })]);
      }
      if (name === 'Skill') run = flow.captureSkill(run, { toolName: 'Skill',
        input: payload.tool_input, cwd, success: outcome === 'completed', invoked: true });
      if (name === 'Read' && outcome === 'completed') run = flow.captureSkill(run,
        { toolName: 'Read', input: payload.tool_input, cwd, success: true, invoked: false });
    }
  }

  // transcript_path on SubagentStop is the MAIN transcript. Child attribution
  // requires the explicit child path, never a filename/newest-agent heuristic.
  const transcript = childId ? payload.agent_transcript_path : payload.transcript_path;
  reconcileTranscript(flow, run, transcript, childId);
  if (typeof transcript === 'string' && ['Stop', 'SubagentStop', 'StopFailure', 'SessionEnd'].includes(event)) {
    // Claude writes JSONL asynchronously. A single bounded retry catches short
    // write lag; a later hook can reconcile anything still outstanding. There
    // is no promise of capture after SIGKILL or an indefinitely delayed write.
    await new Promise(resolve => setTimeout(resolve, 20));
    reconcileTranscript(flow, run, transcript, childId);
  }
  const terminalKey = key(flow, 'terminal', nativeSessionId);
  let terminal = flow.readState(terminalKey);
  const activity = flow.readState(key(flow, 'activity', nativeSessionId));
  const eventPrompt = identity(payload.prompt_id);
  const stalePrompt = eventPrompt && activity?.promptId && flow.id(eventPrompt) !== activity.promptId;
  if (!stalePrompt && ['Stop', 'SubagentStop', 'StopFailure', 'SessionEnd'].includes(event)) {
    const active = activity && (!terminal || activity.startedAt > terminal.endTime);
    let outcome = event === 'StopFailure' ? 'error' : event === 'SessionEnd'
      ? active || !terminal ? 'interrupted' : terminal.outcome : 'completed';
    if (payload.is_interrupt === true) outcome = 'aborted';
    terminal = { outcome, endTime: terminal?.outcome === outcome && !active ? terminal.endTime : now };
    flow.writeState(terminalKey, terminal);
  }
  const currentTerminal = terminal && (!activity || activity.startedAt <= terminal.endTime) ? terminal : undefined;
  flow.submit(run, [agentRecord(run, now, currentTerminal, actualModel)]);
  await boundedFlush(flow, options.flushTimeoutMs ?? 2500);
  return output;
}

module.exports = { HOOK_EVENTS, handleClaudeHook, reconcileTranscript };
