import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startHarness} from './v1-harness.mjs';
import {CodingManager} from '../local/coding-manager.mjs';
import {DshManager} from '../local/dsh-manager.mjs';
import {ChatSessions} from '../local/chat-sessions.mjs';
import {acceptsWork,nativeBindings} from '../local/session-routing.mjs';

test('native dispatch routes only the assigned conversation and one explicit verification receiver',()=>{
 const a={channelIds:['channel_a'],verification:false},b={channelIds:['channel_b'],verification:true};
 assert.equal(acceptsWork(a,{channelId:'channel_b'}),false);assert.equal(acceptsWork(a,{}),false);assert.equal(acceptsWork(b,{}),true);assert.equal(acceptsWork({},{}),true);
 assert.deepEqual(nativeBindings({verificationSessionId:'s',chatBindings:{a:{sessionId:'s',workspace:'/x'},b:{sessionId:'s',workspace:'/x'}}}),[{sessionId:'s',workspace:'/x',channelIds:['a','b'],verification:true}]);
});

test('one account supports concurrent Codex members; connect uses no model; chats persist separate native sessions and projects',async t=>{
 const h=await startHarness();t.after(()=>h.stop());let running=0,peak=0,turns=0,created=0;
 const manager=new CodingManager({dataDir:path.join(h.directory,'local'),config:{endpoint:h.base,adminKey:h.key},runtime:{ensure:async()=>({command:process.execPath})},agentFactory:opts=>({
  initialize:async()=>{},stop:async()=>{},session:async({id,cwd})=>({id:id||'session-'+(++created),cwd}),
  run:async({session,prompt})=>{running++;peak=Math.max(peak,running);turns++;try{await new Promise(r=>setTimeout(r,40));const {work}=await opts.toolCall('list_work',{}),stepId=prompt.match(/stepId=([^，]+)/)[1],item=work.find(w=>w.stepId===stepId);assert.ok(item);const claim=await opts.toolCall('claim_work',{requestId:randomUUID(),stepId});if(item.channelId)await opts.toolCall('post_message',{requestId:randomUUID(),channelId:item.channelId,turnId:claim.turnId,body:'fixture '+session.id});else await opts.toolCall('submit_work',{requestId:randomUUID(),attemptId:claim.attemptId,lease:claim.lease,items:[{title:'protocol fixture',body:claim.input.instruction.match(/proof_[a-z0-9]+/)[0]}]});return{sessionId:session.id};}finally{running--;}}
 })});t.after(()=>manager.stop());manager.workingHost={sessions:async()=>({items:[]})};
 const sessions=new ChatSessions({coding:manager,dsh:{},ag:{}});
 await h.request('/admin/action',{type:'platform.create',payload:{id:'codex',name:'Codex'}});
 const account=(await h.request('/admin/action',{type:'account.create',payload:{platformId:'codex',label:'shared original login'}})).result;
 const members=[];for(const name of ['Codex · 网站','Codex · App'])members.push((await h.request('/admin/action',{type:'member.create',payload:{accountId:account.id,name,mode:'connector'}})).result);
 for(const m of members){await sessions.connect({memberId:m.id});await manager.jobs.get(m.id);}
 assert.equal(turns,0);assert.equal(created,0);assert.ok(members.every(m=>manager.records[m.id].sourceReady));
 const group=await h.command('channel.create',{name:'一起开发',memberIds:members.map(m=>m.id)}),other=await h.command('channel.create',{name:'另一项目',memberIds:[members[0].id]});
 const project=path.join(h.directory,'existing-project');await fs.mkdir(project);await fs.writeFile(path.join(project,'notes.txt'),'preserve');
 await sessions.assign({memberId:members[0].id,channelId:group.id,mode:'new',workspace:project});const proof=manager.records[members[0].id].proofRunId;
 await sessions.assign({memberId:members[0].id,channelId:other.id,mode:'new'});assert.equal(manager.records[members[0].id].proofRunId,proof,'A second chat must not supersede a pending verification');
 await sessions.assign({memberId:members[1].id,channelId:group.id,mode:'new'});
 await h.command('channel.post',{channelId:group.id,body:'First message while native context verifies',mentions:members.map(m=>m.id)});for(const m of members){const {work}=await manager.client(manager.records[m.id]).tool('list_work');assert.equal(work.some(w=>w.kind==='conversation'),false,'An unverified native agent must not claim queued chat before its probe');}
 await manager.tick();await manager.tick();for(const r of Object.values(manager.records))assert.equal(r.status,'idle',r.message);assert.equal(peak,2); // different identities execute concurrently
 const r=manager.records[members[0].id];assert.notEqual(r.chatBindings[group.id].sessionId,r.chatBindings[other.id].sessionId);assert.equal(r.chatBindings[group.id].workspace,await fs.realpath(project));assert.equal(await fs.readFile(path.join(project,'notes.txt'),'utf8'),'preserve');
 await h.command('channel.post',{channelId:group.id,body:'各自回复',mentions:members.map(m=>m.id)});await h.command('channel.post',{channelId:other.id,body:'单独回复'});await manager.tick();await manager.tick();
 const replies=(await h.request('/v2/channel?id='+group.id)).messages.filter(m=>m.authorId!=='owner');assert.ok(replies.some(m=>m.authorId===members[0].id&&m.body.includes(r.chatBindings[group.id].sessionId)));assert.ok(replies.some(m=>m.authorId===members[1].id));
 const second=(await h.request('/v2/channel?id='+other.id)).messages.find(m=>m.authorId===members[0].id);assert.ok(second.body.includes(r.chatBindings[other.id].sessionId));
 const restarted=new CodingManager({dataDir:manager.dataDir,config:manager.config});await restarted.load();assert.deepEqual(restarted.records[members[0].id].chatBindings,r.chatBindings);
 await assert.rejects(()=>sessions.assign({memberId:members[1].id,channelId:other.id,mode:'new'}),/先把/);
});

