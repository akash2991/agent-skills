'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPTS = path.join(__dirname, '..', 'skills', 'orchestrator', 'scripts');
const CLI = path.join(SCRIPTS, 'orchestrator.js');
const store = require(path.join(SCRIPTS, 'store.js'));
const { score, tabLabel, harnessArgs, claudeSettings, projectRoot } = require(CLI);

// A fake `herdr` that keeps panes and agents in a JSON file. Read-only calls do
// not write it, so concurrent orchestrators can share it. `promptPlan` scripts
// the outcome of successive prompts: ok, stall, timeout, reject, or hang.
const FAKE_HERDR = `#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');
const file = process.env.FAKE_HERDR_STATE;
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const save = () => { s.calls.push(args); fs.writeFileSync(file, JSON.stringify(s)); };
const ok = result => { save(); process.stdout.write(JSON.stringify({ id: 'fake', result })); };
const okRead = result => process.stdout.write(JSON.stringify({ id: 'fake', result }));
const fail = (code, message) => { save(); process.stdout.write(JSON.stringify({ id: 'fake', error: { code, message } })); process.exit(1); };
const [group, verb] = args;
const agents = () => Object.values(s.panes).filter(p => p.agent);
if (group === 'pane' && verb === 'get') {
  const pane = s.panes[args[2]];
  pane ? okRead({ pane }) : (process.stdout.write(JSON.stringify({ id: 'fake', error: { code: 'pane_not_found', message: 'pane ' + args[2] + ' not found' } })), process.exit(1));
} else if (group === 'agent' && verb === 'list') {
  okRead({ agents: agents() });
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
  pane.args = rest;
  if (s.failStart) fail(s.failStart, 'agent start failed (' + s.failStart + ')');
  const at = Math.max(rest.indexOf('--session-id'), rest.indexOf('--resume'));
  const native = at >= 0 ? rest[at + 1] : 'untracked';
  pane.agent = args[args.indexOf('--kind') + 1];
  pane.agent_status = 'idle';
  // As real Herdr does: Claude's session is its id, Pi's is its session file path.
  pane.agent_session = pane.agent === 'pi'
    ? { kind: 'path', value: (s.piSessionDir || '/home/.pi/sessions') + '/2026-11-23T10-00-00Z_' + native + '.jsonl' }
    : { kind: 'id', value: native };
  if (s.blockStart) { pane.agent_status = 'blocked'; fail('agent_not_ready', 'agent is blocked during startup and is not ready for prompts'); }
  ok({ started: true });
} else if (group === 'agent' && verb === 'prompt') {
  const step = (s.promptPlan || []).shift() || 'ok';
  const wait = args.includes('--wait');
  if (step === 'reject') fail('agent_blocked', 'agent is blocked');
  s.prompts.push({ pane: args[2], text: args[3], wait });
  if (step.startsWith('hang')) { save(); const end = Date.now() + Number(step.split(':')[1]); while (Date.now() < end) {} process.exit(0); }
  if (step === 'stall') fail('agent_prompt_stalled', 'no working state observed');
  if (step === 'timeout') fail('timeout', 'timed out');
  if (wait && s.onPromptWait) { save(); execSync(s.onPromptWait, { stdio: 'ignore' }); return process.stdout.write(JSON.stringify({ id: 'fake', result: { status: 'idle' } })); }
  ok({ submitted: true });
} else if (group === 'tab' && verb === 'close') {
  if (s.failClose) fail('failed', 'socket closed');
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
  const orchestratorPane = { pane_id: 'w1:p0', tab_id: 'w1:t0', agent: 'claude', agent_status: 'working', agent_session: { kind: 'id', value: 'orch-session' } };
  fs.writeFileSync(state, JSON.stringify({ seq: 0, calls: [], prompts: [], renames: [], panes: { 'w1:p0': orchestratorPane } }));
  const db = path.join(dir, 'project', '.agent-brain', 'orchestrator.db');
  const env = {
    ...process.env, HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p0', HERDR_TAB_ID: 'w1:t0', HERDR_WORKSPACE_ID: 'w1',
    ORCHESTRATOR_HERDR: herdrBin, FAKE_HERDR_STATE: state, ORCHESTRATOR_DB: db,
  };
  delete env.ORCHESTRATOR_SESSION;
  const run = (args, extra = {}, input, options = {}) => spawnSync(process.execPath, [CLI, ...args],
    { env: { ...env, ...extra }, encoding: 'utf8', input, cwd: dir, ...options });
  const runAsync = (args, extra = {}) => new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, cwd: dir });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => resolve({ status, stderr }));
  });
  const herdrState = () => JSON.parse(fs.readFileSync(state, 'utf8'));
  const patchHerdr = fn => { const s = herdrState(); fn(s); fs.writeFileSync(state, JSON.stringify(s)); };
  const open = () => store.open(db);
  const row = id => { const d = open(); try { return store.getSession(d, id); } finally { d.close(); } };
  const patchRow = (id, fields) => { const d = open(); try { store.updateSession(d, id, fields); } finally { d.close(); } };
  const events = id => { const d = open(); try { return store.recentEvents(d, id, 50).map(e => e.kind); } finally { d.close(); } };
  return { dir, db, env, run, runAsync, herdrState, patchHerdr, open, row, patchRow, events, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const ok = r => { assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}${r.stdout}`); return r; };
