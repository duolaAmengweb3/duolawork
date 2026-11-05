import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CodingManager} from '../local/coding-manager.mjs';
import {presentSessions,sessionErrorMessage} from '../local/session-presentation.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
async function fixture(t,{session,signal}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-session-race-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const agents=[];const manager=new CodingManager({config:{},dataDir:dir,runtime:{ensure:async()=>({command:process.execPath})},agentFactory:()=>{
  const agent={rpc:{closed:false},initialize:async()=>({}),stop:async()=>{agent.rpc.closed=true;agent.stops++;},stops:0,session:async options=>session?session(agent,options):{id:'created-session'}};agents.push(agent);return agent;
 }});
 const record=manager.records.member_fixture={memberId:'member_fixture',engine:'codex',enabled:true,sourceReady:true,status:'idle',cwd:dir,chatBindings:{},sessions:{},lastCompletedAt:'2026-01-01T00:00:00Z'};
 manager.client=()=>({tools:async()=>[],api:async p=>p==='/v2/signal'?(signal?signal():{hasWork:false}):{complete:true}});
 manager.workingHost={sessions:async()=>({items:[]})};
 return{manager,record,agents};
}
test('idle signal polling is not working and cannot reject a chat session choice',async t=>{
 const read=deferred(),entered=deferred();const {manager,record}=await fixture(t,{signal:()=>{entered.resolve();return read.promise;}});
 const tick=manager.tick();await entered.promise;
 const assign=manager.assign({memberId:record.memberId,channelId:'channel_next',mode:'new',title:'网站开发'});assign.catch(()=>{});
 read.resolve({hasWork:false});await tick;const result=await assign;
 assert.equal(result.title,'网站开发');assert.equal(record.status,'idle');
});
test('idle cleanup never terminates a native process during session creation',async t=>{
 const created=deferred(),entered=deferred();const {manager,record,agents}=await fixture(t,{session:async a=>{entered.resolve();await created.promise;if(a.rpc.closed)throw Error('原生进程已退出 SIGTERM');return{id:'created-session'};}});
 await manager.prepareNative(record,manager.client());record.status='idle';
 const assign=manager.assign({memberId:record.memberId,channelId:'channel_next',mode:'new',title:'网站开发'});assign.catch(()=>{});await entered.promise;
 await manager.tick();created.resolve();await assign;
 assert.equal(agents[0].stops,0);assert.equal(record.status,'idle');assert.equal(record.chatBindings.channel_next.sessionId,'created-session');
});
test('cold reconnect followed by create returns to receiving messages instead of staying connecting',async t=>{
 const {manager,record}=await fixture(t);await manager.assign({memberId:record.memberId,channelId:'channel_next',mode:'new',title:'新对话'});
 assert.equal(record.status,'idle');assert.equal(record.inFlight??null,null);
});
test('selecting a saved conversation uses its binding without starting or resetting a native process',async t=>{
 const {manager,record,agents}=await fixture(t);record.chatBindings.channel_old={sessionId:'saved-session',workspace:record.cwd,title:'旧网站'};
 await manager.assign({memberId:record.memberId,channelId:'channel_next',mode:'existing',sessionId:'saved-session'});
 assert.equal(agents.length,0);assert.equal(record.chatBindings.channel_next.sessionId,'saved-session');
});
test('actual in-flight work is preserved when a user tries changing its conversation',async t=>{
 const {manager,record,agents}=await fixture(t);record.inFlight={key:'channel_next',stepId:'turn_active'};record.status='working';
 await assert.rejects(()=>manager.assign({memberId:record.memberId,channelId:'channel_next',mode:'new'}),/正在/);
 assert.equal(agents.length,0);assert.equal(record.inFlight.stepId,'turn_active');assert.deepEqual(record.chatBindings,{});
});
test('legacy dialogs have recognizable chat and project labels without changing original bindings',()=>{
 const bindings={channel_old:{sessionId:'native-id',workspace:'/hub/coding/workspace',title:'原工作会话'}},before=JSON.stringify(bindings);
 const [s]=presentSessions([{id:'native-id',workspace:'/hub/coding/workspace',title:'原工作会话'}],{bindings,channels:[{id:'channel_old',name:'网站改版'}],dataDir:'/hub',platform:'Codex'});
 assert.equal(s.title,'网站改版');assert.equal(s.projectName,'Hub 独立工作区');assert.equal(s.sourceLabel,'Hub 中创建的对话');assert.equal(JSON.stringify(bindings),before);assert.equal(s.id,'native-id');
 const [native]=presentSessions([{id:'ide-id',title:'修复购物车',workspace:'/work/shop',source:'vscode',mode:'native-existing',updatedAt:1700000000}],{platform:'Codex'});
 assert.equal(native.projectName,'shop');assert.equal(native.sourceLabel,'Codex 中的对话');assert.ok(native.updatedAt.startsWith('2023-'));
 assert.equal(sessionErrorMessage(Error('原生进程已退出 SIGTERM')).includes('SIGTERM'),false);
});
test('a previously completed binding left in connecting by the old version resumes reception after reload',async t=>{
 const {manager,record}=await fixture(t);record.status='connecting';record.chatBindings.channel_old={sessionId:'exact-old',title:'旧对话',workspace:record.cwd};await manager.save();
 const restored=new CodingManager({dataDir:manager.dataDir,config:{}});await restored.load();assert.equal(restored.records[record.memberId].status,'idle');assert.equal(restored.records[record.memberId].chatBindings.channel_old.sessionId,'exact-old');
});
test('catalog initialization after idle process cleanup does not stop normal message polling',async t=>{
 const {manager,record}=await fixture(t);
 await manager.prepareNative(record,manager.client(),{preserveStatus:true});
 assert.equal(record.status,'idle');
 let checked=0;manager.check=async()=>{checked++;};await manager.tick();assert.equal(checked,1);
});

