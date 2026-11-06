import {fail,required} from './repository.mjs';

export const COORDINATION_TOOLS=[{
 name:'coordinate',description:'负责人跟进一个具体需求：read 查看反馈；update 记录推进/等成员/需用户决定；close 给出结果并结束跟进。先读后带 expectedVersion，避免遗漏新回传。普通聊天不必建任务。',
 inputSchema:{type:'object',properties:{requestId:{type:'string'},channelId:{type:'string'},sourceMessageId:{type:'string'},action:{type:'string',enum:['read','update','close']},expectedVersion:{type:'integer',minimum:1},status:{type:'string',enum:['working','waiting_members','waiting_user']},summary:{type:'string'},refs:{type:'array',items:{type:'object',properties:{kind:{type:'string',enum:['document','task','file','meeting']},id:{type:'string'}},required:['kind','id'],additionalProperties:false},maxItems:20}},required:['requestId','channelId','sourceMessageId','action'],additionalProperties:false}
}];
const key=(channelId,root)=>channelId+':'+root;
const isOpen=r=>r&&!['completed','canceled'].includes(r.status);
export async function trackCoordination(tx,channel,message,parent,targets){
 if(!channel.coordinatorId||message.authorId!==channel.coordinatorId||!targets.some(mid=>mid!==channel.coordinatorId))return null;
 const root=parent?.coordinationRootId||parent?.rootId||parent?.id;
 if(!root)return null;
 const source=await tx.get('channel_message',root,false);
 // Explicit coordination starts only from a real owner request or an existing
 // coordinated thread. An unrelated peer conversation does not become a task.
 const old=await tx.get('channel_coordination',key(channel.id,root),false);
 if(source?.authorId!=='owner'&&!old)return null;
 const record=tx.put('channel_coordination',{...old,id:key(channel.id,root),scopeId:channel.id,parentId:root,sourceMessageId:root,coordinatorId:channel.coordinatorId,appointment:channel.coordinatorVersion||1,status:'waiting_members',version:(old?.version||0)+1,summary:old?.summary||'',requestMessageIds:[...new Set([...(old?.requestMessageIds||[]),message.id])].slice(-100),refs:[...new Map([...(old?.refs||[]),...(message.refs||[])].map(r=>[r.kind+':'+r.id,r])).values()].slice(-100),createdAt:old?.createdAt||tx.now});
 tx.put('channel_message',{...message,coordinationRootId:root});return record;
}
export async function relatedCoordination(tx,channel,message,parent){
 const root=parent?.coordinationRootId||parent?.rootId||parent?.id;
 if(!root||message.authorId==='owner'||message.authorId===channel.coordinatorId)return null;
 const r=await tx.get('channel_coordination',key(channel.id,root),false);
 return isOpen(r)?r:null;
}
export async function registerFeedback(tx,channel,record,message,source={kind:'message',id:message.id}){
 const eventId=record.id+':'+source.kind+':'+source.id+':'+(source.version||1);
 if(await tx.get('coordination_event',eventId,false))return false;
 tx.put('coordination_event',{id:eventId,scopeId:channel.id,parentId:record.id,status:'pending',messageId:message.id,source,authorId:message.authorId,createdAt:tx.now});
 const latest=await tx.get('channel_coordination',record.id);
 tx.put('channel_coordination',{...latest,coordinatorId:channel.coordinatorId,appointment:channel.coordinatorVersion||1,version:latest.version+1,status:'working',lastFeedbackMessageId:message.id});
 return true;
}
export async function objectFeedback(tx,identity,channel,actor,source,message,helpers){
 if(!channel.coordinatorId||actor.memberId===channel.coordinatorId)return;
 const records=(await tx.list('channel_coordination',{scope:channel.id,limit:500})).filter(isOpen);
 for(const r of records){
  if(!r.refs?.some(ref=>ref.kind===source.kind&&ref.id===source.id))continue;
  if(await registerFeedback(tx,channel,r,message,source))await helpers.enqueue(tx,identity,channel,{...message,coordinationRootId:r.sourceMessageId,coordinationFeedback:true},channel.coordinatorId);
 }
}
export async function coordinationCommand(tx,channel,actor,cmd){
 const r=await tx.get('channel_coordination',key(channel.id,cmd.sourceMessageId));
 if(cmd.action==='read')return{...r,events:await tx.list('coordination_event',{parent:r.id,limit:500})};
 if(!actor.owner&&actor.memberId!==channel.coordinatorId)fail('forbidden','仅当前负责人或用户可更新跟进状态',403);
 if(!['update','close'].includes(cmd.action))fail('invalid_action','跟进操作无效');
 if(cmd.expectedVersion!==r.version)fail('version_conflict','有新的反馈，请先读取并纳入本次处理',409);
 const summary=required(cmd.summary,'推进结果或具体等待事项',4000),status=cmd.action==='close'?'completed':cmd.status||'working';
 if(!['completed','working','waiting_members','waiting_user'].includes(status))fail('invalid_status','跟进状态无效');
 const refs=cmd.refs??r.refs??[];
 if(!Array.isArray(refs)||refs.length>100)fail('invalid_refs','关联资料无效');
 for(const ref of refs){const kind={document:'channel_doc',file:'shared_file',task:'channel_task',meeting:'channel_meeting'}[ref.kind];if(!kind)fail('invalid_refs','资料类型无效');const item=await tx.get(kind,ref.id);if(item.scopeId!==channel.id||item.status==='deleted')fail('forbidden','资料不属于本群',403);}
 for(const event of await tx.list('coordination_event',{parent:r.id,status:'pending',limit:500}))tx.put('coordination_event',{...event,status:'handled',handledBy:actor.memberId||'owner',handledAt:tx.now});
 return tx.put('channel_coordination',{...r,version:r.version+1,coordinatorId:channel.coordinatorId,appointment:channel.coordinatorVersion||1,status,summary,refs,completedAt:status==='completed'?tx.now:null});
}
export async function transferCoordination(tx,identity,channel,helpers){
 const records=(await tx.list('channel_coordination',{scope:channel.id,limit:500})).filter(isOpen);
 for(const r of records){
  tx.put('channel_coordination',{...r,version:r.version+1,coordinatorId:channel.coordinatorId,appointment:channel.coordinatorVersion});
  for(const turn of await tx.list('channel_turn',{scope:channel.id,status:'ready',limit:500}))if(turn.coordinationFeedback&&turn.coordinationRootId===r.sourceMessageId&&turn.memberId===r.coordinatorId&&turn.memberId!==channel.coordinatorId)tx.put('channel_turn',{...turn,status:'removed',reason:'后续跟进已交给新负责人，原成员执行保留'});
  if(channel.coordinatorId){const original=await tx.get('channel_message',r.lastFeedbackMessageId||r.sourceMessageId);const handoff=await helpers.channelMessage(tx,channel,{memberId:'system'},'负责人已更换，继续跟进原需求。',{type:'coordination',hidden:true,rootId:r.sourceMessageId,coordinationRootId:r.sourceMessageId,coordinationFeedback:true,hops:original.hops||0});await helpers.enqueue(tx,identity,channel,handoff,channel.coordinatorId);}
 }
}
