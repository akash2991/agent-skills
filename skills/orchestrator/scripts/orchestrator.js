#!/usr/bin/env node
'use strict';

// The orchestrator's mechanics: the session record, the one-orchestrator
// ownership, and launching, resuming, messaging, and closing worker agents in
// Herdr tabs. The orchestrator agent makes the judgment (which session a
// request belongs to); this script does everything that can be exact. See
// ../SKILL.md.
//
// Invariants:
// - A session's native conversation id never changes on its own; only
//   `relaunch` replaces it. A launch that is known not to have started a worker
//   restores the session exactly as it was; one whose outcome is uncertain stays
//   recorded and blocks another launch until it is reconciled.
// - Resume opens the conversation by what is certain: Pi's recorded file, or
//   Claude's id. It starts the same id fresh only when the recorded transcript
//   is known to be gone.
// - A worker's prompts (its brief, held prompts, and every send) are held in the
//   record before they are sent and removed once accepted. A prompt whose
//   submission was interrupted is `unknown`: it is neither resent nor dropped
//   until the orchestrator settles it. A status probe (status --ask) is best
//   effort and is not held.
// - A tab the orchestrator did not start, or that now runs another
//   conversation, is never closed.

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
// Herdr's answers after which the agent accepted the prompt, and before which
// it certainly did not. Anything else leaves the submission unknown.
const ACCEPTED = new Set(['timeout', 'agent_prompt_stalled']);
const NOT_SENT = new Set(['agent_blocked', 'agent_not_found', 'pane_not_found', 'agent_not_ready']);
const HERDR_TIMEOUT_MS = Number(process.env.ORCHESTRATOR_HERDR_TIMEOUT_MS) || 330000;
const HOOK_BUSY_MS = { claude: 1500, pi: 5000 };
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

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// The project's main working tree: shared by its linked worktrees, and right
// for submodules and separate git directories, where the git directory is not
// inside the working tree.
function projectRoot(cwd = process.cwd()) {
  let top;
  try { top = git(['rev-parse', '--show-toplevel'], cwd); } catch { return cwd; }
  try {
    const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], cwd);
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
    if (gitDir === common) return top; // the main working tree itself
    // A linked worktree: its main working tree is listed first.
    const first = git(['worktree', 'list', '--porcelain'], cwd).split(/\n\n/)[0].split('\n');
    const line = first.find(l => l.startsWith('worktree '));
    if (line && !first.includes('bare')) return line.slice('worktree '.length);
  } catch { /* an old git */ }
  return top;
}

function dbPath(opts = {}) {
  return path.resolve(opts.db || process.env.ORCHESTRATOR_DB || path.join(projectRoot(), '.agent-brain', 'orchestrator.db'));
}

// Files that belong to a record are named after it, so one exclude covers them.
const companion = (db, suffix) => `${db}${suffix}`;

const escapeGlob = s => s.replace(/[*?[\]\\]/g, '\\$&');

