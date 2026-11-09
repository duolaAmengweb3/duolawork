import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand} from '../cloud/collaboration/conversation.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';
import {eventMethod} from '../cloud/collaboration/events.mjs';
import {dispatchOne,maintenance} from '../cloud/collaboration/dispatcher.mjs';
import {seal} from '../cloud/collaboration/security.mjs';
const secret='isolated-receiver-recovery',signing='whsec_'+Buffer.alloc(32,21).toString('base64');
const base=Date.parse('2026-11-09T15:00:00Z'),at=s=>new Date(base+s*1000).toISOString();
async function setup(t,transport='dots-events',receiverToken=signing){
 const f=await fixture(t),calls=[],accepted=new Set();let seq=0;
 const send=(type,args={},actor={owner:true},s=0)=>conversationCommand(f.repo,f.identity,actor,{type,requestId:'resilience-'+ ++seq,...args},at(s));
 const channel=await send('channel.create',{name:'Receiver resilience',memberIds:['grok','check'],coordinatorId:'check'});
 await f.repo.transact('configure-receiver',{},async tx=>{const c=await tx.get('connection','grok');tx.put('connection',{...c,transport,credentials:await seal({url:receiverToken.startsWith('whsec_')?'https://grok.com/webhook/automation/resilience':'https://api2.cursor.sh/automations/webhook/resilience',token:receiverToken},secret)});return{};},at(0));
 const fetcher=async(url,options)=>{const body=JSON.parse(options.body);if(body.type==='verification')return Response.json({challenge:body.challenge});calls.push({body,headers:options.headers});accepted.add(body.eventId||body.delivery_id);return new Response('{}',{status:transport==='grok-webhook'&&receiverToken.startsWith('whsec_')?202:200});};
 if(transport==='dots-events')await eventMethod(f.repo,'grok','events/subscribe',{name:'work.ready',arguments:{member_id:'grok'},delivery:{mode:'webhook',url:'https://chatgpt.com/receiver-resilience',secret:signing}},secret,fetcher,at(0));
 const post=async(body,s=0)=>{const message=await send('channel.post',{channelId:channel.id,body,mentions:['grok']},{owner:true},s);return{message,turnId:`turn_${message.id}_grok`,noticeId:`notice_turn_${message.id}_grok`};};
 const tick=s=>maintenance(f.repo,f.identity,{ADMIN_KEY:secret},fetcher,at(s));
 const receive=(source,requestId)=>callTool(f.repo,f.identity,{memberId:'grok'},'receive_messages',{requestId,channelId:channel.id,notificationTurnId:source.turnId,expectedMemberId:'grok'},{},{clock:()=>base+610000});
 return{...f,send,channel,calls,accepted,fetcher,post,tick,receive};
}
test('Dot accepted without a claim receives bounded new invitations, while HTTP retries retain event identity',async t=>{
 const f=await setup(t),a=await f.post('Preserve exact requirement');await f.tick(0);
 const first=f.calls[0].body;await f.tick(599);assert.equal(f.calls.length,1,'allow the native batching window');
 await Promise.all([f.tick(600),f.tick(600)]);assert.equal(f.calls.length,2);
 const second=f.calls[1].body;assert.notEqual(first.eventId,second.eventId);assert.equal(first.data.step_id,second.data.step_id);assert.equal(second.timestamp,at(600));
 assert.equal(f.accepted.size,2,'platform event deduplication must not suppress the later invitation');
 // Model the callback failing on the next invitation; its HTTP retry must use
 // the same event ID and must not invent another application invitation.
 await f.repo.transact('transient-callback',{},async tx=>{const n=await tx.get('outbox',a.noticeId);tx.put('outbox',{...n,status:'retry',dueAt:at(601)});const records=await tx.list('event_delivery',{parent:a.noticeId});for(const record of records)if(record.id===second.eventId)tx.put('event_delivery',{...record,status:'retry'});return{};},at(601));
 await dispatchOne(f.repo,f.identity,a.noticeId,{ADMIN_KEY:secret},f.fetcher,at(601));
 assert.equal(f.calls.at(-1).body.eventId,second.eventId);
 assert.deepEqual(f.calls.at(-1).body,second,'HTTP retries preserve the complete event, including its occurrence timestamp');
 const claim=await f.receive(a,'actual-dot-receiver');assert.equal(claim.status,'claimed');
 await f.tick(2000);assert.equal(f.calls.length,3,'never resend after the native Agent claims');
 assert.equal((await f.repo.get('channel_message',a.message.id)).body,'Preserve exact requirement');
});
test('a fresh supplement does not disappear behind an expired Dot callback and does not leave a second recovery running',async t=>{
 const f=await setup(t),a=await f.post('First request');await f.tick(0);
 const b=await f.post('Supplement while healthy',30);await f.tick(30);assert.equal(f.calls.length,1);
 const fresh=await f.post('New explicit request after ten minutes',601);
 await dispatchOne(f.repo,f.identity,fresh.noticeId,{ADMIN_KEY:secret},f.fetcher,at(601));
 assert.equal(f.calls.length,2);for(const n of [a,b])assert.equal((await f.repo.get('outbox',n.noticeId)).coalescedInto,fresh.noticeId);
 await f.tick(602);assert.equal(f.calls.length,2);
 const claim=await f.receive(fresh,'receive-all-supplements');assert.deepEqual(new Set(claim.input.triggerMessageIds),new Set([a.message.id,b.message.id,fresh.message.id]));
});
for(const transport of ['grok-webhook','dots-events'])test(`${transport}: leave and rejoin discards old invitations, keeps identity and accepts fresh work`,async t=>{
 const f=await setup(t,transport),a=await f.post('Before leaving');await f.tick(0);
 const connection=await f.repo.get('connection','grok');
 await f.repo.transact('old-short-wait',{},tx=>tx.put('channel_wait',{id:f.channel.id+':grok',scopeId:f.channel.id,parentId:'grok',status:'waiting',expiresAt:at(999),configVersion:connection.configVersion}));
 await f.send('channel.update',{channelId:f.channel.id,memberIds:['check']},{owner:true},1);
 assert.equal((await f.repo.get('outbox',a.noticeId)).status,'canceled');assert.equal((await f.repo.get('channel_wait',f.channel.id+':grok')).status,'finished');
 const obsolete=await f.receive(a,'late-old-invocation');assert.equal(obsolete.status,'obsolete');assert.equal(obsolete.input,undefined,'no former group history is exposed');
 await f.send('channel.update',{channelId:f.channel.id,memberIds:['grok','check']},{owner:true},2);
 assert.deepEqual(await f.repo.get('connection','grok'),connection,'rejoining must not recreate identity or credentials');
 const b=await f.post('Fresh work after rejoining',3);await f.tick(3);
 assert.equal(f.calls.length,2);assert.equal((await f.receive(a,'old-event-after-rejoin')).status,'obsolete');assert.equal((await f.repo.get('channel_turn',b.turnId)).status,'ready');
 const received=await f.receive(b,'fresh-original-receiver');assert.equal(received.status,'claimed');assert.deepEqual(received.input.triggerMessageIds,[b.message.id]);
 await f.tick(5000);assert.equal(f.calls.length,2);
});
test('Dot recovery never revives stalled execution, another configuration, a busy receiver, or a removed group',async t=>{
 const f=await setup(t),a=await f.post('Pending');await f.tick(0);
 await f.repo.transact('busy-native',{},tx=>tx.put('resource',{id:'grok',status:'busy'}));await f.tick(600);assert.equal(f.calls.length,1);
 await f.repo.transact('clear-native',{},tx=>tx.put('resource',{id:'grok',status:'idle'}));await f.tick(601);assert.equal(f.calls.length,2);
 await f.repo.transact('stalled-claimed',{},async tx=>{const row=await tx.get('channel_turn',a.turnId);tx.put('channel_turn',{...row,status:'stalled',claimedAt:at(602),lease:'prior-execution'});return{};});
 await f.tick(1500);assert.equal(f.calls.length,2);assert.equal((await f.repo.get('channel_turn',a.turnId)).lease,'prior-execution');
});
test('accepted receipt recovery is paginated and stops after three invitations without fabricating a claim',async t=>{
 const f=await setup(t),a=await f.post('Still waiting');await f.tick(0);
 await f.repo.transact('historical-receipt-page',{},async tx=>{const source=await tx.get('outbox',a.noticeId);for(let i=0;i<101;i++)tx.put('outbox',{...source,id:'a-old-receipt-'+i,conversation:false});return{};});
 await f.tick(600);await f.tick(1200);await f.tick(1800);assert.equal(f.calls.length,3);
 assert.equal((await f.repo.get('channel_turn',a.turnId)).status,'stalled');assert.equal((await f.repo.get('outbox',a.noticeId)).status,'unclaimed');
 await f.tick(2400);assert.equal(f.calls.length,3,'no recurring paid model polling');
});
for(const transport of ['grok-webhook','dots-events'])test(`${transport}: explicitly retrying a timed-out message uses a new invitation and resets only its bounded recovery budget`,async t=>{
 const f=await setup(t,transport),a=await f.post('Retry this exact preserved requirement'),wait=600;await f.tick(0);
 for(const s of [wait,wait*2,wait*3])await f.tick(s);
 assert.equal((await f.repo.get('channel_turn',a.turnId)).status,'stalled');
 const lastId=f.calls.at(-1).body.eventId||f.calls.at(-1).body.delivery_id;
 await f.send('channel.continue',{channelId:f.channel.id,turnId:a.turnId},{owner:true},wait*3+1);await f.tick(wait*3+1);
 const newId=f.calls.at(-1).body.eventId||f.calls.at(-1).body.delivery_id;
 assert.notEqual(newId,lastId);assert.equal(f.accepted.size,4,'the platform must not deduplicate an explicit recovery against a previous event');
 await f.tick(wait*4+1);assert.equal(f.calls.length,5,'explicit retry gets a fresh bounded recovery budget, even with a monotonic wake generation');
 const claim=await f.receive(a,'real-receiver-after-manual-retry');assert.equal(claim.status,'claimed');assert.deepEqual(claim.input.triggerMessageIds,[a.message.id]);
});
test('signed platform automations get their asynchronous startup window; Bot routine recovery remains independent',async t=>{
 const f=await setup(t,'grok-webhook');await f.post('Cloud automation startup');await f.tick(0);
 await f.tick(120);await f.tick(599);assert.equal(f.calls.length,1,'do not report an asynchronous platform offline after two minutes');
 await f.tick(600);assert.equal(f.calls.length,2);assert.equal(f.calls[1].body.member_id,'grok');
 assert.notEqual(f.calls[0].body.delivery_id,f.calls[1].body.delivery_id);
});
test('legacy accepted Grok receipts without receiver kind do not misclassify a slow platform as a fast Bot',async t=>{
 const f=await setup(t,'grok-webhook'),a=await f.post('Pre-upgrade accepted invitation');await f.tick(0);
 await f.repo.transact('legacy-no-receiver-kind',{},async tx=>{const n=await tx.get('outbox',a.noticeId);delete n.receiverKind;tx.put('outbox',n);return{};});
 await f.tick(120);await f.tick(599);assert.equal(f.calls.length,1);
 await f.tick(600);assert.equal(f.calls.length,2);assert.equal((await f.repo.get('outbox',a.noticeId)).receiverKind,'platform-automation');
});
test('Bearer Bot routines retain their two-minute recovery window independently of legacy platform automations',async t=>{
 const f=await setup(t,'grok-webhook','crsr_isolated_routine'),a=await f.post('Native Bot invitation');await f.tick(0);
 assert.equal((await f.repo.get('outbox',a.noticeId)).receiverKind,'bot-routine');
 await f.tick(119);assert.equal(f.calls.length,1);await f.tick(120);assert.equal(f.calls.length,2);
});
