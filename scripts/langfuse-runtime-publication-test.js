'use strict';

// Real offline processes stop on publication boundaries, not elapsed sleeps.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const test = require('node:test');
const { ContextStore } = require('../runtime/langfuse/context.cjs');
const { createFlow } = require('../runtime/langfuse/flow.cjs');
const { handleClaudeHook } = require('../runtime/langfuse/claude.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const actor = output => output.hookSpecificOutput.additionalContext.match(/--actor ([A-Za-z0-9_-]+)/)[1];
const delivery = async () => ({ accepted: 0, queued: 0, verified: false });

if (process.argv[2] === '--worker') {
  const f = JSON.parse(process.argv[3]);
  const store = new ContextStore({ stateDir: f.stateDir });
  const flow = createFlow({ harness: 'claude', stateDir: f.stateDir, cwd: f.cwd, store, env: {}, flushOutbox: delivery });
  let created = f.phase === 'drain' ? store.getSession('claude', f.nativeSessionId) : null, stopped = false;
  function barrier(phase) {
    if (f.phase !== phase || stopped) return;
    stopped = true;
    process.send({ barrier: phase, run: created });
    // stdin is a real pipe owned by the test parent. SIGKILL needs no cleanup
    // protocol; continuing the competing-writer case requires one explicit byte.
    const byte = Buffer.alloc(1);
    assert.equal(fs.readSync(0, byte, 0, 1, null), 1);
  }
  const create = store.createRun.bind(store);
  store.createRun = options => {
    created = create(options);
    barrier('create');
    return created;
  };
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    const checkpoint = created && to === flow.stateFile(`run:${created.rootSpanId}`);
    if (checkpoint) barrier('before-checkpoint');
    const result = rename(from, to);
    if (checkpoint) barrier('after-checkpoint');
    return result;
  };
  const take = store.takePending.bind(store);
  store.takePending = identity => {
    const result = take(identity);
    if (result.some(item => item.run.runId === created?.runId)) barrier('drain');
    return result;
  };
  const hook = event => handleClaudeHook({ cwd: f.cwd, session_id: f.sessionId,
    agent_id: f.agentId, hook_event_name: event }, { flow, env: {} });
  (async () => {
    const first = actor(await hook('SubagentStart'));
    const second = actor(await hook('SubagentStart'));
    const child = flow.session(f.nativeSessionId);
    const result = { child, actors: [first, second] };
    if (f.recover) {
      await hook('SubagentStop');
      // A child launched by the recovered, still-provisional actor is itself
      // exactly identified. Its direct descendant exercises the inherited
      // parent path as well as a deferred exact-launch path.
      store.createLaunch(child, { launchId: `brain:pi:${f.grandSession}` });
      const nested = createFlow({ harness: 'pi', stateDir: f.stateDir, cwd: f.cwd, env: {}, flushOutbox: delivery });
      const grandchild = nested.begin({ cwd: f.cwd, nativeSessionId: f.grandSession, reuseSession: true });
      const leaf = nested.begin({ cwd: f.cwd, nativeSessionId: f.leafSession, parent: grandchild, reuseSession: true });
      for (const run of [grandchild, leaf]) nested.submit(run, [
        { id: run.rootSpanId, type: 'AGENT', startTime: Date.parse(run.startedAt), endTime: Date.parse(run.startedAt), outcome: 'completed' },
        { id: nested.id(`generation:${run.runId}`), parentId: run.rootSpanId, type: 'GENERATION',
          startTime: Date.parse(run.startedAt), endTime: Date.parse(run.startedAt), model: 'synthetic-model', outcome: 'completed' }
      ]);
      await nested.flush({ timeoutMs: 10000 });
      result.grandchild = nested.store.getRun(grandchild.runId);
      result.leaf = nested.store.getRun(leaf.runId);
    }
    process.send({ done: result }, () => process.disconnect());
  })().catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
} else {
  function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'brain-publication-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
    const sessionId = crypto.randomUUID(), agentId = 'synthetic-child';
    const digest = hash(`claude:${sessionId}:${agentId}`);
    return { cwd, stateDir: path.join(root, 'state'), sessionId, agentId,
      nativeSessionId: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
      grandSession: crypto.randomUUID(), leafSession: crypto.randomUUID() };
  }
  function worker(t, f) {
    const child = fork(__filename, ['--worker', JSON.stringify(f)], {
      env: { PATH: process.env.PATH }, stdio: ['pipe', 'ignore', 'pipe', 'ipc']
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let stderr = '', lastMessage;
    child.stderr.on('data', bytes => { stderr += bytes; });
    const first = new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject);
      child.once('exit', code => { if (code) reject(new Error(stderr || `worker exited ${code}`)); });
    });
    child.on('message', message => { lastMessage = message; });
    const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    return { child, first, exit, async done() {
      await first;
      const status = await exit;
      assert.equal(status.code, 0, stderr);
      assert.ok(lastMessage?.done, stderr);
      return lastMessage.done;
    } };
  }
  const outbox = f => {
    const dir = path.join(f.stateDir, 'outbox');
    return fs.existsSync(dir) ? fs.readdirSync(dir).map(name => JSON.parse(fs.readFileSync(path.join(dir, name))).record) : [];
  };

  for (const [phase, kill] of [['create', false], ['create', true], ['before-checkpoint', true], ['after-checkpoint', true]]) {
    test(`native publication ${phase}: ${kill ? 'actual SIGKILL/restart' : 'barrier-controlled competing hook'} defers recovery descendants`, { timeout: 60000 }, async t => {
      const f = fixture(t);
      const parentFlow = createFlow({ harness: 'claude', stateDir: f.stateDir, cwd: f.cwd, env: {}, flushOutbox: delivery });
      const parent = parentFlow.begin({ cwd: f.cwd, nativeSessionId: f.sessionId });
      const creator = worker(t, { ...f, phase });
      const boundary = await creator.first;
      assert.equal(boundary.barrier, phase);
      assert.equal(boundary.run.nativeSessionId, f.nativeSessionId);
      const publication = parentFlow.store.getPublication(boundary.run.runId);
      assert.equal(publication.published, true);
      assert.equal(publication.unresolved, true);
      assert.ok(publication.identity.reference.length);
      assert.equal(parentFlow.store.getSession('claude', f.nativeSessionId).runId, boundary.run.runId);
      if (kill) {
        creator.child.kill('SIGKILL');
        assert.deepEqual(await creator.exit, { code: null, signal: 'SIGKILL' });
      }
      const recovered = await worker(t, { ...f, recover: true }).done();
      assert.equal(recovered.child.runId, boundary.run.runId);
      assert.equal(recovered.child.rootSpanId, boundary.run.rootSpanId);
      assert.equal(new Set(recovered.actors).size, 1, 'duplicate project/per-run hooks reuse the exact actor');
      assert.equal(outbox(f).length, 0, 'no terminal child or descendant observation may enqueue before exact binding');
      assert.equal(parentFlow.resolve(recovered.child), null);
      assert.equal(parentFlow.resolve(recovered.grandchild), null);
      assert.equal(parentFlow.resolve(recovered.leaf), null);
      if (!kill) {
        creator.child.stdin.end('x');
        const continued = await creator.done();
        assert.deepEqual(continued.actors, recovered.actors);
        assert.equal(continued.child.runId, recovered.child.runId);
        assert.equal(outbox(f).length, 0, 'late publisher cannot overwrite recovered pending ownership');
      }
      parentFlow.store.createLaunch(parent, { launchId: `claude:${f.sessionId}:${f.agentId}`, multiUse: true });
      await parentFlow.flush({ timeoutMs: 10000 });
      const records = outbox(f);
      assert.equal(new Set(records.map(record => record.id)).size, 5, 'child AGENT plus both descendant AGENT/generation pairs');
      const byId = new Map(records.map(record => [record.id, record]));
      assert.equal(byId.get(boundary.run.rootSpanId).parentId, parent.rootSpanId);
      assert.equal(byId.get(recovered.grandchild.rootSpanId).parentId, boundary.run.rootSpanId);
      assert.equal(byId.get(recovered.leaf.rootSpanId).parentId, recovered.grandchild.rootSpanId);
      for (const run of [recovered.grandchild, recovered.leaf]) {
        assert.equal(byId.get(parentFlow.id(`generation:${run.runId}`)).parentId, run.rootSpanId);
      }
      assert.ok(records.every(record => record.traceId === parent.traceId && record.sessionId === parent.sessionId));
      const retry = await worker(t, { ...f, recover: true }).done();
      assert.deepEqual(retry.actors, recovered.actors, 'binding and restart cannot mint a different child actor');
      for (const key of ['child', 'grandchild', 'leaf']) {
        assert.equal(retry[key].runId, recovered[key].runId);
        assert.equal(retry[key].rootSpanId, recovered[key].rootSpanId);
        assert.equal(retry[key].traceId, parent.traceId);
        assert.equal(retry[key].sessionId, parent.sessionId);
      }
      assert.deepEqual(new Set(outbox(f).map(record => record.id)), new Set(records.map(record => record.id)), 'duplicate completion preserves observation IDs');
      assert.ok(outbox(f).every(record => record.traceId === parent.traceId));
    });
  }

  test('SIGKILL after authoritative rebase but before adapter repair retains binding metadata and IDs', { timeout: 60000 }, async t => {
    const f = fixture(t);
    const flow = createFlow({ harness: 'claude', stateDir: f.stateDir, cwd: f.cwd, env: {}, flushOutbox: delivery });
    const parent = flow.begin({ cwd: f.cwd, nativeSessionId: f.sessionId, ticketId: 'TEST-17' });
    const pending = flow.begin({ cwd: f.cwd, nativeSessionId: f.nativeSessionId,
      pendingIdentity: `claude:${f.sessionId}:${f.agentId}` });
    assert.equal(pending.persona, null);
    assert.equal(pending.ticketId, null);
    flow.store.createLaunch(parent, { launchId: `claude:${f.sessionId}:${f.agentId}`,
      child: { persona: 'scout', agentName: 'scout' }, multiUse: true });
    const creator = worker(t, { ...f, phase: 'drain' });
    const boundary = await creator.first;
    assert.equal(boundary.barrier, 'drain');
    assert.equal(flow.store.getPublication(boundary.run.runId).unresolved, false);
    creator.child.kill('SIGKILL');
    assert.deepEqual(await creator.exit, { code: null, signal: 'SIGKILL' });
    const recovered = await worker(t, { ...f, recover: true }).done();
    assert.equal(recovered.child.runId, boundary.run.runId);
    assert.equal(recovered.child.rootSpanId, boundary.run.rootSpanId);
    assert.equal(recovered.child.persona, 'scout');
    assert.equal(recovered.child.agentName, 'scout');
    assert.equal(recovered.child.ticketId, 'TEST-17');
    assert.equal(recovered.child.parentSpanId, parent.rootSpanId);
    assert.ok(outbox(f).every(record => record.traceId === parent.traceId && record.sessionId === parent.sessionId));
  });

  test('ownerless incomplete legacy publication fails closed even when a native session is selected', async t => {
    const f = fixture(t), store = new ContextStore({ stateDir: f.stateDir });
    const run = store.createRun({ cwd: f.cwd, harness: 'claude', nativeSessionId: f.nativeSessionId, reuseSession: true });
    const flow = createFlow({ harness: 'claude', stateDir: f.stateDir, cwd: f.cwd, env: {}, flushOutbox: delivery });
    assert.equal(flow.session(f.nativeSessionId).runId, run.runId);
    assert.equal(flow.resolve(run), null);
    for (const hook_event_name of ['SubagentStart', 'PostModelSwitch', 'SubagentStop', 'SubagentStop']) {
      await handleClaudeHook({ cwd: f.cwd, session_id: f.sessionId, agent_id: f.agentId,
        hook_event_name, to_model: 'synthetic-model' }, { flow, env: {} });
    }
    assert.equal(flow.resolve(store.getRun(run.runId)), null, 'metadata/cache updates cannot repair unknown ownership by guessing');
    assert.equal(outbox(f).length, 0);
  });
}
