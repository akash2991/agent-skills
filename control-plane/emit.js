#!/usr/bin/env node
'use strict';
// Metadata-only observability events, validated then written to the control-plane database.
// The event contract is event.schema.json; raw prompt, response, reasoning, document, tool-input,
// and tool-output content are intentionally not representable.

const crypto = require('node:crypto');
const database = require('./db');

const EVENT_TYPES = new Set([
  'agent.started', 'agent.status_changed', 'agent.completed',
  'skill.loaded', 'document.loaded',
  'turn.started', 'turn.completed', 'model.completed',
  'tool.completed', 'control.completed', ]);
const TOP_LEVEL_FIELDS = new Set([
  'schema_version', 'event_id', 'timestamp', 'type', 'agent_id', 'parent_agent_id',
  'session_id', 'trace_id', 'span_id', 'parent_span_id', 'role', 'ticket', 'status',
  'model', 'effort', 'duration_ms', 'error_type', 'runtime', 'artifact', 'context',
  'usage', 'turn', 'tool', 'control'
]);
const NESTED_FIELDS = {
  runtime: new Set(['name', 'session_ref', 'agent_ref', 'state_source']),
  artifact: new Set(['kind', 'name', 'path', 'sha256', 'bytes', 'tokens', 'token_measurement']),
  context: new Set(['input_tokens', 'window_tokens', 'token_measurement', 'sources']),
  usage: new Set(['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_input_tokens', 'cache_write_input_tokens', 'cost_usd', 'source']),
  turn: new Set(['number', 'duration_ms', 'outcome']),
  tool: new Set(['name', 'outcome', 'duration_ms']),
  control: new Set(['action', 'target', 'outcome']),
};
const SOURCE_FIELDS = new Set(['kind', 'name', 'bytes', 'tokens', 'token_measurement']);
const STATUS = new Set(['PLANNED', 'RUNNING', 'WAITING', 'BLOCKED', 'COMPLETED', 'FAILED', 'UNKNOWN']);
const MEASUREMENT = new Set(['exact', 'estimated', 'unknown']);
const ARTIFACT_KINDS = new Set(['skill', 'document', 'spec', 'plan', 'instructions', 'reference']);
const RUNTIME_STATES = new Set(['hook', 'api', 'screen', 'reported', 'unknown']);
const USAGE_SOURCES = new Set(['provider', 'runtime', 'calculated', 'unknown']);
const TURN_OUTCOMES = new Set(['success', 'error', 'blocked', 'interrupted', 'unknown']);
const TOOL_OUTCOMES = new Set(['success', 'error', 'cancelled', 'unknown']);
const CONTROL_ACTIONS = new Set(['focus', 'steer', 'interrupt', 'stop']);
const CONTROL_OUTCOMES = new Set(['success', 'error', 'refused']);

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function allowedFields(value, allowed, name) {
  object(value, name);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unsupported field "${key}" in ${name}`);
}

function nonNegativeNumber(value, name, integer = false) {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a non-negative ${integer ? 'integer' : 'number'}`);
  }
}

function validateMeasurement(value, name) {
  if (!MEASUREMENT.has(value)) throw new Error(`${name} must be exact, estimated, or unknown`);
}

