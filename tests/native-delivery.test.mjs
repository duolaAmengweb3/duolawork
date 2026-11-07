import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand,conversationWork,receiveDelivery,readChannel} from '../cloud/collaboration/conversation.mjs';
import {putExecutionBinding} from '../cloud/collaboration/execution-bindings.mjs';
import {digest} from '../cloud/collaboration/repository.mjs';
import {pendingTurnState} from '../shared/chat-activity.mjs';

async function setup(t){const f=await fixture(t);let n=0;const send=(type,args)=>conversationCommand(f.repo,f.identity,{owner:true},{type,requestId:'receipt-'+ ++n,...args});
 const channel=await send('channel.create',{name:'Delivery fences',memberIds:['grok','check']});
 const message=await send('channel.post',{channelId:channel.id,body:'Keep this full original requirement and correction.',mentions:['grok']});
 const bind=async sessionId=>f.repo.transact('bind-'+ ++n,{},async tx=>putExecutionBinding(tx,{id:'grok:'+channel.id,parentId:'grok',scopeId:channel.id,sessionKey:await digest(sessionId),status:'active'}));await bind('native-one');
 const work=(await conversationWork(f.repo,f.identity,'grok',{delivery:true}))[0];
 const input={turnId:work.stepId,sessionId:'native-one',attempt:0,phase:'received',sourceVersion:1};
 const receipt=(extra={},actor={memberId:'grok'})=>receiveDelivery(f.repo,actor,{requestId:'receive-'+ ++n,...input,...extra});
 return{...f,channel,message,bind,work,receipt,input};
}
test('a durable receive is not a model start or a lease; receipts cannot cross members, sessions or recovery attempts',async t=>{
 const f=await setup(t);assert.equal(f.work.delivery.message.body,f.message.body);
 await assert.rejects(f.receipt({}, {memberId:'check'}),e=>e.code==='forbidden');
 await assert.rejects(f.receipt({sessionId:'wrong'}),e=>e.code==='session_changed');
 await assert.rejects(f.receipt({attempt:1}),e=>e.code==='stale_delivery');
 await assert.rejects(f.receipt({phase:'started'}),e=>e.code==='receipt_required');
 await f.receipt();let turn=await f.repo.get('channel_turn',f.work.stepId);assert.equal(turn.status,'ready');assert.equal(turn.claimedAt,undefined);assert.equal(turn.nativeStartedAt,undefined);
 assert.equal(pendingTurnState(turn).label,'消息已接收');
 await f.receipt({phase:'accepted'});turn=await f.repo.get('channel_turn',f.work.stepId);assert.equal(pendingTurnState(turn).label,'原对话已收到');
 await f.receipt({phase:'started'});turn=await f.repo.get('channel_turn',f.work.stepId);assert.equal(pendingTurnState(turn).label,'已开始处理');assert.equal(turn.status,'ready');
});
test('lost receipt ACK is replayable; binding changes clear stale status and reject late old-session receipts',async t=>{
 const f=await setup(t),args={...f.input,requestId:'lost-ack'};
 const first=await receiveDelivery(f.repo,{memberId:'grok'},args);assert.deepEqual(await receiveDelivery(f.repo,{memberId:'grok'},args),first);
 await f.bind('native-two');assert.equal((await f.repo.get('channel_turn',f.work.stepId)).connectorReceivedAt,undefined);
 await assert.rejects(receiveDelivery(f.repo,{memberId:'grok'},args),e=>e.code==='session_changed');
 await f.receipt({sessionId:'native-two'});const changed=await f.repo.get('channel_turn',f.work.stepId);assert.equal(changed.receiptSessionKey,await digest('native-two'));
 await f.repo.transact('completed',{},tx=>tx.put('channel_turn',{...changed,status:'done'}));
 assert.equal((await f.receipt({sessionId:'native-two',phase:'started'})).applied,false);assert.equal((await f.repo.get('channel_turn',f.work.stepId)).nativeStartedAt,undefined);
});
test('fast chat projection excludes materials without losing messages, addressing, receipts or access checks',async t=>{
 const f=await setup(t);await f.receipt();
 await f.repo.transact('heavy',{},tx=>tx.put('channel_doc',{id:'doc',scopeId:f.channel.id,body:'x'.repeat(120000),status:'active'}));
 const fast=await readChannel(f.repo,f.identity,{owner:true},{channelId:f.channel.id,view:'chat'}),full=await readChannel(f.repo,f.identity,{owner:true},{channelId:f.channel.id});
 assert.deepEqual(fast.messages,full.messages);assert.deepEqual(fast.activity,full.activity);assert.equal(fast.documents,undefined);assert.equal(full.documents.length,1);
 assert.ok(JSON.stringify(fast).length<JSON.stringify(full).length/10);
 await assert.rejects(readChannel(f.repo,f.identity,{memberId:'write'},{channelId:f.channel.id,view:'chat'}),e=>e.code==='forbidden');
});
test('cached successful receipt cannot bypass a later message edit, retry generation or connection revocation',async t=>{
 const f=await setup(t),args={...f.input,requestId:'same-receipt'};await receiveDelivery(f.repo,{memberId:'grok'},args);
 const message=await f.repo.get('channel_message',f.message.id);await f.repo.transact('edit-source',{},tx=>tx.put('channel_message',{...message,version:2,body:'corrected requirement'}));
 await assert.rejects(receiveDelivery(f.repo,{memberId:'grok'},args),e=>e.code==='message_changed');
 await f.receipt({sourceVersion:2});const turn=await f.repo.get('channel_turn',f.work.stepId);await f.repo.transact('retry-generation',{},tx=>tx.put('channel_turn',{...turn,recoveryCount:1}));
 await assert.rejects(receiveDelivery(f.repo,{memberId:'grok'},{...args,sourceVersion:2}),e=>e.code==='stale_delivery');
 const fresh={...args,requestId:'new-generation',sourceVersion:2,attempt:1};await receiveDelivery(f.repo,{memberId:'grok'},fresh);
 const connection=await f.repo.get('connection','grok');await f.repo.transact('disconnect',{},tx=>tx.put('connection',{...connection,status:'disconnected'}));
 await assert.rejects(receiveDelivery(f.repo,{memberId:'grok'},fresh),e=>e.code==='disconnected');
});
