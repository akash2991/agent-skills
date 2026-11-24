'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
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
  if (s.failPaneGet && args[2] !== 'w1:p0') { process.stdout.write(JSON.stringify({ id: 'fake', error: { code: 'failed', message: 'socket error' } })); process.exit(1); }
  const pane = s.panes[args[2]];
  pane ? okRead({ pane }) : (process.stdout.write(JSON.stringify({ id: 'fake', error: { code: 'pane_not_found', message: 'pane ' + args[2] + ' not found' } })), process.exit(1));
} else if (group === 'agent' && verb === 'list') {
  if (s.failAgentList) { process.stdout.write(JSON.stringify({ id: 'fake', error: { code: 'failed', message: 'socket error' } })); process.exit(1); }
  okRead({ agents: agents() });
} else if (group === 'tab' && verb === 'create') {
  if (s.failTabCreate) fail('failed', 'server unavailable');
  if (s.hangTabCreate && s.hangLeavesTab) { const n = ++s.seq; s.panes['w1:p' + n] = { pane_id: 'w1:p' + n, tab_id: 'w1:t' + n, agent: null, env: [] }; save(); }
  if (s.hangTabCreate) { const end = Date.now() + s.hangTabCreate; while (Date.now() < end) {} process.exit(0); }
  if (s.badTabCreate) ok({});
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
  let pane = s.panes[args[args.indexOf('--pane') + 1]];
  const rest = args.slice(args.indexOf('--') + 1);
  pane.args = rest;
  if (s.onStart) {
    // Another command runs while this agent starts; it may change the state.
    // During the hook, starts fail as innerFailStart says; this one as failStart.
    const hook = s.onStart;
    const outer = s.failStart;
    s.onStart = null;
    s.failStart = s.innerFailStart || null;
    save();
    try { execSync(hook, { stdio: 'ignore' }); } catch { /* the other command may fail; the test checks it */ }
    Object.assign(s, JSON.parse(fs.readFileSync(file, 'utf8')));
    s.failStart = outer;
    s.innerFailStart = null;
    pane = s.panes[args[args.indexOf('--pane') + 1]];
  }
  if (s.failStart) fail(s.failStart, 'agent start failed (' + s.failStart + ')');
  const at = Math.max(rest.indexOf('--session-id'), rest.indexOf('--resume'));
  const native = at >= 0 ? rest[at + 1] : 'untracked';
  // As Claude does: --resume opens only a conversation that was written.
  s.written = s.written || [];
  if (rest.includes('--resume') && !s.written.includes(native) && !s.anyResume) fail('failed', 'No conversation found with session ID: ' + native);
  if (native !== 'untracked') s.written.push(native);
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
  // Hangs before the worker accepts the prompt, so it never arrives.
  if (step.startsWith('lost')) { save(); const end = Date.now() + Number(step.split(':')[1]); while (Date.now() < end) {} process.exit(0); }
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

test('a tab label follows DS2: <worktree> (<persona>) once reported, <ticket> <scope> (<persona>) until then', () => {
  assert.strictEqual(tabLabel({ id: 3, title: 'Fix login button', ticket: 'FAC-31', persona: 'web-engineer' }), 'FAC-31 S3 fix-login-button (web-engineer)');
  assert.strictEqual(tabLabel({ id: 4, title: 'Spike: queues?' }), 'S4 spike-queues');
  assert.strictEqual(tabLabel({ id: 3, title: 'Fix login button', ticket: 'FAC-31', persona: 'web-engineer', worktree: '/w/FAC-31-login-fix' }), 'FAC-31-login-fix (web-engineer)');
  assert.strictEqual(tabLabel({ id: 3, title: 'x', worktree: '/w/FAC-31-login-fix/' }), 'FAC-31-login-fix');
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
  const pi = harnessArgs({ ...row, harness: 'pi', model: null, transcript_path: '/s/x_u-1.jsonl' }, true);
  assert.deepStrictEqual(pi.slice(0, 2), ['--session', '/s/x_u-1.jsonl'], 'a Pi resume names its exact file');
  assert.deepStrictEqual(harnessArgs({ ...row, harness: 'pi' }, false).slice(0, 2), ['--session-id', 'u-1']);
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
      ok(t.run(['find'])); // create the record first, so the race is over ownership
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

test('resume reopens the conversation by id or recorded file; a known-gone transcript restarts the same id with the full brief', () => {
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
    const byId = json(t.run(['resume', 'S1', '--json', '--request', 'signup too', '--reason', 'r']));
    assert.strictEqual(byId.action, 'resumed', 'an unrecorded Claude transcript is resumed by id, never assumed absent');
    assert.deepStrictEqual(t.herdrState().panes[byId.pane_id].args.slice(0, 2), ['--resume', id]);
    assert.strictEqual(t.herdrState().prompts.at(-1).text, '[orchestrator S1] signup too');

    const transcript = path.join(t.dir, `${id}.jsonl`);
    t.patchRow(1, { transcript_path: transcript }); // recorded, then deleted
    t.patchHerdr(s => { delete s.panes[byId.pane_id]; });
    const restarted = json(t.run(['resume', 'S1', '--json', '--request', 'and the reset page', '--reason', 'r']));
    assert.strictEqual(restarted.action, 'restarted');
    assert.match(restarted.why, /is gone/);
    assert.deepStrictEqual(t.herdrState().panes[restarted.pane_id].args.slice(0, 2), ['--session-id', id]);
    assert.match(t.herdrState().prompts.at(-1).text, /and the reset page[\s\S]*This continues the work of session S1/);

    fs.writeFileSync(transcript, '{}\n');
    t.patchHerdr(s => { delete s.panes[restarted.pane_id]; });
    const resumed = json(t.run(['resume', 'S1', '--json', '--request', 'and the 404 page', '--reason', 'r']));
    assert.strictEqual(resumed.action, 'resumed');
    assert.deepStrictEqual(t.herdrState().panes[resumed.pane_id].args.slice(0, 2), ['--resume', id]);
    assert.strictEqual(t.row(1).launches, 4);
  } finally { t.cleanup(); }
});

test('a failed resume changes nothing, so a retry sends the request once; held work survives', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Fix login', '--request', 'fix it', '--reason', 'r']));
    const id = t.row(1).native_session_id;
    const transcript = path.join(t.dir, `${id}.jsonl`);
    fs.writeFileSync(transcript, '{}\n');
    t.patchRow(1, { transcript_path: transcript, pending: JSON.stringify([{ text: '[orchestrator S1] earlier held ask', state: 'pending' }]) });
    t.patchHerdr(s => { delete s.panes[first.pane_id]; s.failStart = 'timeout'; });
    const before = t.row(1);

    const failed = t.run(['resume', 'S1', '--request', 'now the footer', '--reason', 'continuing']);
    assert.strictEqual(failed.status, 1);
    assert.match(failed.stderr, /Nothing changed[\s\S]*relaunch S1/);
    const after = t.row(1);
    for (const k of ['native_session_id', 'transcript_path', 'launches', 'pending']) assert.strictEqual(after[k], before[k], k);
    assert.strictEqual(after.pane_id, null, 'only the closed tab is cleared');
    assert.strictEqual(Object.keys(t.herdrState().panes).length, 1, 'the failed tab is closed');

    t.patchHerdr(s => { s.failStart = null; });
    const prompts = t.herdrState().prompts.length;
    ok(t.run(['resume', 'S1', '--request', 'now the footer', '--reason', 'continuing']));
    assert.deepStrictEqual(t.herdrState().prompts.slice(prompts).map(p => p.text),
      ['[orchestrator S1] earlier held ask', '[orchestrator S1] now the footer']);
  } finally { t.cleanup(); }
});

test('relaunch replaces the conversation only when a worker may have started, and records the old one', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Fix login', '--request', 'fix it', '--reason', 'r', '--ticket', 'FAC-31']));
    const id = t.row(1).native_session_id;
    const transcript = path.join(t.dir, `${id}.jsonl`);
    fs.writeFileSync(transcript, '{}\n');
    t.patchRow(1, { transcript_path: transcript });
    ok(t.run(['report', '--summary', 'Button fixed; footer remains'], { ORCHESTRATOR_SESSION: '1' }));
    t.patchHerdr(s => { delete s.panes[first.pane_id]; });

    for (const [failure, patch] of [['agent start', s => { s.failStart = 'failed'; }], ['tab create', s => { s.failTabCreate = true; }],
      ['a malformed tab create', s => { s.badTabCreate = true; }]]) {
      t.patchHerdr(patch);
      const r = t.run(['relaunch', 'S1', '--request', 'now the footer', '--reason', 'resume keeps failing']);
      assert.strictEqual(r.status, 1, failure);
      assert.match(r.stderr, /previous conversation is still the recorded one/, failure);
      assert.strictEqual(t.row(1).native_session_id, id, failure);
      assert.strictEqual(t.row(1).transcript_path, transcript, failure);
      t.patchHerdr(s => { s.failStart = null; s.failTabCreate = false; s.badTabCreate = false; });
    }

    // herdr times out creating the tab: nothing was recorded, so nothing is claimed as kept.
    t.patchHerdr(s => { s.promptPlan = []; s.hangTabCreate = 2500; });
    const timedOut = t.run(['relaunch', 'S1', '--request', 'now the footer', '--reason', 'r'], { ORCHESTRATOR_HERDR_TIMEOUT_MS: '1000' });
    assert.match(timedOut.stderr, /Nothing changed in the record[\s\S]*empty tab may be open/);
    assert.doesNotMatch(timedOut.stderr, /Its tab is kept/);
    assert.strictEqual(t.row(1).native_session_id, id);
    sleep(2000);
    t.patchHerdr(s => { s.hangTabCreate = 0; });
    const d0 = t.open();
    assert.match(store.recentEvents(d0, 1, 50).filter(e => e.kind === 'relaunch-failed').at(-1).detail, /^restored the previous conversation/);
    // Each attempt is its own decision, and none claims a relaunch that did not happen.
    assert.deepStrictEqual(store.recentDecisions(d0, 1, 4).map(x => x.outcome.split(':')[0]), ['failed', 'failed', 'failed', 'failed']);
    d0.close();
    assert.ok(!t.events(1).includes('relaunched'));
    assert.strictEqual(t.events(1).filter(k => k === 'relaunch-staged').length, 1, 'only the agent-start failure staged a replacement');

    const out = json(t.run(['relaunch', 'S1', '--json', '--request', 'now the footer', '--reason', 'resume keeps failing']));
    assert.strictEqual(out.action, 'relaunched');
    assert.strictEqual(out.previous, id);
    assert.notStrictEqual(t.row(1).native_session_id, id);
    assert.strictEqual(t.row(1).transcript_path, null);
    assert.match(t.herdrState().prompts.at(-1).text, /now the footer[\s\S]*ticket FAC-31[\s\S]*Button fixed; footer remains/);
    const d = t.open();
    assert.match(store.recentEvents(d, 1, 50).find(e => e.kind === 'relaunched').detail, new RegExp(`previous conversation ${id} at `));
    assert.strictEqual(store.recentDecisions(d, 1, 1)[0].outcome, 'relaunched');
    d.close();
  } finally { t.cleanup(); }
});

