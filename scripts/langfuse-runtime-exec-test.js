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

test('bounded native grammar rejects overrides, aliases, clusters and ambiguous forms before any flow or spawn', async t => {
  const f = fixture(t);
  const canary = 'PRIVATE_OPTION_VALUE --token=CANARY';
  const common = ['--cwd', '-C', '--session-id', '--session', '--session-dir', '--continue', '-c', '--resume', '-r', '--fork', '--no-session', '--settings', '--setting-sources', '--plugin-dir', '--disable-hooks', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode', '--api-key',
    '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--permission-prompt-tool', '--permission-prompts', '--add-dir', '--mcp-config', '--strict-mcp-config', '--plugin-url'];
  const specific = {
    pi: ['-e', '--extension', '-ne', '--no-extensions', '--brain-tracing', '--export', '--approve', '-a', '--no-approve', '-na', '--skill', '--prompt-template', '--theme', '--use-theme'],
    claude: ['--fork-session', '--no-session-persistence', '--bare', '--remote', '--teleport', '--from-pr', '--resume-session-at', '--worktree', '-w', '--tmux', '--agent-id', '--agent', '--agents', '--safe-mode', '--restricted', '--bg', '--background', '--cloud', '--environment', '--remote-control', '--desktop', '--chrome', '--ide']
  };
  const ambiguous = ['-pc', '-pr', '-pw', '-pcrw', '-pv', '-nprompt', '-n=prompt', '-cOTHER', '-rOTHER', '-wOTHER', '-eother.js', '-p=prompt', '-unknown', '--unknown', '--allowedT=Read', '--print=true'];
  const snapshot = fs.readFileSync(path.join(f.env.BRAIN_TRACE_STATE_DIR, 'context-v1.json'), 'utf8');
  const entries = fs.readdirSync(f.env.BRAIN_TRACE_STATE_DIR).sort();
  let spawned = 0, touchedFlow = 0;
  const options = { cwd: f.cwd, env: f.env, spawn: () => { spawned++; throw new Error('must not spawn'); },
    flow: new Proxy({}, { get() { touchedFlow++; throw new Error('must not touch flow'); } }) };
  for (const harness of ['pi', 'claude']) {
    for (const flag of [...common, ...specific[harness], ...ambiguous]) {
      for (const args of [[flag, canary], [`${flag}=${canary}`], ['--model', 'safe/model', flag, canary], ['safe prompt', flag, canary]]) {
        await assert.rejects(exec(argsFor(f, harness, ...args).slice(1), options), error => {
          assert.match(error.message, /override|unsupported/i);
          assert.ok(!error.message.includes(canary));
          return true;
        }, `${harness}: ${flag}`);
      }
    }
    // Even a real router invocation emits no native output or sensitive value.
    const result = f.run(argsFor(f, harness, '--allowedTools', canary));
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Brain tracing operation unavailable or invalid; no context was guessed.\n');
  }
  assert.equal(spawned, 0); assert.equal(touchedFlow, 0);
  assert.equal(fs.readFileSync(path.join(f.env.BRAIN_TRACE_STATE_DIR, 'context-v1.json'), 'utf8'), snapshot);
  assert.deepEqual(fs.readdirSync(f.env.BRAIN_TRACE_STATE_DIR).sort(), entries);
  for (const name of ['.claude', '.pi', '.agent-brain']) assert.equal(fs.existsSync(path.join(f.target, name)), false);
});

