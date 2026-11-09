import {digest,fail,id,required} from './repository.mjs';
import {childrenOf,validateTaskGroup} from './task-groups.mjs';
import {bindTaskSkills} from './skill-bindings.mjs';
import {workspaceGrant} from './delegation.mjs';
import {recordMemoryEvent} from './memory-context.mjs';

// The wire shape is stable. Business sections and questions belong to this task,
// never to a global per-scenario schema or an extra model invocation.
const object={type:'object',additionalProperties:true};
export const taskDeliveryProperties={workSpec:object,dependsOn:{type:'array',items:{type:'string'},maxItems:100},coordinationRef:object,submission:object,selfCheck:object,submissionId:{type:'string'},workSpecVersion:{type:'integer',minimum:1},criterionResults:{type:'array',items:object,maxItems:100},verdict:{type:'string',enum:['accept','changes_requested']},reason:{type:'string'},executionDecision:object};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// JSON object key order is not a new business deliverable. Array order remains
// meaningful (sections, tables), while retries with reordered object keys dedupe.
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const duplicate=(old,data,fingerprint)=>old&&(old.fingerprint===fingerprint||same(canonical(Object.fromEntries(Object.keys(data).map(k=>[k,old[k]]))),canonical(data)));
const terminal=t=>['done','canceled'].includes(t.status);
const who=a=>a.owner?'owner':a.memberId;
function str(v,path,max=12000,optional=false){
 if(optional&&(v===undefined||v===null))return '';
 if(typeof v!=='string'||(!optional&&!v.trim())||v.length>max)fail('invalid_input',`${path}：请提供${max}字以内${optional?'':'的非空'}文本`);
 return v.trim();
}
function array(v,path,max=100){if(!Array.isArray(v)||v.length>max)fail('invalid_input',`${path}：最多${max}项`);return v;}
function record(v,path){if(!v||typeof v!=='object'||Array.isArray(v))fail('invalid_input',`${path}：需要对象`);return v;}
function keys(v,allowed,path){record(v,path);for(const k of Object.keys(v))if(!allowed.includes(k))fail('invalid_input',`${path}.${k}：不支持的字段`);}
const identityRefs={document:'channel_doc',file:'shared_file',memory:'channel_memory',task:'channel_task',message:'channel_message',meeting:'channel_meeting',link:'channel_link'};
export async function currentTaskBasis(repo,task,seen=new Set()){
 if(seen.has(task.id))return {valid:false,gaps:['依赖循环']};
 seen=new Set([...seen,task.id]);
 const gaps=[],inputs=[];
 if(task.requirementSources&&!same(task.requirementSources,(await sourceMessages(repo,{id:task.scopeId},task)).map(m=>({id:m.id,version:m.version}))))gaps.push('原始用户要求已有变化，请 configure 核对当前要求');
 for(const ref of task.workSpec?.basisRefs||[]){
  const current=await repo.get(identityRefs[ref.kind],ref.id,false);
  if(!current||current.scopeId!==task.scopeId||current.hidden||['deleted','inactive'].includes(current.status)||(current.version||1)!==ref.version)gaps.push(`来源已变化：${ref.title||ref.id}`);
 }
 let requirementVersion=null;
 if(task.coordinationRef){const r=await repo.get('channel_coordination',task.coordinationRef.id,false);requirementVersion=r?.requirementVersion;
  if(!r||r.scopeId!==task.scopeId||r.status==='canceled')gaps.push('关联需求已停止或不可访问');
  else if(requirementVersion!==task.coordinationRef.requirementVersion)gaps.push('用户要求已有新版，请更新交付约定');
 }
 for(const depId of task.dependsOn||[]){
  const dep=await repo.get('channel_task',depId,false);
  if(!dep||dep.scopeId!==task.scopeId||dep.parentTaskId!==task.parentTaskId||dep.status!=='done'||!dep.acceptedSubmissionId){gaps.push(`前置成果尚未通过：${dep?.title||depId}`);continue;}
  const state=await taskDelivery(repo,dep,{seen});
  if(!state.valid)gaps.push(`前置成果需复核：${dep.title}`);
  inputs.push({taskId:dep.id,submissionId:dep.acceptedSubmissionId,workSpecVersion:dep.workSpec.version});
 }
 // A final task implicitly consumes its completed Todos. Preserve the exact
 // accepted inputs so later artifact changes cannot leave the aggregate valid.
 if(!task.parentTaskId)for(const child of await childrenOf(repo,task.id)){
  if(!child.workSpec||child.status!=='done')continue;
  if(!(await taskDelivery(repo,child,{seen})).valid)gaps.push(`子项成果需复核：${child.title}`);
  inputs.push({taskId:child.id,submissionId:child.acceptedSubmissionId,workSpecVersion:child.workSpec.version});
 }
 return {valid:!gaps.length,gaps,inputs,requirementVersion};
}
export async function taskDelivery(repo,task,{seen=new Set(),historical=false}={}){
 if(!task.workSpec)return {stage:'legacy',label:'历史任务',valid:false,gaps:[],nextAction:'历史记录未补造核对；需要接续时 configure 交付约定'};
 const submission=task.currentSubmissionId?await repo.get('channel_task_submission',task.currentSubmissionId,false):null;
 const check=task.currentCheckId?await repo.get('channel_task_check',task.currentCheckId,false):null;
 const basis=historical?{valid:true,gaps:[],inputs:submission?.inputs||[],requirementVersion:submission?.requirementVersion}:await currentTaskBasis(repo,task,seen);
 const gaps=[...basis.gaps];
 if(submission){
  if(submission.workSpecVersion!==task.workSpec.version)gaps.push('成果基于旧交付约定');
  if(!same(submission.inputs,basis.inputs))gaps.push('上游成果已有变化');
  if(submission.requirementVersion!==basis.requirementVersion)gaps.push('成果基于旧需求');
  if(!historical&&submission.sourceVersions&&!same(submission.sourceVersions,(await sourceMessages(repo,{id:task.scopeId},task)).map(m=>({id:m.id,version:m.version}))))gaps.push('原始要求已编辑，请核对当前原话');
  if(!historical)for(const ref of submission.refs||[]){const r=await repo.get(identityRefs[ref.kind],ref.id,false);if(!r||r.scopeId!==task.scopeId||r.hidden||r.status==='deleted'||(r.version||1)!==ref.version)gaps.push(`产物已有新版或不可访问：${ref.title||ref.id}`);}
  for(const criterion of task.workSpec.criteria.filter(c=>c.required))if(!submission.coverage.some(c=>c.id===criterion.id&&c.location&&!c.gap))gaps.push(`成果未覆盖：${criterion.text}`);
 }
 const valid=!!submission&&check?.verdict==='accept'&&check.submissionId===submission.id&&check.workSpecVersion===task.workSpec.version&&task.acceptedSubmissionId===submission.id&&!gaps.length;
 const stage=gaps.length?'stale':!submission?'pending':check?.submissionId===submission.id&&check.verdict==='changes_requested'?'changes_requested':valid?'accepted':'review';
 return {stage,label:{stale:'需复核',pending:'待提交',changes_requested:'需补充',accepted:'已通过',review:'待核对'}[stage],valid,gaps,submission,check,nextAction:gaps.length?'读取原要求与当前产物，处理列出的缺口后重新提交':valid?'接续相关工作；任务最终交付仍需单独核对':stage==='pending'?'提交成果；普通事项可同时 selfCheck':stage==='changes_requested'?'按核对意见补充后提交新版':'由实际核对人 check 当前成果'};
}
export async function enrichTask(repo,task,options){return {...task,delivery:await taskDelivery(repo,task,options)};}
export async function taskTurnAllowed(tx,turn){
 if(!turn.taskId||!turn.taskEvent)return true;
 const task=await tx.get('channel_task',turn.taskId,false);
 if(!task||task.status==='canceled')return false;
 if(turn.taskEvent.startsWith('review:'))return turn.taskEvent==='review:'+task.currentSubmissionId&&task.status!=='done';
 if(turn.taskEvent.startsWith('check:'))return turn.taskEvent==='check:'+task.currentCheckId;
 if(turn.taskEvent.startsWith('ready:')){const check=await tx.get('channel_task_check',turn.taskEvent.slice(6),false);const upstream=check?await tx.get('channel_task',check.taskId,false):null;if(!upstream||upstream.currentCheckId!==check.id||!(await taskDelivery(tx,upstream)).valid)return false;}
 return !terminal(task)&&(await currentTaskBasis(tx,task)).valid;
}
export async function invalidateCoordinationTasks(tx,channel,coordination){
 let after='';
 for(;;){const page=await tx.list('channel_task',{scope:channel.id,after,limit:500,page:true});for(const task of page){
  if(task.coordinationRef?.id!==coordination.id||task.status==='canceled')continue;
  const next={...task,status:task.status==='done'?'todo':task.status,acceptedSubmissionId:null,executionDecision:null,completedAt:null,completedBy:null,reviewReason:'用户要求已有新版，请核对受影响部分',version:(task.version||1)+1,updatedAt:tx.now};
  tx.put('channel_task',next);tx.put('channel_task_version',{...next,id:task.id+':'+next.version,parentId:task.id,reason:next.reviewReason,createdAt:tx.now});
  if(task.parentTaskId){const parent=await tx.get('channel_task',task.parentTaskId);if(parent.status==='done'){const p={...parent,status:'todo',acceptedSubmissionId:null,executionDecision:null,completedAt:null,completedBy:null,version:(parent.version||1)+1,updatedAt:tx.now};tx.put('channel_task',p);tx.put('channel_task_version',{...p,id:p.id+':'+p.version,parentId:p.id,reason:next.reviewReason,createdAt:tx.now});}}
 }if(page.length<500)break;after=page.at(-1).id;}
}
async function dependencies(tx,channel,next){
 const all=new Map();let after='';
 for(;;){const page=await tx.list('channel_task',{scope:channel.id,after,limit:500,page:true});for(const t of page)all.set(t.id,t);if(page.length<500)break;after=page.at(-1).id;}
 all.set(next.id,next);
 for(const t of all.values())for(const depId of t.dependsOn||[]){
  const d=all.get(depId);if(!t.parentTaskId||!d||d.id===t.id||d.parentTaskId!==t.parentTaskId)fail('invalid_dependency','依赖只能连接同一任务下的同层 Todo；移动前请调整依赖');
 }
 const active=new Set(),done=new Set();
 function visit(t){if(active.has(t.id))fail('dependency_cycle','Todo 前置依赖不能成环');if(done.has(t.id))return;active.add(t.id);for(const d of t.dependsOn||[])visit(all.get(d));active.delete(t.id);done.add(t.id);}
 for(const t of all.values())visit(t);
}
async function normalizeSpec(tx,channel,value,old,validateRefs){
 keys(value,['version','expectedOutcome','criteria','commonQuestions','outputGuide','checkMode','reviewerId','independentReview','basisRefs'],'workSpec');
 const ids=new Set();
 const criteria=array(value.criteria,'workSpec.criteria').map((c,i)=>{keys(c,['id','text','required'],`criteria[${i}]`);const key=str(c.id,'criterion.id',100);if(ids.has(key))fail('invalid_input','完成条件和共同问题的 id 不能重复');ids.add(key);if(c.required!==undefined&&typeof c.required!=='boolean')fail('invalid_input','criterion.required 需要布尔值');return{id:key,text:str(c.text,'criterion.text',2000),required:c.required!==false};});
 if(!criteria.some(c=>c.required))fail('criteria_required','至少保留一项必要完成条件');
 const commonQuestions=array(value.commonQuestions||[],'workSpec.commonQuestions',50).map(q=>{keys(q,['id','text'],'question');const key=str(q.id,'question.id',100);if(ids.has(key))fail('invalid_input','完成条件和共同问题的 id 不能重复');ids.add(key);return{id:key,text:str(q.text,'question.text',2000)};});
 const checkMode=value.checkMode||'self';if(!['self','designated'].includes(checkMode))fail('invalid_input','workSpec.checkMode 无效');
 if(value.independentReview!==undefined&&typeof value.independentReview!=='boolean')fail('invalid_input','independentReview 需要布尔值');
 const reviewerId=checkMode==='designated'?str(value.reviewerId,'workSpec.reviewerId',200):null;
 if(reviewerId&&reviewerId!=='owner'&&!channel.memberIds.includes(reviewerId))fail('invalid_member','核对人须为本群成员或用户');
 if(value.independentReview&&checkMode!=='designated')fail('invalid_input','独立核对需要指定核对人');
 const spec={expectedOutcome:str(value.expectedOutcome,'workSpec.expectedOutcome',4000),criteria,commonQuestions,outputGuide:str(value.outputGuide,'workSpec.outputGuide',4000,true),checkMode,reviewerId,independentReview:!!value.independentReview,basisRefs:await validateRefs(tx,channel.id,value.basisRefs||[])};
 const {version,...prior}=old||{};return {...spec,version:version?version+(same(spec,prior)?0:1):1};
}
async function sourceMessages(tx,channel,task){
 const ids=new Set([...(task.sourceMessageIds||[]),...(task.sourceMessageId?[task.sourceMessageId]:[])]);
 if(task.coordinationRef){const r=await tx.get('channel_coordination',task.coordinationRef.id);for(const mid of r.requirementMessageIds||[r.sourceMessageId])ids.add(mid);}
 const out=[];for(const mid of ids){const m=await tx.get('channel_message',mid,false);if(m&&m.scopeId===channel.id&&!m.hidden)out.push({id:m.id,authorId:m.authorId,body:m.body,version:m.version||1});}
 return out;
}
export {sourceMessages as taskSourceMessages};
async function notify(tx,identity,channel,helpers,actor,task,memberId,event,body){
 if(!memberId||memberId==='owner'||memberId===who(actor)||!channel.memberIds.includes(memberId))return;
 const key=`${task.id}:${event}:${memberId}`;if(await tx.get('channel_task_followup',key,false))return;
 const message=await helpers.channelMessage(tx,channel,actor,body,{hidden:!event.startsWith('assigned:'),type:'todo',taskId:task.id,taskEvent:event,refs:[{kind:'task',id:task.id,version:task.version,title:task.title,channelId:channel.id}],mentions:[memberId],hops:0});
 tx.put('channel_task_followup',{id:key,scopeId:channel.id,parentId:task.id,memberId,messageId:message.id,status:'pending',createdAt:tx.now});
 await helpers.enqueue(tx,identity,channel,message,memberId);
 return message;
}
async function reopenParent(tx,next,save,actor){
 if(!next.parentTaskId)return;
 const p=await tx.get('channel_task',next.parentTaskId);
 if(p.status==='canceled')fail('task_closed','任务已取消，请先明确恢复任务',409);
 if(p.status==='done')await save(tx,'channel_task',{...p,status:'todo',completedAt:null,completedBy:null,acceptedSubmissionId:null,reviewReason:'子项按当前要求重新处理'},p,actor,'子项重新处理');
}
export async function taskCommand(tx,identity,actor,cmd,channel,helpers,{save,validateRefs}){
 const authorId=who(actor),action=cmd.action;
 if(!['create','update','accept','configure','submit','check','bind_execution_decision'].includes(action))fail('invalid_action','Todo 操作无效');
 const old=action==='create'?null:await tx.get('channel_task',cmd.taskId);
 if(old&&old.scopeId!==channel.id)fail('forbidden','Todo 不属于本群',403);
 const strict=['configure','submit','check','bind_execution_decision'].includes(action);
 if(old&&(strict||cmd.expectedVersion!==undefined)&&cmd.expectedVersion!==(old.version||1))fail('version_conflict','Todo 已更新，请 read_todo 后带当前 expectedVersion',409);
 const parentId=cmd.parentTaskId===undefined?old?.parentTaskId:cmd.parentTaskId;
 const parent=parentId?await tx.get('channel_task',parentId):null;
 if(parent&&parent.scopeId!==channel.id)fail('forbidden','所属任务须在本群',403);
 const manager=actor.owner||authorId===channel.coordinatorId||authorId===(old?.parentTaskId?parent?.assigneeId:null)||await workspaceGrant(tx,actor);
 const groupingOnly=old&&cmd.parentTaskId!==undefined&&Object.keys(cmd).every(k=>['type','requestId','channelId','action','taskId','parentTaskId','expectedVersion','reason','notifyAssignee'].includes(k))&&cmd.notifyAssignee!==true;
 const checker=action==='check'&&(authorId===old?.workSpec?.reviewerId||(old?.workSpec?.checkMode==='self'&&authorId===(old?.currentSubmissionId?await tx.get('channel_task_submission',old.currentSubmissionId,false):null)?.authorId));
 if(!manager&&!checker&&old?.assigneeId&&old.assigneeId!==authorId&&!(groupingOnly&&old.authorId===authorId))fail('forbidden','请由执行成员更新进度，核对人使用 check',403);
 if(action==='configure'&&!manager&&!(old.authorId===authorId&&!old.currentSubmissionId&&(!old.assigneeId||old.assigneeId===authorId)))fail('forbidden','交付约定由任务负责人或用户调整',403);
 if(action==='check'&&Object.keys(cmd).some(k=>!['type','requestId','channelId','action','taskId','expectedVersion','submissionId','workSpecVersion','criterionResults','verdict','reason'].includes(k)))fail('invalid_input','check 只记录核对，不能修改执行者或成果');
 const next={...old,id:old?.id||id('board'),scopeId:channel.id,parentId:channel.id,title:required(cmd.title??old?.title,'Todo 标题',1000),body:str(cmd.body??old?.body,'body',12000,true),status:cmd.status||old?.status||'todo',assigneeId:cmd.assigneeId===undefined?(old?.assigneeId||null):(cmd.assigneeId||null),authorId:old?.authorId||authorId,createdAt:old?.createdAt||tx.now};
 if(!['todo','doing','blocked','done','canceled'].includes(next.status))fail('invalid_status','Todo 状态无效');
 if(next.assigneeId&&!channel.memberIds.includes(next.assigneeId))fail('invalid_member','执行成员须在本群内');
 for(const k of ['progress','blocker','result','dueDate'])next[k]=str(cmd[k]??old?.[k],k,k==='dueDate'?40:12000,true);
 if(next.dueDate&&!/^\d{4}-\d{2}-\d{2}$/.test(next.dueDate))fail('invalid_date','日期格式无效');
 if(next.status==='blocked'&&!next.blocker)fail('blocker_required','请说明卡在哪里');
 next.refs=cmd.refs===undefined?(old?.refs||[]):await validateRefs(tx,channel.id,cmd.refs);
 next.meetingIds=[...new Set(array(cmd.meetingIds??old?.meetingIds??[],'meetingIds',20))];
 for(const mid of next.meetingIds){const m=await tx.get('channel_meeting',mid);if(m.scopeId!==channel.id)fail('forbidden','会议不属于本群',403);}
 if(cmd.sourceMessageId!==undefined){const m=await tx.get('channel_message',cmd.sourceMessageId);if(m.scopeId!==channel.id||m.hidden)fail('forbidden','原消息不在本群',403);next.sourceMessageId=m.id;}
 if(cmd.coordinationRef!==undefined){if(!manager)fail('forbidden','需求关联由负责人调整',403);keys(cmd.coordinationRef,['id','requirementVersion'],'coordinationRef');const r=await tx.get('channel_coordination',cmd.coordinationRef.id);if(r.scopeId!==channel.id||r.requirementVersion!==cmd.coordinationRef.requirementVersion)fail('version_conflict','请关联本群当前要求',409);next.coordinationRef={id:r.id,requirementVersion:r.requirementVersion};}
 if(!next.coordinationRef&&parent?.coordinationRef)next.coordinationRef=parent.coordinationRef;
 if(!next.sourceMessageId&&parent?.sourceMessageId)next.sourceMessageId=parent.sourceMessageId;
 next.sourceMessageIds=[...new Set([...(old?.sourceMessageIds||[]),...(old?.sourceMessageId?[old.sourceMessageId]:[]),...(next.sourceMessageId?[next.sourceMessageId]:[])])];
 if(cmd.workSpec!==undefined&&!['create','configure'].includes(action))fail('invalid_action','请用 configure 调整交付约定，不能清除既有检查');
 if(cmd.workSpec!==undefined)next.workSpec=await normalizeSpec(tx,channel,cmd.workSpec,old?.workSpec,validateRefs);
 else if(!old||action==='configure'&&!old.workSpec||!old?.workSpec&&parent?.workSpec&&!terminal(old))next.workSpec=await normalizeSpec(tx,channel,{expectedOutcome:next.title,criteria:[{id:'outcome',text:next.title,required:true}],basisRefs:next.refs},null,validateRefs);
 if(cmd.body!==undefined&&old?.workSpec&&cmd.body!==old.body&&cmd.workSpec===undefined){next.workSpec={...old.workSpec,version:old.workSpec.version+1,expectedOutcome:next.body||next.title};next.reviewReason='工作说明已更新，请核对完成条件';}
 next.dependsOn=cmd.dependsOn===undefined?(old?.dependsOn||[]):[...new Set(array(cmd.dependsOn,'dependsOn'))].sort();
 if(cmd.dependsOn!==undefined&&!['create','configure'].includes(action))fail('invalid_action','请用 configure 调整前置依赖');
 if(old?.status==='canceled'&&strict)fail('task_closed','已取消任务不会自动恢复，请先明确重新打开',409);
 if(next.workSpec&&(!old||action==='configure'||cmd.sourceMessageId!==undefined||cmd.coordinationRef!==undefined))next.requirementSources=(await sourceMessages(tx,channel,next)).map(m=>({id:m.id,version:m.version}));
 if(old?.workSpec&&!same(next.requirementSources,old.requirementSources)&&next.workSpec.version===old.workSpec.version)next.workSpec={...next.workSpec,version:old.workSpec.version+1};
 const specChanged=!!old?.workSpec&&(!same(next.workSpec,old.workSpec)||!same(next.dependsOn,old.dependsOn||[])||!same(next.coordinationRef,old.coordinationRef)||!same(next.requirementSources,old.requirementSources));
 if(specChanged){next.acceptedSubmissionId=null;next.executionDecision=null;if(next.status==='done'){next.status='todo';await reopenParent(tx,{...next,parentTaskId:old.parentTaskId},save,actor);}}
 if(old?.acceptedSubmissionId&&((cmd.status&&cmd.status!==old.status&&cmd.status!=='done')||(cmd.result!==undefined&&cmd.result!==old.result)||(next.assigneeId!==old.assigneeId&&old.workSpec?.independentReview))){next.acceptedSubmissionId=null;next.executionDecision=null;if(next.status==='done')next.status='doing';}
 if(next.assigneeId!==old?.assigneeId){next.acceptedAt=null;next.acceptedBy=null;}
 if(next.workSpec?.independentReview&&next.workSpec.reviewerId===next.assigneeId)fail('invalid_member','独立核对人不能与执行成员相同');
 next.parentTaskId=parentId||null;
 await dependencies(tx,channel,next);
 const basis=next.workSpec?await currentTaskBasis(tx,next):{valid:true,gaps:[],inputs:[],requirementVersion:null};
 if((action==='accept'||next.status==='doing'&&old?.status!=='doing')&&!basis.valid)fail('task_not_ready',basis.gaps.join('；'),409);
 if(action==='accept'||(!actor.owner&&next.status==='doing'&&old?.status!=='doing')){if(actor.owner||next.assigneeId&&next.assigneeId!==authorId)fail('forbidden','只有实际执行成员可以接手',403);next.assigneeId=authorId;next.status='doing';next.acceptedAt=next.acceptedAt||tx.now;next.acceptedBy=authorId;}
 const legacyDone=next.workSpec&&cmd.status==='done'&&(old?.status!=='done'||cmd.result!==undefined&&cmd.result!==old?.result);
 let submitted=false,checked=false;
 if(action==='submit'||legacyDone){
  if(action==='submit'&&cmd.workSpecVersion!==next.workSpec?.version)fail('version_conflict','请按当前 workSpecVersion 提交',409);
  if(!next.workSpec)fail('work_spec_required','请先 configure 交付约定');
  if(!basis.valid)fail('task_not_ready',basis.gaps.join('；'),409);
  if(!actor.owner&&next.assigneeId&&authorId!==next.assigneeId)fail('forbidden','成果应由实际执行成员提交',403);
  const input=action==='submit'?record(cmd.submission,'submission'):{body:next.result,refs:next.refs,coverage:[]};
  keys(input,['body','sections','data','refs','coverage','codeRef'],'submission');
  const body=str(input.body,'submission.body',24000,true),refs=await validateRefs(tx,channel.id,input.refs||[]);
  if(JSON.stringify(input).length>48000)fail('payload_too_large','成果超过48000字符，请使用文档或文件引用');
  if(!body&&!refs.length&&!input.sections?.length&&!Object.keys(input.data||{}).length&&!input.codeRef)fail('result_required','请提供实际成果正文或可访问原件');
  if(input.sections!==undefined)array(input.sections,'submission.sections',40).forEach(s=>{keys(s,['id','title','body'],'section');str(s.id,'section.id',100);str(s.title,'section.title',500);str(s.body,'section.body',12000);});
  if(input.data!==undefined)record(input.data,'submission.data');
  let codeRef=null;if(input.codeRef){keys(input.codeRef,['repository','commit','path'],'codeRef');let u;try{u=new URL(input.codeRef.repository);}catch{fail('invalid_input','codeRef.repository 需要HTTPS仓库地址');}if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!/^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(input.codeRef.commit))fail('invalid_input','codeRef 需要不含凭证的HTTPS地址和完整提交哈希');codeRef={repository:u.href,commit:input.codeRef.commit,path:str(input.codeRef.path,'codeRef.path',1000,true)};}
  const ids=new Set([...next.workSpec.criteria,...next.workSpec.commonQuestions].map(c=>c.id)),used=new Set();
  const coverage=array(input.coverage||[],'submission.coverage',150).map(c=>{keys(c,['id','location','gap'],'coverage');if(!ids.has(c.id)||used.has(c.id))fail('invalid_input','coverage.id 必须唯一且属于本次条件或共同问题');used.add(c.id);return{id:c.id,location:str(c.location,'coverage.location',2000,true),gap:str(c.gap,'coverage.gap',2000,true)};});
  const data={taskId:next.id,workSpecVersion:next.workSpec.version,requirementVersion:basis.requirementVersion,sourceVersions:(await sourceMessages(tx,channel,next)).map(m=>({id:m.id,version:m.version})),inputs:basis.inputs,body,sections:input.sections||[],data:input.data||null,refs,codeRef,coverage,authorId};
  const fingerprint=await digest(JSON.stringify(canonical(data))),previous=old?.currentSubmissionId?await tx.get('channel_task_submission',old.currentSubmissionId,false):null;
  if(duplicate(previous,data,fingerprint)){if(!cmd.selfCheck)return enrichTask(tx,old);next.currentSubmissionId=previous.id;}
  else {const submission=tx.put('channel_task_submission',{...data,id:id('submission'),scopeId:channel.id,parentId:next.id,fingerprint,supersedes:old?.currentSubmissionId||null,createdAt:tx.now});next.currentSubmissionId=submission.id;next.currentCheckId=null;next.acceptedSubmissionId=null;next.executionDecision=null;submitted=true;}
  next.status='doing';next.result=body||refs.map(r=>r.title).join('、')||'成果见提交记录';
  if(old?.status==='done')await reopenParent(tx,{...next,parentTaskId:old.parentTaskId},save,actor);
 }
 const checkInput=action==='check'?cmd:cmd.selfCheck;
 if(checkInput){
  if(!next.workSpec)fail('work_spec_required','请先 configure 交付约定');
  if(action!=='check'&&action!=='submit')fail('invalid_action','selfCheck 只能随 submit 使用');
  if(action!=='check')keys(checkInput,['criterionResults','verdict','reason'],'selfCheck');
  if(action==='check'&&(cmd.submissionId!==next.currentSubmissionId||cmd.workSpecVersion!==next.workSpec.version))fail('version_conflict','请核对当前提交和交付约定',409);
  const submission=next.currentSubmissionId?await tx.get('channel_task_submission',next.currentSubmissionId,false):null;if(!submission)fail('submission_required','尚未提交成果');
  const spec=next.workSpec,allowed=actor.owner&&!spec.independentReview||(spec.checkMode==='self'?authorId===submission.authorId:authorId===spec.reviewerId);
  if(!allowed||spec.independentReview&&authorId===submission.authorId)fail('forbidden','请由约定的实际核对人检查；自检不能冒充独立核对',403);
  if(!['accept','changes_requested'].includes(checkInput.verdict))fail('invalid_input','请明确 accept 或 changes_requested');
  const reason=str(checkInput.reason,'check.reason',6000),ids=new Set(),criterionResults=array(checkInput.criterionResults||[],'criterionResults').map(c=>{keys(c,['id','result','evidence'],'criterionResults');if(!spec.criteria.some(x=>x.id===c.id)||ids.has(c.id)||!['met','not_met','unknown'].includes(c.result))fail('invalid_input','核对条目需要唯一条件ID及 met/not_met/unknown');ids.add(c.id);return{id:c.id,result:c.result,evidence:str(c.evidence,'criterionResults.evidence',4000)};});
  if(checkInput.verdict==='accept'){
   const state=await taskDelivery(tx,{...next,acceptedSubmissionId:null});
   if(state.gaps.length)fail('check_incomplete',state.gaps.join('；'),409);
   if(spec.criteria.some(c=>c.required&&!criterionResults.some(r=>r.id===c.id&&r.result==='met')))fail('check_incomplete','必要条件存在未满足或未知项；不能接受',409);
  }
  const data={taskId:next.id,submissionId:submission.id,workSpecVersion:spec.version,requirementVersion:submission.requirementVersion,verdict:checkInput.verdict,reason,criterionResults,authorId};
  const fingerprint=await digest(JSON.stringify(canonical(data))),prior=next.currentCheckId?await tx.get('channel_task_check',next.currentCheckId,false):null;
  if(duplicate(prior,data,fingerprint))return enrichTask(tx,old);
  const check=tx.put('channel_task_check',{...data,id:id('check'),scopeId:channel.id,parentId:next.id,fingerprint,createdAt:tx.now});next.currentCheckId=check.id;checked=true;
  next.acceptedSubmissionId=check.verdict==='accept'?submission.id:null;next.status=check.verdict==='accept'?'done':'doing';
 }
 if(action==='bind_execution_decision'){
  keys(cmd.executionDecision,['proposalSubmissionId','proposalWorkSpecVersion','sourceOwnerMessageId','scopeSummary'],'executionDecision');
  const d=cmd.executionDecision,state=await taskDelivery(tx,next);
  if(!state.valid||d.proposalSubmissionId!==next.acceptedSubmissionId||d.proposalWorkSpecVersion!==next.workSpec.version)fail('version_conflict','执行决定须关联当前已核对的具体提案',409);
  if(!actor.owner){const message=d.sourceOwnerMessageId?await tx.get('channel_message',d.sourceOwnerMessageId,false):null;if(!message||message.scopeId!==channel.id||message.authorId!=='owner'||message.hidden)fail('owner_decision_required','请关联真实用户决定消息，不能自行授予执行授权',403);}
  next.executionDecision={proposalSubmissionId:d.proposalSubmissionId,proposalWorkSpecVersion:next.workSpec.version,sourceOwnerMessageId:d.sourceOwnerMessageId||null,scopeSummary:str(d.scopeSummary,'executionDecision.scopeSummary',4000),decidedBy:'owner',recordedBy:authorId,recordedAt:tx.now};
 }
 if(old&&!groupingOnly&&!checked&&!submitted&&authorId!==channel.coordinatorId){const feedback=await helpers.channelMessage(tx,channel,actor,`待办更新：${next.title} · ${next.status}`,{type:'todo',taskId:next.id,hidden:true,hops:0});await helpers.objectFeedback(tx,identity,channel,actor,{kind:'task',id:next.id,version:(old.version||1)+1},feedback,helpers);}
 if(!next.workSpec&&next.status==='done'&&!next.result)fail('result_required','请提供具体结果');
 // Unrelated metadata edits preserve accepted state. A legacy done call can save
 // a submission, but cannot manufacture a check or clear the adopted protocol.
 if(next.workSpec&&next.status==='done'&&!(await taskDelivery(tx,next)).valid)next.status='doing';
 if(old?.status==='done'&&!terminal(next))await reopenParent(tx,{...next,parentTaskId:old.parentTaskId},save,actor);
 await validateTaskGroup(tx,channel,next,old,cmd);
 if(next.status==='done')for(const child of await childrenOf(tx,next.id))if(child.workSpec&&child.status!=='canceled'&&!(await taskDelivery(tx,child)).valid)fail('unfinished_todos','还有需要复核的 Todo 成果',409);
 await bindTaskSkills(tx,actor,channel,next,old,cmd);
 next.completedAt=next.status==='done'?(old?.status==='done'?old.completedAt:tx.now):null;
 next.completedBy=next.status==='done'?(old?.status==='done'?old.completedBy:authorId):null;
 let result=await save(tx,'channel_task',next,old,actor,cmd.reason||cmd.progress||cmd.result);
 if(next.status==='done'&&old?.status!=='done')await recordMemoryEvent(tx,channel,result,'task');
 if(cmd.notifyAssignee!==undefined&&typeof cmd.notifyAssignee!=='boolean')fail('invalid_input','通知选项无效');
 if(next.assigneeId&&cmd.notifyAssignee!==false&&(next.assigneeId!==old?.assigneeId||cmd.notifyAssignee===true)&&basis.valid){const notice=await notify(tx,identity,channel,helpers,actor,result,next.assigneeId,'assigned:'+result.version,`请跟进：${next.title}\n${next.body}\n先 read_todo 当前要求和原用户消息，再实际接手。`);if(notice){result.notificationMessageId=notice.id;tx.put('channel_task',result);}}
 const delivery=await taskDelivery(tx,result);
 if(submitted&&!checked&&next.workSpec.checkMode==='designated')await notify(tx,identity,channel,helpers,actor,result,next.workSpec.reviewerId,'review:'+next.currentSubmissionId,`请核对「${next.title}」当前成果。对照用户原话和实际原件；完成条件也可能不完整。read_todo 后 check，不改写执行者成果。`);
 if(checked){
  const follower=parent?.assigneeId||(!next.parentTaskId?next.assigneeId:null)||channel.coordinatorId;
  await notify(tx,identity,channel,helpers,actor,result,delivery.valid?follower:result.assigneeId,'check:'+next.currentCheckId,`「${next.title}」${delivery.label}：${delivery.check.reason}\n读取当前 Todo 和实际成果，再推进或补充。采纳纠正必须落实到产物，不能只说已采纳。`);
  if(delivery.valid&&next.parentTaskId)for(const t of await childrenOf(tx,next.parentTaskId))if(!terminal(t)&&t.dependsOn?.includes(next.id)&&(await currentTaskBasis(tx,t)).valid)await notify(tx,identity,channel,helpers,actor,t,t.assigneeId,'ready:'+next.currentCheckId,`「${t.title}」前置成果已通过，请读取当前 Todo、上游原件和用户要求后继续。`);
 }
 return {...result,delivery,...(legacyDone?{compatibilityNotice:'已保存成果，尚未核对。read_todo 后用 board_task check；普通小项可 submit 并附 selfCheck，不把旧 done 当核对通过。'}:{})};
}
