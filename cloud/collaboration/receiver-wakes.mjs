import {receptionIssues} from '../../shared/receiver-reception.mjs';
// Transport retries preserve an event ID. A later invitation to still-unclaimed
// work has its own ID; it never recreates the business turn or execution lease.
export const receiverClaimWait = (transport,receiverKind) =>
  // Old accepted rows predate receiverKind. Wait conservatively until a real
  // dispatch identifies the receiver; do not guess they are fast Bot routines.
  transport === 'dots-events'||transport === 'grok-webhook'&&receiverKind!=='bot-routine'
    ? 10 * 60000 : transport === 'grok-webhook' ? 2 * 60000 : null;
export function wakeExpired(row, now) {
  const wait = receiverClaimWait(row.transport,row.receiverKind);
  return wait !== null && Number.isFinite(Date.parse(row.completedAt)) &&
    Date.parse(row.completedAt) + wait <= Date.parse(now);
}
export const wakeId = row => row.wakeGeneration
  ? `${row.id}:wake:${row.wakeGeneration}` : row.id;
export const eventDeliveryId = (row, subscriptionId) => `${wakeId(row)}:${subscriptionId}`;

export async function resolveReceptionBlock(tx, turn) {
  if(!['done','silent'].includes(turn.status)||!turn.claimedAt||!turn.completedAt)return;
  const connection=await tx.get('connection',turn.memberId,false);
  if(connection?.status!=='verified')return;
  const issues=receptionIssues(connection),resolved=Object.values(issues).filter(issue=>
    (!issue.channelId||issue.channelId===turn.scopeId)&&issue.at<=turn.completedAt);
  if(!resolved.length)return;
  if(turn.status==='done'){
    if(turn.responseRef?.kind!=='message')return;
    const reply=await tx.get('channel_message',turn.responseRef.id,false);
    if(reply?.authorId!==turn.memberId)return;
  }
  for(const issue of resolved)delete issues[issue.channelId||'*'];
  const remaining=Object.values(issues).sort((a,b)=>(b.at||'').localeCompare(a.at||''))[0];
  tx.put('connection',{...connection,receptionIssues:issues,previousSetupIssue:resolved.at(-1),
    setup:remaining||{stage:'verified',message:'原 Agent 已实际接收并回执，旧接收异常已解除。',at:turn.completedAt}});
}
