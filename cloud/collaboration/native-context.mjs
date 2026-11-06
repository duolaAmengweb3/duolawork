import {digest} from './repository.mjs';

// An acknowledgement belongs to an exact group/member/native conversation.
// Ordinary bots and receivers without the new contract always get full history.
export async function nativeMessageContext(repo,turn,messages,triggerIds=[]){
  if(!turn.nativeSessionId||turn.nativeContextMode!=='incremental')return {messages,history:{mode:'full'}};
  const key=turn.memberId+':'+turn.scopeId+':'+await digest(turn.nativeSessionId);
  const previous=await repo.get('native_context_checkpoint',key,false),known=new Map(previous?.messages?.map(m=>[m.id,m.fingerprint])||[]);
  const versions=await Promise.all(messages.map(async m=>({id:m.id,fingerprint:await digest(JSON.stringify(m))})));
  const triggers=new Set(triggerIds),inline=[],references=[];
  for(let i=0;i<messages.length;i++){
    const m=messages[i];
    if(m.authorId==='owner'||triggers.has(m.id)||known.get(m.id)!==versions[i].fingerprint)inline.push(m);
    else references.push({id:m.id,number:m.number,authorId:m.authorId,version:m.version||1,refs:m.refs||[]});
  }
  await repo.transact('native-context:'+turn.id,{turnId:turn.id,key},async tx=>{
    const current=await tx.get('channel_turn',turn.id);
    if(current.status==='active'&&current.nativeSessionId===turn.nativeSessionId)tx.put('native_context_delivery',{id:turn.id,parentId:turn.memberId,scopeId:turn.scopeId,key,messages:versions,status:'prepared'});
    return{};
  });
  return {messages:inline,history:{mode:previous?'incremental':'full',previousAcknowledgedTurnId:previous?.turnId||null,previouslyProvided:references,
    restore:{tool:'read_channel',arguments:{channelId:turn.scopeId}},
    instruction:'仅省略同一原生会话已回复确认、且未变化的旧 Agent 消息；用户原话、新消息、当前触发消息和共享约定仍完整提供。此前提供过不表示你在压缩后仍记得；若当前上下文缺少相关依据，先用 read_channel 或 read_space_object(kind=message,id,channelId)读原文，不能从索引猜结论。所有原消息均保留。'}};
}

export async function acknowledgeNativeContext(tx,turn){
  const delivery=await tx.get('native_context_delivery',turn.id,false);if(!delivery)return;
  tx.put('native_context_checkpoint',{id:delivery.key,parentId:turn.memberId,scopeId:turn.scopeId,turnId:turn.id,messages:delivery.messages,acknowledgedAt:tx.now});
  tx.put('native_context_delivery',{...delivery,status:'acknowledged'});
}
