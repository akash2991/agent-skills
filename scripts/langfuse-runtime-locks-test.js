'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const modulePath = path.resolve(__dirname, '../runtime/langfuse/locks.cjs');
const { claimLock } = require(modulePath);
const kinds = ['queue', 'flush', 'context'];
const start = pid => execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
  encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' }
}).trim();
const hash = value => createHash('sha256').update(value).digest('hex');
const token = i => i.toString(16).padStart(32, '0');
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-lock-test-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function directory(dir, kind) {
  const target = path.join(dir, `${kind}-claims`);
  fs.mkdirSync(target, { mode: 0o700, recursive: true });
  return target;
}
function fixture(dir, kind, { pid = process.pid, birth = start(pid), id = token(1), temporary = false, legacy = false, text } = {}) {
  const name = temporary ? legacy ? `.${id}.tmp` : `.${pid}-${hash(birth)}-${id}.tmp` : `${pid}-${id}.json`;
  const file = path.join(directory(dir, kind), name);
  fs.writeFileSync(file, text ?? JSON.stringify({ pid, token: id, start: birth, choosing: true, ticket: 0 }), { mode: 0o600 });
  return file;
}
// Test-only dependency injection: production exports no hooks or weaker modes.
function injected({ filesystem = {}, lookup = execFileSync } = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), {
    module, process, Buffer,
    require: name => name === 'node:fs' ? { ...fs, ...filesystem }
      : name === 'node:child_process' ? { execFileSync: lookup } : require(name)
  }, { filename: modulePath });
  return module.exports.claimLock;
}
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', "process.kill(process.pid,'SIGKILL')"]);
  assert.equal(child.signal, 'SIGKILL');
  return child.pid;
}
function managedChild(t, program) {
  const child = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  child.diagnostics = () => stderr;
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return child;
}
async function finish(child) {
  const exited = once(child, 'exit');
  child.send('release');
  assert.deepEqual(await exited, [0, null], child.diagnostics());
}
async function check(child) {
  const message = once(child, 'message');
  child.send('check');
  return (await message)[0].blocked;
}

