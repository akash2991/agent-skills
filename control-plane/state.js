'use strict';
// Read side of the control plane: the agent tree, path conflicts, budget roll-up, and the combined
// status object. Both the CLI (brain.js) and the UI server (server.js) depend on this module, and it
// depends on neither of them, so there is no require cycle.
const database = require('./db');

const UNKNOWN = 'UNKNOWN';
const now = () => new Date().toISOString();

function agents(db) {
  return db.prepare('SELECT * FROM agents ORDER BY started_at').all().map(a => ({
    ...a, heartbeat_age_minutes: database.minutesSince(a.last_heartbeat),
    spend: database.spend(db, a.agent_id)
  }));
}

function tree(db) {
  const rows = agents(db);
  const byId = new Map(rows.map(r => [r.agent_id, { ...r, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parent && byId.get(node.parent);
    if (parent) parent.children.push(node); else roots.push(node);
  }
  return roots;
}

function renderTree(roots, depth = 0) {
  const lines = [];
  for (const node of roots) {
    const pad = '  '.repeat(depth);
    lines.push(`${pad}- ${node.agent_id} [${node.status}] ${node.role} ticket=${node.ticket || '-'} ${node.model || UNKNOWN}/${node.effort || UNKNOWN} hb=${node.heartbeat_age_minutes ?? '?'}min`);
    lines.push(`${pad}  spend ${node.spend.input_tokens}in/${node.spend.output_tokens}out subtree agents=${node.spend.agents}${node.blocker ? ` blocker=${node.blocker}` : ''}`);
    if (node.children.length) lines.push(renderTree(node.children, depth + 1));
  }
  return lines.join('\n');
}

function pathConflicts(db) {
  const owners = new Map();
  for (const a of db.prepare("SELECT agent_id, owned_paths FROM agents WHERE status = 'RUNNING' AND owned_paths IS NOT NULL").all()) {
    for (const p of a.owned_paths.split(/[,;]\s*/).filter(Boolean)) {
      if (!owners.has(p)) owners.set(p, []);
      owners.get(p).push(a.agent_id);
    }
  }
  return [...owners.entries()].filter(([, list]) => list.length > 1).map(([p, list]) => ({ path: p, agents: list }));
}

// ─── budgets ─────────────────────────────────────────────────────────────────
// Allocations form a chain: user → ceo → PMs/EMs → agents. Spend rolls up the agents.parent tree.
function budgetRows(db) {
  const cfg = database.config(db);
  const warnAt = Number(cfg.warn_at_percent || 80);
  return db.prepare('SELECT * FROM budget_allocations ORDER BY granted_at').all().map(a => {
    const spent = database.spend(db, a.holder);
    const pct = (used, alloc) => (alloc ? Math.round((used / alloc) * 100) : null);
    const pctIn = pct(spent.input_tokens, a.input_tokens);
    const pctOut = pct(spent.output_tokens, a.output_tokens);
    const worst = Math.max(pctIn ?? -1, pctOut ?? -1);
    const children = db.prepare('SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM budget_allocations WHERE granted_by = ?').get(a.holder);
    return {
      holder: a.holder, granted_by: a.granted_by, scope: a.scope,
      role: (db.prepare('SELECT role FROM agents WHERE agent_id = ?').get(a.holder) || {}).role || '',
      allocated: { input_tokens: a.input_tokens ?? UNKNOWN, output_tokens: a.output_tokens ?? UNKNOWN, cost_usd: a.cost_usd ?? UNKNOWN },
      spent: { input_tokens: spent.input_tokens, output_tokens: spent.output_tokens, cost_usd: spent.cost_usd ?? UNKNOWN,
        usage_events: spent.usage_events, agents: spent.agents, input_basis: spent.input_basis,
        fresh_input_tokens: spent.fresh_input_tokens, cache_write_tokens: spent.cache_write_tokens, cache_read_tokens: spent.cache_read_tokens },
      remaining: { input_tokens: a.input_tokens === null ? UNKNOWN : a.input_tokens - spent.input_tokens, output_tokens: a.output_tokens === null ? UNKNOWN : a.output_tokens - spent.output_tokens },
      percent: { input: pctIn ?? UNKNOWN, output: pctOut ?? UNKNOWN },
      status: spent.usage_events === 0 ? 'NO_USAGE_RECORDED' : worst >= 100 ? 'EXHAUSTED' : worst >= warnAt ? 'WARN' : 'OK',
      over_allocated: (a.input_tokens !== null && children.i > a.input_tokens) || (a.output_tokens !== null && children.o > a.output_tokens),
      child_allocated: { input_tokens: children.i, output_tokens: children.o }
    };
  });
}

// The nearest allocation covering an agent: itself, else the closest budgeted ancestor.
function budgetFor(db, agentId) {
  const rows = budgetRows(db);
  const byHolder = new Map(rows.map(r => [r.holder, r]));
  let cursor = agentId;
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    if (byHolder.has(cursor)) return byHolder.get(cursor);
    const row = db.prepare('SELECT parent FROM agents WHERE agent_id = ?').get(cursor);
    cursor = row ? row.parent : null;
  }
  return null;
}

function statusData(db) {
  const rows = agents(db);
  const cfg = database.config(db);
  const staleAfter = Number(cfg.agent_stale_minutes || 20);
  const running = rows.filter(a => a.status === 'RUNNING');
  return {
    checked_at: now(), db: db.file,
    sessions: db.prepare('SELECT * FROM sessions WHERE released_at IS NULL').all().map(s => ({ ...s, heartbeat_age_minutes: database.minutesSince(s.last_heartbeat) })),
    counts: rows.reduce((acc, a) => ({ ...acc, [a.status]: (acc[a.status] || 0) + 1 }), {}),
    tree: tree(db),
    running, blocked: rows.filter(a => a.status === 'BLOCKED'), waiting: rows.filter(a => a.status === 'WAITING'),
    stale: running.filter(a => a.heartbeat_age_minutes === null || a.heartbeat_age_minutes > staleAfter),
    path_conflicts: pathConflicts(db),
    budgets: budgetRows(db),
    open_budget_requests: db.prepare("SELECT * FROM budget_requests WHERE status IN ('PENDING','ESCALATED')").all(),
    recent_changes: db.prepare('SELECT * FROM changes ORDER BY id DESC LIMIT 10').all(),
    event_counts: Object.fromEntries(db.prepare('SELECT type, COUNT(*) n FROM events GROUP BY type').all().map(r => [r.type, r.n]))
  };
}

function renderStatus(s) {
  const lines = [`control plane ${s.db} at ${s.checked_at}`,
    `sessions live: ${s.sessions.map(x => `${x.role}=${x.id}(${x.harness},hb ${x.heartbeat_age_minutes ?? '?'}min)`).join(' ') || 'none'}`,
    `agents: ${Object.entries(s.counts).map(([k, v]) => `${k}:${v}`).join(' ') || 'none'}`, ''];
  if (s.tree.length) lines.push(renderTree(s.tree), '');
  if (s.blocked.length) lines.push('BLOCKED', ...s.blocked.map(a => `  ${a.agent_id} ticket=${a.ticket || '-'} blocker=${a.blocker || '(none recorded!)'}`), '');
  if (s.stale.length) lines.push('STALE (heartbeat older than agent_stale_minutes)', ...s.stale.map(a => `  ${a.agent_id} hb=${a.heartbeat_age_minutes ?? '?'}min`), '');
  if (s.path_conflicts.length) lines.push('PATH CONFLICTS', ...s.path_conflicts.map(c => `  ${c.path} ← ${c.agents.join(', ')}`), '');
  const attention = s.budgets.filter(b => b.status === 'WARN' || b.status === 'EXHAUSTED' || b.over_allocated);
  if (attention.length) lines.push('BUDGET ATTENTION', ...attention.map(b => `  ${b.holder} ${b.status}${b.over_allocated ? ' OVER-ALLOCATED' : ''} ${b.percent.input}%in ${b.percent.output}%out`), '');
  if (s.open_budget_requests.length) lines.push('OPEN BUDGET ASKS', ...s.open_budget_requests.map(r => `  ${r.id} ${r.from_holder} → ${r.to_holder} [${r.status}]`), '');
  if (!Object.keys(s.event_counts).length) lines.push('No observability events recorded yet: token, cost, and context figures are UNKNOWN until agents emit them.');
  return lines.join('\n');
}

module.exports = { now, agents, tree, renderTree, pathConflicts, budgetRows, budgetFor, statusData, renderStatus, UNKNOWN };