test('every decision records how its route ended; a refused route records none', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    const outcomes = () => { const d = t.open(); try { return store.recentDecisions(d, 1, 20).map(x => `${x.action} ${x.outcome}`); } finally { d.close(); } };
    assert.deepStrictEqual(outcomes(), ['new new']);
    ok(t.run(['send', 'S1', '--request', 'also the footer', '--reason', 'r']));
    t.patchHerdr(s => { s.promptPlan = ['reject']; });
    t.run(['send', 'S1', '--request', 'then the header', '--reason', 'r']);
    ok(t.run(['deliver', 'S1']));
    t.patchHerdr(s => { s.promptPlan = ['hang:2500']; });
    t.run(['send', 'S1', '--request', 'then the banner', '--reason', 'r'], { ORCHESTRATOR_HERDR_TIMEOUT_MS: '1000' });
    sleep(2000);
    ok(t.run(['settle', 'S1', '--drop']));
    t.patchHerdr(s => { delete s.panes[first.pane_id]; s.failStart = 'failed'; });
    t.run(['resume', 'S1', '--request', 'and the logo', '--reason', 'r']);
    t.patchHerdr(s => { s.failStart = null; });
    ok(t.run(['resume', 'S1', '--request', 'and the logo', '--reason', 'retry']));
    const got = outcomes();
    assert.deepStrictEqual(got.map(x => x.split(':')[0]), ['new new', 'send sent', 'send held', 'send unknown', 'resume failed', 'resume resumed']);

    // A Pi session whose file was never recorded is refused before any decision.
    const d = t.open();
    d.prepare("UPDATE sessions SET harness = 'pi', transcript_path = NULL, pane_id = NULL, tab_id = NULL WHERE id = 1").run();
    d.close();
    t.patchHerdr(s => { s.panes = {}; });
    assert.match(t.run(['resume', 'S1', '--request', 'x', '--reason', 'r']).stderr, /never recorded/);
    assert.strictEqual(outcomes().length, got.length);

    const status = ok(t.run(['status', 'S1'])).stdout;
    assert.match(status, /decisions:\n[\s\S]*send -> unknown: [\s\S]*resume -> failed: [\s\S]*resume -> resumed/);
  } finally { t.cleanup(); }
});

test('new --from supersedes its parent only once the new session has a worker', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    t.patchHerdr(s => { s.failStart = 'failed'; });
    assert.match(t.run(['new', '--from', 'S1', '--title', 'Site 2', '--request', 'the footer', '--reason', 'S1 is stale']).stderr, /no agent started/);
    assert.strictEqual(t.row(1).status, 'open', 'a confirmed failure leaves the parent open');
    t.patchHerdr(s => { s.failStart = null; });
    ok(t.run(['resume', 'S2', '--reason', 'retry the failed start']));
    assert.strictEqual(t.row(1).status, 'superseded');
    assert.ok(t.events(1).includes('superseded'));

    ok(t.run(['reopen', 'S1']));
    ok(t.run(['new', '--from', 'S1', '--title', 'Site 3', '--request', 'the header', '--reason', 'S1 is stale']));
    assert.strictEqual(t.row(1).status, 'superseded', 'a launch that succeeds supersedes at once');

    // A launch that may have started a worker supersedes too.
    ok(t.run(['reopen', 'S1']));
    t.patchHerdr(s => { s.failStart = 'failed'; s.failClose = true; });
    assert.match(t.run(['new', '--from', 'S1', '--title', 'Site 4', '--request', 'the logo', '--reason', 'r']).stderr, /uncertain/);
    assert.strictEqual(t.row(1).status, 'superseded');
  } finally { t.cleanup(); }
});

test('a parent the user reopened stays open when its child is resumed or relaunched later', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    const child = json(t.run(['new', '--json', '--from', 'S1', '--title', 'Site 2', '--request', 'the footer', '--reason', 'S1 is stale']));
    assert.strictEqual(t.row(1).status, 'superseded');
    ok(t.run(['reopen', 'S1', '--reason', 'the user wants S1 back']));
    t.patchHerdr(s => { delete s.panes[child.pane_id]; });
    const resumed = json(t.run(['resume', 'S2', '--json', '--request', 'and the header', '--reason', 'its tab was closed']));
    t.patchHerdr(s => { delete s.panes[resumed.pane_id]; });
    ok(t.run(['relaunch', 'S2', '--request', 'and the logo', '--reason', 'stale context']));
    assert.strictEqual(t.row(1).status, 'open');
    assert.strictEqual(t.events(1).filter(k => k === 'superseded').length, 1);
    ok(t.run(['send', 'S1', '--request', 'one more thing', '--reason', 'r']));
  } finally { t.cleanup(); }
});

test('an outcome that cannot be written never changes the route\'s result or its error', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    const d = t.open();
    d.exec("CREATE TRIGGER no_outcome BEFORE UPDATE OF outcome ON decisions BEGIN SELECT RAISE(ABORT, 'injected'); END");
    d.close();
    const count = re => t.herdrState().prompts.filter(p => re.test(p.text)).length;

    const sent = ok(t.run(['send', 'S1', '--json', '--request', 'also the footer', '--reason', 'r']));
    assert.strictEqual(JSON.parse(sent.stdout).action, 'sent');
    assert.match(sent.stderr, /warning: the outcome of decision \d+ was not recorded \(injected\)/);
    assert.strictEqual(count(/also the footer/), 1);

    const made = JSON.parse(ok(t.run(['new', '--json', '--title', 'Docs', '--request', 'write the docs', '--reason', 'r'])).stdout);
    assert.strictEqual(made.session, 'S2');
    assert.ok(made.pane_id);
    assert.strictEqual(Object.values(t.herdrState().panes).filter(p => p.agent && p.pane_id !== 'w1:p0').length, 2, 'one worker each');

    t.patchHerdr(s => { s.promptPlan = ['reject']; });
    const held = t.run(['send', 'S1', '--request', 'then the header', '--reason', 'r']);
    assert.strictEqual(held.status, 1);
    assert.match(held.stderr, /the request is held: run deliver S1/);
    assert.strictEqual(store.pendingOf(t.row(1)).length, 1);

    t.patchHerdr(s => { s.failStart = 'failed'; s.failClose = true; });
    const uncertain = t.run(['new', '--title', 'Logo', '--request', 'the logo', '--reason', 'r']);
    assert.match(uncertain.stderr, /whether its agent started is uncertain[\s\S]*Its tab is kept/);
    assert.ok(t.row(3).pane_id, 'the uncertain tab stays recorded');
  } finally { t.cleanup(); }
});

