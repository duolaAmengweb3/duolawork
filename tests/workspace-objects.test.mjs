import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand,conversationTool,readChannel,claimConversation} from '../cloud/collaboration/conversation.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';
import {withConversationContext} from '../cloud/collaboration/inbox.mjs';
const owner={owner:true},agent={memberId:'grok'};
async function setup(t){const f=await fixture(t);let n=0;const send=(type,args={},actor=owner)=>conversationCommand(f.repo,f.identity,actor,{type,requestId:'space-'+(++n),...args});const c=await send('channel.create',{name:'协作',memberIds:['grok','check'],coordinatorId:'grok'});return {...f,c,send};}
test('Todo assignment delivers once, assignee accepts and reports blockers and results with meeting provenance',async t=>{
 const f=await setup(t),channelId=f.c.id;
 const source=await f.send('channel.post',{channelId,body:'请跟进测试结果'});
 const meeting=await f.send('channel.meeting',{channelId,action:'prepare',body:'讨论发布'});
 const task=await f.send('channel.task',{channelId,action:'create',title:'修复同步',assigneeId:'check',sourceMessageId:source.id,meetingIds:[meeting.id]});
 assert.equal(task.acceptedAt,null);
 const turns=await f.repo.list('channel_turn'),target=turns.find(t=>t.messageId===task.notificationMessageId);
 assert.equal(target.memberId,'check');
 await claimConversation(f.repo,f.identity,{memberId:'check'},{requestId:'todo-claim',stepId:target.id});
 let current=await f.send('channel.task',{channelId,taskId:task.id,action:'accept',expectedVersion:1},{memberId:'check'});
 assert.equal(current.acceptedBy,'check');assert.equal(current.status,'doing');
 await assert.rejects(f.send('channel.task',{channelId,taskId:task.id,action:'update',expectedVersion:1,status:'done'}),e=>e.code==='version_conflict');
 await assert.rejects(f.send('channel.task',{channelId,taskId:task.id,action:'update',status:'blocked'}),e=>e.code==='blocker_required');
 current=await f.send('channel.task',{channelId,taskId:task.id,action:'update',status:'blocked',blocker:'缺少验收文件'},{memberId:'check'});
 current=await f.send('channel.task',{channelId,taskId:task.id,action:'update',status:'done',result:'修复已提交，回归通过'},{memberId:'check'});
 const read=await conversationTool(f.repo,f.identity,owner,'read_todo',{channelId,taskId:task.id});
 assert.equal(read.versions.length,4);assert.equal(read.completedBy,'check');assert.deepEqual(read.meetingIds,[meeting.id]);assert.equal(read.sourceMessageId,source.id);
 assert.equal((await f.repo.list('channel_turn')).filter(t=>t.messageId===task.notificationMessageId).length,1);
});
test('shared memory revisions and deactivation affect next native context, retain owner history and reject stale/cross-channel edits',async t=>{
 const f=await setup(t),channelId=f.c.id;
 let m=await f.send('channel.remember',{channelId,title:'交付要求',body:'使用中文回复',category:'requirement'});
 assert.equal(m.status,'approved');
 const msg=await f.send('channel.post',{channelId,body:'确认要求'}),turn=(await f.repo.list('channel_turn')).find(t=>t.messageId===msg.id);
 const claim=await claimConversation(f.repo,f.identity,agent,{requestId:'ctx-claim',stepId:turn.id});
 let context=await withConversationContext(f.repo,f.identity,agent,claim);assert.equal(context.input.knowledge[0].body,'使用中文回复');
 m=await f.send('channel.memory.update',{channelId,memoryId:m.id,expectedVersion:1,body:'使用中英文对照回复'});
 context=await withConversationContext(f.repo,f.identity,agent,claim);assert.equal(context.input.knowledge[0].version,2);assert.equal(context.input.knowledge[0].body,'使用中英文对照回复');
 const old=await conversationTool(f.repo,f.identity,owner,'read_memory',{channelId,memoryId:m.id});assert.equal(old.versions.length,2);
 await assert.rejects(f.send('channel.memory.update',{channelId,memoryId:m.id,expectedVersion:1,body:'旧更新'}),e=>e.code==='version_conflict');
 await f.send('channel.memory.update',{channelId,memoryId:m.id,expectedVersion:2,status:'inactive'});
 context=await withConversationContext(f.repo,f.identity,agent,claim);assert.equal(context.input.knowledge.length,0);
 const other=await f.send('channel.create',{name:'其他群',memberIds:['grok']});
 await assert.rejects(conversationTool(f.repo,f.identity,agent,'read_memory',{channelId:other.id,memoryId:m.id}),e=>e.code==='forbidden');
});
test('Agent proposed memory stays pending and cannot promote itself; source is checked',async t=>{
 const f=await setup(t),channelId=f.c.id;
 const message=await f.send('channel.post',{channelId,body:'一个待核实的结论'});
 const m=await f.send('channel.remember',{channelId,title:'待核实经验',body:'仅用于测试',refs:[{kind:'message',id:message.id}]},agent);
 assert.equal(m.status,'pending');assert.equal((await readChannel(f.repo,f.identity,agent,{channelId})).knowledge.length,0);
 await assert.rejects(f.send('channel.memory.update',{channelId,memoryId:m.id,status:'approved'},agent),e=>e.code==='forbidden');
 await f.send('channel.memory.review',{channelId,memoryId:m.id,status:'approved',expectedVersion:1});
 const search=await conversationTool(f.repo,f.identity,agent,'search_memory',{channelId,query:'测试'});assert.equal(search.items.length,1);assert.equal(search.items[0].refs[0].id,message.id);
});
test('versioned references keep old document content and reject cross-channel data or unsupported URLs',async t=>{
 const f=await setup(t),channelId=f.c.id;
 const d=await f.send('channel.doc.create',{channelId,title:'资料',body:'第一版'});
 const m=await f.send('channel.post',{channelId,body:'阅读这个版本',refs:[{kind:'document',id:d.id,version:1}]});
 await f.send('channel.doc.edit',{channelId,documentId:d.id,expectedVersion:1,body:'第二版',reason:'修订'});
 const ref=m.refs[0],read=await conversationTool(f.repo,f.identity,agent,'read_space_object',{channelId,...ref});
 assert.equal(read.body,'第一版');assert.equal(read.currentVersion,2);
 const other=await f.send('channel.create',{name:'私聊',memberIds:['check']});
 await assert.rejects(f.send('channel.post',{channelId:other.id,body:'跨群引用',refs:[{kind:'document',id:d.id}]}),e=>e.code==='forbidden');
 await assert.rejects(f.send('channel.link',{channelId,title:'坏链接',url:'javascript:alert(1)'}),e=>e.code==='invalid_url');
 const link=await f.send('channel.link',{channelId,title:'仓库',url:'https://github.com/duolaAmengweb3/agent-hub'});
 assert.equal((await readChannel(f.repo,f.identity,owner,{channelId})).links[0].id,link.id);
});
test('meeting preparation appears in original chat without waking other members; owner can continue by replying there',async t=>{
 const f=await setup(t),channelId=f.c.id;
 const meeting=await f.send('channel.meeting',{channelId,action:'prepare',body:'还没想清楚如何发布'});
 let snapshot=await readChannel(f.repo,f.identity,owner,{channelId});assert.equal(snapshot.messages[0].meetingId,meeting.id);
 const turn=(await f.repo.list('channel_turn')).find(t=>t.memberId==='grok');await claimConversation(f.repo,f.identity,agent,{requestId:'meeting-claim',stepId:turn.id});
 await f.send('channel.post',{channelId,turnId:turn.id,body:'你希望先验证哪类用户？'},agent);
 snapshot=await readChannel(f.repo,f.identity,owner,{channelId});assert.equal(snapshot.messages.at(-1).body,'你希望先验证哪类用户？');assert.equal(snapshot.messages.at(-1).meetingId,meeting.id);
 await f.send('channel.post',{channelId,meetingId:meeting.id,body:'先看独立开发者'});
 assert.equal((await f.repo.list('channel_turn')).filter(t=>t.memberId==='check').length,0);
});

