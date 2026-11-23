#!/usr/bin/env node
'use strict';

// The orchestrator's mechanics: the session record, the one-orchestrator lock,
// and launching, resuming, messaging, and closing worker agents in Herdr tabs.
// The orchestrator agent makes the judgment (which session a request belongs
// to); this script does everything that can be exact. See ../SKILL.md.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const store = require('./store.js');

const CLI = __filename;
const PI_EXTENSION = path.join(__dirname, 'pi-extension.js');
const DEFAULT_HARNESS = 'claude';
const DEFAULTS = {
  claude: { model: 'claude-opus-5-5', effort: 'medium' },
  pi: { model: null, effort: 'medium' },
};
// Harnesses whose sessions can be named at launch, resumed by id, and recorded
// by a hook. Any other Herdr agent kind can be launched, untracked.
const TRACKED = new Set(['claude', 'pi']);
const SETTLED = new Set(['idle', 'done', 'blocked']);
const EXIT = { error: 1, usage: 2, lock: 3 };

class CliError extends Error {
  constructor(message, code = EXIT.error) { super(message); this.exitCode = code; }
}
const usageError = message => new CliError(message, EXIT.usage);

// ─── Arguments ────────────────────────────────────────────────────────────────

function parseArgs(argv, booleans = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2);
    if (booleans.includes(key)) { out[key] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || (value.startsWith('--') && value !== '--')) throw usageError(`missing value for ${arg}`);
    out[key] = value === '-' ? fs.readFileSync(0, 'utf8').trim() : value;
    i++;
  }
  return out;
}

function required(opts, key) {
  const value = opts[key];
  if (typeof value !== 'string' || !value.trim()) throw usageError(`--${key} is required`);
  return value.trim();
}

function sessionArg(opts, { fromEnv = false } = {}) {
  const raw = opts._[0] || opts.session || (fromEnv ? process.env.ORCHESTRATOR_SESSION : undefined);
  const match = /^S?(\d+)$/i.exec(String(raw || ''));
  if (!match) throw usageError('a session id is required, such as S12');
  return Number(match[1]);
}

// ─── Paths ────────────────────────────────────────────────────────────────────

function projectRoot(cwd = process.cwd()) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.dirname(common);
  } catch {
    return cwd;
  }
}

function dbPath(opts = {}) {
  return path.resolve(opts.db || process.env.ORCHESTRATOR_DB || path.join(projectRoot(), '.agent-brain', 'orchestrator.db'));
}

const lockPath = db => path.join(path.dirname(db), 'orchestrator.lock');

