// A connection is reusable. A native working context belongs to an explicit
// (Hub conversation, member) assignment, never to the last opened UI window.
export function acceptsWork(binding, work) {
  if (!Array.isArray(binding.channelIds)) return true; // persisted legacy binding
  return work.channelId ? binding.channelIds.includes(work.channelId) : binding.verification === true;
}

// One contract for all native adapters. The server atomically validates the
// addressed group, actual session, membership, lease and idempotent request.
export function claimNativeConversation(client,{requestId,stepId,channelId,sessionId,contextMode='incremental'}) {
  if(!requestId||!channelId||!sessionId||!(stepId?.startsWith('turn_')||stepId?.startsWith('inbox:after:')))
    throw Error('领取原会话消息需要完整的消息、聊天和会话标识');
  return client.tool('claim_work',{requestId,stepId,channelId,expectedSessionId:sessionId,contextMode});
}

// ACP MCP and Codex dynamic tools share the same execution scope. The session
// and active assignment come from the receiver, never from model arguments.
export async function claimNativeAssignment(client,{args,sessionId,active}){
  if(!active||!sessionId)throw Error('当前原会话没有待领取的工作');
  if(args.channelId&&args.channelId!==active.key)throw Error('工作属于其他聊天会话，未领取');
  const continuation=args.stepId?.startsWith('inbox:after:');
  if(args.stepId!==active.stepId&&!continuation)throw Error('工作不是本次原会话接收的消息，未领取');
  if(active.key?.startsWith('channel_')&&(args.stepId?.startsWith('turn_')||continuation))
    return claimNativeConversation(client,{...args,channelId:active.key,sessionId});
  const {work}=await client.tool('list_work');
  if(!work.some(w=>w.stepId===args.stepId&&(w.channelId?w.channelId===active.key:w.stepId===active.stepId)))throw Error('工作属于其他聊天会话，未领取');
  return client.tool('claim_work',{...args,expectedSessionId:sessionId});
}

export function receiveNativeConversation(client,{args,channelId,sessionId}){
  if(!channelId||!sessionId||args.channelId&&args.channelId!==channelId)throw Error('收件范围必须是当前原会话的聊天');
  return client.tool('receive_messages',{...args,channelId,expectedSessionId:sessionId,contextMode:args.contextMode||'incremental'});
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
