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
  if (payload.hook_event_name === 'SessionStart' && !options.adapter) {
    const flow = require(path.join(runtimeDir, 'flow.cjs')).createFlow({ harness: 'claude', cwd: payload.cwd, env });
    flow.acknowledgeSession(payload.session_id);
  }
  return adapter.handleClaudeHook(payload);
}

if (require.main === module) {
  let input = '';
  let size = 0;
  process.stdin.on('data', chunk => {
    size += chunk.length;
    if (size <= LIMIT) input += chunk.toString('utf8');
  });
  process.stdin.on('end', () => {
    if (size > LIMIT) return;
    main(input).then(result => { if (result && Object.keys(result).length) process.stdout.write(JSON.stringify(result)); })
      .catch(() => { /* Telemetry failure is nonblocking; never echo payloads/errors. */ });
  });
}
module.exports = { main };
