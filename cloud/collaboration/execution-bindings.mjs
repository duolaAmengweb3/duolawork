import {fail,required,digest} from './repository.mjs';
const native=new Set(['codex','antigravity','gemini-cli','deepseek-harness','claude-code']);
export async function executionResource(tx,connection,channelId){
 const binding=await tx.get('execution_binding',connection.id+':'+channelId,false);
 if(binding?.sessionKey)return 'native-session:'+connection.id+':'+binding.sessionKey;
 // Existing remote runtimes already persist their authorized channel binding.
 for(const kind of ['remote-runtime','native-source']){const source=await tx.get(kind,connection.id,false),sessionId=source?.bindings?.[channelId]?.sessionId;if(sessionId)return 'native-session:'+connection.id+':'+await digest(sessionId);}
 return connection.resourceKey;
}
export async function registerExecutionBindings(repo,identity,actor,input){
 const m=identity.members.find(m=>m.id===actor.memberId&&m.status!=='disabled');
 if(!m||!native.has(m.platformId))fail('forbidden','仅原生运行端可登记自己的工作对话',403);
 if(!Array.isArray(input.bindings)||input.bindings.length>100)fail('invalid_bindings','对话绑定数量无效');
 const bindings=await Promise.all(input.bindings.map(async b=>({channelId:required(b.channelId,'聊天',100),sessionKey:await digest(required(b.sessionId,'对话',200))})));
 return repo.transact(required(input.requestId,'请求编号',120),bindings,async tx=>{
  const c=await tx.get('connection',m.id);if(c.status==='disconnected')fail('disconnected','连接已解除',403);
  const remote=await tx.get('remote-runtime',m.id,false);
  let registered=0;for(const b of bindings){const key=m.id+':'+b.channelId,old=await tx.get('execution_binding',key,false),channel=await tx.get('channel',b.channelId,false);if(!channel?.memberIds.includes(m.id)){if(old)continue;fail('forbidden','成员不在这个聊天',403);}registered++;
   const authoritative=remote?.bindings?.[b.channelId];if(authoritative&&await digest(authoritative.sessionId)!==b.sessionKey){
    // Older receivers stage their local binding before activate. Acknowledge a
    // matching prepared candidate without publishing it before the atomic switch.
    const prepared=(await tx.list('native-command',{parent:m.id,status:'prepared',limit:501})).find(command=>command.channelId===b.channelId);
    if(prepared?.binding?.sessionId&&await digest(prepared.binding.sessionId)===b.sessionKey)continue;
    fail('session_changed','原环境已选择另一段对话，请同步最新绑定后继续',409);
   }
   if(old?.sessionKey===b.sessionKey)continue;
   const occupied=await tx.get('resource',await executionResource(tx,c,b.channelId),false);
   if(occupied?.status==='busy')fail('resource_busy','这段对话还有正在处理的消息，原绑定保留',409);
   tx.put('execution_binding',{id:key,parentId:m.id,scopeId:b.channelId,sessionKey:b.sessionKey,status:'active'});
  }
  return {registered};
 });
}
