import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand,conversationTool,claimConversation} from '../cloud/collaboration/conversation.mjs';
import {withConversationContext} from '../cloud/collaboration/inbox.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';
const owner={owner:true},leader={memberId:'write'},worker={memberId:'grok'};
async function setup(t){const f=await fixture(t);let n=0;const send=(type,args,actor=owner)=>conversationCommand(f.repo,f.identity,actor,{type,requestId:'intent-'+(++n),...args});const c=await send('channel.create',{name:'持续协作',memberIds:['grok','check','write'],coordinatorId:'write'});const post=(body,args={},actor=owner)=>send('channel.post',{channelId:c.id,body,...args},actor);const action=(args,actor=leader)=>send('channel.task',{channelId:c.id,...args},actor);const read=id=>conversationTool(f.repo,f.identity,owner,'read_todo',{channelId:c.id,taskId:id});const plan=async(goal='交付目标')=>{const m=await post(goal);return action({action:'plan',intent:{goal,scope:['只按本次授权执行']},messageIds:[m.id]});};return {...f,c,send,post,action,read,plan};}
const passed={criterionResults:[{id:'outcome',result:'met',evidence:'核对实际结果'}],verdict:'accept',reason:'已核对'};
async function done(f,t,actor=leader){return f.action({action:'submit',taskId:t.id,expectedVersion:t.version,workSpecVersion:t.workSpec.version,submission:{body:'实际交付',coverage:[{id:'outcome',location:'正文'}]},selfCheck:passed},actor);}

