import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DshConnector} from '../local/dsh-connector.mjs';

async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-dsh-unit-')),project=path.join(dir,'project');await fs.mkdir(project);
 const file=path.join(dir,'connector.json'),grantFile=path.join(dir,'grant.json'),token=randomUUID()+randomUUID();
 await fs.writeFile(file,JSON.stringify({controlToken:token,bindings:[]}),{mode:0o600});await fs.writeFile(grantFile,'{}',{mode:0o600});
 const registered=[],prompts=[],calls=[];let work=[];
 const agent={id:'native-owned-session',session:{},ctx:{tools:{register(def){const r={def,disposed:false};registered.push(r);return()=>{r.disposed=true;};}}}};
 const ctx={sessionController:{list:async()=>({items:[{sessionId:agent.id,cwd:project}]}),resolveAgent:async()=>({agent}),prompt:async request=>{prompts.push(request);return{accepted:true};}},workingDirectory:{get:()=>project}};
 const client={credentials:async()=>({memberId:'member-owned'}),api:async()=>({hasWork:work.some(w=>w.status==='ready')}),tools:async()=>[{name:'post_message',description:'Reply',inputSchema:{type:'object',properties:{body:{type:'string'}}}}],tool:async(name,args)=>{calls.push({name,args});return name==='list_work'?{work}:{ok:true};}};
 const options={ctx,stateFile:file,pollMs:100000,clientFactory:()=>client};
 let connector=await new DshConnector(options).start();
 return{dir,project,file,grantFile,token,registered,prompts,calls,agent,options,get connector(){return connector;},setWork:v=>{work=v;},restart:async()=>{await connector.stop();connector=await new DshConnector(options).start();return connector;},cleanup:async()=>{await connector.stop();await fs.rm(dir,{recursive:true,force:true});}};
}

test('local native connector rejects unauthenticated and cross-origin requests without exposing its token',async()=>{
 const f=await fixture();try{
  const url=f.connector.state.controlUrl;
  assert.equal((await fetch(url+'/health')).status,401);
  assert.equal((await fetch(url+'/health',{headers:{Authorization:'Bearer '+f.token,Origin:'https://untrusted.example'}})).status,401);
  const r=await fetch(url+'/health',{headers:{Authorization:'Bearer '+f.token}});assert.equal(r.status,200);assert.ok(!(await r.text()).includes(f.token));
 }finally{await f.cleanup();}
});

test('binding requires the exact existing native session and canonical project before registering tools',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.connector.bind({sessionId:'missing',workspace:f.project,grantFile:f.grantFile}),/does not exist/);
  await assert.rejects(f.connector.bind({sessionId:f.agent.id,workspace:f.dir,grantFile:f.grantFile}),/workspace does not match/);
  assert.equal(f.registered.length,0);assert.equal(f.prompts.length,0);
  await f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile});assert.equal(f.registered.length,1);
 }finally{await f.cleanup();}
});

test('native Hub tools refuse another Agent identity; disconnect removes tools and retains native work',async()=>{
 const f=await fixture();try{
  await f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile});
  const tool=f.registered[0].def;
  await assert.rejects(tool.execute({body:'x'},{agent:{id:'another-session'}}),/not authorized/);
  assert.equal(f.calls.length,0);
  assert.deepEqual(await tool.execute({body:'hello'},{agent:f.agent}),{ok:true});
  const result=await f.connector.unbind(f.agent.id);assert.equal(result.nativeSessionRetained,true);assert.equal(f.registered[0].disposed,true);
  await assert.rejects(tool.execute({body:'x'},{agent:f.agent}),/not authorized/);
  assert.equal(f.prompts.length,0);assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')).bindings,[]);
 }finally{await f.cleanup();}
});

test('empty polling does not run a model; duplicate ready work and restart retain the same native request identity',async()=>{
 const f=await fixture();try{
  await f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile});
  await f.connector.poll();assert.equal(f.prompts.length,0);
  f.setWork([{status:'ready',stepId:'one-message',channelId:'same-channel'}]);
  await Promise.all([f.connector.poll(),f.connector.poll()]);await f.connector.poll();
  assert.equal(f.prompts.length,1);assert.equal(f.prompts[0].sessionId,f.agent.id);assert.equal(f.prompts[0].mode,'queue');
  assert.equal(f.prompts[0].requestId.length,64);
  const c=await f.restart();await c.poll();assert.equal(f.prompts.length,1);assert.equal(c.bindings.get(f.agent.id).memberId,'member-owned');
 }finally{await f.cleanup();}
});

test('unbinding while a lightweight check is in flight cannot wake the original Agent afterward',async()=>{
 const f=await fixture();try{
  await f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile});
  f.setWork([{status:'ready',stepId:'late-message',channelId:'same-channel'}]);
  const b=f.connector.bindings.get(f.agent.id);let finish;
  b.client.tool=()=>new Promise(resolve=>{finish=resolve;});
  const pending=f.connector.poll();while(!finish)await new Promise(r=>setImmediate(r));await f.connector.unbind(f.agent.id);
  finish({work:[{status:'ready',stepId:'late-message',channelId:'same-channel'}]});await pending;
  assert.equal(f.prompts.length,0);
 }finally{await f.cleanup();}
});

test('native Agent recreation attaches tools to the same persisted session rather than a stale runtime object',async()=>{
 const f=await fixture();try{
  await f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile});
  const replacement={...f.agent,session:{}};f.connector.ctx.sessionController.resolveAgent=async()=>({agent:replacement});
  f.setWork([{status:'ready',stepId:'after-native-recreation',channelId:'same-channel'}]);await f.connector.poll();
  assert.equal(f.registered[0].disposed,true);assert.equal(f.registered.length,2);
  assert.equal(f.connector.bindings.get(f.agent.id).agent,replacement);assert.equal(f.prompts[0].sessionId,f.agent.id);
 }finally{await f.cleanup();}
});

test('parallel restore and connect cannot register Hub tools twice for the same original session',async()=>{
 const f=await fixture();try{await Promise.all([f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile}),f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile})]);assert.equal(f.registered.length,1);assert.equal(f.connector.bindings.size,1);}finally{await f.cleanup();}
});

test('native Host health stays not ready until persisted bindings and scoped tools have finished restoring',async()=>{
 const f=await fixture();let restarted;try{
  await f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile});const client=f.connector.bindings.get(f.agent.id).client;await f.connector.stop();let release;client.tools=()=>new Promise(r=>release=r);
  restarted=new DshConnector(f.options);const boot=restarted.start();while(!release)await new Promise(r=>setImmediate(r));
  const response=await fetch(restarted.state.controlUrl+'/health',{headers:{Authorization:'Bearer '+f.token}});assert.equal((await response.json()).ready,false);
  release([{name:'post_message',inputSchema:{type:'object'}}]);await boot;assert.equal(restarted.ready,true);assert.equal(restarted.bindings.size,1);
 }finally{await restarted?.stop();await f.cleanup();}
});

test('archived native sessions are not offered as active work and are never silently reopened by binding',async()=>{
 const f=await fixture();try{f.connector.ctx.workspaceRegistry={archivedSessionIds:[f.agent.id]};assert.equal((await f.connector.sessions()).items.length,0);await assert.rejects(f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile}),/does not exist/);assert.equal(f.prompts.length,0);}finally{await f.cleanup();}
});
