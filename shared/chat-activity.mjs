// A reply completes its own turn, not messages that arrived while it ran.
// Match native delivery by step, never by member alone or by an old notification.
export function processingLabel(turn = {}) {
  const progress = typeof turn.progress === 'string' ? turn.progress.trim().replace(/\s+/g, ' ') : '';
  return progress ? `处理中 · ${progress.slice(0, 90)}` : '处理中';
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
    const queued = ready.some(t => t.id === native?.pendingStepId && ['sent','queued'].includes(native.deliveryState));
    const accepted = ready.some(t => notifications.some(n => n.stepId === t.id && n.status === 'accepted'));
    const label = active.length
      ? `${processingLabel(active.at(-1))}${ready.length ? ` · 另有 ${ready.length} 条待处理` : ''}`
      : `${ready.length} 条消息${queued ? '在原会话排队' : accepted ? '等待接收' : '待处理'}`;
    return { memberId, label, working: active.length > 0, turnIds: turns.map(t => t.id) };
  });
}