async function originalDelivery(t){
 const {manager,record,agents}=await fixture(t);
 record.inFlight={key:'channel_original',stepId:'turn_original'};
 record.chatBindings.channel_original={sessionId:'exact-original',workspace:record.cwd,mode:'native-existing'};
 record.nativeDeliveries={turn_original:{sessionId:'exact-original',status:'sent'}};
 record.status='working';await manager.save();await manager.load();
 const restored=manager.records[record.memberId];
 assert.equal(restored.status,'syncing');
 manager.workingHost.queue=()=>{throw Error('must never resend original delivery');};
 manager.workingHost.isQueued=async()=>false;
 return{manager,record:restored,agents};
}
test('restart observes claimed original work without interrupting, replaying or reconnecting',async t=>{
 const {manager,record,agents}=await originalDelivery(t);const calls=[];
 manager.client=()=>({tool:async name=>{calls.push(name);return{work:[{stepId:'turn_original',status:'claimed'}]};}});
 await manager.tick();assert.deepEqual(calls,['list_work']);assert.equal(agents.length,0);
 assert.equal(record.status,'working');assert.equal(record.inFlight.stepId,'turn_original');
 assert.equal(manager.status().members[0].pendingReply,true);
 assert.equal(record.chatBindings.channel_original.sessionId,'exact-original');
});
test('original reply completed across restart automatically clears stale interruption and resumes reception',async t=>{
 const {manager,record,agents}=await originalDelivery(t);let checks=0;
 manager.client=()=>({tool:async()=>({work:[]}),api:async p=>{assert.equal(p,'/v2/self/status');return{complete:true};}});
 manager.check=async()=>{checks++;};await manager.tick();
 assert.equal(record.status,'idle');assert.equal(record.inFlight,null);assert.equal(agents.length,0);assert.equal(checks,0);
 assert.equal(manager.status().members[0].pendingReply,false);
 await manager.tick();assert.equal(checks,1);
});
test('lost polling response preserves original delivery and retries only the read',async t=>{
 const {manager,record,agents}=await originalDelivery(t);
 manager.client=()=>({tool:async()=>{throw Error('temporary network failure');}});
 await manager.tick();assert.equal(record.status,'syncing');assert.equal(record.inFlight.stepId,'turn_original');assert.equal(agents.length,0);
 manager.client=()=>({tool:async()=>({work:[{stepId:'turn_original',status:'claimed'}]})});
 await manager.tick();assert.equal(record.status,'working');assert.equal(record.nativeDeliveries.turn_original.status,'sent');
});
test('uncertain queued delivery is never silently sent again or declared finished',async t=>{
 const {manager,record,agents}=await originalDelivery(t);record.nativeDeliveries.turn_original.status='uncertain';
 manager.client=()=>({tool:async()=>({work:[{stepId:'turn_original',status:'ready'}]})});
 await manager.tick();assert.equal(record.status,'needs_review');assert.equal(record.inFlight.stepId,'turn_original');assert.equal(agents.length,0);
});
test('disappeared work cannot make an unverified connection ready',async t=>{
 const {manager,record}=await originalDelivery(t);
 manager.client=()=>({tool:async()=>({work:[]}),api:async()=>({complete:false})});
 await manager.tick();assert.equal(record.status,'needs_review');assert.equal(record.inFlight,null);
});
test('a native queue receipt distinguishes pending original work from a failed connection, without replay',async t=>{
 const {manager,record,agents}=await originalDelivery(t);record.nativeDeliveries.turn_original.status='uncertain';
 manager.client=()=>({tool:async()=>({work:[{stepId:'turn_original',status:'ready'}]})});
 manager.workingHost.isQueued=async input=>{assert.deepEqual(input,{sessionId:'exact-original',workMarker:'turn_original'});return true;};
 await manager.tick();
 assert.equal(record.status,'syncing');assert.equal(record.nativeDeliveries.turn_original.status,'queued');
 const state=manager.status().members[0];assert.equal(state.pendingStepId,'turn_original');assert.equal(state.deliveryState,'queued');
 assert.equal(record.chatBindings.channel_original.sessionId,'exact-original');assert.equal(agents.length,0);
 manager.client=()=>({tool:async()=>({work:[]}),api:async()=>({complete:true})});
 await manager.tick();assert.equal(record.status,'idle');assert.equal(record.inFlight,null);
});