const json = r => JSON.parse(ok(r).stdout);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; sleep(50); }
  return check();
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

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
  const fresh = harnessArgs(row, false, { settingsFile: '/p/.agent-brain/orchestrator.db.claude-settings.json' });
  assert.deepStrictEqual(fresh.slice(0, 2), ['--session-id', 'u-1']);
  assert.strictEqual(fresh[fresh.indexOf('--settings') + 1], '/p/.agent-brain/orchestrator.db.claude-settings.json');
  assert.ok(fresh.join(' ').length < 400, 'Herdr types the launch line into a shell limited to 1024 bytes');
  assert.deepStrictEqual(Object.keys(claudeSettings().hooks).sort(), ['PreCompact', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  assert.deepStrictEqual(harnessArgs(row, true, { settingsFile: 'f' }).slice(0, 2), ['--resume', 'u-1']);
  assert.throws(() => harnessArgs(row, false), /hook settings file/);
  const pi = harnessArgs({ ...row, harness: 'pi', model: null }, true);
  assert.deepStrictEqual(pi.slice(0, 2), ['--session-id', 'u-1']);
  assert.ok(pi.includes('-e') && pi.includes('--thinking'));
  assert.deepStrictEqual(harnessArgs({ ...row, harness: 'codex' }, false), []);
});

// ─── Ownership ───────────────────────────────────────────────────────────────

test('only one orchestrator owns a project; a gone owner is taken over', () => {
  const t = setup();
  try {
    json(t.run(['start', '--json']));
    t.patchHerdr(s => { s.panes['w1:p9'] = { pane_id: 'w1:p9', tab_id: 'w1:t9', agent: 'claude', agent_session: { value: 'other' } }; });
    const refused = t.run(['start'], { HERDR_PANE_ID: 'w1:p9', HERDR_TAB_ID: 'w1:t9' });
    assert.strictEqual(refused.status, 3, refused.stderr);
    assert.match(refused.stderr, /another orchestrator holds this project/);
    assert.strictEqual(t.run(['new', '--title', 'x', '--request', 'y', '--reason', 'z'], { HERDR_PANE_ID: 'w1:p9' }).status, 3);
    t.patchHerdr(s => { delete s.panes['w1:p0']; });
    assert.match(json(t.run(['start', '--json'], { HERDR_PANE_ID: 'w1:p9', HERDR_TAB_ID: 'w1:t9' })).orchestrator, /took over/);
    assert.strictEqual(t.run(['release']).status, 3, 'only the owner releases');
  } finally { t.cleanup(); }
});

for (const [name, prepare] of [
  ['no owner', () => {}],
  ['an owner that is gone', t => { ok(t.run(['start'])); t.patchHerdr(s => { delete s.panes['w1:p0']; }); }],
]) {
  test(`orchestrators starting together against ${name}: exactly one wins`, async () => {
    const t = setup();
    try {
      ok(t.run(['reconcile'])); // create the record first, so the race is over ownership
      prepare(t);
      const panes = [1, 2, 3, 4, 5, 6].map(n => `w1:p${100 + n}`);
      t.patchHerdr(s => { for (const p of panes) s.panes[p] = { pane_id: p, tab_id: `t-${p}`, agent: 'claude', agent_session: { value: `own-${p}` } }; });
      const results = await Promise.all(panes.map(p => t.runAsync(['start'], { HERDR_PANE_ID: p, HERDR_TAB_ID: `t-${p}` })));
      assert.deepStrictEqual(results.map(r => r.status).sort(), [0, 3, 3, 3, 3, 3], results.map(r => r.stderr).join('\n'));
      const winner = panes[results.findIndex(r => r.status === 0)];
      const d = t.open();
      assert.strictEqual(store.getOwner(d).pane_id, winner);
      d.close();
      for (const p of panes.filter(p => p !== winner)) {
        assert.strictEqual(t.run(['new', '--title', 'x', '--request', 'y', '--reason', 'z'], { HERDR_PANE_ID: p }).status, 3, `${p} must not act`);
      }
    } finally { t.cleanup(); }
  });
}