test('a failure after the worker started is never a refusal: it keeps the worker, held work, and supersession', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    const outcome = id => { const d = t.open(); try { return store.recentDecisions(d, id, 1)[0].outcome; } finally { d.close(); } };

    // Herdr cannot say where Pi keeps its session: the launch goes on without it.
    t.patchHerdr(s => { s.failPaneGet = true; });
    const pi = json(t.run(['new', '--json', '--from', 'S1', '--harness', 'pi', '--title', 'Site 2', '--request', 'the footer', '--reason', 'r']));
    t.patchHerdr(s => { s.failPaneGet = false; });
    assert.strictEqual(pi.action, 'new');
    assert.ok(t.events(2).includes('transcript-unknown'));
    assert.strictEqual(t.row(1).status, 'superseded');
    assert.strictEqual(outcome(2), 'new');

    // The record fails right after the agent started, before the first prompt
    // goes: the outcome says so, the brief stays held for deliver, and the
    // parent is superseded once, with the placement.
    ok(t.run(['reopen', 'S1']));
    const d = t.open();
    d.exec(`CREATE TRIGGER no_sending BEFORE UPDATE OF pending ON sessions WHEN NEW.pending LIKE '%"sending"%'
      BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    d.close();
    const r = t.run(['new', '--from', 'S1', '--title', 'Site 3', '--request', 'the header', '--reason', 'r']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /S3's worker started in pane \S+, but recording or delivering to it failed: [\s\S]*deliver S3/);
    assert.match(outcome(3), /^started-then-failed: /);
    assert.ok(t.row(3).pane_id, 'the running worker stays recorded');
    assert.ok(store.pendingOf(t.row(3)).length > 0, 'its brief is still held');
    assert.strictEqual(t.row(1).status, 'superseded');
    const workers = Object.values(t.herdrState().panes).filter(p => p.agent).length;
    const d2 = t.open();
    d2.exec('DROP TRIGGER no_sending');
    d2.close();
    ok(t.run(['deliver', 'S3']));
    assert.strictEqual(t.herdrState().prompts.filter(p => /the header/.test(p.text)).length, 1);
    assert.strictEqual(Object.values(t.herdrState().panes).filter(p => p.agent).length, workers, 'no second worker');
  } finally { t.cleanup(); }
});

// A trigger that aborts one kind of event insert, to show history never
// decides a route's result.
const failEvent = (t, kind) => {
  const d = t.open();
  d.exec(`CREATE TRIGGER no_${kind.replace(/-/g, '_')} BEFORE INSERT ON events WHEN NEW.kind = '${kind}' BEGIN SELECT RAISE(ABORT, 'injected'); END`);
  d.close();
};

test('a relaunch whose relaunched event cannot be written still reports its result, and delivers once', () => {
  for (const [plan, expect] of [[[], 'relaunched'], [['reject'], 'waiting'], [['hang:2500'], 'waiting']]) {
    const t = setup();
    try {
      ok(t.run(['start']));
      const first = json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
      t.patchHerdr(s => { delete s.panes[first.pane_id]; });
      failEvent(t, 'relaunched');
      // The brief goes in one prompt, so the plan applies to it.
      t.patchHerdr(s => { s.promptPlan = plan.slice(); });
      const r = ok(t.run(['relaunch', 'S1', '--json', '--request', 'and the logo', '--reason', 'stale'], { ORCHESTRATOR_HERDR_TIMEOUT_MS: '1000' }));
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.action, expect, plan.join());
      assert.ok(out.pane_id);
      assert.match(r.stderr, /warning: S1's relaunched event was not recorded \(injected\)/);
      if (plan[0] === 'reject') { assert.strictEqual(out.waiting, 'busy'); assert.match(out.note, /deliver S1/); }
      if (plan[0] === 'hang:2500') { assert.strictEqual(out.waiting, 'unknown'); assert.match(out.note, /settle S1/); sleep(2000); }
      if (!plan.length) {
        assert.strictEqual(t.herdrState().prompts.filter(p => /and the logo/.test(p.text)).length, 1);
        assert.strictEqual(t.run(['relaunch', 'S1', '--request', 'and the logo', '--reason', 'r']).status, 1, 'a retry is refused: the worker is live');
      }
    } finally { t.cleanup(); }
  }
});

test('startup bookkeeping that cannot be written keeps the worker phase, its guidance, and supersession', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    const outcome = id => { const d = t.open(); try { return store.recentDecisions(d, id, 1)[0].outcome; } finally { d.close(); } };

    // A worker waiting on the user: the brief is held, and the parent superseded.
    failEvent(t, 'waiting-for-user');
    t.patchHerdr(s => { s.blockStart = true; });
    const waiting = json(t.run(['new', '--json', '--from', 'S1', '--title', 'Site 2', '--request', 'the footer', '--reason', 'r']));
    t.patchHerdr(s => { s.blockStart = false; s.panes[waiting.pane_id].agent_status = 'idle'; });
    assert.strictEqual(waiting.waiting, 'user');
    assert.strictEqual(outcome(2), 'waiting: user');
    assert.strictEqual(t.row(1).status, 'superseded');
    ok(t.run(['deliver', 'S2']));
    assert.strictEqual(t.herdrState().prompts.filter(p => /the footer/.test(p.text)).length, 1);

    // A start that may have left a worker: its uncertainty guidance survives.
    ok(t.run(['reopen', 'S1']));
    failEvent(t, 'start-uncertain');
    t.patchHerdr(s => { s.failStart = 'failed'; s.failClose = true; });
    const uncertain = t.run(['new', '--from', 'S1', '--title', 'Site 3', '--request', 'the header', '--reason', 'r']);
    assert.match(uncertain.stderr, /whether its agent started is uncertain[\s\S]*Its tab is kept/);
    assert.match(outcome(3), /^uncertain: /);
    assert.ok(t.row(3).pane_id);
    assert.strictEqual(t.row(1).status, 'superseded');

    // A confirmed failure: the parent's supersession is undone with the launch.
    ok(t.run(['reopen', 'S1']));
    failEvent(t, 'start-failed');
    t.patchHerdr(s => { s.failClose = false; });
    const failed = t.run(['new', '--from', 'S1', '--title', 'Site 4', '--request', 'the logo', '--reason', 'r']);
    assert.match(failed.stderr, /no agent started[\s\S]*resume S4, without --request/);
    assert.match(outcome(4), /^failed: /);
    assert.strictEqual(t.row(1).status, 'open');
    assert.strictEqual(t.row(4).launches, 0);
    assert.ok(t.events(1).includes('supersession-undone'));

    // An uncertain relaunch whose relaunch-failed event cannot be written.
    failEvent(t, 'relaunch-failed');
    t.patchHerdr(s => { s.failClose = true; });
    const relaunch = t.run(['relaunch', 'S4', '--request', 'the logo', '--reason', 'r']);
    assert.match(relaunch.stderr, /may have started; check it before anything else/);
    assert.match(outcome(4), /^uncertain: /);
  } finally { t.cleanup(); }
});

test('a supersession that cannot be written leaves no worker, and the retry completes it', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    const d = t.open();
    d.exec(`CREATE TRIGGER no_supersede BEFORE UPDATE OF status ON sessions WHEN NEW.status = 'superseded'
      BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    d.close();
    const workers = () => Object.values(t.herdrState().panes).filter(p => p.pane_id !== 'w1:p0').length;
    const before = workers();
    const r = t.run(['new', '--from', 'S1', '--title', 'Site 2', '--request', 'the footer', '--reason', 'S1 is stale']);
    assert.match(r.stderr, /no agent started: recording S2's new tab failed: injected\. Retry with resume S2, without --request/);
    assert.strictEqual(workers(), before, 'its tab was closed and no agent started');
    assert.strictEqual(t.row(1).status, 'open');
    assert.strictEqual(t.row(2).pane_id, null);
    const d2 = t.open();
    d2.exec('DROP TRIGGER no_supersede');
    d2.close();
    ok(t.run(['resume', 'S2', '--reason', 'retry the failed start']));
    assert.strictEqual(t.row(1).status, 'superseded');
    assert.strictEqual(t.herdrState().prompts.filter(p => /the footer/.test(p.text)).length, 1);
  } finally { t.cleanup(); }
});

