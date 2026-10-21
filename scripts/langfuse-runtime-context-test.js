'use strict';

// Offline only: synthetic Git repositories and private temporary protocol state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const test = require('node:test');
const { ContextStore } = require('../runtime/langfuse/context.cjs');
const uuid = () => crypto.randomUUID();
const span = () => crypto.randomBytes(8).toString('hex');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull,
    GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
    GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' } }).trim();

// These subprocesses exercise the real filesystem protocol, not an in-memory mock.
if (process.argv[2] === '--worker') {
  const [stateDir, operation, encoded] = process.argv.slice(3);
  const store = new ContextStore({ stateDir });
  const args = JSON.parse(encoded);
  const result = operation === 'drain' ? store.takePending(args)
    : operation === 'claim' ? store.claimLaunch(args.identity, { claimId: args.claimId })
      : store.createLaunch(args.parent, { launchId: args.launchId });
  process.stdout.write(JSON.stringify(result));
} else {
  function fixture(t, options = {}) {
    // macOS /var and /tmp are system symlinks; explicitly choose their real
    // temporary directory, since the store intentionally refuses symlink paths.
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'brain-context-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'principal');
    fs.mkdirSync(cwd);
    git(cwd, 'init', '-q');
    git(cwd, 'checkout', '-q', '-b', 'feature/AKA-42-lineage');
    git(cwd, 'commit', '-q', '--allow-empty', '-m', 'synthetic');
    const stateDir = path.join(root, 'private-state');
    const store = new ContextStore({ stateDir, ...options });
    const run = (extra = {}) => store.createRun({ harness: 'pi', nativeSessionId: uuid(), cwd, ...extra });
    return { root, cwd, stateDir, store, run };
  }
  function records(run) {
    return [{ id: run.rootSpanId, traceId: run.traceId, parentId: run.parentSpanId,
      sessionId: run.sessionId, nativeSessionId: run.nativeSessionId, type: 'span', name: 'agent.turn',
      startTime: run.startedAt, endTime: run.startedAt, context: run, outcome: 'success' },
    { id: span(), traceId: run.traceId, parentId: run.rootSpanId,
      sessionId: run.sessionId, nativeSessionId: run.nativeSessionId, type: 'generation', name: 'model.generate',
      startTime: run.startedAt, endTime: run.startedAt, model: 'synthetic-model', provider: 'synthetic',
      usage: { inputTokens: 4, outputTokens: 2 }, cost: { total: 0.01 } }];
  }
  function worker(stateDir, operation, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [__filename, '--worker', stateDir, operation, JSON.stringify(args)],
        { env: { ...process.env, PI_CODING_AGENT_DIR: path.join(stateDir, `isolated-agent-${uuid()}`) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject);
      child.on('close', code => code ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)));
    });
  }

  test('expired pending payloads never make provisional parents exportable', t => {
    let now = Date.now();
    const f = fixture(t, { now: () => now });
    const child = f.run();
    f.store.hold({ identity: { launchId: 'awaiting-exact-caller' }, run: child, records: [] });
    now += 23 * 60 * 60 * 1000 + 59 * 60 * 1000;
    const grandchild = f.store.createLaunch(child);
    now += 2 * 60 * 1000;
    assert.equal(f.store.resolveLaunch({ nonce: grandchild.nonce }), null);
    assert.equal(f.store.inspectLaunch({ nonce: grandchild.nonce }).ancestryPending, true);
    now += 25 * 60 * 60 * 1000;
    const refreshed = f.store.updateRun(child, { persona: 'scout' });
    const later = f.store.createLaunch(refreshed);
    assert.equal(f.store.resolveLaunch({ nonce: later.nonce }), null, 'metadata refresh must not clear the unresolved lineage marker');
  });

  test('root context is allocated before tools; turns share only the session and never ambient traceparent', t => {
    const f = fixture(t);
    const old = process.env.TRACEPARENT;
    process.env.TRACEPARENT = '00-11111111111111111111111111111111-2222222222222222-01';
    t.after(() => { if (old === undefined) delete process.env.TRACEPARENT; else process.env.TRACEPARENT = old; });
    const nativeSessionId = uuid();
    const first = f.run({ nativeSessionId });
    const next = f.run({ nativeSessionId });
    assert.match(first.traceId, /^[0-9a-f]{32}$/);
    assert.match(first.rootSpanId, /^[0-9a-f]{16}$/);
    assert.notEqual(first.traceId, '11111111111111111111111111111111');
    assert.notEqual(first.traceId, next.traceId);
    assert.notEqual(first.rootSpanId, next.rootSpanId);
    assert.equal(first.sessionId, next.sessionId);
    assert.equal(first.parentSpanId, null);
    assert.equal(first.runtimeName, 'principal');
    assert.equal(first.agentName, null);
    assert.equal(first.ticketId, 'AKA-42');
    assert.equal(first.ticketSource, 'inferred');
    assert.deepEqual(f.store.getSession('pi', nativeSessionId), next);
    assert.equal(f.store.getSession('claude', nativeSessionId), null);
  });

  test('default storage is per-user and independent of cwd and isolated Pi directories', t => {
    const f = fixture(t);
    const originalHome = os.homedir;
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    // Only replace the home lookup in this process; never touch user state.
    os.homedir = () => f.root;
    try {
      process.env.PI_CODING_AGENT_DIR = path.join(f.root, 'isolated-pi-one');
      const one = new ContextStore();
      const nativeSessionId = uuid();
      const run = one.createRun({ harness: 'pi', nativeSessionId, cwd: f.cwd });
      process.env.PI_CODING_AGENT_DIR = path.join(f.root, 'isolated-pi-two');
      const two = new ContextStore();
      assert.equal(one.stateDir, path.join(f.root, '.cache', 'agent-brain', 'tracing-state'));
      assert.deepEqual(two.getSession('pi', nativeSessionId), run);
      assert.ok(!fs.existsSync(process.env.PI_CODING_AGENT_DIR));
    } finally {
      os.homedir = originalHome;
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
  });

  test('Pi and Claude children inherit exact lineage while agent and runtime labels stay separate', t => {
    const f = fixture(t);
    const parent = f.run({ harness: 'claude', ticketId: 'ABC-99', persona: 'lead' });
    const child = f.run({ parent, agentName: 'builder', persona: 'engineer', requestedModel: 'synthetic', requestedEffort: 'high' });
    assert.equal(child.traceId, parent.traceId);
    assert.equal(child.sessionId, parent.sessionId);
    assert.equal(child.parentSpanId, parent.rootSpanId);
    assert.equal(child.parentSessionId, parent.nativeSessionId);
    assert.equal(child.ticketId, 'ABC-99');
    assert.equal(child.ticketSource, 'explicit');
    assert.equal(child.runtimeName, 'principal');
    assert.equal(child.agentName, 'builder');
    const grandchild = f.run({ harness: 'claude', parent: child });
    assert.equal(grandchild.parentSpanId, child.rootSpanId);
    assert.equal(grandchild.traceId, parent.traceId);
  });

  test('Git worktrees and credential-free normalized remotes have one canonical project', t => {
    const f = fixture(t);
    git(f.cwd, 'remote', 'add', 'origin', 'https://synthetic-user:synthetic-password@example.invalid/team/project.git?token=synthetic#private');
    const main = f.run();
    const worktree = path.join(f.root, 'actual-worktree');
    git(f.cwd, 'worktree', 'add', '-q', '-b', 'task/ABC-51', worktree);
    const child = f.run({ cwd: worktree, agentName: 'separate-label' });
    assert.equal(main.projectId, child.projectId);
    assert.notEqual(main.worktreeId, child.worktreeId);
    assert.equal(child.runtimeName, 'actual-worktree');
    assert.equal(child.projectName, 'project');
    git(f.cwd, 'remote', 'set-url', 'origin', 'git@example.invalid:team/project.git');
    assert.equal(f.run().projectId, main.projectId);
    git(f.cwd, 'remote', 'remove', 'origin');
    assert.equal(f.run().projectId, f.run({ cwd: worktree }).projectId);
    const disk = fs.readFileSync(f.store.file, 'utf8');
    for (const raw of ['synthetic-user', 'synthetic-password', 'token=', 'example.invalid', f.cwd, worktree]) assert.ok(!disk.includes(raw), raw);
  });

  test('tickets are explicit, uniquely inferred, or unknown; no invented fallback', t => {
    const f = fixture(t);
    git(f.cwd, 'checkout', '-q', '-b', 'feature/AKA-42-and-ABC-51');
    assert.equal(f.run().ticketId, null);
    assert.equal(f.run().ticketSource, 'unknown');
    assert.equal(f.run({ ticketId: 'XYZ-21' }).ticketSource, 'explicit');
    git(f.cwd, 'checkout', '-q', '--detach');
    const detached = f.run();
    assert.equal(detached.branch, null);
    assert.equal(detached.ticketId, null);
    git(f.cwd, 'checkout', '-q', '-b', 'feature/no-ticket');
    assert.equal(f.run().ticketSource, 'unknown');
  });

  test('persisted sessions and updates only contain allowlisted normalized metadata', t => {
    const f = fixture(t);
    const run = f.run();
    f.store.saveSession({ ...run, input: 'DO_NOT_STORE', env: { PRIVATE: 'DO_NOT_STORE' }, cwd: '/DO_NOT_STORE' });
    const updated = f.store.updateRun(run, { skillsInvoked: ['review', 'review'], skillsLoaded: ['coding-standards'] });
    assert.deepEqual(updated.skillsInvoked, ['review']);
    assert.throws(() => f.store.updateRun(run, { traceId: '1'.repeat(32) }), /Invalid/);
    assert.throws(() => f.store.updateRun(run, { input: 'DO_NOT_STORE' }), /Invalid/);
    assert.throws(() => f.store.updateRun(run, { agentName: 'a@example.invalid' }), /Invalid/);
    assert.throws(() => f.run({ nativeSessionId: '/private/session.jsonl' }), /Invalid/);
    assert.throws(() => f.run({ parent: { ...run, traceId: '0'.repeat(32) } }), /Invalid/);
    assert.throws(() => f.run({ parent: { ...run, rootSpanId: '0'.repeat(16) } }), /Invalid/);
    const hashed = f.run({ nativeSessionId: crypto.createHash('sha256').update('synthetic').digest('hex') });
    assert.equal(hashed.nativeSessionId.length, 64);
    assert.ok(!fs.readFileSync(f.store.file, 'utf8').includes('DO_NOT_STORE'));
  });

  test('historical rebase and metadata persistence never change the selector, even inside the transaction', t => {
    const f = fixture(t), parent = f.run({ ticketId: 'TEST-17' });
    const nativeSessionId = uuid(), first = f.run({ nativeSessionId, requestedEffort: 'low' });
    const identity = { launchId: 'historical-exact-child' };
    f.store.hold({ identity, run: first, records: records(first) });
    f.store.updateRun(first, { requestedEffort: 'high' });
    const second = f.run({ nativeSessionId });
    const original = f.store._transaction.bind(f.store);
    // Inspect before lock release: a read/select/restore workaround must fail,
    // not merely happen to leave the right selector after the method returns.
    f.store._transaction = fn => original((state, now) => {
      const result = fn(state, now);
      assert.equal(state.sessions[f.store._sessionKey('pi', nativeSessionId)].run.runId, second.runId);
      return result;
    });
    f.store.createLaunch(parent, { launchId: identity.launchId });
    const drained = f.store.takePending(identity)[0];
    assert.equal(drained.run.traceId, parent.traceId);
    assert.equal(drained.run.requestedEffort, 'high', 'the early hold must not roll back current metadata');
    assert.equal(drained.records[0].context.requestedEffort, 'low', 'held observations keep captured semantics');
    const saved = f.store.saveRun({ ...first, persona: 'builder', ticketId: 'TEST-17', ticketSource: 'explicit' });
    assert.equal(saved.traceId, parent.traceId, 'no-select saves still preserve canonical lineage');
    assert.equal(f.store.getRun(first.runId).persona, 'builder');
    f.store.updateRun(first, { observedEffort: 'medium' });
    assert.equal(f.store.getRun(first.runId).observedEffort, 'medium');
    f.store.updateRun(second, { requestedEffort: 'high' });
    assert.equal(f.store.getSession('pi', nativeSessionId).requestedEffort, 'high', 'selected-run metadata still refreshes');
    assert.equal(f.store.getSession('pi', nativeSessionId).runId, second.runId);
    f.store._transaction = original;
    // Expired/absent selectors are not recreated by historical persistence.
    original(state => { delete state.sessions[f.store._sessionKey('pi', nativeSessionId)]; });
    f.store.saveRun(saved);
    f.store.updateRun(saved, { observedEffort: 'high' });
    assert.equal(f.store.getSession('pi', nativeSessionId), null);
    assert.equal(f.store.saveSession(saved).runId, first.runId, 'explicit selection remains available');
    assert.equal(f.store.getSession('pi', nativeSessionId).runId, first.runId);
  });

  test('exact aliases are hashed, all supplied identities must agree, and names never correlate', t => {
    const f = fixture(t);
    const first = f.run({ agentName: 'same-name' });
    const second = f.run({ agentName: 'same-name' });
    const sessionFile = path.join(f.root, 'private-child-session.jsonl');
    const a = f.store.createLaunch(first, { launchId: 'exact-herdr-id-A', sessionFile, child: { persona: 'builder', agentName: 'same-name' } });
    const b = f.store.createLaunch(second, { launchId: 'exact-herdr-id-B' });
    for (const input of [{ nonce: a.nonce }, { launchId: 'exact-herdr-id-A' }, { sessionFile }]) {
      assert.equal(f.store.resolveLaunch(input).parent.runId, first.runId);
    }
    assert.equal(f.store.resolveLaunch({ nonce: a.nonce, launchId: 'exact-herdr-id-B' }), null);
    assert.equal(f.store.resolveLaunch({ nonce: b.nonce, sessionFile }), null);
    assert.equal(f.store.resolveLaunch({ nonce: a.nonce, launchId: 'not-bound' }), null);
    assert.equal(f.store.resolveLaunch({ launchId: 'same-name' }), null);
    assert.throws(() => f.store.bindLaunch(second, { launchId: 'exact-herdr-id-A' }), /Mismatched/);
    assert.throws(() => f.store.bindLaunch(first, { launchId: 'exact-herdr-id-A',
      sessionFile: path.join(f.root, 'different-session.jsonl') }), /Mismatched/);
    assert.throws(() => f.store.bindLaunch(first, { launchId: 'different-pane', sessionFile }), /Mismatched/);
    const aliased = f.store.bindLaunch(first, { launchId: 'exact-herdr-id-A', sessionFile,
      child: { persona: 'builder', agentName: 'same-name' } });
    assert.equal(f.store.resolveLaunch({ nonce: aliased.nonce }).parent.runId, first.runId);
    const disk = fs.readFileSync(f.store.file, 'utf8');
    for (const raw of [a.nonce, b.nonce, 'exact-herdr-id-A', 'private-child-session.jsonl', sessionFile]) assert.ok(!disk.includes(raw));
    assert.throws(() => f.store.resolveLaunch({}), /Invalid/);
  });

  test('launcher can attach an exact pane and session to an already allocated capability', t => {
    const f = fixture(t);
    const parent = f.run();
    const launch = f.store.createLaunch(parent, { child: { persona: 'builder' } });
    const input = { nonce: launch.nonce, launchId: 'target-pane', sessionFile: path.join(f.root, 'target-session.jsonl') };
    const bound = f.store.bindLaunch(parent, input);
    assert.equal(bound.nonce, launch.nonce);
    const resolved = f.store.resolveLaunch(input);
    assert.equal(resolved.parent.runId, parent.runId);
    assert.equal(resolved.child.persona, 'builder');
    assert.throws(() => f.store.bindLaunch(parent, { nonce: crypto.randomBytes(32).toString('base64url'), launchId: 'target-pane' }), /Unknown/);
  });

  test('child exits before binding: unresolved records stay private then rebase once, retaining span IDs', t => {
    const f = fixture(t);
    const parent = f.run({ harness: 'claude' });
    const provisional = f.run();
    const input = { launchId: 'late-exact', sessionFile: path.join(f.root, 'late-session.jsonl') };
    const originalRecords = records(provisional);
    originalRecords[1].context = provisional;
    originalRecords[1].model = 'synthetic/synthetic-model';
    assert.deepEqual(f.store.hold({ identity: input, run: provisional, records: originalRecords }), { pending: true });
    assert.deepEqual(f.store.takePending(input), []);
    assert.equal(f.store.resolveLaunch(input), null);
    f.store.bindLaunch(parent, input);
    const drained = f.store.takePending(input);
    assert.equal(drained.length, 1);
    assert.equal(drained[0].run.traceId, parent.traceId);
    assert.equal(drained[0].run.sessionId, parent.sessionId);
    assert.equal(drained[0].run.parentSpanId, parent.rootSpanId);
    assert.equal(drained[0].run.rootSpanId, provisional.rootSpanId);
    assert.equal(drained[0].records[0].parentId, parent.rootSpanId);
    assert.equal(drained[0].records[0].context.traceId, parent.traceId);
    assert.equal(drained[0].records[1].parentId, provisional.rootSpanId);
    assert.equal(drained[0].records[1].context.parentSpanId, parent.rootSpanId);
    assert.deepEqual(drained[0].records.map(r => r.id), originalRecords.map(r => r.id));
    assert.equal(f.store.getSession('pi', provisional.nativeSessionId).traceId, parent.traceId);
    assert.deepEqual(f.store.takePending(input), []);
    assert.deepEqual(f.store.hold({ identity: input, run: provisional, records: originalRecords }), { pending: false });
    assert.deepEqual(f.store.takePending(input), []);
    assert.equal(f.store.saveSession(provisional).traceId, parent.traceId);
    assert.equal(f.run({ parent: provisional }).traceId, parent.traceId);
    const nested = f.store.createLaunch(provisional);
    assert.equal(f.store.resolveLaunch({ nonce: nested.nonce }).parent.traceId, parent.traceId);
  });

  test('parallel pending children bind to exact parents despite identical names and completion order', t => {
    const f = fixture(t);
    const parents = [f.run({ agentName: 'same' }), f.run({ agentName: 'same' })];
    const children = [f.run({ agentName: 'same' }), f.run({ agentName: 'same' })];
    children.forEach((run, i) => f.store.hold({ identity: { launchId: `id-${i}` }, run, records: records(run) }));
    f.store.bindLaunch(parents[1], { launchId: 'id-1' });
    f.store.bindLaunch(parents[0], { launchId: 'id-0' });
    for (const i of [1, 0]) {
      const result = f.store.takePending({ launchId: `id-${i}` });
      assert.equal(result[0].run.traceId, parents[i].traceId);
      assert.equal(result[0].run.rootSpanId, children[i].rootSpanId);
    }
  });

  test('nested unresolved grandchildren cannot drain against a provisional parent', t => {
    const f = fixture(t);
    const parent = f.run();
    const child = f.run();
    const grandchild = f.run({ parent: child });
    f.store.hold({ identity: { launchId: 'child' }, run: child, records: [] });
    const grandLaunch = f.store.createLaunch(child, { launchId: 'grandchild' });
    f.store.hold({ identity: { launchId: 'grandchild' }, run: grandchild, records: records(grandchild) });
    assert.equal(f.store.resolveLaunch({ nonce: grandLaunch.nonce }), null);
    assert.deepEqual(f.store.takePending({ launchId: 'grandchild' }), []);
    f.store.hold({ identity: { launchId: 'child' }, run: child, records: records(child) });
    f.store.bindLaunch(parent, { launchId: 'child' });
    assert.equal(f.store.takePending({ launchId: 'child' })[0].run.traceId, parent.traceId);
    const resolvedGrand = f.store.resolveLaunch({ nonce: grandLaunch.nonce });
    assert.equal(resolvedGrand.parent.traceId, parent.traceId);
    const result = f.store.takePending({ launchId: 'grandchild' });
    assert.equal(result[0].run.traceId, parent.traceId);
    assert.equal(result[0].run.parentSpanId, child.rootSpanId);
    assert.equal(result[0].records[1].parentId, grandchild.rootSpanId);
    assert.deepEqual(f.store.takePending({ launchId: 'child' }), []);
  });

  test('early unresolved markers may be rebased before sanitized completion arrives', t => {
    const f = fixture(t);
    const parent = f.run();
    const child = f.run();
    const grandchild = f.run({ parent: child });
    f.store.hold({ identity: { launchId: 'early-child' }, run: child, records: [] });
    f.store.createLaunch(child, { launchId: 'early-grandchild' });
    assert.equal(f.store.resolveLaunch({ launchId: 'early-grandchild' }), null);
    f.store.bindLaunch(parent, { launchId: 'early-child' });
    const marker = f.store.takePending({ launchId: 'early-child' });
    assert.equal(marker[0].run.traceId, parent.traceId);
    assert.deepEqual(marker[0].records, []);
    assert.equal(f.store.resolveLaunch({ launchId: 'early-grandchild' }).parent.traceId, parent.traceId);
    // The early marker is not a completed-observation replay tombstone.
    f.store.hold({ identity: { launchId: 'early-child' }, run: child, records: records(child) });
    const complete = f.store.takePending({ launchId: 'early-child' });
    assert.equal(complete[0].records.length, 2);
    assert.equal(complete[0].run.traceId, parent.traceId);
    f.store.hold({ identity: { launchId: 'early-grandchild' }, run: grandchild, records: records(grandchild) });
    assert.equal(f.store.takePending({ launchId: 'early-grandchild' })[0].run.traceId, parent.traceId);
  });

  test('projected launch references preserve exact matching without accepting mixed or forged scope handles', t => {
    const f = fixture(t), parent = f.run();
    const launch = f.store.createLaunch(parent, { launchId: 'private native alias', sessionFile: path.join(f.root, 'private transcript.jsonl') });
    const reference = f.store.referenceLaunch({ nonce: launch.nonce, launchId: 'private native alias' });
    assert.ok(!JSON.stringify(reference).includes('private native alias'));
    assert.equal(f.store.resolveLaunch(reference).parent.runId, parent.runId);
    assert.equal(f.store.resolveLaunch(reference).nonce, launch.nonce);
    assert.throws(() => f.store.resolveLaunch({ ...reference, launchId: 'private native alias' }), /Invalid/);
    assert.throws(() => f.store.resolveLaunch({ ...reference, capability: 'a'.repeat(32) }), /Invalid/);
    assert.throws(() => f.store.resolveLaunch({ reference: ['launchId:not-a-digest'] }), /Invalid/);
  });

  test('atomic late drain owns one native session, not every matching candidate or provisional trace sibling', t => {
    const f = fixture(t), provisionalParent = f.run(), target = f.run();
    const identity = { launchId: 'competing-late-consumers' };
    const first = f.run({ parent: provisionalParent }), other = f.run({ parent: provisionalParent });
    const nextTurn = f.run({ parent: provisionalParent, nativeSessionId: first.nativeSessionId });
    for (const run of [first, other, nextTurn]) f.store.hold({ identity, run, records: [] });
    const descendants = [f.run({ parent: first }), f.run({ parent: other })];
    const launches = [f.store.createLaunch(descendants[0]), f.store.createLaunch(descendants[1])];
    f.store.createLaunch(target, { launchId: identity.launchId });
    const drained = f.store.takePending(identity);
    assert.deepEqual(drained.map(item => item.run.runId), [first.runId, nextTurn.runId]);
    assert.equal(f.store.getRun(other.runId).traceId, provisionalParent.traceId);
    assert.equal(f.store.getRun(provisionalParent.runId).parentSpanId, null);
    assert.equal(f.store.getRun(descendants[0].runId).traceId, target.traceId);
    assert.equal(f.store.getRun(descendants[1].runId).traceId, provisionalParent.traceId);
    assert.equal(f.store.resolveLaunch({ nonce: launches[0].nonce }).parent.traceId, target.traceId);
    assert.equal(f.store.resolveLaunch({ nonce: launches[1].nonce }), null, 'losing descendant is still unresolved');
    assert.equal(f.store.claimLaunch(identity, { claimId: `pi:${other.nativeSessionId}` }), null);
    assert.ok(f.store.claimLaunch(identity, { claimId: `pi:${first.nativeSessionId}` }));
    assert.deepEqual(f.store.takePending(identity), []);
    const persisted = new ContextStore({ stateDir: f.stateDir });
    assert.equal(persisted.claimLaunch(identity, { claimId: `pi:${other.nativeSessionId}` }), null);
    assert.equal(persisted.getSession('pi', first.nativeSessionId).runId, nextTurn.runId);
  });

  test('already linked pending records do not incorrectly block their own parent', t => {
    const f = fixture(t);
    const parent = f.run();
    const child = f.run({ parent });
    f.store.bindLaunch(parent, { launchId: 'linked-child' });
    f.store.hold({ identity: { launchId: 'linked-child' }, run: child, records: records(child) });
    const result = f.store.takePending({ launchId: 'linked-child' });
    assert.equal(result.length, 1);
    assert.equal(result[0].run.parentSpanId, parent.rootSpanId);
    assert.equal(result[0].run.traceId, parent.traceId);
    // Parent must remain a root, not be spuriously rebased into its own child.
    assert.equal(f.store.getSession('pi', parent.nativeSessionId).parentSpanId, null);
  });

  test('pending storage rejects raw/unknown fields, nested payloads, mismatched IDs, and differing replays', t => {
    const f = fixture(t);
    const run = f.run();
    const base = records(run)[0];
    const hold = record => f.store.hold({ identity: { launchId: 'private' }, run, records: [record] });
    for (const key of ['input', 'output', 'content', 'args', 'env', 'cwd', 'errors', 'metadata']) {
      assert.throws(() => hold({ ...base, [key]: 'PRIVATE_CANARY' }), /Invalid/);
      assert.throws(() => hold({ ...base, context: { [key]: 'PRIVATE_CANARY' } }), /Invalid/);
    }
    assert.throws(() => hold({ ...base, name: 'raw user message' }), /Invalid/);
    assert.throws(() => hold({ ...base, usage: { raw: 'PRIVATE_CANARY' } }), /Invalid/);
    assert.throws(() => hold({ ...base, outcome: 'PRIVATE_CANARY' }), /Invalid/);
    assert.throws(() => hold({ ...base, traceId: '1'.repeat(32) }), /Invalid/);
    assert.throws(() => hold({ ...base, traceId: '0'.repeat(32) }), /Invalid/);
    assert.throws(() => f.store.hold({ identity: { launchId: 'private' }, run, records: Array(257).fill(base) }), /Invalid/);
    assert.deepEqual(hold(base), { pending: true });
    assert.deepEqual(hold(base), { pending: true });
    assert.throws(() => hold({ ...base, name: 'different' }), /replay/);
    assert.ok(!fs.readFileSync(f.store.file, 'utf8').includes('PRIVATE_CANARY'));
  });

  test('TTL expires unresolved contexts and aliases without guessing or reusing stale panes', t => {
    let now = 1800000000000;
    const f = fixture(t, { now: () => now });
    const parent = f.run();
    const child = f.run();
    const launch = f.store.createLaunch(parent, { launchId: 'stale-pane' });
    f.store.hold({ identity: { launchId: 'stale-pane' }, run: child, records: records(child) });
    now += 24 * 3600000 + 1;
    assert.equal(f.store.resolveLaunch({ nonce: launch.nonce }), null);
    assert.deepEqual(f.store.takePending({ launchId: 'stale-pane' }), []);
    assert.throws(() => f.store.createLaunch(f.run(), { launchId: 'stale-pane' }), /expired/);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(f.store.file, 'utf8')).pending).length, 0);
    now += 8 * 24 * 3600000;
    assert.equal(f.store.getSession('pi', parent.nativeSessionId), null);
  });

  test('capacity fails closed rather than evicting a live binding', t => {
    const f = fixture(t);
    const parent = f.run();
    const launch = f.store.createLaunch(parent, { launchId: 'retained' });
    const state = JSON.parse(fs.readFileSync(f.store.file, 'utf8'));
    const template = Object.values(state.launches)[0];
    for (let i = 1; i < 4096; i++) state.launches[`synthetic-${i}`] = { ...template, aliases: [`launchId:${i}`] };
    fs.writeFileSync(f.store.file, JSON.stringify(state));
    assert.throws(() => f.store.createLaunch(parent, { launchId: 'overflow' }), /capacity/);
    assert.equal(f.store.resolveLaunch({ nonce: launch.nonce }).parent.runId, parent.runId);
  });

  test('private directories and atomic files reject symlinks, hardlinks and unsafe permissions', t => {
    const f = fixture(t);
    f.run();
    assert.equal(fs.statSync(f.stateDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(f.store.file).mode & 0o777, 0o600);
    const link = path.join(f.root, 'state-link');
    fs.symlinkSync(f.stateDir, link);
    assert.throws(() => new ContextStore({ stateDir: link }), /Unsafe/);
    assert.throws(() => new ContextStore({ stateDir: path.join(link, 'nested') }), /Unsafe/);
    fs.chmodSync(f.stateDir, 0o755);
    assert.throws(() => new ContextStore({ stateDir: f.stateDir }), /Unsafe/);
    fs.chmodSync(f.stateDir, 0o700);
    fs.chmodSync(f.store.file, 0o644);
    assert.throws(() => f.store.getSession('pi', uuid()), /Unsafe/);
    fs.chmodSync(f.store.file, 0o600);
    const hardlink = path.join(f.root, 'hardlink');
    fs.linkSync(f.store.file, hardlink);
    assert.throws(() => f.store.getSession('pi', uuid()), /Unsafe/);
    fs.unlinkSync(hardlink);
    const actual = path.join(f.root, 'actual.json');
    fs.renameSync(f.store.file, actual);
    fs.symlinkSync(actual, f.store.file);
    assert.throws(() => f.store.getSession('pi', uuid()), /ELOOP|symbolic|Unsafe/);
    assert.ok(!fs.existsSync(path.join(f.stateDir, '.context-lock')));
  });

  test('separate processes race to drain exactly once and preserve unrelated launches', { timeout: 30000 }, async t => {
    const f = fixture(t);
    const parent = f.run();
    const child = f.run();
    f.store.hold({ identity: { launchId: 'race-child' }, run: child, records: records(child) });
    f.store.bindLaunch(parent, { launchId: 'race-child' });
    const results = await Promise.all(Array.from({ length: 8 }, () => worker(f.stateDir, 'drain', { launchId: 'race-child' })));
    assert.equal(results.reduce((sum, value) => sum + value.length, 0), 1);
    const launches = await Promise.all(Array.from({ length: 8 }, (_, i) => worker(f.stateDir, 'launch', { parent, launchId: `parallel-${i}` })));
    for (const launch of launches) assert.equal(f.store.resolveLaunch({ nonce: launch.nonce }).parent.runId, parent.runId);
    assert.equal(new Set(launches.map(value => value.nonce)).size, 8);
    assert.deepEqual(fs.readdirSync(f.stateDir).sort(), ['context-claims', 'context-v1.json']);
    assert.deepEqual(fs.readdirSync(path.join(f.stateDir, 'context-claims')), []);
  });

  test('single-use exact claims are cross-process atomic; multi-use is explicit', { timeout: 30000 }, async t => {
    const f = fixture(t);
    const parent = f.run();
    const launch = f.store.createLaunch(parent);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => worker(f.stateDir, 'claim',
      { identity: { nonce: launch.nonce }, claimId: `claimant-${i}` })));
    assert.equal(results.filter(Boolean).length, 1);
    const winner = results.findIndex(Boolean);
    assert.ok(f.store.claimLaunch({ nonce: launch.nonce }, { claimId: `claimant-${winner}` }));
    assert.equal(f.store.claimLaunch({ nonce: launch.nonce }, { claimId: 'other' }), null);
    const multi = f.store.createLaunch(parent, { multiUse: true });
    assert.ok(f.store.claimLaunch({ nonce: multi.nonce }, { claimId: 'one' }));
    assert.ok(f.store.claimLaunch({ nonce: multi.nonce }, { claimId: 'two' }));
  });
}
