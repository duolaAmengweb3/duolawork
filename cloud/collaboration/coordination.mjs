import {fail,required} from './repository.mjs';

export const COORDINATION_TOOLS=[{
 name:'coordinate',description:'负责人跟进一个具体需求：open 将本群中由原环境带来的明确请求纳入跟进；read 查看反馈；update 推进，requirementMessageId 纳入用户新要求并通知受影响成员；cancel 通知停止（不承诺撤销外部操作）；close 给出结果。先读后带 expectedVersion，旧结果不能关闭新要求。普通聊天不必建任务。',
 inputSchema:{type:'object',properties:{requestId:{type:'string'},channelId:{type:'string'},sourceMessageId:{type:'string'},action:{type:'string',enum:['open','read','update','cancel','close']},requirementMessageId:{type:'string'},expectedVersion:{type:'integer',minimum:1},status:{type:'string',enum:['working','waiting_members','waiting_user']},summary:{type:'string'},refs:{type:'array',items:{type:'object',properties:{kind:{type:'string',enum:['document','task','file','meeting']},id:{type:'string'}},required:['kind','id'],additionalProperties:false},maxItems:20}},required:['requestId','channelId','sourceMessageId','action'],additionalProperties:false}
}];
const key=(channelId,root)=>channelId+':'+root;
const isOpen=r=>r&&!['completed','canceled'].includes(r.status);
export async function trackCoordination(tx,channel,message,parent,targets){
 if(message.purpose==='message'||!channel.coordinatorId||message.authorId!==channel.coordinatorId||!targets.some(mid=>mid!==channel.coordinatorId))return null;
 const root=parent?.coordinationRootId||parent?.rootId||parent?.id||(message.purpose==='request'?message.id:null);
 if(!root)return null;
 const source=await tx.get('channel_message',root,false);
 // Explicit coordination starts only from a real owner request or an existing
 // coordinated thread. An unrelated peer conversation does not become a task.
 const old=await tx.get('channel_coordination',key(channel.id,root),false);
 if(source?.authorId!=='owner'&&!old&&message.purpose!=='request')return null;
 const record=tx.put('channel_coordination',{...old,id:key(channel.id,root),scopeId:channel.id,parentId:root,sourceMessageId:root,coordinatorId:channel.coordinatorId,appointment:channel.coordinatorVersion||1,status:'waiting_members',version:(old?.version||0)+1,requirementVersion:old?.requirementVersion||1,requirementMessageIds:old?.requirementMessageIds||[root],participantIds:[...new Set([...(old?.participantIds||[]),...targets])],summary:old?.summary||'',requestMessageIds:[...new Set([...(old?.requestMessageIds||[]),message.id])].slice(-100),refs:[...new Map([...(old?.refs||[]),...(message.refs||[])].map(r=>[r.kind+':'+r.id,r])).values()].slice(-100),createdAt:old?.createdAt||tx.now});
 Object.assign(message,{coordinationRootId:root,requirementVersion:record.requirementVersion});tx.put('channel_message',message);return record;
}
export async function relatedCoordination(tx,channel,message,parent,targets=[]){
 const root=parent?.coordinationRootId||parent?.rootId||parent?.id;
 if(!root||message.authorId==='owner'||message.authorId===channel.coordinatorId)return null;
 let r=await tx.get('channel_coordination',key(channel.id,root),false);
 // Peer questions preserve the causal thread but do not summon the coordinator.
 // A result without peer recipients (including legacy tools) still returns home.
 if(r){
  message.coordinationRootId=root;message.requirementVersion??=parent?.requirementVersion||r.requirementVersion||1;message.obsoleteRequirement=message.requirementVersion<(r.requirementVersion||1);tx.put('channel_message',message);
  const participants=[...new Set([...(r.participantIds||[]),message.authorId,...targets.filter(mid=>mid!==channel.coordinatorId)])];
  if(isOpen(r)&&participants.length!==(r.participantIds||[]).length)r=tx.put('channel_coordination',{...r,participantIds:participants,version:r.version+1});
 }
 if(['question','message'].includes(message.purpose)||(targets.some(mid=>mid!==channel.coordinatorId)&&!targets.includes(channel.coordinatorId)))return null;
 return r&&(isOpen(r)||r.status==='canceled')?r:null;
}
export async function registerFeedback(tx,channel,record,message,source={kind:'message',id:message.id}){
 const eventId=record.id+':'+source.kind+':'+source.id+':'+(source.version||1);
 if(await tx.get('coordination_event',eventId,false))return false;
 tx.put('coordination_event',{id:eventId,scopeId:channel.id,parentId:record.id,status:'pending',messageId:message.id,source,authorId:message.authorId,requirementVersion:message.requirementVersion||record.requirementVersion||1,obsoleteRequirement:!!message.obsoleteRequirement,createdAt:tx.now});
 const latest=await tx.get('channel_coordination',record.id);
 tx.put('channel_coordination',{...latest,coordinatorId:channel.coordinatorId,appointment:channel.coordinatorVersion||1,version:latest.version+1,status:latest.status==='canceled'?'canceled':'working',lastFeedbackMessageId:message.id,...(message.executionOutcome&&latest.interruption?{interruption:latest.interruption.map(x=>x.memberId===message.authorId?{...x,state:message.executionOutcome,messageId:message.id,reportedAt:tx.now}:x)}:{})});
 return true;
}
export async function objectFeedback(tx,identity,channel,actor,source,message,helpers){
 if(!channel.coordinatorId||actor.memberId===channel.coordinatorId)return;
 const records=(await tx.list('channel_coordination',{scope:channel.id,limit:500})).filter(isOpen);
 for(const r of records){
  if(!r.refs?.some(ref=>ref.kind===source.kind&&ref.id===source.id))continue;
  const active=(await tx.list('channel_turn',{scope:channel.id,parent:actor.memberId,status:'active'})).find(t=>t.coordinationRootId===r.sourceMessageId);
  if(active){message={...message,requirementVersion:active.requirementVersion||1,obsoleteRequirement:(active.requirementVersion||1)<(r.requirementVersion||1)};tx.put('channel_message',message);}
  if(await registerFeedback(tx,channel,r,message,source))await helpers.enqueue(tx,identity,channel,{...message,coordinationRootId:r.sourceMessageId,coordinationFeedback:true},channel.coordinatorId);
 }
}
export async function coordinationCommand(tx,channel,actor,cmd,identity,helpers){
 let r=await tx.get('channel_coordination',key(channel.id,cmd.sourceMessageId),false);
 if(cmd.action==='open'){
  if(!actor.owner&&actor.memberId!==channel.coordinatorId)fail('forbidden','仅当前负责人或用户可开始跟进',403);
  const source=await tx.get('channel_message',cmd.sourceMessageId);
  if(source.scopeId!==channel.id||source.hidden)fail('forbidden','请求必须来自本群可见消息',403);
  if(r)return r;
  r=tx.put('channel_coordination',{id:key(channel.id,source.id),scopeId:channel.id,parentId:source.id,sourceMessageId:source.id,origin:source.authorId==='owner'?'owner':'native_request',coordinatorId:channel.coordinatorId,appointment:channel.coordinatorVersion||1,status:'working',version:1,requirementVersion:1,requirementMessageIds:[source.id],participantIds:source.recipientIds||[],requestMessageIds:[source.id],summary:required(cmd.summary,'明确请求及授权范围',4000),refs:source.refs||[],createdAt:tx.now});
  tx.put('channel_message',{...source,coordinationRootId:source.id,requirementVersion:1});return r;
 }
 if(!r)fail('not_found','这个需求尚未开始跟进',404);
 if(cmd.action==='read')return{...r,events:await tx.list('coordination_event',{parent:r.id,limit:500})};
 if(!actor.owner&&actor.memberId!==channel.coordinatorId)fail('forbidden','仅当前负责人或用户可更新跟进状态',403);
 if(!['update','cancel','close'].includes(cmd.action))fail('invalid_action','跟进操作无效');
 if(cmd.expectedVersion!==r.version)fail('version_conflict','有新的反馈，请先读取并纳入本次处理',409);
 if(r.status==='canceled'&&cmd.action==='close')fail('request_canceled','已停止的要求不能被迟到结果标记完成',409);
 const summary=required(cmd.summary,'推进结果或具体等待事项',4000),status=cmd.action==='cancel'?'canceled':cmd.action==='close'?'completed':cmd.status||'working';
 if(!['canceled','completed','working','waiting_members','waiting_user'].includes(status))fail('invalid_status','跟进状态无效');
 if(cmd.requirementMessageId){
  const source=await tx.get('channel_message',cmd.requirementMessageId);
  if(source.scopeId!==channel.id||source.authorId!=='owner')fail('forbidden','新要求必须是本群的真实用户消息',403);
  r=await reviseRequirement(tx,identity,channel,r,source,helpers);
 }
 let interruption=r.interruption;
 if(cmd.action==='cancel'){
  const turns=(await tx.list('channel_turn',{scope:channel.id,limit:1000})).filter(t=>t.coordinationRootId===r.sourceMessageId);
  interruption=[];
  for(const mid of r.participantIds||[]){
   const own=turns.filter(t=>t.memberId===mid),running=own.some(t=>t.status==='active'),pending=own.filter(t=>['ready','unavailable','limited','stalled'].includes(t.status));
   for(const turn of pending){tx.put('channel_turn',{...turn,status:'removed',reason:'用户停止了这项要求，未开始的通知不再执行'});const notice=await tx.get('outbox',`notice_${turn.id}`,false);if(notice)tx.put('outbox',{...notice,status:'canceled'});}
   const events=(await tx.list('coordination_event',{parent:r.id,limit:500})).filter(e=>e.authorId===mid);
   interruption.push({memberId:mid,state:running?'outcome_unknown':events.length?'result':pending.length?'not_started':'awaiting_confirmation',at:tx.now});
  }
  const notice=await helpers.channelMessage(tx,channel,{memberId:actor.memberId||'owner'},`停止此项要求：${summary}。不要继续未开始的动作；如已执行，请报告实际结果、待确认事项或外部结果未知，不声称自动撤销。`,{hidden:true,type:'coordination',coordinationRootId:r.sourceMessageId,requirementVersion:r.requirementVersion||1,hops:0});
  for(const item of interruption.filter(x=>x.state!=='not_started'&&x.state!=='result'))if(channel.memberIds.includes(item.memberId))await helpers.enqueue(tx,identity,channel,notice,item.memberId);
 }
 const refs=cmd.refs??r.refs??[];
 if(!Array.isArray(refs)||refs.length>100)fail('invalid_refs','关联资料无效');
 for(const ref of refs){const kind={document:'channel_doc',file:'shared_file',task:'channel_task',meeting:'channel_meeting'}[ref.kind];if(!kind)fail('invalid_refs','资料类型无效');const item=await tx.get(kind,ref.id);if(item.scopeId!==channel.id||item.status==='deleted')fail('forbidden','资料不属于本群',403);}
 for(const event of await tx.list('coordination_event',{parent:r.id,status:'pending',limit:500}))tx.put('coordination_event',{...event,status:'handled',handledBy:actor.memberId||'owner',handledAt:tx.now});
 return tx.put('channel_coordination',{...r,version:r.version+1,coordinatorId:channel.coordinatorId,appointment:channel.coordinatorVersion||1,status,summary,refs,interruption,completedAt:status==='completed'?tx.now:null});
}

