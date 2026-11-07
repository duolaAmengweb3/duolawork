import {createHash} from 'node:crypto';
const subscriptions=new Map();
const wakeKinds=new Set(['channel_turn','step','execution_binding','native-command','session-link','connection','channel']);
export function subscribeNativeChanges(client,listener){
  if(typeof client.watch!=='function')return ()=>{};
  const key=client.file||client;let entry=subscriptions.get(key);
  if(!entry){entry={listeners:new Set()};subscriptions.set(key,entry);entry.watch=client.watch(page=>{if(page.reset||page.changes.some(c=>wakeKinds.has(c.kind)))for(const fn of entry.listeners)fn(page);});}
  entry.listeners.add(listener);
  return ()=>{entry.listeners.delete(listener);if(!entry.listeners.size){entry.watch.stop();subscriptions.delete(key);}};
}
export const readNativeInbox=client=>typeof client.inbox==='function'?client.inbox():client.tool('list_work');
export async function deliveryReceipt(client,work,sessionId,phase='received'){
  if(!work.delivery||!sessionId)return; // Older server / formal verification has no transport envelope.
  const attempt=work.delivery.attempt;
  const sourceVersion=work.delivery.message?.version||1;
  const requestId='delivery-'+createHash('sha256').update(JSON.stringify([work.stepId,sessionId,attempt,sourceVersion,phase])).digest('hex');
  return client.api('/v2/self/delivery',{method:'POST',body:{requestId,turnId:work.stepId,sessionId,attempt,phase,sourceVersion}});
}
// Shared wording for native interactive adapters. A notification is a bounded
// side conversation, not permission to abandon an already authorized user task.
export const CONTINUE_PRIMARY_WORK='这是一条协作通知，不替代原会话中用户已授权但尚未完成的主任务。回传本通知后，若原主任务仍未完成且用户未停止、暂停或改变它，继续原任务至原验收目标；不要把回群成功说成主任务完成。不要主动领取其他通知、follow-up、inbox:after 或循环监听。若原主任务已结束或被用户停止，则结束本轮。';
