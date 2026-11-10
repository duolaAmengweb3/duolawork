// Group the same delivery by its source, not by the number of recipients.
export function deliveryView(snapshot={},members=[],nativeMembers=[]) {
 const activity=(snapshot.activity||[]).filter(t=>!t.deliveryReview);
 const issues=snapshot.deliveryIssues||[],tracked=new Set(issues.flatMap(i=>i.turnIds||[]));
 const waiting=new Map(),untracked=new Map(),local=new Map();
 for(const t of activity){
  if(['ready','active'].includes(t.status)||t.status==='limited'&&t.resumeAfter){
   const member=members.find(m=>m.id===t.memberId),native=nativeMembers.find(m=>m.memberId===t.memberId);
   const coding=['codex','gemini-cli','antigravity','deepseek-harness','claude-code'].includes(member?.platformId);
   const offline=coding&&native&&(!native.enabled||['offline','disconnected','waiting_login'].includes(native.status));
   const unbound=coding&&native?.enabled&&native.manualAssignments!==false&&Array.isArray(native.assignments)&&!native.assignments.some(a=>a.channelId===snapshot.channel?.id);
   if(t.status==='ready'&&(offline||unbound)){
    const id='local_'+t.memberId;if(!local.has(id))local.set(id,{id,local:true,messageId:t.messageId,rootId:t.rootId,status:'needs_user',action:offline?'connect':'select_session',cause:offline?'connection':'context',memberIds:[t.memberId],turnIds:[],summary:offline?`${member.name} 的原运行环境尚未连接，消息已保存。`:`请为 ${member.name} 选择在这个聊天里继续的工作对话。`,nextAction:offline?'打开成员连接，恢复后会继续接收。':'可以选择已有对话或新建；选择后，已发送的消息会继续投递。'});
    local.get(id).turnIds.push(t.id);continue;
   }
   if(issues.some(i=>i.status!=='resolved'&&i.turnIds?.includes(t.id)))continue;
   if(!waiting.has(t.messageId))waiting.set(t.messageId,{id:t.messageId,messageId:t.messageId,turns:[]});
   waiting.get(t.messageId).turns.push(t);
  }else if(['limited','stalled','unavailable'].includes(t.status)&&!tracked.has(t.id)){
   if(!untracked.has(t.messageId))untracked.set(t.messageId,{id:t.messageId,messageId:t.messageId,rootId:t.rootId,status:'reviewing',memberIds:[],turnIds:[],impact:'正在核对这条消息的送达情况，原消息已保留。'});
   const group=untracked.get(t.messageId);group.memberIds.push(t.memberId);group.turnIds.push(t.id);
  }
 }
 return {attention:[...issues.filter(i=>i.status==='needs_user'),...local.values()],recovering:[...issues.filter(i=>['reviewing','recovering'].includes(i.status)),...untracked.values()],waiting:[...waiting.values()],history:activity.filter(t=>!['ready','active','limited','stalled','unavailable','merged'].includes(t.status)),resolved:issues.filter(i=>i.status==='resolved')};
}
