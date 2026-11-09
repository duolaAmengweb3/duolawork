import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand,claimConversation} from '../cloud/collaboration/conversation.mjs';
import {eventMethod} from '../cloud/collaboration/events.mjs';
import {dispatchOne} from '../cloud/collaboration/dispatcher.mjs';

const secret='event-recovery-test-only',signing='whsec_'+Buffer.alloc(32,7).toString('base64');
async function setup(t){
 const f=await fixture(t),events=[];let n=0;
 await f.repo.transact('event-connection',{},async tx=>{const c=await tx.get('connection','grok');tx.put('connection',{...c,transport:'dots-events'});return{};});
 const send=(type,args={},actor={owner:true})=>conversationCommand(f.repo,f.identity,actor,{type,requestId:'event-recovery-'+ ++n,...args});
 const channel=await send('channel.create',{name:'Subscription recovery fixture',memberIds:['grok'],coordinatorId:'grok'});
 const fetcher=async(url,options)=>{const body=JSON.parse(options.body);if(body.type==='verification')return Response.json({challenge:body.challenge});events.push({url,body});return Response.json({});};
 const subscribe=(name,method='events/subscribe')=>eventMethod(f.repo,'grok',method,{name:'work.ready',arguments:{member_id:'grok'},delivery:{mode:'webhook',url:'https://chatgpt.com/fixture-'+name,secret:signing}},secret,fetcher);
 const post=async body=>{const m=await send('channel.post',{channelId:channel.id,body,mentions:['grok']});return{message:m,turnId:`turn_${m.id}_grok`,noticeId:`notice_turn_${m.id}_grok`};};
 const dispatch=notice=>dispatchOne(f.repo,f.identity,notice.noticeId,{ADMIN_KEY:secret},fetcher);
 return {...f,send,channel,fetcher,events,subscribe,post,dispatch};
}
test('a replacement subscription receives still-unclaimed work; old callback acceptance must not strand it',async t=>{
 const f=await setup(t);await f.subscribe('old');const a=await f.post('Exact pending requirement');await f.dispatch(a);
 const b=await f.post('A later supplement');await f.dispatch(b);assert.equal((await f.repo.get('outbox',b.noticeId)).status,'coalesced');
 await f.subscribe('old','events/unsubscribe');const replacement=await f.subscribe('new');await f.dispatch(a);
 assert.equal(f.events.filter(e=>e.url.endsWith('fixture-new')).length,1);
 assert.equal((await f.repo.get('event_delivery',a.noticeId+':'+replacement.id)).status,'accepted');
 assert.equal((await f.repo.get('channel_turn',a.turnId)).status,'ready','a callback cannot invent a claim');
 assert.equal((await f.repo.get('channel_message',a.message.id)).body,'Exact pending requirement');
 assert.equal((await f.repo.get('channel_message',b.message.id)).body,'A later supplement');
 await f.subscribe('new');await f.dispatch(a);assert.equal(f.events.filter(e=>e.url.endsWith('fixture-new')).length,1,'TTL refresh and dispatch retries do not duplicate the event');
});
test('the first valid subscription immediately wakes work waiting for a subscription, without waiting for its retry timer',async t=>{
 const f=await setup(t),a=await f.post('Waiting for a receiver');await f.dispatch(a);
 assert.equal((await f.repo.get('outbox',a.noticeId)).status,'waiting_subscription');
 await f.subscribe('first');await f.dispatch(a);assert.equal(f.events.length,1);assert.equal((await f.repo.get('channel_turn',a.turnId)).status,'ready');
});
test('subscription replacement never restarts claimed execution or another member work',async t=>{
 const f=await setup(t);await f.subscribe('old');const a=await f.post('Already claimed work');await f.dispatch(a);
 const claim=await claimConversation(f.repo,f.identity,{memberId:'grok'},{requestId:'claim-original-event',stepId:a.turnId});
 const before=await f.repo.get('channel_turn',a.turnId);await f.subscribe('new');await f.dispatch(a);
 const after=await f.repo.get('channel_turn',a.turnId);assert.equal(after.lease,claim.lease);assert.equal(after.status,'active');assert.equal(after.revision,before.revision);assert.equal(f.events.length,1);
});
test('replacement retires an obsolete task notice instead of replaying it, and leaves other members untouched',async t=>{
 const f=await setup(t);await f.subscribe('old');
 const task=await f.send('channel.task',{channelId:f.channel.id,action:'create',title:'Canceled historical task',assigneeId:'grok',notifyAssignee:true});
 const notice={turnId:`turn_${task.notificationMessageId}_grok`,noticeId:`notice_turn_${task.notificationMessageId}_grok`};await f.dispatch(notice);
 await f.repo.transact('legacy-cancel-and-unrelated',{},async tx=>{const current=await tx.get('channel_task',task.id);tx.put('channel_task',{...current,status:'canceled',version:current.version+1});tx.put('outbox',{id:'other-receiver',memberId:'check',scopeId:f.channel.id,parentId:f.channel.id,transport:'dots-events',configVersion:1,status:'accepted'});return{};});
 const other=await f.repo.get('outbox','other-receiver');await f.subscribe('new');
 assert.equal((await f.repo.get('channel_turn',notice.turnId)).status,'removed');assert.equal((await f.repo.get('outbox',notice.noticeId)).status,'canceled');
 assert.deepEqual(await f.repo.get('outbox','other-receiver'),other);assert.equal(f.events.length,1);
});
test('a new subscription does not requeue a notice from an older connection configuration',async t=>{
 const f=await setup(t);await f.subscribe('old');const a=await f.post('Old connection notice');await f.dispatch(a);
 await f.repo.transact('connection-changed',{},async tx=>{const c=await tx.get('connection','grok');tx.put('connection',{...c,configVersion:c.configVersion+1});return{};});
 await f.subscribe('new');assert.equal((await f.repo.get('outbox',a.noticeId)).status,'accepted');assert.equal(f.events.length,1);
});
test('subscription recovery covers all pages of still-unclaimed work without a fixed conversation count',async t=>{
 const f=await setup(t),source=await f.post('Preserved requirement');await f.subscribe('old');await f.dispatch(source);
 await f.repo.transact('queued-pages',{},async tx=>{const template=await tx.get('outbox',source.noticeId);for(let i=0;i<501;i++){const stepId='paged-turn-'+String(i).padStart(4,'0');tx.put('channel_turn',{id:stepId,scopeId:f.channel.id,parentId:'grok',memberId:'grok',messageId:source.message.id,status:'ready'});tx.put('outbox',{...template,id:'paged-notice-'+String(i).padStart(4,'0'),stepId,status:'accepted'});}return{};});
 await f.subscribe('new');assert.equal((await f.repo.get('outbox','paged-notice-0500')).status,'pending');assert.equal((await f.repo.get('channel_turn','paged-turn-0500')).status,'ready');
});
test('new messages cannot coalesce behind a historical receipt belonging only to a replaced receiver',async t=>{
 const f=await setup(t);await f.subscribe('old');const a=await f.post('Historical pending source');await f.dispatch(a);
 await f.subscribe('old','events/unsubscribe');await f.subscribe('new');
 // A pre-upgrade accepted record can survive a receiver replacement. No receipt
 // exists for that receiver; a newly published message must still reach it.
 await f.repo.transact('old-version-accepted-state',{},async tx=>{const notice=await tx.get('outbox',a.noticeId);tx.put('outbox',{...notice,status:'accepted'});return{};});
 const b=await f.post('New input after receiver replacement');await f.dispatch(b);
 assert.equal(f.events.filter(e=>e.url.endsWith('fixture-new')).length,1);
 assert.equal((await f.repo.get('outbox',b.noticeId)).status,'accepted');assert.equal((await f.repo.get('channel_turn',a.turnId)).status,'ready');
 const c=await f.post('Healthy coalesced supplement');await f.dispatch(c);assert.equal((await f.repo.get('outbox',c.noticeId)).status,'coalesced');assert.equal(f.events.filter(e=>e.url.endsWith('fixture-new')).length,1);
});
test('an inconsistent ready record with a previous lease cannot absorb newly published work',async t=>{
 const f=await setup(t);await f.subscribe('current');const a=await f.post('Previously leased source');await f.dispatch(a);
 await f.repo.transact('historical-ready-with-lease',{},async tx=>{const turn=await tx.get('channel_turn',a.turnId);tx.put('channel_turn',{...turn,lease:'existing-lease',claimedAt:tx.now});return{};});
 const before=await f.repo.get('channel_turn',a.turnId),b=await f.post('Independent new input');await f.dispatch(b);
 assert.equal((await f.repo.get('outbox',b.noticeId)).status,'accepted');assert.deepEqual(await f.repo.get('channel_turn',a.turnId),before);assert.equal(f.events.length,2);
});
