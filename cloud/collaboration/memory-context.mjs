import {fail,digest,id,required} from './repository.mjs';
import {access,publicMemory} from './workspace-objects.mjs';
import {workspaceGrant} from './delegation.mjs';
import {meetingHelpers} from './conversation.mjs';
export const MEMORY_TOOLS=[{name:'forget_memory',description:'按用户要求彻底删除共享记忆正文与修订，异步清除语义索引并阻止从相同来源重新学回。只能处理当前获授权范围，不能让原 Agent 远程忘掉已读内容。',inputSchema:{type:'object',properties:{requestId:{type:'string'},channelId:{type:'string'},memoryId:{type:'string'},expectedVersion:{type:'integer'},reason:{type:'string'}},required:['requestId','channelId','memoryId','expectedVersion'],additionalProperties:false}},{name:'review_memory_events',description:'原 Agent 阅读本次用户补充、决定与会议结果后，记录已整理或无需长期记忆。不要每句话创建一条记忆。',inputSchema:{type:'object',properties:{requestId:{type:'string'},channelId:{type:'string'},eventIds:{type:'array',items:{type:'string'},maxItems:50},summary:{type:'string'}},required:['requestId','channelId','eventIds','summary'],additionalProperties:false}}];
export function queueMemoryIndex(tx,memory){tx.put('memory_index_job',{id:memory.id,scopeId:memory.scopeId,parentId:memory.id,status:'pending',memoryVersion:memory.version||1,attempts:0,createdAt:tx.now});}
export async function recordMemoryEvent(tx,channel,source,kind){
 if(source.hidden||source.type==='memory_review')return;
 return tx.put('memory_event',{id:'memory-event:'+source.id+':'+(source.version||1),scopeId:channel.id,parentId:channel.id,sourceId:source.id,sourceKind:kind,sourceVersion:source.version||1,status:'pending',createdAt:tx.now});
}
export async function memoryAuthority(tx,actor,cmd,channel,refs,old){
 const authority=actor.owner?'user_directive':cmd.authority||old?.authority||'proposal';
 if(!['user_directive','observation','proposal'].includes(authority))fail('invalid_authority','记忆依据类型无效');
 const conditions=String(cmd.conditions??old?.conditions??'').trim().slice(0,2000);
 if(authority==='user_directive'&&!actor.owner){
  const source=refs.find(r=>r.kind==='message'&&r.id===cmd.sourceMessageId);
  if(!source)fail('source_required','用户约定需要关联原消息');
  const message=await tx.get('channel_message',source.id);
  const quote=required(cmd.sourceQuote,'用户原话',4000);
  if(message.authorId!=='owner'||!message.body.includes(quote))fail('source_required','原话必须来自本群用户消息');
 }
 if(authority==='observation'&&!refs.length)fail('source_required','背景事实需要可查看的来源');
 const scope=cmd.memoryScope??old?.memoryScope??'channel';if(!['channel','workspace'].includes(scope))fail('invalid_scope','记忆范围无效');
 if(scope==='workspace'&&!actor.owner&&!await workspaceGrant(tx,actor))fail('forbidden','共享到整个工作区需要用户或秘书操作',403);
 const tombstones=await tx.list('memory_tombstone',{scope:channel.id});
 const contentHash=await digest((cmd.title??old?.title??'')+'\n'+(cmd.body??old?.body??''));
 if(tombstones.some(t=>t.contentHash===contentHash||refs.some(r=>t.sourceKeys?.includes(r.kind+':'+r.id+':'+r.version))))fail('forgotten_source','这段来源已被要求遗忘，请使用新的用户要求或新资料',409);
 return {authority,conditions,memoryScope:scope,sourceMessageId:cmd.sourceMessageId||old?.sourceMessageId,sourceQuote:cmd.sourceQuote||old?.sourceQuote,contentHash};
}
async function sourcesAvailable(repo,actor,memory){
 const kinds={message:'channel_message',document:'channel_doc',file:'shared_file',task:'channel_task',meeting:'channel_meeting',memory:'channel_memory',link:'channel_link'};
 for(const ref of memory.refs||[]){
  try{await access(repo,ref.channelId||memory.scopeId,actor);const source=await repo.get(kinds[ref.kind],ref.id,false);
   if(!source||source.status==='deleted'||source.hidden||ref.version!==(source.version||1))return false;
  }catch{return false;}
 }
 return true;
}
async function available(repo,actor,channelId){
 await access(repo,channelId,actor);
 const rows=await repo.db.prepare("SELECT body FROM hub_v2_records WHERE workspace_id=? AND kind='channel_memory' AND status='approved' AND (scope_id=? OR json_extract(body,'$.memoryScope')='workspace') ORDER BY updated_at DESC LIMIT 2001").bind(repo.workspaceId,channelId).all();
 const result=[];
 for(const row of rows.results){const memory=JSON.parse(row.body);if(memory.sourceUnavailable||memory.expiresAt&&memory.expiresAt<=new Date().toISOString())continue;
  // Sharing a memory never grants access to the original chat. Explicit workspace
  // records may carry only sources the recipient can actually read.
  if(await sourcesAvailable(repo,actor,memory))result.push(memory);
 }
 return result;
}
export async function recallMemory(repo,actor,args,service){
 const list=await available(repo,actor,args.channelId),query=String(args.query||'').trim().slice(0,8000),topK=8;
 const mandatory=list.filter(m=>m.authority==='user_directive'||['requirement','decision'].includes(m.category));
 const tokens=[...new Set(query.toLowerCase().match(/[a-z0-9_-]+|[\u3400-\u9fff]{1,2}/g)||[])];
 const lexical=list.map(m=>({memory:m,score:tokens.reduce((score,t)=>score+Number((m.title+' '+m.body+' '+(m.conditions||'')).toLowerCase().includes(t)),0)})).filter(x=>!query||x.score>0).sort((a,b)=>b.score-a.score).slice(0,topK);
 let retrieval='keyword',hits=[],reason;
 if(query&&service){try{hits=await service.search(query,{channelId:args.channelId,allowedScopes:[...new Set(list.map(m=>m.memoryScope==='workspace'?'__workspace':m.scopeId))]});retrieval='hybrid';}catch{reason='语义检索暂不可用，当前使用关键词；已保存的约定仍会提供。';}}
 else if(query)reason='语义索引尚未配置，当前使用关键词。';
 const byId=new Map(list.map(m=>[m.id,m])),ranks=new Map();
 for(const [rank,hit] of hits.entries()){const m=byId.get(hit.memoryId||hit.metadata?.hubMemoryId);if(m&&(hit.version??hit.metadata?.hubVersion)===(m.version||1))ranks.set(m.id,(ranks.get(m.id)||0)+1/(60+rank));}
 for(const [rank,{memory:m}]of lexical.entries())ranks.set(m.id,(ranks.get(m.id)||0)+1/(60+rank));
 const ranked=[...ranks].sort((a,b)=>b[1]-a[1]).slice(0,topK).map(([key])=>byId.get(key));
 // Validate once more after the remote search; a concurrent edit/forget cannot revive stale data.
 const selected=[...new Map([...mandatory,...ranked].map(m=>[m.id,m])).values()],items=[];
 for(const memory of selected){const fresh=await repo.get('channel_memory',memory.id,false);if(fresh?.status==='approved'&&fresh.version===memory.version&&!fresh.sourceUnavailable&&await sourcesAvailable(repo,actor,fresh))items.push(publicMemory(fresh));}
 if(actor.memberId&&items.length)await repo.transact('memory-read:'+id('r'),{ids:items.map(m=>m.id),actor},tx=>{for(const m of items)tx.put('shared_read',{id:m.id+':'+actor.memberId+':'+args.channelId,parentId:m.id,scopeId:args.channelId,memberId:actor.memberId,version:m.version,createdAt:tx.now});});
 await access(repo,args.channelId,actor);
 return {items,retrieval,reason,mandatoryIds:items.filter(m=>mandatory.some(x=>x.id===m.id)).map(m=>m.id),truncated:list.length>2000};
}
export async function memoryTool(repo,actor,name,args,identity){
 await access(repo,args.channelId,actor);
 const result=await repo.transact(args.requestId,{actor,args,name},async tx=>{
  await access(tx,args.channelId,actor);
  if(name==='review_memory_events'){
   if(!Array.isArray(args.eventIds)||args.eventIds.length>50)fail('invalid_events','记忆事件无效');
   for(const key of args.eventIds){const e=await tx.get('memory_event',key);if(e.scopeId!==args.channelId)fail('forbidden','事件不在当前聊天',403);tx.put('memory_event',{...e,status:'reviewed',reviewedBy:actor.memberId||'owner',summary:required(args.summary,'整理说明',1000)});}return {reviewed:args.eventIds.length};
  }
  const m=await tx.get('channel_memory',args.memoryId);
  if(m.scopeId!==args.channelId)fail('forbidden','记忆不在当前聊天',403);
  if(m.version!==args.expectedVersion)fail('version_conflict','记忆已更新，请刷新',409);
  // Native agents must carry the owner's actual deletion request in their work;
  // deletion is logged with the real actor, never disguised as owner approval.
  tx.put('memory_tombstone',{id:m.id,scopeId:m.scopeId,parentId:m.id,contentHash:m.contentHash||await digest(m.title+'\n'+m.body),sourceKeys:(m.refs||[]).map(r=>r.kind+':'+r.id+':'+r.version),deletedBy:actor.memberId||'owner',deletedAt:tx.now,status:'forgotten'});
  const tombstone={id:m.id,scopeId:m.scopeId,parentId:m.parentId,version:m.version+1,status:'deleted',deletedAt:tx.now,deletedBy:actor.memberId||'owner',createdAt:m.createdAt};
  tx.put('channel_memory',tombstone);
  for(const v of await tx.list('channel_memory_version',{parent:m.id}))tx.put('channel_memory_version',{id:v.id,scopeId:m.scopeId,parentId:m.id,version:v.version,status:'deleted',deletedAt:tx.now});
  queueMemoryIndex(tx,tombstone);
  if(identity){
   const readers=await tx.list('shared_read',{parent:m.id}),groups=new Map();
   for(const r of readers){if(r.memberId===actor.memberId)continue;const channel=await tx.get('channel',r.scopeId,false);if(!channel?.memberIds.includes(r.memberId))continue;if(!groups.has(channel.id))groups.set(channel.id,{channel,members:new Set()});groups.get(channel.id).members.add(r.memberId);}
   for(const {channel,members} of groups.values()){const notice=await meetingHelpers.channelMessage(tx,channel,{memberId:'system'},'之前提供的一条共享记忆已被删除，请停止将它作为当前依据。原会话中已经读过的内容无法远程抹除。',{type:'memory_review',forgottenMemoryId:m.id,hops:0,mentions:[...members]});for(const mid of members)await meetingHelpers.enqueue(tx,identity,channel,notice,mid);}
  }
  return {id:m.id,status:'deleted',version:tombstone.version,indexCleanup:'pending',message:'已停止提供这条记忆，正文与修订已清除；语义索引正在清理。原会话已读内容无法远程抹除。'};
 });
 if(name==='forget_memory')await repo.persistMemoryForget?.(args.memoryId);
 return result;
}