test('outside Herdr the orchestrator refuses to start', () => {
  const t = setup();
  try {
    const r = t.run(['start'], { HERDR_ENV: '' });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /not inside Herdr/);
  } finally { t.cleanup(); }
});

// ─── Launch and routing ──────────────────────────────────────────────────────

test('new launches a tracked worker in its own tab, adopts the persona with its own prompt, and records the decision', () => {
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
    assert.ok(pane.env.some(e => e.startsWith('ORCHESTRATOR_NODE=')));
    assert.strictEqual(pane.label, 'S1 fix-login-button (web-engineer)');
    assert.ok(pane.args.includes('claude-opus-5-5') && pane.args.includes('medium'));
    // A multi-line paste does not run a slash command, so /brain goes alone, on one line, and is waited for.
    assert.match(h.prompts[0].text, /^\/brain web-engineer \[orchestrator S1\] Adopt this persona[^\n]*$/);
    assert.ok(h.prompts[0].wait && !h.prompts[1].wait);
    assert.match(h.prompts[1].text, /^\[orchestrator S1\] The login button overlaps/);
    const row = t.row(1);
    assert.strictEqual(row.native_session_id, pane.agent_session.value);
    assert.strictEqual(row.pending, null, 'delivered prompts are no longer held');
    const d = t.open();
    assert.deepStrictEqual(d.prepare('SELECT action, reason FROM decisions').all().map(r => ({ ...r })), [{ action: 'new', reason: 'no related session' }]);
    d.close();
  } finally { t.cleanup(); }
});

test('resume opens an existing conversation; a never-written one restarts under the same id with the full brief', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Fix login', '--request', 'fix the login page', '--reason', 'r']));
    assert.match(t.run(['resume', 'S1', '--request', 'again', '--reason', 'r']).stderr, /already running/);
    ok(t.run(['send', 'S1', '--request', 'also the footer', '--reason', 'same bug area']));
    assert.strictEqual(t.herdrState().prompts.at(-1).text, '[orchestrator S1] also the footer');
    const id = t.row(1).native_session_id;

    t.patchHerdr(s => { delete s.panes[first.pane_id]; });
    assert.match(t.run(['send', 'S1', '--request', 'x', '--reason', 'r']).stderr, /no live tab; use resume/);
    const restarted = json(t.run(['resume', 'S1', '--json', '--request', 'signup too', '--reason', 'r']));
    assert.strictEqual(restarted.action, 'restarted');
    assert.match(restarted.why, /never written/);
    let pane = t.herdrState().panes[restarted.pane_id];
    assert.deepStrictEqual(pane.args.slice(0, 2), ['--session-id', id], 'the same conversation id, started fresh');
    assert.match(t.herdrState().prompts.at(-1).text, /signup too[\s\S]*This continues the work of session S1/);

    const transcript = path.join(t.dir, `${id}.jsonl`);
    fs.writeFileSync(transcript, '{}\n');
    t.patchRow(1, { transcript_path: transcript });
    t.patchHerdr(s => { delete s.panes[restarted.pane_id]; });
    const resumed = json(t.run(['resume', 'S1', '--json', '--request', 'and the reset page', '--reason', 'same area, open']));
    assert.strictEqual(resumed.action, 'resumed');
    pane = t.herdrState().panes[resumed.pane_id];
    assert.deepStrictEqual(pane.args.slice(0, 2), ['--resume', id]);
    assert.strictEqual(t.herdrState().prompts.at(-1).text, '[orchestrator S1] and the reset page');
    assert.strictEqual(t.row(1).launches, 3);
  } finally { t.cleanup(); }
});

