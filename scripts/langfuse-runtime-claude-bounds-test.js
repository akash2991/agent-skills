'use strict';

// Tracing must never slow a session down. These tests pin the hook's bounds:
// every event is processed in native order by a capped work process that is
// killed with its subprocesses at the cap, transcript reading is budgeted and
// resumes, and only delivery runs in the background. Synthetic fixtures only;
// delivery targets a closed local port.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-claude-bounds-'));
Object.assign(process.env, { BRAIN_TRACE_STATE_DIR: path.join(root, 'state'),
  LANGFUSE_PUBLIC_KEY: 'pk-lf-synthetic', LANGFUSE_SECRET_KEY: 'sk-lf-synthetic', LANGFUSE_BASE_URL: 'http://127.0.0.1:9' });
delete process.env.BRAIN_TRACING_ENABLED;
delete process.env.LANGFUSE_TRACING_ENABLED;
const { processClaudeHook, runClaudeHook } = require('../runtime/langfuse/claude.cjs');
const { createFlow } = require('../runtime/langfuse/flow.cjs');
const hookCli = path.join(__dirname, '../runtime/langfuse/claude-hook.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await sleep(100); }
  return false;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stateDirs = [process.env.BRAIN_TRACE_STATE_DIR];
// The background uploader holds a 'flusher' claim while it runs.
const uploaderIdle = stateDir => {
  try { return fs.readdirSync(path.join(stateDir, 'flusher-claims')).length === 0; } catch { return true; }
};
test.after(async () => {
  await sleep(300);
  for (const stateDir of stateDirs) await until(() => uploaderIdle(stateDir), 30000);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

class StubFlow {
  constructor() { this.states = new Map(); this.queued = []; this.flushes = 0; this.store = { createLaunch: () => ({}) }; }
  id(seed) { return crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 16); }
  readState(key) { return structuredClone(this.states.get(key)); }
  writeState(key, value) { this.states.set(key, structuredClone(value)); }
  session() { return this.run || null; }
  begin(opts) {
    this.run = { rootSpanId: '1111111111111111', traceId: '2'.repeat(32), sessionId: 's', runId: '1111111111111111',
      nativeSessionId: opts.nativeSessionId, startedAt: 1800000000000 };
    return this.run;
  }
  resolve(run) { return run; }
  update(run, patch) { this.run = { ...run, ...patch }; return this.run; }
  submit(_run, records) { this.queued.push(...records); }
  async flush() { this.flushes++; }
  captureBrainCommand(run) { return run; }
  captureSkill(run) { return run; }
  createToolLaunch() { return { nonce: 'a'.repeat(43) }; }
}

function transcript(dir, count) {
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, Array.from({ length: count }, (_, i) => JSON.stringify({ type: 'assistant',
    timestamp: 1800000000000 + i, message: { id: `msg_${i}`, model: 'claude-sonnet-4-5-20250929',
      usage: { input_tokens: 1, output_tokens: 1 }, content: [] } })).join('\n') + '\n');
  return file;
}
const generations = flow => new Set(flow.queued.filter(record => record.type === 'GENERATION').map(record => record.id)).size;

// A git that records its pid; the runtime asks git for project identity, so
// every work process reaches it.
function fakeGit(behaviour, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'git-'));
  const bin = path.join(dir, 'bin'), project = path.join(dir, 'project'), pids = path.join(dir, 'pids');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(project, '.git'), { recursive: true }); fs.mkdirSync(pids);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n${behaviour(pids)}\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    BRAIN_TRACE_STATE_DIR: path.join(dir, 'state'), ...extraEnv };
  stateDirs.push(env.BRAIN_TRACE_STATE_DIR);
  return { project, pids, env, live: () => fs.readdirSync(pids).map(Number).filter(alive) };
}
function hook(env, payload) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [hookCli], { env, encoding: 'utf8', timeout: 20000, input: JSON.stringify(payload) });
  assert.equal(result.status, 0, result.stderr);
  return { ...result, elapsed: Date.now() - started };
}

test('reconciliation stops at its budget, saves the cursor, and the next hook resumes', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'reconcile-'));
  const file = transcript(dir, 4);
  const flow = new StubFlow();
  const payload = { hook_event_name: 'PostToolUse', session_id: 'session-bounds', cwd: dir, transcript_path: file };
  const seen = [];
  for (let i = 0; i < 4; i++) {
    // A zero budget still makes progress: one row per hook, never a restart.
    await processClaudeHook(payload, { flow, env: {}, reconcileBudgetMs: 0, flush: false });
    seen.push(generations(flow));
  }
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.equal(flow.flushes, 0, 'flush:false never delivers inside the hook');
});