test('native option arity and harness-specific forms preserve values without scanning prompt text', () => {
  const prefix = harness => ['--actor', 'a'.repeat(43), '--harness', harness, '--'];
  const accepted = {
    pi: [
      ['--provider', 'synthetic', '--model', 'synthetic/model', '--models', 'a,b', '--thinking', 'low', '--mode', 'json', '--tui-mode', 'regular'],
      ['--no-tools', '-nt', '--no-builtin-tools', '-nbt', '--no-mcp', '--no-skills', '-ns', '--no-prompt-templates', '-np', '--no-context-files', '-nc', '--no-themes', '--offline', '--verbose'],
      ['--tools', 'read,brain_context', '-t', 'read', '--exclude-tools', 'bash', '-xt', 'write', '--name', 'auth', '-n', 'plugin'],
      ['-p', '---literal -pc --allowedTools', '--append-system-prompt', 'c r w e', '--system-prompt', '--session-id'],
      ['--print', 'safe prompt', '--help', '-h', '--version', '-v']
    ],
    claude: [
      ['--model=synthetic/model', '--fallback-model', 'synthetic/fallback', '--effort=low', '--max-turns', '4', '--max-budget-usd=0.10', '--name', 'auth', '-n', 'plugin'],
      ['--print', '-p', '--verbose', '--output-format=stream-json', '--input-format', 'text', '--include-partial-messages', '--include-hook-events', '--replay-user-messages', '--forward-subagent-text', '--disable-slash-commands'],
      ['--json-schema', '{"properties":{"-pc":{"const":"--allowedTools"}}}', '--system-prompt=--resume', '--append-system-prompt', '-pc -pr -pw', '--help', '-h', '--version', '-v'],
      ['--tools', 'Bash,Read', '--output-format', 'json', 'safe prompt'],
      ['--tools=Read', 'safe prompt'], ['--tools', '', '--', 'literal prompt']
    ]
  };
  for (const harness of ['pi', 'claude']) {
    for (const args of accepted[harness]) assert.deepEqual(parse([...prefix(harness), ...args]).args, args);
    for (const value of ['--session-id', '--allowedTools', '-pc', '-pr', '-pw', '--', '', 'auth']) {
      const args = ['--system-prompt', value, 'a prompt mentioning --resume and -pc'];
      assert.deepEqual(parse([...prefix(harness), ...args]).args, args);
    }
    for (const args of [['--model'], ['-n'], ['--system-prompt'], ['--tools']]) assert.throws(() => parse([...prefix(harness), ...args]), /value required/);
    // Required-value -- is not a boundary. The following override stays live.
    assert.throws(() => parse([...prefix(harness), '--system-prompt', '--', '--allowedTools', 'Read']), /override/);
    const literal = ['--', '-pc', '-pr', '-pw', '--allowedTools=Read', '--mcp-config', '--session-id', 'auth', '', 'PRIVATE literal prompt'];
    assert.deepEqual(parse([...prefix(harness), ...literal]).args, literal);
    for (const bad of [null, 1, 'bad\0value']) assert.throws(() => parse([...prefix(harness), '--', bad]), /Invalid native argument/);
  }
  for (const args of [['--model=synthetic'], ['--mode', '--resume'], ['--tui-mode', '--resume'], ['--mode', '--'], ['--tui-mode', 'unknown']]) assert.throws(() => parse([...prefix('pi'), ...args]), /override|Unsupported/);
  for (const args of [['--tools', 'Read', 'Bash'], ['--tools', 'Read', 'would-be prompt']]) assert.throws(() => parse([...prefix('claude'), ...args]), /Ambiguous native tool/);
});

test('administrative first bare words after known options cannot escape the session grammar', async () => {
  let spawned = false;
  for (const harness of ['pi', 'claude']) {
    for (const command of ['auth', 'mcp', 'install', 'remove', 'uninstall', 'update', 'config', 'list', 'plugin', 'plugins', 'doctor', 'setup-token', 'help', 'agents', 'attach', 'auto-mode', 'gateway', 'import', 'logs', 'purge', 'respawn', 'rm', 'stop', 'kill', 'ultrareview', 'upgrade']) {
      const prefix = ['--actor', 'a'.repeat(43), '--harness', harness, '--'];
      for (const options of [[], ['--model', 'auth'], ['--name', 'mcp', '--verbose'], ['-p']]) {
        await assert.rejects(exec([...prefix, ...options, command, 'PRIVATE_COMMAND_VALUE'], { spawn: () => { spawned = true; } }), /session invocation/);
      }
      assert.deepEqual(parse([...prefix, '--name', command, '--', command]).args, ['--name', command, '--', command]);
      assert.deepEqual(parse([...prefix, 'a literal prompt mentioning mcp and --allowedTools', command]).args, ['a literal prompt mentioning mcp and --allowedTools', command]);
    }
  }
  assert.equal(spawned, false);
});

test('safe native probe arguments and flag-looking literal prompts reach the synthetic child byte-for-byte', t => {
  const f = fixture(t);
  const cases = {
    pi: ['--no-context-files', '--no-skills', '--no-prompt-templates', '--tools', 'read,brain_context', '--model', 'synthetic/model', '--thinking', 'low', '--mode', 'json', '-p'],
    claude: ['--print', '--model', 'synthetic/model', '--effort', 'low', '--max-turns', '4', '--tools', 'Bash,Read', '--output-format', 'stream-json', '--verbose']
  };
  for (const harness of ['pi', 'claude']) {
    const args = [...cases[harness], '--system-prompt', '--allowedTools', '--', '-pc', '-pr', '-pw', '--session-id', '--allowed-tools=Read', 'mcp', ''];
    const result = f.run(argsFor(f, harness, ...args), { input: 'preserved stdin\n' });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.args.slice(harness === 'pi' ? 5 : 4), args);
    assert.equal(output.input, 'preserved stdin\n'); assert.equal(result.stderr, 'native-stderr\n');
    if (harness === 'claude') {
      const settings = JSON.parse(output.args[3]);
      assert.deepEqual(Object.keys(settings).sort(), ['enabledPlugins', 'hooks']);
      assert.ok(!JSON.stringify(settings).includes('permission'));
    }
  }
  for (const name of ['.claude', '.pi', '.agent-brain']) assert.equal(fs.existsSync(path.join(f.target, name)), false);
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