test('a parent reopened after its child started stays open through the child\'s later uncertain or started-then-failed launches', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    const child = json(t.run(['new', '--json', '--from', 'S1', '--title', 'Site 2', '--request', 'the footer', '--reason', 'r']));
    ok(t.run(['reopen', 'S1']));
    t.patchHerdr(s => { delete s.panes[child.pane_id]; s.failStart = 'failed'; s.failClose = true; });
    assert.match(t.run(['relaunch', 'S2', '--request', 'again', '--reason', 'r']).stderr, /may have started/);
    assert.strictEqual(t.row(1).status, 'open');
    const placed = t.row(2).pane_id;
    t.patchHerdr(s => { delete s.panes[placed]; s.failStart = null; s.failClose = false; });
    const d = t.open();
    d.exec(`CREATE TRIGGER no_sending BEFORE UPDATE OF pending ON sessions WHEN NEW.pending LIKE '%"sending"%'
      BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    d.close();
    const started = t.run(['relaunch', 'S2', '--request', 'again', '--reason', 'r']);
    assert.match(started.stderr, /S2's worker started in pane/);
    assert.ok(t.events(2).includes('relaunched'), 'the relaunch that placed a worker says so');
    assert.strictEqual(t.row(1).status, 'open');
    assert.strictEqual(t.events(1).filter(k => k === 'superseded').length, 1);
  } finally { t.cleanup(); }
});

test('a rolled-back first launch restores its parent even when the rollback event cannot be written', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    failEvent(t, 'supersession-undone');
    t.patchHerdr(s => { s.failStart = 'failed'; });
    const r = t.run(['new', '--from', 'S1', '--title', 'Site 2', '--request', 'the footer', '--reason', 'r']);
    assert.match(r.stderr, /warning: S1's supersession-undone event was not recorded[\s\S]*no agent started[\s\S]*Retry with resume S2, without --request/);
    assert.strictEqual(t.row(1).status, 'open');
    assert.strictEqual(t.row(2).launches, 0);
    assert.strictEqual(t.row(2).pane_id, null);
    assert.ok(store.pendingOf(t.row(2)).length > 0, 'its brief is held');
    const d = t.open();
    assert.match(store.recentDecisions(d, 2, 1)[0].outcome, /^failed: /);
    d.close();
  } finally { t.cleanup(); }
});

test('a rolled-back first launch leaves a parent its own worker resolved meanwhile resolved', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    // S1's worker reports itself done while S2's agent is starting, then S2's start fails.
    t.patchHerdr(s => {
      s.onStart = `ORCHESTRATOR_SESSION=1 "${process.execPath}" "${CLI}" report --summary done --resolved`;
      s.failStart = 'failed';
    });
    t.run(['new', '--from', 'S1', '--title', 'Site 2', '--request', 'the footer', '--reason', 'r']);
    t.patchHerdr(s => { s.onStart = null; s.failStart = null; });
    assert.strictEqual(t.row(1).status, 'resolved');
    assert.ok(t.row(1).resolved_at);
    assert.ok(!t.events(1).includes('supersession-undone'));
    assert.match(t.run(['send', 'S1', '--request', 'x', '--reason', 'r']).stderr, /S1 is resolved/);
    assert.strictEqual(t.row(2).launches, 0);
    assert.strictEqual(t.row(2).pane_id, null);
  } finally { t.cleanup(); }
});

test('a rolled-back first launch leaves its parent with a sibling that superseded it meanwhile', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    // While S2's agent starts, S3 is made from S1 and starts; then S2's start fails.
    t.patchHerdr(s => {
      s.onStart = `"${process.execPath}" "${CLI}" new --from S1 --title "Site 3" --request "the header" --reason r`;
      s.failStart = 'failed';
    });
    const r = t.run(['new', '--from', 'S1', '--title', 'Site 2', '--request', 'the footer', '--reason', 'r']);
    assert.match(r.stderr, /no agent started/);
    assert.ok(t.row(3).pane_id, 'S3 has a worker');
    assert.strictEqual(t.row(2).pane_id, null);
    assert.strictEqual(t.row(1).status, 'superseded', 'S3 still supersedes S1');
    assert.ok(!t.events(1).includes('supersession-undone'));
  } finally { t.cleanup(); }
});

test('a failed launch of a later sibling leaves its parent with the earlier successor, in either order', () => {
  // In sequence: S2 took over S1; S3 from S1 then fails.
  let t = setup();
  try {
    ok(t.run(['start']));
    json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    json(t.run(['new', '--json', '--from', 'S1', '--title', 'Site 2', '--request', 'the footer', '--reason', 'r']));
    t.patchHerdr(s => { s.failStart = 'failed'; });
    assert.match(t.run(['new', '--from', 'S1', '--title', 'Site 3', '--request', 'the header', '--reason', 'r']).stderr, /no agent started/);
    assert.strictEqual(t.row(1).status, 'superseded', 'S2 still supersedes S1');
    assert.match(t.run(['send', 'S1', '--request', 'x', '--reason', 'r']).stderr, /S1 is superseded/);
  } finally { t.cleanup(); }

  // Overlapping: S2 is placed; while its agent starts, S3 is placed and fails; then S2 starts.
  t = setup();
  try {
    ok(t.run(['start']));
    json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    t.patchHerdr(s => {
      s.onStart = `"${process.execPath}" "${CLI}" new --from S1 --title "Site 3" --request "the header" --reason r`;
      s.innerFailStart = 'failed';
    });
    json(t.run(['new', '--json', '--from', 'S1', '--title', 'Site 2', '--request', 'the footer', '--reason', 'r']));
    assert.strictEqual(t.row(3).pane_id, null, 'S3 got no worker');
    assert.ok(t.row(2).pane_id, 'S2 did');
    assert.strictEqual(t.row(1).status, 'superseded', 'S2 still supersedes S1');
  } finally { t.cleanup(); }
});

test('a parent reopened by any route, even with its event lost, stays open when a later child fails', () => {
  for (const reopen of ['report --open', 'reopen without its event', 'resolve then report --open']) {
    const t = setup();
    try {
      ok(t.run(['start']));
      json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
      json(t.run(['new', '--json', '--from', 'S1', '--title', 'Site 2', '--request', 'the footer', '--reason', 'r']));
      if (reopen === 'report --open') ok(t.run(['report', '--open'], { ORCHESTRATOR_SESSION: '1' }));
      if (reopen === 'resolve then report --open') {
        ok(t.run(['report', '--resolved'], { ORCHESTRATOR_SESSION: '1' }));
        ok(t.run(['report', '--open'], { ORCHESTRATOR_SESSION: '1' }));
      }
      if (reopen === 'reopen without its event') {
        failEvent(t, 'reopened');
        assert.match(ok(t.run(['reopen', 'S1'])).stderr, /warning: S1's reopened event was not recorded/);
      }
      assert.strictEqual(t.row(1).status, 'open', reopen);
      t.patchHerdr(s => { s.failStart = 'failed'; });
      assert.match(t.run(['new', '--from', 'S1', '--title', 'Site 3', '--request', 'the header', '--reason', 'r']).stderr, /no agent started/);
      t.patchHerdr(s => { s.failStart = null; });
      assert.strictEqual(t.row(1).status, 'open', `${reopen}: S1 is left as it was`);
      ok(t.run(['send', 'S1', '--request', 'one more', '--reason', 'r']));
    } finally { t.cleanup(); }
  }
});

test('children that fail in turn leave their parent open: a rolled-back claim is no successor', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    t.patchHerdr(s => { s.failStart = 'failed'; });
    t.run(['new', '--from', 'S1', '--title', 'Site 2', '--request', 'the footer', '--reason', 'r']);
    t.run(['new', '--from', 'S1', '--title', 'Site 3', '--request', 'the header', '--reason', 'r']);
    t.patchHerdr(s => { s.failStart = null; });
    assert.strictEqual(t.row(1).status, 'open');
    ok(t.run(['send', 'S1', '--request', 'one more', '--reason', 'r']));
  } finally { t.cleanup(); }

  // Overlapping, in one succession: S3 is placed and fails while S2 starts, then S2 fails too.
  const u = setup();
  try {
    ok(u.run(['start']));
    json(u.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    u.patchHerdr(s => {
      s.onStart = `"${process.execPath}" "${CLI}" new --from S1 --title "Site 3" --request "the header" --reason r`;
      s.innerFailStart = 'failed';
      s.failStart = 'failed';
    });
    assert.match(u.run(['new', '--from', 'S1', '--title', 'Site 2', '--request', 'the footer', '--reason', 'r']).stderr, /no agent started/);
    u.patchHerdr(s => { s.failStart = null; });
    assert.strictEqual(u.row(2).pane_id, null);
    assert.strictEqual(u.row(3).pane_id, null);
    assert.strictEqual(u.row(1).status, 'open', 'neither rolled-back claim is a successor');
  } finally { u.cleanup(); }
});

test('a failed restore notes that the parent stays superseded only while it is', () => {
  for (const resolvedMeanwhile of [false, true]) {
    const t = setup();
    try {
      ok(t.run(['start']));
      json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
      blockClear(t);
      t.patchHerdr(s => {
        s.failStart = 'failed';
        if (resolvedMeanwhile) s.onStart = `ORCHESTRATOR_SESSION=1 "${process.execPath}" "${CLI}" report --summary done --resolved`;
      });
      const r = t.run(['new', '--from', 'S1', '--title', 'Site 2', '--request', 'the footer', '--reason', 'r']);
      assert.match(r.stderr, /restoring the record failed/);
      if (resolvedMeanwhile) assert.doesNotMatch(r.stderr, /S1 stays superseded/);
      else assert.match(r.stderr, /including this request, and S1 stays superseded\. Do not send the request again/);
    } finally { t.cleanup(); }
  }
});

test('a delivery whose activity time cannot be written still reports delivered, once', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    t.patchHerdr(s => { s.blockStart = true; });
    const first = json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    t.patchHerdr(s => { s.blockStart = false; s.panes[first.pane_id].agent_status = 'idle'; });
    const d = t.open();
    d.exec("CREATE TRIGGER no_activity BEFORE UPDATE OF last_active_at ON sessions BEGIN SELECT RAISE(ABORT, 'injected'); END");
    d.close();
    const r = ok(t.run(['deliver', 'S1', '--json']));
    assert.strictEqual(JSON.parse(r.stdout).action, 'delivered');
    assert.strictEqual(JSON.parse(r.stdout).pane_id, first.pane_id);
    assert.match(r.stderr, /warning: S1's activity time was not recorded \(injected\)/);
    assert.strictEqual(t.row(1).pending, null);
    assert.match(t.run(['deliver', 'S1']).stderr, /has no held prompt/);
    assert.strictEqual(t.herdrState().prompts.filter(p => /fix the login/.test(p.text)).length, 1);
  } finally { t.cleanup(); }
});

// A record that cannot be restored after its tab closed still holds that
// launch's prompts; following the retry its error names submits each once.
const blockClear = t => {
  const d = t.open();
  // Only the rollback clears the placement and lowers the launch count.
  d.exec("CREATE TRIGGER no_clear BEFORE UPDATE OF pane_id ON sessions WHEN NEW.pane_id IS NULL AND NEW.launches < OLD.launches BEGIN SELECT RAISE(ABORT, 'injected'); END");
  d.close();
};
const unblockClear = t => { const d = t.open(); d.exec('DROP TRIGGER no_clear'); d.close(); };

for (const harness of ['claude', 'pi']) {
  test(`a ${harness} first launch whose record cannot be restored names relaunch, and that sends its brief once`, () => {
    const t = setup();
    try {
      ok(t.run(['start']));
      blockClear(t);
      t.patchHerdr(s => { s.failStart = 'failed'; });
      const r = t.run(['new', '--harness', harness, '--title', 'Site', '--request', 'fix the login', '--reason', 'r']);
      assert.match(r.stderr, /no agent started[\s\S]*restoring the record failed \(injected\)[\s\S]*No agent is running[\s\S]*including this request\. Do not send the request again; relaunch S1 with a --request asking it to continue/);
      assert.doesNotMatch(r.stderr, /Its tab is kept|then resume/);
      assert.ok(t.events(1).includes('start-failed') && !t.events(1).includes('start-uncertain'), 'the history agrees with the outcome');
      const d = t.open();
      assert.match(store.recentDecisions(d, 1, 1)[0].outcome, /^failed: /);
      d.close();
      unblockClear(t);
      t.patchHerdr(s => { s.failStart = null; });
      ok(t.run(['relaunch', 'S1', '--request', 'continue where the held messages leave off', '--reason', 'retry the failed start']));
      assert.strictEqual(t.herdrState().prompts.filter(p => /fix the login/.test(p.text)).length, 1);
      assert.strictEqual(Object.values(t.herdrState().panes).filter(p => p.agent && p.pane_id !== 'w1:p0').length, 1);
    } finally { t.cleanup(); }
  });
}

test('a resume --request whose record cannot be restored names resume without --request, and the request goes once', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    // A Claude conversation whose transcript location was never recorded.
    t.patchHerdr(s => { delete s.panes[first.pane_id]; s.failStart = 'failed'; });
    blockClear(t);
    const r = t.run(['resume', 'S1', '--request', 'a unique new request', '--reason', 'its tab was closed']);
    assert.match(r.stderr, /Do not send the request again; resume S1 without --request: it delivers the held prompts/);
    assert.doesNotMatch(r.stderr, /relaunch it/, 'one route only');
    unblockClear(t);
    t.patchHerdr(s => { s.failStart = null; });
    ok(t.run(['resume', 'S1', '--reason', 'retry the failed resume']));
    assert.strictEqual(t.herdrState().prompts.filter(p => /a unique new request/.test(p.text)).length, 1);
    assert.strictEqual(t.row(1).pending, null);
  } finally { t.cleanup(); }
});

test('an empty tab that could not be closed after its record failed is named for what happened', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    const d = t.open();
    d.exec(`CREATE TRIGGER no_supersede BEFORE UPDATE OF status ON sessions WHEN NEW.status = 'superseded'
      BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    d.close();
    t.patchHerdr(s => { s.failClose = true; });
    const r = t.run(['new', '--from', 'S1', '--title', 'Site 2', '--request', 'the footer', '--reason', 'r']);
    assert.match(r.stderr, /no agent started[\s\S]*its tab could not be closed after recording it failed, so an empty tab may be open: close it if so, then resume S2/);
    assert.doesNotMatch(r.stderr, /timed out/);
  } finally { t.cleanup(); }
});

test('a launch waiting on the user records which wait', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    t.patchHerdr(s => { s.blockStart = true; });
    assert.strictEqual(json(t.run(['new', '--json', '--title', 'New folder', '--request', 'x', '--reason', 'r'])).waiting, 'user');
    const d = t.open();
    assert.strictEqual(store.recentDecisions(d, 1, 1)[0].outcome, 'waiting: user');
    d.close();
  } finally { t.cleanup(); }
});

test('prompts show in the order they were typed, whatever order their writers commit in', () => {
  const t = setup();
  try {
    const d = t.open();
    const id = store.createSession(d, { title: 'pi', intent: 'i', harness: 'pi', cwd: t.dir });
    const typed = Date.now() - 60000;
    store.recordHookEvent(d, id, { kind: 'prompt', text: 'second', at: new Date(typed + 5).toISOString(), seq: 3 });
    store.recordHookEvent(d, id, { kind: 'prompt', text: 'first', at: new Date(typed).toISOString(), seq: 2 });
    store.recordHookEvent(d, id, { kind: 'prompt', text: 'third', at: new Date(typed + 5).toISOString(), seq: 4 });
    store.recordHookEvent(d, id, { kind: 'prompt', text: 'no stamp' });
    assert.deepStrictEqual(store.recentPrompts(d, id, 10).map(p => p.text), ['first', 'second', 'third', 'no stamp']);
    d.close();
  } finally { t.cleanup(); }
});

