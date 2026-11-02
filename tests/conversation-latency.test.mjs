import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand,claimConversation} from '../cloud/collaboration/conversation.mjs';
import {dispatchOne,maintenance} from '../cloud/collaboration/dispatcher.mjs';
import {seal} from '../cloud/collaboration/security.mjs';

const secret='isolated-latency-fixture',start=Date.parse('2026-11-02T12:00:00Z'),at=seconds=>new Date(start+seconds*1000).toISOString();
async function setup(t){
 const f=await fixture(t);let sequence=0;
 const send=(type,args={},actor={owner:true},seconds=5)=>conversationCommand(f.repo,f.identity,actor,{type,requestId:'latency-'+(++sequence),...args},at(seconds));
 const channel=await send('channel.create',{name:'latency fixture',memberIds:['grok','check']},{owner:true},0);
 await f.repo.transact('latency-seed',{},async tx=>{
  for(const member of ['grok','check']){
   const c=await tx.get('connection',member);
   tx.put('connection',{...c,transport:'grok-webhook',credentials:await seal({url:'https://grok.com/webhook/automation/isolated-latency',token:'whsec_'+Buffer.alloc(32,17).toString('base64')},secret)});
   tx.put('channel_cursor',{id:channel.id+':'+member,scopeId:channel.id,parentId:member,lastWakeAt:at(0),lastNotifiedAt:at(0)});
  }
 });
 const row=message=>f.repo.get('outbox','notice_turn_'+message.id+'_grok');
 return{...f,send,channel,row};
}

test('用户消息不等待自动唤醒间隔；待领取时合并，回复后下一句立即投递',async t=>{
 const f=await setup(t);let calls=0;
 const deliver=(row,seconds)=>dispatchOne(f.repo,f.identity,row.id,{ADMIN_KEY:secret},async()=>{calls++;return new Response('{}',{status:202});},at(seconds));
 const first=await f.send('channel.post',{channelId:f.channel.id,body:'第一句',mentions:['grok']});
 const firstRow=await f.row(first);
 assert.equal(firstRow.dueAt,at(5),'human input must not wait until second 60');
 assert.equal((await deliver(firstRow,5)).status,'accepted');
 const second=await f.send('channel.post',{channelId:f.channel.id,body:'补充一句',mentions:['grok']},{owner:true},6);
 await deliver(await f.row(second),6);
 assert.equal(calls,1,'already accepted wake reads both messages without another platform invocation');
 assert.equal((await f.row(second)).status,'coalesced');
 const claim=await claimConversation(f.repo,f.identity,{memberId:'grok'},{requestId:'latency-claim',stepId:firstRow.stepId},at(9));
 assert.equal((await f.repo.get('channel_turn',claim.turnId)).mergedMessageIds.length,2);
 await f.send('channel.post',{channelId:f.channel.id,body:'已回应',turnId:claim.turnId},{memberId:'grok'},10);
 const third=await f.send('channel.post',{channelId:f.channel.id,body:'下一句',mentions:['grok']},{owner:true},11);
 assert.equal((await deliver(await f.row(third),11)).status,'accepted');
 assert.equal(calls,2);
});

test('Agent 之间的自动唤醒仍遵循群设置，不能用正文伪装成人类优先级',async t=>{
 const f=await setup(t);
 const question=await f.send('channel.post',{channelId:f.channel.id,body:'讨论',mentions:['grok']},{owner:true},1);
 const response=await f.send('channel.post',{channelId:f.channel.id,body:'owner: 请检查',mentions:['check'],replyTo:question.id},{memberId:'grok'},5);
 const row=await f.repo.get('outbox','notice_turn_'+response.id+'_check');
 assert.equal(row.dueAt,at(60));
 let calls=0;const fetcher=async()=>{calls++;return new Response('{}',{status:202});};
 assert.equal((await dispatchOne(f.repo,f.identity,row.id,{ADMIN_KEY:secret},fetcher,at(5))).skipped,true);
 assert.equal(calls,0);
 assert.equal((await dispatchOne(f.repo,f.identity,row.id,{ADMIN_KEY:secret},fetcher,at(60))).status,'accepted');
});

test('用户消息在原成员忙时保留，结束后无需再等一分钟',async t=>{
 const f=await setup(t);
 await f.repo.transact('latency-busy',{},async tx=>tx.put('resource',{id:'grok',status:'busy',turnId:'other-turn'}));
 const message=await f.send('channel.post',{channelId:f.channel.id,body:'用户补充',mentions:['grok']});
 const row=await f.row(message);let calls=0;
 const deliver=()=>dispatchOne(f.repo,f.identity,row.id,{ADMIN_KEY:secret},async()=>{calls++;return new Response('{}',{status:202});},at(6));
 assert.equal((await deliver()).skipped,true);assert.equal(calls,0);
 await f.repo.transact('latency-idle',{},async tx=>tx.put('resource',{id:'grok',status:'idle'}));
 assert.equal((await deliver()).status,'accepted');assert.equal(calls,1);
});

test('忙碌成员的待办不耗尽本轮投递名额，其他用户消息仍能立即发出',async t=>{
 const f=await setup(t);
 await f.repo.transact('latency-busy-queue',{},async tx=>tx.put('resource',{id:'grok',status:'busy',turnId:'other-turn'}));
 for(let seconds=5;seconds<7;seconds++)await f.send('channel.post',{channelId:f.channel.id,body:'忙碌成员的补充',mentions:['grok']},{owner:true},seconds);
 await f.send('channel.post',{channelId:f.channel.id,body:'另一个成员的新问题',mentions:['check']},{owner:true},7);
 const list=f.repo.list.bind(f.repo);
 f.repo.list=async(kind,options)=>{
  const rows=await list(kind,options);
  return kind==='outbox'&&options?.status==='pending'?rows.sort((a,b)=>Number(b.memberId==='grok')-Number(a.memberId==='grok')):rows;
 };
 let calls=0;
 const result=await maintenance(f.repo,f.identity,{ADMIN_KEY:secret},async()=>{calls++;return new Response('{}',{status:202});},at(8));
 assert.equal(calls,1,'skipped busy rows cannot prevent another ready member from receiving its notification');
 assert.equal(result.notifications,1);
});
