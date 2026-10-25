'use strict';

// Real helper/flow/process boundaries, with synthetic native executables only.
// No model, credential lookup, network, dependency install or global settings.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createFlow } = require('../runtime/langfuse/flow.cjs');
const { exec, parse, claudeSettings } = require('../runtime/langfuse/exec.cjs');
const { resolveActor } = require('../runtime/langfuse/context-cli.cjs');
const { launch } = require('../runtime/langfuse/launch.cjs');
const { testDependencyRoot } = require('./lib/langfuse-test-dependencies.js');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-exec-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'caller'), target = path.join(root, "target ' $ spaces");
  for (const dir of [cwd, target]) { fs.mkdirSync(dir); fs.mkdirSync(path.join(dir, '.git')); }
  const runtime = path.join(cwd, '.agent-brain/observability'); fs.mkdirSync(runtime, { recursive: true });
  for (const name of fs.readdirSync(path.join(__dirname, '../runtime/langfuse')).filter(name => /\.(?:cjs|js|json)$/.test(name))) {
    fs.copyFileSync(path.join(__dirname, '../runtime/langfuse', name), path.join(runtime, name));
  }
  fs.writeFileSync(path.join(cwd, '.agent-brain/tracing.json'), JSON.stringify({ schema: 1, enabled: true, captureMode: 'metadata-only' }));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const stateDir = path.join(root, 'state');
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: root, BRAIN_TRACE_STATE_DIR: stateDir,
    LANGFUSE_PUBLIC_KEY: '', TEST_RUNTIME: runtime };
  const flow = createFlow({ cwd, stateDir, env, flushOutbox: async () => ({ accepted: 0, verified: false }) });
  const parent = flow.begin({ cwd, nativeSessionId: crypto.randomUUID(), ticketId: 'TEST-17' });
  const actor = flow.createToolLaunch(parent).nonce;
  const cli = path.join(runtime, 'brain-trace.cjs');
  const run = (args, extra = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: 15000, ...extra });
  const native = `#!${process.execPath}
    const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
    const args=process.argv.slice(2), runtime=process.env.TEST_RUNTIME;
    const harness=path.basename(process.argv[1]), id=args[args.indexOf('--session-id')+1];
    if(process.env.TEST_MODE==='wait'){console.log('READY');setInterval(()=>{},1000);return;}
    if(process.env.TEST_MODE==='signal'){process.kill(process.pid,'SIGTERM');return;}
    if(process.env.TEST_MODE==='exit'){process.exit(23);}
    if(process.env.TEST_MODE==='flow'){
      const {createFlow}=require(path.join(runtime,'flow.cjs'));
      let context;
      if(harness==='claude'){
        const settings=JSON.parse(args[args.indexOf('--settings')+1]);
        const hook=(event,extra={})=>cp.spawnSync(settings.hooks[event][0].hooks[0].command,{
          shell:true,env:process.env,input:JSON.stringify({hook_event_name:event,session_id:id,cwd:process.cwd(),...extra}),encoding:'utf8'});
        const start=hook('SessionStart');if(start.status!==0)throw new Error('hook failed');
        const actor=JSON.parse(start.stdout).hookSpecificOutput.additionalContext.match(/--actor ([A-Za-z0-9_-]+)/)[1];
        const set=cp.spawnSync(process.execPath,[path.join(runtime,'brain-trace.cjs'),'context','--actor',actor,'set','--ticket','TEST-18'],{env:process.env,encoding:'utf8'});
        if(set.status!==0)throw new Error('context failed');context=JSON.parse(set.stdout);
        const bash=hook('PreToolUse',{tool_name:'Bash',tool_use_id:'ordinary',tool_input:{command:'PRIVATE_BODY; $(never-run)'}});
        if(bash.stdout!=='')throw new Error('Bash rewrite');hook('Stop');
      }else{
        const flow=createFlow({harness,cwd:process.cwd(),env:process.env});
        flow.acknowledgeSession(id);const run=flow.begin({nativeSessionId:id,cwd:process.cwd()});
        const resolved=flow.resolve(run);context=resolved?{traceId:resolved.traceId,parentSpanId:resolved.parentSpanId}:{ancestryPending:true};
      }
      console.log(JSON.stringify({id,context}));return;
    }
    let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
      console.error('native-stderr');console.log(JSON.stringify({args,cwd:process.cwd(),input,
        ambient:process.env.BRAIN_TRACE_LAUNCH_ID,stock:process.env.PI_SUBAGENT_ID}));
    });
  `;
  for (const name of ['pi', 'claude']) fs.writeFileSync(path.join(bin, name), native, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}
    const cp=require('node:child_process'),args=process.argv.slice(2),cwd=process.env.TEST_TARGET;
    if(args[0]==='pane')console.log(JSON.stringify({result:{process_info:{pane_id:'w1:p7',shell_pid:42,foreground_processes:[{pid:42,cwd}]}}}));
    else {
      const native=cp.spawnSync(args[args.indexOf('--kind')+1],args.slice(args.indexOf('--')+1),{
        cwd,env:{...process.env,HERDR_PANE_ID:'w1:p7'},input:'',encoding:'utf8'});
      if(native.status!==0){process.stderr.write(native.stderr);process.exit(native.status||1);}
      console.log('{}');
    }
  `, { mode: 0o700 });
  return { root, cwd, target, runtime, env, flow, parent, actor, cli, run };
}
const argsFor = (f, harness, ...args) => ['exec', '--actor', f.actor, '--harness', harness, '--cwd', f.target, '--', ...args];

test('actual router/native exec preserves argv, stdin/stdout/stderr, cwd and exact single-use launch for both harnesses', t => {
  const f = fixture(t);
  const canary = 'PRIVATE_ARG; $(touch MUST_NOT_EXIST)\nsecond line';
  for (const harness of ['pi', 'claude']) {
    const result = f.run(argsFor(f, harness, '--model', 'synthetic/model', '--', canary, '', '--session-id', '--help'), {
      input: 'stdin bytes\n', env: { ...f.env, BRAIN_TRACE_LAUNCH_ID: 'x'.repeat(43), PI_SUBAGENT_ID: 'foreign' }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, 'native-stderr\n');
    const output = JSON.parse(result.stdout), args = output.args;
    assert.deepEqual(args.slice(args.indexOf('--model')), ['--model', 'synthetic/model', '--', canary, '', '--session-id', '--help']);
    assert.equal(output.input, 'stdin bytes\n'); assert.equal(output.cwd, f.target);
    assert.equal(output.ambient, undefined); assert.equal(output.stock, undefined);
    const id = args[1]; assert.match(id, /^[a-f0-9-]{36}$/);
    const launch = f.flow.readState(`native-launch:${harness}:${id}`);
    const binding = f.flow.store.resolveLaunch({ nonce: launch.nonce });
    assert.equal(binding.parent.rootSpanId, f.parent.rootSpanId); assert.equal(binding.multiUse, false);
    assert.ok(f.flow.store.claimLaunch({ nonce: launch.nonce }, { claimId: `${harness}:${id}` }));
    assert.equal(f.flow.store.claimLaunch({ nonce: launch.nonce }, { claimId: `${harness}:${crypto.randomUUID()}` }), null);
    if (harness === 'pi') {
      assert.deepEqual(args.slice(2, 5), ['-e', path.join(f.runtime, 'pi.js'), '--brain-tracing']);
      assert.ok(!args.includes('--approve') && !args.includes('--no-extensions'));
    } else {
      const settings = JSON.parse(args[3]);
      assert.equal(settings.enabledPlugins['langfuse-observability@langfuse-observability'], false);
      assert.deepEqual(Object.keys(settings).sort(), ['enabledPlugins', 'hooks']);
      assert.ok(!JSON.stringify(settings).includes('permission'));
    }
    const saved = fs.readdirSync(path.join(f.env.BRAIN_TRACE_STATE_DIR, 'adapters')).filter(n => n.endsWith('.json'))
      .map(n => fs.readFileSync(path.join(f.env.BRAIN_TRACE_STATE_DIR, 'adapters', n), 'utf8')).join('');
    assert.ok(!saved.includes(canary));
  }
  assert.equal(fs.existsSync(path.join(f.target, 'MUST_NOT_EXIST')), false);
  assert.equal(fs.existsSync(path.join(f.target, '.claude')), false);
  assert.equal(fs.existsSync(path.join(f.target, '.pi')), false);
});

test('actual native flow and per-run Claude hook use marker-absent target consent and actor context CLI', t => {
  const f = fixture(t);
  for (const harness of ['pi', 'claude']) {
    const result = f.run(argsFor(f, harness), { env: { ...f.env, TEST_MODE: 'flow' } });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    const flow = createFlow({ harness, cwd: f.target, stateDir: f.env.BRAIN_TRACE_STATE_DIR, env: f.env });
    const child = flow.session(output.id);
    assert.ok(child); assert.equal(flow.resolve(child).parentSpanId, f.parent.rootSpanId);
    assert.equal(flow.resolve(child).traceId, f.parent.traceId);
    if (harness === 'claude') assert.equal(output.context.ticketId, 'TEST-18');
    assert.ok(f.flow.readState(`launch-ack:${f.flow.readState(`native-launch:${harness}:${output.id}`).nonce}`));
  }
});

test('missing/invalid/expired explicit actors never fall back to ambient or current session; legacy Pi binding remains supported', t => {
  const f = fixture(t);
  const legacy = f.flow.store.createLaunch(f.parent, { multiUse: true });
  assert.equal(resolveActor(f.flow, undefined, { BRAIN_TRACE_LAUNCH_ID: legacy.nonce }).current.runId, f.parent.runId);
  assert.throws(() => resolveActor(f.flow, legacy.nonce, { BRAIN_TRACE_LAUNCH_ID: f.actor }), /unavailable/);
  for (const actor of ['', 'invalid', 'x'.repeat(43)]) {
    const result = f.run(['context', '--actor', actor, 'status'], { env: { ...f.env, BRAIN_TRACE_LAUNCH_ID: f.actor } });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    const child = f.run(['exec', '--actor', actor, '--harness', 'pi', '--'], { env: { ...f.env, BRAIN_TRACE_LAUNCH_ID: f.actor } });
    assert.equal(child.status, 1); assert.equal(child.stdout, '');
  }
  assert.equal(f.run(['context', 'status']).status, 1);
  assert.equal(f.run(['exec', '--harness', 'pi', '--']).status, 1);
  assert.equal(f.run(['context', 'status'], { env: { ...f.env, BRAIN_TRACE_LAUNCH_ID: f.actor } }).status, 0);
  const future = createFlow({ cwd: f.cwd, stateDir: f.env.BRAIN_TRACE_STATE_DIR, env: {}, clock: () => Date.now() + 8 * 24 * 3600 * 1000 });
  assert.throws(() => resolveActor(future, f.actor, { BRAIN_TRACE_LAUNCH_ID: f.actor }), /unavailable/);
});

test('exact pending actor can update itself and exec a descendant without exporting guessed ancestry', async t => {
  const f = fixture(t);
  const pending = f.flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID(), pendingIdentity: 'pending-native-child' });
  const actor = f.flow.createToolLaunch(pending).nonce;
  const set = f.run(['context', '--actor', actor, 'set', '--ticket', 'TEST-19']);
  assert.equal(set.status, 0, set.stderr); assert.equal(JSON.parse(set.stdout).ancestryPending, true);
  const result = f.run(argsFor({ ...f, actor }, 'pi'), { env: { ...f.env, TEST_MODE: 'flow' } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.context.ancestryPending, true);
  const childFlow = createFlow({ harness: 'pi', cwd: f.target, stateDir: f.env.BRAIN_TRACE_STATE_DIR, env: {} });
  const child = childFlow.session(output.id);
  assert.ok(child, 'new native descendant was durably held');
  assert.equal(childFlow.resolve(child), null);
  const now = Date.now();
  assert.equal(childFlow.submit(child, [{ id: childFlow.id(), parentId: child.rootSpanId, type: 'GENERATION', startTime: now, endTime: now, outcome: 'completed' }]).pending, 1);
  const spans = [];
  const opts = { dependencyRoot: testDependencyRoot(), exporterFactory: () => ({ export(batch, callback) { spans.push(...batch); callback({ code: 0 }); }, async shutdown() {} }) };
  await childFlow.flush(opts); assert.equal(spans.length, 0);
  f.flow.store.createLaunch(f.parent, { launchId: 'pending-native-child', multiUse: true });
  await childFlow.flush(opts);
  assert.equal(spans.length, 1); assert.equal(spans[0].spanContext().traceId, f.parent.traceId);
  assert.equal(childFlow.resolve(child).parentSpanId, pending.rootSpanId);
});

test('target disabled/invalid declarations and kill switches refuse before native spawn, even with explicit consent', async t => {
  const f = fixture(t);
  for (const env of [{ BRAIN_TRACING_ENABLED: 'false' }, { LANGFUSE_TRACING_ENABLED: '0' }]) {
    let spawned = false;
    await assert.rejects(exec(argsFor(f, 'pi').slice(1), { cwd: f.cwd, env: { ...f.env, ...env }, flow: f.flow, spawn: () => { spawned = true; } }), /disabled/);
    assert.equal(spawned, false);
  }
  const marker = path.join(f.target, '.agent-brain/tracing.json'); fs.mkdirSync(path.dirname(marker));
  for (const value of ['{', 'null', JSON.stringify({ schema: 1, enabled: false, captureMode: 'metadata-only' }), JSON.stringify({ schema: 1, enabled: true, captureMode: 'metadata-only' })]) {
    fs.writeFileSync(marker, value);
    const result = f.run(argsFor(f, 'claude')); assert.equal(result.status, 1); assert.equal(result.stdout, '');
  }
  fs.rmSync(marker); fs.symlinkSync(path.join(f.root, 'missing'), marker);
  assert.equal(f.run(argsFor(f, 'pi')).status, 1);
});

test('reserved native session/resources/permission flags are refused in split, equals and attached forms', () => {
  for (const harness of ['pi', 'claude']) {
    const prefix = ['--actor', 'a'.repeat(43), '--harness', harness, '--'];
    const flags = ['--session-id', '--session', '--resume', '-r', '-rOTHER', '--continue', '-c', '-cOTHER', '--cwd', '--settings', '--plugin-dir', '--dangerously-skip-permissions', '--permission-mode'];
    if (harness === 'pi') flags.push('-e', '-eother.js', '--extension', '--no-extensions', '--brain-tracing', '--approve');
    else flags.push('--fork-session', '--no-session-persistence', '--bare', '--from-pr', '--resume-session-at', '--worktree', '-wOTHER');
    for (const flag of flags) {
      assert.throws(() => parse([...prefix, flag, 'override']), /override/);
      assert.throws(() => parse([...prefix, `${flag}=override`]), /override/);
    }
    assert.throws(() => parse(prefix.slice(0, -1)), /boundary/);
    assert.throws(() => parse(['--harness', harness, '--']), /actor/);
    assert.throws(() => parse([...prefix, 'auth']), /invocation/);
    assert.deepEqual(parse([...prefix, '--', '--session-id', 'literal prompt']).args, ['--', '--session-id', 'literal prompt']);
  }
});

test('exec mirrors native exit, child signal and spawn failure; forwards wrapper signals without extra stdout', async t => {
  const f = fixture(t);
  assert.equal(f.run(argsFor(f, 'pi'), { env: { ...f.env, TEST_MODE: 'exit' } }).status, 23);
  const signal = f.run(argsFor(f, 'claude'), { env: { ...f.env, TEST_MODE: 'signal' } });
  assert.equal(signal.status, null); assert.equal(signal.signal, 'SIGTERM'); assert.equal(signal.stdout, '');
  const missing = f.run(argsFor(f, 'pi'), { env: { ...f.env, PATH: path.dirname(process.execPath) } });
  assert.equal(missing.status, 127); assert.equal(missing.stdout, '');
  const child = spawn(process.execPath, [f.cli, ...argsFor(f, 'pi')], { cwd: f.cwd, env: { ...f.env, TEST_MODE: 'wait' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000); t.after(() => clearTimeout(timeout));
  const [ready] = await once(child.stdout, 'data'); assert.equal(ready.toString(), 'READY\n');
  const closed = once(child, 'close'); child.kill('SIGTERM');
  assert.deepEqual(await closed, [null, 'SIGTERM']);
});

test('per-run hook command quoting survives spaces/quotes and refuses mismatched native sessions and target policy changes', t => {
  const f = fixture(t), id = crypto.randomUUID();
  const settings = claudeSettings(id, f.target);
  const command = settings.hooks.SessionStart[0].hooks[0].command;
  const hook = payload => spawnSync(command, { shell: true, env: f.env, cwd: f.target, input: JSON.stringify(payload), encoding: 'utf8', timeout: 5000 });
  const payload = { session_id: crypto.randomUUID(), cwd: f.target, hook_event_name: 'SessionStart' };
  let result = hook(payload); assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  fs.mkdirSync(path.join(f.target, '.agent-brain'));
  fs.writeFileSync(path.join(f.target, '.agent-brain/tracing.json'), '{}');
  result = hook({ ...payload, session_id: id }); assert.equal(result.status, 0); assert.equal(result.stdout, '');
});

test('actual pane helper CLI and Herdr subprocess acknowledge exact Pi/Claude native children', t => {
  const f = fixture(t);
  for (const harness of ['pi', 'claude']) {
    const result = f.run(['launch', '--actor', f.actor, '--pane', 'w1:p7', '--harness', harness, '--name', 'test', '--cwd', f.target], {
      env: { ...f.env, HERDR_ENV: '1', TEST_TARGET: f.target, TEST_MODE: 'flow' }
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'adapter-started');
    assert.equal(output.sessionId, f.parent.sessionId);
    const flow = createFlow({ harness, cwd: f.target, stateDir: f.env.BRAIN_TRACE_STATE_DIR, env: { ...f.env, HERDR_PANE_ID: 'w1:p7' } });
    assert.equal(flow.resolve(flow.session(output.nativeSessionId)).parentSpanId, f.parent.rootSpanId);
  }
});

test('pane helper accepts explicit pending actor and never consults another parent session', async t => {
  const f = fixture(t);
  const pending = f.flow.begin({ cwd: f.cwd, nativeSessionId: crypto.randomUUID(), pendingIdentity: 'pending-pane-parent' });
  const actor = f.flow.createToolLaunch(pending).nonce;
  const calls = [];
  const run = (command, args) => { calls.push([command, args]); return args.includes('process-info')
    ? { status: 0, stdout: JSON.stringify({ result: { process_info: { pane_id: 'w1:p7', shell_pid: 42, foreground_processes: [{ pid: 42, cwd: f.target }] } } }) }
    : { status: 0 }; };
  const args = ['--actor', actor, '--pane', 'w1:p7', '--harness', 'claude', '--name', 'test', '--cwd', f.target];
  const result = await launch(args, { flow: f.flow, env: { ...f.env, HERDR_ENV: '1', BRAIN_TRACE_LAUNCH_ID: f.actor }, run });
  assert.equal(result.ancestryPending, true); assert.equal(result.sessionId, 'UNKNOWN');
  const binding = f.flow.readState(`native-launch:claude:${result.nativeSessionId}`);
  assert.equal(f.flow.store.inspectLaunch({ nonce: binding.nonce }).parent.rootSpanId, pending.rootSpanId);
  assert.ok(calls[1][1].includes('--settings'));
  await assert.rejects(launch([...args, '--parent-session', f.parent.nativeSessionId], { flow: f.flow, env: { HERDR_ENV: '1' }, run }), /Invalid/);
  await assert.rejects(launch(args.map(v => v === actor ? 'x'.repeat(43) : v), { flow: f.flow, env: { ...f.env, HERDR_ENV: '1', BRAIN_TRACE_LAUNCH_ID: f.actor }, run }), /unavailable/);
  assert.equal(calls.length, 2, 'invalid actor never even inspects a pane');
});