test('a transient failure on resume keeps the conversation; only relaunch replaces it, and a failed relaunch restores it', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Fix login', '--request', 'fix it', '--reason', 'r', '--ticket', 'FAC-31']));
    const id = t.row(1).native_session_id;
    const transcript = path.join(t.dir, `${id}.jsonl`);
    fs.writeFileSync(transcript, '{}\n');
    t.patchRow(1, { transcript_path: transcript });
    ok(t.run(['report', '--summary', 'Button fixed; footer remains'], { ORCHESTRATOR_SESSION: '1' }));
    t.patchHerdr(s => { delete s.panes[first.pane_id]; s.failStart = 'timeout'; });

    const failed = t.run(['resume', 'S1', '--request', 'now the footer', '--reason', 'continuing']);
    assert.strictEqual(failed.status, 1);
    assert.match(failed.stderr, /conversation is intact[\s\S]*relaunch S1/);
    assert.strictEqual(t.row(1).native_session_id, id, 'a timeout is not a lost conversation');
    assert.strictEqual(t.row(1).pane_id, null);
    assert.strictEqual(Object.keys(t.herdrState().panes).length, 1, 'the failed tab is closed');

    const refused = t.run(['relaunch', 'S1', '--request', 'now the footer', '--reason', 'resume keeps failing']);
    assert.strictEqual(refused.status, 1);
    assert.strictEqual(t.row(1).native_session_id, id, 'a failed relaunch restores the recorded conversation');
    assert.ok(t.events(1).includes('relaunch-failed'));

    t.patchHerdr(s => { s.failStart = null; });
    const out = json(t.run(['relaunch', 'S1', '--json', '--request', 'now the footer', '--reason', 'resume keeps failing']));
    assert.strictEqual(out.action, 'relaunched');
    assert.strictEqual(out.previous, id);
    assert.notStrictEqual(t.row(1).native_session_id, id);
    const prompt = t.herdrState().prompts.at(-1).text;
    assert.match(prompt, /now the footer[\s\S]*Button fixed; footer remains[\s\S]*ticket FAC-31/);
    const d = t.open();
    assert.match(store.recentEvents(d, 1, 50).find(e => e.kind === 'relaunched').detail, new RegExp(`previous conversation ${id} at `));
    d.close();
  } finally { t.cleanup(); }
});

test('a Pi resume opens the session file when it exists and restarts with the full brief when it is gone', () => {
  const t = setup();
  try {
    const sessions = path.join(t.dir, 'pi-sessions');
    fs.mkdirSync(sessions);
    t.patchHerdr(s => { s.piSessionDir = sessions; });
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Queue work', '--request', 'build the queue', '--reason', 'r', '--harness', 'pi']));
    const row = t.row(1);
    assert.match(row.transcript_path, new RegExp(`${row.native_session_id}\\.jsonl$`), 'the session file is recorded at launch');
    assert.match(t.run(['resume', 'S1', '--request', 'x', '--reason', 'r']).stderr, /already running/, 'a path-form session is live');
    fs.writeFileSync(row.transcript_path, '{}\n');

    t.patchHerdr(s => { delete s.panes[first.pane_id]; });
    const resumed = json(t.run(['resume', 'S1', '--json', '--request', 'add retries', '--reason', 'r']));
    assert.strictEqual(resumed.action, 'resumed');
    assert.strictEqual(t.herdrState().prompts.at(-1).text, '[orchestrator S1] add retries');

    fs.rmSync(row.transcript_path);
    t.patchHerdr(s => { delete s.panes[resumed.pane_id]; });
    const restarted = json(t.run(['resume', 'S1', '--json', '--request', 'add backoff', '--reason', 'r']));
    assert.strictEqual(restarted.action, 'restarted');
    assert.match(restarted.why, /is gone/);
    assert.match(t.herdrState().prompts.at(-1).text, /add backoff[\s\S]*report --summary[\s\S]*This continues the work of session S1/);
  } finally { t.cleanup(); }
});

test('a tab waiting on the user keeps its brief held; a closed waiting tab hands the brief to the next start', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    t.patchHerdr(s => { s.blockStart = true; });
    const out = json(t.run(['new', '--json', '--title', 'New folder', '--request', 'build the importer', '--reason', 'r']));
    assert.strictEqual(out.action, 'waiting');
    assert.match(out.note, /trust or login prompt[\s\S]*deliver S1/);
    assert.ok(t.herdrState().panes[out.pane_id], 'the tab is kept for the user to answer');
    assert.strictEqual(t.herdrState().prompts.length, 0, 'nothing is typed into a prompt the user must answer');
    assert.match(t.run(['send', 'S1', '--request', 'x', '--reason', 'r']).stderr, /still holds prompts/);
    assert.match(t.run(['deliver', 'S1']).stderr, /is blocked/);

    t.patchHerdr(s => { delete s.panes[out.pane_id]; s.blockStart = false; });
    json(t.run(['resume', 'S1', '--json', '--request', 'continue', '--reason', 'r']));
    const prompt = t.herdrState().prompts.at(-1).text;
    assert.match(prompt, /continue[\s\S]*never reached a worker[\s\S]*build the importer/);
    assert.strictEqual(t.row(1).pending, null);
  } finally { t.cleanup(); }
});

