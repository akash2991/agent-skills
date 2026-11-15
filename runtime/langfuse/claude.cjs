'use strict';

// Native bodies cross ONLY the shared full-content projection and typed
// observation checkpoint API. Generic state and ContextStore remain metadata.
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
const MAX_LINE_BYTES = 8 * 1024 * 1024;

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
    'nativeSessionId', 'runId', 'harness', 'projectId', 'projectName', 'worktreeId',
    'runtimeName', 'branch', 'parentSessionId', 'startedAt', 'persona', 'ticketId',
    'ticketSource', 'agentName', 'requestedModel', 'requestedEffort', 'pendingIdentity',
    'skillsInvoked', 'skillsLoaded']
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
// deadlineAt bounds the scan: it stops after the first complete row at or past
// the deadline (so every call makes progress) and returns that row boundary as
// the cursor, letting the next hook resume instead of restarting.
function scanTranscript(file, cursor, visit, diagnostic = () => {}, deadlineAt = Infinity) {
  let fd, progress = null; // The last row boundary committed by this call.
  try {
    // Native transcripts need not use the private state-file modes or size
    // limit: scanning is incremental and bounded below. They must be regular
    // files, and the inspected inode must be the one we actually open.
    const before = fs.lstatSync(file);
    if (!before.isFile()) { diagnostic('transcript_not_regular'); return cursor; }
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || before.dev !== stat.dev || before.ino !== stat.ino) {
      diagnostic('transcript_changed'); return cursor;
    }
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
          try { row = JSON.parse(text); } catch { diagnostic('transcript_invalid_row'); }
          if (row && typeof row === 'object') visit(row, offset + i + 1, stat.ino);
        } else diagnostic('transcript_line_refused_size');
        committed = offset + i + 1;
        line = Buffer.alloc(0);
        oversized = false;
        start = i + 1;
        progress = { offset: committed, inode: stat.ino };
        if (Date.now() >= deadlineAt) return progress;
      }
      if (line.length + n - start > MAX_LINE_BYTES) oversized = true;
      if (!oversized) line = Buffer.concat([line, buffer.subarray(start, n)]);
      offset += n;
    }
    if (limit < stat.size) diagnostic('transcript_scan_limited');
    if (line.length || oversized) diagnostic(oversized ? 'transcript_line_refused_size' : 'transcript_partial_tail');
    return { offset: oversized ? offset : committed, inode: stat.ino,
      ...(oversized ? { discarding: true } : {}) };
  } catch (error) {
    // A publication/storage failure MUST propagate: advancing the content
    // cursor after a failed visit would permanently lose a native row.
    if (error?.claudePublicationFailure) throw error;
    // Keep rows already committed (e.g. a busy lock on a later row): the
    // failed row is not committed and is visited again by the next hook.
    diagnostic('transcript_unavailable'); return progress || cursor;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

const fullContent = flow => flow.captureMode?.() === 'full-content';
const observationKey = (flow, id) => key(flow, 'body', id);
function savedObservation(flow, id) {
  return flow.readObservation ? flow.readObservation(observationKey(flow, id)) : null;
}
function savedOwner(flow, capture, fallback) {
  const rootSpanId = capture?.owner.rootSpanId || fallback.rootSpanId;
  return flow.readState(`run:${rootSpanId}`)?.run || fallback;
}

// The common projector runs BEFORE any body persistence. Its plain JSON result
// also makes native JSON independent of SDK classes/getters/toJSON. Runtime
// capabilities are additional local secrets, not task identifiers. Check only
// known runtime values (never discover credentials/environment or reset global
// configured literals). The core redactor does not yet recognize --actor.
function projectNative(flow, run, surfaces) {
  const projected = flow.createContent(surfaces);
  const ownNonce = flow.readState(`actor-reference:${run.runId}`)?.nonce;
  const inbound = flow.inboundIdentity?.nonce;
  function scrub(value, changed) {
    if (typeof value === 'string') return value.replace(/[A-Za-z0-9_-]{32,128}/g, token => {
      const known = token === ownNonce || token === inbound || flow.readState(`actor-capability:${token}`)?.rootSpanId;
      if (!known) return token;
      changed.value = true; return '[REDACTED]';
    });
    if (Array.isArray(value)) return value.map(item => scrub(item, changed));
    if (value && typeof value === 'object') {
      const result = {};
      for (const [name, item] of Object.entries(value)) {
        const safeName = scrub(name, changed);
        if (Object.hasOwn(result, safeName)) changed.unsupported = true;
        result[safeName] = scrub(item, changed);
      }
      return result;
    }
    return value;
  }
  const result = { ...projected };
  for (const field of ['input', 'output']) {
    const surface = projected[field];
    if (!Object.hasOwn(surface, 'value')) continue;
    const changed = { value: false }, value = scrub(surface.value, changed);
    result[field] = changed.unsupported ? { status: 'unsupported' }
      : { status: changed.value ? 'credential_redacted' : surface.status, value };
  }
  return result;
}

// Retain a typed latest revision even after publication. Later metadata hooks
// must never erase richer content, and recovery must retain the original owner
// and capture grant. Capacity/refusal is explicit; no raw fallback checkpoint.
function publishRecord(flow, run, fields, surfaces, options = {}) {
  const previous = savedObservation(flow, fields.id);
  if (!fullContent(flow)) {
    if (previous) {
      if ([undefined, 'unknown', 'pending'].includes(previous.record.outcome) &&
          ![undefined, 'unknown', 'pending'].includes(fields.outcome)) {
        // The shared API can retry the old grant after downgrade, but cannot
        // issue a terminal revision under it. Keep the original body/owner;
        // never replace it with a new metadata grant or fabricate completion.
        flow.writeState(key(flow, 'capture-limit', fields.id), {
          reason: 'original_grant_revision_unavailable', observationId: fields.id, at: fields.endTime });
      }
      return flow.submitCaptured([previous]); // original grant, kill still wins
    }
    return flow.submit(run, [fields]);
  }
  const owner = savedOwner(flow, previous, run);
  const old = previous?.record;
  const content = old?.content || flow.createContent();
  const merged = { ...content };
  if (surfaces) {
    const projected = projectNative(flow, owner, surfaces);
    for (const field of ['input', 'output']) {
      if (!Object.hasOwn(surfaces, field)) continue;
      const before = content[field], after = projected[field];
      const canMerge = before?.value && after.value && !Array.isArray(before.value) &&
        !Array.isArray(after.value) && typeof before.value === 'object' && typeof after.value === 'object';
      merged[field] = canMerge ? { status: before.status === 'credential_redacted' || after.status === 'credential_redacted'
        ? 'credential_redacted' : after.status, value: { ...before.value, ...after.value } } : after;
    }
  }
  if (options.redactedOutput && Object.hasOwn(merged.output, 'value')) merged.output = {
    ...merged.output, status: 'credential_redacted' };
  const next = { ...old, ...fields, content: merged,
    startTime: Math.min(old?.startTime || fields.startTime, fields.startTime),
    endTime: Math.max(old?.endTime || fields.endTime, fields.endTime) };
  // A late Pre hook / bare transcript metadata cannot reopen a completed tool.
  if (old && old.type !== 'AGENT' && !['unknown', undefined].includes(old.outcome) &&
      [undefined, 'unknown'].includes(fields.outcome)) next.outcome = old.outcome;
  const capture = flow.captureObservation(owner, next);
  flow.writeObservation(observationKey(flow, fields.id), capture);
  if (!options.hold) flow.submitCaptured([capture]);
  return capture;
}
function submitRecords(flow, run, records) {
  for (const fields of records) publishRecord(flow, run, fields);
}
function coverage(flow, run, reason, now) {
  const id = flow.id(`claude:coverage:${run.rootSpanId}:${reason}`);
  // Fixed diagnostic vocabulary only; never parser/errors/path excerpts.
  publishRecord(flow, run, record(run, { id, type: 'SPAN', startTime: now,
    endTime: now, outcome: 'unknown' }), { output: { source: 'claude.adapter', coverage: reason } });
}

function transcriptSnapshot(file) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    return stat.isFile() && before.dev === stat.dev && before.ino === stat.ino
      ? { inode: stat.ino, device: stat.dev, offset: stat.size } : null;
  } catch (error) { return error.code === 'ENOENT' ? { inode: 0, device: 0, offset: 0 } : null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function contentEpoch(flow, run, file, now) {
  if (!flow.captureMode) return null;
  const epochKey = key(flow, 'full-epoch', run.nativeSessionId, run.rootSpanId);
  const previous = flow.readState(epochKey);
  if (!fullContent(flow)) {
    if (previous && !previous.paused) flow.writeState(epochKey, { ...previous, paused: true });
    return null;
  }
  if (typeof file !== 'string' || !path.isAbsolute(file)) return previous;
  const fileId = flow.id(file);
  if (previous?.fileId && previous.fileId !== fileId) {
    coverage(flow, run, 'transcript_branch_change_unsupported', now); return null;
  }
  if (previous?.fileId && !previous.paused) return previous;
  const snapshot = transcriptSnapshot(file);
  if (!snapshot) { coverage(flow, run, 'transcript_unavailable', now); return null; }
  // First full-content contact is a durable EOF cutover, not permission to
  // backfill a pre-existing session. Metadata reconciliation stays independent.
  const epoch = { ...snapshot, fileId, startedAt: previous?.startedAt || now,
    // EOF in a partial row cannot later become a new historical capture.
    skipInitialTail: snapshot.offset > 0 && !endsWithNewline(file, snapshot.offset) };
  flow.writeState(epochKey, epoch);
  flow.writeState(key(flow, 'full-cursor', run.nativeSessionId, run.rootSpanId), epoch);
  coverage(flow, run, 'native_surfaces_only_provider_request_unavailable', now);
  if (snapshot.offset) coverage(flow, run, 'content_cutover_existing_bytes_skipped', now);
  return epoch;
}
function endsWithNewline(file, size) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const byte = Buffer.alloc(1); return fs.readSync(fd, byte, 0, 1, size - 1) === 1 && byte[0] === 10;
  } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function publishDispatch(flow, child, toolCapture) {
  const id = flow.id(`claude:dispatch:${child.rootSpanId}:${toolCapture.record.id}`);
  const previous = savedObservation(flow, id);
  const childCapture = flow.captureObservation(savedOwner(flow, previous, child), record(child, { id,
    type: 'SPAN', startTime: toolCapture.record.startTime,
    endTime: Math.max(previous?.record.endTime || 0, toolCapture.record.endTime),
    outcome: toolCapture.record.outcome, content: toolCapture.record.content }));
  flow.writeObservation(observationKey(flow, id), childCapture);
  flow.submitCaptured([childCapture]);
}
function contentTool(flow, run, toolId, name, time, surfaces, outcome = 'unknown') {
  const stateKey = key(flow, 'tool', run.nativeSessionId, toolId), state = flow.readState(stateKey);
  const caller = state?.caller ? flow.resolve(state.caller) || state.caller : run;
  const id = flow.id(`claude:tool:${run.nativeSessionId}:${toolId}`);
  const dispatch = ['Agent', 'Task'].includes(name);
  const capture = publishRecord(flow, caller, record(caller, { id,
    type: dispatch ? 'SPAN' : 'TOOL', toolName: name,
    startTime: state?.startTime || time, endTime: state?.endTime || time, outcome }), surfaces,
  { hold: dispatch && !['error', 'aborted', 'interrupted'].includes(outcome) });
  if (dispatch && state?.childRootSpanId) {
    const child = flow.readState(`run:${state.childRootSpanId}`)?.run;
    if (child && child.nativeSessionId === state.childNativeSessionId) publishDispatch(flow, child, capture);
    else coverage(flow, caller, 'dispatch_exact_child_binding_unavailable', time);
  }
  const openKey = key(flow, 'open-tools', run.nativeSessionId);
  const open = flow.readState(openKey) || { ids: [] };
  const ids = capture && !['unknown', undefined].includes(capture.record.outcome)
    ? open.ids.filter(item => item !== id) : open.ids.includes(id) ? open.ids : [...open.ids, id];
  flow.writeState(openKey, { ids });
  return capture;
}
function generationContent(flow, run, row, time, position, now) {
  const id = flow.id(`claude:generation:${run.nativeSessionId}:${row.message.id}`);
  const saved = savedObservation(flow, id);
  if (!Object.hasOwn(row.message, 'content')) {
    coverage(flow, run, 'assistant_content_unavailable', now); return;
  }
  if (['refused_size', 'unsupported'].includes(saved?.record.content?.output?.status)) {
    coverage(flow, run, 'generation_content_previously_refused', now); return;
  }
  const rows = saved?.record.content?.output?.value?.nativeRows || [];
  // Keep native row/block boundaries. Distinct rows are NEVER blindly
  // concatenated, nor is a later text block allowed to erase earlier ones.
  // Revisions of the same native row are explicit ordered snapshots.
  const rowId = typeof row.uuid === 'string' ? row.uuid : `offset:${position}`;
  const nativeRow = { rowId, position, blocks: row.message.content,
    nativeTruncation: row.isTruncated === true || row.message.is_truncated === true ||
      row.message.truncated === true || row.message.stop_reason === 'max_tokens' ? 'reported_truncated' : 'unknown' };
  if (Object.hasOwn(row.message, 'stop_reason')) nativeRow.stopReason = row.message.stop_reason;
  const projected = projectNative(flow, run, { output: nativeRow }).output;
  const metadata = flow.readState(key(flow, 'generation', run.nativeSessionId, id));
  const fields = record(run, { id, type: 'GENERATION', startTime: metadata?.startTime || time,
    endTime: metadata?.endTime || time, outcome: 'completed', model: model(row.message.model),
    provider: 'anthropic', usage: metadata?.usage || usage(row.message.usage) });
  if (Object.hasOwn(projected, 'value')) {
    const nativeRows = [...rows];
    if (!nativeRows.some(item => item.position === position && item.rowId === rowId &&
        JSON.stringify(item.blocks) === JSON.stringify(projected.value.blocks))) nativeRows.push(projected.value);
    publishRecord(flow, run, fields, { output: { source: 'claude.transcript', nativeRows,
      coverage: { assembly: 'ordered_native_row_snapshots_not_concatenated', providerRequest: 'unavailable',
        hiddenReasoning: 'unavailable', media: 'native_blocks_only_no_artifact_fetch' } } },
    { redactedOutput: projected.status === 'credential_redacted' });
  } else {
    const capture = publishRecord(flow, run, fields);
    const refused = flow.captureObservation(savedOwner(flow, capture, run), { ...capture.record,
      content: { ...capture.record.content, output: projected } });
    flow.writeObservation(observationKey(flow, id), refused); flow.submitCaptured([refused]);
  }
}
function reconcileContent(flow, run, file, childId, now, deadlineAt = Infinity) {
  if (!fullContent(flow) || !contentEpoch(flow, run, file, now)) return;
  if (typeof file !== 'string' || !path.isAbsolute(file)) return;
  const cursorKey = key(flow, 'full-cursor', run.nativeSessionId, run.rootSpanId);
  let cursor = flow.readState(cursorKey);
  const snapshot = transcriptSnapshot(file);
  if (!snapshot) { coverage(flow, run, 'transcript_unavailable', now); return; }
  if (cursor.inode && (cursor.inode !== snapshot.inode || cursor.device !== snapshot.device || cursor.offset > snapshot.offset)) {
    coverage(flow, run, 'transcript_replaced_no_backfill', now);
    cursor = { ...snapshot, skipInitialTail: snapshot.offset > 0 && !endsWithNewline(file, snapshot.offset) };
    flow.writeState(cursorKey, cursor); return;
  }
  const next = scanTranscript(file, { ...cursor, ...(cursor.skipInitialTail ? { discarding: true } : {}) }, (row, position) => {
    try {
      if (row.agentId && row.agentId !== childId || !childId && row.isSidechain) return;
      if (row.sessionId && row.sessionId !== run.nativeSessionId && !childId) return;
      if (!['user', 'assistant'].includes(row.type)) return;
      const time = timestamp(row.timestamp);
      if (!time) { coverage(flow, run, 'transcript_row_time_unavailable', now); return; }
      const blocks = row.message?.content;
      if (row.type === 'assistant' && identity(row.message?.id) && hasRuntimeModel(row.message.model)) {
        generationContent(flow, run, row, time, position, now);
      }
      if (row.type === 'user' || !identity(row.message?.id) || !hasRuntimeModel(row.message?.model)) {
        const id = flow.id(`claude:native-row:${run.rootSpanId}:${position}`);
        const native = { source: 'claude.transcript', rowType: row.type,
          position, blocks, providerRequest: 'unavailable' };
        publishRecord(flow, run, record(run, { id, type: 'SPAN', startTime: time,
          endTime: time, outcome: 'completed' }), row.type === 'user' ? { input: native } : { output: native });
      }
      if (!Array.isArray(blocks)) return;
      for (const [blockIndex, block] of blocks.entries()) {
        if (block?.type === 'tool_use' && identity(block.id) && hasRuntimeModel(row.message?.model)) {
          const stateKey = key(flow, 'tool', run.nativeSessionId, block.id);
          const state = flow.readState(stateKey);
          if (state && !state.caller) flow.writeState(stateKey, { ...state, caller: callerIdentity(run) });
          const id = flow.id(`claude:tool:${run.nativeSessionId}:${block.id}`);
          const snapshots = savedObservation(flow, id)?.record.content?.input?.value?.transcriptToolUses || [];
          const next = snapshots.some(item => item.position === position && item.blockIndex === blockIndex)
            ? snapshots : [...snapshots, { position, blockIndex, block }];
          contentTool(flow, run, block.id, toolName(block.name), time,
            { input: { transcriptToolUses: next } }, state?.outcome || 'unknown');
        }
        if (block?.type === 'tool_result' && identity(block.tool_use_id)) {
          const state = flow.readState(key(flow, 'tool', run.nativeSessionId, block.tool_use_id));
          if (!state) { coverage(flow, run, 'tool_result_without_exact_call', now); continue; }
          const id = flow.id(`claude:tool:${run.nativeSessionId}:${block.tool_use_id}`);
          const snapshots = savedObservation(flow, id)?.record.content?.output?.value?.transcriptToolResults || [];
          const next = snapshots.some(item => item.position === position && item.blockIndex === blockIndex)
            ? snapshots : [...snapshots, { position, blockIndex, block }];
          const toolCapture = contentTool(flow, run, block.tool_use_id, state.toolName, time,
            { output: { transcriptToolResults: next } }, state.outcome || 'unknown');
          if (['Agent', 'Task'].includes(state.toolName) && state.outcome === 'completed' && !state.childRootSpanId) {
            coverage(flow, run, 'dispatch_exact_child_binding_unavailable', time);
            flow.submitCaptured([toolCapture]);
          }
        }
      }
    } catch (error) { error.claudePublicationFailure = true; throw error; }
  }, reason => coverage(flow, run, reason, now), deadlineAt);
  if (next) flow.writeState(cursorKey, { ...next, device: snapshot.device });
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
      else if (previous.startUnknown && time <= previous.startTime) {
        // A completed tool recorded with a placeholder start: correct it and
        // publish a new revision of the same observation.
        const { startUnknown, ...known } = previous;
        const state = { ...known, startTime: time };
        flow.writeState(stateKey, state);
        if (state.outcome && !(['Agent', 'Task'].includes(state.toolName) && state.outcome === 'completed')) {
          const caller = state.caller ? flow.resolve(state.caller) || state.caller : run;
          submitRecords(flow, caller, [record(caller, { id: state.id,
            type: fullContent(flow) && ['Agent', 'Task'].includes(state.toolName) ? 'SPAN' : 'TOOL',
            name: state.toolName, toolName: state.toolName, startTime: state.startTime,
            endTime: state.endTime, outcome: state.outcome })]);
        }
      }
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
    submitRecords(flow, caller, [record(caller, { id: state.id,
      type: fullContent(flow) && ['Agent', 'Task'].includes(state.toolName) ? 'SPAN' : 'TOOL',
      name: state.toolName, toolName: state.toolName, startTime: state.startTime,
      endTime: state.endTime, outcome: state.outcome })]);
  }
}

