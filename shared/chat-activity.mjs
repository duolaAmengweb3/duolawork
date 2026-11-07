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
  return notice?.status === 'accepted' ? '等待成员接收' : '等待接收';
}
export function nativeTurnDelivery(turn, native) {
  if(!turn?.id)return;
  return [...(native?.assignments||[]),native].find(state=>state?.pendingStepId===turn.id);
}
export function nativeReceptionProblem(native,channelId){
  if(!native)return null;
  const bound=native.assignments?.find(b=>b.channelId===channelId);
  if(bound?.nativeIssueCode==='session_offline'&&Date.now()-Date.parse(bound.observedAt||0)<30000)
    return {kind:'unavailable',label:'原会话未连接',working:false,detail:bound.nativeMessage+' 消息已保存，恢复后继续接收，无需重发。'};
  if(native.enabled===false||['offline','disconnected','waiting_login'].includes(native.status))
    return {kind:'unavailable',label:'原环境未连接',working:false,detail:(native.message||'请在原环境打开已接入的 Agent。')+' 消息已保存，恢复后继续接收，无需重发。'};
  if(bound?.nativeState==='unavailable'&&Date.now()-Date.parse(bound.observedAt||0)<30000){
    if(bound.nativeIssueCode==='connection_retry')return {kind:'recovering',label:'连接恢复中',working:false,detail:bound.nativeMessage};
    return {kind:'unavailable',label:'对话暂不可用',working:false,detail:(bound.nativeMessage||'请打开原对话或在本聊天重新选择。')+' 原消息保留，其他对话不受影响。'};
  }
  if(native.status==='needs_review')return {kind:'unavailable',label:'连接需要处理',working:false,detail:native.message||'请查看成员连接中的具体原因，原消息已保留。'};
  return null;
}
// Queueing needs evidence for this message or its bound conversation. An account
// running in another conversation, or a missing claim, is not queue evidence.
export function pendingTurnState(turn = {}, notice, native, activity = []) {
  if(turn.status==='active')return {kind:'processing',label:processingLabel(turn),working:true,detail:turn.progress||'Agent 已接收这条消息，正在处理。无需重发。'};
  if(turn.status==='limited'&&turn.resumeAfter)return {kind:'delayed',label:'稍后自动继续',working:false,detail:'短时间内通知较多，系统会自动继续发送。原消息已保存，无需重发。'};
  if(turn.status!=='ready')return null;
  const problem=nativeReceptionProblem(native,turn.scopeId||turn.channelId);
  if(problem)return problem;
  const delivery=nativeTurnDelivery(turn,native);
  if(delivery?.deliveryState==='queued')return {kind:'queued',label:'排队中',working:false,detail:'这段原对话正在工作，这条消息已在原对话排队，空闲后会继续接收。无需重发。'};
  if(delivery?.deliveryState==='sent')return {kind:'delivered',label:'已送达，等待接收',working:false,detail:'消息已送入原对话，等待 Agent 确认接收。无需重发。'};
  if(delivery?.deliveryState==='working'||!delivery?.deliveryState&&delivery?.workState==='working')return {kind:'receiving',label:'正在接收',working:true,detail:'原对话已开始接收这条消息，尚未返回处理回执。无需重发。'};
  const channelId=turn.scopeId||turn.channelId;
  const bound=channelId&&native?.assignments?.find(a=>a.channelId===channelId);
  const blocker=bound?.pendingStepId&&bound.pendingStepId!==turn.id&&activity.find(t=>t.id===bound.pendingStepId&&t.memberId===turn.memberId&&t.status==='active');
  if(blocker)return {kind:'queued',label:'排队中',working:false,detail:'这段原对话正在处理前一条消息，完成后会接收这条消息。无需重发。',waitingForMessageId:blocker.messageId};
  return {kind:'waiting',label:waitingLabel(notice),working:false,detail:notice?.unclaimedRetry?'尚未收到 Agent 的接收回执，系统正在重新通知。原消息已保存，无需重发。':'消息已保存，正在等待 Agent 接收。无需重发。'};
}
export function pendingMemberActivity(activity = [], notifications = [], nativeMembers = []) {
  const grouped = new Map();
  for (const turn of activity) {
    if (!['ready', 'active'].includes(turn.status)&&!(turn.status==='limited'&&turn.resumeAfter)) continue;
    if (!grouped.has(turn.memberId)) grouped.set(turn.memberId, []);
    grouped.get(turn.memberId).push(turn);
  }
  return [...grouped].map(([memberId, turns]) => {
    const active = turns.filter(t => t.status === 'active');
    const ready = turns.filter(t => t.status === 'ready'||t.resumeAfter);
    const native = nativeMembers.find(m => m.memberId === memberId);
    const states=ready.map(t=>pendingTurnState(t,turnNotification(t,notifications),native,activity));
    const counts=new Map();
    for(const state of states)counts.set(state.label,(counts.get(state.label)||0)+1);
    const label = active.length
      ? `${processingLabel(active.at(-1))}${ready.length ? ` · 另有 ${ready.length} 条待处理` : ''}`
      : [...counts].map(([label,count])=>`${count} 条消息${label}`).join(' · ');
    return { memberId, label, working: active.length > 0||states.some(s=>s.working), turnIds: turns.map(t => t.id) };
  });
}