test('an interrupted persona wait leaves the brief deliverable and never sends /brain twice', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    t.patchHerdr(s => { s.promptPlan = ['hang:4000']; });
    const killed = t.run(['new', '--title', 'Slow', '--request', 'audit the API', '--reason', 'r', '--persona', 'scout'], {}, undefined, { timeout: 1500 });
    assert.notStrictEqual(killed.status, 0, 'the CLI was killed mid-wait');
    const held = store.pendingOf(t.row(1));
    assert.deepStrictEqual(held.map(e => e.state), ['sending', 'pending']);
    sleep(3000); // let the fake's hung prompt finish
    const out = json(t.run(['deliver', 'S1', '--json']));
    assert.match(out.skipped, /1 prompt/);
    const texts = t.herdrState().prompts.map(p => p.text);
    assert.strictEqual(texts.filter(x => x.startsWith('/brain')).length, 1);
    assert.match(texts.at(-1), /^\[orchestrator S1\] audit the API/);
  } finally { t.cleanup(); }
});

test('an accepted but stalled persona prompt is not resent; a rejected prompt stays held', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    t.patchHerdr(s => { s.promptPlan = ['stall']; });
    const out = json(t.run(['new', '--json', '--title', 'Slow', '--request', 'go', '--reason', 'r', '--persona', 'scout']));
    assert.strictEqual(out.action, 'waiting');
    assert.match(out.note, /still held/);
    t.patchHerdr(s => { s.promptPlan = ['reject']; });
    assert.match(t.run(['deliver', 'S1']).stderr, /1 prompt\(s\) still held/);
    ok(t.run(['deliver', 'S1']));
    const texts = t.herdrState().prompts.map(p => p.text);
    assert.strictEqual(texts.length, 2);
    assert.match(texts[1], /^\[orchestrator S1\] go/);
  } finally { t.cleanup(); }
});

test('a start failure whose cleanup fails keeps the tab recorded and blocks a duplicate until it is closed', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    t.patchHerdr(s => { s.failStart = 'failed'; s.failClose = true; });
    const r = t.run(['new', '--title', 'Flaky', '--request', 'go', '--reason', 'r']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /could not be closed and stays recorded/);
    const kept = t.row(1);
    assert.ok(kept.pane_id && t.herdrState().panes[kept.pane_id], 'the orphan is recorded, not forgotten');
    t.patchHerdr(s => { s.failStart = null; });
    assert.match(t.run(['resume', 'S1', '--request', 'go', '--reason', 'r']).stderr, /still open and could not be closed/);
    assert.strictEqual(Object.keys(t.herdrState().panes).length, 2, 'no second worker');
    t.patchHerdr(s => { s.failClose = false; });
    const out = json(t.run(['resume', 'S1', '--json', '--request', 'go', '--reason', 'r']));
    assert.strictEqual(out.action, 'restarted');
    assert.strictEqual(t.herdrState().panes[kept.pane_id], undefined, 'the leftover tab is closed first');
  } finally { t.cleanup(); }
});

test('reconcile adopts a conversation resumed in another tab in the same pass; resume adopts one opened later', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Fix login', '--request', 'fix', '--reason', 'r']));
    const id = t.row(1).native_session_id;
    const handResume = pane => t.patchHerdr(s => {
      s.panes[pane] = { pane_id: pane, tab_id: `t-${pane}`, agent: 'claude', agent_status: 'idle', agent_session: { kind: 'id', value: id } };
    });
    t.patchHerdr(s => { delete s.panes[first.pane_id]; });
    handResume('w1:p50');
    assert.deepStrictEqual(json(t.run(['reconcile', '--json'])), { closed: ['S1'], adopted: ['S1'] });
    assert.strictEqual(t.row(1).pane_id, 'w1:p50');

    t.patchHerdr(s => { delete s.panes['w1:p50']; });
    ok(t.run(['reconcile']));
    handResume('w1:p51');
    const r = t.run(['resume', 'S1', '--request', 'more', '--reason', 'r']);
    assert.match(r.stderr, /already running in pane w1:p51.*adopted/);
    assert.strictEqual(t.row(1).pane_id, 'w1:p51');
    assert.ok(!t.herdrState().calls.some(c => c[0] === 'tab' && c[1] === 'create' && t.herdrState().seq > 1), 'no second worker');
    ok(t.run(['send', 'S1', '--request', 'more', '--reason', 'r']));
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
    assert.strictEqual(t.row(2).ticket, 'FAC-31');
    assert.strictEqual(t.row(2).parent_id, 1);
    assert.strictEqual(t.row(1).status, 'resolved');
  } finally { t.cleanup(); }
});

