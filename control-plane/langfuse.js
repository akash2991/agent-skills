'use strict';
// Export control-plane events to Langfuse (https://langfuse.com) as OTLP/HTTP spans.
//
// Why this instead of the Langfuse SDK: an injected repository must run the control plane with
// nothing installed, so there is no dependency to add. Langfuse accepts OTLP over HTTP with a JSON
// body, which Node's built-in fetch can post directly. The SDK is the better choice in an
// application that already has a package manager; here it would break the zero-install guarantee.
//
// Shape sent to Langfuse (https://langfuse.com/integrations/native/opentelemetry):
//   one trace per agent      → root span, langfuse.observation.type=agent
//   model.completed          → child span, type=generation, with model, usage and cost
//   tool.completed           → child span, type=tool
//   turn.completed           → child span, type=span
//   everything else          → child span, type=event
// The organization's parent/child tree is reproduced with OTLP parentSpanId, so Langfuse renders the
// CEO → PM → EM → engineer hierarchy as its agent graph.
//
// Privacy: events are metadata only by contract, and this exporter can only read those columns. No
// prompt, response, reasoning, file content, tool argument, or tool result is representable here.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const OTEL_PATH = '/api/public/otel/v1/traces';

// OTLP wants a 16-byte trace id and an 8-byte span id as hex. Deriving them from stable strings
// keeps an export idempotent: re-exporting the same event overwrites the same span instead of
// duplicating it, and a child always resolves to its parent's id without a lookup table.
const hex = (s, bytes) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, bytes * 2);
const traceIdFor = agentId => hex(`agent-brain:trace:${agentId}`, 16);
const spanIdFor = key => hex(`agent-brain:span:${key}`, 8);

const nano = iso => {
  const ms = Date.parse(iso);
  return String((Number.isNaN(ms) ? Date.now() : ms) * 1e6);
};