export async function reviseRequirement(tx,identity,channel,r,source,helpers){
 const revisions=r.requirementRevisions||{},stamp=`${source.id}:${source.version||1}`;
 if(revisions[stamp])return r;
 const next=tx.put('channel_coordination',{...r,version:r.version+1,requirementVersion:(r.requirementVersion||1)+1,requirementMessageIds:[...new Set([...(r.requirementMessageIds||[r.sourceMessageId]),source.id])],requirementRevisions:{...revisions,[stamp]:true},status:'working'});
 const notice=await helpers.channelMessage(tx,channel,{memberId:'owner'},`用户更新了此项要求：\n${source.body}\n请按新要求检查当前工作；旧结果需说明适用版本。`,{hidden:true,type:'coordination',replyTo:source.id,coordinationRootId:r.sourceMessageId,requirementVersion:next.requirementVersion,hops:0});
 for(const mid of new Set([channel.coordinatorId,...(r.participantIds||[])]))if(channel.memberIds.includes(mid))await helpers.enqueue(tx,identity,channel,notice,mid);
 return next;
}

export async function ownerRequirementChanged(tx,identity,channel,message,parent,helpers){
 const root=parent?.coordinationRootId||parent?.rootId||parent?.id;
 if(!root)return;
 const r=await tx.get('channel_coordination',key(channel.id,root),false);
 if(isOpen(r))await reviseRequirement(tx,identity,channel,r,message,helpers);
}
export async function transferCoordination(tx,identity,channel,helpers){
 const records=(await tx.list('channel_coordination',{scope:channel.id,limit:500})).filter(isOpen);
 for(const r of records){
  tx.put('channel_coordination',{...r,version:r.version+1,coordinatorId:channel.coordinatorId,appointment:channel.coordinatorVersion});
  for(const turn of await tx.list('channel_turn',{scope:channel.id,status:'ready',limit:500}))if(turn.coordinationFeedback&&turn.coordinationRootId===r.sourceMessageId&&turn.memberId===r.coordinatorId&&turn.memberId!==channel.coordinatorId)tx.put('channel_turn',{...turn,status:'removed',reason:'后续跟进已交给新负责人，原成员执行保留'});
  if(channel.coordinatorId){const original=await tx.get('channel_message',r.lastFeedbackMessageId||r.sourceMessageId);const handoff=await helpers.channelMessage(tx,channel,{memberId:'system'},'负责人已更换，继续跟进原需求。',{type:'coordination',hidden:true,rootId:r.sourceMessageId,coordinationRootId:r.sourceMessageId,coordinationFeedback:true,hops:original.hops||0});await helpers.enqueue(tx,identity,channel,handoff,channel.coordinatorId);}
 }
}
