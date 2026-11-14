'use strict';

// Tracing must never slow a session down. These tests pin the hook's bounds:
// budgeted transcript reconciliation that resumes, no in-hook delivery, a
// prompt return for every event, and detached processing of the handed-off
// event. Synthetic fixtures only; delivery targets a closed local port.
const assert = require('node:assert/strict');
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
const { processClaudeHook, runClaudeHook } = require('../runtime/langfuse/claude.cjs');
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

test('the kill switch spawns nothing and returns nothing', async () => {
  process.env.BRAIN_TRACING_ENABLED = 'false';
  try {
    assert.equal(await runClaudeHook({ hook_event_name: 'UserPromptSubmit', session_id: 'session-off', cwd: root }), null);
  } finally { delete process.env.BRAIN_TRACING_ENABLED; }
});