test('a version-1 record is migrated on open and keeps its rows', () => {
  const t = setup();
  try {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.dirname(t.db), { recursive: true });
    const old = new DatabaseSync(t.db);
    old.exec(store.MIGRATIONS[1]);
    old.exec('PRAGMA user_version = 1');
    old.prepare("INSERT INTO sessions (title, intent, harness, cwd, started_at, last_active_at) VALUES ('t', 'i', 'claude', '/x', 'a', 'a')").run();
    old.prepare("INSERT INTO decisions (at, request, action, session_id, reason) VALUES ('a', 'r', 'new', 1, 'why')").run();
    old.prepare("INSERT INTO prompts (session_id, at, source, text) VALUES (1, 'a', 'direct', 'hello')").run();
    old.close();
    const d = t.open();
    try {
      assert.strictEqual(d.prepare('PRAGMA user_version').get().user_version, store.SCHEMA_VERSION);
      assert.strictEqual(store.recentPrompts(d, 1, 5)[0].text, 'hello');
      const [decision] = store.recentDecisions(d, 1, 5);
      assert.strictEqual(decision.outcome, null);
      store.setOutcome(d, decision.id, 'new');
      assert.strictEqual(store.recentDecisions(d, 1, 5)[0].outcome, 'new');
      store.updateSession(d, 1, { worktree: '/w/FAC-1-x' });
      assert.strictEqual(store.getSession(d, 1).worktree, '/w/FAC-1-x');
    } finally { d.close(); }
  } finally { t.cleanup(); }
});

test('a Pi resume opens its exact recorded file, and restarts with the full brief when that file is gone', () => {
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

    t.patchHerdr(s => { delete s.panes[first.pane_id]; s.piSessionDir = path.join(t.dir, 'moved'); });
    const resumed = json(t.run(['resume', 'S1', '--json', '--request', 'add retries', '--reason', 'r']));
    assert.strictEqual(resumed.action, 'resumed');
    assert.deepStrictEqual(t.herdrState().panes[resumed.pane_id].args.slice(0, 2), ['--session', row.transcript_path],
      'the exact file, wherever Pi now keeps new sessions');
    assert.strictEqual(t.herdrState().prompts.at(-1).text, '[orchestrator S1] add retries');

    fs.rmSync(row.transcript_path);
    t.patchRow(1, { transcript_path: row.transcript_path });
    t.patchHerdr(s => { delete s.panes[resumed.pane_id]; });
    const restarted = json(t.run(['resume', 'S1', '--json', '--request', 'add backoff', '--reason', 'r']));
    assert.strictEqual(restarted.action, 'restarted');
    assert.match(t.herdrState().prompts.at(-1).text, /add backoff[\s\S]*report --summary[\s\S]*This continues the work of session S1/);
  } finally { t.cleanup(); }
});

test('a tab waiting on the user keeps its brief held; a failed start keeps it for the retry', () => {
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

    // The user closed the waiting tab: its conversation was never written.
    t.patchHerdr(s => { delete s.panes[out.pane_id]; s.blockStart = false; s.failStart = 'failed'; });
    assert.match(t.run(['resume', 'S1', '--request', 'continue', '--reason', 'r']).stderr, /never recorded[\s\S]*relaunch/);
    t.patchHerdr(s => { s.failStart = null; });
    json(t.run(['relaunch', 'S1', '--json', '--request', 'continue', '--reason', 'its conversation was never written']));
    assert.match(t.herdrState().prompts.at(-1).text, /continue[\s\S]*never reached a worker[\s\S]*build the importer/);
    assert.strictEqual(t.row(1).pending, null);

    t.patchHerdr(s => { s.failStart = 'failed'; });
    const failed = t.run(['new', '--title', 'Another', '--request', 'write the exporter', '--reason', 'r']);
    assert.match(failed.stderr, /brief held, but no agent started[\s\S]*resume S2, without --request/);
    t.patchHerdr(s => { s.failStart = null; });
    const started = json(t.run(['resume', 'S2', '--json', '--reason', 'retry the failed start']));
    assert.strictEqual(started.action, 'started');
    assert.match(t.herdrState().prompts.at(-1).text, /^\[orchestrator S2\] write the exporter/);
    assert.strictEqual(t.herdrState().prompts.filter(p => /write the exporter/.test(p.text)).length, 1);

    // herdr times out creating the tab: no agent start ran, so none is called uncertain.
    t.patchHerdr(s => { s.hangTabCreate = 2500; s.hangLeavesTab = true; });
    const timedOut = t.run(['new', '--title', 'Third', '--request', 'write the docs', '--reason', 'r'], { ORCHESTRATOR_HERDR_TIMEOUT_MS: '1000' });
    assert.match(timedOut.stderr, /brief held, but no agent started[\s\S]*empty tab may be open: close it if so, then resume S3, without --request/);
    assert.doesNotMatch(timedOut.stderr, /uncertain|Nothing changed|Its tab is kept/);
    sleep(2000);
    t.patchHerdr(s => { s.hangTabCreate = 0; s.hangLeavesTab = false; });
    const orphan = Object.values(t.herdrState().panes).find(p => !p.agent && !p.env.length);
    assert.ok(orphan, 'the timed-out create left an empty tab');
    assert.strictEqual(t.row(3).pane_id, null, 'the empty tab is never recorded');
    const retried = json(t.run(['resume', 'S3', '--json', '--reason', 'retry the timed-out start']));
    assert.strictEqual(retried.action, 'started');
    assert.notStrictEqual(retried.pane_id, orphan.pane_id);
    assert.ok(t.herdrState().panes[orphan.pane_id], 'resume neither uses nor closes a tab it never recorded');
    assert.strictEqual(t.herdrState().prompts.filter(p => /write the docs/.test(p.text)).length, 1);
    assert.ok(t.herdrState().prompts.every(p => p.pane !== orphan.pane_id));
  } finally { t.cleanup(); }
});

test('an interrupted send is unknown: nothing resends or drops it until it is settled', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    t.patchHerdr(s => { s.promptPlan = ['hang:4000']; });
    const killed = t.run(['new', '--title', 'Slow', '--request', 'audit the API', '--reason', 'r', '--persona', 'scout'], {}, undefined, { timeout: 1500 });
    assert.notStrictEqual(killed.status, 0, 'the CLI was killed mid-wait');
    assert.deepStrictEqual(store.pendingOf(t.row(1)).map(e => e.state), ['unknown', 'pending']);
    sleep(3000); // let the fake's hung prompt finish
    assert.match(t.run(['deliver', 'S1']).stderr, /delivery is unknown[\s\S]*settle S1/);
    const tab = t.row(1);
    t.patchHerdr(s => { delete s.panes[tab.pane_id]; });
    assert.match(t.run(['resume', 'S1', '--request', 'x', '--reason', 'r']).stderr, /delivery is unknown/, 'resume does not replay it');
    assert.match(t.run(['relaunch', 'S1', '--request', 'x', '--reason', 'r']).stderr, /delivery is unknown/, 'nor relaunch');
    assert.strictEqual(t.herdrState().prompts.filter(p => p.text.startsWith('/brain')).length, 1);

    ok(t.run(['settle', 'S1', '--drop']));
    json(t.run(['resume', 'S1', '--json', '--reason', 'deliver the held brief']));
    const texts = t.herdrState().prompts.map(p => p.text);
    assert.strictEqual(texts.filter(x => x.startsWith('/brain')).length, 1);
    assert.match(texts.at(-1), /^\[orchestrator S1\] audit the API/);
  } finally { t.cleanup(); }
});

test('send holds its request: an uncertain send is unknown and blocks a retry; a refused one stays held', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    json(t.run(['new', '--json', '--title', 'Deploy', '--request', 'prepare', '--reason', 'r']));
    t.patchHerdr(s => { s.promptPlan = ['hang:2500']; });
    const r = t.run(['send', 'S1', '--request', 'deploy the change', '--reason', 'r'], { ORCHESTRATOR_HERDR_TIMEOUT_MS: '1000' });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /may or may not have arrived[\s\S]*settle S1/);
    sleep(2000);
    assert.match(t.run(['send', 'S1', '--request', 'deploy the change', '--reason', 'r']).stderr, /delivery is unknown/);
    assert.strictEqual(t.herdrState().prompts.filter(p => /deploy the change/.test(p.text)).length, 1, 'no second deploy');
    ok(t.run(['settle', 'S1', '--drop']));

    t.patchHerdr(s => { s.promptPlan = ['reject']; });
    assert.match(t.run(['send', 'S1', '--request', 'then tag it', '--reason', 'r']).stderr, /the request is held: run deliver S1/);
    ok(t.run(['deliver', 'S1']));
    assert.strictEqual(t.herdrState().prompts.filter(p => /then tag it/.test(p.text)).length, 1);
    ok(t.run(['send', 'S1', '--request', 'and announce it', '--reason', 'r']));
    assert.strictEqual(t.row(1).pending, null);
  } finally { t.cleanup(); }
});

