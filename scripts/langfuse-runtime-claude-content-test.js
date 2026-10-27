'use strict';

// Synthetic native JSONL + actual hook handler/shared flow. No native runtime,
// activation, credentials, downloads, provider calls, or network transport.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { createFlow } = require('../runtime/langfuse/flow.cjs');
const { configurePrivacy } = require('../runtime/langfuse/privacy.cjs');
const { handleClaudeHook } = require('../runtime/langfuse/claude.cjs');
const { readPayload, MAX_INPUT_BYTES } = require('../runtime/langfuse/claude-hook.cjs');
const { readInput } = require('../runtime/langfuse/bootstrap-claude.cjs');
const FULL = { schema: 2, enabled: true, captureMode: 'full-content', capturePolicyVersion: 1,
  redactionPolicyVersion: 1, pii: 'retain', durableRetry: true };
const META = { schema: 1, enabled: true, captureMode: 'metadata-only' };
const SESSION = 'fe3dccb0-d27e-4b48-814c-074b59afe199';
const EMAIL = 'zoe@example.invalid';
const SECRET = 'sk-proj-SYNTHETIC_CLAUDE_SECRET';
const LITERAL = 'opaque-SYNTHETIC-claude-literal';
const PII = `Zoë 王 😀 ${EMAIL} 123-45-6789 +1-415-555-2671 https://example.invalid/person?id=7`;
const body = () => ({ text: `${PII}\n${SECRET}\n${LITERAL}`, token: 'SYNTHETIC_TOKEN',
  values: [null, '', false, 0, ['é']], authorization: 'Bearer SYNTHETIC_BEARER' });