test('a hook returns the event processed, with actor context, well within the cap', async () => {
  const sessionId = crypto.randomUUID();
  const started = Date.now();
  const output = await runClaudeHook({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: root });
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  assert.match(output?.hookSpecificOutput?.additionalContext || '', /--actor [A-Za-z0-9_-]{32,}/);
  const tool = hook(process.env, { hook_event_name: 'PostToolUse', session_id: sessionId, cwd: root,
    tool_use_id: 'toolu_inline', tool_name: 'Bash', tool_input: {}, tool_response: {}, duration_ms: 3 });
  assert.equal(tool.stdout, '');
  assert.ok(tool.elapsed < 2000, `PostToolUse hook took ${tool.elapsed} ms`);
  const flow = createFlow({ harness: 'claude', cwd: root, env: process.env });
  const toolState = flow.readState(`claude:tool:${flow.id(JSON.stringify([sessionId, 'toolu_inline']))}`);
  assert.equal(toolState?.outcome, 'completed', 'processed before the hook returned');
});

test('past the cap the hook answers nothing instead of waiting', async () => {
  const started = Date.now();
  assert.equal(await runClaudeHook({ hook_event_name: 'SessionStart', session_id: crypto.randomUUID(), cwd: root }, { inlineMs: 1 }), null);
  assert.ok(Date.now() - started < 1500, `returned after ${Date.now() - started} ms`);
});

test('the kill switch and ordinary PreToolUse return at once and record nothing', async () => {
  const sessionId = crypto.randomUUID();
  const started = Date.now();
  assert.equal(await runClaudeHook({ hook_event_name: 'PostToolUse', session_id: sessionId, cwd: root, tool_use_id: 'toolu_off' },
    { env: { ...process.env, BRAIN_TRACING_ENABLED: 'false' } }), null);
  // Older settings register PreToolUse for every tool; only dispatch and
  // skill calls are worth a hook.
  assert.equal(await runClaudeHook({ hook_event_name: 'PreToolUse', session_id: sessionId, cwd: root,
    tool_use_id: 'toolu_pre', tool_name: 'Bash', tool_input: { command: 'true' } }), null);
  assert.ok(Date.now() - started < 100, 'no work process was started');
  assert.equal(createFlow({ harness: 'claude', cwd: root, env: process.env }).session(sessionId), null);
});

test('a stuck subprocess cannot hold the hook past its cap or outlive it', async () => {
  // git ignores SIGTERM and sleeps: the work process is stuck in a native call.
  // A 2 s cap leaves the work process time to reach git before it is killed.
  const git = fakeGit(pids => `trap '' TERM\necho $$ > "${pids}/$$"\nsleep 30`, { BRAIN_TRACE_HOOK_INLINE_MS: '2000' });
  for (const event of ['SessionStart', 'PostToolUse']) {
    const { elapsed } = hook(git.env, { hook_event_name: event, session_id: crypto.randomUUID(), cwd: git.project,
      tool_use_id: 'toolu_stuck', tool_name: 'Bash' });
    assert.ok(elapsed < 3000, `${event} hook held for ${elapsed} ms`);
  }
  assert.ok(fs.readdirSync(git.pids).length > 0, 'git was reached');
  assert.ok(await until(() => git.live().length === 0, 5000), `stuck git still alive: ${git.live()}`);
});

test('a subprocess background child dies with its work process on a normal exit', async () => {
  // git starts a detached background sleep, records it, and exits at once.
  // A generous cap: this test is about cleanup after a normal exit, not the cap.
  const git = fakeGit(pids => `sleep 30 </dev/null >/dev/null 2>&1 &\necho $! > "${pids}/$!"`, { BRAIN_TRACE_HOOK_INLINE_MS: '5000' });
  hook(git.env, { hook_event_name: 'PostToolUse', session_id: crypto.randomUUID(), cwd: git.project,
    tool_use_id: 'toolu_bg', tool_name: 'Bash', duration_ms: 1 });
  assert.ok(fs.readdirSync(git.pids).length > 0, 'background child was started');
  assert.ok(await until(() => git.live().length === 0, 5000), `background children alive: ${git.live()}`);
});

