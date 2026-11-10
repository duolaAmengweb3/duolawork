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

test('failed receiver disk write cannot ACK or start native work; retry persists before ACK',async()=>{
 const f=await fixture();try{
  await f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile,channelIds:['durable']});
  const receipts=[],client=f.options.clientFactory(),original=client.api;
  client.api=async(route,args)=>{if(route==='/v2/self/delivery'){
   const disk=JSON.parse(await fs.readFile(f.file,'utf8'));
   assert.equal(disk.bindings[0].received.disk.message.body,'full original requirement');receipts.push(args.body);return{ok:true};
  }return original(route,args);};
  f.setWork([{stepId:'disk',channelId:'durable',status:'ready',delivery:{attempt:0,message:{version:1,body:'full original requirement'}}}]);
  const blocker=path.join(f.dir,'not-a-directory');await fs.writeFile(blocker,'block');f.connector.stateFile=path.join(blocker,'state.json');
  await f.connector.poll();assert.equal(receipts.length,0);assert.equal(f.prompts.length,0);assert.match(f.connector.bindings.get(f.agent.id).lastError,/ENOTDIR|EEXIST/);
  f.connector.stateFile=f.file;await f.connector.poll();assert.deepEqual(receipts.map(r=>r.phase),['received','accepted']);assert.equal(f.prompts.length,1);
 }finally{await f.cleanup();}
});
test('retired or waiting task snapshots never resolve a native agent or queue a DSH prompt',async()=>{
 const f=await fixture();try{
  await f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile,channelIds:['own']});
  const client=f.options.clientFactory();client.api=async()=>({applied:false,status:'removed'});
  f.options.ctx.sessionController.resolveAgent=async()=>assert.fail('obsolete tasks must not resolve/start the model');
  f.setWork([{stepId:'retired',channelId:'own',status:'ready',delivery:{attempt:0,message:{version:1}}}]);
  await f.connector.poll();assert.equal(f.prompts.length,0);assert.equal(f.connector.bindings.get(f.agent.id).received.retired,undefined);assert.equal(f.connector.bindings.get(f.agent.id).lastError,null);
 }finally{await f.cleanup();}
});

test('local native connector rejects unauthenticated and cross-origin requests without exposing its token',async()=>{
 const f=await fixture();try{
  const url=f.connector.state.controlUrl;
  assert.equal((await fetch(url+'/health')).status,401);
  assert.equal((await fetch(url+'/health',{headers:{Authorization:'Bearer '+f.token,Origin:'https://untrusted.example'}})).status,401);
  const r=await fetch(url+'/health',{headers:{Authorization:'Bearer '+f.token}});assert.equal(r.status,200);assert.ok(!(await r.text()).includes(f.token));
 }finally{await f.cleanup();}
});

test('addressed DSH claims use the common session guard without querying work first',async()=>{
 const f=await fixture();try{
  const client=f.options.clientFactory();client.tools=async()=>[{name:'claim_work',inputSchema:{type:'object'}}];
  await f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile,channelIds:['own']});
  const tool=f.registered[0].def,args={requestId:'direct-one',stepId:'turn_one',channelId:'own'};
  await tool.execute(args,{agent:f.agent});
  assert.deepEqual(f.calls,[{name:'claim_work',args:{...args,expectedSessionId:f.agent.id,contextMode:'incremental'}}]);
  await assert.rejects(()=>tool.execute({...args,channelId:'other'},{agent:f.agent}),/其他聊天/);
  assert.equal(f.calls.length,1,'foreign group is not forwarded');
  await tool.execute({requestId:'next',stepId:'inbox:after:turn_one',channelId:'own'},{agent:f.agent});
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].args.expectedSessionId,f.agent.id);
  f.setWork([{stepId:'turn_next',channelId:'own',status:'ready'}]);await f.connector.poll();
  assert.ok(f.prompts[0].content[0].text.includes('"channelId":"own"'));assert.ok(!f.prompts[0].content[0].text.includes('hub_list_work'));
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

test('full tools apply only to a newly created Hub conversation, never to an existing original session',async()=>{
 const f=await fixture();try{
  const settings=[];f.options.ctx.permissionPresets={set:(session,preset)=>settings.push({session,preset})};
  await f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile});assert.equal(settings.length,0);
  f.options.ctx.sessionController.create=async()=>({sessionId:'new-hub-session'});const created={id:'new-hub-session',session:{new:true}};f.options.ctx.sessionController.resolveAgent=async()=>({agent:created});
  const response=await fetch(f.connector.state.controlUrl+'/sessions/create',{method:'POST',headers:{Authorization:'Bearer '+f.token,'Content-Type':'application/json'},body:JSON.stringify({workspace:f.project})});assert.equal(response.status,200);assert.deepEqual(settings,[{session:created.session,preset:'danger-full-access'}]);
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

test('two native contexts for one Hub member are routed by chat; completion releases the next context and scopes survive restart',async()=>{
 const f=await fixture();try{
  const second={...f.agent,id:'second-native-context'};
  f.options.ctx.sessionController.list=async()=>({items:[{sessionId:f.agent.id,cwd:f.project},{sessionId:second.id,cwd:f.project}]});
  f.options.ctx.sessionController.resolveAgent=async id=>({agent:id===second.id?second:f.agent});
  await f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile,channelIds:['channel_a'],verification:true});
  await f.connector.bind({sessionId:second.id,workspace:f.project,grantFile:f.grantFile,channelIds:['channel_b'],verification:false});
  f.setWork([{stepId:'b',channelId:'channel_b',status:'ready'}]);await f.connector.poll();assert.equal(f.prompts[0].sessionId,second.id);
  f.setWork([{stepId:'a',channelId:'channel_a',status:'ready'}]);await f.connector.poll();assert.equal(f.prompts[1].sessionId,f.agent.id);
  await f.restart();assert.deepEqual(f.connector.bindings.get(second.id).channelIds,['channel_b']);await f.connector.poll();assert.equal(f.prompts.length,2);
 }finally{await f.cleanup();}
});