for (const kind of kinds) {
  test(`${kind}: own birth lookup failure is bounded, publishes nothing, and later recovers`, t => {
    const dir = sandbox(t);
    let failure = 'throw', writes = 0;
    const lock = injected({
      lookup: (...args) => {
        if (failure === 'throw') throw new Error('injected ps failure');
        if (failure === 'empty') return ' \n';
        if (failure === 'unsupported') return 'unsupported process identity';
        return execFileSync(...args);
      },
      filesystem: { openSync: (...args) => {
        if (args[1] & fs.constants.O_CREAT) writes++;
        return fs.openSync(...args);
      } }
    });
    for (failure of ['throw', 'empty', 'unsupported']) {
      const before = Date.now();
      assert.throws(() => lock(dir, kind, { deadlineAt: before + 1000 }), /Process birth identity unavailable/);
      assert.ok(Date.now() - before < 1000);
      assert.equal(writes, 0);
      assert.deepEqual(fs.readdirSync(dir), []);
    }
    failure = null;
    const acquired = lock(dir, kind);
    assert.equal(acquired.blocked(), false);
    const files = fs.readdirSync(directory(dir, kind));
    assert.equal(files.length, 1);
    assert.equal(typeof JSON.parse(fs.readFileSync(path.join(directory(dir, kind), files[0]), 'utf8')).start, 'string');
    acquired.release();
    assert.deepEqual(fs.readdirSync(directory(dir, kind)), []);
    assert.throws(() => lock(dir, kind, { deadlineAt: Date.now() - 1 }), /budget/);
    assert.deepEqual(fs.readdirSync(directory(dir, kind)), []);
  });

  test(`${kind}: live, mismatched and legacy null identities have conservative dispositions`, t => {
    const dir = sandbox(t), first = claimLock(dir, kind), second = claimLock(dir, kind);
    assert.equal(first.blocked(), false);
    assert.equal(second.blocked(), true);
    first.release();
    assert.equal(second.blocked(), false);
    second.release();
    // A planted mismatch, NOT a forced real OS PID reuse experiment.
    fixture(dir, kind, { birth: 'different process birth time' });
    const recovered = claimLock(dir, kind);
    assert.equal(recovered.blocked(), false);
    recovered.release();
    assert.deepEqual(fs.readdirSync(directory(dir, kind)), []);
    fixture(dir, kind, { birth: 'different process birth time', temporary: true, text: '' });
    const recoveredTemp = claimLock(dir, kind);
    assert.equal(recoveredTemp.blocked(), false);
    recoveredTemp.release();
    assert.deepEqual(fs.readdirSync(directory(dir, kind)), []);

    const legacy = fixture(dir, kind, { birth: null });
    fs.utimesSync(legacy, 1, 1);
    let lookups = 0;
    const conservative = injected({ lookup: (...args) => { lookups++; return execFileSync(...args); } });
    const blocked = conservative(dir, kind);
    assert.equal(blocked.blocked(), true);
    assert.equal(lookups, 1, 'null-birth live peer is unprovable, not a mismatch');
    blocked.release();
    assert.equal(fs.existsSync(legacy), true);
    const legacyTemp = fixture(dir, kind, { birth: null, temporary: true, legacy: true });
    fs.utimesSync(legacyTemp, 1, 1);
    const preservingTemp = claimLock(dir, kind);
    assert.equal(preservingTemp.blocked(), true);
    preservingTemp.release();
    assert.equal(fs.existsSync(legacyTemp), true);
    fs.unlinkSync(legacyTemp);
    fs.unlinkSync(legacy); // Offline fixture disposal, not runtime age-based stealing.
    fixture(dir, kind, { pid: deadPid(), birth: null });
    const dead = claimLock(dir, kind);
    assert.equal(dead.blocked(), false);
    dead.release();
    assert.deepEqual(fs.readdirSync(directory(dir, kind)), []);
  });

  test(`${kind}: failed peer identity lookup preserves a live owner`, t => {
    const dir = sandbox(t), peer = fixture(dir, kind);
    let lookups = 0;
    const lock = injected({ lookup: (...args) => {
      if (++lookups > 1) throw new Error('injected peer lookup failure');
      return execFileSync(...args);
    } })(dir, kind);
    assert.equal(lock.blocked(), true);
    assert.equal(fs.existsSync(peer), true);
    lock.release();
    assert.deepEqual(fs.readdirSync(directory(dir, kind)), [path.basename(peer)]);
  });

  for (const legacy of [false, true]) {
    test(`${kind}: 256 abandoned ${legacy ? 'legacy' : 'identity-named, including empty/partial'} temporaries are collected`, t => {
      const dir = sandbox(t), pid = deadPid();
      for (let i = 1; i <= 256; i++) fixture(dir, kind, {
        pid, birth: legacy ? null : 'dead publisher birth', id: token(i), temporary: true, legacy,
        ...(!legacy && i % 3 ? { text: i % 3 === 1 ? '' : '{' } : {})
      });
      assert.equal(fs.readdirSync(directory(dir, kind)).length, 256);
      for (let i = 0; i < 4; i++) {
        const lock = claimLock(dir, kind);
        assert.equal(lock.blocked(), false);
        assert.equal(fs.readdirSync(directory(dir, kind)).length, 1);
        lock.release();
        assert.deepEqual(fs.readdirSync(directory(dir, kind)), []);
      }
    });
  }

  test(`${kind}: live temporary capacity stays bounded and legacy ambiguous partials fail closed`, t => {
    const dir = sandbox(t), birth = start(process.pid);
    for (let i = 1; i <= 256; i++) fixture(dir, kind, { birth, id: token(i), temporary: true, text: '' });
    for (let i = 0; i < 3; i++) {
      assert.throws(() => claimLock(dir, kind), /capacity exceeded/);
      assert.equal(fs.readdirSync(directory(dir, kind)).length, 256, 'failed entrants leave no new files');
    }
    for (const file of fs.readdirSync(directory(dir, kind))) fs.unlinkSync(path.join(directory(dir, kind), file));
    const ambiguous = fixture(dir, kind, { temporary: true, legacy: true, text: '{' });
    fs.utimesSync(ambiguous, 1, 1);
    assert.throws(() => claimLock(dir, kind));
    assert.deepEqual(fs.readdirSync(directory(dir, kind)), [path.basename(ambiguous)]);
  });

  test(`${kind}: claim plus temporary counts once per publisher, not as raw directory capacity`, t => {
    const dir = sandbox(t), birth = start(process.pid);
    for (let i = 1; i <= 128; i++) {
      fixture(dir, kind, { birth, id: token(i) });
      fixture(dir, kind, { birth, id: token(i), temporary: true, text: '' });
    }
    const lock = claimLock(dir, kind);
    assert.equal(lock.blocked(), true);
    assert.equal(fs.readdirSync(directory(dir, kind)).length, 257);
    lock.release();
    assert.equal(fs.readdirSync(directory(dir, kind)).length, 256);
  });

  test(`${kind}: SIGKILL at each publication boundary leaves recoverable bounded state`, t => {
    const dir = sandbox(t);
    for (const stage of ['empty-1', 'partial-1', 'written-1', 'choosing', 'empty-2', 'partial-2', 'written-2', 'ready']) {
      const program = `const fs=require('node:fs');
        const open=fs.openSync,write=fs.writeFileSync,rename=fs.renameSync;let renames=0,publications=0;
        const die=()=>process.kill(process.pid,'SIGKILL');
        fs.openSync=function(...args){const fd=open(...args);if(typeof args[0]==='string'&&args[0].endsWith('.tmp')){publications++;if(${JSON.stringify(stage)}==='empty-'+publications)die();}return fd;};
        fs.writeFileSync=function(...args){if(typeof args[0]==='number'&&${JSON.stringify(stage)}==='partial-'+publications){fs.writeSync(args[0],'{');die();}return write(...args);};
        fs.renameSync=function(...args){renames++;if(${JSON.stringify(stage)}==='written-'+publications)die();const result=rename(...args);if(renames===1&&${JSON.stringify(stage)}==='choosing'||renames===2&&${JSON.stringify(stage)}==='ready')die();return result;};
        require(${JSON.stringify(modulePath)}).claimLock(${JSON.stringify(dir)},${JSON.stringify(kind)});process.exit(3);`;
      const child = spawnSync(process.execPath, ['-e', program]);
      assert.equal(child.signal, 'SIGKILL', `${stage}: ${child.stderr}`);
      assert.equal(fs.readdirSync(directory(dir, kind)).length, stage.endsWith('-2') ? 2 : 1, stage);
      const lock = claimLock(dir, kind);
      assert.equal(lock.blocked(), false, stage);
      assert.equal(fs.readdirSync(directory(dir, kind)).length, 1, stage);
      lock.release();
      assert.deepEqual(fs.readdirSync(directory(dir, kind)), []);
    }
  });

  for (const stage of ['before-1', 'after-1', 'before-2', 'after-2']) {
    test(`${kind}: SIGSTOP ${stage} rename preserves publisher state and resumed exclusion`, { timeout: 15000 }, async t => {
      const dir = sandbox(t);
      const program = `const fs=require('node:fs'),rename=fs.renameSync;let renames=0;
        const pause=stage=>{if(stage===${JSON.stringify(stage)}){process.send({stage});process.kill(process.pid,'SIGSTOP');}};
        fs.renameSync=function(...args){renames++;pause('before-'+renames);const result=rename(...args);pause('after-'+renames);return result;};
        const lock=require(${JSON.stringify(modulePath)}).claimLock(${JSON.stringify(dir)},${JSON.stringify(kind)},{deadlineAt:Date.now()+12000});
        process.send({stage:'acquired',blocked:lock.blocked()});
        process.on('message',message=>{if(message==='check')process.send({blocked:lock.blocked()});if(message==='release'){lock.release();process.exit(0);}});`;
      const child = managedChild(t, program);
      assert.equal((await once(child, 'message'))[0].stage, stage);
      const pausedFiles = fs.readdirSync(directory(dir, kind));
      for (const file of pausedFiles) fs.utimesSync(path.join(directory(dir, kind), file), 1, 1);
      const peer = claimLock(dir, kind);
      for (const file of pausedFiles) assert.ok(fs.existsSync(path.join(directory(dir, kind), file)), 'no paused file stolen by age');
      const initialBlocked = peer.blocked();
      assert.equal(initialBlocked, stage !== 'before-1');
      assert.ok(fs.readdirSync(directory(dir, kind)).length <= 4, 'at most a claim and temporary per live publisher');
      const resumed = once(child, 'message');
      child.kill('SIGCONT');
      const resumedMessage = (await resumed)[0];
      assert.equal(resumedMessage.stage, 'acquired', child.diagnostics());
      const parentBlocked = peer.blocked();
      assert.notEqual(parentBlocked, resumedMessage.blocked, 'exactly one ready owner is eligible');
      if (!parentBlocked) {
        peer.release();
        assert.equal(await check(child), false);
        await finish(child);
      } else {
        await finish(child);
        assert.equal(peer.blocked(), false);
        peer.release();
      }
      assert.deepEqual(fs.readdirSync(directory(dir, kind)), []);
    });
  }

  test(`${kind}: simultaneous admission accounts for paused temporaries and drains a rejected entrant`, { timeout: 15000 }, async t => {
    const dir = sandbox(t);
    for (let i = 1; i <= 255; i++) fixture(dir, kind, { birth: null, id: token(i) });
    const program = `const fs=require('node:fs'),rename=fs.renameSync,open=fs.openSync;let calls=0,opens=0;
      fs.openSync=function(...args){if(typeof args[0]==='string'&&args[0].endsWith('.tmp')&&++opens===1){process.send('admitted');process.kill(process.pid,'SIGSTOP');}return open(...args);};
      fs.renameSync=function(...args){if(++calls===1){process.send('paused');process.kill(process.pid,'SIGSTOP');}return rename(...args);};
      try{const lock=require(${JSON.stringify(modulePath)}).claimLock(${JSON.stringify(dir)},${JSON.stringify(kind)},{deadlineAt:Date.now()+12000});
        process.send({acquired:true,blocked:lock.blocked()});process.on('message',()=>{lock.release();process.exit(0);});
      }catch(error){if(!/capacity exceeded/.test(error.message)){console.error(error);process.exit(2);}process.exit(0);}`;
    const first = managedChild(t, program);
    assert.equal((await once(first, 'message'))[0], 'admitted');
    const second = managedChild(t, program);
    assert.equal((await once(second, 'message'))[0], 'admitted');
    const paused = [once(first, 'message'), once(second, 'message')];
    first.kill('SIGCONT');
    second.kill('SIGCONT');
    assert.deepEqual((await Promise.all(paused)).map(message => message[0]), ['paused', 'paused']);
    assert.equal(fs.readdirSync(directory(dir, kind)).length, 257, '255 admitted peers plus two in-flight publications');
    assert.throws(() => claimLock(dir, kind), /capacity exceeded/);
    assert.equal(fs.readdirSync(directory(dir, kind)).length, 257, 'paused publishers are not stolen to meet capacity');
    const rejected = once(first, 'exit');
    first.kill('SIGCONT');
    assert.deepEqual(await rejected, [0, null], first.diagnostics());
    assert.equal(fs.readdirSync(directory(dir, kind)).length, 256);
    const resumed = once(second, 'message');
    second.kill('SIGCONT');
    assert.deepEqual((await resumed)[0], { acquired: true, blocked: true });
    await finish(second);
    assert.equal(fs.readdirSync(directory(dir, kind)).length, 255);
  });

  test(`${kind}: concurrent processes never enter the same critical section together`, { timeout: 30000 }, async t => {
    const dir = sandbox(t), guard = path.join(dir, 'critical');
    const program = `const fs=require('node:fs'),{claimLock}=require(${JSON.stringify(modulePath)});
      process.send('ready');process.once('message',()=>{(async()=>{for(let i=0;i<8;i++){
        const lock=claimLock(${JSON.stringify(dir)},${JSON.stringify(kind)});
        while(lock.blocked())await new Promise(r=>setTimeout(r,2));
        try{const fd=fs.openSync(${JSON.stringify(guard)},'wx',0o600);fs.closeSync(fd);
          await new Promise(r=>setTimeout(r,3));fs.unlinkSync(${JSON.stringify(guard)});
        }finally{lock.release();}
      }})().then(()=>process.exit(0),error=>{console.error(error);process.exit(2);});});`;
    const children = Array.from({ length: 5 }, () => managedChild(t, program));
    await Promise.all(children.map(child => once(child, 'message')));
    const outcomes = children.map(child => once(child, 'exit'));
    for (const child of children) child.send('start');
    assert.deepEqual(await Promise.all(outcomes), children.map(() => [0, null]), children.map(child => child.diagnostics()).join('\n'));
    assert.equal(fs.existsSync(guard), false);
    assert.deepEqual(fs.readdirSync(directory(dir, kind)), []);
  });

  test(`${kind}: failed writes/renames leave no claim or temporary at either publication`, t => {
    const dir = sandbox(t);
    for (const operation of ['writeFileSync', 'renameSync']) for (const boundary of [1, 2]) {
      let calls = 0;
      const lock = injected({ filesystem: { [operation]: (...args) => {
        if (++calls === boundary) throw new Error('injected publication failure');
        return fs[operation](...args);
      } } });
      assert.throws(() => lock(dir, kind), /injected publication failure/);
      assert.deepEqual(fs.readdirSync(directory(dir, kind)), []);
    }
  });

  test(`${kind}: replaced claim inodes are not removed or treated as owned`, t => {
    const dir = sandbox(t), lock = claimLock(dir, kind), target = directory(dir, kind);
    const file = path.join(target, fs.readdirSync(target)[0]);
    const replacement = path.join(dir, 'replacement');
    fs.writeFileSync(replacement, fs.readFileSync(file), { mode: 0o600 });
    fs.renameSync(replacement, file);
    assert.throws(() => lock.blocked(), /ownership changed/);
    lock.release();
    lock.release();
    assert.equal(fs.existsSync(file), true);
    fs.unlinkSync(file);

    const dead = fixture(dir, kind, { birth: 'dead birth fixture' });
    const substitute = path.join(dir, 'substitute');
    fs.writeFileSync(substitute, fs.readFileSync(dead), { mode: 0o600 });
    let replaced = false;
    const raced = injected({ filesystem: { lstatSync: (...args) => {
      if (!replaced && args[0] === dead) { replaced = true; fs.renameSync(substitute, dead); }
      return fs.lstatSync(...args);
    } } });
    assert.throws(() => raced(dir, kind), /ownership changed during recovery/);
    assert.equal(fs.existsSync(dead), true);
    assert.equal(fs.readdirSync(target).length, 1);
  });

  test(`${kind}: unsafe directories, claims and temporary links fail closed`, t => {
    for (const mode of ['directory-link', 'directory-public', 'malformed', 'symlink', 'hardlink', 'public', 'oversize', 'temp-symlink', 'temp-hardlink', 'temp-public', 'temp-oversize', 'legacy-symlink', 'legacy-hardlink']) {
      const dir = sandbox(t), other = sandbox(t), outside = path.join(other, 'untouched');
      fs.writeFileSync(outside, 'private sentinel', { mode: 0o600 });
      const target = path.join(dir, `${kind}-claims`);
      if (mode === 'directory-link') fs.symlinkSync(other, target);
      else {
        directory(dir, kind);
        if (mode === 'directory-public') fs.chmodSync(target, 0o755);
        else {
          const temporary = mode.startsWith('temp-') || mode.startsWith('legacy-');
          const file = fixture(dir, kind, { temporary, legacy: mode.startsWith('legacy-'), ...(mode === 'malformed' ? { text: '{}' } : {}) });
          if (mode.endsWith('symlink')) { fs.unlinkSync(file); fs.symlinkSync(outside, file); }
          if (mode.endsWith('hardlink')) { fs.unlinkSync(file); fs.linkSync(outside, file); }
          if (mode.endsWith('public')) fs.chmodSync(file, 0o644);
          if (mode.endsWith('oversize')) fs.writeFileSync(file, 'x'.repeat(1025));
        }
      }
      const before = fs.readdirSync(target).sort();
      assert.throws(() => claimLock(dir, kind), undefined, mode);
      assert.deepEqual(fs.readdirSync(target).sort(), before, mode);
      assert.equal(fs.readFileSync(outside, 'utf8'), 'private sentinel', mode);
    }
    const dir = sandbox(t), peer = fixture(dir, kind);
    const foreign = injected({ filesystem: { fstatSync: fd => Object.assign(Object.create(fs.fstatSync(fd)), { uid: process.getuid() + 1 }) } });
    assert.throws(() => foreign(dir, kind), /Unsafe lock claim/);
    assert.equal(fs.existsSync(peer), true);
  });
}

test('invalid kinds cannot create state directories', t => {
  const dir = sandbox(t);
  assert.throws(() => claimLock(dir, 'other'), /Invalid lock kind/);
  assert.deepEqual(fs.readdirSync(dir), []);
});
