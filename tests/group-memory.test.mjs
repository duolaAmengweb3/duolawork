import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand,meetingHelpers,readChannel,conversationWork} from '../cloud/collaboration/conversation.mjs';
import {groupMemoryTool,readGroupMemory,groupMemoryMaintenance,memoryEvents} from '../cloud/collaboration/group-memory.mjs';
import {memoryTool,recallMemory} from '../cloud/collaboration/memory-context.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';

async function setup(t){const f=await fixture(t);let i=0;const send=(type,args,actor={owner:true})=>conversationCommand(f.repo,f.identity,actor,{requestId:'gm-'+(++i),type,...args});const channel=await send('channel.create',{name:'跨场景经历',memberIds:['grok','check'],coordinatorId:'grok'});const actor={memberId:'grok'};return {...f,send,channel,actor,write:args=>groupMemoryTool(f.repo,actor,{channelId:channel.id,requestId:'record-'+(++i),action:'record',...args})};}
test('interleaved topics retain identity and owner changes without page interaction or human approval',async t=>{
 const f=await setup(t),channelId=f.channel.id;
 const a=await f.send('channel.post',{channelId,body:'活动只安排周六，预算1000。'}),b=await f.send('channel.post',{channelId,body:'网站先保持中文，英文版本另排。'});
 const x=await f.write({topicKey:'event',title:'周末活动',body:a.body,phase:'goal',refs:[{kind:'message',id:a.id}]});
 const y=await f.write({topicKey:'site',title:'网站语言',body:b.body,phase:'goal',refs:[{kind:'message',id:b.id}]});
 const change=await f.send('channel.post',{channelId,body:'活动预算改成800，周六不变；网站先不动。'});
 const updated=await f.write({topicId:x.topic.id,expectedVersion:1,summary:'周六活动预算800；网站不受影响',body:change.body,phase:'change',refs:[{kind:'message',id:change.id}]});
 assert.equal(updated.topic.id,x.topic.id);assert.equal(updated.topic.status,'approved');assert.equal(updated.topic.authority,'observation');
 const read=await readGroupMemory(f.repo,{memberId:'check'},{channelId,topicId:x.topic.id});assert.equal(read.episodes.length,2);assert.equal(read.episodes[0].body,a.body);assert.match(read.body,/800/);
 assert.equal((await readGroupMemory(f.repo,f.actor,{channelId,topicId:y.topic.id})).version,1);
 const recall=await recallMemory(f.repo,{memberId:'check'},{channelId,query:'周六活动预算'},null);assert.ok(recall.items.some(m=>m.id===x.topic.id));assert.ok(!recall.mandatoryIds.includes(x.topic.id),'an agent summary is not an owner instruction');
});
test('concurrent dissent is appended and cannot silently replace a newer understanding',async t=>{
 const f=await setup(t),channelId=f.channel.id,m=await f.send('channel.post',{channelId,body:'需要比较两个方案，尚未定案。'});
 const first=await f.write({title:'方案比较',body:m.body,refs:[{kind:'message',id:m.id}]});
 await f.write({topicId:first.topic.id,expectedVersion:1,summary:'A仍有风险，尚未定案',body:'A有风险',phase:'question',refs:[{kind:'message',id:m.id}]});
 const conflict=await f.write({topicId:first.topic.id,expectedVersion:1,summary:'所有人同意B',body:'反对直接采用B',phase:'dissent',refs:[{kind:'message',id:m.id}]});
 assert.equal(conflict.conflict,true);assert.equal(conflict.topic.body,'A仍有风险，尚未定案');assert.equal(conflict.episode.body,'反对直接采用B');assert.equal(conflict.topic.needsReconcile,true);
 const d=await readGroupMemory(f.repo,f.actor,{channelId,topicId:first.topic.id});assert.equal(d.episodes.length,3);
});
test('coverage counts exact sources, preserves holes, rejects fake coverage and tracks edited originals',async t=>{
 const f=await setup(t),channelId=f.channel.id;
 const a=await f.send('channel.post',{channelId,body:'原要求'}),b=await f.send('channel.post',{channelId,body:'补充要求'});
 const events=await memoryEvents(f.repo,channelId),ea=events.events.find(e=>e.sourceId===a.id),eb=events.events.find(e=>e.sourceId===b.id);
 await assert.rejects(f.write({title:'总结',body:'无法覆盖第二条',refs:[{kind:'message',id:a.id}],eventIds:[eb.id]}),e=>e.code==='uncovered_event');
 await f.write({title:'总结',body:b.body,refs:[{kind:'message',id:b.id}],eventIds:[eb.id]});
 const pending=await memoryEvents(f.repo,channelId);assert.equal(pending.pending,1);assert.equal(pending.events[0].id,ea.id);
 await f.send('channel.message.edit',{channelId,messageId:a.id,expectedVersion:1,body:'更改原要求'});
 const next=await memoryEvents(f.repo,channelId);assert.ok(next.events.some(e=>e.sourceId===a.id&&e.sourceVersion===2));assert.equal(next.events.find(e=>e.id===ea.id).sourceAvailable,false);
});
test('source changes retire derived memory in recall, direct reads and channel context; forgetting cannot revive episodes',async t=>{
 const f=await setup(t),channelId=f.channel.id;
 const source=await f.send('channel.post',{channelId,body:'旧要求'}, {owner:true});
 const first=await f.write({topicKey:'forgettable',title:'旧要求',body:source.body,refs:[{kind:'message',id:source.id}]});
 await f.send('channel.message.edit',{channelId,messageId:source.id,expectedVersion:1,body:'新要求'});
 assert.equal((await recallMemory(f.repo,f.actor,{channelId,query:'旧要求'},null)).items.length,0);
 assert.equal((await readChannel(f.repo,f.identity,f.actor,{channelId})).knowledge.length,0);
 const detail=await readGroupMemory(f.repo,f.actor,{channelId,topicId:first.topic.id});assert.equal(detail.sourceUnavailable,true);assert.ok(detail.episodes.every(e=>e.sourceUnavailable));
 await memoryTool(f.repo,{owner:true},'forget_memory',{requestId:'forget-topic',channelId,memoryId:first.topic.id,expectedVersion:1});
 assert.ok((await f.repo.list('memory_episode',{parent:first.topic.id})).every(e=>!e.body&&!e.refs));
 await assert.rejects(f.write({topicKey:'forgettable',title:'重建',body:'不可复活',refs:[{kind:'message',id:source.id,version:2}]}),e=>e.code==='forgotten_source');
});
test('cross-channel source and private membership boundaries apply to topics and compatibility calls',async t=>{
 const f=await setup(t),channelId=f.channel.id;
 const other=await f.send('channel.create',{name:'其他群',memberIds:['check']});const m=await f.send('channel.post',{channelId:other.id,body:'不可跨群'});
 await assert.rejects(f.write({title:'越界',body:'不可跨群',refs:[{kind:'message',id:m.id}]}),e=>e.code==='forbidden');
 await assert.rejects(readGroupMemory(f.repo,{memberId:'write'},{channelId}),e=>e.code==='forbidden');
 const source=await f.send('channel.post',{channelId,body:'可用于旧工具目录'});
 const result=await callTool(f.repo,f.identity,f.actor,'post_message',{requestId:'cached-group-memory',channelId,body:'HUB_SHARED_TOOL_V1\n'+JSON.stringify({name:'group_memory',arguments:{channelId,action:'record',title:'兼容写入',body:source.body,refs:[{kind:'message',id:source.id}]}})},{});
 assert.equal(result.topic.status,'approved');assert.equal((await f.repo.list('channel_message',{scope:channelId})).length,1,'tool envelope is not a chat message');
});
test('automatic maintenance waits for normal work, coalesces once and keeps incomplete coverage pending',async t=>{
 const f=await setup(t),channelId=f.channel.id,source=await f.send('channel.post',{channelId,body:'讨论的新要求'});
 const now=new Date(Date.now()+60000).toISOString();
 await groupMemoryMaintenance(f.repo,f.identity,meetingHelpers,now);
 assert.equal((await f.repo.list('memory_maintenance')).length,0,'does not compete with active/ready normal work');
 await f.repo.transact('done-original',{},async tx=>{for(const turn of await tx.list('channel_turn',{scope:channelId}))tx.put('channel_turn',{...turn,status:'done'});});
 await groupMemoryMaintenance(f.repo,f.identity,meetingHelpers,now);
 const records=await f.repo.list('memory_maintenance');assert.equal(records.length,1);
 await f.repo.transact('done-review-no-coverage',{},async tx=>{for(const turn of await tx.list('channel_turn',{scope:channelId}))tx.put('channel_turn',{...turn,status:'done'});});
 await groupMemoryMaintenance(f.repo,f.identity,meetingHelpers,new Date(Date.now()+120000).toISOString());
 assert.equal((await f.repo.list('channel_message',{scope:channelId})).filter(m=>m.memoryMaintenance).length,1,'a failed review cannot cause endless paid wakeups');
 assert.equal((await memoryEvents(f.repo,channelId)).pending,1,'a response does not invent coverage');assert.equal((await memoryEvents(f.repo,channelId)).events[0].sourceId,source.id);
});
test('a new result does not erase unresolved dissent; explicit versioned reconciliation is required',async t=>{
 const f=await setup(t),channelId=f.channel.id,m=await f.send('channel.post',{channelId,body:'A存在风险，需独立核对。'});
 const x=await f.write({title:'争议',phase:'dissent',body:m.body,refs:[{kind:'message',id:m.id}]});
 const y=await f.write({topicId:x.topic.id,expectedVersion:1,phase:'result',body:'有了新的材料',refs:[{kind:'message',id:m.id}]});assert.equal(y.topic.needsReconcile,true);
 const z=await f.write({topicId:x.topic.id,expectedVersion:2,phase:'correction',body:'核对来源后，风险仍存在，当前决定暂缓A',resolvedEpisodeIds:[x.episode.id],refs:[{kind:'message',id:m.id}]});assert.equal(z.topic.needsReconcile,false);assert.equal((await readGroupMemory(f.repo,f.actor,{channelId,topicId:x.topic.id})).episodes[0].body,m.body);
});
test('split and merge preserve stable aliases and source history without overwriting new episodes',async t=>{
 const f=await setup(t),channelId=f.channel.id,m=await f.send('channel.post',{channelId,body:'同时比较活动预算和网站方案'});
 const x=await f.write({title:'比较',body:m.body,refs:[{kind:'message',id:m.id}]});
 const y=await groupMemoryTool(f.repo,f.actor,{requestId:'split-good',channelId,action:'split',topicId:x.topic.id,expectedVersion:1,title:'网站',summary:'独立比较网站方案',episodeIds:[x.episode.id],refs:[{kind:'message',id:m.id}]});
 const z=await f.write({topicId:y.topic.id,expectedVersion:1,body:'追加网站证据',refs:[{kind:'message',id:m.id}]});assert.equal((await readGroupMemory(f.repo,f.actor,{channelId,topicId:z.topic.id})).episodes.length,2);
 await groupMemoryTool(f.repo,f.actor,{requestId:'merge-good',channelId,action:'merge',topicId:x.topic.id,expectedVersion:2,relatedTopicIds:[z.topic.id]});assert.equal((await readGroupMemory(f.repo,f.actor,{channelId,topicId:z.topic.id})).mergedInto,x.topic.id);
});
test('forgetting more than 500 episodes removes all bodies, revisions and cached source keys',async t=>{
 const f=await setup(t),channelId=f.channel.id,m=await f.send('channel.post',{channelId,body:'大量经历对应同一来源'});const x=await f.write({title:'长话题',body:m.body,refs:[{kind:'message',id:m.id}]});
 for(let batch=0;batch<3;batch++)await f.repo.transact('episode-batch-'+batch,{},async tx=>{for(let i=0;i<200;i++){const index=batch*200+i+2;tx.put('memory_episode',{id:x.topic.id+':'+String(index).padStart(9,'0'),scopeId:channelId,parentId:x.topic.id,body:'应全部清除',refs:x.topic.refs});}});
 await memoryTool(f.repo,{owner:true},'forget_memory',{requestId:'forget-long-topic',channelId,memoryId:x.topic.id,expectedVersion:1});
 const rows=await f.repo.db.prepare("SELECT COUNT(*) AS n FROM hub_v2_records WHERE workspace_id=? AND kind='memory_episode' AND parent_id=? AND json_extract(body,'$.body') IS NOT NULL").bind(f.repo.workspaceId,x.topic.id).first();assert.equal(rows.n,0);
});
test('topic search covers later pages without exposing invalidated source text',async t=>{
 const f=await setup(t),channelId=f.channel.id,m=await f.send('channel.post',{channelId,body:'目录来源'});
 await f.repo.transact('seed-topic-pages',{},tx=>{for(let i=0;i<105;i++)tx.put('channel_memory',{id:'topic-search-'+String(i).padStart(3,'0'),scopeId:channelId,status:'approved',memoryType:'topic',title:i===104?'晚页特殊目标':'普通条目',body:'目录内容',version:1,refs:[{kind:'message',id:m.id,version:1}]});});
 const result=await readGroupMemory(f.repo,f.actor,{channelId,query:'特殊目标'});assert.equal(result.items.length,1);assert.equal(result.items[0].id,'topic-search-104');assert.equal(result.next,null);
 await f.send('channel.message.edit',{channelId,messageId:m.id,expectedVersion:1,body:'来源变了'});
 assert.equal((await readGroupMemory(f.repo,f.actor,{channelId,query:'特殊目标'})).items.length,0);
});
test('direct group-memory readers receive a withdrawal without leaking the forgotten content',async t=>{
 const f=await setup(t),channelId=f.channel.id,m=await f.send('channel.post',{channelId,body:'验收用过期价格1234'});
 const x=await f.write({title:'价格约定',body:m.body,refs:[{kind:'message',id:m.id}]});
 await groupMemoryTool(f.repo,{memberId:'check'},{channelId,action:'read',topicId:x.topic.id});
 await memoryTool(f.repo,{owner:true},'forget_memory',{requestId:'forget-read-topic',channelId,memoryId:x.topic.id,expectedVersion:1},f.identity);
 const notice=(await f.repo.list('channel_message',{scope:channelId})).find(m=>m.forgottenMemoryId===x.topic.id);
 assert.ok(notice);assert.ok(notice.mentions.includes('check'));assert.ok(!notice.body.includes('1234'));
 const withdrawal=(await f.repo.list('channel_turn',{scope:channelId,parent:'check'})).find(t=>t.messageId===notice.id);assert.ok(withdrawal);
});
test('correcting an overinterpreted episode marks it historical and preserves unresolved questions',async t=>{
 const f=await setup(t),channelId=f.channel.id,m=await f.send('channel.post',{channelId,body:'这和supervisor类似吗，已经实现了吗？'});
 const first=await f.write({title:'架构问题',phase:'goal',body:'必须采用supervisor',refs:[{kind:'message',id:m.id}]});
 const corrected=await f.write({topicId:first.topic.id,expectedVersion:1,phase:'correction',body:'之前误把提问当决定，用户只是在询问比较和实现状态',summary:'用户询问架构比较与实现状态，尚未形成架构决定',supersededEpisodeIds:[first.episode.id],refs:[{kind:'message',id:m.id}]});
 const question=await f.write({topicId:first.topic.id,expectedVersion:2,phase:'question',body:'实现状态需要实际证据回答',refs:[{kind:'message',id:m.id}]});
 const d=await readGroupMemory(f.repo,f.actor,{channelId,topicId:first.topic.id});assert.equal(d.episodes[0].supersededBy,corrected.episode.id);assert.equal(d.episodes[0].body,'必须采用supervisor');assert.ok(d.episodes[1].supersedes.includes(first.episode.id));assert.equal(d.needsReconcile,true);assert.deepEqual(d.unresolvedEpisodeIds,[question.episode.id]);assert.match(d.body,/尚未形成架构决定/);
 await assert.rejects(f.write({topicId:first.topic.id,expectedVersion:1,phase:'correction',body:'stale overwrite',supersededEpisodeIds:[question.episode.id],refs:[{kind:'message',id:m.id}]}),e=>e.code==='version_conflict');
});
for(const legacy of [false,true])test(`later episodes preserve earlier source dependencies across recall and edits (legacy=${legacy})`,async t=>{
 const f=await setup(t),channelId=f.channel.id;
 const a=await f.send('channel.post',{channelId,body:'预算800，周六活动'}),b=await f.send('channel.post',{channelId,body:'场地仍未确定'});
 const first=await f.write({title:'预算与场地',body:a.body,refs:[{kind:'message',id:a.id}]});
 const next=await f.write({topicId:first.topic.id,expectedVersion:1,phase:'question',summary:'预算800，场地待定',body:b.body,refs:[{kind:'message',id:b.id}]});
 if(legacy)await f.repo.transact('simulate-last-refs-only',{},tx=>{const row={...next.topic,refs:next.episode.refs};delete row.sourceIndexVersion;tx.put('channel_memory',row);});
 const detail=await readGroupMemory(f.repo,f.actor,{channelId,topicId:first.topic.id});assert.deepEqual(new Set(detail.refs.map(r=>r.id)),new Set([a.id,b.id]));
 await f.send('channel.message.edit',{channelId,messageId:a.id,expectedVersion:1,body:'预算600，周六活动'});
 assert.equal((await readGroupMemory(f.repo,f.actor,{channelId,topicId:first.topic.id})).sourceUnavailable,true);
 assert.equal((await recallMemory(f.repo,f.actor,{channelId,query:'预算'},null)).items.length,0);
 assert.equal((await readChannel(f.repo,f.identity,f.actor,{channelId})).knowledge.length,0);
 const fixed=await f.write({topicId:first.topic.id,expectedVersion:2,phase:'correction',summary:'预算600，场地仍未定',body:'读取新原话后修正预算；保留场地问题',refs:[{kind:'message',id:a.id,version:2}]});
 assert.equal(fixed.topic.refs.find(r=>r.id===a.id).version,2);assert.ok(fixed.topic.refs.some(r=>r.id===b.id));assert.ok(fixed.topic.unresolvedEpisodeIds.includes(next.episode.id));
 const current=await readGroupMemory(f.repo,f.actor,{channelId,topicId:first.topic.id});assert.equal(current.sourceUnavailable,false);assert.match(current.body,/600/);assert.ok((await recallMemory(f.repo,f.actor,{channelId,query:'预算'},null)).items.some(m=>m.id===first.topic.id));
});