function reconcileTranscript(flow, run, file, childId, deadlineAt = Infinity) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return;
  const cursorKey = key(flow, 'cursor', run.nativeSessionId, file);
  const cursor = flow.readState(cursorKey);
  const generations = new Map();
  const next = scanTranscript(file, cursor, (row, position, inode) => {
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
    // Each update is a context transaction; skip the ones that change nothing.
    if (run.observedModel !== (actualModel || null)) run = flow.update(run, { observedModel: actualModel || null });
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
    // Publish in small batches and save the cursor with each, including the
    // batch that reaches the deadline: the budget then pays for publishing,
    // and a hook killed at its cap still keeps the progress it made.
    if (generations.size >= 5 || Date.now() >= deadlineAt) {
      submitRecords(flow, run, [...generations.values()]); generations.clear();
      flow.writeState(cursorKey, { offset: position, inode });
    }
  }, undefined, deadlineAt);
  if (generations.size) submitRecords(flow, run, [...generations.values()]);
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

const killed = env => ['BRAIN_TRACING_ENABLED', 'LANGFUSE_TRACING_ENABLED']
  .some(key => ['false', '0'].includes(String(env[key] || '').toLowerCase()));

/** Process one native hook in this process. Returns supported actor
 * additionalContext, or null. Never rewrites tool input or participates in
 * native permission decisions. A supplied flow makes this module usable
 * without loading the transport. Options: reconcile:false skips transcript
 * reconciliation, reconcileBudgetMs bounds it, flush:false skips delivery,
 * acknowledgeSession acknowledges a brain launch on SessionStart. */