const hashId = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const key = (kind, ...ids) => `claude:${kind}:${hashId(JSON.stringify(ids))}`;
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
function fixture(t, policy = FULL) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'brain-claude-content-'));
  const cwd = path.join(root, 'project'), stateDir = path.join(root, 'state'); fs.mkdirSync(cwd);
  const file = path.join(root, 'native.jsonl'); fs.writeFileSync(file, '');
  let now = Date.now(), flow;
  const make = (capturePolicy = policy, extra = {}) => createFlow({ harness: 'claude', cwd, stateDir,
    env: {}, capturePolicy, clock: () => now,
    flushOutbox: async () => ({ queued: 0, accepted: 0, failed: 0, verified: false }), ...extra });
  flow = make();
  configurePrivacy({ sensitiveLiterals: [LITERAL] });
  t.after(() => { configurePrivacy(); fs.rmSync(root, { recursive: true, force: true }); });
  const hook = (event, data = {}) => handleClaudeHook({ cwd, session_id: SESSION,
    hook_event_name: event, transcript_path: file, ...data }, { flow, env: {}, clock: () => ++now, flushTimeoutMs: 2500 });
  const append = rows => fs.appendFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const row = (id, content, extra = {}) => ({ type: 'assistant', uuid: `row-${id}`, timestamp: ++now,
    sessionId: SESSION, message: { id, model: 'claude-sonnet-4-6', content,
      usage: { input_tokens: 11, output_tokens: 3 } }, ...extra });
  const records = () => {
    const latest = new Map();
    for (const name of walk(path.join(stateDir, 'outbox')).filter(name => name.endsWith('.json'))) {
      const envelope = JSON.parse(fs.readFileSync(name, 'utf8')), previous = latest.get(envelope.record.id);
      if (!previous || envelope.record.endTime > previous.record.endTime ||
          envelope.record.endTime === previous.record.endTime && envelope.revision > previous.revision) latest.set(envelope.record.id, envelope);
    }
    return [...latest.values()].map(value => value.record);
  };
  const all = () => walk(stateDir).map(name => fs.readFileSync(name, 'utf8')).join('\n');
  const assertDisk = () => {
    const text = all();
    for (const secret of [SECRET, LITERAL, 'SYNTHETIC_TOKEN', 'SYNTHETIC_BEARER']) assert.ok(!text.includes(secret), secret);
    for (const name of walk(stateDir)) assert.equal(fs.statSync(name).mode & 0o777, 0o600, name);
    // Generic checkpoints and ContextStore may contain metadata only.
    for (const name of walk(stateDir).filter(name => !name.includes('/outbox/') && !name.includes('/pending/'))) {
      if (!name.endsWith('.json')) continue;
      const value = JSON.parse(fs.readFileSync(name, 'utf8'));
      if (value.checkpointVersion !== 2) assert.ok(!JSON.stringify(value).includes(EMAIL), name);
    }
  };
  return { root, cwd, stateDir, file, hook, append, row, records, all, assertDisk, make,
    get flow() { return flow; }, restart(capturePolicy = policy, extra = {}) { flow = make(capturePolicy, extra); },
    tick() { return ++now; } };
}
const one = (f, type) => f.records().find(record => record.type === type);
const capture = (f, id) => f.flow.readObservation(key('body', id));
function childRun(f, child) {
  const hex = crypto.createHash('sha256').update(`claude:${SESSION}:${child}`).digest('hex');
  return f.flow.session(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`);
}

test('R1/R2: actual prompts/expansion, terminal fallback, PII and structured values survive shared redaction', async t => {
  const f = fixture(t);
  const context = await f.hook('SessionStart');
  const nonce = context.hookSpecificOutput.additionalContext.match(/--actor ([A-Za-z0-9_-]+)/)[1];
  await f.hook('UserPromptSubmit', { prompt_id: 'prompt-1', prompt: body() });
  await f.hook('UserPromptExpansion', { prompt_id: 'prompt-1', command_name: 'local-command',
    command_args: PII, prompt: `expanded ${PII} ${SECRET}`, original_prompt: '', expanded_prompt: body(), expansion_type: 'slash_command' });
  await f.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'bash-1', tool_input: {
    command: `printf '${PII}' --actor ${nonce}`, nested: body(), actorEcho: nonce } });
  f.assertDisk(); // open checkpoint is already redacted
  f.restart();
  await f.hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'bash-1', tool_response: body() });
  await f.hook('Stop', { last_assistant_message: `answer ${PII} ${SECRET} ${LITERAL}` });
  const agent = one(f, 'AGENT'), tool = one(f, 'TOOL');
  assert.equal(agent.content.input.value.UserPromptSubmit.prompt.text.includes(EMAIL), true);
  assert.equal(agent.content.input.value.UserPromptExpansion.command_args, PII);
  assert.deepEqual(agent.content.input.value.UserPromptExpansion.expanded_prompt.values, [null, '', false, 0, ['é']]);
  assert.ok(agent.content.output.value.terminalLastAssistantMessage.value.includes(PII));
  assert.equal(agent.content.output.value.terminalLastAssistantMessage.providerRequest, 'unavailable');
  assert.deepEqual(tool.content.input.value.preToolUse.nested.values, [null, '', false, 0, ['é']]);
  assert.ok(tool.content.input.value.preToolUse.command.includes(PII));
  assert.equal(tool.content.input.value.preToolUse.actorEcho, '[REDACTED]');
  assert.equal(tool.content.output.value.postToolUse.text.includes(EMAIL), true);
  assert.equal(tool.content.input.status, 'credential_redacted');
  const typedBodies = walk(path.join(f.stateDir, 'adapters')).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(name, 'utf8'))).filter(value => value.checkpointVersion === 2);
  assert.ok(typedBodies.length);
  assert.ok(!JSON.stringify(typedBodies).includes(nonce));
  assert.equal(f.records().filter(record => record.type === 'SPAN' && record.content?.input?.value?.source?.startsWith('claude.hook.UserPrompt')).length, 2);
  const before = tool.content;
  await f.hook('Stop'); await f.hook('SessionEnd');
  assert.deepEqual(one(f, 'TOOL').content, before);
  f.assertDisk();
});

test('R3: ordered native rows preserve distinct chunks, surfaced thinking, cumulative snapshots and usage', async t => {
  const f = fixture(t); await f.hook('SessionStart');
  const first = f.row('message-a', [{ type: 'text', text: `first ${PII} ${SECRET}` },
    { type: 'thinking', thinking: 'surfaced native thought', signature: 'opaque-signature' }]);
  f.append([first]); await f.hook('Stop');
  f.restart();
  const cumulative = f.row('message-a', [...first.message.content, { type: 'text', text: 'continued' }]);
  cumulative.message.usage.output_tokens = 8;
  const distinct = f.row('message-a', [{ type: 'text', text: 'distinct final block' }], { uuid: 'row-distinct' });
  distinct.message.usage.output_tokens = 13;
  f.append([cumulative, distinct]); await f.hook('Stop');
  const generation = one(f, 'GENERATION');
  assert.equal(generation.content.input.status, 'unavailable');
  assert.equal(generation.content.output.status, 'credential_redacted');
  const output = generation.content.output.value;
  assert.equal(output.nativeRows.length, 3);
  assert.equal(output.nativeRows[0].rowId, output.nativeRows[1].rowId);
  assert.equal(output.nativeRows[2].blocks[0].text, 'distinct final block');
  assert.equal(output.nativeRows[1].blocks.length, 3);
  assert.deepEqual(output.nativeRows[0].blocks[1], first.message.content[1]);
  assert.equal(output.coverage.providerRequest, 'unavailable');
  assert.equal(output.coverage.hiddenReasoning, 'unavailable');
  assert.equal(generation.usage.output, 13);
  await f.hook('Stop');
  assert.equal(one(f, 'GENERATION').content.output.value.nativeRows.length, 3);
  f.assertDisk();
});

test('R4: Pre/Post without input, transcript cancellation and late metadata retain exact tool content', async t => {
  const f = fixture(t); await f.hook('SessionStart');
  const args = { command: `echo '${PII}'`, values: [null, '', 7, false] };
  const snapshot = structuredClone(args);
  assert.equal(await f.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'cancelled', tool_input: args }), null);
  assert.deepEqual(args, snapshot, 'no updatedInput or permissionDecision');
  f.append([f.row('tool-message', [{ type: 'tool_use', id: 'cancelled', name: 'Bash', input: args }]),
    { type: 'user', timestamp: f.tick(), message: { content: [{ type: 'tool_result', tool_use_id: 'cancelled',
      content: '[Request interrupted by user for tool use]', is_error: true }] } }]);
  await f.hook('Stop');
  let tool = one(f, 'TOOL');
  assert.equal(tool.outcome, 'aborted');
  assert.deepEqual(tool.content.input.value.preToolUse, args);
  assert.equal(tool.content.output.value.transcriptToolResults[0].block.is_error, true);
  f.restart();
  await f.hook('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'cancelled', is_interrupt: true,
    error: `cancelled ${PII} ${SECRET}` });
  await f.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'cancelled' });
  tool = one(f, 'TOOL');
  assert.equal(tool.outcome, 'aborted');
  assert.deepEqual(tool.content.input.value.preToolUse, args);
  assert.equal(tool.content.output.value.transcriptToolResults.length, 1);
  assert.ok(tool.content.output.value.error.includes(PII));
  await f.hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'cancelled' });
  assert.equal(one(f, 'TOOL').outcome, 'aborted', 'later bare completed metadata does not undo native cancellation');
  await f.hook('PreToolUse', { tool_name: 'Read', tool_use_id: 'open-read', tool_input: { file_path: '/synthetic/file', text: PII } });
  f.restart(); await f.hook('SessionEnd');
  const interrupted = f.records().find(record => record.toolName === 'Read');
  assert.equal(interrupted.outcome, 'interrupted');
  assert.equal(interrupted.content.output.status, 'unavailable');
  f.assertDisk();
});

test('R5: exact saved caller wins if native current run changes before Post', async t => {
  const f = fixture(t); await f.hook('SessionStart');
  await f.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'owner', tool_input: body() });
  const first = f.flow.session(SESSION);
  f.flow.begin({ nativeSessionId: SESSION, cwd: f.cwd, reuseSession: false });
  await f.hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'owner', tool_response: body() });
  const tool = one(f, 'TOOL'), saved = capture(f, tool.id);
  assert.equal(tool.parentId, first.rootSpanId);
  assert.equal(saved.owner.runId, first.runId);
  assert.equal(saved.owner.rootSpanId, first.rootSpanId);
  f.assertDisk();
});

test('R6: EOF cutover prevents upgrade backfill, sidechains excluded, partial tails retained across restart', async t => {
  const f = fixture(t, META);
  f.append([f.row('historical', [{ type: 'text', text: 'NEVER_BACKFILL_OLD' }])]);
  await f.hook('SessionStart');
  f.restart(FULL); await f.hook('UserPromptSubmit', { prompt: PII });
  f.append([f.row('new', [{ type: 'text', text: `current ${PII}` }]),
    f.row('sidechain', [{ type: 'text', text: 'NEVER_ATTRIBUTE_SIDECHAIN' }], { agentId: 'foreign', isSidechain: true })]);
  const partial = JSON.stringify(f.row('partial', [{ type: 'text', text: 'partial 王 😀' }]));
  fs.appendFileSync(f.file, partial.slice(0, -5));
  await f.hook('Stop');
  assert.equal(f.records().find(record => record.id === hashId(`claude:generation:${SESSION}:historical`)).content, undefined);
  assert.ok(!f.all().includes('NEVER_BACKFILL_OLD'));
  assert.ok(!f.all().includes('NEVER_ATTRIBUTE_SIDECHAIN'));
  f.restart(FULL); fs.appendFileSync(f.file, partial.slice(-5) + '\n'); await f.hook('Stop');
  const current = f.records().find(record => record.id === hashId(`claude:generation:${SESSION}:partial`));
  assert.equal(current.content.output.value.nativeRows[0].blocks[0].text, 'partial 王 😀');
  f.assertDisk();
});

test('R6: initial partial row, transcript replacement and unverified branch paths never backfill', async t => {
  const f = fixture(t);
  const historical = JSON.stringify(f.row('old-partial', [{ type: 'text', text: 'HISTORICAL_TAIL' }]));
  fs.writeFileSync(f.file, historical.slice(0, -4));
  await f.hook('SessionStart');
  fs.appendFileSync(f.file, historical.slice(-4) + '\n');
  f.append([f.row('after-cutover', [{ type: 'text', text: PII }])]);
  await f.hook('Stop'); assert.ok(!f.all().includes('HISTORICAL_TAIL'));
  const foreign = path.join(f.root, 'other.jsonl');
  fs.writeFileSync(foreign, JSON.stringify(f.row('foreign', [{ type: 'text', text: 'FOREIGN_BRANCH' }])) + '\n');
  await f.hook('Stop', { transcript_path: foreign });
  assert.ok(!f.all().includes('FOREIGN_BRANCH'));
  fs.renameSync(f.file, `${f.file}.old`);
  fs.writeFileSync(f.file, JSON.stringify(f.row('rotated-history', [{ type: 'text', text: 'ROTATED_OLD' }])) + '\n');
  await f.hook('Stop'); assert.ok(!f.all().includes('ROTATED_OLD'));
  assert.ok(f.all().includes('transcript_replaced_no_backfill'));
});

test('R7: deferred children and nested dispatches bind only exact IDs; child prompt/answer are not dispatch content', async t => {
  const f = fixture(t); await f.hook('SessionStart');
  await f.hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'dispatch-child', tool_input: { prompt: `dispatch ${PII}`, model: 'sonnet' } });
  const childFile = path.join(f.root, 'child.jsonl'); fs.writeFileSync(childFile, '');
  await f.hook('SubagentStart', { agent_id: 'child', agent_transcript_path: childFile });
  await f.hook('UserPromptSubmit', { agent_id: 'child', agent_transcript_path: childFile, prompt: `own child ${PII}` });
  await f.hook('PreToolUse', { agent_id: 'child', tool_name: 'Task', tool_use_id: 'dispatch-grand', tool_input: { prompt: `grand ${PII}` } });
  const grandFile = path.join(f.root, 'grand.jsonl'); fs.writeFileSync(grandFile, '');
  await f.hook('SubagentStart', { agent_id: 'grand', agent_transcript_path: grandFile });
  fs.appendFileSync(grandFile, JSON.stringify(f.row('grand-message', [{ type: 'text', text: PII }])) + '\n');
  await f.hook('SubagentStop', { agent_id: 'grand', agent_transcript_path: grandFile, last_assistant_message: PII });
  await f.hook('PostToolUse', { agent_id: 'child', tool_name: 'Task', tool_use_id: 'dispatch-grand', tool_response: { agentId: 'grand', content: PII } });
  fs.appendFileSync(childFile, JSON.stringify(f.row('child-message', [{ type: 'text', text: PII }])) + '\n');
  await f.hook('SubagentStop', { agent_id: 'child', agent_transcript_path: childFile, last_assistant_message: `own answer ${PII}` });
  f.assertDisk();
  assert.ok(walk(path.join(f.stateDir, 'adapters/pending')).length, 'exact parent still pending');
  f.restart();
  await f.hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'dispatch-child', tool_response: { agentId: 'child', content: `dispatch result ${PII}`, usage: { output_tokens: 999999 } } });
  await f.hook('Stop');
  const child = childRun(f, 'child'), grand = childRun(f, 'grand');
  const childAgent = f.records().find(record => record.id === child.rootSpanId);
  assert.equal(childAgent.parentId, f.flow.session(SESSION).rootSpanId);
  assert.equal(f.records().find(record => record.id === grand.rootSpanId).parentId, child.rootSpanId);
  assert.equal(childAgent.content.input.value.UserPromptSubmit.prompt, `own child ${PII}`);
  assert.equal(childAgent.content.output.value.terminalLastAssistantMessage.value, `own answer ${PII}`);
  const dispatch = f.records().find(record => record.type === 'SPAN' && record.parentId === child.rootSpanId && record.content?.input?.value?.preToolUse?.model === 'sonnet');
  assert.equal(dispatch.content.input.value.preToolUse.prompt, `dispatch ${PII}`);
  assert.equal(dispatch.content.output.value.postToolUse.content, `dispatch result ${PII}`);
  assert.equal(f.records().filter(record => record.type === 'TOOL').length, 0);
  assert.ok(!f.records().some(record => record.usage?.output === 999999));
  f.assertDisk();
});

test('R7: missing exact dispatch child emits limitation, no guessed TOOL or ancestry', async t => {
  const f = fixture(t); await f.hook('SessionStart');
  await f.hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'unbound', tool_input: body() });
  await f.hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'unbound', tool_response: { content: PII } });
  assert.ok(f.all().includes('dispatch_exact_child_binding_unavailable'));
  assert.equal(f.records().filter(record => record.type === 'TOOL').length, 0);
  f.assertDisk();
});

test('R8: canonical cap and unsupported media produce typed refusals, not successful prefixes', async t => {
  const f = fixture(t); await f.hook('SessionStart');
  await f.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'oversize', tool_input: { command: 'é'.repeat(180000) } });
  await f.hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'oversize', tool_response: { value: 'ok' } });
  assert.equal(one(f, 'TOOL').content.input.status, 'refused_size');
  f.append([f.row('media', [{ type: 'image', source: { data: 'data:image/png;base64,SYNTHETIC' } }])]);
  await f.hook('Stop');
  assert.equal(one(f, 'GENERATION').content.output.status, 'unsupported');
  f.append([f.row('media', [{ type: 'text', text: 'must not silently replace refused media' }])]);
  await f.hook('Stop');
  assert.equal(one(f, 'GENERATION').content.output.status, 'unsupported');
  f.assertDisk();
});

test('R8: failed durable publication never advances content cursor; retry replays exact native row', async t => {
  const f = fixture(t); await f.hook('SessionStart');
  const cursorKey = key('full-cursor', SESSION, f.flow.session(SESSION).rootSpanId);
  const before = f.flow.readState(cursorKey);
  f.append([f.row('retry-row', [{ type: 'text', text: PII }])]);
  const write = f.flow.writeObservation;
  f.flow.writeObservation = (name, value) => {
    if (value.record.content?.output?.value?.nativeRows) throw new Error('synthetic storage refusal');
    return write(name, value);
  };
  await assert.rejects(f.hook('Stop'), /synthetic storage refusal/);
  assert.deepEqual(f.flow.readState(cursorKey), before);
  f.restart(); await f.hook('Stop');
  assert.equal(one(f, 'GENERATION').content.output.value.nativeRows[0].blocks[0].text, PII);
  f.assertDisk();
});

test('R9: metadata does not touch content-only getters; downgrade preserves rich records, kill blocks delivery', async t => {
  const f = fixture(t, META);
  const hostile = { tool_name: 'Bash', tool_use_id: 'metadata' };
  Object.defineProperty(hostile, 'tool_response', { enumerable: true, get() { throw new Error('body read'); } });
  // Pass directly: object spread itself would invoke the hostile getter.
  Object.assign(hostile, { cwd: f.cwd, session_id: SESSION, hook_event_name: 'PostToolUse' });
  await handleClaudeHook(hostile, { flow: f.flow, env: {}, flushTimeoutMs: 1 });
  const payload = { cwd: f.cwd, session_id: SESSION, hook_event_name: 'Stop' };
  Object.defineProperty(payload, 'last_assistant_message', { get() { throw new Error('body read'); } });
  await handleClaudeHook(payload, { flow: f.flow, env: {}, flushTimeoutMs: 1 });
  assert.ok(f.records().every(record => !record.content));
  f.restart(FULL); await f.hook('SessionStart');
  await f.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'full', tool_input: body() });
  await f.hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'full', tool_response: body() });
  const rich = f.records().find(record => record.id === hashId(`claude:tool:${SESSION}:full`));
  f.restart(META); await f.hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'full', tool_response: 'NEVER_CAPTURE_DOWNGRADE' });
  assert.deepEqual(f.records().find(record => record.id === rich.id).content, rich.content);
  assert.ok(!f.all().includes('NEVER_CAPTURE_DOWNGRADE'));
  f.restart(FULL);
  await f.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'downgraded-open', tool_input: body() });
  const openId = hashId(`claude:tool:${SESSION}:downgraded-open`), open = capture(f, openId);
  f.restart(META);
  await f.hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'downgraded-open', tool_response: 'NEVER_CAPTURE_DOWNGRADE' });
  assert.deepEqual(capture(f, openId), open, 'no forgery of an original-grant terminal revision');
  assert.ok(f.all().includes('original_grant_revision_unavailable'), 'shared API limitation is persistent, not silent');
  const snapshot = f.all();
  f.restart(FULL, { env: { BRAIN_TRACING_ENABLED: '0' } });
  await handleClaudeHook({ cwd: f.cwd, session_id: SESSION, hook_event_name: 'Stop', last_assistant_message: 'KILLED_BODY' },
    { flow: f.flow, env: { BRAIN_TRACING_ENABLED: '0' } });
  assert.equal(f.all(), snapshot);
  f.assertDisk();
});

test('R6: observed downgrade/re-upgrade starts a new EOF epoch rather than capturing the consent gap', async t => {
  const f = fixture(t); await f.hook('SessionStart');
  f.append([f.row('before-gap', [{ type: 'text', text: PII }])]); await f.hook('Stop');
  f.restart(META);
  f.append([f.row('consent-gap', [{ type: 'text', text: 'NEVER_RETRO_CAPTURE_GAP' }])]);
  await f.hook('Stop');
  f.restart(FULL); await f.hook('SessionStart');
  f.append([f.row('after-gap', [{ type: 'text', text: 'new consent 王' }])]); await f.hook('Stop');
  assert.ok(!f.all().includes('NEVER_RETRO_CAPTURE_GAP'));
  const after = f.records().find(record => record.id === hashId(`claude:generation:${SESSION}:after-gap`));
  assert.equal(after.content.output.value.nativeRows[0].blocks[0].text, 'new consent 王');
  f.assertDisk();
});

test('R1/R4: empty, null, numeric, boolean and multibyte top-level native arguments/results are not coerced', async t => {
  const f = fixture(t); await f.hook('SessionStart');
  for (const [index, value] of [null, '', false, 0, ['王', { nested: null }]].entries()) {
    const tool_use_id = `typed-${index}`;
    await f.hook('PreToolUse', { tool_name: 'Bash', tool_use_id, tool_input: value });
    f.restart(); await f.hook('PostToolUse', { tool_name: 'Bash', tool_use_id, tool_response: value });
    const tool = f.records().find(record => record.id === hashId(`claude:tool:${SESSION}:${tool_use_id}`));
    assert.deepEqual(tool.content.input.value.preToolUse, value);
    assert.deepEqual(tool.content.output.value.postToolUse, value);
  }
  f.assertDisk();
});

test('R7: conflicting repeat dispatch IDs are refused, not rebound; later transcript enriches the exact child', async t => {
  const f = fixture(t); await f.hook('SessionStart');
  await f.hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'stable-dispatch', tool_input: body() });
  await f.hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'stable-dispatch', tool_response: { agentId: 'exact-child', content: PII } });
  f.append([f.row('dispatch-native', [{ type: 'tool_use', id: 'stable-dispatch', name: 'Agent', input: body() }]),
    { type: 'user', timestamp: f.tick(), message: { content: [{ type: 'tool_result', tool_use_id: 'stable-dispatch', content: `native ${PII}` }] } }]);
  await f.hook('Stop');
  const child = childRun(f, 'exact-child');
  const dispatch = f.records().find(record => record.type === 'SPAN' && record.parentId === child.rootSpanId && record.content?.input?.value?.preToolUse);
  assert.equal(dispatch.content.output.value.transcriptToolResults[0].block.content, `native ${PII}`);
  f.restart(); await f.hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'stable-dispatch', tool_response: { agentId: 'wrong-child' } });
  assert.equal(childRun(f, 'wrong-child'), null);
  assert.ok(f.all().includes('dispatch_child_rebind_refused'));
  f.assertDisk();
});

test('R8: bounded 32 MiB scans and 8 MiB line refusals are persistent diagnostics and resume safely', async t => {
  const f = fixture(t); await f.hook('SessionStart');
  fs.appendFileSync(f.file, Buffer.alloc(32 * 1024 * 1024 + 1024, 97));
  await f.hook('PostModelSwitch', { to_model: 'claude-sonnet-4-6' });
  assert.ok(f.all().includes('transcript_scan_limited'));
  assert.ok(f.all().includes('transcript_line_refused_size'));
  fs.appendFileSync(f.file, '\n');
  const row = f.row('after-large-line', [{ type: 'text', text: PII }]);
  row.message.stop_reason = 'max_tokens'; f.append([row]);
  await f.hook('Stop');
  const generation = one(f, 'GENERATION');
  assert.equal(generation.content.output.value.nativeRows[0].blocks[0].text, PII);
  assert.equal(generation.content.output.value.nativeRows[0].nativeTruncation, 'reported_truncated');
  f.assertDisk();
});

test('R8: nonregular/symlink native inputs fail closed with fixed diagnostics, no parser excerpts', async t => {
  const f = fixture(t);
  const { spawnSync } = require('node:child_process');
  fs.unlinkSync(f.file);
  assert.equal(spawnSync('mkfifo', [f.file], { timeout: 5000 }).status, 0);
  const start = Date.now(); await f.hook('SessionStart');
  assert.ok(Date.now() - start < 3000);
  fs.unlinkSync(f.file);
  const target = path.join(f.root, 'private.jsonl'); fs.writeFileSync(target, `${SECRET} invalid JSON`);
  fs.symlinkSync(target, f.file); await f.hook('Stop');
  assert.ok(f.all().includes('transcript_unavailable'));
  f.assertDisk();
});

test('actual Claude hook → shared outbox → existing SDK offline exporter retains PII with no credentials', async t => {
  const f = fixture(t); await f.hook('SessionStart');
  await f.hook('UserPromptSubmit', { prompt: body() });
  f.append([f.row('wire', [{ type: 'text', text: `${PII} ${SECRET} ${LITERAL}` }])]);
  await f.hook('Stop', { last_assistant_message: PII });
  f.assertDisk();
  const seen = [];
  const { flushOutbox } = require('../runtime/langfuse/export.cjs');
  const dependencyRoot = require('./lib/langfuse-test-dependencies.js').testDependencyRoot();
  const result = await flushOutbox({ stateDir: f.stateDir, env: {}, dependencyRoot, timeoutMs: 10000,
    exporterFactory: () => ({ export(spans, callback) { seen.push(...spans); callback({ code: 0 }); }, async shutdown() {} }) });
  assert.ok(result.accepted > 0);
  const generation = seen.find(span => span.attributes['langfuse.observation.output']?.includes('nativeRows'));
  assert.ok(generation);
  const output = JSON.parse(generation.attributes['langfuse.observation.output']);
  assert.ok(output.nativeRows[0].blocks[0].text.includes(PII));
  for (const secret of [SECRET, LITERAL, 'SYNTHETIC_TOKEN', 'SYNTHETIC_BEARER']) assert.ok(!JSON.stringify(seen.map(span => span.attributes)).includes(secret));
});

test('8 MiB hook/bootstrap readers decode split multibyte chunks and bound errors/timeouts without excerpts', async () => {
  assert.equal(MAX_INPUT_BYTES, 8 * 1024 * 1024);
  const text = JSON.stringify({ prompt: `${'x'.repeat(1024 * 1024)}王😀${PII}` });
  const bytes = Buffer.from(text), split = bytes.indexOf(Buffer.from('王')) + 1;
  for (const reader of [readPayload, readInput]) {
    const stream = new PassThrough(), pending = reader(stream);
    stream.write(bytes.subarray(0, split)); stream.end(bytes.subarray(split));
    const result = await pending;
    assert.deepEqual(typeof result === 'string' ? JSON.parse(result) : result, JSON.parse(text));
  }
  const large = new PassThrough(), rejected = readPayload(large);
  large.end(Buffer.alloc(MAX_INPUT_BYTES + 1)); await assert.rejects(rejected, /input unavailable/);
  const timed = new PassThrough(); assert.equal(await readInput(timed, 5), null);
  const broken = new PassThrough(), pending = readInput(broken);
  broken.emit('error', new Error(`private ${SECRET}`)); assert.equal(await pending, null);
});
