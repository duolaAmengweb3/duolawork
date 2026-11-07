import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand,meetingHelpers,readChannel} from '../cloud/collaboration/conversation.mjs';
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
