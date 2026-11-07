import {fail,id,required,digest} from './repository.mjs';
import {access,validateRefs,publicMemory} from './workspace-objects.mjs';
import {queueMemoryIndex,sourcesAvailable,memoryRows,currentMemoryRefs,mergeMemoryRefs} from './memory-context.mjs';

const string={type:'string'},number={type:'integer',minimum:1};
const refs={type:'array',maxItems:20,items:{type:'object',properties:{kind:string,id:string,version:number},required:['kind','id'],additionalProperties:false}};
export const GROUP_MEMORY_TOOLS=[{
 name:'group_memory',
 description:'自动维护本群话题经历，无需用户逐条批准。list/read 查询；record 新建话题或追加关键变化，复用 topicId，带真实来源 refs。summary 是当前理解，不是完成回执；dissent/question 保留未决问题。提问不是授权或决定，实现状态无证据时保留question。用correction和supersededEpisodeIds标记被纠正的旧经历，保留历史但不再作为当前约束。并发旧版本只追加不覆盖。link 关联、merge 合并、split 拆分话题均保留历史与来源。',
 inputSchema:{type:'object',properties:{requestId:string,channelId:string,action:{type:'string',enum:['list','read','record','link','merge','split']},topicId:string,topicKey:string,expectedVersion:number,title:string,summary:string,body:string,phase:{type:'string',enum:['goal','change','evidence','decision','result','question','dissent','correction']},refs,eventIds:{type:'array',items:string,maxItems:50},relatedTopicIds:{type:'array',items:string,maxItems:20},resolvedEpisodeIds:{type:'array',items:string,maxItems:50},episodeIds:{type:'array',items:string,maxItems:50},supersededEpisodeIds:{type:'array',items:string,maxItems:50},query:string,after:string,eventAfter:string},required:['channelId','action'],additionalProperties:false}
}];

export async function memoryEvents(repo,channelId,{after='',limit=50}={}){
 const rows=await repo.list('memory_event',{scope:channelId,status:'pending',after,limit:limit+1});
 const events=[];
 const kinds={message:'channel_message',task:'channel_task',meeting:'channel_meeting',document:'channel_doc'};
 for(const e of rows.slice(0,limit)){
  const source=await repo.get(kinds[e.sourceKind],e.sourceId,false);
  // Supply exact references; no copy of a withdrawn/private source enters a job.
  events.push({...e,sourceAvailable:!!source&&!source.hidden&&source.status!=='deleted'&&(source.version||1)===e.sourceVersion,read:{tool:'read_space_object',arguments:{channelId,kind:e.sourceKind,id:e.sourceId,version:e.sourceVersion}}});
 }
 const database=repo.db||repo.repo.db,workspaceId=repo.workspaceId||repo.repo.workspaceId;
 const totals=await database.prepare("SELECT status,COUNT(*) AS n FROM hub_v2_records WHERE workspace_id=? AND kind='memory_event' AND scope_id=? GROUP BY status").bind(workspaceId,channelId).all();
 return {events,next:rows.length>limit?rows[limit-1].id:null,pending:totals.results.find(r=>r.status==='pending')?.n||0,reviewed:totals.results.find(r=>r.status==='reviewed')?.n||0,coverage:'逐项记录；未整理事件仍可读取原文，不以最大序号推断完整覆盖'};
}

async function topicRecord(repo,channelId,key){
 const m=await repo.get('channel_memory',key);
 if(m.scopeId!==channelId||m.memoryType!=='topic'||m.status==='deleted')fail('not_found','本群话题不存在',404);
 return m;
}
async function safeTopic(repo,actor,m){
 m={...m,refs:await currentMemoryRefs(repo,m)};
 const fresh=m.refs?.length&&await sourcesAvailable(repo,actor,m);
 return fresh?publicMemory(m):{id:m.id,scopeId:m.scopeId,memoryType:'topic',title:'来源已变化的话题',version:m.version,status:m.status,body:'部分来源已修改或不可用，请核对最新原件后更新理解。',sourceUnavailable:true,refs:[],relatedTopicIds:m.relatedTopicIds||[]};
}
export async function readGroupMemory(repo,actor,args){
 await access(repo,args.channelId,actor);
 if(args.topicId){
  const m=await topicRecord(repo,args.channelId,args.topicId);
  const rows=await repo.list('memory_episode',{scope:args.channelId,parent:m.id,after:args.after||'',limit:101});
  const episodes=[];
  for(const e of rows.slice(0,100))episodes.push(await sourcesAvailable(repo,actor,e)?e:{id:e.id,phase:e.phase,createdAt:e.createdAt,authorId:e.authorId,body:'来源已变化或不可用',refs:[],sourceUnavailable:true});
  return {...await safeTopic(repo,actor,m),episodes,next:rows.length>100?rows[99].id:null};
 }
 const q=String(args.query||'').trim().toLowerCase();
 const database=repo.db||repo.repo.db,workspaceId=repo.workspaceId||repo.repo.workspaceId;
 const rows=await database.prepare("SELECT body FROM hub_v2_records WHERE workspace_id=? AND kind='channel_memory' AND scope_id=? AND id>? AND status!='deleted' AND json_extract(body,'$.memoryType')='topic' AND (?='' OR instr(lower(COALESCE(json_extract(body,'$.title'),'')||' '||COALESCE(json_extract(body,'$.body'),'')),?)>0) ORDER BY id LIMIT 101").bind(workspaceId,args.channelId,args.after||'',q,q).all();
 const items=[];
 for(const {body} of rows.results.slice(0,100)){const m=await safeTopic(repo,actor,JSON.parse(body));if(!q||(m.title+' '+m.body).toLowerCase().includes(q))items.push(m);}
 return {items,next:rows.results.length>100?JSON.parse(rows.results[99].body).id:null,...(args.includeCoverage===false?{}:{coverage:await memoryEvents(repo,args.channelId,{after:args.eventAfter})})};
}