test('cached native catalogs use existing post_message envelope for version reads and new Todo result fields, without posting commands',async t=>{
 const f=await setup(t),channelId=f.c.id;
 const d=await f.send('channel.doc.create',{channelId,title:'旧版资料',body:'第一版 12'});
 const task=await f.send('channel.task',{channelId,action:'create',title:'真实回传',assigneeId:'grok'});
 const count=(await f.repo.list('channel_message')).length;
 const wrap=(name,args,scope=channelId)=>callTool(f.repo,f.identity,agent,'post_message',{requestId:crypto.randomUUID(),channelId:scope,body:'HUB_SHARED_TOOL_V1\n'+JSON.stringify({name,arguments:args})},{});
 const read=await wrap('read_space_object',{channelId,kind:'document',id:d.id,version:1});assert.equal(read.body,'第一版 12');
 await wrap('board_task',{channelId,taskId:task.id,action:'accept'});
 const done=await wrap('board_task',{channelId,taskId:task.id,action:'update',status:'done',result:'第一版 12 已核对'});assert.equal(done.result,'第一版 12 已核对');
 assert.equal((await f.repo.list('channel_message')).length,count);
 const other=await f.send('channel.create',{name:'另外一群',memberIds:['grok']});
 await assert.rejects(wrap('read_space_object',{channelId:other.id,kind:'document',id:d.id}),e=>e.code==='forbidden');
});
test('an old reference remains readable after more than 100 revisions',async t=>{
 const f=await setup(t),channelId=f.c.id;
 const doc=await f.send('channel.doc.create',{channelId,title:'长期资料',body:'第一版原文'});
 for(let version=1;version<=105;version++)await f.send('channel.doc.edit',{channelId,documentId:doc.id,expectedVersion:version,body:'修订 '+version,reason:'长期修订'});
 const posted=await f.send('channel.post',{channelId,body:'回到第一版',refs:[{kind:'document',id:doc.id,version:1}]});
 const data=await conversationTool(f.repo,f.identity,agent,'read_space_object',{channelId,kind:'document',id:posted.refs[0].id,version:1});
 assert.equal(data.body,'第一版原文');assert.equal(data.currentVersion,106);
});
