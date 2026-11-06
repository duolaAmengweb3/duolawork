import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand,claimConversation,conversationRuntime} from '../cloud/collaboration/conversation.mjs';
import {pendingMemberActivity} from '../shared/chat-activity.mjs';
import {memberAvailability} from '../shared/member-availability.mjs';
import {CodingManager} from '../local/coding-manager.mjs';

test('active means processing with real progress, and terminal cloud state beats a stale native busy report',()=>{
 const member={id:'a',platformId:'codex'},native={enabled:true,assignments:[{channelId:'c',pendingStepId:'turn_x',workState:'working'}]},turn={id:'turn_x',memberId:'a',scopeId:'c',status:'active',progress:'正在核对 3 个文件'};
 assert.equal(pendingMemberActivity([turn])[0].label,'处理中 · 正在核对 3 个文件');
 assert.equal(memberAvailability(member,{},native,'c',[turn]).label,'处理中 · 正在核对 3 个文件');
 for(const status of ['done','silent','stalled']){
  assert.deepEqual(pendingMemberActivity([{...turn,status}]),[]);
  assert.notEqual(memberAvailability(member,{},native,'c',[{...turn,status}]).state,'working');
 }
});

test('runtime interruption is member-scoped, preserves work, releases only its resource and cannot overwrite a real reply',async t=>{
 const f=await fixture(t),owner={owner:true},actor={memberId:'grok'};
 const c=await conversationCommand(f.repo,f.identity,owner,{type:'channel.create',requestId:'c',name:'中断验收',memberIds:['grok']});
 const send=async requestId=>{await conversationCommand(f.repo,f.identity,owner,{type:'channel.post',channelId:c.id,requestId,body:'请核对',mentions:['grok']});return claimConversation(f.repo,f.identity,actor,{requestId:'claim-'+requestId,receiveNext:true,channelId:c.id});};
 const claim=await send('one');
 await assert.rejects(conversationRuntime(f.repo,{memberId:'check'},{requestId:'foreign',turnId:claim.turnId,state:'ended'}),e=>e.code==='forbidden');
 await conversationRuntime(f.repo,actor,{requestId:'alive',turnId:claim.turnId,state:'running'});
 assert.equal((await f.repo.get('channel_turn',claim.turnId)).status,'active');
 const interrupted=await conversationRuntime(f.repo,actor,{requestId:'stopped',turnId:claim.turnId,state:'ended'});
 assert.equal(interrupted.status,'stalled');assert.equal(interrupted.completedAt,null);
 const row=await f.repo.get('channel_turn',claim.turnId);assert.ok(row.claimedAt&&row.lease);assert.equal((await f.repo.get('resource',row.resourceKey)).status,'idle');
 const second=await send('two');await conversationCommand(f.repo,f.identity,actor,{type:'channel.post',requestId:'reply',channelId:c.id,turnId:second.turnId,body:'已核对'});
 assert.equal((await conversationRuntime(f.repo,actor,{requestId:'late-exit',turnId:second.turnId,state:'ended'})).status,'done');
 assert.equal((await conversationRuntime(f.repo,actor,{action:'read',turnId:second.turnId})).status,'done');
});

test('reconcile checks real receipts without a delivery record, clears inFlight and uses the server completion time',async()=>{
 const manager=new CodingManager({config:{},dataDir:'/unused'});manager.save=async()=>{};
 const r={memberId:'a',engine:'codex',enabled:true,status:'working',inFlight:{stepId:'turn_done'},lastCompletedAt:'old'};
 manager.client=()=>({tool:async()=>({work:[]}),api:async p=>p==='/v2/self/status'?{complete:true}:{status:'done',completedAt:'2026-11-06T01:00:00Z'}});
 await manager.reconcileOriginal(r);assert.equal(r.inFlight,null);assert.equal(r.status,'idle');assert.equal(r.lastReceiptAt,'2026-11-06T01:00:00Z');assert.equal(r.lastCompletedAt,r.lastReceiptAt);
 r.inFlight={stepId:'turn_stalled'};manager.client=()=>({tool:async()=>({work:[]}),api:async()=>({status:'stalled',reason:'未回传'})});await manager.reconcileOriginal(r);assert.equal(r.status,'needs_review');assert.equal(r.inFlight,null);assert.equal(r.lastReceiptAt,'2026-11-06T01:00:00Z');
});

