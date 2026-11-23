'use strict';

// Loaded with `pi -e` only into workers the orchestrator launched. It records
// prompts, compactions, and session changes on the worker's row. Outside such a
// worker (no ORCHESTRATOR_DB / ORCHESTRATOR_SESSION in the environment) it does
// nothing. A recording failure never reaches the user's session.

module.exports = function orchestratorRecorder(pi) {
  const dbPath = process.env.ORCHESTRATOR_DB;
  const sessionId = process.env.ORCHESTRATOR_SESSION;
  if (!dbPath || !sessionId) return;

  let store;
  let db;
  let failed = false;
  const record = (event) => {
    if (failed) return;
    try {
      store = store || require('./store.js');
      db = db || store.open(dbPath);
      store.recordHookEvent(db, sessionId, event);
    } catch (err) {
      failed = true;
      process.stderr.write(`orchestrator: recording disabled for this session: ${err.message}\n`);
    }
  };

  pi.on('session_start', (_event, ctx) => {
    let nativeSessionId;
    try { nativeSessionId = ctx.sessionManager.getSessionId(); } catch { /* older Pi */ }
    record({ kind: 'start', nativeSessionId, detail: 'pi' });
  });
  pi.on('input', (event) => {
    if (event && event.source !== 'extension' && typeof event.text === 'string' && event.text.trim()) {
      record({ kind: 'prompt', text: event.text });
    }
  });
  pi.on('session_compact', (event) => record({ kind: 'compact', detail: event && event.reason }));
  pi.on('agent_settled', () => record({ kind: 'stop' }));
  pi.on('session_shutdown', () => {
    record({ kind: 'end' });
    try { if (db) db.close(); } catch { /* already closed */ }
    db = undefined;
  });
};
