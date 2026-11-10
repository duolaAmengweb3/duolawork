import {executionResource} from './execution-bindings.mjs';

// Background memory is an optional batch, not another user request. This also
// recognizes already-persisted turns created before the batch field existed.
export async function isMemoryMaintenance(repo,turn){
 return turn.background==='memory'||!!(await repo.get('channel_message',turn.messageId,false))?.memoryMaintenance;
}
export async function foregroundWaiting(repo,memberId,resourceKey,exceptId){
 const connection=await repo.get('connection',memberId,false);if(!connection)return false;
 for(const status of ['ready','active']){let after='';for(;;){
  const rows=await repo.list('channel_turn',{parent:memberId,status,after,limit:500,page:true});
  for(const turn of rows){
   if(turn.id===exceptId||await isMemoryMaintenance(repo,turn))continue;
   if(turn.taskId&&turn.taskEvent){const {taskNotificationState}=await import('./task-deliverables.mjs');if((await taskNotificationState(repo,turn)).state!=='current')continue;}
   const channel=await repo.get('channel',turn.scopeId,false);
   if(channel?.status==='active'&&channel.memberIds.includes(memberId)&&await executionResource(repo,connection,channel.id)===resourceKey)return true;
  }
  if(rows.length<500)break;after=rows.at(-1).id;
 }}return false;
}
export async function memoryBatch(repo,actor,channelId){
 if(!actor.memberId)return null;
 const turns=await repo.list('channel_turn',{scope:channelId,parent:actor.memberId,status:'active',limit:500});
 for(const turn of turns)if(await isMemoryMaintenance(repo,turn)){
  const source=await repo.get('channel_message',turn.messageId,false);
  let eventIds=source?.maintenanceEventIds;
  if(!eventIds){const rows=await repo.list('memory_event',{scope:channelId,status:'pending',limit:500});eventIds=rows.filter(e=>e.createdAt<=turn.createdAt).slice(0,50).map(e=>e.id);}
  const yieldToForeground=await foregroundWaiting(repo,actor.memberId,turn.resourceKey,turn.id);
  return {turnId:turn.id,eventIds,yieldToForeground,instruction:yieldToForeground?'这段原会话已有前台工作等待。本次后台整理停止扩展；调用 stay_silent 结束本通知，让原会话正常收尾。未整理事件保留，下次空闲继续；不要领取其他通知。':'本次后台整理只处理 eventIds 指定的快照；之后到达的事件留给下次，不追读到全群清空。完成后 stay_silent。'};
 }return null;
}
export const backgroundYield=batch=>({deferred:true,backgroundWork:batch,instruction:batch.instruction});
