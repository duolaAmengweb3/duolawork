// A connection is reusable. A native working context belongs to an explicit
// (Hub conversation, member) assignment, never to the last opened UI window.
export function acceptsWork(binding, work) {
  if (!Array.isArray(binding.channelIds)) return true; // persisted legacy binding
  return work.channelId ? binding.channelIds.includes(work.channelId) : binding.verification === true;
}

export function nativeBindings(record) {
  if (!record.chatBindings) return record.sessionId ? [{sessionId:record.sessionId, workspace:record.cwd}] : [];
  const result = new Map();
  for (const [channelId, b] of Object.entries(record.chatBindings)) {
    const item = result.get(b.sessionId) || {sessionId:b.sessionId, workspace:b.workspace, channelIds:[], verification:b.sessionId===record.verificationSessionId};
    item.channelIds.push(channelId); result.set(b.sessionId,item);
  }
  if(record.verificationSessionId&&!result.has(record.verificationSessionId)&&record.cwd)result.set(record.verificationSessionId,{sessionId:record.verificationSessionId,workspace:record.cwd,channelIds:[],verification:true});
  return [...result.values()];
}

export function publicAssignments(record) {
  return Object.entries(record.chatBindings || {}).map(([channelId,b])=>({channelId,...b}));
}

export const SESSION_CAPABILITIES = {
  'claude-code':{kind:'sessions',existing:true,create:false,multiple:true,label:'Claude 工作会话',remote:true,createHint:'在 Claude 所在的项目目录打开已接入的会话，再点刷新。'},
  codex: {kind:'sessions', existing:true, create:true, multiple:true, label:'Codex 工作会话'},
  antigravity: {kind:'sessions', existing:true, create:false, multiple:true, label:'Antigravity 桌面会话', createHint:'请先在官方桌面新建会话，再回到这里选择。'},
  'deepseek-harness': {kind:'sessions', existing:true, create:true, multiple:true, label:'DeepSeek Harness 工作会话'},
  'grok-bot': {kind:'fixed', existing:false, create:false, multiple:true, label:'原 Grok Bot'},
  dots: {kind:'fixed', existing:false, create:false, multiple:true, label:'原 Dot Agent'},
};