test('new --from an open session supersedes it', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    ok(t.run(['new', '--title', 'Long session', '--request', 'a', '--reason', 'r']));
    ok(t.run(['new', '--from', 'S1', '--title', 'Fresh start', '--request', 'b', '--reason', 'S1 compacted 4 times']));
    assert.strictEqual(t.row(1).status, 'superseded');
    const listed = ok(t.run(['find'])).stdout;
    assert.match(listed, /^S2 · open/);
    assert.doesNotMatch(listed, /S1 ·/);
    assert.match(ok(t.run(['find', '--all'])).stdout, /S1 · superseded/);
  } finally { t.cleanup(); }
});

// ─── Recorders ───────────────────────────────────────────────────────────────

test('the Claude hook records prompts, compactions, the transcript, and a /clear; it prints nothing and is inert elsewhere', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    ok(t.run(['new', '--title', 'Fix login', '--request', 'fix it', '--reason', 'r']));
    const hook = (payload, extra = { ORCHESTRATOR_SESSION: '1' }) => {
      const r = ok(t.run(['hook', 'claude'], extra, JSON.stringify(payload)));
      assert.strictEqual(r.stdout, '', 'a hook must not inject context');
      assert.strictEqual(r.stderr, '');
    };
    const native = t.row(1).native_session_id;
    hook({ hook_event_name: 'SessionStart', session_id: native, source: 'startup', transcript_path: '/t/x.jsonl' });
    hook({ hook_event_name: 'UserPromptSubmit', session_id: native, prompt: '[orchestrator S1] fix it' });
    hook({ hook_event_name: 'UserPromptSubmit', session_id: native, prompt: 'also check dark mode' });
    hook({ hook_event_name: 'PreCompact', session_id: native, trigger: 'auto' });
    hook({ hook_event_name: 'SessionStart', session_id: 'after-clear', source: 'clear' });
    hook({ hook_event_name: 'UserPromptSubmit', session_id: 'x', prompt: 'not tracked' }, { ORCHESTRATOR_SESSION: '' });
    const d = t.open();
    assert.deepStrictEqual(store.recentPrompts(d, 1).map(p => [p.source, p.text]), [
      ['orchestrator', '[orchestrator S1] fix it'], ['direct', 'also check dark mode']]);
    d.close();
    const row = t.row(1);
    assert.strictEqual(row.compactions, 1);
    assert.ok(row.last_compacted_at);
    assert.strictEqual(row.transcript_path, '/t/x.jsonl');
    assert.strictEqual(row.native_session_id, 'after-clear');
  } finally { t.cleanup(); }
});

test('a recorder never creates a record, never fails on an unusable one, and never prints', () => {
  const t = setup();
  try {
    const missing = path.join(t.dir, 'gone', '.agent-brain', 'orchestrator.db');
    const unusable = path.join(t.dir, 'a-directory.db');
    fs.mkdirSync(unusable);
    for (const db of [missing, unusable]) {
      const r = ok(t.run(['hook', 'claude'], { ORCHESTRATOR_SESSION: '1', ORCHESTRATOR_DB: db },
        JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'x', prompt: 'hello' })));
      assert.strictEqual(r.stdout + r.stderr, '');
    }
    assert.ok(!fs.existsSync(path.dirname(missing)), 'no record is created where none exists');
  } finally { t.cleanup(); }
});

