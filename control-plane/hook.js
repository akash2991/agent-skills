#!/usr/bin/env node
'use strict';
// Automatic usage capture. Harness hooks call this with the hook payload on stdin; it turns real
// runtime facts into control-plane events so tokens, cost, context, turns, and tool calls stop
// being UNKNOWN. Nothing here reads or stores message content: only counts, names, and outcomes.
//
//   node hook.js session-start   < payload.json
//   node hook.js tool            < payload.json     (PostToolUse)
//   node hook.js turn            < payload.json     (Stop / SubagentStop)
//   node hook.js session-end     < payload.json
//   node hook.js ingest --transcript <path> --session <id> [--all]   (manual or non-Claude harness)
//
// Every event derived from a transcript message carries a deterministic id (`msg:<uuid>` and
// `turn:<uuid>`), so re-running a hook, replaying a transcript, or a hook firing twice can never
// double-count usage.
const crypto = require('node:crypto');
const fs = require('node:fs');
const database = require('./db');
const { emitEvent } = require('./emit');

const flag = (args, name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
const has = (args, name) => args.includes(`--${name}`);
// How many trailing transcript messages to consider when no cursor exists. Deterministic ids make a
// wider window harmless, but a bounded read keeps the hook fast on a long transcript.
const DEFAULT_WINDOW = 40;

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function payload() {
  const raw = readStdin().trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// The agent these events belong to: whoever is bound to this harness session, else the role the
// session claimed, else a synthetic agent so usage is never silently dropped on the floor.
function resolveAgent(db, sessionId, { harness, cwd } = {}) {
  if (sessionId) {
    const bound = db.prepare('SELECT agent_id FROM agents WHERE session_id = ? ORDER BY started_at DESC').get(sessionId);
    if (bound) return bound.agent_id;
    const session = db.prepare('SELECT role FROM sessions WHERE id = ? OR id LIKE ?').get(sessionId, `%${String(sessionId).slice(0, 8)}%`);
    if (session) {
      const byRole = db.prepare("SELECT agent_id FROM agents WHERE role = ? AND status = 'RUNNING' ORDER BY started_at DESC").get(session.role);
      if (byRole) return byRole.agent_id;
    }
  }
  // A live CEO is the usual owner of an unbound session: it is the main session by definition.
  const ceo = db.prepare("SELECT agent_id FROM agents WHERE role = 'ceo' AND status = 'RUNNING'").get();
  if (ceo) return ceo.agent_id;
  const id = `session-${String(sessionId || 'unknown').slice(0, 8)}`;
  db.prepare(`INSERT INTO agents(agent_id, role, parent, session_id, harness, status, started_at, last_heartbeat, current_operation)
              VALUES(?, 'unregistered', NULL, ?, ?, 'RUNNING', ?, ?, 'observed by a runtime hook before registering')
              ON CONFLICT(agent_id) DO UPDATE SET last_heartbeat = excluded.last_heartbeat`)
    .run(id, sessionId || null, harness || null, new Date().toISOString(), new Date().toISOString());
  return id;
}

// Assistant messages carrying usage, oldest first. Claude Code writes one JSON object per line with
// `message.usage` and `message.model`; sidechain entries are subagent turns.
function transcriptMessages(file, limit) {
  if (!file || !fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const window = limit === null ? lines : lines.slice(-Math.max(limit * 4, limit));
  const out = [];
  for (const line of window) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry.message;
    if (!message || !message.usage) continue;
    const u = message.usage;
    out.push({
      uuid: entry.uuid || crypto.createHash('sha256').update(line).digest('hex').slice(0, 32),
      model: message.model || entry.model || undefined,
      sidechain: Boolean(entry.isSidechain),
      timestamp: entry.timestamp || undefined,
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? undefined,
      cache_write_input_tokens: u.cache_creation_input_tokens ?? undefined,
      // What actually sat in the window for this request: fresh input plus everything read from or
      // written to the cache. Exact, because the provider reported each part.
      context_input_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    });
  }
  return out.slice(-Math.max(limit ?? out.length, 1));
}

function alreadyRecorded(db, eventId) {
  return Boolean(db.prepare('SELECT 1 FROM events WHERE event_id = ?').get(eventId));
}

// Emits model.completed and turn.completed for every transcript message not yet recorded.
function ingest(db, { transcript, sessionId, agentId, harness, all }) {
  const messages = transcriptMessages(transcript, all ? null : DEFAULT_WINDOW);
  let recorded = 0, skipped = 0, turns = 0;
  for (const [index, m] of messages.entries()) {
    const usageId = `msg:${m.uuid}`;
    if (alreadyRecorded(db, usageId)) { skipped++; continue; }
    // A sidechain message is a subagent's turn. The hook cannot know which registered agent it was,
    // so it is attributed to the session's agent and marked, rather than guessed or dropped.
    const owner = agentId;
    emitEvent({
      schema_version: '1.0', event_id: usageId, type: 'model.completed',
      agent_id: owner, session_id: sessionId || 'unknown',
      ...(m.timestamp ? { timestamp: m.timestamp } : {}),
      ...(m.model ? { model: m.model } : {}),
      usage: {
        input_tokens: m.input_tokens, output_tokens: m.output_tokens,
        ...(m.cache_read_input_tokens === undefined ? {} : { cache_read_input_tokens: m.cache_read_input_tokens }),
        ...(m.cache_write_input_tokens === undefined ? {} : { cache_write_input_tokens: m.cache_write_input_tokens }),
        source: 'runtime'
      },
      context: { input_tokens: m.context_input_tokens, token_measurement: 'exact' }
    }, { db });
    recorded++;
    const turnId = `turn:${m.uuid}`;
    if (!alreadyRecorded(db, turnId)) {
      emitEvent({
        schema_version: '1.0', event_id: turnId, type: 'turn.completed',
        agent_id: owner, session_id: sessionId || 'unknown',
        ...(m.timestamp ? { timestamp: m.timestamp } : {}),
        turn: { number: index + 1, outcome: 'success' }
      }, { db });
      turns++;
    }
  }
  if (recorded) db.prepare('UPDATE agents SET last_heartbeat = ? WHERE agent_id = ?').run(new Date().toISOString(), agentId);
  return { recorded, skipped, turns, considered: messages.length };
}

function main(args = process.argv.slice(2)) {
  const action = args[0];
  const hook = payload();
  const db = database.open(flag(args, 'db'));
  try {
    const sessionId = flag(args, 'session') || hook.session_id || hook.sessionId;
    const harness = flag(args, 'harness') || process.env.BRAIN_HARNESS || 'claude-code';
    const transcript = flag(args, 'transcript') || hook.transcript_path;
    const agentId = flag(args, 'agent-id') || process.env.BRAIN_AGENT_ID || resolveAgent(db, sessionId, { harness, cwd: hook.cwd });

    if (action === 'tool') {
      const name = hook.tool_name || flag(args, 'tool') || 'unknown';
      const response = hook.tool_response;
      // A hook payload reports the call, not the content: only the name and whether it failed.
      const failed = Boolean(response && (response.is_error || response.error || response.success === false));
      emitEvent({
        schema_version: '1.0', type: 'tool.completed', agent_id: agentId, session_id: sessionId || 'unknown',
        tool: { name, outcome: failed ? 'error' : 'success' }
      }, { db });
      // A tool call is also the cheapest reliable moment to pick up new usage.
      const result = transcript ? ingest(db, { transcript, sessionId, agentId, harness }) : { recorded: 0 };
      return process.stdout.write(`${JSON.stringify({ ok: true, tool: name, usage_events: result.recorded })}\n`);
    }

    if (action === 'turn' || action === 'ingest') {
      const result = transcript
        ? ingest(db, { transcript, sessionId, agentId, harness, all: has(args, 'all') })
        : { recorded: 0, skipped: 0, turns: 0, considered: 0, reason: 'no transcript path in the hook payload' };
      return process.stdout.write(`${JSON.stringify({ ok: true, agent_id: agentId, ...result })}\n`);
    }

    if (action === 'session-start') {
      emitEvent({ schema_version: '1.0', type: 'agent.status_changed', agent_id: agentId, session_id: sessionId || 'unknown',
        status: 'RUNNING' }, { db });
      db.prepare('UPDATE agents SET session_id = COALESCE(session_id, ?), harness = COALESCE(harness, ?), last_heartbeat = ? WHERE agent_id = ?')
        .run(sessionId || null, harness, new Date().toISOString(), agentId);
      return process.stdout.write(`${JSON.stringify({ ok: true, agent_id: agentId })}\n`);
    }

    if (action === 'session-end') {
      if (transcript) ingest(db, { transcript, sessionId, agentId, harness });
      emitEvent({ schema_version: '1.0', type: 'agent.completed', agent_id: agentId, session_id: sessionId || 'unknown' }, { db });
      if (sessionId) {
        const live = db.prepare('SELECT id FROM sessions WHERE (id = ? OR id LIKE ?) AND released_at IS NULL').get(sessionId, `%${String(sessionId).slice(0, 8)}%`);
        if (live) {
          db.prepare('UPDATE sessions SET released_at = ? WHERE id = ?').run(new Date().toISOString(), live.id);
          database.record(db, 'hook', 'session', live.id, 'released_at', null, new Date().toISOString(), 'harness session ended');
        }
      }
      return process.stdout.write(`${JSON.stringify({ ok: true, agent_id: agentId })}\n`);
    }

    throw new Error(`unknown action "${action}" (session-start | tool | turn | session-end | ingest)`);
  } finally {
    db.close();
  }
}

module.exports = { main, ingest, transcriptMessages, resolveAgent };

if (require.main === module) {
  // A hook must never break the session it observes: report the problem and exit 0.
  try { main(); }
  catch (error) { process.stderr.write(`brain hook: ${error.message}\n`); }
}
