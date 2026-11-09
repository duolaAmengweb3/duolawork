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
