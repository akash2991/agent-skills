'use strict';

// Tracing must never slow a session down. These tests pin the hook's bounds:
// budgeted transcript reconciliation that resumes, no in-hook delivery, a
// prompt return for every event, and detached processing of the handed-off
// event. Synthetic fixtures only; delivery targets a closed local port.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-claude-bounds-'));
Object.assign(process.env, { BRAIN_TRACE_STATE_DIR: path.join(root, 'state'),
  LANGFUSE_PUBLIC_KEY: 'pk-lf-synthetic', LANGFUSE_SECRET_KEY: 'sk-lf-synthetic', LANGFUSE_BASE_URL: 'http://127.0.0.1:9' });
delete process.env.BRAIN_TRACING_ENABLED;
delete process.env.LANGFUSE_TRACING_ENABLED;
const { processClaudeHook, runClaudeHook, INLINE_EVENTS } = require('../runtime/langfuse/claude.cjs');
const { createFlow } = require('../runtime/langfuse/flow.cjs');
const hookCli = path.join(__dirname, '../runtime/langfuse/claude-hook.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await sleep(100); }
  return false;
}
const idle = stateDir => {
  try { return fs.readdirSync(path.join(stateDir, 'flusher-claims')).length === 0
    && fs.readdirSync(path.join(stateDir, 'hook-claims')).length === 0; } catch { return false; }
};
test.after(async () => {
  // Detached processes spawned by the hooks above may still be finishing.
  await sleep(300);
  await until(() => idle(process.env.BRAIN_TRACE_STATE_DIR) || !fs.existsSync(process.env.BRAIN_TRACE_STATE_DIR), 20000);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

class StubFlow {
  constructor() { this.states = new Map(); this.queued = []; this.flushes = 0; this.store = { createLaunch: () => ({}) }; }
  id(seed) { return require('node:crypto').createHash('sha256').update(String(seed)).digest('hex').slice(0, 16); }
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

test('reconcile:false leaves the transcript for a later hook', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'skip-'));
  const file = transcript(dir, 3);
  const flow = new StubFlow();
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: 'session-skip', cwd: dir, transcript_path: file, prompt: 'synthetic' };
  await processClaudeHook(payload, { flow, env: {}, reconcile: false, flush: false });
  assert.equal(generations(flow), 0);
  await processClaudeHook({ ...payload, hook_event_name: 'Stop' }, { flow, env: {}, flush: false });
  assert.equal(generations(flow), 3);
});

test('an actor event past its inline cap returns nothing instead of waiting', async () => {
  const started = Date.now();
  const output = await runClaudeHook({ hook_event_name: 'SessionStart', session_id: '55555555-5555-4555-8555-555555555555',
    cwd: root }, { inlineMs: 1 });
  assert.equal(output, null);
  assert.ok(Date.now() - started < 1500, `returned after ${Date.now() - started} ms`);
});

test('a native tool hook returns at once and a detached process records the event', async () => {
  const sessionId = '44444444-4444-4444-8444-444444444444';
  const payload = { hook_event_name: 'PostToolUse', session_id: sessionId, cwd: root, tool_use_id: 'toolu_bounds',
    tool_name: 'Bash', tool_input: { command: 'true' }, tool_response: {}, duration_ms: 3 };
  const started = Date.now();
  const result = spawnSync(process.execPath, [hookCli], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 10000 });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.ok(elapsed < 2000, `hook took ${elapsed} ms`);
  const flow = createFlow({ harness: 'claude', cwd: root, env: process.env });
  assert.ok(await until(() => flow.session(sessionId)), 'the detached process processed the event');
  assert.ok(await until(() => idle(flow.stateDir)), 'detached processes release their locks and exit');
});

const ledger = () => path.join(process.env.BRAIN_TRACE_STATE_DIR, 'hook-slots');
const ledgerEntries = () => { try { return fs.readdirSync(ledger()); } catch { return []; } };
const liveSpawns = () => ledgerEntries().filter(name => {
  try { process.kill(Number(fs.readFileSync(path.join(ledger(), name), 'utf8')), 0); return true; } catch { return false; } }).length;

test('the kill switch and ordinary PreToolUse spawn nothing and return nothing', async () => {
  const before = ledgerEntries().length;
  process.env.BRAIN_TRACING_ENABLED = 'false';
  try {
    assert.equal(await runClaudeHook({ hook_event_name: 'PostToolUse', session_id: 'session-off', cwd: root, tool_use_id: 'toolu_off' }), null);
  } finally { delete process.env.BRAIN_TRACING_ENABLED; }
  // Older settings register PreToolUse for every tool; only dispatch and
  // skill calls are worth a hook.
  assert.equal(await runClaudeHook({ hook_event_name: 'PreToolUse', session_id: 'session-pre', cwd: root,
    tool_use_id: 'toolu_pre', tool_name: 'Bash', tool_input: { command: 'true' } }), null);
  assert.equal(ledgerEntries().length, before);
});

test('a full detached ledger drops the event instead of spawning', async t => {
  const holders = Array.from({ length: 8 }, () => require('node:child_process').spawn('sleep', ['20']));
  t.after(() => holders.forEach(child => child.kill('SIGKILL')));
  fs.mkdirSync(ledger(), { recursive: true, mode: 0o700 });
  holders.forEach((child, i) => fs.writeFileSync(path.join(ledger(), `slot-${i}`), String(child.pid)));
  const sessionId = crypto.randomUUID();
  await runClaudeHook({ hook_event_name: 'PostToolUse', session_id: sessionId, cwd: root, tool_use_id: 'toolu_full', tool_name: 'Bash' });
  await sleep(1500);
  assert.equal(createFlow({ harness: 'claude', cwd: root, env: process.env }).session(sessionId), null, 'event dropped');
  assert.equal(liveSpawns(), 8, 'nothing new spawned');
  holders.forEach(child => child.kill('SIGKILL'));
  assert.ok(await until(() => liveSpawns() === 0, 5000));
  for (const name of ledgerEntries()) fs.rmSync(path.join(ledger(), name), { force: true });
});