// Keep the record, its SQLite sidecars, and its companions out of git without
// editing the project's .gitignore.
function excludeFromGit(root, db) {
  const rel = path.relative(root, db);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
  let exclude;
  try { exclude = git(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], root); } catch { return; }
  const pattern = `/${rel.split(path.sep).map(escapeGlob).join('/')}*`;
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
    out = execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: HERDR_TIMEOUT_MS });
  } catch (err) {
    const detail = String(err.stdout || '').trim() || String(err.stderr || '').trim() || err.message;
    let parsed;
    try { parsed = JSON.parse(detail); } catch { /* not JSON */ }
    const failure = new CliError(`herdr ${args.slice(0, 2).join(' ')} failed: ${parsed && parsed.error ? parsed.error.message : detail}`);
    // A local timeout is not Herdr's: nothing says whether the request landed.
    failure.herdrCode = parsed && parsed.error ? parsed.error.code : (err.code === 'ETIMEDOUT' ? 'local_timeout' : 'failed');
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
    return herdr(['pane', 'get', paneId]).pane || null;
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

// ─── Ownership: one orchestrator per project ─────────────────────────────────

function holderAlive(held) {
  const pane = paneInfo(held.pane_id);
  if (!pane || !pane.agent) return false;
  const native = pane.agent_session && pane.agent_session.value;
  return !held.agent_session || !native || sameId(native, held.agent_session);
}

function claimOwnership(db) {
  requireHerdr();
  const pane = paneInfo(process.env.HERDR_PANE_ID);
  const me = {
    pane_id: process.env.HERDR_PANE_ID,
    tab_id: process.env.HERDR_TAB_ID || (pane && pane.tab_id) || null,
    workspace_id: process.env.HERDR_WORKSPACE_ID,
    agent_session: pane && pane.agent_session ? pane.agent_session.value : null,
  };
  let result = store.claimOwner(db, me, holderAlive);
  for (let i = 0; i < 5 && result.changed; i++) result = store.claimOwner(db, me, holderAlive);
  if (!result.claimed) {
    throw new CliError(`another orchestrator holds this project: pane ${result.held.pane_id} (tab ${result.held.tab_id}), since ` +
      `${result.held.at}. Use that one, or close it first. This session stays read-only.`, EXIT.lock);
  }
  return { me, tookOver: result.tookOver };
}

function requireOwner(db) {
  requireHerdr();
  const owner = store.getOwner(db);
  if (!owner || owner.pane_id !== process.env.HERDR_PANE_ID) {
    throw new CliError(owner
      ? `this pane is not the orchestrator; pane ${owner.pane_id} is. Only the orchestrator launches, resumes, messages, or closes workers.`
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
  const held = store.pendingOf(r);
  const unknown = held.filter(e => e.state === 'unknown').length;
  if (unknown) lines.push(`  ${unknown} prompt(s) of unknown delivery: check the worker, then settle S${r.id} --resend or --drop`);
  if (held.length > unknown) lines.push(`  ${held.length - unknown} prompt(s) held: run deliver S${r.id} once its tab is ready`);
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
  const file = companion(dbFile, '.claude-settings.json');
  const content = `${JSON.stringify(claudeSettings(), null, 2)}\n`;
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) fs.writeFileSync(file, content);
  return file;
}

// `resume` reopens the recorded conversation; otherwise it starts under the
// session's id.
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
    // Resume names the exact recorded file: --session-id looks only in the
    // current session directory and creates a conversation when it is not there.
    return [
      ...(resume ? ['--session', row.transcript_path] : ['--session-id', row.native_session_id]),
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

function priorContext(db, row, heading) {
  const prompts = store.recentPrompts(db, row.id, 5);
  const held = store.pendingOf(row).filter(e => e.state === 'pending').map(e => e.text).filter(t => !t.startsWith('/brain '));
  return [
    `${heading} S${row.id} ("${row.title}")${row.ticket ? `, ticket ${row.ticket}` : ''}:`,
    `- intent: ${oneLine(row.intent, 400)}`,
    row.summary ? `- where it stood: ${oneLine(row.summary, 800)}` : '- no summary was recorded',
    ...prompts.map(p => `- asked ${ago(p.at)}: ${oneLine(p.text, 300)}`),
    ...(held.length ? ['Messages that were held for this session and never reached a worker:', ...held.map(t => `---\n${t}\n---`)] : []),
    'Read the ticket, its PR, and the code for the current state before acting; this summary may be stale.',
  ].join('\n');
}

function clearPlacement(db, id) {
  store.updateSession(db, id, { pane_id: null, tab_id: null, agent_name: null });
}

// Send the held prompts in order, removing each once the agent accepted it.
// Stops at the first prompt not accepted: one Herdr refused stays pending, and
// one whose submission is in doubt becomes `unknown` for the orchestrator to
// settle. Never called while an unknown prompt is held.
function deliverPending(db, id, paneId) {
  let entries = store.pendingOf(store.getSession(db, id));
  while (entries.length) {
    const [entry, ...rest] = entries;
    store.setPending(db, id, [{ ...entry, state: 'sending' }, ...rest]);
    try {
      herdr(['agent', 'prompt', paneId, entry.text, ...(rest.length ? ['--wait', '--timeout', '300000'] : [])]);
    } catch (err) {
      if (ACCEPTED.has(err.herdrCode)) {
        // Accepted, but the turn has not settled: hold the rest until it has.
        store.setPending(db, id, rest);
        return rest.length ? { ok: false, error: err.message } : { ok: true };
      }
      if (NOT_SENT.has(err.herdrCode)) {
        store.setPending(db, id, entries);
        return { ok: false, error: err.message };
      }
      store.setPending(db, id, [{ ...entry, state: 'unknown' }, ...rest]);
      return { ok: false, unknown: true, error: err.message };
    }
    entries = rest;
    store.setPending(db, id, entries);
  }
  return { ok: true };
}

// What an unconfirmed launch failure left behind, for the orchestrator to check.
function uncertainNote(err, what = 'the agent') {
  if (err.tabClosed) return err.recovery;
  if (err.tabRecorded) return `Its tab is kept, because ${what} may have started; check it before anything else`;
  return `Nothing changed in the record, but ${emptyTabCause(err)}: an empty tab may be open, with no agent in it`;
}

// Why an unrecorded tab may be left open: herdr timed out creating it, or the
// orchestrator could not close the tab it made after recording it failed.
const emptyTabCause = err => (err.emptyTab ? 'its tab could not be closed after recording it failed' : 'herdr timed out creating the tab');

const unknownHeld = row => store.pendingOf(row).filter(e => e.state === 'unknown');

function requireSettled(row) {
  const unknown = unknownHeld(row);
  if (unknown.length) {
    throw new CliError(`S${row.id} holds ${unknown.length} prompt(s) whose delivery is unknown (an interrupted send): ` +
      `"${oneLine(unknown[0].text, 120)}". Check the worker's conversation (status S${row.id}, or its tab), ` +
      `then run settle S${row.id} --resend if it never arrived or --drop if it did`);
  }
}

const IDENTITY = ['native_session_id', 'transcript_path', 'launches', 'identity_seq', 'launch_token', 'pending'];

// Open a tab and start the agent. `row` may carry a new identity (relaunch);
// it is committed with the tab. When the agent is known not to have started
// (no tab, or its tab confirmed closed), the session is restored exactly as it
// was; when that is uncertain, the tab and the new state stay recorded.
function launch(db, dbFile, row, { resume, prompts, commitEvent }) {
  const before = store.getSession(db, row.id);
  const restore = Object.fromEntries(IDENTITY.map(k => [k, before[k]]));
  const generation = before.launches + 1;
  const token = crypto.randomUUID();
  let tab;
  try {
    tab = herdr(['tab', 'create', '--workspace', process.env.HERDR_WORKSPACE_ID, '--cwd', row.cwd,
      '--label', tabLabel(row), '--no-focus',
      '--env', `ORCHESTRATOR_DB=${dbFile}`, '--env', `ORCHESTRATOR_SESSION=${row.id}`, '--env', `ORCHESTRATOR_LAUNCH=${token}`,
      '--env', `ORCHESTRATOR_CLI=${CLI}`, '--env', `ORCHESTRATOR_NODE=${process.execPath}`]);
  } catch (err) {
    // Nothing was recorded. A local timeout may still have left an empty tab.
    Object.assign(err, { startFailed: true, confirmed: err.herdrCode !== 'local_timeout', tabRecorded: false });
    throw err;
  }
  const pane = tab.root_pane && tab.root_pane.pane_id;
  const tabId = (tab.tab && tab.tab.tab_id) || (tab.root_pane && tab.root_pane.tab_id);
  if (!pane || !tabId) {
    const failure = new CliError(`herdr tab create returned no pane or tab id: ${JSON.stringify(tab)}`);
    Object.assign(failure, { startFailed: true, confirmed: true });
    throw failure;
  }
  const agentName = `orch-s${row.id}-${crypto.randomBytes(2).toString('hex')}`;
  // Recorded with the tab, as one routing change: the new placement, and for a
  // session's first worker, its parent's supersession (new --from). A launch
  // rolled back below restores both.
  let superseded = null;
  try {
    store.transaction(db, () => {
      store.updateSession(db, row.id, {
        native_session_id: row.native_session_id, transcript_path: row.transcript_path,
        tab_id: tabId, pane_id: pane, agent_name: agentName, launches: generation, identity_seq: 0, launch_token: token,
        pending: JSON.stringify(prompts.map(text => ({ text, state: 'pending' }))), last_active_at: store.now(),
      });
      store.addEvent(db, row.id, 'tab-created', `${pane} launch ${generation}`);
      if (commitEvent) store.addEvent(db, row.id, commitEvent.kind, commitEvent.detail);
      // A parent another new session already superseded records this one
      // too, so the rollback of either leaves the parent with the other.
      const parent = before.launches === 0 && before.parent_id ? store.getSession(db, before.parent_id) : null;
      if (parent && (parent.status === 'open' || parent.status === 'superseded')) {
        if (parent.status === 'open') store.updateSession(db, parent.id, { status: 'superseded' });
        store.addEvent(db, parent.id, 'superseded', `by S${row.id}`);
        superseded = parent.id;
      }
    }, 'launch');
  } catch (err) {
    // Nothing was recorded and no agent was started; close the tab it made.
    let closed = false;
    try { herdr(['tab', 'close', tabId]); closed = true; } catch { /* reported below */ }
    throw Object.assign(new CliError(`recording S${row.id}'s new tab failed: ${err.message}` +
      `${closed ? '' : `; its empty tab ${tabId} could not be closed`}`), { startFailed: true, confirmed: closed, tabRecorded: false, emptyTab: !closed });
  }
  const placed = { tab_id: tabId, pane_id: pane, label: tabLabel(row) };
  try {
    const args = harnessArgs(row, resume, { settingsFile: row.harness === 'claude' ? claudeSettingsFile(dbFile) : undefined });
    herdr(['agent', 'start', agentName, '--kind', row.harness, '--pane', pane, '--timeout', '120000', '--', ...args]);
  } catch (err) {
    if (err.herdrCode === 'agent_not_ready') {
      // The agent is up but asking the user something first, such as whether
      // to trust the folder. That answer is the user's, never the orchestrator's.
      logEvent(db, row.id, 'waiting-for-user', err.message);
      return { ...placed, waiting: 'user' };
    }
    let closed = false;
    try { herdr(['tab', 'close', tabId]); closed = true; } catch { /* reported below */ }
    let restored = false;
    let reopened = false;
    if (closed) {
      try {
        store.transaction(db, () => {
          store.updateSession(db, row.id, { ...restore, tab_id: null, pane_id: null, agent_name: null });
          // Undo only a supersession that still stands: not for a parent its
          // own worker resolved meanwhile,
          // nor one whose latest supersession is by another session.
          const parent = superseded ? store.getSession(db, superseded) : null;
          const latest = parent ? store.lastEvent(db, parent.id, 'superseded') : null;
          if (parent && parent.status === 'superseded' && latest && latest.detail === `by S${row.id}`) {
            store.updateSession(db, parent.id, { status: 'open' });
            reopened = true;
          }
        });
        restored = true;
      } catch (restoreErr) {
        err.message += `; its tab was closed, but restoring the record failed (${restoreErr.message})`;
      }
    }
    if (reopened) logEvent(db, superseded, 'supersession-undone', `S${row.id} got no worker`);
    logEvent(db, row.id, closed ? 'start-failed' : 'start-uncertain',
      `${err.message}${closed ? (restored ? '' : '; the record was not restored') : `; tab ${tabId} could not be closed`}`);
    const failure = new CliError(`${err.message}${closed ? '' : `; its tab ${tabId} could not be closed and stays recorded`}`);
    // A record that could not be restored is treated as uncertain: it stays
    // recorded and blocks another launch until it is checked. It also still
    // holds this launch's prompts, so its retry must not send them again.
    Object.assign(failure, { startFailed: true, confirmed: restored, tabRecorded: !restored, tabClosed: closed && !restored });
    if (failure.tabClosed) {
      // No conversation was written for a first launch or a relaunch's new id,
      // so only relaunch can start it; otherwise resume reopens the old one.
      // Only a resume reopens a conversation that was written before; every
      // other launch recorded one that never was, which only relaunch replaces.
      failure.recovery = 'No agent is running: its tab was closed, but restoring the record failed, so it still holds that launch ' +
        `and its prompts, including this request${superseded ? `, and S${superseded} stays superseded by it` : ''}. Do not send the request again; ` +
        (resume
          ? `resume S${row.id} without --request: it delivers the held prompts`
          : `relaunch S${row.id} with a --request asking it to continue: its held prompts go into the brief`);
    }
    throw failure;
  }
  // The worker is running from here on: a failure now never reads as a start
  // that failed, and the prompts it did not take stay held.
  try {
    logEvent(db, row.id, resume ? 'resumed' : 'launched', `${row.harness} pane ${pane}`);
    if (row.harness === 'pi') {
      let session = null;
      try {
        session = (paneInfo(pane) || {}).agent_session;
      } catch (err) {
        logEvent(db, row.id, 'transcript-unknown', err.message);
      }
      if (session && session.kind === 'path') store.updateSession(db, row.id, { transcript_path: session.value });
    }
    const sent = deliverPending(db, row.id, pane);
    if (sent.ok) return placed;
    return { ...placed, waiting: sent.unknown ? 'unknown' : 'busy', error: sent.error };
  } catch (err) {
    throw Object.assign(new CliError(`S${row.id}'s worker started in pane ${pane}, but recording or delivering to it failed: ${err.message}. ` +
      `Check status S${row.id}; run deliver S${row.id} for any prompt still held, or settle one of unknown delivery`), { workerStarted: true });
  }
}

function waitingNote(id, launched) {
  if (launched.waiting === 'user') {
    return `its tab is waiting for the user (a trust or login prompt). Ask the user to answer it in that tab, then run deliver S${id}`;
  }
  if (launched.waiting === 'unknown') {
    return `a prompt may or may not have reached the worker (${launched.error}). Check its tab, then run settle S${id} --resend or --drop`;
  }
  return `a prompt is still held (${launched.error}). Run deliver S${id} once the worker settles`;
}

// Before launching a session again: refuse if it already runs anywhere or if
// that cannot be checked, close an agentless leftover tab of ours, leave a tab
// that now runs another conversation alone, and adopt a tab the user resumed
// by hand.
function clearForLaunch(db, row) {
  if (row.pane_id) {
    const pane = paneInfo(row.pane_id);
    if (isLive(row, pane)) throw new CliError(`S${row.id} is already running in pane ${row.pane_id}; use send`);
    if (pane && pane.agent) {
      store.addEvent(db, row.id, 'tab-detached', `${row.pane_id} now runs another conversation`);
    } else if (pane) {
      try { herdr(['tab', 'close', row.tab_id || pane.tab_id]); } catch (err) {
        throw new CliError(`S${row.id}'s earlier tab ${row.tab_id || pane.tab_id} is still open and could not be closed: ${err.message}`);
      }
      store.addEvent(db, row.id, 'tab-closed', row.pane_id);
    }
    clearPlacement(db, row.id);
  }
  const agents = liveAgents();
  if (agents === null) throw new CliError(`cannot check whether S${row.id} is already running elsewhere (herdr agent list failed); try again`);
  const match = row.native_session_id && agents.find(a => a.agent_session && sameId(a.agent_session.value, row.native_session_id));
  if (match) {
    store.updateSession(db, row.id, { pane_id: match.pane_id, tab_id: match.tab_id || null });
    store.addEvent(db, row.id, 'tab-adopted', match.pane_id);
    throw new CliError(`S${row.id} is already running in pane ${match.pane_id}, opened outside the orchestrator; it is adopted now, so use send`);
  }
  return store.getSession(db, row.id);
}

const transcriptExists = row => !!row.transcript_path && fs.existsSync(row.transcript_path);

function print(value, opts) {
  if (opts.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (typeof value === 'string') process.stdout.write(`${value}\n`);
  else process.stdout.write(`${Object.entries(value).map(([k, v]) => `${k}: ${v}`).join('\n')}\n`);
}

function launchResult(id, action, launched, extra = {}) {
  return {
    session: `S${id}`, action: launched.waiting ? 'waiting' : action, ...(launched.waiting ? { waiting: launched.waiting } : {}), ...extra,
    tab_id: launched.tab_id, pane_id: launched.pane_id, label: launched.label,
    ...(launched.waiting ? { note: waitingNote(id, launched) } : {}),
  };
}

// Record the route, run it, then record what happened: the action it printed,
// or why it failed. A failure that may have left a worker is `uncertain`.
function decided(db, decision, run) {
  const id = store.addDecision(db, decision);
  // The outcome is bookkeeping: failing to write it never replaces the
  // route's result or its error, only adds a warning.
  const note = outcome => {
    try {
      store.setOutcome(db, id, outcome);
    } catch (err) {
      process.stderr.write(`orchestrator: warning: the outcome of decision ${id} was not recorded (${err.message})\n`);
    }
  };
  let result;
  try {
    result = run();
  } catch (err) {
    const kind = err.outcome || (err.workerStarted ? 'started-then-failed'
      : err.startFailed ? (noWorker(err) ? 'failed' : 'uncertain')
        : err instanceof CliError ? 'refused' : 'error');
    note(`${kind}: ${oneLine(err.message, 300)}`);
    throw err;
  }
  note(result.waiting ? `waiting: ${result.waiting}` : result.action);
  return result;
}

// No worker can have started: herdr confirmed the failure, or never confirmed
// creating the tab, so no agent start ran in it.
const noWorker = err => err.confirmed || !err.tabRecorded || !!err.tabClosed;

// The orchestrator's message for a failed launch, keeping what the outcome needs.
const fromLaunch = (err, message) => Object.assign(new CliError(message),
  { startFailed: true, confirmed: err.confirmed, tabRecorded: err.tabRecorded, tabClosed: err.tabClosed, emptyTab: err.emptyTab, recovery: err.recovery });

// History is not routing state: an event that cannot be written warns and
// never replaces the result or the error of the step it describes.
function logEvent(db, id, kind, detail) {
  try {
    store.addEvent(db, id, kind, detail);
  } catch (err) {
    process.stderr.write(`orchestrator: warning: S${id}'s ${kind} event was not recorded (${err.message})\n`);
  }
}

// ─── Reconcile ────────────────────────────────────────────────────────────────

// The record is the truth about intent; Herdr is the truth about what is
// running. Clear tabs that are gone, and adopt a tab where the user resumed a
// recorded session by hand.
function reconcile(db) {
  const agents = liveAgents();
  if (agents === null) return { skipped: 'herdr agent list failed', closed: [], adopted: [] };
  const byPane = new Map(agents.map(a => [a.pane_id, a]));
  const closed = [];
  const adopted = [];
  for (let row of store.listSessions(db)) {
    if (row.pane_id && !isLive(row, byPane.get(row.pane_id))) {
      const pane = paneInfo(row.pane_id);
      if (!pane || pane.agent) {
        // Gone, or now running another conversation: no longer this session's tab.
        clearPlacement(db, row.id);
        store.addEvent(db, row.id, pane ? 'tab-detached' : 'tab-closed', row.pane_id);
        closed.push(`S${row.id}`);
        row = store.getSession(db, row.id);
      }
    }
    if (row.pane_id || !row.native_session_id) continue;
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

function requireOpen(row, verb) {
  if (row.status !== 'open') throw new CliError(`S${row.id} is ${row.status}; start a new session with --from S${row.id} instead of ${verb} it`);
}

const commands = {
  start(argv) {
    const opts = parseArgs(argv, ['json']);
    return withDb(opts, (db, file) => {
      excludeFromGit(projectRoot(), file);
      const { me, tookOver } = claimOwnership(db);
      const changes = reconcile(db);
      const open = store.listSessions(db).filter(r => r.status === 'open');
      print({
        orchestrator: `pane ${me.pane_id}${tookOver ? ' (took over from an orchestrator that is gone)' : ''}`,
        record: file,
        open_sessions: open.length,
        live_tabs: open.filter(r => r.pane_id).length,
        reconciled: changes.skipped ? `skipped (${changes.skipped})` : `${changes.closed.length} closed, ${changes.adopted.length} adopted`,
      }, opts);
      if (!opts.json && open.length) print(`\n${candidates(db, { limit: 10 }).map(describe).join('\n\n')}`, opts);
    });
  },

  release(argv) {
    const opts = parseArgs(argv);
    return withDb(opts, db => {
      requireOwner(db);
      store.releaseOwner(db, process.env.HERDR_PANE_ID);
      print('released', opts);
    });
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
      requireOwner(db);
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
      const row = store.getSession(db, id);
      const context = parent ? priorContext(db, parent, 'Related earlier session') : null;
      const prompts = brief(row, request, { context });
      // Held before the launch, so a launch that fails keeps the brief for resume.
      store.setPending(db, id, prompts.map(text => ({ text, state: 'pending' })));
      const result = decided(db, { request, action: 'new', sessionId: id, considered: opts.considered, reason }, () => {
        let launched;
        try {
          launched = launch(db, file, store.getSession(db, id), { resume: false, prompts });
        } catch (err) {
          if (!err.startFailed) throw err;
          // A tab that herdr never confirmed creating ran no agent start, so no agent started.
          const retry = `resume S${id}, without --request`;
          throw fromLaunch(err, `S${id} is recorded with its brief held, but ${noWorker(err) ? 'no agent started' : 'whether its agent started is uncertain'}: ` +
            `${err.message}. ${err.confirmed ? `Retry with ${retry}`
              : err.tabClosed ? uncertainNote(err)
              : err.tabRecorded ? `${uncertainNote(err)}; then ${retry}`
                : `${emptyTabCause(err)}, so an empty tab may be open: close it if so, then ${retry}`}`);
        }
        return launchResult(id, 'new', launched, { tracked: TRACKED.has(harness) });
      });
      print(result, opts);
    });
  },

  // Open an open session again in a new tab. With no --request it only
  // delivers what the session holds (the retry of a launch that failed).
  resume(argv) {
    const opts = parseArgs(argv, ['json']);
    const id = sessionArg(opts);
    const request = opts.request ? opts.request.trim() : null;
    const reason = required(opts, 'reason');
    return withDb(opts, (db, file) => {
      requireOwner(db);
      let row = getRow(db, id);
      requireOpen(row, 'resuming');
      requireSettled(row);
      row = clearForLaunch(db, row);
      const held = store.pendingOf(row).map(e => e.text);
      if (!request && !held.length) throw usageError('--request is required: the session holds nothing to deliver');
      // Refusals come before the decision, so only a route that runs is recorded.
      const fresh = !TRACKED.has(row.harness) || row.launches === 0;
      if (!fresh && !request && row.transcript_path && !fs.existsSync(row.transcript_path)) {
        throw usageError(`--request is required: S${id}'s conversation is gone, so it starts again from a new brief`);
      }
      if (!fresh && !row.transcript_path && row.harness === 'pi') {
        throw new CliError(`S${id}'s Pi session file was never recorded, so it cannot be resumed exactly; relaunch S${id} for a new conversation`);
      }
      const decision = { request: request || '(deliver held prompts)', action: 'resume', sessionId: id, considered: opts.considered, reason };
      print(decided(db, decision, () => {
        const asks = [...held, ...(request ? [`[orchestrator S${id}] ${request}`] : [])];
        const fail = (err, what) => {
          if (!err.startFailed) return err;
          return fromLaunch(err, `${what} S${id} failed: ${err.message}. ${err.confirmed
            ? `Nothing changed: its conversation and held prompts are as they were. Retry, or relaunch S${id} for a new conversation`
            : uncertainNote(err)}`);
        };

        if (fresh) {
          // No conversation can exist yet: it never had a worker. Deliver the
          // held brief, or a new one when there is none.
          const prompts = held.length ? asks : brief(row, request, { context: priorContext(db, row, 'This continues the work of session') });
          let launched;
          try { launched = launch(db, file, row, { resume: false, prompts }); } catch (err) { throw fail(err, 'starting'); }
          return launchResult(id, 'started', launched);
        }
        if (row.transcript_path && !fs.existsSync(row.transcript_path)) {
          // Its recorded transcript is gone: start the same id fresh, with the
          // brief and everything the record knows.
          let launched;
          try {
            launched = launch(db, file, row, { resume: false, prompts: brief(row, request, { context: priorContext(db, row, 'This continues the work of session') }) });
          } catch (err) { throw fail(err, 'restarting'); }
          return launchResult(id, 'restarted', launched, { why: `its transcript ${row.transcript_path} is gone` });
        }
        // Reopen the conversation: Pi by its recorded file, Claude by its id
        // (where the transcript lives is Claude's to find).
        let launched;
        try {
          launched = launch(db, file, row, { resume: true, prompts: asks });
        } catch (err) {
          const unknownPlace = err.startFailed && !row.transcript_path ? ' Its transcript location was never recorded; if its conversation was never written (its tab closed while waiting for the user), relaunch it.' : '';
          const out = fail(err, 'resuming');
          out.message += unknownPlace;
          throw out;
        }
        return launchResult(id, 'resumed', launched);
      }), opts);
    });
  },

  // A new conversation for an open session, on the orchestrator's decision
  // (after a failed resume, or when the old one is not worth its context).
  relaunch(argv) {
    const opts = parseArgs(argv, ['json']);
    const id = sessionArg(opts);
    const request = required(opts, 'request');
    const reason = required(opts, 'reason');
    return withDb(opts, (db, file) => {
      requireOwner(db);
      let row = getRow(db, id);
      requireOpen(row, 'relaunching');
      requireSettled(row);
      row = clearForLaunch(db, row);
      const previous = { native_session_id: row.native_session_id, transcript_path: row.transcript_path };
      // The new identity is committed with its tab, and only if a worker may have started.
      const replacement = { ...row, native_session_id: TRACKED.has(row.harness) ? crypto.randomUUID() : null, transcript_path: null };
      const previousText = `previous conversation ${previous.native_session_id || 'none'}` +
        `${previous.transcript_path ? ` at ${previous.transcript_path}` : ''}: ${reason}`;
      print(decided(db, { request, action: 'relaunch', sessionId: id, considered: opts.considered, reason }, () => {
        let launched;
        try {
          launched = launch(db, file, replacement, {
            resume: false,
            prompts: brief(replacement, request, { context: priorContext(db, row, 'This continues the work of the earlier conversation of session') }),
            // Written with the new identity, so the old one is never unrecorded;
            // `relaunched` follows only once the new worker is placed.
            commitEvent: { kind: 'relaunch-staged', detail: previousText },
          });
        } catch (err) {
          if (err.workerStarted) logEvent(db, id, 'relaunched', previousText);
          if (!err.startFailed) throw err;
          const kept = !err.confirmed && err.tabRecorded;
          logEvent(db, id, 'relaunch-failed', `${kept ? 'kept the new conversation; the' : 'restored the'} ${previousText} (${err.message})`);
          throw fromLaunch(err, `relaunching S${id} failed: ${err.message}. ${err.confirmed
            ? 'Its previous conversation is still the recorded one'
            : `${uncertainNote(err, 'the new agent')}${kept ? '. The previous conversation is in its events' : ''}`}`);
        }
        logEvent(db, id, 'relaunched', previousText);
        return launchResult(id, 'relaunched', launched, { previous: previous.native_session_id });
      }), opts);
    });
  },

  // Resolve prompts whose delivery is unknown, after checking the worker's
  // conversation: --resend if it never arrived, --drop if it did.
  settle(argv) {
    const opts = parseArgs(argv, ['resend', 'drop', 'json']);
    const id = sessionArg(opts);
    if (!!opts.resend === !!opts.drop) throw usageError('pass exactly one of --resend or --drop');
    return withDb(opts, db => {
      requireOwner(db);
      const row = getRow(db, id);
      const entries = store.pendingOf(row);
      const unknown = entries.filter(e => e.state === 'unknown');
      if (!unknown.length) throw new CliError(`S${id} has no prompt of unknown delivery`);
      store.setPending(db, id, opts.resend
        ? entries.map(e => (e.state === 'unknown' ? { ...e, state: 'pending' } : e))
        : entries.filter(e => e.state !== 'unknown'));
      logEvent(db, id, opts.resend ? 'settled-resend' : 'settled-drop', `${unknown.length} prompt(s)`);
      print({ session: `S${id}`, settled: `${unknown.length} prompt(s) ${opts.resend ? `held to resend: run deliver S${id}, or resume S${id} if its tab is gone (with --request if a new request is waiting)` : 'dropped as delivered'}` }, opts);
    });
  },

  // Send the prompts held while a new tab waited for the user or the worker.
  deliver(argv) {
    const opts = parseArgs(argv, ['json']);
    const id = sessionArg(opts);
    return withDb(opts, db => {
      requireOwner(db);
      const row = getRow(db, id);
      if (!store.pendingOf(row).length) throw new CliError(`S${id} has no held prompt`);
      requireSettled(row);
      const pane = paneInfo(row.pane_id);
      if (!isLive(row, pane)) throw new CliError(`S${id}'s tab is gone; resume it, and its held prompts go with it`);
      if (pane.agent_status !== 'idle' && pane.agent_status !== 'done') {
        throw new CliError(`S${id} is ${pane.agent_status}; the user has not finished answering its tab, or it is still working`);
      }
      const sent = deliverPending(db, id, row.pane_id);
      if (!sent.ok) {
        throw new CliError(`S${id}: ${sent.error}; ${sent.unknown
          ? `a prompt may or may not have arrived: check its tab, then settle S${id} --resend or --drop`
          : `${store.pendingOf(store.getSession(db, id)).length} prompt(s) still held, run deliver again once it settles`}`);
      }
      try {
        store.updateSession(db, id, { last_active_at: store.now() });
      } catch (err) {
        process.stderr.write(`orchestrator: warning: S${id}'s activity time was not recorded (${err.message})\n`);
      }
      logEvent(db, id, 'delivered', row.pane_id);
      print({ session: `S${id}`, action: 'delivered', pane_id: row.pane_id }, opts);
    });
  },

  send(argv) {
    const opts = parseArgs(argv, ['json']);
    const id = sessionArg(opts);
    const request = required(opts, 'request');
    const reason = required(opts, 'reason');
    return withDb(opts, db => {
      requireOwner(db);
      const row = getRow(db, id);
      requireOpen(row, 'messaging');
      if (!isLive(row, paneInfo(row.pane_id))) throw new CliError(`S${id} has no live tab; use resume S${id} --request with this request, which carries it: nothing was kept`);
      requireSettled(row);
      if (store.pendingOf(row).length) throw new CliError(`S${id} still holds prompts; run deliver S${id} before sending more`);
      print(decided(db, { request, action: 'send', sessionId: id, considered: opts.considered, reason }, () => {
        store.setPending(db, id, [{ text: `[orchestrator S${id}] ${request}`, state: 'pending' }]);
        const sent = deliverPending(db, id, row.pane_id);
        if (!sent.ok) {
          throw Object.assign(new CliError(`S${id}: ${sent.error}; ${sent.unknown
            ? `the request may or may not have arrived: check its tab, then settle S${id} --resend or --drop`
            : `the request is held: run deliver S${id} once the worker can take it`}`), { outcome: sent.unknown ? 'unknown' : 'held' });
        }
        return { session: `S${id}`, action: 'sent', pane_id: row.pane_id };
      }), opts);
    });
  },

  status(argv) {
    const opts = parseArgs(argv, ['ask', 'json']);
    const id = sessionArg(opts);
    return withDb(opts, db => {
      let row = getRow(db, id);
      const pane = row.pane_id && process.env.HERDR_ENV === '1' ? paneInfo(row.pane_id) : null;
      const live = isLive(row, pane);
      // --ask is a best-effort request: the summary below is whatever the record
      // holds afterwards, with its age, never a claim that the worker answered.
      let asked = null;
      if (opts.ask) {
        requireOwner(db);
        if (!live) throw new CliError(`S${id} has no live tab; read the record below or resume it`);
        if (store.pendingOf(row).length) throw new CliError(`S${id} still holds prompts; deliver or settle them first`);
        if (pane.agent_status !== 'idle' && pane.agent_status !== 'done') {
          asked = `no: the worker is ${pane.agent_status}`;
        } else {
          try {
            herdr(['agent', 'prompt', row.pane_id, `[orchestrator S${id}] Status check from the user: update the record with ` +
              '`node "$ORCHESTRATOR_CLI" report --summary "<what is done, what remains, anything blocking>"`, then answer in two or three lines.',
            '--wait', '--timeout', String(Number(opts.timeout || 300000))]);
            asked = 'yes, and its turn ended';
          } catch (err) {
            asked = `yes, but ${err.message}`;
          }
        }
        row = getRow(db, id);
      }
      const prompts = store.recentPrompts(db, id, 5);
      const events = store.recentEvents(db, id, 8);
      const decisions = store.recentDecisions(db, id, 3);
      const liveState = live ? (pane.agent_status || 'live') : 'closed';
      if (opts.json) return print({ ...row, live: liveState, asked, prompts, events, decisions }, opts);
      const c = { row, prompts, live: liveState, score: null, promptCount: store.promptCount(db, id) };
      print([
        ...(asked ? [`asked: ${asked}`] : []),
        `summary last reported: ${row.summary_at ? ago(row.summary_at) : 'never'}`,
        describe(c),
        prompts.length ? `  recent prompts:\n${prompts.map(p => `    ${ago(p.at)} (${p.source}): ${oneLine(p.text)}`).join('\n')}` : '',
        events.length ? `  events: ${events.map(e => `${e.kind} ${ago(e.at)}`).join(', ')}` : '',
        decisions.length ? `  decisions:\n${decisions.map(d => `    ${ago(d.at)} ${d.action} -> ${d.outcome ? oneLine(d.outcome, 160) : 'no outcome recorded'}`).join('\n')}` : '',
      ].filter(Boolean).join('\n'), opts);
    });
  },

  stop(argv) {
    const opts = parseArgs(argv, ['force', 'json']);
    const id = sessionArg(opts);
    return withDb(opts, db => {
      requireOwner(db);
      const row = getRow(db, id);
      const pane = paneInfo(row.pane_id);
      if (!pane) {
        clearPlacement(db, id);
        return print({ session: `S${id}`, action: 'already closed' }, opts);
      }
      const live = isLive(row, pane);
      if (!live && pane.agent) {
        // Not this session's worker any more: leave it to the user.
        clearPlacement(db, id);
        store.addEvent(db, id, 'tab-detached', `${row.pane_id} now runs another conversation`);
        return print({ session: `S${id}`, action: 'detached', note: `its tab now runs another conversation and was left open` }, opts);
      }
      // A blocked worker is waiting on the user, at startup or mid-turn on a
      // permission prompt; closing it is the user's call (--force).
      const settled = !live || pane.agent_status === 'idle' || pane.agent_status === 'done';
      if (!settled && !opts.force) {
        throw new CliError(`S${id} is ${pane.agent_status}; wait for it to settle, or pass --force to close it mid-turn`);
      }
      herdr(['tab', 'close', row.tab_id || pane.tab_id]);
      clearPlacement(db, id);
      logEvent(db, id, 'stopped', opts.force ? `forced while ${pane.agent_status}` : pane.agent_status || 'no agent');
      print({ session: `S${id}`, action: 'closed', status: row.status }, opts);
    });
  },

  resolve(argv) {
    const opts = parseArgs(argv, ['json']);
    const id = sessionArg(opts);
    return withDb(opts, db => {
      requireOwner(db);
      getRow(db, id);
      store.updateSession(db, id, { status: 'resolved', resolved_at: store.now() });
      logEvent(db, id, 'resolved', opts.reason || 'orchestrator');
      print({ session: `S${id}`, status: 'resolved' }, opts);
    });
  },

  reopen(argv) {
    const opts = parseArgs(argv, ['json']);
    const id = sessionArg(opts);
    return withDb(opts, db => {
      requireOwner(db);
      getRow(db, id);
      store.updateSession(db, id, { status: 'open', resolved_at: null });
      logEvent(db, id, 'reopened', opts.reason || 'orchestrator');
      print({ session: `S${id}`, status: 'open' }, opts);
    });
  },

  // Called by the worker itself (ORCHESTRATOR_SESSION is set in its tab).
  report(argv) {
    const opts = parseArgs(argv, ['resolved', 'open', 'json']);
    const id = sessionArg(opts, { fromEnv: true });
    if (opts.resolved && opts.open) throw usageError('--resolved and --open are exclusive');
    return withDb(opts, db => {
      getRow(db, id);
      const fields = {};
      if (opts.summary) Object.assign(fields, { summary: opts.summary.trim(), summary_at: store.now() });
      if (opts.title) fields.title = opts.title.trim();
      if (opts.ticket) fields.ticket = opts.ticket.trim();
      if (opts.resolved) Object.assign(fields, { status: 'resolved', resolved_at: store.now() });
      if (opts.open) Object.assign(fields, { status: 'open', resolved_at: null });
      if (!Object.keys(fields).length) throw usageError('nothing to report: pass --summary, --title, --ticket, --resolved, or --open');
      store.updateSession(db, id, { ...fields, last_active_at: store.now() });
      logEvent(db, id, 'report', Object.keys(fields).filter(k => k !== 'summary_at').join(','));
      const updated = store.getSession(db, id);
      if ((fields.ticket || fields.title) && updated.tab_id && process.env.HERDR_ENV === '1') {
        try { herdr(['tab', 'rename', updated.tab_id, tabLabel(updated)]); } catch { /* the label is cosmetic */ }
      }
      print({ session: `S${id}`, status: updated.status, recorded: Object.keys(fields).filter(k => k !== 'summary_at').join(', ') }, opts);
    });
  },

  reconcile(argv) {
    const opts = parseArgs(argv, ['json']);
    return withDb(opts, db => {
      requireOwner(db);
      print(reconcile(db), opts);
    });
  },

  // A worker's recorder: the Claude hook (registered only through the settings
  // file the orchestrator passes its workers) and the Pi extension's detached
  // writer. Opens only an existing record, waits a bounded time for it, prints
  // nothing, and never fails; errors go to the record's hook log.
  hook(argv) {
    const harness = argv[0];
    const file = process.env.ORCHESTRATOR_DB;
    const sessionId = process.env.ORCHESTRATOR_SESSION;
    if (!file || !sessionId || !HOOK_BUSY_MS[harness]) return;
    let event;
    try {
      const payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
      if (harness === 'claude') {
        const kinds = { SessionStart: 'start', UserPromptSubmit: 'prompt', PreCompact: 'compact', Stop: 'stop', SessionEnd: 'end' };
        if (!kinds[payload.hook_event_name]) return;
        event = {
          launch: process.env.ORCHESTRATOR_LAUNCH,
          kind: kinds[payload.hook_event_name],
          nativeSessionId: payload.session_id,
          transcriptPath: payload.transcript_path,
          text: payload.prompt,
          detail: payload.source || payload.trigger || payload.reason || null,
        };
      } else {
        event = payload;
      }
    } catch { return; }
    try {
      const db = store.open(file, { create: false, busyTimeout: HOOK_BUSY_MS[harness] });
      if (!db) return;
      try { store.recordHookEvent(db, sessionId, event); } finally { db.close(); }
    } catch (err) {
      try {
        if (fs.statSync(path.dirname(file)).isDirectory()) {
          fs.appendFileSync(companion(file, '.hook.log'), `${store.now()} ${harness} ${event.kind}: ${err.message}\n`);
        }
      } catch { /* nowhere to note it; the session goes on */ }
    }
  },
};

const HELP = `Usage: orchestrator.js <command> [options]

Orchestrator (needs ownership; run inside Herdr):
  start                      own this project's orchestration, reconcile, list open sessions
  release                    give ownership up
  new --title T --request R --reason W [--intent I] [--persona P] [--ticket T]
      [--harness claude|pi|<herdr kind>] [--model M] [--effort E] [--cwd DIR] [--from S<id>] [--considered S1,S2]
  resume S<id> [--request R] --reason W [--considered ...]  reopen an open session's conversation in a new tab
  relaunch S<id> --request R --reason W [--considered ...]  give an open session a new conversation, seeded from the record
  send S<id> --request R --reason W [--considered ...]      message a live session
  deliver S<id>              send prompts held while a tab waited for the user or the worker
  settle S<id> --resend|--drop   resolve prompts whose delivery is unknown, after checking the worker
  stop S<id> [--force]       close a settled worker's tab; the session stays as it is
  resolve S<id> | reopen S<id>
  status S<id> [--ask]       the record, its prompts, events, and recent decisions with outcomes; --ask asks an idle worker to update it first (best effort)
  reconcile                  match the record to live Herdr tabs

Anyone:
  find [--query TEXT] [--all] [--limit N]   rank sessions against a request
  report [S<id>] [--summary S] [--title T] [--ticket T] [--resolved|--open]   the worker's own update

Defaults: ${Object.entries(DEFAULTS).map(([h, d]) => `${h} ${[d.model || 'its own model', d.effort].join(' ')}`).join('; ')}; harness ${DEFAULT_HARNESS}.
new, resume, relaunch, and deliver can wait minutes for an agent to start and settle; give them a long tool timeout.
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

module.exports = { main, parseArgs, score, tokens, tabLabel, harnessArgs, brief, claudeSettings, projectRoot, EXIT };