test('plan records dynamic intent, original source and visible card; plain chat does not manufacture a task',async t=>{
 const f=await setup(t);await f.post('你好吗');assert.equal((await f.repo.list('channel_task')).length,0);
 const task=await f.plan();assert.equal(task.managedIntent,true);assert.equal(task.assigneeId,'write');assert.equal(task.intentVersion,1);
 const card=await f.repo.get('channel_message',task.cardMessageId);assert.equal(card.type,'task_intent');assert.equal(card.taskCard.intent.goal,'交付目标');
 const detail=await f.read(task.id);assert.equal(detail.sourceMessages.length,1);assert.equal(detail.sourceMessages[0].body,'交付目标');
});
test('explicit task supplement keeps target routing, remains in source context and never pauses active work',async t=>{
 const f=await setup(t),task=await f.plan();await f.action({action:'accept',taskId:task.id,expectedVersion:task.version});
 const msg=await f.post('补充材料，先继续',{refs:[{kind:'task',id:task.id}],mentions:['grok']});assert.deepEqual(msg.recipientIds,['grok']);assert.deepEqual(msg.taskIds,[task.id]);
 const current=await f.read(task.id);assert.equal(current.status,'doing');assert.equal(current.workSpec.version,1);assert.equal(current.sourceMessages.length,2);
 const notice=(await f.repo.list('channel_turn')).find(x=>x.messageId===msg.id),claim=await claimConversation(f.repo,f.identity,worker,{requestId:'claim-task',stepId:notice.id});const context=await withConversationContext(f.repo,f.identity,worker,claim);assert.equal(context.input.taskWork[0].intent.goal,task.intent.goal);assert.ok(context.input.taskWork[0].sourceMessages.some(m=>m.id===msg.id));
});
test('revision changes only affected node; completed independent work and another parallel task survive',async t=>{
 const f=await setup(t),task=await f.plan(),other=await f.plan('独立任务');
 const a=await done(f,await f.action({action:'create',title:'不受影响',parentTaskId:task.id,assigneeId:'write',notifyAssignee:false}));
 const b=await done(f,await f.action({action:'create',title:'受影响',parentTaskId:task.id,assigneeId:'write',notifyAssignee:false}));
 const fresh=await f.read(task.id),m=await f.post('改第二项要求');
 await f.action({action:'revise',taskId:task.id,expectedVersion:fresh.version,intent:{goal:'改过的目标',format:{custom:true}},messageIds:[m.id],changes:[{taskId:b.id,expectedVersion:b.version,action:'configure',body:'新版要求'}]});
 const unchanged=await f.read(a.id),changed=await f.read(b.id);assert.equal(unchanged.version,a.version);assert.equal(unchanged.delivery.valid,true);assert.equal(changed.status,'todo');assert.equal(changed.delivery.valid,false);assert.equal((await f.read(other.id)).version,other.version);assert.equal((await f.read(task.id)).intent.format.custom,true);
});
test('progress association preserves acceptance, actual intent correction reopens only aggregate',async t=>{
 const f=await setup(t),task=await done(f,await f.plan()),m=await f.post('进度怎么样');
 const linked=await f.action({action:'associate',taskId:task.id,expectedVersion:task.version,messageIds:[m.id]});assert.equal((await f.read(task.id)).delivery.valid,true);
 const revised=await f.action({action:'revise',taskId:task.id,expectedVersion:linked.version,intent:{goal:'补上新的交付'}});assert.equal(revised.status,'doing');assert.equal((await f.read(task.id)).delivery.valid,false);assert.equal((await f.repo.get('channel_task_submission',task.currentSubmissionId)).body,'实际交付');
});
test('associated result without purpose or @ returns to leader, including child work',async t=>{
 const f=await setup(t),task=await f.plan(),child=await f.action({action:'create',title:'具体节点',parentTaskId:task.id,assigneeId:'grok'});
 const msg=await f.post('这是具体结果',{refs:[{kind:'task',id:child.id}],mentions:[],replyTo:(await f.read(task.id)).sourceMessageId},worker);
 assert.ok(msg.recipientIds.includes('write'));assert.ok(msg.taskIds.includes(task.id));assert.equal((await f.repo.list('channel_turn')).filter(x=>x.messageId===msg.id&&x.memberId==='write').length,1);
});
test('merge preserves IDs, original results, child dependencies and handles old references and late submissions',async t=>{
 const f=await setup(t),left=await f.plan('同目标旧任务'),right=await f.plan('同目标主任务');
 const child=await f.action({action:'create',title:'已完成节点',parentTaskId:left.id,assigneeId:'grok',notifyAssignee:false});const completed=await done(f,child,worker);
 const merged=await f.action({action:'merge',taskId:left.id,expectedVersion:(await f.read(left.id)).version,targetTaskId:right.id,targetVersion:right.version,reason:'同一交付目标'});
 assert.equal(merged.id,right.id);assert.equal((await f.read(completed.id)).parentTaskId,right.id);assert.equal((await f.read(completed.id)).delivery.valid,true);assert.equal((await f.read(left.id)).mergedInto,right.id);
 const msg=await f.post('沿用旧链接补充',{refs:[{kind:'task',id:left.id}]});assert.deepEqual(msg.taskIds,[right.id]);
 const late=await done(f,await f.read(left.id));assert.equal(late.id,left.id);assert.equal(late.parentTaskId,right.id);assert.equal((await f.repo.get('channel_task_submission',late.currentSubmissionId)).body,'实际交付');
});
test('stale, foreign, unauthorized and invalid nested revisions roll back the whole intent operation',async t=>{
 const f=await setup(t),task=await f.plan();const before=(await f.repo.list('channel_message')).length;
 await assert.rejects(f.action({action:'revise',taskId:task.id,expectedVersion:task.version-1,intent:{goal:'覆盖'}}),e=>e.code==='version_conflict');
 await assert.rejects(f.action({action:'revise',taskId:task.id,expectedVersion:task.version,intent:{goal:'越权'}},worker),e=>e.code==='forbidden');
 const foreign=await f.send('channel.create',{name:'别群',memberIds:['write']});const m=await f.send('channel.post',{channelId:foreign.id,body:'私有'});
 await assert.rejects(f.action({action:'associate',taskId:task.id,expectedVersion:task.version,messageIds:[m.id]}),e=>e.code==='forbidden');
 await assert.rejects(f.action({action:'revise',taskId:task.id,expectedVersion:task.version,intent:{goal:'新版'},changes:[{taskId:task.id,expectedVersion:task.version,action:'update',title:'不应保留'}, {taskId:'missing'}]}));assert.equal((await f.read(task.id)).title,task.title);assert.equal((await f.read(task.id)).version,task.version);assert.equal((await f.repo.list('channel_message',{scope:f.c.id})).length,before);
});
test('cached native tool catalog can plan through existing body string and shared envelope',async t=>{
 const f=await setup(t),m=await f.post('旧目录需求');const result=await callTool(f.repo,f.identity,leader,'post_message',{requestId:'cached-plan',channelId:f.c.id,body:'HUB_SHARED_TOOL_V1\n'+JSON.stringify({name:'board_task',arguments:{channelId:f.c.id,action:'plan',body:JSON.stringify({intent:{goal:'兼容旧目录'},messageIds:[m.id]})}})},{});assert.equal(result.intent.goal,'兼容旧目录');
});
test('reply does not finish a runnable managed task; continuation is durable and does not spin on no progress',async t=>{
 const f=await setup(t),task=await f.plan(),source=(await f.read(task.id)).sourceMessageId;
 const msg=await f.post('已记录，继续处理',{replyTo:source,mentions:[]},leader);assert.equal((await f.read(task.id)).status,'todo');
 const notices=(await f.repo.list('channel_task_followup')).filter(x=>x.id.includes(':continue:'));assert.equal(notices.length,1);assert.ok(await f.repo.get('outbox','notice_'+(await f.repo.list('channel_turn')).find(x=>x.messageId===notices[0].messageId).id));
 await f.post('无新状态',{replyTo:msg.id,mentions:[]},leader);assert.equal((await f.repo.list('channel_task_followup')).filter(x=>x.id.includes(':continue:')).length,1);
});