for(const count of [1,2,3,4,5,10,17])test(`DSH: ${count} contexts of one account dispatch together and preserve exact request identities after restart`,async()=>{
 const f=await fixture();try{
  const agents=Array.from({length:count},(_,i)=>({...f.agent,id:`native-${i}`,session:{}}));
  f.options.ctx.sessionController.list=async()=>({items:agents.map(a=>({sessionId:a.id,cwd:f.project}))});
  f.options.ctx.sessionController.resolveAgent=async id=>({agent:agents.find(a=>a.id===id)});
  for(const [i,a] of agents.entries())await f.connector.bind({sessionId:a.id,workspace:f.project,grantFile:f.grantFile,channelIds:[`channel-${i}`,`alias-${i}`],verification:false});
  const work=agents.flatMap((a,i)=>[{stepId:`work-${i}`,channelId:`channel-${i}`,status:'ready'},{stepId:`alias-work-${i}`,channelId:`alias-${i}`,status:'ready'}]);
  f.setWork(work);await Promise.all([f.connector.poll(),f.connector.poll()]);
  assert.equal(f.prompts.length,count,'one busy native context must not serialize its account');assert.equal(new Set(f.prompts.map(p=>p.sessionId)).size,count);assert.ok(f.prompts.every(p=>p.mode==='queue'));
  const requests=f.prompts.map(p=>p.requestId);await f.restart();await f.connector.poll();assert.deepEqual(f.prompts.map(p=>p.requestId),requests,'restart must not enqueue duplicates');
  f.setWork(work.filter(w=>w.stepId.startsWith('alias-work')));await f.connector.poll();assert.equal(f.prompts.length,count*2);assert.equal(new Set(f.prompts.map(p=>p.requestId)).size,count*2);
 }finally{await f.cleanup();}
});

test('a stalled DSH session poll cannot stop other sessions or their next message',async()=>{
 const f=await fixture();let release;try{
  const second={...f.agent,id:'independent'};f.options.ctx.sessionController.list=async()=>({items:[f.agent,second].map(a=>({sessionId:a.id,cwd:f.project}))});f.options.ctx.sessionController.resolveAgent=async id=>({agent:id===second.id?second:f.agent});
  await f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile,channelIds:['slow']});await f.connector.bind({sessionId:second.id,workspace:f.project,grantFile:f.grantFile,channelIds:['fast']});
  const slow=f.connector.bindings.get(f.agent.id);let stalled=false;slow.client={...slow.client,inbox:()=>{if(stalled)return Promise.resolve({work:[]});stalled=true;return new Promise(r=>release=r);}};
  f.setWork([{channelId:'fast',stepId:'first',status:'ready'}]);const pending=f.connector.poll();while(!f.prompts.length)await new Promise(r=>setTimeout(r,2));
  await f.connector.pollJobs.get(second.id);f.setWork([{channelId:'fast',stepId:'second',status:'ready'}]);await f.connector.poll();assert.equal(f.prompts.length,2);release({work:[]});await pending;
 }finally{release?.({work:[]});await f.cleanup();}
});

test('an idle claimed native turn gets one receipt-only continuation even without new work, surviving restart',async()=>{
 const f=await fixture();let now=100000;try{
  f.options.now=()=>now;f.connector.now=f.options.now;
  f.options.ctx.sessionController.list=async()=>({items:[{sessionId:f.agent.id,cwd:f.project,running:false}]});
  await f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile,channelIds:['group']});
  const client=f.options.clientFactory(),api=client.api;let status='active';
  client.api=async(route,args)=>route.startsWith('/v2/self/conversation-state')?{status}:api(route,args);
  f.setWork([{stepId:'turn_work',channelId:'group',status:'ready'}]);await f.connector.poll();
  f.setWork([{stepId:'turn_work',channelId:'group',status:'claimed'}]);now+=15000;await f.connector.poll();
  assert.equal(f.prompts.length,1,'no immediate replay while native may still settle');
  now+=60000;await f.connector.poll();assert.equal(f.prompts.length,2);
  assert.equal(f.prompts[1].sessionId,f.agent.id);assert.equal(f.prompts[1].mode,'queue');assert.match(f.prompts[1].content[0].text,/不要重做已完成/);assert.match(f.prompts[1].content[0].text,/无需再次 claim_work/);
  await f.restart();await f.connector.poll();assert.equal(f.prompts.length,2,'persisted attempt is not enqueued again');
  status='done';now+=60000;await f.connector.poll();assert.equal(f.prompts.length,2);assert.equal(f.connector.bindings.get(f.agent.id).receiptRecovery,null);
  f.setWork([{stepId:'turn_next',channelId:'group',status:'ready'}]);await f.connector.poll();assert.equal(f.prompts.length,3,'next message resumes after authoritative receipt');
 }finally{await f.cleanup();}
});