test('a stalled filesystem cannot hold the hook', () => {
  // Every mkdir of the state directory stalls for 9 s, in the hook and in its
  // work process: the hook itself does no state I/O and kills the work at the cap.
  const dir = fs.mkdtempSync(path.join(root, 'stall-'));
  const shim = path.join(dir, 'stall.cjs'), stateDir = path.join(dir, 'state');
  fs.writeFileSync(shim, `const fs = require('node:fs'); const mkdir = fs.mkdirSync;
    fs.mkdirSync = (target, ...rest) => { if (String(target).startsWith(${JSON.stringify(stateDir)}))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 9000); return mkdir(target, ...rest); };`);
  const { elapsed } = hook({ ...process.env, BRAIN_TRACE_STATE_DIR: stateDir, NODE_OPTIONS: `--require ${shim}` },
    { hook_event_name: 'PostToolUse', session_id: crypto.randomUUID(), cwd: root, tool_use_id: 'toolu_stall', tool_name: 'Bash' });
  assert.ok(elapsed < 2500, `hook held for ${elapsed} ms`);
});

test('an older cached bootstrap calling the new runtime still exits on its own', async () => {
  // Old bootstraps call handleClaudeHook(payload) and never exit explicitly.
  const git = fakeGit(pids => `trap '' TERM\necho $$ > "${pids}/$$"\nsleep 30`, { BRAIN_TRACE_HOOK_INLINE_MS: '300' });
  const program = `const { handleClaudeHook } = require(${JSON.stringify(require.resolve('../runtime/langfuse/claude.cjs'))});
    handleClaudeHook(${JSON.stringify({ hook_event_name: 'SessionStart', session_id: crypto.randomUUID(), cwd: git.project })})
      .then(output => { if (output) process.stdout.write(JSON.stringify(output)); });`;
  const started = Date.now();
  const result = spawnSync(process.execPath, ['-e', program], { env: git.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started < 3000, `old-style caller lived ${Date.now() - started} ms`);
  assert.ok(await until(() => git.live().length === 0, 5000), 'stuck subprocesses were killed');
});

for (const event of ['PostToolUse', 'PostToolUseFailure']) test(`a tool seen only by ${event} without duration gets its start from the transcript`, async () => {
  const dir = fs.mkdtempSync(path.join(root, 'start-'));
  const file = path.join(dir, 'transcript.jsonl');
  const started = 1800000000000, finished = started + 4000;
  const flow = new StubFlow();
  const base = { session_id: 'session-start', cwd: dir, transcript_path: file };
  await processClaudeHook({ ...base, hook_event_name: event, tool_use_id: 'toolu_slow', tool_name: 'Bash',
    tool_input: {}, tool_response: {}, error: 'synthetic' }, { flow, env: {}, clock: () => finished, reconcile: false, flush: false });
  const tool = () => flow.queued.filter(record => record.type === 'TOOL').at(-1);
  assert.equal(tool().startTime, finished, 'placeholder start before reconciliation');
  fs.writeFileSync(file, [
    { type: 'assistant', timestamp: started, message: { id: 'msg_tool', model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'tool_use', id: 'toolu_slow', name: 'Bash', input: {} }] } },
    { type: 'user', timestamp: finished, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_slow', content: 'ok',
      ...(event === 'PostToolUseFailure' ? { is_error: true } : {}) }] } }
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  await processClaudeHook({ ...base, hook_event_name: 'Stop' }, { flow, env: {}, clock: () => finished + 1, flush: false });
  assert.equal(tool().startTime, started);
  assert.equal(tool().endTime, finished);
});

test('a late Stop from an older turn changes nothing about the newer turn', async () => {
  const flow = new StubFlow();
  const base = { session_id: 'session-late', cwd: root };
  const at = time => ({ flow, env: {}, clock: () => time, reconcile: false, flush: false });
  await processClaudeHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'A' }, at(1000));
  await processClaudeHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'B' }, at(3000));
  await processClaudeHook({ ...base, hook_event_name: 'Stop', last_assistant_message: 'answer B' }, at(4000));
  const terminal = () => [...flow.states.entries()].find(([key]) => key.startsWith('claude:terminal:'))[1];
  const before = terminal(), published = flow.queued.length;
  await processClaudeHook({ ...base, hook_event_name: 'Stop', last_assistant_message: 'answer A' }, at(2000));
  assert.deepEqual(terminal(), before);
  assert.equal(flow.queued.length, published, 'nothing republished for the late Stop');
});

