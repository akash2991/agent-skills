'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPTS = path.join(__dirname, '..', 'skills', 'orchestrator', 'scripts');
const CLI = path.join(SCRIPTS, 'orchestrator.js');
const store = require(path.join(SCRIPTS, 'store.js'));
const { score, tabLabel, harnessArgs, claudeSettings } = require(CLI);

// A fake `herdr` that keeps panes and agents in a JSON file and logs every call.
const FAKE_HERDR = `#!/usr/bin/env node
const fs = require('fs');
const file = process.env.FAKE_HERDR_STATE;
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
s.calls.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const ok = result => { save(); process.stdout.write(JSON.stringify({ id: 'fake', result })); };
const fail = (code, message) => { save(); process.stdout.write(JSON.stringify({ id: 'fake', error: { code, message } })); process.exit(1); };
const [group, verb] = args;
const agents = () => Object.values(s.panes).filter(p => p.agent);
if (group === 'pane' && verb === 'get') {
  const pane = s.panes[args[2]];
  pane ? ok({ pane }) : fail('pane_not_found', 'pane ' + args[2] + ' not found');
} else if (group === 'agent' && verb === 'list') {
  ok({ agents: agents() });
} else if (group === 'tab' && verb === 'create') {
  const n = ++s.seq;
  const pane = { pane_id: 'w1:p' + n, tab_id: 'w1:t' + n, agent: null, env: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env') pane.env.push(args[i + 1]);
    if (args[i] === '--label') pane.label = args[i + 1];
    if (args[i] === '--cwd') pane.cwd = args[i + 1];
  }
  s.panes[pane.pane_id] = pane;
  ok({ tab: { tab_id: pane.tab_id }, root_pane: { pane_id: pane.pane_id, tab_id: pane.tab_id } });
} else if (group === 'agent' && verb === 'start') {
  const pane = s.panes[args[args.indexOf('--pane') + 1]];
  const rest = args.slice(args.indexOf('--') + 1);
  if (s.failResume && rest.includes('--resume')) fail('agent_start_failed', 'agent exited');
  const at = Math.max(rest.indexOf('--session-id'), rest.indexOf('--resume'));
  pane.agent = args[args.indexOf('--kind') + 1];
  pane.agent_status = 'idle';
  const native = at >= 0 ? rest[at + 1] : 'untracked';
  // As real Herdr does: Claude's session is its id, Pi's is its session file path.
  pane.agent_session = pane.agent === 'pi' ? { kind: 'path', value: '/home/.pi/sessions/2026-11-23T10-00-00Z_' + native + '.jsonl' } : { kind: 'id', value: native };
  pane.args = rest;
  if (s.blockStart) { pane.agent_status = 'blocked'; fail('agent_not_ready', 'agent is blocked during startup and is not ready for prompts'); }
  ok({ started: true });
} else if (group === 'agent' && verb === 'prompt') {
  if (s.timeoutWaits && args.includes('--wait')) { s.prompts.push({ pane: args[2], text: args[3] }); fail('timeout', 'timed out waiting'); }
  if (s.rejectPrompts) fail('agent_blocked', 'agent is blocked');
  s.prompts.push({ pane: args[2], text: args[3] });
  ok({ submitted: true });
} else if (group === 'agent' && verb === 'wait') {
  ok({ status: 'idle' });
} else if (group === 'tab' && verb === 'close') {
  for (const [id, p] of Object.entries(s.panes)) if (p.tab_id === args[2]) delete s.panes[id];
  ok({ closed: true });
} else if (group === 'tab' && verb === 'rename') {
  s.renames.push(args.slice(2));
  ok({ renamed: true });
} else {
  fail('unknown', 'fake herdr: unsupported ' + args.join(' '));
}
`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-test-'));
  const herdrBin = path.join(dir, 'herdr');
  fs.writeFileSync(herdrBin, FAKE_HERDR, { mode: 0o755 });
  const state = path.join(dir, 'herdr.json');
  const orchestratorPane = { pane_id: 'w1:p0', tab_id: 'w1:t0', agent: 'claude', agent_status: 'working', agent_session: { value: 'orch-session' } };
  fs.writeFileSync(state, JSON.stringify({ seq: 0, calls: [], prompts: [], renames: [], panes: { 'w1:p0': orchestratorPane } }));
  const db = path.join(dir, 'project', '.agent-brain', 'orchestrator.db');
  const env = {
    ...process.env, HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p0', HERDR_TAB_ID: 'w1:t0', HERDR_WORKSPACE_ID: 'w1',
    ORCHESTRATOR_HERDR: herdrBin, FAKE_HERDR_STATE: state, ORCHESTRATOR_DB: db,
  };
  delete env.ORCHESTRATOR_SESSION;
  const run = (args, extra = {}, input) => spawnSync(process.execPath, [CLI, ...args],
    { env: { ...env, ...extra }, encoding: 'utf8', input, cwd: dir });
  const herdrState = () => JSON.parse(fs.readFileSync(state, 'utf8'));
  const patchHerdr = fn => { const s = herdrState(); fn(s); fs.writeFileSync(state, JSON.stringify(s)); };
  const open = () => store.open(db);
  return { dir, db, run, herdrState, patchHerdr, open, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const ok = r => { assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}${r.stdout}`); return r; };
const json = r => JSON.parse(ok(r).stdout);

test('a related request outranks an unrelated one', () => {
  const doc = 'Fix the login button alignment on the settings page; navbar overlaps';
  assert.ok(score('login button misaligned on mobile', doc) > score('add CSV export to billing reports', doc));
  assert.strictEqual(score('', doc), 0);
});

test('a tab label follows <ticket> <scope> (<persona>) and keeps the session id', () => {
  assert.strictEqual(tabLabel({ id: 3, title: 'Fix login button', ticket: 'FAC-31', persona: 'web-engineer' }), 'FAC-31 S3 fix-login-button (web-engineer)');
  assert.strictEqual(tabLabel({ id: 4, title: 'Spike: queues?' }), 'S4 spike-queues');
});

test('workers get a resumable session id and the recording hooks; other kinds get nothing', () => {
  const row = { id: 1, title: 't', harness: 'claude', native_session_id: 'u-1', model: 'claude-opus-5-5', effort: 'medium' };
  const fresh = harnessArgs(row, false, { settingsFile: '/p/.agent-brain/orchestrator.claude-settings.json' });
  assert.deepStrictEqual(fresh.slice(0, 2), ['--session-id', 'u-1']);
  assert.strictEqual(fresh[fresh.indexOf('--settings') + 1], '/p/.agent-brain/orchestrator.claude-settings.json');
  assert.ok(fresh.join(' ').length < 400, 'Herdr types the launch line into a shell limited to 1024 bytes');
  assert.deepStrictEqual(Object.keys(claudeSettings().hooks).sort(), ['PreCompact', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  assert.deepStrictEqual(harnessArgs(row, true, { settingsFile: 'f' }).slice(0, 2), ['--resume', 'u-1']);
  assert.throws(() => harnessArgs(row, false), /hook settings file/);
  const pi = harnessArgs({ ...row, harness: 'pi', model: null }, true);
  assert.deepStrictEqual(pi.slice(0, 2), ['--session-id', 'u-1']);
  assert.ok(pi.includes('-e') && pi.includes('--thinking'));
  assert.deepStrictEqual(harnessArgs({ ...row, harness: 'codex' }, false), []);
});

test('only one orchestrator holds a project; a dead holder is taken over', () => {
  const t = setup();
  try {
    json(t.run(['start', '--json']));
    t.patchHerdr(s => { s.panes['w1:p9'] = { pane_id: 'w1:p9', tab_id: 'w1:t9', agent: 'claude', agent_session: { value: 'other' } }; });
    const refused = t.run(['start'], { HERDR_PANE_ID: 'w1:p9', HERDR_TAB_ID: 'w1:t9' });
    assert.strictEqual(refused.status, 3, refused.stderr);
    assert.match(refused.stderr, /another orchestrator holds this project/);
    const notOrchestrator = t.run(['new', '--title', 'x', '--request', 'y', '--reason', 'z'], { HERDR_PANE_ID: 'w1:p9' });
    assert.strictEqual(notOrchestrator.status, 3);
    t.patchHerdr(s => { delete s.panes['w1:p0']; });
    assert.match(json(t.run(['start', '--json'], { HERDR_PANE_ID: 'w1:p9', HERDR_TAB_ID: 'w1:t9' })).orchestrator, /took over/);
  } finally { t.cleanup(); }
});

test('outside Herdr the orchestrator refuses to start', () => {
  const t = setup();
  try {
    const r = t.run(['start'], { HERDR_ENV: '' });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /not inside Herdr/);
  } finally { t.cleanup(); }
});

test('new launches a tracked worker in its own tab and records the decision', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const out = json(t.run(['new', '--json', '--title', 'Fix login button', '--request', 'The login button overlaps the navbar',
      '--reason', 'no related session', '--persona', 'web-engineer', '--considered', 'none']));
    assert.strictEqual(out.session, 'S1');
    const h = t.herdrState();
    const pane = h.panes[out.pane_id];
    assert.strictEqual(pane.agent, 'claude');
    assert.ok(pane.env.includes(`ORCHESTRATOR_DB=${t.db}`) && pane.env.includes('ORCHESTRATOR_SESSION=1'));
    assert.strictEqual(pane.label, 'S1 fix-login-button (web-engineer)');
    assert.ok(pane.args.includes('claude-opus-5-5') && pane.args.includes('medium'));
    // A multi-line paste does not run a slash command, so /brain goes alone, on one line, and is waited for.
    assert.match(h.prompts[0].text, /^\/brain web-engineer \[orchestrator S1\] Adopt this persona[^\n]*$/);
    assert.match(h.prompts[1].text, /^\[orchestrator S1\] The login button overlaps/);
    const promptCalls = h.calls.filter(c => c[0] === 'agent' && c[1] === 'prompt');
    assert.ok(promptCalls[0].includes('--wait') && !promptCalls[1].includes('--wait'));
    const db = t.open();
    const row = store.getSession(db, 1);
    assert.strictEqual(row.native_session_id, pane.agent_session.value);
    assert.strictEqual(row.launches, 1);
    assert.deepStrictEqual(db.prepare('SELECT action, reason FROM decisions').all().map(r => ({ ...r })), [{ action: 'new', reason: 'no related session' }]);
    db.close();
  } finally { t.cleanup(); }
});

test('send reaches a live worker; resume reopens a closed one in a new tab', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Fix login', '--request', 'fix it', '--reason', 'r']));
    assert.match(t.run(['resume', 'S1', '--request', 'again', '--reason', 'r']).stderr, /already running/);
    ok(t.run(['send', 'S1', '--request', 'also the footer', '--reason', 'same bug area']));
    assert.strictEqual(t.herdrState().prompts.at(-1).text, '[orchestrator S1] also the footer');

    t.patchHerdr(s => { delete s.panes[first.pane_id]; });
    assert.match(t.run(['send', 'S1', '--request', 'x', '--reason', 'r']).stderr, /no live tab; use resume/);
    assert.deepStrictEqual(json(t.run(['reconcile', '--json'])), { closed: ['S1'], adopted: [] });
    const resumed = json(t.run(['resume', 'S1', '--json', '--request', 'the related bug on signup', '--reason', 'same area, open']));
    assert.strictEqual(resumed.action, 'resumed');
    const pane = t.herdrState().panes[resumed.pane_id];
    const db = t.open();
    assert.deepStrictEqual(pane.args.slice(0, 2), ['--resume', store.getSession(db, 1).native_session_id]);
    assert.strictEqual(store.getSession(db, 1).launches, 2);
    db.close();
  } finally { t.cleanup(); }
});

test('a failed resume relaunches a fresh conversation carrying the summary', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Fix login', '--request', 'fix it', '--reason', 'r', '--ticket', 'FAC-31']));
    ok(t.run(['report', '--summary', 'Button fixed; footer remains'], { ORCHESTRATOR_SESSION: '1' }));
    const before = (() => { const db = t.open(); const id = store.getSession(db, 1).native_session_id; db.close(); return id; })();
    t.patchHerdr(s => { delete s.panes[first.pane_id]; s.failResume = true; });
    const out = json(t.run(['resume', 'S1', '--json', '--request', 'now the footer', '--reason', 'continuing']));
    assert.strictEqual(out.action, 'relaunched');
    const h = t.herdrState();
    assert.ok(!Object.values(h.panes).some(p => p.args && p.args.includes('--resume')), 'the failed tab is closed');
    const prompt = h.prompts.at(-1).text;
    assert.match(prompt, /now the footer/);
    assert.match(prompt, /Button fixed; footer remains/);
    assert.match(prompt, /ticket FAC-31/);
    const db = t.open();
    assert.notStrictEqual(store.getSession(db, 1).native_session_id, before);
    assert.deepStrictEqual(store.recentEvents(db, 1).map(e => e.kind).filter(k => k.startsWith('re')).slice(-3), ['report', 'resume-failed', 'relaunched']);
    db.close();
  } finally { t.cleanup(); }
});

test('a tab waiting on the user keeps its first prompt until deliver; it is not a failed resume', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    t.patchHerdr(s => { s.blockStart = true; });
    const out = json(t.run(['new', '--json', '--title', 'New folder', '--request', 'build it', '--reason', 'r']));
    assert.strictEqual(out.action, 'waiting');
    assert.match(out.note, /trust or login prompt[\s\S]*deliver S1/);
    assert.ok(t.herdrState().panes[out.pane_id], 'the tab is kept for the user to answer');
    assert.strictEqual(t.herdrState().prompts.length, 0, 'nothing is typed into a prompt the user must answer');
    assert.match(t.run(['send', 'S1', '--request', 'x', '--reason', 'r']).stderr, /still holds its first prompt/);
    assert.match(t.run(['deliver', 'S1']).stderr, /is blocked; the user has not finished/);
    t.patchHerdr(s => { s.panes[out.pane_id].agent_status = 'idle'; s.blockStart = false; });
    ok(t.run(['deliver', 'S1']));
    assert.match(t.herdrState().prompts.at(-1).text, /^\[orchestrator S1\] build it/);
    assert.match(t.run(['deliver', 'S1']).stderr, /no held prompt/);

    t.patchHerdr(s => { delete s.panes[out.pane_id]; s.blockStart = true; });
    const resumed = json(t.run(['resume', 'S1', '--json', '--request', 'more', '--reason', 'r']));
    assert.strictEqual(resumed.action, 'waiting');
    const db = t.open();
    assert.ok(!store.recentEvents(db, 1).some(e => e.kind === 'resume-failed' || e.kind === 'relaunched'));
    db.close();
  } finally { t.cleanup(); }
});

test('a started agent whose prompt fails keeps the rest held for deliver instead of reporting a failed start', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    t.patchHerdr(s => { s.timeoutWaits = true; });
    const out = json(t.run(['new', '--json', '--title', 'Slow persona', '--request', 'go', '--reason', 'r', '--persona', 'scout']));
    assert.strictEqual(out.action, 'waiting');
    assert.strictEqual(t.herdrState().prompts.length, 1, 'the /brain prompt went out; its wait timed out');
    t.patchHerdr(s => { s.timeoutWaits = false; s.rejectPrompts = true; });
    assert.match(t.run(['deliver', 'S1']).stderr, /still held/);
    t.patchHerdr(s => { s.rejectPrompts = false; });
    ok(t.run(['deliver', 'S1']));
    const texts = t.herdrState().prompts.map(p => p.text);
    assert.strictEqual(texts.length, 2);
    assert.match(texts[1], /^\[orchestrator S1\] go/);
  } finally { t.cleanup(); }
});

test('a resolved session is never resumed; new --from seeds a fresh one from it', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    ok(t.run(['new', '--title', 'Fix login', '--request', 'fix it', '--reason', 'r', '--ticket', 'FAC-31']));
    ok(t.run(['report', '--summary', 'Done in PR 12', '--resolved'], { ORCHESTRATOR_SESSION: '1' }));
    const refused = t.run(['resume', 'S1', '--request', 'login again', '--reason', 'r']);
    assert.strictEqual(refused.status, 1);
    assert.match(refused.stderr, /resolved; start a new session with --from S1/);
    assert.match(t.run(['send', 'S1', '--request', 'x', '--reason', 'r']).stderr, /resolved/);
    const out = json(t.run(['new', '--json', '--from', 'S1', '--title', 'Login regression', '--request', 'login broke again', '--reason', 'S1 resolved']));
    assert.strictEqual(out.session, 'S2');
    assert.match(t.herdrState().prompts.at(-1).text, /Related earlier session S1[\s\S]*Done in PR 12/);
    const db = t.open();
    assert.strictEqual(store.getSession(db, 2).ticket, 'FAC-31');
    assert.strictEqual(store.getSession(db, 2).parent_id, 1);
    assert.strictEqual(store.getSession(db, 1).status, 'resolved');
    db.close();
  } finally { t.cleanup(); }
});

test('new --from an open session supersedes it', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    ok(t.run(['new', '--title', 'Long session', '--request', 'a', '--reason', 'r']));
    ok(t.run(['new', '--from', 'S1', '--title', 'Fresh start', '--request', 'b', '--reason', 'S1 compacted 4 times']));
    const db = t.open();
    assert.strictEqual(store.getSession(db, 1).status, 'superseded');
    db.close();
    const listed = ok(t.run(['find'])).stdout;
    assert.match(listed, /^S2 · open/);
    assert.doesNotMatch(listed, /S1 ·/);
    assert.match(ok(t.run(['find', '--all'])).stdout, /S1 · superseded/);
  } finally { t.cleanup(); }
});

test('the Claude hook records prompts, compactions, and a /clear; it prints nothing and is inert elsewhere', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    ok(t.run(['new', '--title', 'Fix login', '--request', 'fix it', '--reason', 'r']));
    const hook = (payload, extra = { ORCHESTRATOR_SESSION: '1' }) => {
      const r = ok(t.run(['hook', 'claude'], extra, JSON.stringify(payload)));
      assert.strictEqual(r.stdout, '', 'a hook must not inject context');
    };
    const db0 = t.open(); const native = store.getSession(db0, 1).native_session_id; db0.close();
    hook({ hook_event_name: 'UserPromptSubmit', session_id: native, prompt: '[orchestrator S1] fix it' });
    hook({ hook_event_name: 'UserPromptSubmit', session_id: native, prompt: 'also check dark mode' });
    hook({ hook_event_name: 'PreCompact', session_id: native, trigger: 'auto' });
    hook({ hook_event_name: 'SessionStart', session_id: 'after-clear', source: 'clear' });
    hook({ hook_event_name: 'UserPromptSubmit', session_id: 'x', prompt: 'not tracked' }, { ORCHESTRATOR_SESSION: '' });
    hook({ hook_event_name: 'UserPromptSubmit', session_id: 'x', prompt: 'bad db' }, { ORCHESTRATOR_SESSION: '1', ORCHESTRATOR_DB: path.join(t.dir, 'missing', 'dir', 'x.db') });
    const db = t.open();
    assert.deepStrictEqual(store.recentPrompts(db, 1).map(p => [p.source, p.text]), [
      ['orchestrator', '[orchestrator S1] fix it'], ['direct', 'also check dark mode']]);
    const row = store.getSession(db, 1);
    assert.strictEqual(row.compactions, 1);
    assert.ok(row.last_compacted_at);
    assert.strictEqual(row.native_session_id, 'after-clear');
    db.close();
  } finally { t.cleanup(); }
});

test('the Pi extension records the same events and does nothing outside a worker', () => {
  const t = setup();
  const saved = { db: process.env.ORCHESTRATOR_DB, session: process.env.ORCHESTRATOR_SESSION };
  try {
    const db = t.open();
    const id = store.createSession(db, { title: 'pi work', intent: 'i', harness: 'pi', native_session_id: 'p-1', cwd: t.dir });
    db.close();
    const extension = require(path.join(SCRIPTS, 'pi-extension.js'));
    const fakePi = () => { const handlers = {}; return { handlers, on: (name, fn) => { handlers[name] = fn; } }; };

    delete process.env.ORCHESTRATOR_DB;
    const inert = fakePi();
    extension(inert);
    assert.deepStrictEqual(Object.keys(inert.handlers), []);

    process.env.ORCHESTRATOR_DB = t.db;
    process.env.ORCHESTRATOR_SESSION = String(id);
    const pi = fakePi();
    extension(pi);
    pi.handlers.session_start({}, { sessionManager: { getSessionId: () => 'p-2' } });
    pi.handlers.input({ text: 'please fix the queue', source: 'interactive' });
    pi.handlers.input({ text: 'injected', source: 'extension' });
    pi.handlers.session_compact({ reason: 'threshold' });
    pi.handlers.session_shutdown();
    const check = t.open();
    assert.deepStrictEqual(store.recentPrompts(check, id).map(p => p.text), ['please fix the queue']);
    assert.strictEqual(store.getSession(check, id).compactions, 1);
    assert.strictEqual(store.getSession(check, id).native_session_id, 'p-2');
    check.close();
  } finally {
    if (saved.db === undefined) delete process.env.ORCHESTRATOR_DB; else process.env.ORCHESTRATOR_DB = saved.db;
    if (saved.session === undefined) delete process.env.ORCHESTRATOR_SESSION; else process.env.ORCHESTRATOR_SESSION = saved.session;
    t.cleanup();
  }
});

test('a worker report with a ticket relabels its tab; stop waits for a settled worker', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Fix login', '--request', 'fix it', '--reason', 'r', '--persona', 'web-engineer']));
    ok(t.run(['report', '--ticket', 'FAC-40'], { ORCHESTRATOR_SESSION: '1' }));
    assert.deepStrictEqual(t.herdrState().renames.at(-1), [first.tab_id, 'FAC-40 S1 fix-login (web-engineer)']);
    assert.strictEqual(t.run(['report'], { ORCHESTRATOR_SESSION: '1' }).status, 2);

    t.patchHerdr(s => { s.panes[first.pane_id].agent_status = 'working'; });
    assert.match(t.run(['stop', 'S1']).stderr, /is working; wait for it to settle/);
    t.patchHerdr(s => { s.panes[first.pane_id].agent_status = 'idle'; });
    assert.strictEqual(json(t.run(['stop', 'S1', '--json'])).action, 'closed');
    assert.strictEqual(t.herdrState().panes[first.pane_id], undefined);
    const db = t.open();
    assert.strictEqual(store.getSession(db, 1).status, 'open', 'closing a tab does not resolve the work');
    db.close();
    assert.match(ok(t.run(['status', 'S1'])).stdout, /tab closed[\s\S]*events: .*stopped/);
  } finally { t.cleanup(); }
});

test('a Pi worker, which Herdr reports by session file path, is recognized as live', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const out = json(t.run(['new', '--json', '--title', 'Pi work', '--request', 'go', '--reason', 'r', '--harness', 'pi']));
    assert.match(t.run(['resume', 'S1', '--request', 'x', '--reason', 'r']).stderr, /already running/);
    assert.match(ok(t.run(['find'])).stdout, /tab live \(idle\)/);
    assert.strictEqual(json(t.run(['stop', 'S1', '--json'])).action, 'closed');
    assert.strictEqual(t.herdrState().panes[out.pane_id], undefined, 'the tab is really closed, not orphaned');
  } finally { t.cleanup(); }
});

test('the record is kept out of git', () => {
  const t = setup();
  try {
    const project = path.join(t.dir, 'project');
    fs.mkdirSync(project, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: project });
    ok(spawnSync(process.execPath, [CLI, 'start'], { cwd: project, encoding: 'utf8',
      env: { ...process.env, HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p0', HERDR_WORKSPACE_ID: 'w1', ORCHESTRATOR_HERDR: path.join(t.dir, 'herdr'),
        FAKE_HERDR_STATE: path.join(t.dir, 'herdr.json'), ORCHESTRATOR_DB: '' } }));
    assert.ok(fs.existsSync(path.join(project, '.agent-brain', 'orchestrator.db')));
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: project, encoding: 'utf8' }).stdout;
    assert.doesNotMatch(status, /orchestrator/);
  } finally { t.cleanup(); }
});
