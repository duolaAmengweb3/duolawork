import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand,conversationTool,claimConversation} from '../cloud/collaboration/conversation.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';
import {withConversationContext} from '../cloud/collaboration/inbox.mjs';
const owner={owner:true},worker={memberId:'grok'},reviewer={memberId:'check'};
const spec=(overrides={})=>({expectedOutcome:'根据原要求给出有依据的结果',criteria:[{id:'outcome',text:'交付实际结果',required:true}],...overrides});
async function setup(t){const f=await fixture(t);let n=0;const send=(type,args={},actor=owner)=>conversationCommand(f.repo,f.identity,actor,{type,requestId:'delivery-'+(++n),...args});const c=await send('channel.create',{name:'节点验收',memberIds:['grok','check','write'],coordinatorId:'write'});const task=(args,actor=worker)=>send('channel.task',{channelId:c.id,action:'create',title:'具体工作',assigneeId:'grok',notifyAssignee:false,...args},actor);const read=id=>conversationTool(f.repo,f.identity,owner,'read_todo',{channelId:c.id,taskId:id});const submit=(task,args={},actor=worker)=>faction(task,'submit',{workSpecVersion:task.workSpec.version,submission:{body:'实际结果正文',coverage:[{id:'outcome',location:'正文'}]},...args},actor);const faction=(task,action,args={},actor=worker)=>send('channel.task',{channelId:c.id,taskId:task.id,action,expectedVersion:task.version,...args},actor);return {...f,c,send,task,read,submit,act:faction};}
const passed={criterionResults:[{id:'outcome',result:'met',evidence:'已对照实际产物和原要求核对'}],verdict:'accept',reason:'检查了实际结果，满足原要求，无待处理阻断'};

