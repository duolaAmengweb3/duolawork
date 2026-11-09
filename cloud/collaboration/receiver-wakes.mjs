// Transport retries preserve an event ID. A later invitation to still-unclaimed
// work has its own ID; it never recreates the business turn or execution lease.
export const receiverClaimWait = transport =>
  transport === 'dots-events' ? 10 * 60000 : transport === 'grok-webhook' ? 2 * 60000 : null;
export function wakeExpired(row, now) {
  const wait = receiverClaimWait(row.transport);
  return wait !== null && Number.isFinite(Date.parse(row.completedAt)) &&
    Date.parse(row.completedAt) + wait <= Date.parse(now);
}
export const wakeId = row => row.wakeGeneration
  ? `${row.id}:wake:${row.wakeGeneration}` : row.id;
export const eventDeliveryId = (row, subscriptionId) => `${wakeId(row)}:${subscriptionId}`;