test('reassociation is explicit and retains a history trail rather than silently overwriting earlier interpretation',async t=>{
 const f=await setup(t),left=await f.plan('目标甲'),right=await f.plan('目标乙'),m=await f.post('补充乙的要求',{refs:[{kind:'task',id:left.id}]});
 await f.action({action:'associate',taskId:right.id,expectedVersion:right.version,fromTaskId:left.id,fromVersion:(await f.read(left.id)).version,messageIds:[m.id],reason:'纠正归属'});
 assert.deepEqual((await f.repo.get('channel_message',m.id)).taskIds,[right.id]);assert.ok(!(await f.read(left.id)).intentSourceIds.includes(m.id));assert.ok((await f.read(right.id)).intentSourceIds.includes(m.id));assert.ok((await f.read(left.id)).versions.some(v=>v.intentSourceIds?.includes(m.id)));
});
test('waiting on peers or dependencies creates no continuation polling; work in another task still proceeds',async t=>{
 const f=await setup(t),task=await f.plan('等待核查');await f.action({action:'create',title:'其他成员的工作',parentTaskId:task.id,assigneeId:'grok',notifyAssignee:false});
 await f.post('等待成员回传',{replyTo:(await f.read(task.id)).sourceMessageId,mentions:[]},leader);assert.equal((await f.repo.list('channel_task_followup')).filter(x=>x.id.includes(':continue:')).length,0);
 const other=await f.plan('独立可做');await f.post('推进独立事项',{replyTo:(await f.read(other.id)).sourceMessageId,mentions:[]},leader);assert.equal((await f.repo.list('channel_task_followup')).filter(x=>x.id.includes(':continue:')).length,1);
});
test('concurrent supplements and intent revisions retain both original messages without restarting native work',async t=>{
 const f=await setup(t),task=await f.plan();const outcomes=await Promise.allSettled([f.post('补充一',{refs:[{kind:'task',id:task.id}]}),f.post('补充二',{refs:[{kind:'task',id:task.id}]})]);
 assert.ok(outcomes.every(o=>o.status==='fulfilled'));const current=await f.read(task.id);assert.ok(current.sourceMessages.some(m=>m.body==='补充一'));assert.ok(current.sourceMessages.some(m=>m.body==='补充二'));assert.equal(current.status,'todo');
 const revisions=await Promise.allSettled([f.action({action:'revise',taskId:task.id,expectedVersion:current.version,intent:{goal:'版本A'}}),f.action({action:'revise',taskId:task.id,expectedVersion:current.version,intent:{goal:'版本B'}})]);assert.equal(revisions.filter(r=>r.status==='fulfilled').length,1);assert.equal(revisions.filter(r=>r.status==='rejected'&&r.reason.code==='version_conflict').length,1);
});

test('editing an original owner message does not invalidate every child; explicit revision refreshes aggregate basis',async t=>{
 const f=await setup(t),task=await f.plan('方案要求'),child=await done(f,await f.action({action:'create',title:'已核对的独立证据',parentTaskId:task.id,assigneeId:'write',notifyAssignee:false}));
 const detail=await f.read(task.id),source=await f.repo.get('channel_message',detail.sourceMessageId);
 await f.send('channel.message.edit',{channelId:f.c.id,messageId:source.id,expectedVersion:source.version||1,body:'方案要求，加一个交付维度'});
 assert.equal((await f.read(child.id)).delivery.valid,true);assert.ok((await f.read(child.id)).sourceMessages.some(m=>m.body.includes('加一个交付维度')));
 const current=await f.read(task.id);const revised=await f.action({action:'revise',taskId:task.id,expectedVersion:current.version,intent:{goal:'方案要求，加一个交付维度'}});
 assert.equal(revised.requirementSources[0].version,2);assert.equal((await f.read(child.id)).delivery.valid,true);assert.ok(!(await f.read(task.id)).delivery.gaps.some(g=>g.includes('原始用户要求已有变化')));
});