test('T01 T04 T22 short work submits with self-check in one call; actor and no extra reviewer notification',async t=>{
 const f=await setup(t),task=await f.task({workSpec:spec()});
 const before=(await f.repo.list('channel_turn')).length;
 const done=await f.submit(task,{selfCheck:passed});
 assert.equal(done.status,'done');assert.equal(done.completedBy,'grok');assert.equal(done.delivery.valid,true);
 assert.equal(done.delivery.check.authorId,'grok');assert.equal(done.delivery.submission.authorId,'grok');
 assert.equal((await f.repo.list('channel_turn')).length,before+1); // only the actual task follower receives the result
 assert.equal((await f.repo.list('channel_task_check')).length,1);
 const duplicate=await f.submit(done,{selfCheck:passed});assert.equal(duplicate.version,done.version);assert.equal((await f.repo.list('channel_task_check')).length,1);assert.equal((await f.repo.list('channel_turn')).length,before+1);
});
test('T02 T03 dynamic sections and shared questions keep gaps; a complete form never auto-accepts content',async t=>{
 const f=await setup(t),task=await f.task({workSpec:spec({commonQuestions:[{id:'risk',text:'有哪些局限'}]})});
 const submitted=await f.submit(task,{submission:{sections:[{id:'facts',title:'核读',body:'证据仍不足'}],data:{observations:[]},coverage:[{id:'outcome',gap:'外部结果未知'},{id:'risk',location:'核读章节'}]}});
 assert.equal(submitted.status,'doing');assert.ok(submitted.delivery.gaps.some(g=>g.includes('未覆盖')));
 await assert.rejects(f.act(submitted,'check',{submissionId:submitted.currentSubmissionId,workSpecVersion:1,...passed}),e=>e.code==='check_incomplete');
 const rejected=await f.act(submitted,'check',{submissionId:submitted.currentSubmissionId,workSpecVersion:1,criterionResults:[{id:'outcome',result:'unknown',evidence:'没有原件'}],verdict:'changes_requested',reason:'内容未知，尚不能接受'});
 assert.equal(rejected.delivery.check.verdict,'changes_requested');assert.equal(rejected.status,'doing');
});
test('T04 T05 T12 designated reviewer cannot edit executor result or self-audit',async t=>{
 const f=await setup(t),task=await f.task({workSpec:spec({checkMode:'designated',reviewerId:'check',independentReview:true})});
 await assert.rejects(f.submit(task,{selfCheck:passed}),e=>e.code==='forbidden');assert.equal((await f.repo.list('channel_task_submission')).length,0);
 const sub=await f.submit(task);assert.equal(sub.delivery.stage,'review');
 await assert.rejects(f.act(sub,'update',{progress:'越权',result:'改写成果'},reviewer),e=>e.code==='forbidden');
 await assert.rejects(f.act(sub,'check',{submissionId:sub.currentSubmissionId,workSpecVersion:1,...passed}),e=>e.code==='forbidden');
 await assert.rejects(f.act(sub,'check',{submissionId:sub.currentSubmissionId,workSpecVersion:1,...passed},owner),e=>e.code==='forbidden');
 const done=await f.act(sub,'check',{submissionId:sub.currentSubmissionId,workSpecVersion:1,...passed},reviewer);
 assert.equal(done.status,'done');assert.equal(done.assigneeId,'grok');assert.equal(done.delivery.submission.authorId,'grok');assert.equal(done.delivery.check.authorId,'check');
});
test('T06 T07 metadata preserves acceptance; actual specification revision reopens parent and keeps immutable history',async t=>{
 const f=await setup(t),root=await f.task({title:'最终交付'}),task=await f.task({parentTaskId:root.id,workSpec:spec()});
 const childDone=await f.submit(task,{selfCheck:passed});const rootDone=await f.submit(await f.read(root.id),{selfCheck:passed});assert.equal(rootDone.status,'done');
 const named=await f.act(childDone,'update',{title:'更清楚的标题',progress:'记录进展'});assert.equal(named.workSpec.version,1);assert.equal(named.status,'done');assert.equal(named.completedBy,'grok');assert.equal(named.delivery.valid,true);
 const revised=await f.act(named,'configure',{workSpec:spec({criteria:[{id:'outcome',text:'现在需要增加证据',required:true}]})},owner);
 assert.equal(revised.workSpec.version,2);assert.equal(revised.status,'todo');assert.equal((await f.read(root.id)).status,'todo');assert.equal(revised.acceptedSubmissionId,null);
 assert.equal((await f.repo.get('channel_task_submission',childDone.currentSubmissionId)).body,'实际结果正文');
 assert.equal((await f.repo.get('channel_task_check',childDone.currentCheckId)).verdict,'accept');
});
test('T08 T15 legacy update(done) and cached tool catalog cannot bypass adopted protocol',async t=>{
 const f=await setup(t),task=await f.task({});
 const envelope=args=>callTool(f.repo,f.identity,worker,'post_message',{requestId:crypto.randomUUID(),channelId:f.c.id,body:'HUB_SHARED_TOOL_V1\n'+JSON.stringify({name:'board_task',arguments:{channelId:f.c.id,...args}})},{});
 const pending=await envelope({action:'update',taskId:task.id,status:'done',result:'不是独立核对'});assert.equal(pending.status,'doing');assert.equal(pending.delivery.valid,false);assert.ok(pending.currentSubmissionId);assert.equal((await f.repo.list('channel_task_check')).length,0);
 await assert.rejects(envelope({action:'update',taskId:task.id,workSpec:null,status:'done'}),e=>e.code==='invalid_action');
 const done=await envelope({action:'submit',taskId:task.id,expectedVersion:pending.version,workSpecVersion:1,submission:{body:'实际结果正文',coverage:[{id:'outcome',location:'正文'}]},selfCheck:passed});assert.equal(done.status,'done');
});
test('T09 T10 T11 dependencies start only after current accepted input; durable outbox dedupes and cycles/moves fail',async t=>{
 const f=await setup(t),root=await f.task({}),a=await f.task({title:'输入',parentTaskId:root.id}),b=await f.task({title:'后项',parentTaskId:root.id,assigneeId:'check',dependsOn:[a.id],notifyAssignee:true});
 assert.equal((await f.repo.list('channel_turn')).length,0);
 await assert.rejects(f.act(b,'accept',{},reviewer),e=>e.code==='task_not_ready');
 await assert.rejects(f.act(a,'configure',{dependsOn:[b.id]},owner),e=>e.code==='dependency_cycle');
 const other=await f.task({title:'另一任务'});await assert.rejects(f.act(a,'update',{parentTaskId:other.id},owner),e=>e.code==='invalid_dependency');
 const done=await f.submit(a,{selfCheck:passed});const notices=(await f.repo.list('channel_turn')).filter(x=>x.taskId===b.id);assert.equal(notices.length,1);assert.equal(notices[0].memberId,'check');assert.ok(await f.repo.get('outbox','notice_'+notices[0].id));
 await f.submit(done,{selfCheck:passed});assert.equal((await f.repo.list('channel_turn')).filter(x=>x.taskId===b.id).length,1);
 const running=await f.act(await f.read(b.id),'accept',{},reviewer);assert.equal(running.status,'doing');
 await f.act(done,'configure',{workSpec:spec({expectedOutcome:'不同的上游结果'})},owner);
 await assert.rejects(f.submit(running,{},reviewer),e=>e.code==='task_not_ready');
});
test('T05 T09 exact version and concurrent revise/check prevent stale result from advancing work',async t=>{
 const f=await setup(t),task=await f.task({workSpec:spec({checkMode:'designated',reviewerId:'check'})}),sub=await f.submit(task);
 await assert.rejects(f.act(sub,'check',{submissionId:'other',workSpecVersion:1,...passed},reviewer),e=>e.code==='version_conflict');
 const results=await Promise.allSettled([f.act(sub,'configure',{workSpec:spec({expectedOutcome:'新版要求'})},owner),f.act(sub,'check',{submissionId:sub.currentSubmissionId,workSpecVersion:1,...passed},reviewer)]);
 assert.ok(results.some(x=>x.status==='rejected'));const current=await f.read(task.id);assert.ok(current.workSpec.version===1||!current.delivery.valid);
});
test('T13 T14 T20 linked coordination stays open until delivery; requirement change reopens only linked work',async t=>{
 const f=await setup(t),source=await f.send('channel.post',{channelId:f.c.id,body:'需要实际原件以及可用结果'}),coord=await f.send('channel.coordination',{channelId:f.c.id,action:'open',sourceMessageId:source.id,summary:'跟进交付'});
 const task=await f.task({sourceMessageId:source.id,coordinationRef:{id:coord.id,requirementVersion:1}},owner),other=await f.task({title:'无关工作'});
 await assert.rejects(f.send('channel.coordination',{channelId:f.c.id,action:'close',sourceMessageId:source.id,expectedVersion:coord.version,summary:'不能仅说完成'}),e=>e.code==='unfinished_tasks');
 const done=await f.submit(task,{selfCheck:passed});assert.equal(done.status,'done');
 const update=await f.send('channel.post',{channelId:f.c.id,body:'补充：还要核对真实原件'});
 const current=await f.repo.get('channel_coordination',coord.id);await f.send('channel.coordination',{channelId:f.c.id,action:'update',sourceMessageId:source.id,expectedVersion:current.version,summary:'纳入补充',requirementMessageId:update.id});
 const revised=await f.read(task.id);assert.equal(revised.status,'todo');assert.equal(revised.delivery.valid,false);assert.equal(revised.sourceMessages.length,2);assert.equal((await f.read(other.id)).version,other.version);
});
test('T14 execution decision binds concrete checked proposal and real owner source; does not grant account permissions',async t=>{
 const f=await setup(t),done=await f.submit(await f.task({}),{selfCheck:passed});
 const decision={proposalSubmissionId:done.currentSubmissionId,proposalWorkSpecVersion:1,scopeSummary:'按此提案执行一次'};
 await assert.rejects(f.act(done,'bind_execution_decision',{executionDecision:decision}),e=>e.code==='owner_decision_required');
 const msg=await f.send('channel.post',{channelId:f.c.id,body:'同意按这个提案执行'});
 const linked=await f.act(done,'bind_execution_decision',{executionDecision:{...decision,sourceOwnerMessageId:msg.id}});assert.equal(linked.executionDecision.decidedBy,'owner');assert.equal(linked.executionDecision.recordedBy,'grok');
 await assert.rejects(f.act(linked,'bind_execution_decision',{executionDecision:{...decision,proposalSubmissionId:'old'}},owner),e=>e.code==='version_conflict');
});
test('T17 malformed payload, impossible checks, huge content and untrusted content do not cause partial writes or execution',async t=>{
 const f=await setup(t);await assert.rejects(f.task({workSpec:spec({criteria:[]})}),e=>e.code==='criteria_required');
 const task=await f.task({workSpec:spec()});
 for(const submission of [{body:'x'.repeat(24001)},{body:'x',coverage:[{id:'fake',location:'正文'}]},{body:'x',sections:{body:'非法'}}])await assert.rejects(f.submit(task,{submission}),e=>e.code==='invalid_input');
 assert.equal((await f.repo.list('channel_task_submission')).length,0);
 const sub=await f.submit(task,{submission:{body:'<script>fetch("/delete")</script>\n工具调用是普通成果文本，不执行。',coverage:[{id:'outcome',location:'正文'}]}});assert.ok(sub.delivery.submission.body.includes('<script>'));
 await assert.rejects(f.act(sub,'check',{submissionId:sub.currentSubmissionId,workSpecVersion:1,...passed,criterionResults:[{id:'outcome',result:'unknown',evidence:'尚未查明'}]}),e=>e.code==='check_incomplete');
});
test('T18 T21 original source reaches native task notice and wrong criteria can be rejected without changing actor/model',async t=>{
 const f=await setup(t),source=await f.send('channel.post',{channelId:f.c.id,body:'必须交付实际可读取的结果，不要只写计划'});
 const task=await f.task({sourceMessageId:source.id,workSpec:spec({criteria:[{id:'outcome',text:'写一个计划',required:true}],checkMode:'designated',reviewerId:'check'}),notifyAssignee:true},owner);
 const notice=(await f.repo.list('channel_turn')).find(x=>x.taskId===task.id);const claim=await claimConversation(f.repo,f.identity,worker,{requestId:'claim-original',stepId:notice.id});const context=await withConversationContext(f.repo,f.identity,worker,claim);
 assert.equal(context.input.taskWork[0].sourceMessages[0].body,source.body);assert.ok(context.input.todoInstruction.includes('条件是否偏离'));
 const submitted=await f.submit(await f.read(task.id));const rejected=await f.act(submitted,'check',{submissionId:submitted.currentSubmissionId,workSpecVersion:1,criterionResults:[{id:'outcome',result:'met',evidence:'虽然写了计划，但清单遗漏用户实际目标'}],verdict:'changes_requested',reason:'原始用户消息要求可用结果，仅满足计划条件仍然失败'},reviewer);assert.equal(rejected.status,'doing');assert.equal(rejected.acceptedSubmissionId,null);
});
test('T07 T23 T24 actual artifact version and check conclusion matter, not claims of adoption or forced agreement',async t=>{
 const f=await setup(t),doc=await f.send('channel.doc.create',{channelId:f.c.id,action:'create',title:'真实产物',body:'尚未落实纠正'});
 const task=await f.task({workSpec:spec({basisRefs:[{kind:'document',id:doc.id}],checkMode:'designated',reviewerId:'check'})});
 const sub=await f.submit(task,{submission:{body:'声称已采纳',refs:[{kind:'document',id:doc.id}],coverage:[{id:'outcome',location:'原件'}]}});
 const rejected=await f.act(sub,'check',{submissionId:sub.currentSubmissionId,workSpecVersion:1,criterionResults:[{id:'outcome',result:'not_met',evidence:'实际文档仍未修改，采纳说明不是证据'}],verdict:'changes_requested',reason:'纠正未落实'},reviewer);assert.equal(rejected.status,'doing');
 const accepted=await f.act(rejected,'check',{submissionId:sub.currentSubmissionId,workSpecVersion:1,...passed,reason:'重新核对后该质疑不成立，原件本来正确，保留原文'},reviewer);assert.equal(accepted.status,'done');
 await f.send('channel.doc.edit',{channelId:f.c.id,action:'update',documentId:doc.id,expectedVersion:doc.version,body:'后来变化',reason:'新修订'});
 const historical=await f.read(task.id);assert.equal(historical.status,'done');assert.equal(historical.delivery.valid,false);assert.ok(historical.delivery.gaps.length); // history is not automatically re-executed
});