const attr = (key, value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isInteger(value)
    ? { key, value: { intValue: String(value) } }
    : { key, value: { doubleValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return { key, value: { stringValue: String(value) } };
};
const attrs = pairs => pairs.map(([k, v]) => attr(k, v)).filter(Boolean);

// Read credentials from the environment, falling back to a .env file in the repository. Node does
// not load .env on its own, and asking a user to export three variables before every command is the
// kind of friction that stops a tool being used.
function credentials(envFile) {
  const env = { ...process.env };
  const file = envFile || path.join(process.cwd(), '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, key, raw] = m;
      if (env[key]) continue; // a real environment variable always wins over the file
      env[key] = raw.trim().replace(/^['"]|['"]$/g, '');
    }
  }
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  const baseUrl = (env.LANGFUSE_BASE_URL || env.LANGFUSE_HOST || 'https://cloud.langfuse.com').replace(/\/+$/, '');
  const missing = [!publicKey && 'LANGFUSE_PUBLIC_KEY', !secretKey && 'LANGFUSE_SECRET_KEY'].filter(Boolean);
  return { publicKey, secretKey, baseUrl, missing, environment: env.LANGFUSE_TRACING_ENVIRONMENT || 'default' };
}

// One Langfuse observation type per event type. Sending the most specific type is what makes the
// agent graph and the per-model analytics work; a generic span would render but tell you less.
const OBSERVATION_TYPE = {
  'model.completed': 'generation',
  'tool.completed': 'tool',
  'turn.completed': 'span',
  'skill.loaded': 'event',
  'document.loaded': 'event',
  'budget.changed': 'event',
  'agent.status_changed': 'event',
  'agent.started': 'event',
  'agent.completed': 'event',
  'control.completed': 'event',
};

// Names are an API: evaluators, dashboards and saved views target them, so they must be stable and
// low-cardinality. Never the model (every model swap would break them) and never a run-specific
// value like a turn number or an agent id; those go to metadata.
const SPAN_NAME = {
  'model.completed': 'generate-response',
  'tool.completed': 'call-tool',
  'turn.completed': 'run-turn',
  'skill.loaded': 'load-skill',
  'document.loaded': 'load-document',
  'budget.changed': 'change-budget',
  'agent.status_changed': 'change-status',
  'agent.started': 'start-agent',
  'agent.completed': 'complete-agent',
  'control.completed': 'control-agent',
};
function spanName(e) {
  // A tool name is stable and low-cardinality, so it earns a place in the name; everything else
  // that varies per run stays in metadata.
  if (e.type === 'tool.completed' && e.tool_name) return `call-tool: ${e.tool_name}`;
  return SPAN_NAME[e.type] || e.type;
}

// Langfuse derives trace input and output from the root observation, and an observation with
// neither is hard to read in the tracing table. The event contract forbids content, so what goes
// here is the assignment and the result: identifiers, status, and counts, never text the agent
// read or wrote.
function agentIO(agent) {
  const input = {
    role: agent.role,
    agent_id: agent.agent_id,
    ticket: agent.ticket || null,
    assigned_by: agent.parent || null,
    owned_paths: agent.owned_paths || null,
  };
  const output = {
    status: agent.status,
    operation: agent.current_operation || null,
    blocker: agent.blocker || null,
    model: agent.model || 'UNKNOWN',
    effort: agent.effort || 'UNKNOWN',
  };
  return { input: JSON.stringify(input), output: JSON.stringify(output) };
}

// Per-observation input/output, still metadata only: what the step was asked to do and how it ended.
function eventIO(e) {
  if (e.type === 'model.completed') return {
    input: JSON.stringify({ context_input_tokens: e.context_input_tokens ?? null, measurement: e.context_measurement || 'unknown' }),
    output: JSON.stringify({ output_tokens: e.output_tokens ?? null, thinking_tokens: e.thinking_tokens ?? null, source: e.usage_source || 'unknown' }),
  };
  if (e.type === 'tool.completed') return {
    input: JSON.stringify({ tool: e.tool_name || 'UNKNOWN' }),
    output: JSON.stringify({ outcome: e.tool_outcome || 'UNKNOWN', duration_ms: e.duration_ms ?? null, error_type: e.error_type || null }),
  };
  if (e.type === 'turn.completed') return {
    input: JSON.stringify({ turn: e.turn_number ?? null }),
    output: JSON.stringify({ outcome: e.turn_outcome || 'UNKNOWN' }),
  };
  if (e.type === 'budget.changed') return {
    input: JSON.stringify({ action: e.budget_action, holder: e.budget_holder, granted_by: e.budget_granted_by, request: e.budget_request_id }),
    output: JSON.stringify({ input_tokens: e.input_tokens ?? null, output_tokens: e.output_tokens ?? null }),
  };
  if (e.type === 'skill.loaded' || e.type === 'document.loaded') return {
    input: JSON.stringify({ kind: e.artifact_kind, name: e.artifact_name, path: e.artifact_path }),
    output: JSON.stringify({ tokens: e.artifact_tokens ?? null, bytes: e.artifact_bytes ?? null, measurement: e.artifact_measurement || 'unknown' }),
  };
  return {
    input: JSON.stringify({ event: e.type }),
    output: JSON.stringify({ status: e.status || null, outcome: e.control_outcome || null }),
  };
}

// Every span carries the trace-level attributes. Langfuse aggregates across observations rather
// than only the root, so an attribute set once on the root is not filterable on the children.
function traceLevel(agent, environment) {
  return [
    ['langfuse.trace.name', `${agent.role} ${agent.agent_id}`],
    ['langfuse.session.id', agent.session_id || agent.agent_id],
    ['langfuse.user.id', agent.role],
    ['langfuse.environment', environment],
    ['langfuse.trace.metadata.role', agent.role],
    ['langfuse.trace.metadata.agent_id', agent.agent_id],
    ['langfuse.trace.metadata.parent', agent.parent || 'none'],
    ['langfuse.trace.metadata.harness', agent.harness],
    ['langfuse.trace.metadata.ticket', agent.ticket],
    ['langfuse.trace.metadata.status', agent.status],
  ];
}

function rootSpan(agent, environment) {
  const started = agent.started_at || new Date().toISOString();
  const ended = agent.status === 'CLOSED' ? (agent.last_heartbeat || started) : (agent.last_heartbeat || started);
  return {
    traceId: traceIdFor(agent.agent_id),
    spanId: spanIdFor(`agent:${agent.agent_id}`),
    // An agent reports to its parent, so its span nests under the parent's root span. This is what
    // draws the organization chart in Langfuse rather than a flat list of traces.
    ...(agent.parent && agent.parent !== 'user' ? { parentSpanId: spanIdFor(`agent:${agent.parent}`) } : {}),
    // The role is the stable, low-cardinality identity of this run. The agent id varies per run and
    // belongs in metadata, where it stays filterable without breaking every saved view.
    name: agent.role,
    kind: 1,
    startTimeUnixNano: nano(started),
    endTimeUnixNano: nano(ended),
    attributes: attrs([
      ['langfuse.observation.type', 'agent'],
      ['langfuse.observation.input', agentIO(agent).input],
      ['langfuse.observation.output', agentIO(agent).output],
      ['langfuse.observation.metadata.model', agent.model],
      ['langfuse.observation.metadata.effort', agent.effort],
      ['langfuse.observation.metadata.owned_paths', agent.owned_paths],
      ['langfuse.observation.metadata.blocker', agent.blocker],
      ...traceLevel(agent, environment),
    ]),
  };
}

function eventSpan(e, agent, environment) {
  const type = OBSERVATION_TYPE[e.type] || 'span';
  const start = e.timestamp || new Date().toISOString();
  const endMs = Date.parse(start) + (e.duration_ms || 0);
  const usage = {
    ...(e.input_tokens === null || e.input_tokens === undefined ? {} : { input: e.input_tokens }),
    ...(e.output_tokens === null || e.output_tokens === undefined ? {} : { output: e.output_tokens }),
    ...(e.cache_read_tokens ? { cache_read_input_tokens: e.cache_read_tokens } : {}),
    ...(e.cache_write_tokens ? { cache_creation_input_tokens: e.cache_write_tokens } : {}),
    ...(e.thinking_tokens ? { reasoning: e.thinking_tokens } : {}),
  };
  return {
    traceId: traceIdFor(e.agent_id),
    spanId: spanIdFor(`event:${e.event_id}`),
    parentSpanId: spanIdFor(`agent:${e.agent_id}`),
    name: spanName(e),
    kind: 1,
    startTimeUnixNano: nano(start),
    endTimeUnixNano: String(endMs * 1e6),
    attributes: attrs([
      ['langfuse.observation.type', type],
      ['langfuse.observation.input', eventIO(e).input],
      ['langfuse.observation.output', eventIO(e).output],
      ['langfuse.observation.metadata.turn_number', e.turn_number],
      ['langfuse.observation.metadata.thinking_tokens', e.thinking_tokens],
      ...(type === 'generation' ? [
        ['langfuse.observation.model.name', e.model],
        ...(Object.keys(usage).length ? [['langfuse.observation.usage_details', JSON.stringify(usage)]] : []),
        ...(e.cost_usd ? [['langfuse.observation.cost_details', JSON.stringify({ total: e.cost_usd })]] : []),
        ...(e.effort ? [['langfuse.observation.model.parameters', JSON.stringify({ effort: e.effort })]] : []),
      ] : []),
      ['langfuse.observation.level', e.error_type ? 'ERROR' : 'DEFAULT'],
      ['langfuse.observation.status_message', e.error_type],
      ['langfuse.observation.metadata.event_type', e.type],
      ['langfuse.observation.metadata.event_id', e.event_id],
      ['langfuse.observation.metadata.usage_source', e.usage_source],
      ['langfuse.observation.metadata.context_input_tokens', e.context_input_tokens],
      ['langfuse.observation.metadata.context_measurement', e.context_measurement],
      ['langfuse.observation.metadata.tool_outcome', e.tool_outcome],
      ['langfuse.observation.metadata.turn_outcome', e.turn_outcome],
      ['langfuse.observation.metadata.artifact_path', e.artifact_path],
      ['langfuse.observation.metadata.artifact_tokens', e.artifact_tokens],
      ['langfuse.observation.metadata.budget_action', e.budget_action],
      ['langfuse.observation.metadata.budget_holder', e.budget_holder],
      ['langfuse.observation.metadata.status', e.status],
      ...(agent ? traceLevel(agent, environment) : []),
    ]),
  };
}

// Which events still need sending. The marker is a row in `exports`, so an interrupted run resumes
// and a repeated run sends nothing: the same reason event ids are deterministic in the first place.
function pending(db, { limit = 500, all = false } = {}) {
  const where = all ? '' : 'WHERE e.event_id NOT IN (SELECT event_id FROM exports WHERE backend = \'langfuse\')';
  return db.prepare(`SELECT e.* FROM events e ${where} ORDER BY e.timestamp LIMIT ?`).all(limit);
}

// Every agent whose events are in this batch, plus its ancestors. Without the ancestors a child's
// parentSpanId points at a span that was never sent, and the tree renders flat.
function agentsWithAncestors(db, ids) {
  const byId = new Map();
  const queue = [...ids];
  const get = db.prepare('SELECT * FROM agents WHERE agent_id = ?');
  while (queue.length) {
    const id = queue.shift();
    if (!id || id === 'user' || byId.has(id)) continue;
    const row = get.get(id);
    if (!row) continue;
    byId.set(id, row);
    if (row.parent) queue.push(row.parent);
  }
  return byId;
}

function buildPayload(db, events, environment) {
  const agentIds = [...new Set(events.map(e => e.agent_id).filter(Boolean))];
  const byId = agentsWithAncestors(db, agentIds);
  const agents = [...byId.values()];
  const spans = [];
  for (const a of agents) spans.push(rootSpan(a, environment));
  for (const e of events) spans.push(eventSpan(e, byId.get(e.agent_id), environment));
  return {
    resourceSpans: [{
      resource: { attributes: attrs([['service.name', 'agent-brain'], ['deployment.environment.name', environment]]) },
      scopeSpans: [{ scope: { name: 'agent-brain.control-plane' }, spans }],
    }],
  };
}

async function send(db, { limit = 500, all = false, dryRun = false, envFile, fetchImpl = globalThis.fetch } = {}) {
  const cred = credentials(envFile);
  if (cred.missing.length) return { ok: false, reason: 'missing_credentials', missing: cred.missing, baseUrl: cred.baseUrl };
  const events = pending(db, { limit, all });
  if (!events.length) return { ok: true, sent: 0, spans: 0, baseUrl: cred.baseUrl, note: 'nothing new to export' };
  const body = buildPayload(db, events, cred.environment);
  const spans = body.resourceSpans[0].scopeSpans[0].spans.length;
  if (dryRun) return { ok: true, sent: 0, spans, events: events.length, baseUrl: cred.baseUrl, dryRun: true };

  const auth = Buffer.from(`${cred.publicKey}:${cred.secretKey}`).toString('base64');
  const res = await fetchImpl(`${cred.baseUrl}${OTEL_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
      // Without this header, directly ingested OTLP data can lag by up to ten minutes.
      'x-langfuse-ingestion-version': '4',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) return { ok: false, reason: 'http_error', status: res.status, body: text.slice(0, 400), baseUrl: cred.baseUrl };

  const at = new Date().toISOString();
  const mark = db.prepare('INSERT OR REPLACE INTO exports(event_id, backend, exported_at) VALUES(?, ?, ?)');
  for (const e of events) mark.run(e.event_id, 'langfuse', at);
  return { ok: true, sent: events.length, spans, baseUrl: cred.baseUrl, status: res.status };
}

module.exports = { send, buildPayload, pending, credentials, traceIdFor, spanIdFor };