// Keep the record out of git without editing the project's .gitignore.
function excludeFromGit(root, db) {
  const rel = path.relative(root, path.dirname(db));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  let exclude;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    exclude = path.join(common, 'info', 'exclude');
  } catch {
    return;
  }
  const pattern = `/${rel ? `${rel.split(path.sep).join('/')}/` : ''}orchestrator.*`;
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (current.split(/\r?\n/).includes(pattern)) return;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`);
}

// ─── Herdr ────────────────────────────────────────────────────────────────────

function herdr(args) {
  const bin = process.env.ORCHESTRATOR_HERDR || 'herdr';
  let out;
  try {
    out = execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 330000 });
  } catch (err) {
    const detail = String(err.stdout || '').trim() || String(err.stderr || '').trim() || err.message;
    let parsed;
    try { parsed = JSON.parse(detail); } catch { /* not JSON */ }
    const failure = new CliError(`herdr ${args.slice(0, 2).join(' ')} failed: ${parsed && parsed.error ? parsed.error.message : detail}`);
    failure.herdrCode = parsed && parsed.error ? parsed.error.code : 'failed';
    throw failure;
  }
  let json;
  try { json = JSON.parse(out); } catch { return { text: out }; }
  if (json && json.error) {
    const failure = new CliError(`herdr ${args.slice(0, 2).join(' ')}: ${json.error.message}`);
    failure.herdrCode = json.error.code;
    throw failure;
  }
  return json && json.result !== undefined ? json.result : json;
}

function requireHerdr() {
  if (process.env.HERDR_ENV !== '1' || !process.env.HERDR_PANE_ID || !process.env.HERDR_WORKSPACE_ID) {
    throw new CliError('not inside Herdr (HERDR_ENV=1 with a pane and workspace); the orchestrator launches workers as Herdr tabs');
  }
}

function paneInfo(paneId) {
  if (!paneId) return null;
  try {
    const result = herdr(['pane', 'get', paneId]);
    return result.pane || null;
  } catch (err) {
    if (err.herdrCode === 'pane_not_found') return null;
    throw err;
  }
}

function liveAgents() {
  try {
    const result = herdr(['agent', 'list']);
    return Array.isArray(result.agents) ? result.agents : [];
  } catch {
    return null;
  }
}

// Herdr reports Claude's session as its id and Pi's as the session file path,
// whose name ends with the id; either names the same session.
const sameId = (reported, id) => !!reported && !!id && String(reported).toLowerCase().includes(String(id).toLowerCase());

// A worker is live when its pane still runs an agent on this session.
function isLive(row, pane) {
  if (!pane || !pane.agent) return false;
  const native = pane.agent_session && pane.agent_session.value;
  return !row.native_session_id || !native || sameId(native, row.native_session_id);
}

// ─── Lock: one orchestrator per project ─────────────────────────────────────

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function holderAlive(lock) {
  if (!lock || !lock.pane_id) return false;
  const pane = paneInfo(lock.pane_id);
  if (!pane || !pane.agent) return false;
  const native = pane.agent_session && pane.agent_session.value;
  return !lock.agent_session || !native || sameId(native, lock.agent_session);
}

function acquireLock(db) {
  requireHerdr();
  const file = lockPath(db);
  const me = paneInfo(process.env.HERDR_PANE_ID);
  const mySession = me && me.agent_session ? me.agent_session.value : null;
  const held = readLock(file);
  if (held && held.pane_id !== process.env.HERDR_PANE_ID && holderAlive(held)) {
    throw new CliError(`another orchestrator holds this project: pane ${held.pane_id} (tab ${held.tab_id}), since ${held.at}. ` +
      'Use that one, or close it first. This session stays read-only.', EXIT.lock);
  }
  const lock = {
    pane_id: process.env.HERDR_PANE_ID,
    tab_id: process.env.HERDR_TAB_ID || (me && me.tab_id) || null,
    workspace_id: process.env.HERDR_WORKSPACE_ID,
    agent_session: mySession,
    at: store.now(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { lock, tookOver: !!held && held.pane_id !== lock.pane_id };
}

function requireLock(db) {
  requireHerdr();
  const held = readLock(lockPath(db));
  if (!held || held.pane_id !== process.env.HERDR_PANE_ID) {
    throw new CliError(held
      ? `this pane is not the orchestrator; pane ${held.pane_id} is. Only the orchestrator launches, resumes, messages, or closes workers.`
      : 'no orchestrator is running in this project; start one with /orchestrator', EXIT.lock);
  }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'task';
const oneLine = (text, max = 160) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// `<ticket> <scope> (<persona>)` (development-setup DS2); the session id keeps the tab findable.
function tabLabel(row) {
  const scope = `S${row.id} ${slug(row.title)}`;
  return `${row.ticket ? `${row.ticket} ` : ''}${scope}${row.persona ? ` (${row.persona})` : ''}`;
}

// ─── Matching ─────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(('the and for with that this from into onto when then than have has had was were are not but you your our its ' +
  'can will should would could just also some any all fix add make please need want get use new old same similar again').split(' '));

function tokens(text) {
  return new Set((String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || []).filter(t => !STOPWORDS.has(t)));
}

function score(query, doc) {
  const q = tokens(query);
  if (!q.size) return 0;
  const d = tokens(doc);
  let hits = 0;
  for (const t of q) if (d.has(t)) hits++;
  return hits;
}

const STATUS_ORDER = { open: 0, superseded: 1, resolved: 2 };

function candidates(db, opts) {
  const agents = liveAgents();
  const byPane = new Map((agents || []).map(a => [a.pane_id, a]));
  const rows = store.listSessions(db).filter(r => opts.all || r.status === 'open');
  const scored = rows.map(row => {
    const prompts = store.recentPrompts(db, row.id, 10);
    const doc = [row.title, row.intent, row.summary, row.ticket, row.persona, ...prompts.map(p => p.text)].join(' ');
    const pane = row.pane_id ? byPane.get(row.pane_id) : null;
    const live = agents === null ? (row.pane_id ? 'unknown' : 'closed') : (isLive(row, pane) ? (pane.agent_status || 'live') : 'closed');
    return { row, prompts, live, score: opts.query ? score(opts.query, doc) : null, promptCount: store.promptCount(db, row.id) };
  });
  scored.sort((a, b) => (b.score || 0) - (a.score || 0)
    || STATUS_ORDER[a.row.status] - STATUS_ORDER[b.row.status]
    || String(b.row.last_active_at).localeCompare(String(a.row.last_active_at)));
  return scored.slice(0, Number(opts.limit || 10));
}

function describe(c) {
  const r = c.row;
  const runtime = [r.harness, r.model, r.effort].filter(Boolean).join(' ');
  const head = [`S${r.id}`, r.status, c.live === 'closed' ? 'tab closed' : `tab live (${c.live})`, runtime, r.ticket, r.persona]
    .filter(Boolean).join(' · ');
  const last = c.prompts[c.prompts.length - 1];
  const lines = [
    head,
    `  title: ${oneLine(r.title)}`,
    `  started ${ago(r.started_at)} · active ${ago(r.last_active_at)} · ${c.promptCount} prompts · compacted ${r.compactions}×` +
      `${r.last_compacted_at ? ` (last ${ago(r.last_compacted_at)})` : ''}${c.score === null ? '' : ` · match ${c.score}`}`,
    `  intent: ${oneLine(r.intent)}`,
  ];
  if (r.summary) lines.push(`  summary: ${oneLine(r.summary, 400)}`);
  if (last) lines.push(`  last prompt (${last.source}, ${ago(last.at)}): ${oneLine(last.text)}`);
  if (r.status === 'resolved') lines.push(`  resolved ${ago(r.resolved_at)}: do not resume; start new with --from S${r.id} if related`);
  if (r.status === 'superseded') lines.push('  superseded by a newer session');
  if (r.pending_prompt) lines.push(`  first prompt held: the tab is waiting for the user; then deliver S${r.id}`);
  return lines.join('\n');
}

// ─── Launching ────────────────────────────────────────────────────────────────

const shellQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

function claudeSettings() {
  const command = `${shellQuote(process.execPath)} ${shellQuote(CLI)} hook claude`;
  const entry = [{ hooks: [{ type: 'command', command, timeout: 10 }] }];
  return {
    hooks: {
      SessionStart: entry, UserPromptSubmit: entry, PreCompact: entry, Stop: entry, SessionEnd: entry,
    },
  };
}

// Herdr types the launch command into the tab's shell, whose line limit is
// 1024 bytes, so the hook settings go in a file beside the record.
function claudeSettingsFile(dbFile) {
  const file = path.join(path.dirname(dbFile), 'orchestrator.claude-settings.json');
  const content = `${JSON.stringify(claudeSettings(), null, 2)}\n`;
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) fs.writeFileSync(file, content);
  return file;
}

function harnessArgs(row, resume, { settingsFile } = {}) {
  const label = tabLabel(row);
  if (row.harness === 'claude') {
    if (!settingsFile) throw new Error('a Claude worker needs its hook settings file');
    return [
      resume ? '--resume' : '--session-id', row.native_session_id,
      '--settings', settingsFile,
      '--name', label,
      ...(row.model ? ['--model', row.model] : []),
      ...(row.effort ? ['--effort', row.effort] : []),
    ];
  }
  if (row.harness === 'pi') {
    // --session-id opens the exact session, creating it when missing.
    return [
      '--session-id', row.native_session_id,
      '-e', PI_EXTENSION,
      '--name', label,
      ...(row.model ? ['--model', row.model] : []),
      ...(row.effort ? ['--thinking', row.effort] : []),
    ];
  }
  return [];
}

function brief(row, request, { context } = {}) {
  const lines = [
    `[orchestrator S${row.id}] ${request}`,
    '',
    `The orchestrator started you as the worker for session S${row.id}: "${row.title}".`,
    'Keep its record current: run `node "$ORCHESTRATOR_CLI" report --summary "<what this session is for, what is done, what remains>"` ' +
      'when that changes and before you stop for the user. Add `--ticket <id>` once the work has a ticket, and `--resolved` when ' +
      'its ticket is Done or its PR is merged. Never close this tab yourself.',
  ];
  if (context) lines.push('', context);
  const text = lines.join('\n');
  // A multi-line prompt arrives as pasted text, and a slash command inside a
  // paste is not run. So the persona is adopted with its own one-line
  // /brain prompt, and the brief follows once that turn settles.
  if (!row.persona || !['claude', 'pi'].includes(row.harness)) return [text];
  return [`/brain ${row.persona} [orchestrator S${row.id}] Adopt this persona and declare; the brief follows in the next message.`, text];
}

// Returns the prompts not sent when one fails, so they can be held for deliver.
function sendPrompts(paneId, prompts) {
  for (let i = 0; i < prompts.length; i++) {
    const last = i === prompts.length - 1;
    try {
      herdr(['agent', 'prompt', paneId, prompts[i], ...(last ? [] : ['--wait', '--timeout', '300000'])]);
    } catch (err) {
      // A --wait that timed out still delivered its prompt; anything else did not.
      const unsent = err.herdrCode === 'timeout' ? prompts.slice(i + 1) : prompts.slice(i);
      return { unsent, error: err.message };
    }
  }
  return { unsent: [] };
}

function priorContext(db, row, heading) {
  const prompts = store.recentPrompts(db, row.id, 5);
  return [
    `${heading} S${row.id} ("${row.title}")${row.ticket ? `, ticket ${row.ticket}` : ''}:`,
    `- intent: ${oneLine(row.intent, 400)}`,
    row.summary ? `- where it stood: ${oneLine(row.summary, 800)}` : '- no summary was recorded',
    ...prompts.map(p => `- asked ${ago(p.at)}: ${oneLine(p.text, 300)}`),
    'Read the ticket, its PR, and the code for the current state before acting; this summary may be stale.',
  ].join('\n');
}

function launch(db, dbFile, row, { resume, prompts }) {
  const tab = herdr(['tab', 'create', '--workspace', process.env.HERDR_WORKSPACE_ID, '--cwd', row.cwd,
    '--label', tabLabel(row), '--no-focus',
    '--env', `ORCHESTRATOR_DB=${dbFile}`, '--env', `ORCHESTRATOR_SESSION=${row.id}`, '--env', `ORCHESTRATOR_CLI=${CLI}`]);
  const pane = tab.root_pane && tab.root_pane.pane_id;
  const tabId = (tab.tab && tab.tab.tab_id) || (tab.root_pane && tab.root_pane.tab_id);
  if (!pane || !tabId) throw new CliError(`herdr tab create returned no pane or tab id: ${JSON.stringify(tab)}`);
  const agentName = `orch-s${row.id}-${crypto.randomBytes(2).toString('hex')}`;
  const placed = { tab_id: tabId, pane_id: pane, agent_name: agentName, launches: row.launches + 1, last_active_at: store.now() };
  try {
    const args = harnessArgs(row, resume, { settingsFile: row.harness === 'claude' ? claudeSettingsFile(dbFile) : undefined });
    herdr(['agent', 'start', agentName, '--kind', row.harness, '--pane', pane, '--timeout', '120000', '--', ...args]);
  } catch (err) {
    if (err.herdrCode === 'agent_not_ready') {
      // The agent is up but asking the user something first, such as whether
      // to trust the folder. That answer is the user's, never the orchestrator's:
      // keep the tab and hold the first prompt until `deliver`.
      store.updateSession(db, row.id, { ...placed, pending_prompt: JSON.stringify(prompts) });
      store.addEvent(db, row.id, 'waiting-for-user', err.message);
      return { tab_id: tabId, pane_id: pane, label: tabLabel(row), waiting: true };
    }
    try { herdr(['tab', 'close', tabId]); } catch { /* best effort */ }
    err.startFailed = true;
    throw err;
  }
  store.updateSession(db, row.id, { ...placed, pending_prompt: null });
  store.addEvent(db, row.id, resume ? 'resumed' : 'launched', `${row.harness} pane ${pane}`);
  const sent = sendPrompts(pane, prompts);
  if (sent.unsent.length) {
    store.updateSession(db, row.id, { pending_prompt: JSON.stringify(sent.unsent) });
    store.addEvent(db, row.id, 'prompt-held', sent.error);
    return { tab_id: tabId, pane_id: pane, label: tabLabel(row), waiting: true };
  }
  return { tab_id: tabId, pane_id: pane, label: tabLabel(row) };
}

const WAITING_NOTE = 'its tab is waiting for the user (a trust or login prompt). Ask the user to answer it in that tab, then run deliver';

function relaunch(db, dbFile, row, request, why) {
  const fresh = TRACKED.has(row.harness) ? crypto.randomUUID() : null;
  store.updateSession(db, row.id, { native_session_id: fresh });
  store.addEvent(db, row.id, 'relaunched', why);
  const updated = store.getSession(db, row.id);
  return launch(db, dbFile, updated, {
    resume: false,
    prompts: brief(updated, request, { context: priorContext(db, row, 'This continues the work of the earlier conversation of session') }),
  });
}

function print(value, opts) {
  if (opts.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (typeof value === 'string') process.stdout.write(`${value}\n`);
  else process.stdout.write(`${Object.entries(value).map(([k, v]) => `${k}: ${v}`).join('\n')}\n`);
}

// ─── Reconcile ────────────────────────────────────────────────────────────────

// The record is the truth about intent; Herdr is the truth about what is
// running. Clear tabs that are gone, and adopt a tab where the user resumed a
// recorded session by hand.
function reconcile(db) {
  const agents = liveAgents();
  if (agents === null) return { closed: [], adopted: [] };
  const byPane = new Map(agents.map(a => [a.pane_id, a]));
  const closed = [];
  const adopted = [];
  for (const row of store.listSessions(db)) {
    if (row.pane_id) {
      if (!isLive(row, byPane.get(row.pane_id))) {
        store.updateSession(db, row.id, { pane_id: null, tab_id: null, agent_name: null });
        store.addEvent(db, row.id, 'tab-closed', row.pane_id);
        closed.push(`S${row.id}`);
      }
      continue;
    }
    if (!row.native_session_id) continue;
    const match = agents.find(a => a.agent_session && sameId(a.agent_session.value, row.native_session_id));
    if (match) {
      store.updateSession(db, row.id, { pane_id: match.pane_id, tab_id: match.tab_id || null });
      store.addEvent(db, row.id, 'tab-adopted', match.pane_id);
      adopted.push(`S${row.id}`);
    }
  }
  return { closed, adopted };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function withDb(opts, fn) {
  const file = dbPath(opts);
  const db = store.open(file);
  try { return fn(db, file); } finally { db.close(); }
}

function getRow(db, id) {
  const row = store.getSession(db, id);
  if (!row) throw new CliError(`no session S${id}`);
  return row;
}

const commands = {
  start(argv) {
    const opts = parseArgs(argv, ['json']);
    return withDb(opts, (db, file) => {
      excludeFromGit(projectRoot(), file);
      const { lock, tookOver } = acquireLock(file);
      const changes = reconcile(db);
      const open = store.listSessions(db).filter(r => r.status === 'open');
      const result = {
        orchestrator: `pane ${lock.pane_id}${tookOver ? ' (took over a stale lock)' : ''}`,
        record: file,
        open_sessions: open.length,
        live_tabs: open.filter(r => r.pane_id).length,
        reconciled: `${changes.closed.length} closed, ${changes.adopted.length} adopted`,
      };
      print(result, opts);
      if (!opts.json && open.length) print(`\n${candidates(db, { limit: 10 }).map(describe).join('\n\n')}`, opts);
    });
  },

  release(argv) {
    const opts = parseArgs(argv);
    const file = lockPath(dbPath(opts));
    const held = readLock(file);
    if (held && held.pane_id !== process.env.HERDR_PANE_ID) throw new CliError(`the lock belongs to pane ${held.pane_id}`, EXIT.lock);
    fs.rmSync(file, { force: true });
    print('released', opts);
  },

  find(argv) {
    const opts = parseArgs(argv, ['all', 'json']);
    return withDb(opts, db => {
      const found = candidates(db, opts);
      if (opts.json) return print(found.map(c => ({ ...c.row, live: c.live, score: c.score, prompts: c.promptCount, last_prompts: c.prompts })), opts);
      print(found.length ? found.map(describe).join('\n\n') : `no ${opts.all ? '' : 'open '}sessions`, opts);
    });
  },

  new(argv) {
    const opts = parseArgs(argv, ['json']);
    const request = required(opts, 'request');
    const title = required(opts, 'title');
    const reason = required(opts, 'reason');
    const harness = (opts.harness || DEFAULT_HARNESS).toLowerCase();
    const defaults = DEFAULTS[harness] || { model: null, effort: null };
    return withDb(opts, (db, file) => {
      requireLock(file);
      const parent = opts.from ? getRow(db, sessionArg({ _: [opts.from] })) : null;
      const id = store.createSession(db, {
        title,
        intent: (opts.intent || request).trim(),
        harness,
        model: opts.model || defaults.model,
        effort: opts.effort || defaults.effort,
        persona: opts.persona || null,
        ticket: opts.ticket || (parent && parent.ticket) || null,
        native_session_id: TRACKED.has(harness) ? crypto.randomUUID() : null,
        cwd: path.resolve(opts.cwd || projectRoot()),
        parent_id: parent ? parent.id : null,
      });
      store.addDecision(db, { request, action: 'new', sessionId: id, considered: opts.considered, reason });
      if (parent && parent.status === 'open') {
        store.updateSession(db, parent.id, { status: 'superseded' });
        store.addEvent(db, parent.id, 'superseded', `by S${id}`);
      }
      const row = store.getSession(db, id);
      const context = parent ? priorContext(db, parent, 'Related earlier session') : null;
      let launched;
      try {
        launched = launch(db, file, row, { resume: false, prompts: brief(row, request, { context }) });
      } catch (err) {
        store.addEvent(db, id, 'launch-failed', err.message);
        throw new CliError(`S${id} was recorded but its agent did not start: ${err.message}. Retry with: resume S${id}`);
      }
      print({ session: `S${id}`, action: launched.waiting ? 'waiting' : 'new', tracked: TRACKED.has(harness), ...launched,
        ...(launched.waiting ? { note: `${WAITING_NOTE} S${id}` } : {}) }, opts);
    });
  },

  resume(argv) {
    const opts = parseArgs(argv, ['json']);
    const id = sessionArg(opts);
    const request = required(opts, 'request');
    const reason = required(opts, 'reason');
    return withDb(opts, (db, file) => {
      requireLock(file);
      const row = getRow(db, id);
      if (row.status !== 'open') {
        throw new CliError(`S${id} is ${row.status}; start a new session with --from S${id} instead of resuming it`);
      }
      if (isLive(row, paneInfo(row.pane_id))) throw new CliError(`S${id} is already running in pane ${row.pane_id}; use send`);
      store.addDecision(db, { request, action: 'resume', sessionId: id, considered: opts.considered, reason });
      // The resumed conversation already holds its persona and brief, unless
      // its tab closed while they were still held for deliver.
      const prompts = [...(row.pending_prompt ? JSON.parse(row.pending_prompt) : []), `[orchestrator S${id}] ${request}`];
      let launched;
      let mode = 'resumed';
      if (!TRACKED.has(row.harness) || !row.native_session_id) {
        launched = relaunch(db, file, row, request, `${row.harness} has no resumable session id`);
        mode = 'relaunched';
      } else {
        try {
          launched = launch(db, file, row, { resume: true, prompts });
        } catch (err) {
          if (!err.startFailed) throw err;
          store.addEvent(db, id, 'resume-failed', err.message);
          launched = relaunch(db, file, store.getSession(db, id), request, `resume failed: ${err.message}`);
          mode = 'relaunched';
        }
      }
      if (launched.waiting) mode = 'waiting';
      print({ session: `S${id}`, action: mode, ...launched, ...(launched.waiting ? { note: `${WAITING_NOTE} S${id}` } : {}) }, opts);
    });
  },

  // Send the first prompt held back while the new tab waited for the user.
  deliver(argv) {
    const opts = parseArgs(argv, ['json']);
    const id = sessionArg(opts);
    return withDb(opts, (db, file) => {
      requireLock(file);
      const row = getRow(db, id);
      if (!row.pending_prompt) throw new CliError(`S${id} has no held prompt`);
      const pane = paneInfo(row.pane_id);
      if (!isLive(row, pane)) throw new CliError(`S${id}'s tab is gone; resume it`);
      if (pane.agent_status !== 'idle' && pane.agent_status !== 'done') {
        throw new CliError(`S${id} is ${pane.agent_status}; the user has not finished answering its tab yet`);
      }
      const sent = sendPrompts(row.pane_id, JSON.parse(row.pending_prompt));
      if (sent.unsent.length) {
        store.updateSession(db, id, { pending_prompt: JSON.stringify(sent.unsent) });
        throw new CliError(`S${id}: ${sent.error}; ${sent.unsent.length} prompt(s) still held, run deliver again once it settles`);
      }
      store.updateSession(db, id, { pending_prompt: null, last_active_at: store.now() });
      store.addEvent(db, id, 'delivered', row.pane_id);
      print({ session: `S${id}`, action: 'delivered', pane_id: row.pane_id }, opts);
    });
  },

  send(argv) {
    const opts = parseArgs(argv, ['json']);
    const id = sessionArg(opts);
    const request = required(opts, 'request');
    const reason = required(opts, 'reason');
    return withDb(opts, (db, file) => {
      requireLock(file);
      const row = getRow(db, id);
      if (row.status !== 'open') throw new CliError(`S${id} is ${row.status}; start a new session with --from S${id}`);
      if (!isLive(row, paneInfo(row.pane_id))) throw new CliError(`S${id} has no live tab; use resume`);
      if (row.pending_prompt) throw new CliError(`S${id} still holds its first prompt: ${WAITING_NOTE} S${id} before sending more`);
      store.addDecision(db, { request, action: 'send', sessionId: id, considered: opts.considered, reason });
      herdr(['agent', 'prompt', row.pane_id, `[orchestrator S${id}] ${request}`]);
      print({ session: `S${id}`, action: 'sent', pane_id: row.pane_id }, opts);
    });
  },

  status(argv) {
    const opts = parseArgs(argv, ['ask', 'json']);
    const id = sessionArg(opts);
    return withDb(opts, (db, file) => {
      let row = getRow(db, id);
      const pane = row.pane_id && process.env.HERDR_ENV === '1' ? paneInfo(row.pane_id) : null;
      const live = isLive(row, pane);
      if (opts.ask) {
        requireLock(file);
        if (!live) throw new CliError(`S${id} has no live tab; read the record below or resume it`);
        herdr(['agent', 'prompt', row.pane_id, `[orchestrator S${id}] Status check from the user: update the record with ` +
          '`node "$ORCHESTRATOR_CLI" report --summary "<what is done, what remains, anything blocking>"`, then answer in two or three lines.']);
        try {
          herdr(['agent', 'wait', row.pane_id, '--timeout', String(Number(opts.timeout || 300000))]);
        } catch (err) {
          process.stderr.write(`S${id} did not settle in time; showing the record as it is: ${err.message}\n`);
        }
        row = getRow(db, id);
      }
      const prompts = store.recentPrompts(db, id, 5);
      const events = store.recentEvents(db, id, 8);
      if (opts.json) return print({ ...row, live: live ? (pane.agent_status || 'live') : 'closed', prompts, events }, opts);
      const c = { row, prompts, live: live ? (pane.agent_status || 'live') : 'closed', score: null, promptCount: store.promptCount(db, id) };
      print([
        describe(c),
        prompts.length ? `  recent prompts:\n${prompts.map(p => `    ${ago(p.at)} (${p.source}): ${oneLine(p.text)}`).join('\n')}` : '',
        events.length ? `  events: ${events.map(e => `${e.kind} ${ago(e.at)}`).join(', ')}` : '',
      ].filter(Boolean).join('\n'), opts);
    });
  },

  stop(argv) {
    const opts = parseArgs(argv, ['force', 'json']);
    const id = sessionArg(opts);
    return withDb(opts, (db, file) => {
      requireLock(file);
      const row = getRow(db, id);
      const pane = paneInfo(row.pane_id);
      if (!isLive(row, pane)) {
        store.updateSession(db, id, { pane_id: null, tab_id: null, agent_name: null });
        return print({ session: `S${id}`, action: 'already closed' }, opts);
      }
      if (!SETTLED.has(pane.agent_status) && !opts.force) {
        throw new CliError(`S${id} is ${pane.agent_status}; wait for it to settle, or pass --force to close it mid-turn`);
      }
      herdr(['tab', 'close', row.tab_id || pane.tab_id]);
      store.updateSession(db, id, { pane_id: null, tab_id: null, agent_name: null });
      store.addEvent(db, id, 'stopped', opts.force ? 'forced' : pane.agent_status);
      print({ session: `S${id}`, action: 'closed', status: row.status }, opts);
    });
  },

  resolve(argv) {
    const opts = parseArgs(argv, ['json']);
    const id = sessionArg(opts);
    return withDb(opts, (db, file) => {
      requireLock(file);
      getRow(db, id);
      store.updateSession(db, id, { status: 'resolved', resolved_at: store.now() });
      store.addEvent(db, id, 'resolved', opts.reason || 'orchestrator');
      print({ session: `S${id}`, status: 'resolved' }, opts);
    });
  },

  reopen(argv) {
    const opts = parseArgs(argv, ['json']);
    const id = sessionArg(opts);
    return withDb(opts, (db, file) => {
      requireLock(file);
      getRow(db, id);
      store.updateSession(db, id, { status: 'open', resolved_at: null });
      store.addEvent(db, id, 'reopened', opts.reason || 'orchestrator');
      print({ session: `S${id}`, status: 'open' }, opts);
    });
  },

  // Called by the worker itself (ORCHESTRATOR_SESSION is set in its tab).
  report(argv) {
    const opts = parseArgs(argv, ['resolved', 'open', 'json']);
    const id = sessionArg(opts, { fromEnv: true });
    if (opts.resolved && opts.open) throw usageError('--resolved and --open are exclusive');
    return withDb(opts, db => {
      const row = getRow(db, id);
      const fields = {};
      if (opts.summary) fields.summary = opts.summary.trim();
      if (opts.title) fields.title = opts.title.trim();
      if (opts.ticket) fields.ticket = opts.ticket.trim();
      if (opts.resolved) Object.assign(fields, { status: 'resolved', resolved_at: store.now() });
      if (opts.open) Object.assign(fields, { status: 'open', resolved_at: null });
      if (!Object.keys(fields).length) throw usageError('nothing to report: pass --summary, --title, --ticket, --resolved, or --open');
      store.updateSession(db, id, { ...fields, last_active_at: store.now() });
      store.addEvent(db, id, 'report', Object.keys(fields).join(','));
      const updated = store.getSession(db, id);
      if ((fields.ticket || fields.title) && updated.tab_id && process.env.HERDR_ENV === '1') {
        try { herdr(['tab', 'rename', updated.tab_id, tabLabel(updated)]); } catch { /* the label is cosmetic */ }
      }
      print({ session: `S${id}`, status: updated.status, recorded: Object.keys(fields).join(', ') }, opts);
    });
  },

  reconcile(argv) {
    const opts = parseArgs(argv, ['json']);
    return withDb(opts, db => print(reconcile(db), opts));
  },

  // Claude Code hook entry point. Registered only through the --settings the
  // orchestrator passes to the workers it launches; prints nothing, never fails.
  hook(argv) {
    const harness = argv[0];
    if (harness !== 'claude') return;
    const file = process.env.ORCHESTRATOR_DB;
    const sessionId = process.env.ORCHESTRATOR_SESSION;
    if (!file || !sessionId) return;
    let payload;
    try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return; }
    const kinds = { SessionStart: 'start', UserPromptSubmit: 'prompt', PreCompact: 'compact', Stop: 'stop', SessionEnd: 'end' };
    const kind = kinds[payload.hook_event_name];
    if (!kind) return;
    try {
      const db = store.open(file);
      try {
        store.recordHookEvent(db, sessionId, {
          kind,
          nativeSessionId: payload.session_id,
          text: payload.prompt,
          detail: payload.source || payload.trigger || payload.reason || null,
        });
      } finally { db.close(); }
    } catch (err) {
      process.stderr.write(`orchestrator hook: ${err.message}\n`);
    }
  },
};

