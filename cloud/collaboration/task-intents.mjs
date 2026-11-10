import {digest,fail} from './repository.mjs';
import {childrenOf} from './task-groups.mjs';

// Interpretation belongs to the native Agent. This module records its decision,
// sources and revisions atomically; it does not guess intent from keywords.
export const intentActions=['plan','associate','revise','merge'];
const who=a=>a.owner?'owner':a.memberId;
const closed=t=>['done','canceled'].includes(t.status);
export async function canonicalTask(repo,channelId,taskId){
 const seen=new Set();let task;
 while(taskId){
  if(seen.has(taskId))fail('invalid_task','任务合并关联成环');seen.add(taskId);
  task=await repo.get('channel_task',taskId);
  if(task.scopeId!==channelId)fail('forbidden','任务不属于本群',403);
  if(!task.mergedInto)return task;taskId=task.mergedInto;
 }
 return task;
}
function intentValue(v){
 if(!v||typeof v!=='object'||Array.isArray(v)||JSON.stringify(v).length>12000||typeof v.goal!=='string'||!v.goal.trim())fail('invalid_input','intent 需要 goal，其余内容按本次任务自定，最多12000字符');
 return {...v,goal:v.goal.trim()};
}
async function messages(tx,channel,ids){
 if(!Array.isArray(ids)||ids.length>100||ids.some(x=>typeof x!=='string'))fail('invalid_input','messageIds 最多100条本群消息');
 const out=[];
 for(const mid of new Set(ids)){const m=await tx.get('channel_message',mid);if(m.scopeId!==channel.id||m.hidden)fail('forbidden','来源消息不可访问',403);out.push(m);}
 return out;
}
export async function taskIntentCommand(tx,identity,actor,raw,channel,helpers,{save,run,basisSources}){
 // Old native MCP catalogs already expose action:string and body:string.
 let cmd=raw;
 if(raw.body?.trim().startsWith('{')){let value;try{value=JSON.parse(raw.body);}catch{fail('invalid_input','结构化任务 body 不是有效 JSON');}cmd={...value,...raw,body:value.body};}
 let task=cmd.taskId?await canonicalTask(tx,channel.id,cmd.taskId):null;
 if(task&&cmd.expectedVersion!==task.version)fail('version_conflict','任务已更新，请 read_todo 当前任务后重试',409);
 if(task&&!actor.owner&&who(actor)!==channel.coordinatorId&&who(actor)!==task.assigneeId&&who(actor)!==task.authorId&&cmd.action!=='associate')fail('forbidden','由任务负责人维护意图和计划',403);
 const sources=await messages(tx,channel,cmd.messageIds|| (cmd.sourceMessageId?[cmd.sourceMessageId]:[]));
 if(cmd.action==='plan'){
  if(task)fail('invalid_input','已有任务用 revise，不重复 plan');
  const intent=intentValue(cmd.intent);
  task=await run({...cmd,action:'create',intent:undefined,title:cmd.title||intent.goal.slice(0,150),body:cmd.body||intent.goal,assigneeId:cmd.assigneeId||(!actor.owner?who(actor):channel.coordinatorId),sourceMessageId:sources[0]?.id,notifyAssignee:cmd.notifyAssignee??false});
  task=await save(tx,'channel_task',{...task,intent,intentVersion:1,intentSourceIds:sources.map(m=>m.id),managedIntent:true},task,actor,'记录理解并自动推进');
 }else if(!task)fail('invalid_input','请选择已有任务');
 if(cmd.action==='merge'){
  const target=await canonicalTask(tx,channel.id,cmd.targetTaskId);
  if(!target||target.id===task.id||task.parentTaskId||target.parentTaskId)fail('invalid_merge','只合并同群的独立任务，不能合并到自己');
  if(cmd.targetVersion!==target.version)fail('version_conflict','合入任务已有更新，请读取后重试',409);
  if(closed(target)||task.status==='canceled')fail('task_closed','先明确重新打开目标任务再合并',409);
  if(!actor.owner&&who(actor)!==channel.coordinatorId&&who(actor)!==target.assigneeId&&who(actor)!==target.authorId)fail('forbidden','无权合并目标任务',403);
  // Preserve every old ID/result/receipt. The former root becomes a contribution
  // under the surviving task; late submissions still land on the original ID.
  const children=await childrenOf(tx,task.id);
  for(const child of children)await save(tx,'channel_task',{...child,parentId:target.id,parentTaskId:target.id},child,actor,'合并所属任务，保留成果');
  await save(tx,'channel_task',{...task,parentId:target.id,parentTaskId:target.id,mergedInto:target.id,mergeReason:cmd.reason||'同一交付目标'},task,actor,cmd.reason||'合并任务');
  task=await save(tx,'channel_task',{...target,managedIntent:true,intentSourceIds:[...new Set([...(target.intentSourceIds||[]),...(task.intentSourceIds||[]),...sources.map(m=>m.id)])],mergedTaskIds:[...new Set([...(target.mergedTaskIds||[]),task.id])],acceptedSubmissionId:null,executionDecision:null},target,actor,'合并后继续核对最终交付');
 }else if(cmd.action==='revise'){
  const intent=cmd.intent===undefined?task.intent:intentValue(cmd.intent);
  if(!intent)fail('invalid_input','请提供本次任务理解 intent');
  const changes=cmd.changes||[];
  if(!Array.isArray(changes)||changes.length>100)fail('invalid_input','changes 最多100个受影响节点');
  const seen=new Set();
  for(const change of changes){
   if(!change||typeof change!=='object'||seen.has(change.taskId))fail('invalid_input','受影响节点不能重复');seen.add(change.taskId);
   const node=await tx.get('channel_task',change.taskId);
   if(node.id!==task.id&&node.parentTaskId!==task.id)fail('forbidden','只能调整本任务节点',403);
   if(change.action&&!['configure','update'].includes(change.action))fail('invalid_action','节点调整只使用 configure 或 update');
   await run({...change,action:change.action||'configure',taskId:node.id,expectedVersion:change.expectedVersion,channelId:channel.id});
  }
  task=await tx.get('channel_task',task.id);
  const requirementSources=(await basisSources(tx,channel,task)).map(m=>({id:m.id,version:m.version}));
  const changed=JSON.stringify(task.intent)!==JSON.stringify(intent)||JSON.stringify(task.requirementSources)!==JSON.stringify(requirementSources);
  task=await save(tx,'channel_task',{...task,intent,requirementSources,intentVersion:(task.intentVersion||0)+1,managedIntent:true,intentSourceIds:[...new Set([...(task.intentSourceIds||[]),...sources.map(m=>m.id)])],...(changed?{acceptedSubmissionId:null,executionDecision:null,status:task.status==='done'?'doing':task.status,completedAt:null,completedBy:null,workSpec:task.workSpec?{...task.workSpec,version:task.workSpec.version+1,expectedOutcome:intent.goal}:task.workSpec}:{}),...(cmd.progress!==undefined?{progress:String(cmd.progress).slice(0,12000)}:{})},task,actor,cmd.reason||'按补充调整理解及受影响节点');
 }else if(cmd.action==='associate'){
  if(!sources.length)fail('invalid_input','请指定要关联的 messageIds');
  if(cmd.fromTaskId){
   const previous=await canonicalTask(tx,channel.id,cmd.fromTaskId);
   if(previous.id===task.id||previous.version!==cmd.fromVersion)fail('version_conflict','原归属已有变化，请读取后重新关联',409);
   if(!actor.owner&&who(actor)!==channel.coordinatorId&&who(actor)!==previous.assigneeId&&who(actor)!==previous.authorId)fail('forbidden','由原任务负责人调整归属',403);
   const moved=new Set(sources.map(m=>m.id));
   await save(tx,'channel_task',{...previous,intentSourceIds:(previous.intentSourceIds||[]).filter(mid=>!moved.has(mid))},previous,actor,cmd.reason||'纠正消息归属，历史保留');
   for(const m of sources){m.taskIds=(m.taskIds||[]).filter(tid=>tid!==previous.id);if(m.taskId===previous.id){m.taskId=task.id;m.taskCard={action:'supplement',intent:task.intent||{goal:task.title},intentVersion:task.intentVersion||1};}}
  }
  task=await save(tx,'channel_task',{...task,intentSourceIds:[...new Set([...(task.intentSourceIds||[]),...sources.map(m=>m.id)])]},task,actor,cmd.reason||'关联消息，保留有效成果');
 }
 for(const m of sources){
  // One message may legitimately cover several deliverables. Reassociation is
  // explicit, never silent replacement of another task's source/history.
  tx.put('channel_message',{...m,taskIds:[...new Set([...(m.taskIds||[]),task.id])]});
 }
 const card=await helpers.channelMessage(tx,channel,actor,cmd.reason||({plan:'我理解要完成的是',associate:'已关联到任务',revise:'按补充继续推进',merge:'合并同一目标'}[cmd.action])+`：${task.intent?.goal||task.title}`,{type:'task_intent',taskId:task.id,taskCard:{action:cmd.action,intent:task.intent||{goal:task.title},intentVersion:task.intentVersion||1},refs:[{kind:'task',id:task.id,version:task.version,title:task.title,channelId:channel.id}],hops:0});
 const changedIds=(cmd.changes||[]).map(c=>c.taskId),recipients=new Set();
 if(cmd.action!=='plan'||cmd.notifyAssignee===true){const leader=task.assigneeId||channel.coordinatorId;if(leader)recipients.add(leader);}
 for(const tid of changedIds){const node=await tx.get('channel_task',tid);if(node.assigneeId&&!closed(node))recipients.add(node.assigneeId);}
 card.taskIds=[...new Set([task.id,...changedIds])];card.recipientIds=[...recipients].filter(mid=>mid!==who(actor)&&mid!=='owner'&&channel.memberIds.includes(mid));tx.put('channel_message',card);
 for(const mid of card.recipientIds)await helpers.enqueue(tx,identity,channel,card,mid);
 return {...task,cardMessageId:card.id};
}

