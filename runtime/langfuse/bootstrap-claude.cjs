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
if (require.main === module) {
  // Exit explicitly once the answer is flushed: nothing may keep the hook alive.
  const exit = () => process.exit(0);
  setTimeout(exit, 7500).unref(); // Backstop under Claude's 8-second native timeout.
  readInput().then(input => input === null ? null : main(input))
    .then(result => { if (result && Object.keys(result).length) process.stdout.write(JSON.stringify(result), exit); else exit(); })
    .catch(exit); // Telemetry failure is nonblocking; never echo payloads/errors.
}
module.exports = { main, readInput };