test('receipt reconciliation keeps its flight when the connection check fails, then recovers without repeating work',async()=>{
 const manager=new CodingManager({config:{},dataDir:'/unused'});manager.save=async()=>{};
 const flight={stepId:'turn_done'},r={memberId:'a',engine:'codex',enabled:true,status:'working',inFlight:flight,lastCompletedAt:'old'};
 let fail=true;manager.client=()=>({tool:async()=>({work:[]}),api:async p=>{if(p==='/v2/self/status'){if(fail)throw Error('network temporarily unavailable');return{complete:true};}return{status:'done',completedAt:'2026-11-06T01:00:00Z'};}});
 await manager.reconcileOriginal(r);assert.equal(r.inFlight,flight);assert.equal(r.lastCompletedAt,'old');assert.equal(r.status,'syncing');
 fail=false;await manager.reconcileOriginal(r);assert.equal(r.inFlight,null);assert.equal(r.status,'idle');assert.equal(r.lastCompletedAt,'2026-11-06T01:00:00Z');
});

test('healthy long runs remain active; sustained native idle or unavailable state stops a missing reply within a minute',async()=>{
 const manager=new CodingManager({config:{},dataDir:'/unused'});manager.save=async()=>{};let native='running',status='active';const reports=[];
 manager.workingHost={executionState:async()=>{if(native==='unreachable')throw Error('disconnected');return{state:native};}};
 const client={api:async(_path,options)=>{if(options){reports.push(options.body);if(options.body.state!=='running')status='stalled';}return{status,reason:'需检查原工作'};}};
 const r={engine:'codex',enabled:true,inFlight:{stepId:'turn_work',key:'c'},chatBindings:{c:{sessionId:'original'}}};
 await manager.observeOriginal(r,client,100000);await manager.observeOriginal(r,client,2000000);assert.equal(status,'active');assert.ok(r.inFlight);
 native='idle';await manager.observeOriginal(r,client,2015000);await manager.observeOriginal(r,client,2060000);assert.equal(status,'active');await manager.observeOriginal(r,client,2075000);assert.equal(status,'stalled');assert.equal(r.inFlight,null);assert.equal(reports.at(-1).state,'ended');
 status='active';r.inFlight={stepId:'turn_other',key:'c'};native='unreachable';await manager.observeOriginal(r,client,3000000);await manager.observeOriginal(r,client,3060000);assert.equal(reports.at(-1).state,'unreachable');assert.equal(r.inFlight,null);
});

test('idle original session gets one receipt repair, restart cannot repeat it, later user work is unblocked without false success',async()=>{
 const manager=new CodingManager({config:{},dataDir:'/unused'});manager.save=async()=>{};let status='active',sends=0;
 const r={memberId:'a',engine:'codex',enabled:true,inFlight:{stepId:'turn_real',key:'c'},chatBindings:{c:{sessionId:'original',workspace:'/original'}}};
 const client={api:async(p,opts)=>{if(opts)status='stalled';return{status,reason:'未回传'};}};
 manager.workingHost={executionState:async()=>({state:'idle'}),queue:async args=>{sends++;assert.equal(args.sessionId,'original');assert.equal(args.workspace,'/original');assert.match(args.prompt,/不要重新执行/);assert.match(args.prompt,/turn_real/);}};
 await manager.observeOriginal(r,client,100000);await manager.observeOriginal(r,client,160000);
 assert.equal(sends,1);assert.equal(status,'active');assert.equal(r.inFlight.receiptRecovery.status,'sent');
 const restored=JSON.parse(JSON.stringify(r));await manager.observeOriginal(restored,client,220000);
 assert.equal(sends,1);assert.equal(status,'stalled');assert.equal(restored.inFlight,null);assert.equal(restored.lastReceiptAt,undefined);
});
