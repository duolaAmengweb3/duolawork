// A reply completes its own turn, not messages that arrived while it ran.
// Match native delivery by step, never by member alone or by an old notification.
export function processingLabel(turn = {}) {
  const progress = typeof turn.progress === 'string' ? turn.progress.trim().replace(/\s+/g, ' ') : '';
  return progress ? `处理中 · ${progress.slice(0, 90)}` : '处理中';
}
export function turnNotification(turn, notifications = []) {
  const notice = notifications.find(n => n.stepId === turn.id);
  return notice?.status === 'coalesced'
    ? notifications.find(n => n.id === notice.coalescedInto) || notice
    : notice;
}
export function waitingLabel(notice) {
  if (notice?.unclaimedRetry && ['retry','sending'].includes(notice.status)) return '尚未接收 · 正在重新通知';
  if (notice?.unclaimedRetry && notice.status === 'accepted') return '尚未接收 · 已重新通知';
  return notice?.status === 'accepted' ? '等待成员接收' : '排队中';
}
export function nativeTurnDelivery(turn, native) {
  return [native,...(native?.assignments||[])].find(state=>state?.pendingStepId===turn.id&&['sent','queued'].includes(state.deliveryState));
}
export function pendingMemberActivity(activity = [], notifications = [], nativeMembers = []) {
  const grouped = new Map();
  for (const turn of activity) {
    if (!['ready', 'active'].includes(turn.status)) continue;
    if (!grouped.has(turn.memberId)) grouped.set(turn.memberId, []);
    grouped.get(turn.memberId).push(turn);
  }
  return [...grouped].map(([memberId, turns]) => {
    const active = turns.filter(t => t.status === 'active');
    const ready = turns.filter(t => t.status === 'ready');
    const native = nativeMembers.find(m => m.memberId === memberId);
    const queued = ready.some(t => nativeTurnDelivery(t,native));
    const notices = ready.map(t => turnNotification(t, notifications));
    const retried = notices.find(n => n?.unclaimedRetry && ['accepted','retry','sending'].includes(n.status));
    const accepted = notices.find(n => n?.status === 'accepted');
    const label = active.length
      ? `${processingLabel(active.at(-1))}${ready.length ? ` · 另有 ${ready.length} 条待处理` : ''}`
      : `${ready.length} 条消息${queued ? '排队中 · 已进入原会话' : retried || accepted ? waitingLabel(retried || accepted) : '排队中'}`;
    return { memberId, label, working: active.length > 0, turnIds: turns.map(t => t.id) };
  });
}