// The owner selected a task explicitly (sidebar or composer reference). Persist
// the supplement with the chat message in the same transaction, without
// invalidating work or changing the message's explicit recipient selection.
export async function bindMessageTasks(tx,channel,message,parent){
 const ids=[...new Set([...(message.refs||[]).filter(r=>r.kind==='task').map(r=>r.id),...(parent?.taskIds||[]),...(parent?.taskId?[parent.taskId]:[])])];
 const tasks=[];
 for(const tid of ids){const t=await canonicalTask(tx,channel.id,tid);if(t&&!tasks.some(x=>x.id===t.id))tasks.push(t);if(t?.parentTaskId){const parentTask=await canonicalTask(tx,channel.id,t.parentTaskId);if(parentTask&&!tasks.some(x=>x.id===parentTask.id))tasks.push(parentTask);}}
 if(tasks.length){
  message.taskIds=tasks.map(t=>t.id);tx.put('channel_message',message);
  if(message.authorId==='owner'&&(message.refs||[]).some(r=>r.kind==='task')){
   const task=tasks[0];message.taskId=task.id;message.taskCard={action:'supplement',intent:task.intent||{goal:task.title},intentVersion:task.intentVersion||1};tx.put('channel_message',message);
  }
  if(message.authorId==='owner')for(const task of tasks){
   const next={...task,intentSourceIds:[...new Set([...(task.intentSourceIds||[]),message.id])],version:(task.version||1)+1,lastEditorId:'owner',updatedAt:tx.now};
   tx.put('channel_task',next);tx.put('channel_task_version',{...next,id:task.id+':'+next.version,parentId:task.id,reason:'用户补充，保留有效工作并交由成员判断影响',createdAt:tx.now});
  }
 }
 return tasks;
}

