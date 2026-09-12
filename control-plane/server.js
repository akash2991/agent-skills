'use strict';
// Local control-plane UI and JSON API. Zero dependencies (node:http), binds to loopback by
// default, and reads and writes the same SQLite database the CLI uses, so an edit here is the
// same audited mutation as `brain.js agent set`.
//
//   node brain.js serve [--port 4173] [--host 127.0.0.1]
//
// GET  /api/state                     everything the page renders
// GET  /api/quota                     provider quota via quota-axi (cached briefly)
// POST /api/agents/<id>               { model?, effort?, status?, ticket?, operation?, blocker?, reason? }
// POST /api/budget/allocate           { holder, granted_by, input_tokens, output_tokens, scope?, reason?, force? }
// POST /api/budget/decide             { id, status, input_tokens?, output_tokens?, reason? }
// POST /api/config                    { key, value, reason? }
// POST /api/agents/<id>/control       { action: focus|steer|interrupt|stop, text?, confirm? }  (Herdr)
// POST /api/sessions/<id>/release     {}
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const database = require('./db');
const state = require('./state');
const quota = require('./quota');
const control = require('./control');

const AGENT_FIELDS = { model: 'model', effort: 'effort', status: 'status', ticket: 'ticket', operation: 'current_operation', blocker: 'blocker', owned_paths: 'owned_paths' };
const AGENT_STATUS = new Set(['PLANNED', 'RUNNING', 'WAITING', 'BLOCKED', 'COMPLETED', 'FAILED', 'UNKNOWN']);
const REQUEST_STATUS = new Set(['PENDING', 'GRANTED', 'PARTIAL', 'DENIED', 'ESCALATED']);
let quotaCache = { at: 0, value: null };

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}

function snapshot(db) {
  const s = state.statusData(db);
  const cfg = database.config(db);
  const totals = db.prepare(`SELECT COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens,
                                    SUM(cost_usd) cost_usd, COUNT(*) usage_events FROM events WHERE type='model.completed'`).get();
  const byModel = db.prepare(`SELECT COALESCE(model,'UNKNOWN') model, COUNT(*) calls,
                                     COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens, SUM(cost_usd) cost_usd
                              FROM events WHERE type='model.completed' GROUP BY 1 ORDER BY input_tokens DESC`).all();
  const artifacts = db.prepare(`SELECT artifact_kind kind, artifact_name name, COUNT(*) loads, COALESCE(SUM(artifact_tokens),0) tokens
                                FROM events WHERE type IN ('skill.loaded','document.loaded') AND artifact_name IS NOT NULL
                                GROUP BY 1,2 ORDER BY tokens DESC LIMIT 25`).all();
  const tools = db.prepare(`SELECT tool_name name, tool_outcome outcome, COUNT(*) n FROM events WHERE type='tool.completed' GROUP BY 1,2 ORDER BY n DESC LIMIT 25`).all();
  return { ...s, config: cfg, totals, by_model: byModel, artifacts, tools,
    changes: db.prepare('SELECT * FROM changes ORDER BY id DESC LIMIT 40').all() };
}