test('a send refused before writing keeps nothing; each route SKILL.md names submits it once', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Site', '--request', 'fix the login', '--reason', 'r']));
    const count = re => t.herdrState().prompts.filter(p => re.test(p.text)).length;

    // No live tab: resume --request carries the request.
    t.patchHerdr(s => { delete s.panes[first.pane_id]; });
    assert.match(t.run(['send', 'S1', '--request', 'also the footer', '--reason', 'r']).stderr, /no live tab; use resume S1 --request with this request[\s\S]*nothing was kept/);
    assert.strictEqual(t.row(1).pending, null);
    ok(t.run(['resume', 'S1', '--request', 'also the footer', '--reason', 'its tab was closed']));
    assert.strictEqual(count(/also the footer/), 1);

    // Still holds a prompt: deliver the older one, then send the new request.
    t.patchHerdr(s => { s.promptPlan = ['reject']; });
    assert.match(t.run(['send', 'S1', '--request', 'then the header', '--reason', 'r']).stderr, /the request is held/);
    assert.match(t.run(['send', 'S1', '--request', 'and the sidebar', '--reason', 'r']).stderr, /still holds prompts/);
    assert.deepStrictEqual(store.pendingOf(t.row(1)).map(e => e.text), ['[orchestrator S1] then the header']);
    ok(t.run(['deliver', 'S1']));
    ok(t.run(['send', 'S1', '--request', 'and the sidebar', '--reason', 'r']));
    assert.strictEqual(count(/then the header/), 1);
    assert.strictEqual(count(/and the sidebar/), 1);

    // Holds a prompt of unknown delivery that never arrived: settle --resend holds it again, so deliver, then send.
    t.patchHerdr(s => { s.promptPlan = ['lost:2500']; });
    assert.match(t.run(['send', 'S1', '--request', 'then the banner', '--reason', 'r'], { ORCHESTRATOR_HERDR_TIMEOUT_MS: '1000' }).stderr, /may or may not have arrived/);
    sleep(2000);
    assert.strictEqual(count(/then the banner/), 0, 'it never reached the worker');
    assert.match(t.run(['send', 'S1', '--request', 'and the logo', '--reason', 'r']).stderr, /delivery is unknown/);
    assert.match(t.run(['settle', 'S1', '--resend']).stdout, /held to resend: run deliver S1/);
    assert.match(t.run(['send', 'S1', '--request', 'and the logo', '--reason', 'r']).stderr, /still holds prompts/);
    ok(t.run(['deliver', 'S1']));
    ok(t.run(['send', 'S1', '--request', 'and the logo', '--reason', 'r']));
    assert.strictEqual(count(/then the banner/), 1);
    assert.strictEqual(count(/and the logo/), 1);
    assert.strictEqual(t.row(1).pending, null);

    // One that did arrive: settle --drop, then send.
    t.patchHerdr(s => { s.promptPlan = ['hang:2500']; });
    t.run(['send', 'S1', '--request', 'then the menu', '--reason', 'r'], { ORCHESTRATOR_HERDR_TIMEOUT_MS: '1000' });
    sleep(2000);
    assert.strictEqual(count(/then the menu/), 1, 'it reached the worker');
    assert.match(t.run(['send', 'S1', '--request', 'and the colours', '--reason', 'r']).stderr, /delivery is unknown/);
    ok(t.run(['settle', 'S1', '--drop']));
    ok(t.run(['send', 'S1', '--request', 'and the colours', '--reason', 'r']));
    assert.strictEqual(count(/then the menu/), 1);
    assert.strictEqual(count(/and the colours/), 1);

    // Its agent exited (no live worker, its tab still open): the resume the send
    // refusal names is refused until the unknown prompt is settled, and changes
    // nothing; settle, then resume --request carries the held prompt and the request.
    t.patchHerdr(s => { s.promptPlan = ['lost:2500']; });
    t.run(['send', 'S1', '--request', 'then the icons', '--reason', 'r'], { ORCHESTRATOR_HERDR_TIMEOUT_MS: '1000' });
    sleep(2000);
    // The worker's agent exited but its tab is still open: no live worker, a tab the user may check.
    const worker = t.row(1).pane_id;
    t.patchHerdr(s => { s.panes[worker].agent = null; });
    assert.match(t.run(['send', 'S1', '--request', 'and the fonts', '--reason', 'r']).stderr, /no live tab/);
    const decisions = () => { const d = t.open(); try { return d.prepare('SELECT COUNT(*) AS n FROM decisions').get().n; } finally { d.close(); } };
    const before = { row: t.row(1), events: t.events(1), decisions: decisions() };
    assert.match(t.run(['resume', 'S1', '--request', 'and the fonts', '--reason', 'r']).stderr, /delivery is unknown/);
    assert.deepStrictEqual({ row: t.row(1), events: t.events(1), decisions: decisions() }, before, 'the refused resume changed nothing');
    assert.ok(t.herdrState().panes[worker], 'nor closed the tab the user is told to check');
    assert.strictEqual(count(/and the fonts/), 0);
    assert.match(t.run(['settle', 'S1', '--resend']).stdout, /or resume S1 if its tab is gone \(with --request if a new request is waiting\)/);
    ok(t.run(['resume', 'S1', '--request', 'and the fonts', '--reason', 'its agent exited']));
    assert.strictEqual(count(/then the icons/), 1);
    assert.strictEqual(count(/and the fonts/), 1);
    assert.strictEqual(t.row(1).pending, null);

    // Not open: new --from carries the request to a new session.
    ok(t.run(['resolve', 'S1']));
    assert.match(t.run(['send', 'S1', '--request', 'one more page', '--reason', 'r']).stderr, /resolved; start a new session with --from S1/);
    ok(t.run(['new', '--from', 'S1', '--title', 'Site 2', '--request', 'one more page', '--reason', 'S1 is resolved']));
    assert.strictEqual(count(/one more page/), 1);
  } finally { t.cleanup(); }
});

test('a local herdr timeout leaves the prompt unknown, and settle --resend sends it again', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    t.patchHerdr(s => { s.promptPlan = ['hang:2500']; });
    const out = json(t.run(['new', '--json', '--title', 'Slow', '--request', 'audit the API', '--reason', 'r'], { ORCHESTRATOR_HERDR_TIMEOUT_MS: '1000' }));
    assert.strictEqual(out.action, 'waiting');
    assert.match(out.note, /may or may not have reached the worker/);
    sleep(2000);
    assert.deepStrictEqual(store.pendingOf(t.row(1)).map(e => e.state), ['unknown']);
    assert.match(t.run(['settle', 'S1']).stderr, /exactly one of --resend or --drop/);
    ok(t.run(['settle', 'S1', '--resend']));
    ok(t.run(['deliver', 'S1']));
    assert.strictEqual(t.herdrState().prompts.filter(p => /audit the API/.test(p.text)).length, 2);
    assert.strictEqual(t.row(1).pending, null);
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
    assert.match(r.stderr, /uncertain[\s\S]*could not be closed and stays recorded/);
    const kept = t.row(1);
    assert.ok(kept.pane_id && t.herdrState().panes[kept.pane_id], 'the orphan is recorded, not forgotten');
    // The uncertain start did write its conversation; this test is about the leftover tab.
    t.patchHerdr(s => { s.failStart = null; s.anyResume = true; });
    assert.match(t.run(['resume', 'S1', '--reason', 'r']).stderr, /still open and could not be closed/);
    assert.strictEqual(Object.keys(t.herdrState().panes).length, 2, 'no second worker');
    t.patchHerdr(s => { s.failClose = false; });
    ok(t.run(['resume', 'S1', '--reason', 'r']));
    assert.strictEqual(t.herdrState().panes[kept.pane_id], undefined, 'the agentless leftover tab is closed first');
    assert.strictEqual(t.herdrState().prompts.filter(p => /^\[orchestrator S1\] go/.test(p.text)).length, 1);
  } finally { t.cleanup(); }
});