function validateEvent(event) {
  allowedFields(event, TOP_LEVEL_FIELDS, 'event');
  for (const key of ['schema_version', 'event_id', 'timestamp', 'type', 'agent_id', 'session_id']) {
    if (typeof event[key] !== 'string' || !event[key]) throw new Error(`${key} is required`);
  }
  if (event.schema_version !== '1.0') throw new Error('schema_version must be 1.0');
  if (!EVENT_TYPES.has(event.type)) throw new Error(`unsupported event type "${event.type}"`);
  if (Number.isNaN(Date.parse(event.timestamp))) throw new Error('timestamp must be ISO 8601');
  if (event.status !== undefined && !STATUS.has(event.status)) throw new Error(`unsupported status "${event.status}"`);
  nonNegativeNumber(event.duration_ms, 'duration_ms');

  for (const [name, fields] of Object.entries(NESTED_FIELDS)) {
    if (event[name] !== undefined) allowedFields(event[name], fields, name);
  }
  if (event.runtime) {
    if (!event.runtime.name || !event.runtime.agent_ref) throw new Error('runtime.name and runtime.agent_ref are required');
    if (event.runtime.state_source !== undefined && !RUNTIME_STATES.has(event.runtime.state_source)) throw new Error(`unsupported runtime state source "${event.runtime.state_source}"`);
  }
  if (event.artifact) {
    if (!event.artifact.kind) throw new Error('artifact.kind is required');
    if (!ARTIFACT_KINDS.has(event.artifact.kind)) throw new Error(`unsupported artifact kind "${event.artifact.kind}"`);
    validateMeasurement(event.artifact.token_measurement, 'artifact.token_measurement');
    nonNegativeNumber(event.artifact.bytes, 'artifact.bytes', true);
    nonNegativeNumber(event.artifact.tokens, 'artifact.tokens', true);
    if (event.artifact.sha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(event.artifact.sha256)) throw new Error('artifact.sha256 must be a SHA-256 hex digest');
  }
  if (event.context) {
    validateMeasurement(event.context.token_measurement, 'context.token_measurement');
    nonNegativeNumber(event.context.input_tokens, 'context.input_tokens', true);
    nonNegativeNumber(event.context.window_tokens, 'context.window_tokens', true);
    if (event.context.window_tokens === 0) throw new Error('context.window_tokens must be positive');
    if (event.context.sources !== undefined) {
      if (!Array.isArray(event.context.sources)) throw new Error('context.sources must be an array');
      for (const source of event.context.sources) {
        allowedFields(source, SOURCE_FIELDS, 'context source');
        if (!source.kind || !source.name) throw new Error('context source kind and name are required');
        validateMeasurement(source.token_measurement, 'context source token_measurement');
        nonNegativeNumber(source.bytes, 'context source bytes', true);
        nonNegativeNumber(source.tokens, 'context source tokens', true);
      }
    }
  }
  if (event.usage) {
    for (const key of ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_input_tokens', 'cache_write_input_tokens']) nonNegativeNumber(event.usage[key], `usage.${key}`, true);
    nonNegativeNumber(event.usage.cost_usd, 'usage.cost_usd');
    if (!event.usage.source) throw new Error('usage.source is required');
    if (!USAGE_SOURCES.has(event.usage.source)) throw new Error(`unsupported usage source "${event.usage.source}"`);
  }
  if (event.turn) {
    nonNegativeNumber(event.turn.number, 'turn.number', true);
    if (!event.turn.number || !event.turn.outcome) throw new Error('turn.number and turn.outcome are required');
    if (!TURN_OUTCOMES.has(event.turn.outcome)) throw new Error(`unsupported turn outcome "${event.turn.outcome}"`);
    nonNegativeNumber(event.turn.duration_ms, 'turn.duration_ms');
  }
  if (event.tool) {
    if (!event.tool.name || !event.tool.outcome) throw new Error('tool.name and tool.outcome are required');
    if (!TOOL_OUTCOMES.has(event.tool.outcome)) throw new Error(`unsupported tool outcome "${event.tool.outcome}"`);
    nonNegativeNumber(event.tool.duration_ms, 'tool.duration_ms');
  }
  if (event.control) {
    if (!event.control.action || !event.control.target || !event.control.outcome) throw new Error('control.action, control.target, and control.outcome are required');
    if (!CONTROL_ACTIONS.has(event.control.action)) throw new Error(`unsupported control action "${event.control.action}"`);
    if (!CONTROL_OUTCOMES.has(event.control.outcome)) throw new Error(`unsupported control outcome "${event.control.outcome}"`);
  }
  return event;
}

function normalizeEvent(input, options = {}) {
  object(input, 'event');
  return {
    ...input,
    event_id: input.event_id || (options.id ? options.id() : crypto.randomUUID()),
    timestamp: input.timestamp || (options.now ? options.now() : new Date().toISOString())
  };
}

const COLUMNS = {
  event_id: e => e.event_id,
  timestamp: e => e.timestamp,
  type: e => e.type,
  agent_id: e => e.agent_id,
  parent_agent_id: e => e.parent_agent_id,
  session_id: e => e.session_id,
  trace_id: e => e.trace_id,
  span_id: e => e.span_id,
  parent_span_id: e => e.parent_span_id,
  role: e => e.role,
  ticket: e => e.ticket,
  status: e => e.status,
  model: e => e.model,
  effort: e => e.effort,
  duration_ms: e => e.duration_ms,
  error_type: e => e.error_type,
  input_tokens: e => e.usage?.input_tokens,
  output_tokens: e => e.usage?.output_tokens,
  thinking_tokens: e => e.usage?.thinking_tokens,
  cache_read_tokens: e => e.usage?.cache_read_input_tokens,
  cache_write_tokens: e => e.usage?.cache_write_input_tokens,
  cost_usd: e => e.usage?.cost_usd,
  usage_source: e => e.usage?.source,
  context_input_tokens: e => e.context?.input_tokens,
  context_window_tokens: e => e.context?.window_tokens,
  context_measurement: e => e.context?.token_measurement,
  artifact_kind: e => e.artifact?.kind,
  artifact_name: e => e.artifact?.name,
  artifact_path: e => e.artifact?.path,
  artifact_bytes: e => e.artifact?.bytes,
  artifact_tokens: e => e.artifact?.tokens,
  artifact_measurement: e => e.artifact?.token_measurement,
  artifact_sha256: e => e.artifact?.sha256,
  turn_number: e => e.turn?.number,
  turn_outcome: e => e.turn?.outcome,
  tool_name: e => e.tool?.name,
  tool_outcome: e => e.tool?.outcome,
  control_action: e => e.control?.action,
  control_target: e => e.control?.target,
  control_outcome: e => e.control?.outcome,
  raw: e => JSON.stringify(e)
};
const NAMES = Object.keys(COLUMNS);
const INSERT = `INSERT INTO events(${NAMES.join(', ')}) VALUES(${NAMES.map(() => '?').join(', ')})`;

// Writes one validated event. `db` may be an open database (reused by callers in a loop) or omitted.
function emitEvent(input, options = {}) {
  const event = validateEvent(normalizeEvent(input, options));
  const db = options.db || database.open(options.dbFile);
  try {
    db.prepare(INSERT).run(...NAMES.map(name => {
      const value = COLUMNS[name](event);
      return value === undefined ? null : value;
    }));
    // An event that reports a model or effort keeps the registry's current values honest.
    if (event.model || event.effort) {
      const agent = db.prepare('SELECT model, effort FROM agents WHERE agent_id = ?').get(event.agent_id);
      if (agent) {
        if (event.model && event.model !== agent.model) {
          db.prepare('UPDATE agents SET model = ? WHERE agent_id = ?').run(event.model, event.agent_id);
          database.record(db, event.agent_id, 'agent', event.agent_id, 'model', agent.model, event.model, `observed in ${event.type}`);
        }
        if (event.effort && event.effort !== agent.effort) {
          db.prepare('UPDATE agents SET effort = ? WHERE agent_id = ?').run(event.effort, event.agent_id);
          database.record(db, event.agent_id, 'agent', event.agent_id, 'effort', agent.effort, event.effort, `observed in ${event.type}`);
        }
      }
    }
  } finally {
    if (!options.db) db.close();
  }
  return event;
}

function readEvents(options = {}) {
  const db = options.db || database.open(options.dbFile);
  try {
    return db.prepare('SELECT raw FROM events ORDER BY timestamp, rowid').all().map(row => JSON.parse(row.raw));
  } finally {
    if (!options.db) db.close();
  }
}

function argument(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function main(args = process.argv.slice(2)) {
  const raw = argument(args, '--event') || (args.includes('--stdin') ? require('node:fs').readFileSync(0, 'utf8') : '');
  if (!raw) throw new Error('usage: emit.js (--event JSON | --stdin) [--db PATH]');
  const dbFile = argument(args, '--db');
  const event = emitEvent(JSON.parse(raw), dbFile ? { dbFile } : {});
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`ERROR ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { emitEvent, normalizeEvent, readEvents, validateEvent };