async function processClaudeHook(payload, options = {}) {
  const env = options.env || process.env;
  if (killed(env)) return null;
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
  if (options.acknowledgeSession === true && event === 'SessionStart' && !childId) flow.acknowledgeSession?.(sessionId);
  const now = options.clock ? options.clock() : Date.now();
  const reconcileDeadline = options.reconcile === false ? null
    : Date.now() + (Number.isFinite(options.reconcileBudgetMs) ? options.reconcileBudgetMs : Infinity);
  const nativeSessionId = childId ? childSession(flow, sessionId, childId) : sessionId;
  const pendingIdentity = childId ? namespace(sessionId, childId) : undefined;
  const knownPersona = flow.knownPersona?.(cwd, payload.agent_type) === true;
  let run = flow.session(nativeSessionId) || flow.begin({ nativeSessionId, cwd, reuseSession: true,
    ...(pendingIdentity ? { pendingIdentity } : {}), agentName: agentName(payload.agent_type, knownPersona) });
  // Only the shared flow may resolve/rebase ancestry. SubagentStart's agent_id
  // is the NEW child, never evidence of its caller or dispatch tool ID.
  run = flow.resolve(run) || run;
  if (!run.persona && knownPersona) {
    run = flow.update(run, { persona: payload.agent_type, agentName: payload.agent_type });
  }
  const modelKey = key(flow, 'model', nativeSessionId);
  const modelEvent = event === 'SessionStart' && Object.hasOwn(payload, 'model') ||
    event === 'PostModelSwitch' && Object.hasOwn(payload, 'to_model');
  if (modelEvent) {
    const configured = model(event === 'SessionStart' ? payload.model : payload.to_model);
    // Null records explicit unknown current-model evidence, unlike no model
    // event. Never persist the unsupported native label or reuse stale facts.
    flow.writeState(modelKey, { model: configured || null });
    run = flow.update(run, { requestedModel: configured || null, observedModel: null });
  }
  const actualModel = model(flow.readState(modelKey)?.model);
  // Initialize full-content cutover BEFORE this hook's native surfaces. Child
  // hooks may ONLY supply their explicit agent_transcript_path.
  const transcript = childId ? payload.agent_transcript_path : payload.transcript_path;
  contentEpoch(flow, run, transcript, now);
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
    if (fullContent(flow)) {
      const id = flow.id(`claude:prompt:${run.rootSpanId}:${activity.startedAt}:${event}`);
      const surfaces = { input: { source: `claude.hook.${event}` } };
      for (const field of event === 'UserPromptExpansion'
        ? ['prompt', 'original_prompt', 'expanded_prompt', 'command_name', 'command_args', 'expansion_type'] : ['prompt']) {
        if (Object.hasOwn(payload, field)) surfaces.input[field] = payload[field];
      }
      publishRecord(flow, run, record(run, { id, type: 'SPAN', startTime: activity.startedAt,
        endTime: now, outcome: 'completed' }), surfaces);
      // Native actor prompt is explicitly NOT the hidden provider request.
      if (!current || activity.startedAt >= current.startedAt) publishRecord(flow, run,
        agentRecord(run, now), { input: { [event]: surfaces.input } });
    }
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
  if (['SessionStart', 'UserPromptSubmit', 'SubagentStart'].includes(event)) {
    // Mint for this exact actor, even while its native ancestry is pending.
    // The capability permits own-metadata edits, never guessed export ancestry.
    const binding = flow.actorCapability ? flow.actorCapability(run) : flow.createToolLaunch(run);
    if (/^[A-Za-z0-9_-]{32,128}$/.test(binding?.nonce || '')) {
      output = { hookSpecificOutput: { hookEventName: event, additionalContext:
        `Brain tracing actor: --actor ${binding.nonce}. This local non-secret capability identifies only this actor; do not reuse a parent's actor in a child. ` +
        'Use brain-trace.cjs context --actor NONCE status|set, launch --actor NONCE ..., or exec --actor NONCE --harness pi|claude [--cwd PATH] -- NATIVE_ARGS for explicit tracing. ' +
        'Replace NONCE with this actor value. Ordinary Bash commands are unchanged and retain native permissions. Never put credentials or task content in tracing identifiers.' } };
    }
  }
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
      if (fullContent(flow)) contentTool(flow, run, toolId, name, now,
        Object.hasOwn(payload, 'tool_input') ? { input: { preToolUse: payload.tool_input } } : undefined);
      if (name === 'Skill') run = flow.captureSkill(run, { toolName: 'Skill',
        input: payload.tool_input, cwd, success: false, invoked: true });
    } else {
      const nativeOutcome = event === 'PostToolUseFailure'
        ? payload.is_interrupt === true ? 'aborted' : 'error' : 'completed';
      const outcome = fullContent(flow) && prior?.outcome === 'aborted' ? 'aborted'
        : fullContent(flow) && prior?.outcome === 'error' && nativeOutcome === 'completed' ? 'error' : nativeOutcome;
      const endTime = prior?.endTime || now;
      const duration = Number.isFinite(payload.duration_ms) && payload.duration_ms >= 0
        ? Math.min(payload.duration_ms, now) : 0;
      const startTime = prior?.startTime || now - duration;
      // Without PreToolUse or duration_ms the start is a placeholder; the
      // transcript's tool_use row backfills it (reconcileToolMetadata).
      const startUnknown = !prior?.startTime && !(duration > 0);
      const caller = prior?.caller ? flow.resolve(prior.caller) || prior.caller : run;
      flow.writeState(stateKey, { ...prior, id, toolName: name, startTime, endTime, outcome,
        ...(prior?.caller ? { caller: prior.caller } : {}), ...(startUnknown ? { startUnknown: true } : {}) });
      const responseChild = dispatch && event === 'PostToolUse' ? identity(payload.tool_response?.agentId) : null;
      const bindingConflict = responseChild && prior?.childNativeSessionId &&
        childSession(flow, sessionId, responseChild) !== prior.childNativeSessionId;
      if (bindingConflict && fullContent(flow)) coverage(flow, caller, 'dispatch_child_rebind_refused', now);
      let toolCapture;
      if (fullContent(flow) && !bindingConflict) {
        const surfaces = {};
        if (Object.hasOwn(payload, 'tool_input')) surfaces.input = { postToolUse: payload.tool_input };
        if (event === 'PostToolUse' && Object.hasOwn(payload, 'tool_response')) surfaces.output = { postToolUse: payload.tool_response };
        if (event === 'PostToolUseFailure') {
          surfaces.output = { source: 'claude.hook.PostToolUseFailure', isInterrupt: payload.is_interrupt === true };
          for (const field of ['error', 'error_details']) if (Object.hasOwn(payload, field)) surfaces.output[field] = payload[field];
        }
        toolCapture = contentTool(flow, caller, toolId, name, now, surfaces, outcome);
      }
      if (dispatch && event === 'PostToolUse') {
        const observedChild = responseChild;
        // No pre-hook means no remembered exact caller. Missing/old response
        // schemas are conservative: do not guess, and do not double-count a
        // successful Agent dispatch as a TOOL.
        if (prior?.caller && observedChild && !bindingConflict) {
          const childNative = childSession(flow, sessionId, observedChild);
          const launchId = namespace(sessionId, observedChild);
          flow.store.createLaunch(caller, { launchId, multiUse: true });
          let child = flow.session(childNative) || flow.begin({ nativeSessionId: childNative,
            cwd, pendingIdentity: launchId });
          child = flow.remember(child, { pendingIdentity: launchId });
          child = flow.resolve(child) || child;
          const savedInput = toolCapture?.record.content?.input?.value?.preToolUse;
          const dispatchInput = payload.tool_input === undefined ? savedInput : payload.tool_input;
          const requested = requestedModel(dispatchInput?.model);
          if (requested) child = flow.update(child, { requestedModel: requested });
          child = flow.captureBrainCommand(child, { text: dispatchInput?.prompt, cwd });
          const terminal = flow.readState(key(flow, 'terminal', childNative));
          if (toolCapture) {
            // Immutable exact child binding also permits later transcript
            // reconciliation to enrich this associated dispatch evidence.
            flow.writeState(stateKey, { ...flow.readState(stateKey), childRootSpanId: child.rootSpanId,
              childNativeSessionId: child.nativeSessionId });
            publishDispatch(flow, child, toolCapture);
          }
          submitRecords(flow, child, [agentRecord(child, now, terminal,
            flow.readState(key(flow, 'model', childNative))?.model)]);
        } else if (fullContent(flow)) {
          coverage(flow, caller, 'dispatch_exact_child_binding_unavailable', now);
          if (toolCapture) flow.submitCaptured([toolCapture]);
        }
      } else {
        submitRecords(flow, caller, [record(caller, { id, type: fullContent(flow) && dispatch ? 'SPAN' : 'TOOL', name, toolName: name,
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
  if (reconcileDeadline !== null) {
    reconcileTranscript(flow, run, transcript, childId, reconcileDeadline);
    reconcileContent(flow, run, transcript, childId, now, reconcileDeadline);
    if (typeof transcript === 'string' && ['Stop', 'SubagentStop', 'StopFailure', 'SessionEnd'].includes(event)) {
      // Claude writes JSONL asynchronously. A single bounded retry catches short
      // write lag; a later hook can reconcile anything still outstanding. There
      // is no promise of capture after SIGKILL or an indefinitely delayed write.
      await new Promise(resolve => setTimeout(resolve, 20));
      reconcileTranscript(flow, run, transcript, childId, reconcileDeadline);
      reconcileContent(flow, run, transcript, childId, now, reconcileDeadline);
    }
  }
  // Reconciliation can discover historical known-model rows after a switch.
  // Keep their generation evidence, but do not re-label the unknown current
  // actor using those prior observations.
  if (flow.readState(modelKey)?.model === null) {
    run = flow.update(flow.resolve(run) || run, { requestedModel: null, observedModel: null });
  }
  const terminalKey = key(flow, 'terminal', nativeSessionId);
  let terminal = flow.readState(terminalKey);
  const activity = flow.readState(key(flow, 'activity', nativeSessionId));
  const eventPrompt = identity(payload.prompt_id);
  const stalePrompt = eventPrompt && activity?.promptId && flow.id(eventPrompt) !== activity.promptId;
  // A terminal event received before the current turn began, or before the
  // last recorded terminal, belongs to an older turn (detached events can be
  // processed late). Drop it rather than attach its outcome or answer here.
  const terminalEvent = TERMINAL_EVENTS.includes(event);
  if (terminalEvent && ((activity && activity.startedAt > now) || (terminal && terminal.endTime > now))) {
    if (options.flush !== false) await boundedFlush(flow, options.flushTimeoutMs ?? 2500);
    return output;
  }
  if (!stalePrompt && terminalEvent) {
    const active = activity && (!terminal || activity.startedAt > terminal.endTime);
    let outcome = event === 'StopFailure' ? 'error' : event === 'SessionEnd'
      ? active || !terminal ? 'interrupted' : terminal.outcome : 'completed';
    if (payload.is_interrupt === true) outcome = 'aborted';
    terminal = { outcome, endTime: terminal?.outcome === outcome && !active ? terminal.endTime : now };
    flow.writeState(terminalKey, terminal);
  }
  const currentTerminal = terminal && (!activity || activity.startedAt <= terminal.endTime) ? terminal : undefined;
  if (fullContent(flow) && !stalePrompt && currentTerminal) {
    const surfaces = ['Stop', 'SubagentStop', 'StopFailure', 'SessionEnd'].includes(event) &&
      Object.hasOwn(payload, 'last_assistant_message')
      ? { output: { terminalLastAssistantMessage: { source: `claude.hook.${event}.last_assistant_message`,
        value: payload.last_assistant_message, providerRequest: 'unavailable' } } } : undefined;
    publishRecord(flow, run, agentRecord(run, now, currentTerminal, actualModel), surfaces);
    if (['SessionEnd', 'StopFailure'].includes(event)) {
      const open = flow.readState(key(flow, 'open-tools', nativeSessionId));
      for (const id of open?.ids || []) {
        const capture = savedObservation(flow, id);
        if (!capture || !['unknown', undefined].includes(capture.record.outcome)) continue;
        const owner = savedOwner(flow, capture, run);
        publishRecord(flow, owner, { ...capture.record, endTime: Math.max(now, capture.record.endTime),
          outcome: 'interrupted' }); // Unknown output stays unavailable, never fabricated.
      }
    }
  } else submitRecords(flow, run, [agentRecord(run, now, currentTerminal, actualModel)]);
  if (options.flush !== false) await boundedFlush(flow, options.flushTimeoutMs ?? 2500);
  return output;
}

// Observability must never slow the session down; dropping data is acceptable.
// Every hook event is processed in Claude's native hook order, by a work
// process the hook waits for up to a hard cap. The work process runs in its own
// process group, with the work in a worker thread and a supervising main
// thread; at the cap the hook kills the whole group, subprocesses included (a
// thread alone is not enough: process exit waits for a worker blocked in a
// native call). The event is then dropped. Reading the transcript is bounded by
// a small budget per hook and resumes at the saved cursor. Only delivery to
// Langfuse runs in the background, by one uploader at a time; it publishes
// records already captured and never touches turn state.
const TERMINAL_EVENTS = Object.freeze(['Stop', 'SubagentStop', 'StopFailure', 'SessionEnd']);
// PreToolUse binds a dispatch to its caller; it is registered only for these.
const PRE_TOOLS = Object.freeze(['Agent', 'Task', 'Skill']);
// Anchored: an unanchored pattern also matches TaskCreate, TaskUpdate and the like.
const HOOK_MATCHERS = Object.freeze({ PreToolUse: `^(?:${PRE_TOOLS.join('|')})$` });
const LIMITS = Object.freeze({ inlineMs: 1500, inlineMaxMs: 5000, handoffMs: 1000,
  reconcileMs: 300, flushPassMs: 2000, lifetimeMs: 60000 });
const DETACHED = '--agent-brain-detached';
// Overrides for slow machines and tests, clamped so the hook still fits under
// Claude's 8-second native timeout and the uploader stays short-lived.
function limit(name, fallback, min, max, env = process.env) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, value)) : fallback;
}
const killGroup = pid => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } };

// The lifetime travels as an absolute end time, so the work process's own
// backstop does not drift by its boot time.
function spawnWorkProcess(mode, receivedAt, lifetimeMs, extra = [], env = process.env) {
  return require('node:child_process').spawn(process.execPath,
    [__filename, DETACHED, mode, String(receivedAt), String(Date.now() + lifetimeMs), ...extra],
    { detached: true, env: { ...env, BRAIN_TRACE_HOOK_PARENT: String(process.pid) },
      stdio: ['pipe', mode === 'event' ? 'pipe' : 'ignore', 'ignore'] });
}

// The hook only spawns, pipes and waits: it performs no synchronous state I/O,
// so a stalled filesystem or lock cannot hold it past the cap.
function runEvent(payload, receivedAt, options) {
  return new Promise(resolve => {
    let child, done = false;
    const chunks = [];
    const finish = value => {
      if (done) return;
      done = true; clearTimeout(timer);
      // Always: the leader may have exited while descendants live on.
      if (child?.pid) killGroup(child.pid);
      resolve(value || null);
    };
    let cap = options.inlineMs ?? limit('BRAIN_TRACE_HOOK_INLINE_MS', LIMITS.inlineMs, 100, LIMITS.inlineMaxMs, options.env);
    // A supervising entrypoint passes its absolute deadline: the work process
    // must be gone by then, so both the wait and its lifetime end there.
    const deadline = Number(options.env.BRAIN_TRACE_HOOK_DEADLINE);
    const remaining = Number.isFinite(deadline) ? deadline - Date.now() : Infinity;
    if (remaining < 50) { resolve(null); return; }
    cap = Math.min(cap, remaining);
    const timer = setTimeout(() => finish(null), cap);
    try {
      // The child's own lifetime is a backstop if this hook process is killed.
      child = spawnWorkProcess('event', receivedAt, Math.max(1, Math.min(cap + 500, remaining)),
        options.acknowledgeSession === true ? ['ack'] : [], options.env);
      child.once('error', () => finish(null));
      child.stdout.on('data', chunk => chunks.push(chunk));
      child.once('close', () => {
        let value = null;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* no output */ }
        finish(value);
      });
      child.stdin.once('error', () => {});
      child.stdin.end(JSON.stringify(payload));
    } catch { finish(null); }
  });
}

