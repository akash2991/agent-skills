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
// The hook used to read only the last 40 messages, on the assumption that it fires every turn and
// never falls behind. It does fall behind: in a real session 452 of 499 messages were never
// recorded, so usage and cost were understated by an order of magnitude and nothing ever backfilled
// them, because a skipped message is skipped forever. Ingestion is idempotent by construction, so
// reading the whole transcript is safe and self-healing: whatever was missed is picked up on the
// next firing. The cost is one indexed lookup per message, against a file the harness is already
// keeping in the page cache.

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function payload() {
  const raw = readStdin().trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// Whose usage this is. An explicit id wins; then the task id firstmate exports into every crew pane,
// which is what lines usage up with the task that spent it; otherwise the harness session, so usage
// is never silently dropped on the floor. There is no registry to look anyone up in.
function agentFor(sessionId, env = process.env) {
  if (env.BRAIN_AGENT_ID) return env.BRAIN_AGENT_ID;
  if (env.FM_TASK_ID) return env.FM_TASK_ID;
  return `session-${String(sessionId || 'unknown').slice(0, 8)}`;
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
      // The harness records the thinking effort it actually ran with. Reading it here is what makes
      // the recorded effort the one that ran rather than the one somebody asked for.
      effort: entry.effort || message.effort || undefined,
      sidechain: Boolean(entry.isSidechain),
      timestamp: entry.timestamp || undefined,
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      // A breakdown of output_tokens, never an addition to it.
      thinking_tokens: u.output_tokens_details?.thinking_tokens ?? undefined,
      cache_read_input_tokens: u.cache_read_input_tokens ?? undefined,
      cache_write_input_tokens: u.cache_creation_input_tokens ?? undefined,
      // What actually sat in the window for this request: fresh input plus everything read from or
      // written to the cache. Exact, because the provider reported each part.
      context_input_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    });
  }
  return out.slice(-Math.max(limit ?? out.length, 1));
}

// Ship captured events to the external observability backend without the user running a command.
// `langfuse_export` decides when: `off`, `session-end` (the default once credentials exist), or
// `turn` for a near-live dashboard. A failure here must never break the harness, so it is swallowed
// and reported in the hook's own output rather than thrown.
async function autoExport(db, when) {
  try {
    const mode = database.config(db).langfuse_export || 'turn';
    if (mode === 'off' || (mode === 'session-end' && when !== 'session-end')) return null;
    const langfuse = require('./langfuse');
    if (langfuse.credentials().missing.length) return null;
    const result = await langfuse.send(db, { limit: 500 });
    return result.ok ? { langfuse: result.sent } : { langfuse: `failed: ${result.reason}` };
  } catch (error) {
    return { langfuse: `failed: ${error.message}` };
  }
}

function alreadyRecorded(db, eventId) {
  return Boolean(db.prepare('SELECT 1 FROM events WHERE event_id = ?').get(eventId));
}

// Emits model.completed and turn.completed for every transcript message not yet recorded.
function ingest(db, { transcript, sessionId, agentId, harness, all }) {
  const messages = transcriptMessages(transcript, null);
  let recorded = 0, skipped = 0, turns = 0;
  for (const [index, m] of messages.entries()) {
    const usageId = `msg:${m.uuid}`;
    if (alreadyRecorded(db, usageId)) { skipped++; continue; }
    // A sidechain message is a subagent's turn. The hook cannot tell which child it was, so it is
    // attributed to the session's agent rather than guessed or dropped.
    const owner = agentId;
    emitEvent({
      schema_version: '1.0', event_id: usageId, type: 'model.completed',
      agent_id: owner, session_id: sessionId || 'unknown',
      ...(m.timestamp ? { timestamp: m.timestamp } : {}),
      ...(m.model ? { model: m.model } : {}),
      ...(m.effort ? { effort: m.effort } : {}),
      usage: {
        input_tokens: m.input_tokens, output_tokens: m.output_tokens,
        ...(m.thinking_tokens === undefined ? {} : { thinking_tokens: m.thinking_tokens }),
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
  return { recorded, skipped, turns, considered: messages.length };
}

async function main(args = process.argv.slice(2)) {
  const action = args[0];
  const hook = payload();
  const db = database.open(flag(args, 'db'));
  try {
    const sessionId = flag(args, 'session') || hook.session_id || hook.sessionId;
    const harness = flag(args, 'harness') || process.env.BRAIN_HARNESS || 'claude-code';
    const transcript = flag(args, 'transcript') || hook.transcript_path;
    const agentId = flag(args, 'agent-id') || agentFor(sessionId);

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
        ? ingest(db, { transcript, sessionId, agentId, harness })
        : { recorded: 0, skipped: 0, turns: 0, considered: 0, reason: 'no transcript path in the hook payload' };
      const exported = await autoExport(db, 'turn');
      return process.stdout.write(`${JSON.stringify({ ok: true, agent_id: agentId, ...result, ...(exported ? { exported } : {}) })}\n`);
    }

    if (action === 'session-start') {
      emitEvent({ schema_version: '1.0', type: 'agent.status_changed', agent_id: agentId, session_id: sessionId || 'unknown',
        status: 'RUNNING' }, { db });
      return process.stdout.write(`${JSON.stringify({ ok: true, agent_id: agentId })}\n`);
    }

    if (action === 'session-end') {
      if (transcript) ingest(db, { transcript, sessionId, agentId, harness });
      await autoExport(db, 'session-end');
      emitEvent({ schema_version: '1.0', type: 'agent.completed', agent_id: agentId, session_id: sessionId || 'unknown' }, { db });
      return process.stdout.write(`${JSON.stringify({ ok: true, agent_id: agentId })}\n`);
    }

    throw new Error(`unknown action "${action}" (session-start | tool | turn | session-end | ingest)`);
  } finally {
    db.close();
  }
}

module.exports = { main, ingest, transcriptMessages, agentFor };

if (require.main === module) {
  // A hook must never break the session it observes: report the problem and exit 0.
  main().catch(error => process.stderr.write(`brain hook: ${error.message}\n`));
}
