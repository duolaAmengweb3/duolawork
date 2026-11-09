import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand,conversationWork,claimConversation,receiveDelivery,conversationRuntime} from '../cloud/collaboration/conversation.mjs';
import {taskNotificationMaintenance} from '../cloud/collaboration/task-deliverables.mjs';
import {putExecutionBinding} from '../cloud/collaboration/execution-bindings.mjs';
import {dispatchOne} from '../cloud/collaboration/dispatcher.mjs';
import {digest} from '../cloud/collaboration/repository.mjs';
import {seal} from '../cloud/collaboration/security.mjs';
import {pendingTurnState} from '../shared/chat-activity.mjs';

const owner={owner:true},worker={memberId:'grok'},reviewer={memberId:'check'};
const passed={verdict:'accept',reason:'Checked the actual result',criterionResults:[{id:'outcome',result:'met',evidence:'Actual result matches the requirement'}]};
const spec={expectedOutcome:'Actual result',criteria:[{id:'outcome',text:'Deliver the actual result'}]};
const secret='isolated-task-retirement-fixture';
async function setup(t,{webhook=false}={}){
 const f=await fixture(t);let n=0;
 const requestId=()=>`task-notice-${++n}`;
 const send=(type,args={},actor=owner)=>conversationCommand(f.repo,f.identity,actor,{requestId:requestId(),type,...args});
 const c=await send('channel.create',{name:'Task notification lifecycle',memberIds:['grok','check','write'],coordinatorId:'write'});
 if(webhook)await f.repo.transact(requestId(),{},async tx=>{const connection=await tx.get('connection','grok');tx.put('connection',{...connection,transport:'grok-webhook',credentials:await seal({url:'https://grok.com/webhook/automation/isolated-retirement',token:'whsec_'+Buffer.alloc(32,17).toString('base64')},secret)});});
 const create=args=>send('channel.task',{channelId:c.id,action:'create',title:'Work',assigneeId:'grok',workSpec:spec,...args});
 const act=async(task,action,args={},actor=owner)=>send('channel.task',{channelId:c.id,taskId:task.id,action,expectedVersion:(await f.repo.get('channel_task',task.id)).version,...args},actor);
 const submit=(task,body='Actual result')=>act(task,'submit',{workSpecVersion:task.workSpec.version,submission:{body,coverage:[{id:'outcome',location:'body'}]}},worker);
 const notice=async(task,prefix='assigned:')=>(await f.repo.list('channel_turn',{scope:c.id})).find(x=>x.taskId===task.id&&x.taskEvent.startsWith(prefix));
 const claim=(turn,args={},actor=worker)=>claimConversation(f.repo,f.identity,actor,{requestId:requestId(),stepId:turn.id,channelId:c.id,...args});
 const bind=()=>f.repo.transact(requestId(),{},async tx=>putExecutionBinding(tx,{id:'grok:'+c.id,parentId:'grok',scopeId:c.id,sessionKey:await digest('original'),status:'active'}));
 const legacy=async turn=>{await act({id:turn.taskId},'update',{status:'canceled'});await f.repo.transact(requestId(),{},async tx=>{tx.put('channel_turn',turn);const row=await tx.get('outbox','notice_'+turn.id);tx.put('outbox',{...row,status:webhook?'pending':'awaiting_poll',reason:null});});};
 return {...f,c,requestId,send,create,act,submit,notice,claim,bind,legacy};
}

test('cancel atomically retires unclaimed turns, outbox and task followup; active execution remains owned',async t=>{
 const f=await setup(t),a=await f.create({}),turn=await f.notice(a);
 await f.act(a,'update',{status:'canceled'});
 const retired=await f.repo.get('channel_turn',turn.id);assert.equal(retired.status,'removed');assert.equal(retired.resolution,'obsolete_task');
 assert.equal((await f.repo.get('outbox','notice_'+turn.id)).status,'canceled');
 assert.equal((await f.repo.get('channel_task_followup',`${a.id}:${turn.taskEvent}:grok`)).status,'superseded');
 assert.ok(!(await conversationWork(f.repo,f.identity,'grok')).some(w=>w.stepId===turn.id));
 const b=await f.create({title:'Running work'}),running=await f.notice(b),claim=await f.claim(running);
 await f.act(b,'update',{status:'canceled'});const preserved=await f.repo.get('channel_turn',running.id);
 assert.equal(preserved.status,'active');assert.equal(preserved.lease,claim.lease);assert.equal((await f.repo.get('resource',preserved.resourceKey)).turnId,preserved.id);
 await f.send('channel.silent',{channelId:f.c.id,turnId:preserved.id,reason:'Observed task cancellation; no work was restarted'},worker);
 assert.equal((await f.repo.get('resource',preserved.resourceKey)).status,'idle');
});

