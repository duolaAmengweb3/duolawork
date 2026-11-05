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
