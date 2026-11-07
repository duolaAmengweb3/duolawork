import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand,claimConversation,readChannel} from '../cloud/collaboration/conversation.mjs';
import {withConversationContext} from '../cloud/collaboration/inbox.mjs';
import {COLLABORATION_GUIDANCE_VERSION} from '../shared/collaboration-guidance.mjs';

async function setup(t) {
 const f=await fixture(t);let seq=0;
 const send=(type,args={},actor={owner:true})=>conversationCommand(f.repo,f.identity,actor,{type,requestId:`guidance-${++seq}`,...args});
 const c=await send('channel.create',{name:'方案协作',memberIds:['grok','check','write'],coordinatorId:'grok'});
 return {...f,c,send};
}
test('shared guidance survives full inbox context and ordinary channel reads; direct answers and acknowledgements do not broadcast',async t=>{
 const f=await setup(t);
 const source=await f.send('channel.post',{channelId:f.c.id,body:'只讨论方案，不开发，不开会；已有结论就直接回答'});
 const claim=await claimConversation(f.repo,f.identity,{memberId:'grok'},{requestId:'guidance-claim',stepId:`turn_${source.id}_grok`});
 const full=await withConversationContext(f.repo,f.identity,{memberId:'grok'},claim);
 const view=await readChannel(f.repo,f.identity,{memberId:'check'},{channelId:f.c.id});
 assert.equal(full.input.collaboration.version,COLLABORATION_GUIDANCE_VERSION);
 assert.equal(view.collaboration.instruction,full.input.collaboration.instruction);
 assert.ok(full.input.coordinatorInstruction);
 assert.equal(view.collaboration.coordinatorInstruction,undefined);
 assert.equal(full.input.triggerMessages[0].body,source.body);
 const reply=await f.send('channel.post',{channelId:f.c.id,turnId:claim.turnId,body:'现有结论是先保留原会话，开发另排。',mentions:[]},{memberId:'grok'});
 const thanks=await f.send('channel.post',{channelId:f.c.id,replyTo:reply.id,body:'感谢补充。',mentions:[]},{memberId:'check'});
 assert.deepEqual(reply.recipientIds,[]);assert.deepEqual(thanks.recipientIds,[]);
 assert.equal((await f.repo.list('channel_turn')).filter(x=>x.status==='ready').length,0);
 for(const kind of ['channel_task','channel_doc','channel_meeting'])assert.equal((await f.repo.list(kind)).length,0);
});
test('all-member review is available without automatically starting a meeting or forcing acknowledgement rounds',async t=>{
 const f=await setup(t),source=await f.send('channel.post',{channelId:f.c.id,body:'所有成员独立提出不同证据，请在群里讨论'});
 const request=await f.send('channel.post',{channelId:f.c.id,replyTo:source.id,body:'请各自核对依据，指出不同事实；没有补充可记录原因。',mentionAll:true},{memberId:'grok'});
 assert.deepEqual(request.recipientIds,['check','write']);
 assert.equal((await f.repo.list('channel_meeting')).length,0);
 const claim=await claimConversation(f.repo,f.identity,{memberId:'check'},{requestId:'review-claim',stepId:`turn_${request.id}_check`});
 await f.send('channel.silent',{channelId:f.c.id,turnId:claim.turnId,reason:'本轮来源已逐项核对，没有额外证据'},{memberId:'check'});
 assert.notEqual((await f.repo.list('channel_coordination'))[0].status,'completed');
 assert.equal((await f.repo.list('channel_turn')).filter(x=>x.memberId==='write'&&x.status==='ready').length,1);
});
test('planning Todo can name its future assignee without starting execution; later explicit dispatch remains possible and idempotent',async t=>{
 const f=await setup(t);
 const planned=await f.send('channel.task',{channelId:f.c.id,action:'create',title:'方案已定稿，开发另排',assigneeId:'check',notifyAssignee:false},{memberId:'grok'});
 assert.equal(planned.status,'todo');assert.equal(planned.assigneeId,'check');
 assert.equal((await f.repo.list('channel_turn')).length,0);
 const args={type:'channel.task',requestId:'authorized-dispatch',channelId:f.c.id,action:'update',taskId:planned.id,expectedVersion:planned.version,notifyAssignee:true,progress:'用户已授权，开始执行'};
 const dispatched=await conversationCommand(f.repo,f.identity,{memberId:'grok'},args);
 const retry=await conversationCommand(f.repo,f.identity,{memberId:'grok'},args);
 assert.equal(dispatched.notificationMessageId,retry.notificationMessageId);
 assert.equal((await f.repo.list('channel_turn')).filter(x=>x.memberId==='check').length,1);
});