test('a burst of hooks keeps detached processes near the cap', async t => {
  const { spawn } = require('node:child_process');
  let peak = 0, running = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, liveSpawns()); }, 20);
  await Promise.all(Array.from({ length: 40 }, (_, i) => new Promise(resolve => {
    running++;
    const child = spawn(process.execPath, [hookCli], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('close', () => { running--; resolve(); });
    child.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: crypto.randomUUID(), cwd: root,
      tool_use_id: `toolu_burst_${i}`, tool_name: 'Bash', tool_input: {}, tool_response: {}, duration_ms: 1 }));
  })));
  await until(() => liveSpawns() === 0, 30000);
  clearInterval(sampler);
  t.diagnostic(`peak ${peak} detached processes for 40 hooks`);
  // Slots are claimed exclusively; only a stale-slot reclaim race can add one.
  assert.ok(peak <= 9, `peak ${peak} detached processes`);
  assert.equal(running, 0);
});

// A git that ignores SIGTERM and records its pid. The runtime asks git for
// project identity, so both the inline and the detached path hit it.
function stuckGit() {
  const dir = fs.mkdtempSync(path.join(root, 'stuck-'));
  const bin = path.join(dir, 'bin'), project = path.join(dir, 'project'), pids = path.join(dir, 'pids');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(project, '.git'), { recursive: true }); fs.mkdirSync(pids);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ntrap '' TERM\necho $$ > "${pids}/$$"\nsleep 30\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    BRAIN_TRACE_STATE_DIR: fs.mkdtempSync(path.join(dir, 'state-')),
    BRAIN_TRACE_HOOK_INLINE_MS: '300', BRAIN_TRACE_HOOK_LIFETIME_MS: '2000' };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  return { project, pids, env, stuck: () => fs.readdirSync(pids).map(Number).filter(alive) };
}

test('a stuck subprocess cannot hold the hook past its cap or keep detached work alive', async () => {
  const { project, pids, env, stuck } = stuckGit();
  const hook = event => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [hookCli], { env, encoding: 'utf8', timeout: 20000,
      input: JSON.stringify({ hook_event_name: event, session_id: crypto.randomUUID(), cwd: project,
        tool_use_id: 'toolu_stuck', tool_name: 'Bash' }) });
    assert.equal(result.status, 0, result.stderr);
    return Date.now() - started;
  };
  const inline = hook('SessionStart');
  assert.ok(inline < 1500, `inline hook held for ${inline} ms`);
  const handoff = hook('PostToolUse');
  assert.ok(handoff < 1500, `event hook held for ${handoff} ms`);
  assert.ok(await until(() => fs.readdirSync(pids).length > 0, 5000), 'git was reached');
  assert.ok(await until(() => stuck().length === 0, 8000), `stuck git still alive: ${stuck()}`);
});

test('order-sensitive prompt and model events are processed before the hook returns', async () => {
  assert.ok(INLINE_EVENTS.includes('UserPromptExpansion') && INLINE_EVENTS.includes('PostModelSwitch'));
  const sessionId = crypto.randomUUID();
  await runClaudeHook({ hook_event_name: 'UserPromptExpansion', session_id: sessionId, cwd: root,
    expansion_type: 'slash_command', command_name: 'brain', command_args: '' }, { inlineMs: 5000 });
  const flow = createFlow({ harness: 'claude', cwd: root, env: process.env });
  assert.ok(flow.session(sessionId), 'state exists as soon as the hook returns');
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

test('an older cached bootstrap calling the new runtime still exits on its own', async () => {
  // Old bootstraps call handleClaudeHook(payload) and never exit explicitly.
  const { project, env, stuck } = stuckGit();
  const program = `const { handleClaudeHook } = require(${JSON.stringify(require.resolve('../runtime/langfuse/claude.cjs'))});
    handleClaudeHook(${JSON.stringify({ hook_event_name: 'SessionStart', session_id: crypto.randomUUID(), cwd: project })})
      .then(output => { if (output) process.stdout.write(JSON.stringify(output)); });`;
  const started = Date.now();
  const result = spawnSync(process.execPath, ['-e', program], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started < 3000, `old-style caller lived ${Date.now() - started} ms`);
  assert.ok(await until(() => stuck().length === 0, 8000), 'stuck subprocesses were killed');
});

test('a Stop processed after a newer prompt never completes the newer turn', async () => {
  const flow = new StubFlow();
  const base = { session_id: 'session-order', cwd: root };
  const at = time => ({ flow, env: {}, clock: () => time, reconcile: false, flush: false });
  await processClaudeHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'first' }, at(1000));
  await processClaudeHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'second' }, at(3000));
  // The first turn's Stop was received at 2000 but processed late.
  await processClaudeHook({ ...base, hook_event_name: 'Stop' }, at(2000));
  const agent = flow.queued.filter(record => record.type === 'AGENT').at(-1);
  assert.notEqual(agent.outcome, 'completed', 'the second turn is still running');
});
