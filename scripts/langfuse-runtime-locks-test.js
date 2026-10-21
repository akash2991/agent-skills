'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const modulePath=path.resolve(__dirname,'../runtime/langfuse/locks.cjs');
const {claimLock}=require(modulePath);
function sandbox(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brain-lock-test-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('hard-killed queue and flush owners are recovered without deleting a replacement claim',t=>{
  const dir=sandbox(t);
  for(const kind of['queue','flush','context']){
    const child=spawnSync(process.execPath,['-e',`const l=require(${JSON.stringify(modulePath)}).claimLock(${JSON.stringify(dir)},${JSON.stringify(kind)});if(l.blocked())process.exit(2);process.kill(process.pid,'SIGKILL');`]);
    assert.equal(child.signal,'SIGKILL');
    const lock=claimLock(dir,kind);assert.equal(lock.blocked(),false);assert.equal(fs.readdirSync(path.join(dir,`${kind}-claims`)).length,1);lock.release();
    assert.equal(fs.readdirSync(path.join(dir,`${kind}-claims`)).length,0);
  }
});

test('a live owner is never stolen and PID reuse does not preserve a dead identity',t=>{
  const dir=sandbox(t),first=claimLock(dir,'flush'),second=claimLock(dir,'flush');
  assert.equal(first.blocked(),false);assert.equal(second.blocked(),true);first.release();assert.equal(second.blocked(),false);second.release();
  const token='a'.repeat(32);fs.writeFileSync(path.join(dir,'flush-claims',`${process.pid}-${token}.json`),JSON.stringify({pid:process.pid,token,start:'different process birth time',choosing:true,ticket:0}),{mode:0o600});
  const third=claimLock(dir,'flush');assert.equal(third.blocked(),false);third.release();
});

test('concurrent processes never enter the same critical section together',async t=>{
  const dir=sandbox(t),guard=path.join(dir,'critical');
  const program=`const fs=require('node:fs'),{claimLock}=require(${JSON.stringify(modulePath)});(async()=>{for(let i=0;i<6;i++){const l=claimLock(${JSON.stringify(dir)},'flush');while(l.blocked())await new Promise(r=>setTimeout(r,2));try{const f=fs.openSync(${JSON.stringify(guard)},'wx',0o600);fs.closeSync(f);await new Promise(r=>setTimeout(r,4));fs.unlinkSync(${JSON.stringify(guard)});}finally{l.release();}}})().then(()=>process.exit(0),()=>process.exit(2));`;
  const children=Array.from({length:4},()=>spawn(process.execPath,['-e',program],{stdio:'ignore'}));
  t.after(()=>{for(const c of children)if(c.exitCode===null)c.kill('SIGKILL');});
  const outcomes=await Promise.all(children.map(c=>once(c,'exit')));assert.deepEqual(outcomes.map(x=>x[0]),[0,0,0,0]);
  assert.equal(fs.existsSync(guard),false);assert.deepEqual(fs.readdirSync(path.join(dir,'flush-claims')),[]);
});

test('unsafe claim directories and malformed peer records fail closed',t=>{
  const dir=sandbox(t),other=sandbox(t);fs.symlinkSync(other,path.join(dir,'queue-claims'));assert.throws(()=>claimLock(dir,'queue'));
  fs.mkdirSync(path.join(dir,'flush-claims'),{mode:0o700});fs.writeFileSync(path.join(dir,'flush-claims',`${process.pid}-${'b'.repeat(32)}.json`),'{}',{mode:0o600});assert.throws(()=>claimLock(dir,'flush'));
  assert.deepEqual(fs.readdirSync(other),[]);
});