test('a tab that now runs another conversation is never closed: stop, resume, relaunch, and reconcile detach from it', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const reuse = () => {
      const pane = t.row(1).pane_id;
      t.patchHerdr(s => { Object.assign(s.panes[pane], { agent_status: 'working', agent_session: { kind: 'id', value: 'someone-else' } }); });
      return pane;
    };
    json(t.run(['new', '--json', '--title', 'Fix login', '--request', 'fix', '--reason', 'r']));
    let pane = reuse();
    assert.strictEqual(json(t.run(['stop', 'S1', '--json'])).action, 'detached');
    assert.ok(t.herdrState().panes[pane], 'stop left it open');
    for (const verb of ['resume', 'relaunch']) {
      const launched = json(t.run([verb, 'S1', '--json', '--request', 'more', '--reason', 'r']));
      assert.ok(t.herdrState().panes[pane], `${verb} left the other conversation's tab open`);
      assert.notStrictEqual(launched.pane_id, pane);
      pane = reuse();
    }
    assert.deepStrictEqual(json(t.run(['reconcile', '--json'])), { closed: ['S1'], adopted: [] });
    assert.ok(t.herdrState().panes[pane]);
    assert.strictEqual(t.row(1).pane_id, null);
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
    assert.strictEqual(t.run(['reconcile'], { HERDR_PANE_ID: 'w1:p50' }).status, 3, 'only the orchestrator reconciles');

    t.patchHerdr(s => { delete s.panes['w1:p50']; });
    ok(t.run(['reconcile']));
    handResume('w1:p51');
    const tabsBefore = t.herdrState().seq;
    assert.match(t.run(['resume', 'S1', '--request', 'more', '--reason', 'r']).stderr, /already running in pane w1:p51.*adopted/);
    assert.strictEqual(t.row(1).pane_id, 'w1:p51');

    t.patchHerdr(s => { delete s.panes['w1:p51']; });
    ok(t.run(['reconcile']));
    handResume('w1:p52');
    t.patchHerdr(s => { s.failAgentList = true; });
    assert.match(t.run(['resume', 'S1', '--request', 'more', '--reason', 'r']).stderr, /cannot check whether S1 is already running/);
    assert.match(t.run(['relaunch', 'S1', '--request', 'more', '--reason', 'r']).stderr, /cannot check whether S1 is already running/);
    assert.strictEqual(t.herdrState().seq, tabsBefore, 'no second worker, and no replacement identity');
    assert.strictEqual(t.row(1).native_session_id, id);
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

test('a start event from another launch, or older than one applied, never changes the identity', () => {
  const t = setup();
  try {
    const d = t.open();
    const id = store.createSession(d, { title: 'pi', intent: 'i', harness: 'pi', native_session_id: 'A', cwd: t.dir });
    store.updateSession(d, id, { launches: 2, launch_token: 'L2' });
    store.recordHookEvent(d, id, { kind: 'start', launch: 'L2', seq: 2, nativeSessionId: 'B', transcriptPath: '/s/B.jsonl' });
    store.recordHookEvent(d, id, { kind: 'start', launch: 'L2', seq: 1, nativeSessionId: 'A', transcriptPath: '/s/A.jsonl' });
    store.recordHookEvent(d, id, { kind: 'start', launch: 'L3', seq: 9, nativeSessionId: 'C', transcriptPath: '/s/C.jsonl' });
    store.recordHookEvent(d, id, { kind: 'compact', launch: 'L1' });
    store.recordHookEvent(d, id, { kind: 'prompt', launch: 'L1', text: 'kept: the user said it' });
    const row = store.getSession(d, id);
    assert.deepStrictEqual([row.native_session_id, row.transcript_path, row.compactions], ['B', '/s/B.jsonl', 0]);
    assert.strictEqual(store.promptCount(d, id), 1);
    d.close();
  } finally { t.cleanup(); }
});

test('a failed launch\'s late recorder cannot pass for its retry: launch tokens are never reused', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Fix login', '--request', 'fix', '--reason', 'r']));
    const a = t.row(1);
    const transcript = path.join(t.dir, `${a.native_session_id}.jsonl`);
    fs.writeFileSync(transcript, '{}\n');
    t.patchRow(1, { transcript_path: transcript });
    t.patchHerdr(s => { delete s.panes[first.pane_id]; s.failStart = 'failed'; });
    assert.strictEqual(t.run(['relaunch', 'S1', '--request', 'again', '--reason', 'r']).status, 1);
    const failedToken = t.herdrState().calls.filter(c => c[0] === 'tab' && c[1] === 'create').at(-1)
      .find(x => x.startsWith('ORCHESTRATOR_LAUNCH=')).split('=')[1];
    assert.strictEqual(t.row(1).native_session_id, a.native_session_id, 'rolled back to A');
    t.patchHerdr(s => { s.failStart = null; });
    ok(t.run(['resume', 'S1', '--request', 'again', '--reason', 'r']));
    const current = t.row(1);
    assert.notStrictEqual(current.launch_token, failedToken);
    // The failed attempt's writer arrives late, before and after the current start.
    const hook = (token, sid, file) => ok(t.run(['hook', 'claude'], { ORCHESTRATOR_SESSION: '1', ORCHESTRATOR_LAUNCH: token },
      JSON.stringify({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup' })));
    hook(failedToken, 'B-abandoned', '/s/B.jsonl');
    hook(current.launch_token, a.native_session_id, transcript);
    hook(failedToken, 'B-abandoned', '/s/B.jsonl');
    assert.strictEqual(t.row(1).native_session_id, a.native_session_id);
    assert.strictEqual(t.row(1).transcript_path, transcript);
  } finally { t.cleanup(); }
});

test('an uncertain relaunch keeps its new conversation and records the previous one', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Fix login', '--request', 'fix', '--reason', 'r']));
    const a = t.row(1).native_session_id;
    t.patchRow(1, { transcript_path: '/s/A.jsonl' });
    t.patchHerdr(s => { delete s.panes[first.pane_id]; s.failStart = 'failed'; s.failClose = true; });
    const r = t.run(['relaunch', 'S1', '--request', 'again', '--reason', 'stale context']);
    assert.match(r.stderr, /may have started[\s\S]*previous conversation is in its events/);
    const row = t.row(1);
    assert.notStrictEqual(row.native_session_id, a, 'the possibly-started replacement is kept');
    assert.ok(row.pane_id, 'and its tab');
    const d = t.open();
    const events = store.recentEvents(d, 1, 50);
    const outcome = store.recentDecisions(d, 1, 1)[0].outcome;
    d.close();
    assert.match(events.find(e => e.kind === 'relaunch-staged').detail, new RegExp(`previous conversation ${a} at /s/A\\.jsonl: stale context`));
    assert.ok(!events.some(e => e.kind === 'relaunched'), 'no relaunch is claimed while its worker is uncertain');
    assert.match(outcome, /^uncertain: /);
  } finally { t.cleanup(); }
});

test('Pi session starts that reach the record out of order leave the latest identity, also across /new', async () => {
  const t = setup();
  const saved = { ...process.env };
  try {
    const d = t.open();
    const id = store.createSession(d, { title: 'pi', intent: 'i', harness: 'pi', native_session_id: 'A', cwd: t.dir });
    store.updateSession(d, id, { launches: 1, launch_token: 'L1' });
    Object.assign(process.env, { ORCHESTRATOR_DB: t.db, ORCHESTRATOR_SESSION: String(id), ORCHESTRATOR_LAUNCH: 'L1', ORCHESTRATOR_CLI: CLI, ORCHESTRATOR_NODE: process.execPath });
    const extension = require(path.join(SCRIPTS, 'pi-extension.js'));
    const runtime = () => { const handlers = {}; extension({ on: (name, fn) => { handlers[name] = fn; } }); return handlers; };
    const start = (h, native) => h.session_start({}, { sessionManager: { getSessionId: () => native, getSessionFile: () => `/s/${native}.jsonl` } });
    const count = () => { const c = t.open(); try { return store.recentEvents(c, id, 50).filter(e => /start/.test(e.kind)).length; } finally { c.close(); } };
    const until = async n => { for (let i = 0; i < 100 && count() < n; i++) await new Promise(r => setTimeout(r, 50)); };

    d.exec('BEGIN IMMEDIATE'); // the writers queue on the record
    const first = runtime();
    for (const native of ['A', 'B', 'C', 'D']) start(first, native);
    await new Promise(r => setTimeout(r, 800));
    d.exec('COMMIT');
    d.close();
    await until(4);
    assert.strictEqual(t.row(id).native_session_id, 'D');

    // /new: Pi builds a new runtime and runs the extension factory again.
    start(runtime(), 'E');
    await until(5);
    assert.strictEqual(t.row(id).native_session_id, 'E', 'the new session is not taken for a stale start');
    assert.strictEqual(t.row(id).transcript_path, '/s/E.jsonl');
  } finally {
    for (const k of ['ORCHESTRATOR_DB', 'ORCHESTRATOR_SESSION', 'ORCHESTRATOR_LAUNCH', 'ORCHESTRATOR_CLI', 'ORCHESTRATOR_NODE']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    t.cleanup();
  }
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

// ─── Forced interleavings ────────────────────────────────────────────────────
// Another writer takes the record's write lock, makes its change, and holds it
// uncommitted. The code under test reads the old state, then reaches the
// store's `write-lock` probe just before the write transaction the test names
// (its site); the probe signals the writer, which commits only then, while the
// code under test waits on the lock. A write at any other site comes first only
// by waiting on the held lock, so it fails rather than releasing the writer.
// Nothing hangs: if the named write never comes, the code under test fails with
// "database is locked" at its 5 s busy timeout and the writer is killed; a 10 s
// watchdog commits only if the code under test makes no write at all.

const LOCK_HOLDER = `
const crypto = require('node:crypto');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const [file, sql, signal] = process.argv.slice(1);
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL');
db.exec('BEGIN IMMEDIATE');
db.exec(sql);
process.stdout.write('locked\\n');
const started = Date.now();
const poll = setInterval(() => {
  const signalled = fs.existsSync(signal);
  if (!signalled && Date.now() - started < 10000) return;
  clearInterval(poll);
  db.exec('COMMIT');
  db.close();
  process.stdout.write(signalled ? 'committed after the signal\\n' : 'committed by the watchdog\\n');
}, 5);
`;

function holdLock(t, sql) {
  const signal = path.join(t.dir, `signal-${crypto.randomUUID()}`);
  const child = spawn(process.execPath, ['-e', LOCK_HOLDER, t.db, sql, signal], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const done = new Promise(resolve => {
    child.on('error', err => resolve({ status: null, signalled: false, stderr: err.message }));
    child.on('close', status => resolve({ status, signalled: stdout.includes('committed after the signal'), stderr }));
  });
  const locked = new Promise((resolve, reject) => {
    child.stdout.on('data', d => { stdout += d; if (stdout.includes('locked')) resolve(); });
    done.then(r => reject(new Error(`the lock holder exited before locking: ${r.stderr}`)));
  });
  return { locked, done, release: () => fs.writeFileSync(signal, ''), kill: () => child.kill() };
}

// Run `fn` with the write-lock probe releasing the writer at `site`; always
// stop the writer and wait for it before the caller removes the fixture.
async function raced(t, sql, site, fn) {
  const writer = holdLock(t, sql);
  const sites = [];
  try {
    await writer.locked;
    store.setProbe('write-lock', at => { sites.push(at); if (at === site) writer.release(); });
    const result = fn();
    const done = await writer.done;
    assert.strictEqual(done.status, 0, done.stderr);
    assert.strictEqual(sites[0], site, `the first write was at ${sites[0]}, not ${site}`);
    assert.ok(done.signalled, `the ${site} write never released the writer`);
    return result;
  } finally {
    store.setProbe('write-lock', null);
    writer.kill();
    await writer.done;
  }
}

for (const [name, previous] of [['no owner', null], ['an owner that is gone', 'w1:gone']]) {
  test(`a claim judged against ${name} while another commits its own re-judges and takes nothing`, async () => {
    const t = setup();
    const d = t.open();
    try {
      if (previous) d.prepare("INSERT INTO owner (id, pane_id, at) VALUES (1, ?, '2026-01-01T00:00:00Z')").run(previous);
      const judged = [];
      const first = await raced(t, "INSERT INTO owner (id, pane_id, at) VALUES (1, 'w1:rival', '2026-11-23T00:00:00Z') " +
        'ON CONFLICT(id) DO UPDATE SET pane_id = excluded.pane_id, at = excluded.at', 'claim',
      () => store.claimOwner(d, { pane_id: 'w1:me' }, held => { judged.push(held.pane_id); return false; }));
      assert.deepStrictEqual(judged, previous ? [previous] : [], 'judged the state from before the rival committed');
      assert.strictEqual(first.claimed, false);
      assert.strictEqual(first.changed, true, 'the owner changed after it was judged');
      assert.strictEqual(store.getOwner(d).pane_id, 'w1:rival', 'the rival keeps its claim');
      const again = store.claimOwner(d, { pane_id: 'w1:me' }, held => held.pane_id === 'w1:rival');
      assert.strictEqual(again.claimed, false);
      assert.strictEqual(store.getOwner(d).pane_id, 'w1:rival');
    } finally { d.close(); t.cleanup(); }
  });
}

test('a compaction that waits on another writer counts both', async () => {
  const t = setup();
  const d = t.open();
  try {
    const id = store.createSession(d, { title: 'busy', intent: 'i', harness: 'claude', native_session_id: 'c-1', cwd: t.dir });
    await raced(t, `UPDATE sessions SET compactions = compactions + 1 WHERE id = ${id}`, 'hook', () => {
      assert.strictEqual(store.getSession(d, id).compactions, 0, 'the other compaction is not visible yet');
      store.recordHookEvent(d, id, { kind: 'compact', detail: 'auto' });
    });
    assert.strictEqual(store.getSession(d, id).compactions, 2);
  } finally { d.close(); t.cleanup(); }
});

test('an opener that read version 0 while another created the schema does not create it again', async () => {
  const t = setup();
  let d = null;
  try {
    fs.mkdirSync(path.dirname(t.db), { recursive: true });
    // The connection is kept as soon as it opens, so a failed check still closes it.
    await raced(t, `CREATE TABLE sessions (id INTEGER PRIMARY KEY); PRAGMA user_version = ${store.SCHEMA_VERSION}`, 'open',
      () => { d = store.open(t.db); });
    assert.strictEqual(d.prepare('PRAGMA user_version').get().user_version, store.SCHEMA_VERSION);
  } finally { if (d) d.close(); t.cleanup(); }
});

// A version-1 record, as PR #38 wrote it, with one session.
function writeVersion1(t) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(t.db), { recursive: true });
  const old = new DatabaseSync(t.db);
  old.exec(store.MIGRATIONS[1]);
  old.exec('PRAGMA journal_mode = WAL; PRAGMA user_version = 1');
  old.prepare("INSERT INTO sessions (title, intent, harness, native_session_id, cwd, started_at, last_active_at) VALUES ('t', 'i', 'claude', 'c-1', '/x', 'a', 'a')").run();
  old.close();
}

test('an opener that read version 1 while another migrated it does not migrate it again', async () => {
  const t = setup();
  let d = null;
  try {
    writeVersion1(t);
    const migrate = `${store.MIGRATIONS.slice(2).join('\n')}; PRAGMA user_version = ${store.SCHEMA_VERSION}`;
    await raced(t, migrate, 'open', () => { d = store.open(t.db); });
    assert.strictEqual(d.prepare('PRAGMA user_version').get().user_version, store.SCHEMA_VERSION);
    assert.strictEqual(store.getSession(d, 1).title, 't');
  } finally { if (d) d.close(); t.cleanup(); }
});

test('an opener that read version 1 while a newer brain migrated past it refuses, and leaves the version alone', async () => {
  const t = setup();
  try {
    writeVersion1(t);
    const newer = store.SCHEMA_VERSION + 1;
    let refused = null;
    await raced(t, `PRAGMA user_version = ${newer}`, 'open', () => {
      try { store.open(t.db).close(); } catch (err) { refused = err; }
    });
    assert.match(String(refused && refused.message), new RegExp(`has schema ${newer}; this orchestrator knows ${store.SCHEMA_VERSION}`));
    const { DatabaseSync } = require('node:sqlite');
    const check = new DatabaseSync(t.db);
    assert.strictEqual(check.prepare('PRAGMA user_version').get().user_version, newer);
    check.close();
  } finally { t.cleanup(); }
});

test('a migrated record keeps a standing successor, and not one from before a reopen', () => {
  for (const parentStatus of ['superseded', 'open']) {
    const t = setup();
    try {
      // As PR #38 left it: S1 was superseded by S2, whose worker is live; or S1 was reopened since.
      const { DatabaseSync } = require('node:sqlite');
      fs.mkdirSync(path.dirname(t.db), { recursive: true });
      const old = new DatabaseSync(t.db);
      old.exec(store.MIGRATIONS[1]);
      old.exec('PRAGMA journal_mode = WAL; PRAGMA user_version = 1');
      const insert = old.prepare(`INSERT INTO sessions (title, intent, harness, native_session_id, cwd, started_at, last_active_at, status, parent_id, launches, tab_id, pane_id)
        VALUES (?, 'i', 'claude', ?, '/x', 'a', 'a', ?, ?, ?, ?, ?)`);
      insert.run('Site', 'c-1', parentStatus, null, 1, null, null);
      insert.run('Site 2', 'c-2', 'open', 1, 1, 'w1:t50', 'w1:p50');
      old.close();
      ok(t.run(['start']));
      t.patchHerdr(s => { s.panes['w1:p50'] = { pane_id: 'w1:p50', tab_id: 'w1:t50', agent: 'claude', agent_status: 'idle', agent_session: { kind: 'id', value: 'c-2' }, env: [] }; });
      t.patchHerdr(s => { s.failStart = 'failed'; });
      assert.match(t.run(['new', '--from', 'S1', '--title', 'Site 3', '--request', 'the header', '--reason', 'r']).stderr, /no agent started/);
      assert.strictEqual(t.row(1).status, parentStatus, parentStatus === 'superseded'
        ? 'S2 still supersedes S1 after the upgrade' : 'a parent reopened before the upgrade is left open');
    } finally { t.cleanup(); }
  }
});

test('a recorder migrates a version-1 record it opens, and stays silent on a newer one', () => {
  const t = setup();
  try {
    writeVersion1(t);
    const prompt = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'c-1', prompt: 'hello from the worker' });
    const r = ok(t.run(['hook', 'claude'], { ORCHESTRATOR_SESSION: '1' }, prompt));
    assert.strictEqual(r.stdout + r.stderr, '');
    const d = t.open();
    assert.strictEqual(d.prepare('PRAGMA user_version').get().user_version, store.SCHEMA_VERSION);
    assert.deepStrictEqual(store.recentPrompts(d, 1, 5).map(p => p.text), ['hello from the worker']);
    d.exec(`PRAGMA user_version = ${store.SCHEMA_VERSION + 1}`);
    d.close();
    const newer = ok(t.run(['hook', 'claude'], { ORCHESTRATOR_SESSION: '1' }, prompt));
    assert.strictEqual(newer.stdout + newer.stderr, '', 'a recorder never prints');
    assert.match(fs.readFileSync(`${t.db}.hook.log`, 'utf8'), /claude prompt: .*Update the brain/);
    assert.match(t.run(['find']).stderr, /Update the brain/);
  } finally { t.cleanup(); }
});

// ─── Status, stop, report ────────────────────────────────────────────────────

test('status --ask is a best-effort request that never claims the summary is fresh', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Fix login', '--request', 'fix', '--reason', 'r']));
    assert.match(ok(t.run(['status', 'S1'])).stdout, /summary last reported: never/);
    ok(t.run(['report', '--summary', 'old summary'], { ORCHESTRATOR_SESSION: '1' }));
    t.patchRow(1, { summary_at: new Date(Date.now() - 3 * 3600e3).toISOString() });

    let out = ok(t.run(['status', 'S1', '--ask'])).stdout;
    assert.match(out, /^asked: yes, and its turn ended\nsummary last reported: 3h ago/, 'a turn that did not report leaves the old age');
    assert.doesNotMatch(out, /refreshed/);
    assert.ok(t.herdrState().prompts.at(-1).wait);

    const report = `ORCHESTRATOR_SESSION=1 ORCHESTRATOR_DB='${t.db}' '${process.execPath}' '${CLI}' report --summary 'footer done'`;
    t.patchHerdr(s => { s.onPromptWait = report; });
    out = ok(t.run(['status', 'S1', '--ask'])).stdout;
    assert.match(out, /summary last reported: just now[\s\S]*summary: footer done/);

    t.patchHerdr(s => { s.onPromptWait = null; s.promptPlan = ['timeout']; });
    assert.match(ok(t.run(['status', 'S1', '--ask'])).stdout, /^asked: yes, but .*timed out/);

    t.patchHerdr(s => { s.panes[first.pane_id].agent_status = 'working'; });
    const prompts = t.herdrState().prompts.length;
    assert.match(ok(t.run(['status', 'S1', '--ask'])).stdout, /^asked: no: the worker is working/);
    assert.strictEqual(t.herdrState().prompts.length, prompts);
  } finally { t.cleanup(); }
});