// Actual associated work returns to its leader even if a cached client omitted
// purpose=result or mentions. Ordinary owner messages retain default routing.
export function taskFeedbackTargets(tasks,channel,message){
 if(message.authorId==='owner'||message.purpose==='question')return [];
 return [...new Set(tasks.filter(t=>t.managedIntent).map(t=>t.assigneeId||channel.coordinatorId).filter(mid=>mid&&mid!=='owner'&&mid!==message.authorId&&channel.memberIds.includes(mid)))];
}

// A reply acknowledges an inbox item, not the ongoing task. Resume only actual
// runnable work, once per durable task/node revision. Waiting on other members
// produces no polling turn, and a no-progress reply cannot create a wake loop.
export async function continueTaskWork(tx,identity,actor,channel,tasks,helpers,basis){
 if(actor.owner)return;
 for(const task of tasks){
  if(!task.managedIntent||task.parentTaskId||closed(task)||task.status==='blocked'||task.assigneeId!==actor.memberId)continue;
  const children=await childrenOf(tx,task.id),open=children.filter(t=>!closed(t));
  const ready=[];
  for(const t of open)if(t.assigneeId===actor.memberId&&t.status!=='blocked'&&(await basis(tx,t)).valid)ready.push(t);
  if(open.length&&!ready.length)continue;
  const stamp=[task,...ready].map(t=>t.id+':'+t.version).sort().join('|'),key=task.id+':continue:'+await digest(stamp);
  if(await tx.get('channel_task_followup',key,false))continue;
  const message=await helpers.channelMessage(tx,channel,actor,'任务仍在推进：'+task.title+'。本次回复只结束通知；请按最新要求继续可做节点，完成后提交实际结果。等待其他成员时无需轮询，回传会再次唤醒。',{hidden:true,type:'todo',taskId:task.id,taskEvent:'continue:'+await digest(stamp),taskIds:[task.id,...ready.map(t=>t.id)],hops:0});
  tx.put('channel_task_followup',{id:key,scopeId:channel.id,parentId:task.id,memberId:actor.memberId,messageId:message.id,status:'pending',createdAt:tx.now});
  await helpers.enqueue(tx,identity,channel,message,actor.memberId);
 }
}
