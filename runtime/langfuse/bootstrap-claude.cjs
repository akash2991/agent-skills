#!/usr/bin/env node
'use strict';

// Installed in the private per-user code cache; project-scoped hooks reference
// it so an older child-worktree base need not contain the runtime package yet.
const path = require('node:path');
const { findRuntime } = require('./bootstrap.js');
const LIMIT = 8 * 1024 * 1024;

async function main(input, options = {}) {
  const env = options.env || process.env;
  if (['false', '0'].includes(String(env.BRAIN_TRACING_ENABLED || '').toLowerCase())
    || ['false', '0'].includes(String(env.LANGFUSE_TRACING_ENABLED || '').toLowerCase())) return null;
  if (Buffer.byteLength(input) > LIMIT) return null;
  const payload = JSON.parse(input);
  if (!payload || typeof payload.cwd !== 'string') return null;
  const entry = (options.findRuntime || findRuntime)(payload.cwd);
  if (!entry) return null;
  const runtimeDir = path.dirname(entry);
  const adapter = options.adapter || require(path.join(runtimeDir, 'claude.cjs'));
  // Current adapters bound the hook and acknowledge inside that bound. An
  // older project runtime has no bound and can block a session for minutes,
  // so its Claude tracing is dropped until the project updates its runtime.
  if (typeof adapter.runClaudeHook !== 'function') return null;
  return adapter.runClaudeHook(payload, { acknowledgeSession: true });
}

function readInput(input = process.stdin, timeoutMs = 750) {
  return new Promise(resolve => {
    let size = 0;
    const chunks = [];
    const done = value => {
      clearTimeout(timer);
      input.off('data', data); input.off('end', end); input.off('error', fail);
      resolve(value);
    };
    const fail = () => done(null);
    const data = chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > LIMIT) { fail(); return; }
      chunks.push(buffer);
    };
    // Decode once: an arbitrary stream chunk can split a UTF-8 code point.
    const end = () => done(Buffer.concat(chunks).toString('utf8'));
    const timer = setTimeout(fail, timeoutMs);
    input.on('data', data); input.once('end', end); input.once('error', fail);
  });
}
// The installed hook entry is a thin supervisor: it reads stdin, runs
// discovery and the hook in a child process in its own process group, waits at
// most the inline cap plus one second, then kills that group. Discovery does
// synchronous filesystem work, so it must not run in the process whose timer
// enforces the deadline. exec.cjs reuses this for per-run hooks.
const CHILD = '--agent-brain-hook-child';
function superviseMs(env = process.env) {
  const value = Number(env.BRAIN_TRACE_HOOK_INLINE_MS);
  return (Number.isFinite(value) && value > 0 ? Math.min(5000, Math.max(100, value)) : 1500) + 1000;
}
function supervise(args, input, ms) {
  return new Promise(resolve => {
    let child, done = false;
    const chunks = [];
    const finish = () => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      let output = null;
      try { output = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* no answer */ }
      resolve(output && typeof output === 'object' ? output : null);
    };
    const timer = setTimeout(finish, ms);
    try {
      // The event's own work process runs in another group, so pass the
      // deadline down: no event work may outlive this supervisor.
      const env = { ...process.env, BRAIN_TRACE_HOOK_DEADLINE: String(Date.now() + ms - 100) };
      child = require('node:child_process').spawn(process.execPath, args, { detached: true, env, stdio: ['pipe', 'pipe', 'ignore'] });
      child.once('error', finish);
      child.stdout.on('data', chunk => chunks.push(chunk));
      child.once('close', finish);
      child.stdin.once('error', () => {});
      child.stdin.end(input);
    } catch { finish(); }
  });
}
const disabled = env => ['BRAIN_TRACING_ENABLED', 'LANGFUSE_TRACING_ENABLED']
  .some(key => ['false', '0'].includes(String(env[key] || '').toLowerCase()));

if (require.main === module) {
  // Exit explicitly once the answer is flushed: nothing may keep the hook alive.
  const exit = () => process.exit(0);
  setTimeout(exit, 7500).unref(); // Backstop under Claude's 8-second native timeout.
  const write = result => { if (result && Object.keys(result).length) process.stdout.write(JSON.stringify(result), exit); else exit(); };
  if (process.argv[2] === CHILD) {
    readInput(process.stdin, 5000).then(input => input === null ? null : main(input)).then(write).catch(exit);
  } else {
    readInput().then(input => input === null || disabled(process.env) ? null
      : supervise([__filename, CHILD], input, superviseMs())).then(write).catch(exit);
  }
}
module.exports = { main, readInput, supervise, superviseMs };