test('under a held write lock the recorders stay bounded and silent, and record again once it clears', async () => {
  const t = setup();
  const saved = { db: process.env.ORCHESTRATOR_DB, session: process.env.ORCHESTRATOR_SESSION, cli: process.env.ORCHESTRATOR_CLI, node: process.env.ORCHESTRATOR_NODE };
  try {
    const d = t.open();
    const id = store.createSession(d, { title: 'pi work', intent: 'i', harness: 'pi', native_session_id: 'p-1', cwd: t.dir });
    d.exec('BEGIN IMMEDIATE'); // another writer holds the record

    const started = Date.now();
    const blocked = t.run(['hook', 'claude'], { ORCHESTRATOR_SESSION: String(id) },
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'p-1', prompt: 'lost to contention' }));
    assert.strictEqual(blocked.status, 0);
    assert.strictEqual(blocked.stdout + blocked.stderr, '');
    assert.ok(Date.now() - started < 4000, `the Claude hook waited ${Date.now() - started}ms`);

    Object.assign(process.env, { ORCHESTRATOR_DB: t.db, ORCHESTRATOR_SESSION: String(id), ORCHESTRATOR_CLI: CLI, ORCHESTRATOR_NODE: process.execPath });
    const handlers = {};
    require(path.join(SCRIPTS, 'pi-extension.js'))({ on: (name, fn) => { handlers[name] = fn; } });
    const before = Date.now();
    handlers.input({ text: 'please fix the queue', source: 'interactive' });
    handlers.input({ text: 'injected', source: 'extension' });
    handlers.session_compact({ reason: 'threshold' });
    assert.ok(Date.now() - before < 200, 'Pi never waits on the record');

    await new Promise(r => setTimeout(r, 1000)); // Pi's loop keeps running; its writers wait on the record
    d.exec('COMMIT');
    d.close();
    const recorded = () => { const c = t.open(); try { return store.promptCount(c, id) === 1 && store.getSession(c, id).compactions === 1; } finally { c.close(); } };
    for (let i = 0; i < 100 && !recorded(); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(recorded(), 'Pi events recorded once the lock cleared');
    ok(t.run(['hook', 'claude'], { ORCHESTRATOR_SESSION: String(id) },
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'p-1', prompt: 'after contention' })));
    const check = t.open();
    assert.deepStrictEqual(store.recentPrompts(check, id).map(p => p.text).sort(), ['after contention', 'please fix the queue']);
    check.close();
    assert.match(fs.readFileSync(`${t.db}.hook.log`, 'utf8'), /claude prompt: .*(locked|busy)/i);
  } finally {
    for (const [k, v] of Object.entries({ ORCHESTRATOR_DB: saved.db, ORCHESTRATOR_SESSION: saved.session, ORCHESTRATOR_CLI: saved.cli, ORCHESTRATOR_NODE: saved.node })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    t.cleanup();
  }
});

test('the Pi extension does nothing outside a worker', () => {
  const saved = process.env.ORCHESTRATOR_DB;
  delete process.env.ORCHESTRATOR_DB;
  try {
    const handlers = {};
    require(path.join(SCRIPTS, 'pi-extension.js'))({ on: (name, fn) => { handlers[name] = fn; } });
    assert.deepStrictEqual(Object.keys(handlers), []);
  } finally { if (saved !== undefined) process.env.ORCHESTRATOR_DB = saved; }
});

test('concurrent compactions are all counted', async () => {
  const t = setup();
  try {
    const d = t.open();
    const id = store.createSession(d, { title: 'busy', intent: 'i', harness: 'claude', native_session_id: 'c-1', cwd: t.dir });
    d.close();
    const runs = Array.from({ length: 12 }, () => new Promise(resolve => {
      const child = spawn(process.execPath, [CLI, 'hook', 'claude'], { env: { ...t.env, ORCHESTRATOR_SESSION: String(id) } });
      child.stdin.end(JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'c-1', trigger: 'auto' }));
      child.on('close', resolve);
    }));
    await Promise.all(runs);
    assert.strictEqual(t.row(id).compactions, 12);
  } finally { t.cleanup(); }
});

test('records opened at the same moment for the first time all succeed', async () => {
  const t = setup();
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => t.runAsync(['find'])));
    assert.deepStrictEqual(results.map(r => r.status), [0, 0, 0, 0, 0, 0], results.map(r => r.stderr).join('\n'));
  } finally { t.cleanup(); }
});

// ─── Status, stop, report ────────────────────────────────────────────────────

test('status --ask returns the refreshed record only when the worker answered', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Fix login', '--request', 'fix', '--reason', 'r']));
    ok(t.run(['report', '--summary', 'old summary'], { ORCHESTRATOR_SESSION: '1' }));
    const report = `ORCHESTRATOR_SESSION=1 ORCHESTRATOR_DB='${t.db}' '${process.execPath}' '${CLI}' report --summary 'fresh: footer done'`;
    t.patchHerdr(s => { s.onPromptWait = report; });
    const asked = ok(t.run(['status', 'S1', '--ask'])).stdout;
    assert.match(asked, /^refreshed: yes/);
    assert.match(asked, /summary: fresh: footer done/);
    assert.ok(t.herdrState().prompts.at(-1).wait, 'the ask waits for the worker to take and finish its turn');

    t.patchHerdr(s => { s.onPromptWait = null; s.promptPlan = ['timeout']; });
    assert.match(ok(t.run(['status', 'S1', '--ask'])).stdout, /^refreshed: no: .*timed out/);

    t.patchHerdr(s => { s.panes[first.pane_id].agent_status = 'working'; });
    const prompts = t.herdrState().prompts.length;
    assert.match(ok(t.run(['status', 'S1', '--ask'])).stdout, /^refreshed: no: the worker is working, so it was not asked/);
    assert.strictEqual(t.herdrState().prompts.length, prompts);
  } finally { t.cleanup(); }
});