test('explicit claim of a pre-upgrade canceled notice commits retirement and returns no execution lease',async t=>{
 const f=await setup(t),task=await f.create({}),turn=await f.notice(task);await f.legacy(turn);
 await assert.rejects(f.claim(turn,{channelId:'another-channel'}),e=>e.code==='forbidden');
 await assert.rejects(f.claim(turn,{},reviewer),e=>e.code==='forbidden');
 assert.equal((await f.repo.get('channel_turn',turn.id)).status,'ready');
 const result=await f.claim(turn);assert.equal(result.status,'obsolete');assert.equal(result.claimed,false);assert.equal(result.needsResponse,false);assert.equal(result.turnId,undefined);assert.equal(result.lease,undefined);
 assert.equal((await f.repo.get('channel_turn',turn.id)).status,'removed');assert.equal((await f.repo.get('outbox','notice_'+turn.id)).status,'canceled');
 assert.equal((await f.claim(turn)).status,'obsolete');
 assert.equal((await f.repo.list('resource')).some(r=>r.turnId===turn.id),false);
});

test('inbox and runtime reads heal old records, and a previously successful cached receipt cannot wake them again',async t=>{
 const f=await setup(t);await f.bind();const task=await f.create({}),turn=await f.notice(task);
 const args={requestId:'same-old-positive-ack',turnId:turn.id,sessionId:'original',attempt:0,phase:'received',sourceVersion:1};
 assert.equal((await receiveDelivery(f.repo,worker,args)).applied,true);
 await f.legacy(turn);assert.equal((await receiveDelivery(f.repo,worker,args)).applied,false);
 assert.equal((await conversationRuntime(f.repo,worker,{action:'read',turnId:turn.id})).status,'removed');
 const second=await f.create({title:'Old snapshot'}),old=await f.notice(second);await f.legacy(old);
 assert.equal((await conversationWork(f.repo,f.identity,'grok')).length,0);assert.equal((await f.repo.get('channel_turn',old.id)).status,'removed');
});

test('new submission, changed specification and changed assignee invalidate only their obsolete notices; root completion still notifies',async t=>{
 const f=await setup(t),task=await f.create({notifyAssignee:false,workSpec:{...spec,checkMode:'designated',reviewerId:'check'}}),first=await f.submit(task),review=await f.notice(task,'review:');
 const next=await f.submit(first,'Revised actual result');assert.equal((await f.repo.get('channel_turn',review.id)).status,'removed');
 const currentReview=(await f.repo.list('channel_turn')).find(x=>x.taskEvent==='review:'+next.currentSubmissionId);
 const done=await f.act(next,'check',{submissionId:next.currentSubmissionId,workSpecVersion:1,...passed},reviewer);
 const final=await f.notice(done,'check:');assert.equal(final.status,'ready');assert.equal((await f.repo.get('channel_turn',currentReview.id)).status,'removed');
 assert.ok((await conversationWork(f.repo,f.identity,'grok')).some(w=>w.stepId===final.id),'a completed root still delivers its actual final result');
 await f.act(done,'configure',{workSpec:{...spec,expectedOutcome:'Updated outcome'}});
 assert.equal((await f.repo.get('channel_turn',final.id)).status,'removed');
 const moved=await f.create({title:'Reassigned work'}),old=await f.notice(moved);await f.act(moved,'update',{assigneeId:'write'});
 assert.equal((await f.repo.get('channel_turn',old.id)).status,'removed');assert.ok((await f.repo.list('channel_turn')).some(x=>x.taskId===moved.id&&x.memberId==='write'&&x.status==='ready'));
});