async function maintenanceFixture(t){
 const f=await setup(t),channelId=f.channel.id,source=await f.send('channel.post',{channelId,body:'一个需要整理的实际决定'});
 const claim=await f.send('channel.claim',{channelId,stepId:'turn_'+source.id+'_grok'},f.actor);
 await f.send('channel.silent',{channelId,turnId:claim.turnId,reason:'fixture original processed'},f.actor);
 await groupMemoryMaintenance(f.repo,f.identity,meetingHelpers,new Date(Date.now()+60000).toISOString());
 const message=(await f.repo.list('channel_message',{scope:channelId})).find(m=>m.memoryMaintenance);
 return {...f,channelId,source,message,stepId:'turn_'+message.id+'_grok'};
}
test('background memory freezes its event batch and yields on tool boundaries without consuming foreground work',async t=>{
 const f=await maintenanceFixture(t),claim=await f.send('channel.claim',{channelId:f.channelId,stepId:f.stepId},f.actor);
 assert.deepEqual(claim.input.backgroundWork.eventIds,f.message.maintenanceEventIds);
 const later=await f.send('channel.post',{channelId:f.channelId,replyTo:f.source.id,mentions:['owner'],body:'之后到达的普通成员信息'}, {memberId:'check'});
 const laterEvent=(await memoryEvents(f.repo,f.channelId)).events.find(e=>e.sourceId===later.id);
 const batch=await groupMemoryTool(f.repo,f.actor,{channelId:f.channelId,action:'list'});
 assert.ok(!batch.coverage.events.some(e=>e.id===laterEvent.id),'new sources cannot extend the running background batch');
 const outside=await memoryTool(f.repo,f.actor,'review_memory_events',{requestId:'outside-snapshot',channelId:f.channelId,eventIds:[laterEvent.id],summary:'不得冒充本次覆盖'});
 assert.equal(outside.deferred,true);assert.equal((await f.repo.get('memory_event',laterEvent.id)).status,'pending');
 const owner=await f.send('channel.post',{channelId:f.channelId,body:'我现在需要你回答，后台先让开'});
 const before=await f.repo.get('channel_turn',claim.turnId);
 const yieldRead=await groupMemoryTool(f.repo,f.actor,{channelId:f.channelId,action:'list'});assert.equal(yieldRead.backgroundWork.yieldToForeground,true);
 const review=await memoryTool(f.repo,f.actor,'review_memory_events',{requestId:'yield-snapshot',channelId:f.channelId,eventIds:f.message.maintenanceEventIds,summary:'不要覆盖'});assert.equal(review.deferred,true);
 assert.deepEqual(await f.repo.get('channel_turn',claim.turnId),before,'no forced native cancellation or early lease release');
 assert.ok((await memoryEvents(f.repo,f.channelId)).events.some(e=>e.sourceId===f.source.id));
 await f.send('channel.silent',{channelId:f.channelId,turnId:claim.turnId,reason:'让出前台'},f.actor);
 assert.equal((await f.repo.get('memory_maintenance',f.channelId)).status,'deferred');
 const next=await f.send('channel.claim',{channelId:f.channelId,stepId:'turn_'+owner.id+'_grok'},f.actor);
 assert.deepEqual(next.input.triggerMessageIds,[owner.id]);assert.equal(next.input.backgroundWork,undefined);
 await memoryTool(f.repo,f.actor,'review_memory_events',{requestId:'foreground-normal-memory',channelId:f.channelId,eventIds:[laterEvent.id],summary:'前台照常处理记忆'});
 assert.equal((await f.repo.get('memory_event',laterEvent.id)).status,'reviewed','foreground tools keep their existing abilities');
});
test('foreground wins over an unclaimed background batch, and the batch is not merged or falsely completed',async t=>{
 const f=await maintenanceFixture(t),owner=await f.send('channel.post',{channelId:f.channelId,body:'前台新需求'});
 const ready=await conversationWork(f.repo,f.identity,'grok');assert.equal(ready.find(w=>w.status==='ready').messageId,owner.id);
 const deferred=await f.send('channel.claim',{channelId:f.channelId,stepId:f.stepId},f.actor);assert.equal(deferred.claimed,false);assert.equal(deferred.status,'obsolete');
 assert.equal((await f.repo.get('channel_turn',f.stepId)).resolution,'background_deferred');assert.equal((await f.repo.get('memory_maintenance',f.channelId)).status,'deferred');
 const foreground=await f.send('channel.claim',{channelId:f.channelId,stepId:'turn_'+owner.id+'_grok'},f.actor);
 assert.deepEqual(foreground.input.triggerMessageIds,[owner.id]);assert.ok((await memoryEvents(f.repo,f.channelId)).events.some(e=>e.sourceId===f.source.id));
 await f.send('channel.silent',{channelId:f.channelId,turnId:foreground.turnId,reason:'本次前台已处理'},f.actor);
 await groupMemoryMaintenance(f.repo,f.identity,meetingHelpers,new Date(Date.now()+120000).toISOString());
 assert.equal((await f.repo.list('channel_message',{scope:f.channelId})).filter(m=>m.memoryMaintenance).length,2,'deferred batch can resume once idle');
});
test('background scheduling respects shared native execution across groups without blocking independent sessions',async t=>{
 const f=await setup(t),a=f.channel.id,source=await f.send('channel.post',{channelId:a,body:'待整理的决定'});
 await f.repo.transact('settle-first',{},async tx=>{for(const turn of await tx.list('channel_turn',{scope:a}))tx.put('channel_turn',{...turn,status:'done'});});
 const other=await f.send('channel.create',{name:'同一原会话另一个群',memberIds:['grok'],coordinatorId:'grok'});
 await f.send('channel.post',{channelId:other.id,body:'另一个群的前台工作'});
 const now=new Date(Date.now()+60000).toISOString();await groupMemoryMaintenance(f.repo,f.identity,meetingHelpers,now);
 assert.equal((await f.repo.list('memory_maintenance')).length,0,'shared execution stays with foreground work');
 await f.repo.transact('separate-sessions',{},async tx=>{for(const [scopeId,sessionKey]of[[a,'separate-a'],[other.id,'separate-b']])tx.put('execution_binding',{id:'grok:'+scopeId,parentId:'grok',scopeId,sessionKey,status:'active'});});
 await groupMemoryMaintenance(f.repo,f.identity,meetingHelpers,now);
 assert.ok((await f.repo.list('memory_maintenance')).some(m=>m.id===a),'another session need not block this independent background work');
});

test('legacy queued maintenance also yields to foreground in receiveNext without merging the hidden instruction',async t=>{
 const f=await maintenanceFixture(t);
 await f.repo.transact('legacy-maintenance-fields',{},async tx=>{const turn=await tx.get('channel_turn',f.stepId);delete turn.background;tx.put('channel_turn',turn);const source=await tx.get('channel_message',f.message.id);delete source.maintenanceEventIds;tx.put('channel_message',source);});
 const owner=await f.send('channel.post',{channelId:f.channelId,body:'正常前台先处理'});
 const claim=await f.send('channel.claim',{channelId:f.channelId,receiveNext:true},f.actor);
 assert.deepEqual(claim.input.triggerMessageIds,[owner.id]);assert.equal(claim.input.backgroundWork,undefined);
 assert.equal((await f.repo.get('channel_turn',f.stepId)).status,'ready','legacy background remains pending, never pretends it was processed');
});