test('stop closes a settled worker, refuses a mid-turn or permission-blocked one, and keeps the record', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Fix login', '--request', 'fix it', '--reason', 'r', '--persona', 'web-engineer']));
    ok(t.run(['report', '--ticket', 'FAC-40'], { ORCHESTRATOR_SESSION: '1' }));
    assert.deepStrictEqual(t.herdrState().renames.at(-1), [first.tab_id, 'FAC-40 S1 fix-login (web-engineer)']);
    assert.strictEqual(t.run(['report'], { ORCHESTRATOR_SESSION: '1' }).status, 2);

    for (const status of ['working', 'blocked']) {
      t.patchHerdr(s => { s.panes[first.pane_id].agent_status = status; });
      assert.match(t.run(['stop', 'S1']).stderr, new RegExp(`is ${status}; wait for it to settle`));
    }
    t.patchHerdr(s => { s.panes[first.pane_id].agent_status = 'idle'; });
    assert.strictEqual(json(t.run(['stop', 'S1', '--json'])).action, 'closed');
    assert.strictEqual(t.herdrState().panes[first.pane_id], undefined);
    assert.strictEqual(t.row(1).status, 'open', 'closing a tab does not resolve the work');
    assert.match(ok(t.run(['status', 'S1'])).stdout, /tab closed[\s\S]*events: .*stopped/);

    t.patchHerdr(s => { s.blockStart = true; });
    const waiting = json(t.run(['resume', 'S1', '--json', '--request', 'x', '--reason', 'r']));
    assert.strictEqual(waiting.action, 'waiting');
    assert.strictEqual(json(t.run(['stop', 'S1', '--json'])).action, 'closed', 'a tab blocked before its first prompt may close');
  } finally { t.cleanup(); }
});

// ─── Paths ───────────────────────────────────────────────────────────────────

test('the record, its sidecars, and its companions are kept out of git, also under a custom name', () => {
  const t = setup();
  try {
    const project = path.join(t.dir, 'project');
    fs.mkdirSync(project, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: project });
    const start = db => ok(spawnSync(process.execPath, [CLI, 'start', ...(db ? ['--db', db] : [])], { cwd: project, encoding: 'utf8',
      env: { ...t.env, ORCHESTRATOR_DB: '' } }));
    start();
    start('.agent-brain/workers.db');
    for (const f of ['orchestrator.db', 'orchestrator.db-wal', 'orchestrator.db.claude-settings.json', 'workers.db', 'workers.db-wal', 'workers.db-shm', 'workers.db.hook.log']) {
      fs.writeFileSync(path.join(project, '.agent-brain', f), fs.existsSync(path.join(project, '.agent-brain', f)) ? fs.readFileSync(path.join(project, '.agent-brain', f)) : '');
    }
    fs.writeFileSync(path.join(project, '.agent-brain', 'notes.txt'), 'x');
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: project, encoding: 'utf8' });
    assert.strictEqual(status.trim(), '?? .agent-brain/notes.txt');
  } finally { t.cleanup(); }
});

test('the project root is the main working tree for linked worktrees, submodules, and separate git dirs', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-root-')));
  const g = (cwd, ...args) => execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, stdio: 'ignore' });
  const commit = cwd => g(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  try {
    const main = path.join(dir, 'main');
    fs.mkdirSync(main);
    g(main, 'init', '-q'); commit(main);
    assert.strictEqual(projectRoot(main), main);
    g(main, 'worktree', 'add', '-q', path.join(dir, 'linked'));
    assert.strictEqual(projectRoot(path.join(dir, 'linked')), main, 'a linked worktree shares the main record');

    const lib = path.join(dir, 'lib');
    fs.mkdirSync(lib);
    g(lib, 'init', '-q'); commit(lib);
    g(main, 'submodule', 'add', '-q', lib, 'vendor/lib');
    assert.strictEqual(projectRoot(path.join(main, 'vendor', 'lib')), path.join(main, 'vendor', 'lib'));

    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    g(dir, 'init', '-q', '--separate-git-dir', path.join(dir, 'store.git'), work); commit(work);
    assert.strictEqual(projectRoot(work), work);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