test('temporary unmet basis waits without a model lease or lost notice, then resumes; ordinary messages remain claimable',async t=>{
 const f=await setup(t),root=await f.create({notifyAssignee:false}),up=await f.create({parentTaskId:root.id,notifyAssignee:false});
 const accepted=await f.act(up,'submit',{workSpecVersion:1,submission:{body:'Input',coverage:[{id:'outcome',location:'body'}]},selfCheck:passed},worker);
 const down=await f.create({parentTaskId:root.id,dependsOn:[up.id]}),turn=await f.notice(down);
 await f.act(accepted,'update',{status:'blocked',blocker:'Waiting for the same input'});
 const waiting=await f.claim(turn);assert.equal(waiting.status,'waiting');assert.equal(waiting.lease,undefined);assert.equal((await f.repo.get('outbox','notice_'+turn.id)).status,'awaiting_poll');
 const pending=await f.repo.get('channel_turn',turn.id);assert.equal(pending.status,'ready');assert.equal(pendingTurnState(pending).label,'等待前置条件');
 const msg=await f.send('channel.post',{channelId:f.c.id,body:'A separate human question',mentions:['grok']});
 const normal=await f.claim({id:`turn_${msg.id}_grok`});assert.equal(normal.turnId,`turn_${msg.id}_grok`);assert.ok(!(await f.repo.get('channel_turn',normal.turnId)).mergedMessageIds.includes(turn.messageId));
 await f.send('channel.silent',{channelId:f.c.id,turnId:normal.turnId,reason:'Human question answered separately'},worker);
 await f.act(accepted,'submit',{workSpecVersion:1,submission:{body:'Input',coverage:[{id:'outcome',location:'body'}]},selfCheck:passed},worker);
 assert.equal((await f.repo.get('channel_turn',turn.id)).taskWaitReason,undefined);assert.equal((await f.claim(turn)).turnId,turn.id);
});

test('obsolete webhook anchor releases coalesced human messages; late HTTP success cannot resurrect it',async t=>{
 const f=await setup(t,{webhook:true}),task=await f.create({}),turn=await f.notice(task),rowId='notice_'+turn.id;
 let release,started;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);
 const dispatch=dispatchOne(f.repo,f.identity,rowId,{ADMIN_KEY:secret},async()=>{started();await gate;return new Response('{}',{status:202});});
 await entered;
 const msg=await f.send('channel.post',{channelId:f.c.id,body:'Keep this human followup',mentions:['grok']}),normalId='notice_turn_'+msg.id+'_grok';
 await dispatchOne(f.repo,f.identity,normalId,{ADMIN_KEY:secret},async()=>assert.fail('coalesced work must not send twice'));
 assert.equal((await f.repo.get('outbox',normalId)).status,'coalesced');
 await f.act(task,'update',{status:'canceled'});assert.equal((await f.repo.get('outbox',normalId)).status,'pending');
 release();await dispatch;assert.equal((await f.repo.get('outbox',rowId)).status,'canceled');
 let calls=0;await dispatchOne(f.repo,f.identity,normalId,{ADMIN_KEY:secret},async()=>{calls++;return new Response('{}',{status:202});});
 assert.equal(calls,1);assert.equal((await f.repo.get('outbox',normalId)).status,'accepted');
 const claim=await f.claim({id:`turn_${msg.id}_grok`});assert.ok(!(await f.repo.get('channel_turn',claim.turnId)).mergedMessageIds.includes(turn.messageId));
});

test('maintenance repairs all unclaimed legacy states without replaying ordinary messages or touching active execution',async t=>{
 const f=await setup(t),ids=[];
 for(const status of ['ready','stalled','unavailable','limited']){const task=await f.create({title:status}),turn=await f.notice(task);await f.legacy({...turn,status});ids.push(turn.id);}
 const message=await f.send('channel.post',{channelId:f.c.id,body:'Keep ordinary work',mentions:['grok']});
 await taskNotificationMaintenance(f.repo);for(const id of ids)assert.equal((await f.repo.get('channel_turn',id)).status,'removed');
 assert.equal((await f.repo.get('channel_turn',`turn_${message.id}_grok`)).status,'ready');
 const before=(await f.repo.db.prepare('SELECT COUNT(*) AS n FROM hub_v2_receipts').first()).n;
 await taskNotificationMaintenance(f.repo);assert.equal((await f.repo.db.prepare('SELECT COUNT(*) AS n FROM hub_v2_receipts').first()).n,before);
});