/** Production entry for a native hook: bounded, fails open, returns actor
 * additionalContext or null. Options: acknowledgeSession, env, inlineMs (tests). */
async function runClaudeHook(payload, options = {}) {
  options = { ...options, env: options.env || process.env };
  try {
    if (killed(options.env) || !payload || !HOOK_EVENTS.includes(payload.hook_event_name)
      || !identity(payload.session_id)) return null;
    // Older settings register PreToolUse for every tool; never pay for those.
    if (payload.hook_event_name === 'PreToolUse' && !PRE_TOOLS.includes(payload.tool_name)) return null;
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
    return await runEvent({ ...payload, cwd }, Date.now(), options);
  } catch { return null; } // Observability failures never block a tool or session.
}

/** Tests inject a flow and run in-process; native callers get the bounded path. */
function handleClaudeHook(payload, options = {}) {
  return options.flow ? processClaudeHook(payload, options) : runClaudeHook(payload, options);
}

function readStdin(timeoutMs) {
  return new Promise(resolve => {
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => resolve(null), timeoutMs);
    process.stdin.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { clearTimeout(timer); resolve(null); process.stdin.destroy(); return; }
      chunks.push(chunk);
    });
    process.stdin.once('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.once('error', () => { clearTimeout(timer); resolve(null); });
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function underLock(stateDir, kind, waitMs, fn) {
  const { claimLock } = require('./locks.cjs');
  const deadlineAt = Date.now() + waitMs;
  let lock;
  try { lock = claimLock(stateDir, kind, { deadlineAt: Math.max(deadlineAt, Date.now() + 1000) }); }
  catch { return { acquired: false }; }
  let polls = 0;
  try {
    for (;;) {
      let blocked;
      try { blocked = lock.blocked(); } catch { return { acquired: false }; }
      if (!blocked) break;
      if (Date.now() >= deadlineAt) return { acquired: false };
      // Back off with jitter: each poll rereads every claim.
      await sleep(Math.min(200, 10 * 2 ** Math.min(polls++, 4)) * (0.5 + Math.random()));
    }
    return { acquired: true, value: await fn() };
  } finally { lock.release(); }
}

// One deliverer at a time. A process that finds the flusher busy leaves a
// request timestamp; the flusher repeats while requests arrive after its pass.
// The short wait covers a peer still choosing its ticket, so two finishing
// processes cannot both back off.
async function flushSingleFlight(flow, endAt) {
  const request = path.join(flow.stateDir, 'claude-flush-request');
  const requestedAt = () => { try { return Number(fs.readFileSync(request, 'utf8')) || 0; } catch { return 0; } };
  for (let attempt = 0; attempt < 2; attempt++) {
    let passStart = 0;
    const result = await underLock(flow.stateDir, 'flusher', 250, async () => {
      do {
        passStart = Date.now();
        await flow.flush({ timeoutMs: Math.min(LIMITS.flushPassMs, Math.max(0, endAt - Date.now())) });
      } while (requestedAt() >= passStart && Date.now() < endAt - 1000);
    });
    // Busy: the holder sees the request. Done: retry once only for a request
    // that landed between the last pass and the release.
    if (!result.acquired || requestedAt() < passStart || Date.now() >= endAt - 1000) return;
  }
}

// After an event: ask for delivery, and start the uploader unless one runs.
// A rare duplicate uploader finds the lock busy and exits.
function requestDelivery(flow, cwd, receivedAt) {
  try { fs.writeFileSync(path.join(flow.stateDir, 'claude-flush-request'), String(Date.now()), { mode: 0o600 }); } catch { return Promise.resolve(); }
  // An uploader is running only if a claim names a live PID and is younger
  // than an uploader can live. A dead uploader's claim is left for the next
  // uploader's claimLock to recover, so it never stops delivery.
  let running = false;
  try {
    const dir = path.join(flow.stateDir, 'flusher-claims');
    running = fs.readdirSync(dir).some(name => {
      const pid = Number(/^(\d+)-[a-f0-9]{32}\.json$/.exec(name)?.[1]);
      if (!pid) return false;
      try {
        if (Date.now() - fs.statSync(path.join(dir, name)).mtimeMs > LIMITS.lifetimeMs + 5000) return false;
        process.kill(pid, 0); return true;
      } catch { return false; }
    });
  } catch { /* none yet */ }
  if (running) return Promise.resolve();
  return new Promise(resolve => {
    // Short: the event's answer waits for this handoff.
    const timer = setTimeout(resolve, 200);
    try {
      const child = spawnWorkProcess('flush', receivedAt, limit('BRAIN_TRACE_HOOK_LIFETIME_MS', LIMITS.lifetimeMs, 1000, LIMITS.lifetimeMs));
      child.once('error', () => { clearTimeout(timer); resolve(); });
      child.stdin.once('error', () => {});
      child.unref();
      child.stdin.end(JSON.stringify({ cwd }), () => { clearTimeout(timer); resolve(); });
    } catch { clearTimeout(timer); resolve(); }
  });
}

// Runs in a work process's worker thread.
async function work(mode, input, receivedAt, endAt, acknowledgeSession) {
  if (!input || typeof input.cwd !== 'string' || killed(process.env)) return null;
  const env = process.env;
  const flow = require('./flow.cjs').createFlow({ harness: 'claude', cwd: input.cwd, env });
  if (mode === 'flush') { await flushSingleFlight(flow, endAt); return null; }
  // Delivery is requested even when capture fails: a full outbox or adapter
  // cap refuses new records, and only delivery frees that space.
  try {
    return await processClaudeHook(input, { flow, env, acknowledgeSession, clock: () => receivedAt,
      reconcileBudgetMs: LIMITS.reconcileMs, flush: false });
  } finally { await requestDelivery(flow, input.cwd, receivedAt); }
}

// A work process's main thread only supervises: synchronous work in the worker
// cannot delay the lifetime cap. Every exit path kills the whole group, so a
// subprocess's background child cannot outlive this process.
function endGroup() { killGroup(process.pid); process.exit(0); }
async function workMain(mode, receivedAt, endAt, acknowledgeSession) {
  const lifetimeMs = Math.max(0, endAt - Date.now());
  setTimeout(endGroup, lifetimeMs);
  // Event work belongs to the hook that spawned it. If that hook is killed
  // (a supervisor's signal or cap), its cleanup never runs: end with it. The
  // uploader is meant to outlive its parent, so only event work watches.
  // The spawner passes its pid: a parent killed before this process started
  // must not be mistaken for its replacement (init or a subreaper).
  if (mode === 'event') {
    const parent = Number(process.env.BRAIN_TRACE_HOOK_PARENT) || process.ppid;
    if (process.ppid !== parent) endGroup();
    setInterval(() => { if (process.ppid !== parent) endGroup(); }, 50).unref();
  }
  let input;
  try { input = JSON.parse(await readStdin(Math.min(5000, lifetimeMs))); } catch { endGroup(); }
  const { Worker } = require('node:worker_threads');
  const worker = new Worker(__filename, { stdout: true, stderr: true,
    workerData: { agentBrainClaudeWork: true, mode, input, receivedAt, endAt, acknowledgeSession } });
  worker.once('message', output => {
    if (mode === 'event' && output) process.stdout.write(JSON.stringify(output), endGroup);
    else endGroup();
  });
  worker.once('error', endGroup);
  worker.once('exit', endGroup);
}

const threads = require('node:worker_threads');
if (!threads.isMainThread && threads.workerData?.agentBrainClaudeWork === true) {
  const { mode, input, receivedAt, endAt, acknowledgeSession } = threads.workerData;
  work(mode, input, receivedAt, endAt, acknowledgeSession)
    .then(output => threads.parentPort.postMessage(output || null), () => threads.parentPort.postMessage(null));
} else if (require.main === module && process.argv[2] === DETACHED) {
  const [mode, received, end, ack] = process.argv.slice(3);
  const receivedAt = Number(received), endAt = Number(end);
  workMain(mode, Number.isFinite(receivedAt) ? receivedAt : Date.now(),
    Math.min(Number.isFinite(endAt) ? endAt : 0, Date.now() + LIMITS.lifetimeMs), ack === 'ack').catch(endGroup);
}

module.exports = { HOOK_EVENTS, HOOK_MATCHERS, TERMINAL_EVENTS, LIMITS, handleClaudeHook, processClaudeHook, runClaudeHook, reconcileTranscript };