export async function groupMemoryTool(repo,actor,args){
 await access(repo,args.channelId,actor);
 if(['list','read'].includes(args.action)){
  const result=await readGroupMemory(repo,actor,args),items=args.topicId?[result]:result.items;
  if(actor.memberId&&items.some(m=>!m.sourceUnavailable))await repo.transact('topic-read:'+id('r'),{actor,ids:items.map(m=>m.id)},async tx=>{
   await access(tx,args.channelId,actor);
   for(const m of items){const current=await tx.get('channel_memory',m.id,false);if(!m.sourceUnavailable&&current?.status!=='deleted'&&current?.version===m.version)tx.put('shared_read',{id:m.id+':'+actor.memberId+':'+args.channelId,parentId:m.id,scopeId:args.channelId,memberId:actor.memberId,version:m.version,createdAt:tx.now});}
  });
  return result;
 }
 required(args.requestId,'请求编号',150);
 return repo.transact(args.requestId,{actor,args},async tx=>{
  const channel=await access(tx,args.channelId,actor),authorId=actor.memberId||'owner';
  if(['merge','split','link'].includes(args.action)){
   const original=await topicRecord(tx,channel.id,args.topicId);
   if(args.expectedVersion!==original.version)fail('version_conflict','话题已有更新，请重新读取',409);
   const related=[...new Set(args.relatedTopicIds||[])];
   if(related.length>20||related.includes(original.id))fail('invalid_topics','关联话题无效');
   for(const key of related)await topicRecord(tx,channel.id,key);
   if(args.action==='merge'&&!related.length)fail('invalid_topics','请选择要合并的话题');
   let target=original;
   if(args.action==='split'){
    const selected=args.episodeIds||[];if(!selected.length||selected.length>50)fail('invalid_episodes','请选择要拆分的经历');
    const entries=await Promise.all(selected.map(key=>tx.get('memory_episode',key)));
    if(entries.some(e=>e.parentId!==original.id||e.scopeId!==channel.id))fail('forbidden','经历不属于本话题',403);
    const splitRefs=await validateRefs(tx,channel.id,args.refs||[]);if(!splitRefs.length||!await sourcesAvailable(tx,actor,{scopeId:channel.id,refs:splitRefs}))fail('source_required','拆分总结需要当前有效来源');
    target=tx.put('channel_memory',{...original,id:id('topic'),title:required(args.title,'新话题标题',160),body:required(args.summary,'新话题理解',12000),refs:splitRefs,version:1,authorId,lastEditorId:authorId,createdAt:tx.now,episodeCount:0,relatedTopicIds:[original.id],sourceUnavailable:false,unresolvedEpisodeIds:entries.filter(e=>original.unresolvedEpisodeIds?.includes(e.id)).map(e=>e.id),needsReconcile:entries.some(e=>original.unresolvedEpisodeIds?.includes(e.id))});
    for(const [i,e] of entries.entries()){const movedId=target.id+':'+String(i+1).padStart(9,'0');tx.put('memory_episode',{...e,id:movedId,parentId:target.id,previousTopicId:original.id,previousEpisodeId:e.id});tx.put('memory_episode',{id:e.id,scopeId:channel.id,parentId:original.id,phase:'change',body:'这段经历已拆分到关联话题。',refs:splitRefs,createdAt:tx.now,movedTo:target.id});}
    target=tx.put('channel_memory',{...target,episodeCount:entries.length,unresolvedEpisodeIds:entries.flatMap((e,i)=>original.unresolvedEpisodeIds?.includes(e.id)?[target.id+':'+String(i+1).padStart(9,'0')]:[])});tx.put('channel_memory_version',{...target,id:target.id+':1',parentId:target.id,reason:'split'});
    related.push(target.id);queueMemoryIndex(tx,target);
   }
   const updated=tx.put('channel_memory',{...original,relatedTopicIds:[...new Set([...(original.relatedTopicIds||[]),...related])],version:original.version+1,lastEditorId:authorId});
   tx.put('channel_memory_version',{...updated,id:updated.id+':'+updated.version,parentId:updated.id,reason:args.action});
   if(args.action==='merge')for(const key of related){const other=await topicRecord(tx,channel.id,key);const merged=tx.put('channel_memory',{...other,mergedInto:original.id,relatedTopicIds:[...new Set([...(other.relatedTopicIds||[]),original.id])],version:other.version+1,lastEditorId:authorId});tx.put('channel_memory_version',{...merged,id:merged.id+':'+merged.version,parentId:merged.id,reason:'merge'});queueMemoryIndex(tx,merged);}
   queueMemoryIndex(tx,updated);
   return {topic:target.id===original.id?updated:target,original:updated.id,historyPreserved:true};
  }
  if(args.action!=='record')fail('invalid_action','话题操作无效');
  let old=args.topicId?await topicRecord(tx,channel.id,args.topicId):null;
  const key=args.topicKey?'topic_'+(await digest(channel.id+':'+required(args.topicKey,'话题标识',200))).slice(0,32):null;
  if(!old&&key)old=await tx.get('channel_memory',key,false);
  if(old?.status==='deleted'||key&&await tx.get('memory_tombstone',key,false))fail('forgotten_source','此话题已被遗忘，不自动重建',409);
  if(old&&args.expectedVersion===undefined)fail('version_required','追加前请读取话题版本',409);
  const previousRefs=old?await currentMemoryRefs(tx,old):[];
  const sources=await validateRefs(tx,channel.id,args.refs||[]);
  if(!sources.length)fail('source_required','话题经历需要真实来源');
  if(!await sourcesAvailable(tx,actor,{scopeId:channel.id,refs:sources}))fail('source_changed','来源已变化，请读取当前版本',409);
  const tombstones=await memoryRows(tx,'memory_tombstone',{scope:channel.id});
  if(tombstones.some(t=>sources.some(r=>t.sourceKeys?.includes(r.kind+':'+r.id+':'+r.version))))fail('forgotten_source','这段来源已被要求遗忘',409);
  const phase=args.phase||'evidence';
  if(!['goal','change','evidence','decision','result','question','dissent','correction'].includes(phase))fail('invalid_phase','经历类型无效');
  const body=required(args.body,'关键经历',12000),conflict=!!old&&old.version!==args.expectedVersion;
  const corrected=[];
  if(args.supersededEpisodeIds?.length){
   if(phase!=='correction'||!old||conflict)fail('version_conflict','纠正经历前请读取当前话题版本',409);
   for(const key of [...new Set(args.supersededEpisodeIds)]){const e=await tx.get('memory_episode',key);if(e.parentId!==old.id||e.scopeId!==channel.id||e.supersededBy)fail('invalid_correction','只能纠正本话题尚未被替代的经历');corrected.push(e);}
  }
  const unresolved=new Set(old?.unresolvedEpisodeIds||[]);
  for(const key of args.resolvedEpisodeIds||[]){const e=await tx.get('memory_episode',key);if(e.parentId!==old?.id||!unresolved.has(key))fail('invalid_resolution','只能核对本话题的未决经历');if(conflict)fail('version_conflict','请读取最新经历后处理分歧',409);unresolved.delete(key);}
  const topicId=old?.id||key||id('topic');
  let entry=tx.put('memory_episode',{id:topicId+':'+String((old?.episodeCount||0)+1).padStart(9,'0'),scopeId:channel.id,parentId:topicId,phase,body,refs:sources,authorId,createdAt:tx.now,baseVersion:args.expectedVersion||0,needsReconcile:conflict});
  for(const e of corrected){tx.put('memory_episode',{...e,supersededBy:entry.id,correctedAt:tx.now});unresolved.delete(e.id);}
  if(corrected.length)entry=tx.put('memory_episode',{...entry,supersedes:corrected.map(e=>e.id)});
  if(conflict||['dissent','question'].includes(phase))unresolved.add(entry.id);
  const next={...old,id:topicId,scopeId:channel.id,parentId:channel.id,memoryType:'topic',category:'experience',authority:'observation',memoryScope:'channel',status:old?.status||'approved',title:old&&conflict?old.title:required(args.title||old?.title,'话题标题',160),body:conflict?old.body:required(args.summary||old?.body||body,'当前理解',12000),refs:conflict?previousRefs:mergeMemoryRefs(previousRefs,sources),sourceIndexVersion:1,sourceUnavailable:false,version:(old?.version||0)+1,authorId:old?.authorId||authorId,lastEditorId:authorId,createdAt:old?.createdAt||tx.now,updatedAt:tx.now,evidence:'成员维护的话题经历，实际完成状态以原任务和回执为准',needsReconcile:unresolved.size>0,unresolvedEpisodeIds:[...unresolved],latestEpisodeId:entry.id,episodeCount:(old?.episodeCount||0)+1};
  tx.put('channel_memory',next);tx.put('channel_memory_version',{...next,id:topicId+':'+next.version,parentId:topicId,reason:phase});queueMemoryIndex(tx,next);
  for(const eventId of args.eventIds||[]){const event=await tx.get('memory_event',eventId);if(event.scopeId!==channel.id||!sources.some(r=>r.id===event.sourceId&&r.kind===event.sourceKind&&r.version===event.sourceVersion))fail('uncovered_event','整理覆盖必须逐条对应本次来源',409);tx.put('memory_event',{...event,status:'reviewed',reviewedBy:authorId,topicId,episodeId:entry.id,summary:body.slice(0,1000)});}
  return {topic:next,episode:entry,conflict,...(conflict?{instruction:'并发补充已保留，未覆盖较新总结；请读取全部新经历再更新当前理解。'}:{})};
 });
}