test('desktop member migration preserves existing chats; a new chat never inherits the old global session',async t=>{
 const h=await startHarness();t.after(()=>h.stop());await h.request('/admin/action',{type:'platform.create',payload:{id:'deepseek-harness',name:'DSH'}});const member=await h.member('deepseek-harness','fixture desktop');
 const old=await h.command('channel.create',{name:'old',memberIds:[member.id]}),next=await h.command('channel.create',{name:'new',memberIds:[member.id]});
 const project=path.join(h.directory,'native');await fs.mkdir(project);const bound=new Map();let creates=0;
 const host={kind:'desktop',load:async()=>{},start:async()=>{},sessions:async()=>({items:[{id:'original',title:'原项目',workspace:project},{id:'new-context',title:'新项目',workspace:project}]}),create:async()=>{creates++;return{sessionId:'new-context'};},call:async(p,b)=>{if(p==='/health')return{ready:true,bindings:[...bound.values()]};if(p==='/bind'){bound.set(b.sessionId,{...b,memberId:member.id});return{};}if(p==='/unbind'){bound.delete(b.sessionId);return{};}throw Error(p);}};
 const manager=new DshManager({host,dataDir:path.join(h.directory,'local'),config:{endpoint:h.base,adminKey:h.key}});t.after(()=>manager.stop());
 await manager.connect({memberId:member.id,sessionId:'original'});await manager.jobs.get(member.id);
 // Snapshot migration captures existing conversations rather than installing a wildcard.
 await manager.migrateAssignments(manager.records[member.id],[old]);
 await manager.assign({memberId:member.id,channelId:next.id,mode:'new',channels:[old,next]});assert.equal(creates,1);const proof=manager.records[member.id].proofRunId;await manager.assign({memberId:member.id,channelId:old.id,mode:'existing',sessionId:'original',channels:[old,next]});assert.equal(manager.records[member.id].proofRunId,proof);
 assert.deepEqual(bound.get('original').channelIds,[old.id]);assert.deepEqual(bound.get('new-context').channelIds,[next.id]);
 assert.equal(manager.records[member.id].chatBindings[old.id].sessionId,'original');await manager.disconnect(member.id);assert.equal(bound.size,0);assert.equal((await host.sessions()).items.length,2);
});
