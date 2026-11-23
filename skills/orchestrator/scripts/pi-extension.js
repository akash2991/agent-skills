'use strict';

// Loaded with `pi -e` only into workers the orchestrator launched. It records
// prompts, compactions, and session changes on the worker's row. Outside such a
// worker (no ORCHESTRATOR_DB / ORCHESTRATOR_SESSION in the environment) it does
// nothing.
//
// Pi runs extensions on its own event loop, so nothing here waits on the
// record: each event goes to a detached writer process (`orchestrator.js hook
// pi`) that waits for the database itself, fails silently, and leaves the next
// event unaffected. Nothing is printed into Pi's screen.

const { spawn } = require('node:child_process');
const path = require('node:path');

module.exports = function orchestratorRecorder(pi) {
  const env = process.env;
  if (!env.ORCHESTRATOR_DB || !env.ORCHESTRATOR_SESSION) return;
  const cli = env.ORCHESTRATOR_CLI || path.join(__dirname, 'orchestrator.js');
  const node = env.ORCHESTRATOR_NODE || 'node';
  // The writers race, so each event carries this launch, its order, and when it
  // happened: the record ignores a session start older than one it already
  // applied, and shows prompts in the order they were typed. Pi runs
  // this factory again for /new, /resume, and /fork, so the order lives on the
  // process, not on one factory.
  const launch = env.ORCHESTRATOR_LAUNCH;
  const SEQ = Symbol.for('orchestrator.recorder.seq');

  const record = (fields) => {
    globalThis[SEQ] = (globalThis[SEQ] || 0) + 1;
    const event = { ...fields, launch, seq: globalThis[SEQ], at: new Date().toISOString() };
    try {
      const child = spawn(node, [cli, 'hook', 'pi'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true, env });
      child.on('error', () => {});
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(event));
      child.unref();
    } catch { /* recording is best effort; the session is not */ }
  };

  pi.on('session_start', (_event, ctx) => {
    let nativeSessionId;
    let transcriptPath;
    try { nativeSessionId = ctx.sessionManager.getSessionId(); } catch { /* older Pi */ }
    try { transcriptPath = ctx.sessionManager.getSessionFile(); } catch { /* older Pi */ }
    record({ kind: 'start', nativeSessionId, transcriptPath, detail: 'pi' });
  });
  pi.on('input', (event) => {
    if (event && event.source !== 'extension' && typeof event.text === 'string' && event.text.trim()) {
      record({ kind: 'prompt', text: event.text });
    }
  });
  pi.on('session_compact', (event) => record({ kind: 'compact', detail: event && event.reason }));
  pi.on('agent_settled', () => record({ kind: 'stop' }));
  pi.on('session_shutdown', () => record({ kind: 'end' }));
};
