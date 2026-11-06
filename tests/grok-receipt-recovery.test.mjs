import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand,claimConversation} from '../cloud/collaboration/conversation.mjs';
import {dispatchOne,maintenance} from '../cloud/collaboration/dispatcher.mjs';
import {seal} from '../cloud/collaboration/security.mjs';
import {pendingMemberActivity,turnNotification,waitingLabel} from '../shared/chat-activity.mjs';

const base=Date.parse('2026-11-06T05:00:00Z'),at=s=>new Date(base+s*1000).toISOString(),secret='isolated-grok-receipt';
async function setup(t){
 const f=await fixture(t);let seq=0;const calls=[];
 const send=(type,args={},actor={owner:true},seconds=0)=>conversationCommand(f.repo,f.identity,actor,{type,requestId:'receipt-'+(++seq),...args},at(seconds));
 const group=await send('channel.create',{name:'receipt recovery',memberIds:['grok'],coordinatorId:'grok'});
 await f.repo.transact('receipt-config',{},async tx=>{const c=await tx.get('connection','grok');tx.put('connection',{...c,transport:'grok-webhook',credentials:await seal({url:'https://api2.cursor.sh/automations/webhook/receipt-fixture',token:'crsr_isolated_fixture'},secret)});});
 const fetcher=async(_url,init)=>{calls.push(JSON.parse(init.body));return new Response('{}',{status:200});};
 const post=(body,seconds=0)=>send('channel.post',{channelId:group.id,body,mentions:['grok']},{owner:true},seconds);
 const notice=m=>f.repo.get('outbox',`notice_turn_${m.id}_grok`);
 const tick=seconds=>maintenance(f.repo,f.identity,{ADMIN_KEY:secret},fetcher,at(seconds));
 return{...f,send,group,calls,fetcher,post,notice,tick};
}

test('accepted without claim retries the same notice; delayed receivers claim all supplements once',async t=>{
 const f=await setup(t),one=await f.post('原要求');await f.tick(0);
 const n=await f.notice(one),two=await f.post('补充要求',1);await f.tick(1);
 assert.equal((await f.notice(two)).status,'coalesced');assert.equal(f.calls.length,1);
 await f.tick(119);assert.equal(f.calls.length,1);
 await Promise.all([f.tick(120),f.tick(120)]);assert.equal(f.calls.length,2);
 assert.equal(f.calls[0].delivery_id,f.calls[1].delivery_id);
 assert.notEqual(f.calls[0].receive.arguments.requestId,f.calls[1].receive.arguments.requestId,'a cached busy/empty receipt must not poison the retry');
 const c=await claimConversation(f.repo,f.identity,{memberId:'grok'},{requestId:'real-receiver',stepId:n.stepId},at(121));
 assert.deepEqual(new Set(c.input.triggerMessageIds),new Set([one.id,two.id]));
 await f.tick(250);assert.equal(f.calls.length,2,'never retry an execution already claimed');
 await assert.rejects(()=>claimConversation(f.repo,f.identity,{memberId:'grok'},{requestId:'duplicate-platform-run',stepId:n.stepId},at(251)),e=>e.code==='turn_unavailable');
});

test('an exhausted unclaimed batch exposes every held message and no longer absorbs new messages',async t=>{
 const f=await setup(t),one=await f.post('原要求');await f.tick(0);
 const two=await f.post('第二句',1);await f.tick(1);
 await f.tick(120);await f.tick(240);await f.tick(360);
 assert.equal(f.calls.length,3);
 for(const m of [one,two]){const n=await f.notice(m),turn=await f.repo.get('channel_turn',n.stepId);assert.equal(n.status,'unclaimed');assert.equal(turn.status,'stalled');assert.match(turn.reason,/成员仍未接收/);}
 await f.tick(480);assert.equal(f.calls.length,3,'no endless paid platform invocations');
 const fresh=await f.post('新的明确请求',481);await f.tick(481);
 assert.equal(f.calls.length,4);assert.equal((await f.notice(fresh)).status,'accepted');
 const c=await claimConversation(f.repo,f.identity,{memberId:'grok'},{requestId:'late-real-receiver',stepId:(await f.notice(fresh)).stepId},at(482));
 assert.deepEqual(new Set(c.input.triggerMessageIds),new Set([one.id,two.id,fresh.id]),'unclaimed messages remain available to the eventual receiver');
});

test('known busy resources postpone recovery without caching the busy result forever',async t=>{
 const f=await setup(t),m=await f.post('等待');await f.tick(0);
 await f.repo.transact('receipt-busy',{},async tx=>tx.put('resource',{id:'grok',status:'busy',turnId:'other-work'}));
 await f.tick(120);assert.equal(f.calls.length,1);
 await f.repo.transact('receipt-idle',{},async tx=>tx.put('resource',{id:'grok',status:'idle'}));
 await f.tick(180);assert.equal(f.calls.length,2);
 const n=await f.notice(m);assert.equal(n.unclaimedRetry,true);
});

test('unknown send results and historical stalled work are not automatically replayed',async t=>{
 const f=await setup(t),m=await f.post('保存');await f.tick(0);const n=await f.notice(m);
 await f.repo.transact('historical-unstarted',{},async tx=>{const turn=await tx.get('channel_turn',n.stepId);tx.put('channel_turn',{...turn,status:'stalled'});});
 await f.tick(120);assert.equal(f.calls.length,1);
 const other=await f.post('结果未知',121),row=await f.notice(other);
 await dispatchOne(f.repo,f.identity,row.id,{ADMIN_KEY:secret},async()=>{throw Error('connection reset');},at(121));
 await f.tick(122);assert.equal(f.calls.length,1);assert.equal((await f.notice(other)).status,'unclaimed');
});

test('platform acceptance is displayed as waiting for receipt, including coalesced messages',()=>{
 const t={id:'t',memberId:'grok',status:'ready'},root={id:'root',stepId:'other',status:'accepted'},child={id:'child',stepId:'t',status:'coalesced',coalescedInto:'root'};
 assert.equal(waitingLabel(turnNotification(t,[root,child])),'等待成员接收');
 assert.equal(pendingMemberActivity([t],[root,child])[0].label,'1 条消息等待成员接收');
 assert.match(pendingMemberActivity([t],[{...root,unclaimedRetry:true},child])[0].label,/尚未接收.*重新通知/);
});

test('targeted manual recovery does not restart another held request',async t=>{
 const f=await setup(t),one=await f.post('选择这一条'),two=await f.post('保留另一条');
 const a=await f.notice(one),b=await f.notice(two);
 await f.repo.transact('held-both',{},async tx=>{for(const n of [a,b]){const turn=await tx.get('channel_turn',n.stepId);tx.put('channel_turn',{...turn,status:'stalled'});}});
 await f.send('channel.continue',{channelId:f.group.id,turnId:a.stepId});
 assert.equal((await f.repo.get('channel_turn',a.stepId)).status,'ready');
 assert.equal((await f.repo.get('channel_turn',b.stepId)).status,'stalled');
});
