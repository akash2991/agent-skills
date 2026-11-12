'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {createFlow}=require('../runtime/langfuse/flow.cjs');
const {handleClaudeHook}=require('../runtime/langfuse/claude.cjs');
function fixture(t){const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'brain-actor-race-')));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));return{cwd,stateDir:path.join(cwd,'state'),sessionId:crypto.randomUUID()};}
const actor=output=>output.hookSpecificOutput.additionalContext.match(/--actor ([A-Za-z0-9_-]+)/)[1];
test('duplicate startup hooks atomically publish one native actor and one capability across processes',async t=>{
 const f=fixture(t),program=`const{createFlow}=require(${JSON.stringify(require.resolve('../runtime/langfuse/flow.cjs'))});const{handleClaudeHook}=require(${JSON.stringify(require.resolve('../runtime/langfuse/claude.cjs'))});const f=${JSON.stringify(f)};const flow=createFlow({harness:'claude',cwd:f.cwd,stateDir:f.stateDir,env:{},flushOutbox:async()=>({accepted:0})});handleClaudeHook({cwd:f.cwd,session_id:f.sessionId,hook_event_name:'SessionStart'},{flow}).then(output=>console.log(JSON.stringify({output,run:flow.session(f.sessionId)})));`;
 const children=Array.from({length:4},()=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,['-e',program]);let out='',err='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);c.once('error',reject);c.once('close',code=>{try{assert.equal(code,0,err);resolve(JSON.parse(out));}catch(e){reject(e);}});}));
 const rows=await Promise.all(children);assert.equal(new Set(rows.map(r=>r.run.runId)).size,1);assert.equal(new Set(rows.map(r=>actor(r.output))).size,1);
 const state=JSON.parse(fs.readFileSync(path.join(f.stateDir,'context-v1.json')));assert.equal(Object.keys(state.runs).length,1);
});
test('startup and prompt contexts keep one actor value; expiration refreshes without borrowing another actor',async t=>{
 const f=fixture(t);let now=Date.now();const flow=createFlow({harness:'claude',cwd:f.cwd,stateDir:f.stateDir,env:{},clock:()=>now,flushOutbox:async()=>({accepted:0})});
 const hook=event=>handleClaudeHook({cwd:f.cwd,session_id:f.sessionId,hook_event_name:event},{flow,clock:()=>now});
 const first=actor(await hook('SessionStart'));assert.equal(actor(await hook('UserPromptSubmit')),first);assert.equal(actor(await hook('SessionStart')),first);
 now+=25*3600*1000;const fresh=actor(await hook('UserPromptSubmit'));assert.notEqual(fresh,first);assert.equal(flow.actorForTool(first),null);assert.equal(flow.actorForTool(fresh).runId,flow.session(f.sessionId).runId);
});