const HELP = `Usage: orchestrator.js <command> [options]

Orchestrator (needs the lock; run inside Herdr):
  start                      take the project's orchestrator lock, reconcile, list open sessions
  release                    give the lock up
  new --title T --request R --reason W [--intent I] [--persona P] [--ticket T]
      [--harness claude|pi|<herdr kind>] [--model M] [--effort E] [--cwd DIR] [--from S<id>] [--considered S1,S2]
  resume S<id> --request R --reason W [--considered ...]   reopen a closed open session in a new tab
  send S<id> --request R --reason W [--considered ...]     message a live session
  deliver S<id>              send the first prompt held while a new tab waited for the user
  stop S<id> [--force]       close a settled worker's tab; the session stays as it is
  resolve S<id> | reopen S<id>
  status S<id> [--ask]       the record; --ask has the worker update it first

Anyone:
  find [--query TEXT] [--all] [--limit N]   rank sessions against a request
  report [S<id>] [--summary S] [--title T] [--ticket T] [--resolved|--open]   the worker's own update
  reconcile                  match the record to live Herdr tabs

A value of - reads it from stdin. --json prints JSON. --db overrides the record path.`;

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const handler = commands[command];
  if (!handler) {
    process.stderr.write(`unknown command: ${command}\n\n${HELP}\n`);
    return EXIT.usage;
  }
  if (command === 'hook') {
    try { handler(rest); } catch { /* a hook never fails the session */ }
    return 0;
  }
  try {
    handler(rest);
    return 0;
  } catch (err) {
    process.stderr.write(`orchestrator: ${err.message}\n`);
    return err.exitCode || EXIT.error;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parseArgs, score, tokens, tabLabel, harnessArgs, brief, claudeSettings, EXIT };
