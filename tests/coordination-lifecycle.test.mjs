import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand,claimConversation,readChannel} from '../cloud/collaboration/conversation.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';
import {notificationRecipients} from '../shared/message-recipients.mjs';
async function setup(t){const f=await fixture(t);let n=0;const send=(type,args,actor={owner:true})=>conversationCommand(f.repo,f.identity,actor,{type,requestId:`life-${++n}`,...args});const c=await send('channel.create',{name:'跟进',coordinatorId:'grok',memberIds:['grok','check','write']});return{...f,c,send};}
const actor=memberId=>({memberId});
const record=f=>f.repo.list('channel_coordination').then(x=>x[0]);
test('peer question and result return through A-B-C without waking the coordinator at every step',async t=>{
 const f=await setup(t),root=await f.send('channel.post',{channelId:f.c.id,body:'请核查方案'});
 const a=await f.send('channel.post',{channelId:f.c.id,replyTo:root.id,body:'B 请核对',mentions:['check']},actor('grok'));
 const b=await f.send('channel.post',{channelId:f.c.id,replyTo:a.id,body:'C 请解释来源 v3',mentions:['write'],purpose:'question'},actor('check'));
 assert.deepEqual(b.recipientIds,['write']);
 const c=await f.send('channel.post',{channelId:f.c.id,replyTo:b.id,body:'来源 v3 有以下差异',purpose:'result'},actor('write'));
 assert.deepEqual(c.recipientIds,['check']);assert.equal((await f.repo.list('coordination_event')).length,0);
 const answer=await f.send('channel.post',{channelId:f.c.id,replyTo:a.id,body:'核验结果已包含 C 提供的差异',purpose:'result'},actor('check'));
 assert.deepEqual(answer.recipientIds,['grok']);assert.equal((await f.repo.list('coordination_event')).length,1);
 const acknowledgement=await f.send('channel.post',{channelId:f.c.id,replyTo:a.id,body:'感谢整理',purpose:'message',mentions:[]},actor('check'));
 assert.deepEqual(acknowledgement.recipientIds,[]);
 assert.equal((await f.repo.list('coordination_event')).length,1);
});
test('native coordinator can open a scoped real request without fabricating an owner message',async t=>{
 const f=await setup(t),request=await f.send('channel.post',{channelId:f.c.id,body:'按原工作环境的交办核查文档差异',purpose:'request',mentions:['check']},actor('grok'));
 const r=await record(f);assert.equal(r.sourceMessageId,request.id);
 assert.equal(request.authorId,'grok');assert.equal((await f.repo.list('channel_message')).some(x=>x.authorId==='owner'),false);
 const result=await f.send('channel.post',{channelId:f.c.id,replyTo:request.id,body:'核查结果',purpose:'result'},actor('check'));
 assert.deepEqual(result.recipientIds,['grok']);
 await assert.rejects(()=>f.send('channel.post',{channelId:f.c.id,body:'没有上下文的自主派发',purpose:'request',mentions:['grok']},actor('write')),e=>e.code==='context_required');
});
test('edited owner requirement invalidates old closure and labels late replies without deleting work',async t=>{
 const f=await setup(t),root=await f.send('channel.post',{channelId:f.c.id,body:'核对 v1'});
 const request=await f.send('channel.post',{channelId:f.c.id,replyTo:root.id,body:'按 v1 核对',mentions:['check']},actor('grok'));
 const r=await record(f),claim=await claimConversation(f.repo,f.identity,actor('check'),{requestId:'old-work',stepId:`turn_${request.id}_check`});
 await f.send('channel.message.edit',{channelId:f.c.id,messageId:root.id,expectedVersion:1,body:'更正：改核对 v2'});
 assert.equal((await record(f)).requirementVersion,2);
 await assert.rejects(()=>f.send('channel.coordination',{channelId:f.c.id,sourceMessageId:root.id,action:'close',expectedVersion:r.version,summary:'旧结论完成'},actor('grok')),e=>e.code==='version_conflict');
 const late=await f.send('channel.post',{channelId:f.c.id,turnId:claim.turnId,body:'这是 v1 的结果',purpose:'result'},actor('check'));
 assert.equal(late.obsoleteRequirement,true);assert.equal(late.requirementVersion,1);
 const current=await record(f);assert.notEqual(current.status,'completed');
 assert.ok((await f.repo.list('channel_turn')).some(x=>x.memberId==='check'&&x.requirementVersion===2&&x.status==='ready'));
});
test('stop retains true execution outcomes, removes unstarted work and delivers to offline affected participants',async t=>{
 const f=await setup(t),root=await f.send('channel.post',{channelId:f.c.id,body:'核查'});
 const request=await f.send('channel.post',{channelId:f.c.id,replyTo:root.id,body:'分头核对',mentions:['check','write']},actor('grok'));
 const claim=await claimConversation(f.repo,f.identity,actor('check'),{requestId:'active-check',stepId:`turn_${request.id}_check`});
 await f.repo.transact('offline-receiver',{},async tx=>{const c=await tx.get('connection','check');tx.put('connection',{...c,status:'disconnected'});return {};});
 const r=await record(f),stopped=await f.send('channel.coordination',{channelId:f.c.id,action:'cancel',sourceMessageId:root.id,expectedVersion:r.version,summary:'用户停止核查'},actor('grok'));
 assert.deepEqual(Object.fromEntries(stopped.interruption.map(x=>[x.memberId,x.state])),{check:'outcome_unknown',write:'not_started'});
 assert.equal((await f.repo.get('channel_turn',`turn_${request.id}_write`)).status,'removed');
 assert.equal((await f.repo.get('channel_turn',claim.turnId)).status,'active');
 assert.ok((await f.repo.list('channel_turn')).some(t=>t.memberId==='check'&&t.id!==claim.turnId&&['ready','unavailable'].includes(t.status)));
 await f.repo.transact('receiver-back',{},async tx=>{const c=await tx.get('connection','check');tx.put('connection',{...c,status:'verified'});return {};});
 const late=await f.send('channel.post',{channelId:f.c.id,turnId:claim.turnId,body:'停止前已执行，外部结果待核对',purpose:'result',executionOutcome:'outcome_unknown'},actor('check'));
 assert.deepEqual(late.recipientIds,['grok']);assert.equal((await record(f)).status,'canceled');
 for(const executionOutcome of ['awaiting_confirmation','result']){
  const update=await f.send('channel.post',{channelId:f.c.id,replyTo:request.id,body:'实测状态更新：'+executionOutcome,purpose:'result',executionOutcome},actor('check'));
  const observation=(await record(f)).interruption.find(x=>x.memberId==='check');assert.equal(observation.state,executionOutcome);assert.equal(observation.messageId,update.id);
 }
 await assert.rejects(async()=>f.send('channel.coordination',{channelId:f.c.id,action:'close',sourceMessageId:root.id,expectedVersion:(await record(f)).version,summary:'迟到回执当作完成'},actor('grok')),e=>e.code==='request_canceled');
});
test('cached tool envelope can follow new requirements; server rejects duplicate claims, including after coordinator transfer',async t=>{
 const f=await setup(t),root=await f.send('channel.post',{channelId:f.c.id,body:'核对'});
 const request=await f.send('channel.post',{channelId:f.c.id,replyTo:root.id,body:'请核对',mentions:['check']},actor('grok'));
 const claimArgs={requestId:'one-claim',stepId:`turn_${request.id}_check`};
 const claim=await claimConversation(f.repo,f.identity,actor('check'),claimArgs);
 const retry=await claimConversation(f.repo,f.identity,actor('check'),claimArgs);assert.equal(retry.lease,claim.lease);
 await assert.rejects(()=>claimConversation(f.repo,f.identity,actor('check'),{...claimArgs,requestId:'duplicate-wake'}),e=>e.code==='turn_unavailable');
 await f.send('channel.post',{channelId:f.c.id,turnId:claim.turnId,body:'原始核验结果'},actor('check'));
 const old=await record(f);await f.send('channel.update',{channelId:f.c.id,coordinatorId:'write'});
 const c=await record(f);
 const read=await callTool(f.repo,f.identity,actor('write'),'post_message',{requestId:'cached-coordinate',channelId:f.c.id,body:'HUB_SHARED_TOOL_V1\n'+JSON.stringify({name:'coordinate',arguments:{channelId:f.c.id,sourceMessageId:root.id,action:'read'}})});
 assert.equal(read.version,c.version);
 await assert.rejects(()=>f.send('channel.coordination',{channelId:f.c.id,action:'close',sourceMessageId:root.id,expectedVersion:old.version,summary:'旧负责人覆盖'},actor('grok')),e=>e.code==='forbidden');
 assert.equal((await f.repo.list('channel_turn')).filter(x=>x.coordinationFeedback&&x.status==='ready'&&x.memberId==='write').length,1);
});
test('notification display is derived from actual receipts and rejects invalid peers rather than silently dropping them',async t=>{
 const f=await setup(t),root=await f.send('channel.post',{channelId:f.c.id,body:'核对'});
 const attribution=await f.send('channel.post',{channelId:f.c.id,replyTo:root.id,body:'@check 的资料已看过，感谢。',mentions:[],purpose:'message'},actor('grok'));
 assert.deepEqual(notificationRecipients(attribution).ids,[]);
 assert.equal(notificationRecipients({body:'@全员'}).known,false);
 await assert.rejects(()=>f.send('channel.post',{channelId:f.c.id,replyTo:root.id,body:'请核查',mentions:['outsider']},actor('grok')),e=>e.code==='invalid_mention');
 await f.send('channel.update',{channelId:f.c.id,coordinatorId:null});
 await assert.rejects(()=>f.send('channel.post',{channelId:f.c.id,body:'无负责人'}),e=>e.code==='recipient_required');
 assert.equal((await readChannel(f.repo,f.identity,{owner:true},{channelId:f.c.id})).messages.filter(x=>x.body==='无负责人').length,0);
});

test('cached post_message supports new addressing semantics without catalog refresh or cross-channel escape',async t=>{
 const f=await setup(t),root=await f.send('channel.post',{channelId:f.c.id,body:'核查方案'});
 const args={requestId:'cached-purpose',channelId:f.c.id,body:'HUB_SHARED_TOOL_V1\n'+JSON.stringify({name:'post_message',arguments:{channelId:f.c.id,replyTo:root.id,body:'感谢 @check 的已有记录',mentions:[],purpose:'message'}})};
 const reply=await callTool(f.repo,f.identity,actor('grok'),'post_message',args);
 assert.deepEqual(reply.recipientIds,[]);assert.equal(reply.purpose,'message');
 const again=await callTool(f.repo,f.identity,actor('grok'),'post_message',args);assert.equal(reply.id,again.id);
 const other=await f.send('channel.create',{name:'另一群',memberIds:['grok'],coordinatorId:'grok'});
 await assert.rejects(()=>callTool(f.repo,f.identity,actor('grok'),'post_message',{...args,requestId:'escape',body:'HUB_SHARED_TOOL_V1\n'+JSON.stringify({name:'post_message',arguments:{channelId:other.id,body:'越界',purpose:'request'}})}),e=>e.code==='forbidden');
});