test('a dispatch through the production path binds the child and writes no payload bytes', async () => {
  const sessionId = crypto.randomUUID(), childId = 'agentchild1';
  const secrets = ['SECRET_DISPATCH_PROMPT_BYTES', 'SECRET_CHILD_RESULT_BYTES'];
  const base = { session_id: sessionId, cwd: root };
  const opts = { inlineMs: 5000 };
  await runClaudeHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'synthetic' }, opts);
  await runClaudeHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_dispatch',
    tool_input: { prompt: secrets[0], description: 'synthetic' } }, opts);
  await runClaudeHook({ ...base, hook_event_name: 'SubagentStart', agent_id: childId, agent_type: 'general-purpose' }, opts);
  await runClaudeHook({ ...base, hook_event_name: 'SubagentStop', agent_id: childId }, opts);
  await runClaudeHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_dispatch',
    tool_input: { prompt: secrets[0] }, tool_response: { agentId: childId, content: secrets[1] }, duration_ms: 5 }, opts);
  const flow = createFlow({ harness: 'claude', cwd: root, env: process.env });
  const hex = crypto.createHash('sha256').update(`claude:${sessionId}:${childId}`).digest('hex');
  const childNative = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const parent = flow.session(sessionId);
  assert.ok(parent, 'parent run exists');
  const child = flow.session(childNative), resolved = child && flow.resolve(child);
  assert.equal(resolved?.parentSpanId, parent.rootSpanId, 'child bound to its exact caller');
  assert.equal(resolved.traceId, parent.traceId);
  await until(() => uploaderIdle(process.env.BRAIN_TRACE_STATE_DIR), 20000);
  // Metadata-only (no marker): no prompt or tool bytes anywhere in private state.
  const files = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else if (entry.isFile()) files.push(full); } };
  walk(process.env.BRAIN_TRACE_STATE_DIR);
  for (const file of files) for (const secret of secrets) {
    assert.ok(!fs.readFileSync(file).includes(secret), `${secret} found in ${path.relative(root, file)}`);
  }
});

test('a burst of hooks starts at most a couple of uploaders', async () => {
  const git = fakeGit(() => 'exit 1');
  const uploaders = new Set();
  const sampler = setInterval(() => {
    try { for (const name of fs.readdirSync(path.join(git.env.BRAIN_TRACE_STATE_DIR, 'flusher-claims'))) uploaders.add(name.split('-')[0]); } catch { /* not yet */ }
  }, 10);
  await Promise.all(Array.from({ length: 20 }, (_, i) => new Promise(resolve => {
    const child = spawn(process.execPath, [hookCli], { env: git.env, stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('close', resolve);
    child.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: crypto.randomUUID(), cwd: git.project,
      tool_use_id: `toolu_${i}`, tool_name: 'Bash', tool_input: {}, tool_response: {}, duration_ms: 1 }));
  })));
  await until(() => uploaderIdle(git.env.BRAIN_TRACE_STATE_DIR), 30000);
  clearInterval(sampler);
  // Racing hooks can each see no uploader and start one; the losers exit.
  assert.ok(uploaders.size <= 4, `${uploaders.size} uploader processes for 20 hooks`);
});

test('a hook killed mid-reconciliation keeps the cursor of its last published batch', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'killed-'));
  const file = transcript(dir, 40);
  const rowEnd = n => fs.readFileSync(file, 'utf8').split('\n').slice(0, n).join('\n').length + 1;
  const flow = new StubFlow();
  let writes = 0;
  const write = flow.writeState.bind(flow);
  // Abort hard (like a kill at the cap) on the 30th generation write.
  flow.writeState = (key, value) => {
    if (key.startsWith('claude:generation:') && ++writes === 30) throw Object.assign(new Error('killed'), { claudePublicationFailure: true });
    return write(key, value);
  };
  await assert.rejects(processClaudeHook({ hook_event_name: 'PostToolUse', session_id: 'session-killed', cwd: dir, transcript_path: file },
    { flow, env: {}, flush: false }), /killed/);
  const cursor = [...flow.states.entries()].find(([key]) => key.startsWith('claude:cursor:'))?.[1];
  assert.equal(cursor?.offset, rowEnd(25), 'cursor saved with the 25-row batch');
});
