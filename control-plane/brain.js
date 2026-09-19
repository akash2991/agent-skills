#!/usr/bin/env node
'use strict';
// Agent Brain control plane CLI. One command surface over recorded agent-work usage: the
// metadata-only events harness hooks capture, their token and cost summary, and the Langfuse export.
// Running agents, their panes, and the model and effort each was dispatched with belong to firstmate;
// this CLI records what the harness reports actually ran. `--json` on any command returns the same
// data as JSON.
//
//   brain.js status
//   brain.js event     --event '<json>'
//   brain.js export    langfuse [--limit N] [--all] [--dry-run]
//   brain.js config    show|set --key K --value V
const database = require('./db');
const langfuse = require('./langfuse');
const { emitEvent } = require('./emit');

const UNKNOWN = 'UNKNOWN';
// Commands that used to exist and are now firstmate's job. Named here so a habit, a stale document,
// or an older persona gets a pointer instead of a bare "unknown group".
const MOVED_TO_FIRSTMATE = new Set(['context', 'session', 'agent', 'quota', 'serve', 'budget']);

const flag = (args, name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
const has = (args, name) => args.includes(`--${name}`);
const need = (value, name) => { if (value === undefined || value === '') throw new Error(`--${name} is required`); return value; };
const int = value => (value === undefined || value === '' ? null : Number.parseInt(value, 10));
const out = (args, data, human) => process.stdout.write(has(args, 'json') ? `${JSON.stringify(data, null, 2)}\n` : `${human}\n`);

// Silence is the worst failure mode for tracing: you only find out it never worked when you go
// looking for data that is not there. Say plainly whether it is on.
function tracingLine(db) {
  const mode = database.config(db).langfuse_export || 'turn';
  const cred = langfuse.credentials();
  if (mode === 'off') return 'Langfuse tracing: OFF (langfuse_export=off).';
  if (cred.missing.length) {
    return `Langfuse tracing: OFF, no credentials. Set ${cred.missing.join(' and ')} in ${cred.searched[0]} or ${cred.searched[cred.searched.length - 1]} (which serves every project).`;
  }
  return `Langfuse tracing: ON (${mode}) → ${cred.baseUrl}, credentials from ${cred.source}.`;
}

function statusData(db) {
  const usage = database.usage(db);
  return {
    checked_at: new Date().toISOString(), db: db.file,
    input_basis: usage.input_basis,
    usage: usage.rows,
    event_counts: Object.fromEntries(db.prepare('SELECT type, COUNT(*) n FROM events GROUP BY type').all().map(r => [r.type, r.n])),
    tracing: tracingLine(db),
  };
}

function renderStatus(s) {
  const lines = [`control plane ${s.db} at ${s.checked_at}`, s.tracing, ''];
  if (!s.usage.length) {
    lines.push('No usage recorded yet: token and cost figures are UNKNOWN until a harness hook reports them.');
    return lines.join('\n');
  }
  lines.push(`usage by agent and session, newest first (input basis: ${s.input_basis})`);
  for (const r of s.usage) {
    lines.push(`  ${r.agent_id} session=${r.session_id || UNKNOWN} in=${r.input_tokens} out=${r.output_tokens} cache_read=${r.cache_read_tokens} cache_write=${r.cache_write_tokens} cost=${r.cost_usd ?? UNKNOWN} models=${r.models || UNKNOWN} from ${r.first_at} to ${r.last_at}`);
  }
  return lines.join('\n');
}

// ─── observability export (Langfuse) ─────────────────────────────────────────
// Langfuse answers "what happened, in what order, and what did it cost", with trace timelines and
// dashboards it would be wasteful to rebuild.
async function exportCommand(db, args) {
  const backend = args[1];
  if (backend !== 'langfuse') { console.error('usage: brain.js export langfuse [--limit N] [--all] [--dry-run]'); process.exitCode = 2; return; }
  const result = await langfuse.send(db, {
    limit: int(flag(args, 'limit')) ?? 500,
    all: has(args, 'all'),
    dryRun: has(args, 'dry-run'),
    envFile: flag(args, 'env-file'),
  });
  if (!result.ok) {
    const why = result.reason === 'missing_credentials'
      ? `set ${result.missing.join(' and ')} (a .env file in this directory is read too)`
      : `${result.status}: ${result.body}`;
    out(args, result, `export to ${result.baseUrl} failed: ${why}`);
    process.exitCode = 5;
    return;
  }
  out(args, result, result.dryRun
    ? `[dry-run] ${result.events} event(s) would become ${result.spans} span(s) at ${result.baseUrl}`
    : `exported ${result.sent} event(s) as ${result.spans} span(s) to ${result.baseUrl}${result.note ? ` (${result.note})` : ''}`);
}

// ─── entry ───────────────────────────────────────────────────────────────────
// Async because one command (export) performs network I/O. Every other command stays synchronous;
// the await below is what keeps the database open until an async command has finished with it.
async function main(args = process.argv.slice(2)) {
  const group = args[0];
  const actor = flag(args, 'actor') || process.env.BRAIN_ACTOR || 'cli';
  if (!group || group === 'help' || group === '--help') {
    process.stdout.write(['brain.js <group> <action> [--flags]  ·  add --json to any command',
      '  status                                              recorded token and cost usage, and whether tracing is on',
      "  event    --event '<json>'                           record one metadata-only event",
      '  export   langfuse [--limit N] [--all] [--dry-run]   ship events to Langfuse as OTLP spans',
      '  config   show|set --key K --value V',
      '',
      'Spawning, supervising, and steering agents, their model and effort, and provider quota are firstmate\'s.'].join('\n') + '\n');
    return;
  }
  if (MOVED_TO_FIRSTMATE.has(group)) {
    process.stderr.write(`brain.js ${group} was removed: firstmate runs the crew now (spawning, supervision, model and effort per task, provider quota). This control plane only records usage and exports it.\n`);
    process.exitCode = 2;
    return;
  }
  const db = database.open(flag(args, 'db'));
  try {
    if (group === 'export') return await exportCommand(db, args);
    if (group === 'status') { const s = statusData(db); return out(args, s, renderStatus(s)); }
    if (group === 'event') {
      const raw = flag(args, 'event') || require('node:fs').readFileSync(0, 'utf8');
      const event = emitEvent(JSON.parse(raw), { db });
      return out(args, event, `recorded ${event.type} for ${event.agent_id}`);
    }
    if (group === 'config') {
      if (args[1] === 'set') { database.setConfig(db, need(flag(args, 'key'), 'key'), need(flag(args, 'value'), 'value'), actor); return out(args, { ok: true }, `config ${flag(args, 'key')}=${flag(args, 'value')}`); }
      const cfg = database.config(db);
      return out(args, cfg, Object.entries(cfg).map(([k, v]) => `${k}=${v}`).join('\n'));
    }
    throw new Error(`unknown group "${group}" (try: brain.js help)`);
  } finally { db.close(); }
}

module.exports = { main, statusData, renderStatus };

if (require.main === module) {
  main().catch(error => { process.stderr.write(`ERROR ${error.message}\n`); process.exitCode = 1; });
}
