import {fail} from './repository.mjs';
import {compareChats} from '../../ui/conversation/chat-list-order.mjs';

export async function listChannels(repo,{deleted=false}={}){
 const statuses=deleted?['deleted']:['active','paused','archived'];
 const rows=(await Promise.all(statuses.map(status=>repo.list('channel',{status,order:'recent',limit:500})))).flat();
 return rows.sort(deleted?(a,b)=>(b.deletedAt||'').localeCompare(a.deletedAt||''):compareChats).slice(0,500);
}
async function cancelPending(tx,channelId,kind,statuses){
 for(const status of statuses){let after='';for(;;){
  const rows=await tx.list(kind,{scope:channelId,status,page:true,limit:500,after});
  for(const row of rows)tx.put(kind,{...row,status:kind==='outbox'?'canceled':'removed',reason:'群聊已删除，停止尚未开始的通知',completedAt:tx.now});
  if(rows.length<500)break;after=rows.at(-1).id;
 }}
}
export async function manageChannel(tx,actor,cmd,channel){
 if(!actor.owner)fail('forbidden','只有用户可以置顶、删除或恢复聊天',403);
 if(cmd.type==='channel.pin'){
  if(channel.status==='deleted')fail('channel_deleted','群聊已删除，请恢复后操作',410);
  if(typeof cmd.pinned!=='boolean')fail('invalid_input','请选择置顶或取消置顶');
  return tx.put('channel',{...channel,pinnedAt:cmd.pinned?(channel.pinnedAt||tx.now):null});
 }
 if(channel.direct)fail('invalid_channel','此操作只用于群聊');
 if(cmd.expectedVersion!==channel.revision)fail('version_conflict','群聊刚有更新，请刷新后再操作',409);
 if(cmd.type==='channel.restore'){
  if(channel.status!=='deleted')return channel;
  return tx.put('channel',{...channel,status:channel.previousStatus||'active',deletedAt:null,restoredAt:tx.now});
 }
 if(channel.status==='deleted')return channel;
 // Do not interrupt or release the native-session lock of a live turn. Deleting
 // an idle chat stops queued notifications, never deletes an Agent or its files.
 const active=await tx.list('channel_turn',{scope:channel.id,status:'active',order:'recent',limit:1});
 const sending=await tx.list('outbox',{scope:channel.id,status:'sending',order:'recent',limit:1});
 if(active.length||sending.length)fail('channel_busy','本群有成员正在处理消息，完成后即可删除；原工作不会被中断',409);
 await cancelPending(tx,channel.id,'channel_turn',['ready','limited','unavailable','stalled']);
 await cancelPending(tx,channel.id,'outbox',['pending','retry','waiting_subscription','awaiting_poll','sent','awaiting_trigger','accepted','unknown','needs_review','unclaimed']);
 for(const status of ['preparing','running','closing']){
  let after='';for(;;){const rows=await tx.list('channel_meeting',{scope:channel.id,status,page:true,limit:500,after});
   for(const meeting of rows)tx.put('channel_meeting',{...meeting,status:'ended',endedAt:tx.now,endReason:'channel_deleted',recoveryStatus:'canceled',version:(meeting.version||1)+1});
   if(rows.length<500)break;after=rows.at(-1).id;
  }
 }
 return tx.put('channel',{...channel,status:'deleted',previousStatus:channel.status,pinnedAt:null,deletedAt:tx.now,deletedBy:'owner'});
}