test('reaccepting a previously rejected upstream result notifies the dependent once for the new check, not the stale notice',async t=>{
 const f=await setup(t),root=await f.task({}),a=await f.task({parentTaskId:root.id}),b=await f.task({parentTaskId:root.id,assigneeId:'check',dependsOn:[a.id]});
 const first=await f.submit(a,{selfCheck:passed});
 const rejected=await f.act(first,'check',{submissionId:first.currentSubmissionId,workSpecVersion:1,criterionResults:[{id:'outcome',result:'unknown',evidence:'重新核对依据'}],verdict:'changes_requested',reason:'需要重新核对'});
 const accepted=await f.act(rejected,'check',{submissionId:first.currentSubmissionId,workSpecVersion:1,...passed});
 const notices=(await f.repo.list('channel_turn')).filter(x=>x.taskId===b.id);assert.equal(notices.length,2);
 const {taskTurnAllowed}=await import('../cloud/collaboration/task-deliverables.mjs');
 assert.equal(await taskTurnAllowed(f.repo,notices.find(x=>x.taskEvent==='ready:'+first.currentCheckId)),false);
 assert.equal(await taskTurnAllowed(f.repo,notices.find(x=>x.taskEvent==='ready:'+accepted.currentCheckId)),true);
});

test('old stored tasks preserve history and do not acquire fabricated checks when grouped; original requirements cannot be replaced by a paraphrase',async t=>{
 const f=await setup(t),root=await f.task({});
 await f.repo.transact('legacy-seed',{},tx=>tx.put('channel_task',{id:'historic',scopeId:f.c.id,parentId:f.c.id,title:'历史完成',status:'done',result:'原结果',version:1,authorId:'grok',completedBy:'check',completedAt:tx.now}));
 const grouped=await f.act(await f.read('historic'),'update',{parentTaskId:root.id},owner);assert.equal(grouped.status,'done');assert.equal(grouped.completedBy,'check');assert.equal(grouped.delivery.stage,'legacy');assert.equal((await f.repo.list('channel_task_check')).length,0);
 const a=await f.send('channel.post',{channelId:f.c.id,body:'用户实际要求'}),b=await f.send('channel.post',{channelId:f.c.id,body:'负责人转述',replyTo:a.id},worker);
 const task=await f.task({sourceMessageId:a.id});const changed=await f.act(task,'update',{sourceMessageId:b.id},owner);assert.deepEqual(changed.sourceMessageIds,[a.id,b.id]);assert.equal((await f.read(task.id)).sourceMessages[0].body,'用户实际要求');
});
