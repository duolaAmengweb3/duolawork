import { fail, required, digest } from './repository.mjs';
import { requireManager } from './delegation.mjs';
import { conversationCommand } from './conversation.mjs';

const owner = { owner: true };
const readAll = async (repo, kind) => {
  const rows=[];let after='';
  for (;;) {const page=await repo.list(kind,{after,limit:500});rows.push(...page);if(page.length<500)break;after=page.at(-1).id;}
  return rows;
};
async function currentSecretary(repo, identity) {
  const grant=await repo.get('workspace_secretary','current',false);
  if(grant?.status!=='active'||!identity.members.some(m=>m.id===grant.memberId&&m.status!=='disabled'))fail('secretary_required','请先选择一位秘书',409);
  return grant;
}
async function directChannel(repo,identity,grant) {
  const channels=await readAll(repo,'channel');
  const prior=channels.find(c=>c.direct&&c.memberIds.length===1&&c.memberIds[0]===grant.memberId);
  if(prior)return prior;
  const member=identity.members.find(m=>m.id===grant.memberId);
  return conversationCommand(repo,identity,owner,{type:'channel.create',requestId:'secretary-direct:'+grant.memberId,name:member.name,memberIds:[member.id],direct:true});
}
export async function secretaryOverview(repo,identity,actor) {
  await requireManager(repo,actor);
  const [grant,channels,tasks,questions,turns,requests,watches,schedule]=await Promise.all([
    repo.get('workspace_secretary','current',false),readAll(repo,'channel'),readAll(repo,'channel_task'),
    repo.list('channel_question',{status:'pending',limit:500,order:'recent'}),
    repo.list('channel_turn',{status:'active',limit:500,order:'recent'}),
    repo.list('secretary_request',{limit:40,order:'recent'}),repo.list('secretary_watch',{status:'watching',limit:100}),
    repo.get('secretary_schedule','daily',false)
  ]);
  const questionMessages=questions.length?await repo.list('channel_message',{questionIds:questions.map(q=>q.id),limit:500,excludeHidden:true}):[];
  const pendingQuestions=questions.map(q=>({...q,messageId:questionMessages.find(m=>m.questionId===q.id)?.id}));
  const groups=channels.filter(c=>!c.direct&&c.status!=='archived').map(c=>{
    const scoped=tasks.filter(t=>t.scopeId===c.id),items=scoped.filter(t=>!t.parentTaskId),open=scoped.filter(t=>!['done','canceled'].includes(t.status));
    return {id:c.id,name:c.name,coordinatorId:c.coordinatorId,updatedAt:c.updatedAt,total:items.length,done:items.filter(t=>t.status==='done').length,
      blocked:new Set(open.filter(t=>t.status==='blocked').map(t=>t.parentTaskId||t.id)).size,overdue:new Set(open.filter(t=>t.dueDate&&Date.parse(t.dueDate)<Date.now()).map(t=>t.parentTaskId||t.id)).size,
      tasks:items.slice(-20).map(({id,title,status,progress,blocker,result,updatedAt,assigneeId})=>({id,title,status,progress,blocker,result,updatedAt,assigneeId}))};
  });
  const feeds=new Map();
  const feed=id=>{if(!feeds.has(id))feeds.set(id,Promise.all([repo.list('channel_turn',{scope:id,order:'recent',limit:100}),repo.list('channel_message',{scope:id,order:'recent',limit:500,excludeHidden:true,replyTo:requests.filter(r=>r.channelId===id).map(r=>r.messageId)})]));return feeds.get(id);};
  const receipts=await Promise.all(requests.map(async r=>{
    const [turns,messages]=await feed(r.channelId);
    const turn=turns.find(t=>t.memberId===r.memberId&&(t.messageId===r.messageId||t.messageIds?.includes(r.messageId)));
    const replies=messages.filter(m=>m.authorId===r.memberId&&(m.replyTo===r.messageId||m.rootId===r.messageId)).reverse();
    return {...r,displayStatus:r.memberId!==grant?.memberId?'原秘书委托':r.status==='done'?'已完成':r.status==='blocked'?'需要处理':r.status==='watching'?'持续关注中':replies.length?'已回复':turn?.status==='active'?'处理中':turn?.status==='stalled'?'等待状态更新':'等待接收',progress:r.progress||turn?.progress?.message||turn?.progress,replies:replies.map(({id,body,refs,createdAt})=>({id,body,refs,createdAt}))};
  }));
  return {secretary:grant,groups,questions:pendingQuestions,requests:receipts,watches:watches.filter(w=>w.memberId===grant?.memberId&&w.grantVersion===grant?.version),schedule:schedule&&{...schedule,status:schedule.memberId===grant?.memberId&&schedule.grantVersion===grant?.version?schedule.status:'disabled'},directChannel:channels.find(c=>c.direct&&c.memberIds.length===1&&c.memberIds[0]===grant?.memberId)||null,
    activity:turns.map(({id,scopeId,memberId,progress,startedAt,updatedAt})=>({id,channelId:scopeId,memberId,progress,startedAt,updatedAt})),
    measuredAt:new Date().toISOString()};
}
export async function secretaryCommand(repo,identity,actor,args,now=new Date().toISOString()) {
  if(!actor.owner)fail('forbidden','请通过用户的秘书入口操作',403);
  required(args.requestId,'请求编号',150);
  const grant=await currentSecretary(repo,identity);
  if(args.action==='open')return directChannel(repo,identity,grant);
  if(args.action==='schedule') {
    if(!/^\d{2}:\d{2}$/.test(args.time||'')||Number(args.time.slice(0,2))>23||Number(args.time.slice(3))>59)fail('invalid_time','请选择每天的提醒时间');
    try {new Intl.DateTimeFormat('en',{timeZone:args.timeZone}).format();}catch{fail('invalid_timezone','时区无效');}
    return repo.transact(args.requestId,{...args,actor},tx=>tx.put('secretary_schedule',{id:'daily',memberId:grant.memberId,grantVersion:grant.version,status:args.enabled?'enabled':'disabled',time:args.time,timeZone:args.timeZone,createdAt:now}),now);
  }
  if(args.action==='cancel_watch')return repo.transact(args.requestId,{...args,actor},async tx=>{const w=await tx.get('secretary_watch',args.watchId);return tx.put('secretary_watch',{...w,status:'canceled'});},now);
  if(args.action!=='send')fail('invalid_action','秘书操作无效');
  const requestId='secretary_request_'+await digest(args.requestId),prior=await repo.get('secretary_request',requestId,false);
  const fingerprint=await digest(JSON.stringify({body:args.body,context:args.context||null}));
  if(prior){if(prior.inputFingerprint!==fingerprint)fail('idempotency_conflict','同一发送请求内容发生变化',409);return prior;}
  if((args.memberId&&args.memberId!==grant.memberId)||(args.grantVersion&&args.grantVersion!==grant.version))fail('delegation_changed','秘书已更换。这条尚未发送，请重新交代给当前秘书。',409);
  const body=required(args.body,'交代的事情',12000),channel=await directChannel(repo,identity,grant);
  let context=null;
  if(args.context?.channelId){
    const source=await repo.get('channel',args.context.channelId);
    context={channelId:source.id,name:source.name};
    if(args.context.ref){
      const kinds={document:'channel_doc',task:'channel_task',meeting:'channel_meeting',file:'shared_file',memory:'channel_memory'};
      const ref=args.context.ref;if(!kinds[ref.kind])fail('invalid_reference','资料类型不支持');
      const object=await repo.get(kinds[ref.kind],ref.id);if(object.scopeId!==source.id)fail('invalid_reference','资料不属于当前聊天');
      context.ref={kind:ref.kind,id:object.id,title:object.title||object.name,version:object.version};
    }
  }
  const fresh=await currentSecretary(repo,identity);if(fresh.version!==grant.version)fail('delegation_changed','秘书已更换，请重试',409);
  const message=await conversationCommand(repo,identity,owner,{type:'channel.post',requestId:'secretary-send:'+args.requestId,channelId:channel.id,body,
    mentions:[grant.memberId]},now);
  return repo.transact('secretary-card:'+args.requestId,{requestId:args.requestId,body,context,memberId:grant.memberId},tx=>tx.put('secretary_request',{id:requestId,scopeId:channel.id,parentId:grant.memberId,channelId:channel.id,memberId:grant.memberId,grantVersion:grant.version,messageId:message.id,inputFingerprint:fingerprint,body,context,status:'pending',createdAt:now}),now);
}
export async function secretaryManage(repo,identity,actor,args) {
  const grant=await requireManager(repo,actor),settings=args.settings||{};
  if(args.action==='overview')return secretaryOverview(repo,identity,actor);
  if(args.action==='request_update')return repo.transact(args.requestId,{...args,actor},async tx=>{
    const r=await tx.get('secretary_request',settings.id);
    if(!grant.owner&&(r.memberId!==actor.memberId||r.grantVersion!==grant.version))fail('forbidden','只能更新自己的当前委托',403);
    if(!['doing','done','blocked','watching'].includes(settings.status))fail('invalid_status','请填写真实办事状态');
    const progress=required(settings.progress,'结果或进度',8000);
    const refs=Array.isArray(settings.refs)?settings.refs.slice(0,20):[];
    return tx.put('secretary_request',{...r,status:settings.status,progress,refs,updatedBy:actor.memberId||'owner'});
  });
  if(args.action==='watch')return repo.transact(args.requestId,{...args,actor},async tx=>{
    if(!['task','meeting'].includes(settings.kind))fail('invalid_target','请选择具体待办或会议来关注');
    const target=await tx.get(settings.kind==='task'?'channel_task':'channel_meeting',settings.id);
    if(['done','ended','closed'].includes(target.status))return {alreadyFinished:true,target};
    return tx.put('secretary_watch',{id:'watch_'+await digest(args.requestId),scopeId:target.scopeId,parentId:actor.memberId||grant.memberId,
      memberId:actor.memberId||grant.memberId,grantVersion:grant.version,kindName:settings.kind,targetId:target.id,title:target.title,
      status:'watching',createdAt:tx.now});
  });
  fail('invalid_action','秘书操作无效');
}
export async function secretaryMaintenance(repo,identity,now=new Date().toISOString()) {
  const grant=await repo.get('workspace_secretary','current',false);if(grant?.status!=='active')return;
  const schedule=await repo.get('secretary_schedule','daily',false);
  if(schedule?.status==='enabled'&&schedule.memberId===grant.memberId&&schedule.grantVersion===grant.version){
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:schedule.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(p=>[p.type,p.value]));
    if(`${parts.hour}:${parts.minute}`>=schedule.time){
      const day=`${parts.year}-${parts.month}-${parts.day}`;
      await secretaryCommand(repo,identity,owner,{action:'send',requestId:`daily:${schedule.grantVersion}:${day}`,body:'按我设定的日报安排，汇总今天各项目负责人的实际进展、已完成、阻碍和需要我决定的事；调用 manage_workspace overview 读取现状，必要时查原群。缺少汇报要明确标出，附来源，不把测试或候选算成上线。'},now);
    }
  }
  for(const watch of await repo.list('secretary_watch',{status:'watching',limit:100})){
    if(watch.memberId!==grant.memberId||watch.grantVersion!==grant.version)continue;
    const target=await repo.get(watch.kindName==='task'?'channel_task':'channel_meeting',watch.targetId,false);
    if(!target||!['done','ended','closed'].includes(target.status))continue;
    await secretaryCommand(repo,identity,owner,{action:'send',requestId:'watch-result:'+watch.id,body:`我之前请你关注的「${watch.title}」现在有结果了。请读取这条${watch.kindName==='task'?'待办':'会议'}及交付依据，告诉我实际结果和仍未完成的部分。`,context:{channelId:target.scopeId,ref:{kind:watch.kindName,id:target.id}}},now);
    await repo.transact('watch-notified:'+watch.id,{id:watch.id},tx=>tx.put('secretary_watch',{...watch,status:'notified',notifiedAt:now}),now);
  }
}