test('native running, unknown state and network uncertainty cannot trigger receipt replay or fake completion',async()=>{
 const f=await fixture();let now=100000,running=true;try{
  f.connector.now=()=>now;f.options.ctx.sessionController.list=async()=>({items:[{sessionId:f.agent.id,cwd:f.project,running}]});
  await f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile});
  f.setWork([{stepId:'turn_busy',channelId:'group',status:'ready'}]);await f.connector.poll();
  f.setWork([{stepId:'turn_busy',channelId:'group',status:'claimed'}]);const client=f.options.clientFactory(),api=client.api,reports=[];
  client.api=async(route,args)=>{if(route.startsWith('/v2/self/conversation-state')){if(args)reports.push(args.body);else throw Error('network unavailable');return{status:'active'};}return api(route,args);};
  now+=90000;await f.connector.poll();assert.deepEqual(reports.map(r=>r.state),['running']);assert.equal(f.prompts.length,1);
  running=undefined;now+=90000;await f.connector.poll();assert.equal(f.prompts.length,1);
  running=false;now+=15000;await f.connector.poll();now+=60000;await f.connector.poll();
  assert.equal(f.prompts.length,1);assert.match(f.connector.bindings.get(f.agent.id).lastError,/network unavailable/);assert.deepEqual(reports.map(r=>r.state),['running']);
 }finally{await f.cleanup();}
});

test('failed native receipt recovery reports ended once and releases later notifications without redoing the task',async()=>{
 const f=await fixture();let now=100000;try{
  f.connector.now=()=>now;f.options.ctx.sessionController.list=async()=>({items:[{sessionId:f.agent.id,cwd:f.project,running:false}]});
  await f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile});
  const current={stepId:'turn_failed',channelId:'group',status:'claimed'},next={stepId:'turn_next',channelId:'group',status:'ready'};
  f.setWork([{...current,status:'ready'}]);await f.connector.poll();f.setWork([current,next]);
  const client=f.options.clientFactory(),api=client.api,reports=[];
  client.api=async(route,args)=>{if(route.startsWith('/v2/self/conversation-state')){if(args?.body.state==='ended'){reports.push(args.body);f.setWork([next]);return{status:'stalled'};}return{status:'active'};}return api(route,args);};
  now+=15000;await f.connector.poll();now+=60000;await f.connector.poll();assert.equal(f.prompts.length,2);
  now+=60000;await f.connector.poll();assert.equal(f.prompts.length,2);assert.equal(reports.length,1);assert.equal(reports[0].state,'ended');
  await f.connector.poll();assert.equal(f.prompts.length,3);assert.match(f.prompts[2].content[0].text,/turn_next/);await f.connector.poll();assert.equal(reports.length,1);
 }finally{await f.cleanup();}
});

test('pre-claim failure gets bounded recovery and an explicit retry uses a new native request without duplicating it',async()=>{
 const f=await fixture();let now=100000,status='ready';try{
  f.connector.now=()=>now;f.options.ctx.sessionController.list=async()=>({items:[{sessionId:f.agent.id,cwd:f.project,running:false}]});
  await f.connector.bind({sessionId:f.agent.id,workspace:f.project,grantFile:f.grantFile});
  const work={stepId:'turn_before_claim',channelId:'group',status:'ready'},client=f.options.clientFactory(),api=client.api;
  client.api=async(route,args)=>{if(route.startsWith('/v2/self/conversation-state')){if(args?.body.state==='ended'){status='stalled';f.setWork([]);}return{status};}return api(route,args);};
  f.setWork([work]);await f.connector.poll();const first=f.prompts[0].requestId;
  now+=15000;await f.connector.poll();now+=60000;await f.connector.poll();assert.equal(f.prompts.length,2);assert.match(f.prompts[1].content[0].text,/本条尚未领取/);
  now+=60000;await f.connector.poll();assert.equal(status,'stalled');assert.equal(f.prompts.length,2);
  status='ready';f.setWork([{...work,deliveryAttempt:1}]);await f.connector.poll();assert.equal(f.prompts.length,3);assert.notEqual(f.prompts[2].requestId,first);
  await f.connector.poll();assert.equal(f.prompts.length,3);assert.deepEqual(f.connector.publicBinding(f.connector.bindings.get(f.agent.id)).dispatchedStepIds,['turn_before_claim']);
 }finally{await f.cleanup();}
});