function serve({ port = 4173, host = '127.0.0.1', dbFile } = {}) {
  const page = fs.readFileSync(path.join(__dirname, 'ui.html'));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = database.open(dbFile);
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': page.length });
        return res.end(page);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, snapshot(db));
      if (req.method === 'GET' && url.pathname === '/api/quota') {
        if (Date.now() - quotaCache.at > 60000) quotaCache = { at: Date.now(), value: quota.read({}) };
        return json(res, 200, quotaCache.value);
      }
      const actor = url.searchParams.get('actor') || 'ui';
      if (req.method === 'POST' && url.pathname.startsWith('/api/agents/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/agents/'.length));
        const row = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(id);
        if (!row) return json(res, 404, { error: `unknown agent ${id}` });
        const body = await readBody(req);
        const applied = [];
        for (const [name, column] of Object.entries(AGENT_FIELDS)) {
          if (body[name] === undefined || body[name] === null || body[name] === row[column]) continue;
          if (column === 'status' && !AGENT_STATUS.has(body[name])) return json(res, 400, { error: `bad status ${body[name]}` });
          db.prepare(`UPDATE agents SET ${column} = ? WHERE agent_id = ?`).run(String(body[name]), id);
          database.record(db, actor, 'agent', id, column, row[column], String(body[name]), body.reason || 'changed from the control-plane UI');
          applied.push(column);
        }
        return json(res, 200, { ok: true, applied, agent: db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(id) });
      }
      if (req.method === 'POST' && url.pathname === '/api/budget/allocate') {
        const body = await readBody(req);
        if (!body.holder || !body.granted_by) return json(res, 400, { error: 'holder and granted_by are required' });
        const parent = state.budgetRows(db).find(r => r.holder === body.granted_by);
        if (parent && !body.force) {
          const siblings = db.prepare('SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM budget_allocations WHERE granted_by = ? AND holder != ?').get(body.granted_by, body.holder);
          const overIn = parent.allocated.input_tokens !== 'UNKNOWN' && siblings.i + Number(body.input_tokens || 0) > parent.allocated.input_tokens;
          const overOut = parent.allocated.output_tokens !== 'UNKNOWN' && siblings.o + Number(body.output_tokens || 0) > parent.allocated.output_tokens;
          if (overIn || overOut) return json(res, 409, { error: `${body.granted_by} would allocate more than it holds`, parent: parent.allocated, siblings });
        }
        const before = db.prepare('SELECT * FROM budget_allocations WHERE holder = ?').get(body.holder);
        db.prepare(`INSERT INTO budget_allocations(holder, granted_by, input_tokens, output_tokens, cost_usd, scope, granted_at, note)
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(holder) DO UPDATE SET granted_by=excluded.granted_by, input_tokens=excluded.input_tokens,
                      output_tokens=excluded.output_tokens, cost_usd=excluded.cost_usd, scope=excluded.scope, granted_at=excluded.granted_at`)
          .run(body.holder, body.granted_by, body.input_tokens ?? null, body.output_tokens ?? null, body.cost_usd ?? null, body.scope ?? null, new Date().toISOString(), body.note ?? null);
        database.record(db, actor, 'budget', body.holder, 'allocation', before ? `${before.input_tokens}/${before.output_tokens}` : null, `${body.input_tokens}/${body.output_tokens}`, body.reason || 'changed from the control-plane UI');
        return json(res, 200, { ok: true, budgets: state.budgetRows(db) });
      }
      if (req.method === 'POST' && url.pathname === '/api/budget/decide') {
        const body = await readBody(req);
        if (!body.id || !REQUEST_STATUS.has(body.status)) return json(res, 400, { error: 'id and a valid status are required' });
        const req_ = db.prepare('SELECT * FROM budget_requests WHERE id = ?').get(body.id);
        if (!req_) return json(res, 404, { error: `unknown request ${body.id}` });
        db.prepare('UPDATE budget_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(body.status, actor, new Date().toISOString(), body.id);
        database.record(db, actor, 'budget_request', body.id, 'status', req_.status, body.status, body.reason || 'decided in the control-plane UI');
        if (body.status === 'GRANTED' || body.status === 'PARTIAL') {
          const current = db.prepare('SELECT * FROM budget_allocations WHERE holder = ?').get(req_.from_holder);
          const addIn = Number(body.input_tokens ?? req_.input_tokens ?? 0), addOut = Number(body.output_tokens ?? req_.output_tokens ?? 0);
          if (current) db.prepare('UPDATE budget_allocations SET input_tokens = ?, output_tokens = ?, granted_at = ? WHERE holder = ?')
            .run((current.input_tokens || 0) + addIn, (current.output_tokens || 0) + addOut, new Date().toISOString(), req_.from_holder);
          else db.prepare('INSERT INTO budget_allocations(holder, granted_by, input_tokens, output_tokens, granted_at) VALUES(?, ?, ?, ?, ?)')
            .run(req_.from_holder, req_.to_holder, addIn, addOut, new Date().toISOString());
        }
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/config') {
        const body = await readBody(req);
        if (!body.key) return json(res, 400, { error: 'key is required' });
        database.setConfig(db, body.key, body.value, actor, body.reason || 'changed from the control-plane UI');
        return json(res, 200, { ok: true, config: database.config(db) });
      }
      if (req.method === 'POST' && /^\/api\/agents\/.+\/control$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(id);
        if (!agent) return json(res, 404, { error: `unknown agent ${id}` });
        const body = await readBody(req);
        try {
          const result = control.controlAgent(agent, { action: body.action, text: body.text, confirm: body.confirm });
          database.record(db, actor, 'agent', id, `control:${body.action}`, null, body.text || 'ok', body.reason || 'from the control-plane UI');
          return json(res, 200, { ok: true, result });
        } catch (error) { return json(res, 409, { error: error.message }); }
      }
      if (req.method === 'POST' && /^\/api\/sessions\/.+\/release$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        const changed = db.prepare('UPDATE sessions SET released_at = ? WHERE id = ? AND released_at IS NULL').run(new Date().toISOString(), id);
        if (changed.changes) database.record(db, actor, 'session', id, 'released_at', null, new Date().toISOString(), 'released from the control-plane UI');
        return json(res, changed.changes ? 200 : 404, { ok: Boolean(changed.changes) });
      }
      return json(res, 404, { error: 'not found' });
    } catch (error) {
      return json(res, 500, { error: error.message });
    } finally {
      db.close();
    }
  });
  server.listen(port, host, () => process.stdout.write(`control plane UI http://${host}:${port}  (db ${database.open(dbFile).file})\n`));
  return server;
}

module.exports = { serve, snapshot };