export async function groupMemoryMaintenance(repo,identity,helpers,now){
 // One coalesced maintenance turn only when normal work is idle. A failed review
 // is not a reason to repeatedly wake a model or fabricate a covered cursor.
 const rows=await repo.db.prepare("SELECT scope_id FROM hub_v2_records WHERE workspace_id=? AND kind='memory_event' AND status='pending' GROUP BY scope_id LIMIT 100").bind(repo.workspaceId).all();
 for(const row of rows.results){
  const c=await repo.get('channel',row.scope_id,false);if(!c?.coordinatorId||c.status!=='active'||!c.memoryAutomatic)continue;
  const blocked=async r=>{for(const status of ['ready','active','stalled','limited','unavailable'])if((await r.list('channel_turn',{scope:c.id,status,limit:1,page:true})).length)return true;return false;};
  if(await blocked(repo))continue;
  const meetings=await memoryRows(repo,'channel_meeting',{scope:c.id});
  if(meetings.some(m=>['preparing','running','closing'].includes(m.status)))continue;
  const stopAt=meetings.filter(m=>['stopped','筹备取消'].includes(m.endReason)).map(m=>m.endedAt).sort().at(-1);
  if(stopAt){const latest=(await repo.list('channel_message',{scope:c.id,order:'recent',limit:100})).find(m=>m.authorId==='owner'&&!m.hidden);if(!latest||latest.createdAt<=stopAt)continue;}
  const pending=await repo.list('memory_event',{scope:c.id,status:'pending',limit:50});
  if(!pending.length||pending.some(e=>Date.parse(now)-Date.parse(e.createdAt)<30000))continue;
  const signature=await digest(pending.map(e=>e.id).sort().join('|')),prior=await repo.get('memory_maintenance',c.id,false);
  if(prior?.signature===signature)continue;
  await repo.transact('memory-maintenance:'+c.id+':'+now,{},async tx=>{
   const channel=await tx.get('channel',c.id),events=await tx.list('memory_event',{scope:c.id,status:'pending',limit:50,page:true});
   if(!events.length||events.some(e=>Date.parse(now)-Date.parse(e.createdAt)<30000))return {};
   if(await blocked(tx))return {};
   const connection=await tx.get('connection',channel.coordinatorId,false),member=identity.members.find(m=>m.id===channel.coordinatorId);
   if(!member||member.paused||member.status==='disabled'||connection?.status!=='verified')return {};
   const signature=await digest(events.map(e=>e.id).sort().join('|')),previous=await tx.get('memory_maintenance',c.id,false);
   if(previous?.signature===signature)return {};
   const message=await helpers.channelMessage(tx,channel,{memberId:'system'},'整理本群尚未记录的关键经历。先用 group_memory list 读覆盖信息，按来源读取未整理事件；同话题复用原 topicId，重要变化与分歧用 record，长期知识用 remember；无长期价值的用 review_memory_events 标明。不要新建任务或唤醒其他成员，不改任何原生项目；完成后 stay_silent，不向用户发送整理报告。',{hidden:true,type:'memory_review',memoryMaintenance:true,mentions:[channel.coordinatorId],hops:0});
   await helpers.enqueue(tx,identity,channel,message,channel.coordinatorId);
   tx.put('memory_maintenance',{id:c.id,scopeId:c.id,signature,messageId:message.id,createdAt:now});return {};
  },now);
 }
}