test('a worker that reports its worktree is relabelled <worktree> (<persona>), and keeps that label on resume', () => {
  const t = setup();
  try {
    ok(t.run(['start']));
    const first = json(t.run(['new', '--json', '--title', 'Fix login', '--request', 'fix it', '--reason', 'r', '--persona', 'web-engineer', '--ticket', 'FAC-41']));
    assert.strictEqual(first.label, 'FAC-41 S1 fix-login (web-engineer)');
    assert.match(t.herdrState().prompts.at(-1).text, /report --worktree <path>|--worktree <path>/);
    const worktree = path.join(t.dir, 'FAC-41-login-fix');
    fs.mkdirSync(worktree);
    ok(t.run(['report', '--worktree', worktree], { ORCHESTRATOR_SESSION: '1' }));
    assert.strictEqual(t.row(1).worktree, worktree);
    assert.deepStrictEqual(t.herdrState().renames.at(-1), [first.tab_id, 'FAC-41-login-fix (web-engineer)']);
    assert.match(ok(t.run(['status', 'S1'])).stdout, new RegExp(`worktree: ${worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    t.patchHerdr(s => { delete s.panes[first.pane_id]; });
    const resumed = json(t.run(['resume', 'S1', '--json', '--request', 'and the footer', '--reason', 'its tab was closed']));
    assert.strictEqual(resumed.label, 'FAC-41-login-fix (web-engineer)');
    assert.strictEqual(t.herdrState().panes[resumed.pane_id].label, 'FAC-41-login-fix (web-engineer)');

    // A new conversation of the session continues in that worktree, and is not asked to make one.
    t.patchHerdr(s => { delete s.panes[resumed.pane_id]; });
    json(t.run(['relaunch', 'S1', '--json', '--request', 'and the logo', '--reason', 'stale context']));
    const relaunchBrief = t.herdrState().prompts.at(-1).text;
    const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(relaunchBrief, new RegExp(`Its worktree is ${esc(worktree)}: continue there, and do not create another`));
    assert.strictEqual(relaunchBrief.split(worktree).length - 1, 1, 'stated once');

    // Removed after its PR opened: a fresh conversation (transcript gone) is told to make it again.
    fs.rmSync(worktree, { recursive: true });
    const transcript = path.join(t.dir, 'gone.jsonl');
    t.patchRow(1, { transcript_path: transcript });
    t.patchHerdr(s => { for (const p of Object.values(s.panes)) if (p.pane_id !== 'w1:p0') delete s.panes[p.pane_id]; });
    json(t.run(['resume', 'S1', '--json', '--request', 'review feedback', '--reason', 'its tab was closed']));
    assert.match(t.herdrState().prompts.at(-1).text, new RegExp(`Its worktree ${esc(worktree)} is gone: create it again for the same branch, and report it with --worktree`));

    // A session made from it sees the worktree as the earlier session's.
    json(t.run(['new', '--json', '--from', 'S1', '--title', 'Login follow-up', '--request', 'the footer', '--reason', 'r']));
    assert.match(t.herdrState().prompts.at(-1).text, new RegExp(`- worktree: ${esc(worktree)} \\(the earlier session's; create your own unless the user said to continue it\\)`));
    assert.doesNotMatch(t.herdrState().prompts.at(-1).text, /Its worktree is/);

    // A report that names no usable worktree, or the project checkout, is refused and writes nothing.
    for (const bad of [' ', '/', t.row(1).cwd]) {
      assert.strictEqual(t.run(['report', '--summary', 'should not land', '--worktree', bad], { ORCHESTRATOR_SESSION: '1' }).status, 2, JSON.stringify(bad));
    }
    assert.strictEqual(t.row(1).worktree, worktree);
    assert.notStrictEqual(t.row(1).summary, 'should not land');
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

    // Blocked mid-turn on a permission prompt: a refused send leaves its request held, and stop still refuses.
    json(t.run(['resume', 'S1', '--json', '--request', 'continue', '--reason', 'r']));
    const pane = t.row(1).pane_id;
    t.patchHerdr(s => { s.panes[pane].agent_status = 'blocked'; s.promptPlan = ['reject']; });
    assert.match(t.run(['send', 'S1', '--request', 'also tag it', '--reason', 'r']).stderr, /the request is held/);
    assert.match(t.run(['stop', 'S1']).stderr, /is blocked; wait for it to settle, or pass --force/);
    assert.ok(t.herdrState().panes[pane], 'the blocked worker keeps running');
    assert.strictEqual(store.pendingOf(t.row(1)).length, 1, 'and its held request is kept');
    assert.strictEqual(json(t.run(['stop', 'S1', '--json', '--force'])).action, 'closed');

    // Blocked at startup on a trust prompt: the same rule, the user's call.
    t.patchHerdr(s => { s.blockStart = true; });
    const waiting = json(t.run(['resume', 'S1', '--json', '--reason', 'r']));
    assert.strictEqual(waiting.action, 'waiting');
    assert.match(t.run(['stop', 'S1']).stderr, /is blocked/);
    assert.strictEqual(json(t.run(['stop', 'S1', '--json', '--force'])).action, 'closed');
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
