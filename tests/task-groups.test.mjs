import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand,conversationTool} from '../cloud/collaboration/conversation.mjs';
import {secretaryOverview} from '../cloud/collaboration/secretary.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';
const owner={owner:true},agent={memberId:'grok'};
async function setup(t){const f=await fixture(t);let n=0;const send=(type,args={},actor=owner)=>conversationCommand(f.repo,f.identity,actor,{type,requestId:'group-'+(++n),...args});const c=await send('channel.create',{name:'任务归组',memberIds:['grok','check'],coordinatorId:'grok'});const task=(args,actor)=>send('channel.task',{channelId:c.id,action:'create',notifyAssignee:false,...args},actor);const list=args=>conversationTool(f.repo,f.identity,owner,'read_todo',{channelId:c.id,...args});return {...f,c,send,task,list};}

test('existing tasks move without losing history, identity, result, assignee or meeting; listing searches child and groups roots',async t=>{
 const f=await setup(t),channelId=f.c.id;
 const meeting=await f.send('channel.meeting',{channelId,action:'prepare',body:'讨论交付'});
 const root=await f.task({title:'记忆系统'}),other=await f.task({title:'通信修复'});
 const old=await f.task({title:'验收来源完整性',status:'done',result:'已核验三条来源',assigneeId:'check',meetingIds:[meeting.id]});
 const before=(await f.repo.list('channel_message')).length;
 const moved=await f.task({action:'update',taskId:old.id,parentTaskId:root.id,expectedVersion:1},agent);
 assert.equal(moved.id,old.id);assert.equal(moved.version,2);assert.equal(moved.assigneeId,'check');assert.equal(moved.result,old.result);assert.equal(moved.status,'done');assert.deepEqual(moved.meetingIds,[meeting.id]);assert.equal((await f.repo.list('channel_message')).length,before);
 assert.equal(moved.completedBy,old.completedBy);assert.equal(moved.completedAt,old.completedAt);assert.equal(moved.lastEditorId,'grok');
 const roots=await f.list({});assert.equal(roots.items.length,2);assert.equal(roots.items.find(x=>x.id===root.id).subtasks.done,1);
 assert.equal((await f.list({query:'来源完整性'})).items[0].id,root.id);
 assert.equal((await f.list({parentTaskId:root.id})).items[0].id,old.id);
 const detail=await f.list({taskId:old.id});assert.equal(detail.parentTask.id,root.id);assert.equal(detail.versions.length,2);
 await f.task({action:'update',taskId:old.id,parentTaskId:other.id,expectedVersion:2});
 assert.equal((await f.list({taskId:root.id})).subtasks.total,0);assert.equal((await f.list({taskId:other.id})).subtasks.total,1);
 const historic=await conversationTool(f.repo,f.identity,owner,'read_space_object',{channelId,kind:'task',id:old.id,version:1});assert.equal(historic.parentTask,null);assert.equal(historic.subtasks,null);
 const priorGroup=await conversationTool(f.repo,f.identity,owner,'read_space_object',{channelId,kind:'task',id:old.id,version:2});assert.equal(priorGroup.parentTask.id,root.id);
 await assert.rejects(f.task({action:'update',taskId:old.id,parentTaskId:'',expectedVersion:2}),e=>e.code==='version_conflict');
 await f.task({action:'update',taskId:old.id,parentTaskId:'',expectedVersion:3});assert.equal((await f.list({})).items.length,3);
});

test('editing completed work preserves completion attribution; reopening and completing records the new finisher',async t=>{
 const f=await setup(t),done=await f.task({title:'已交付',status:'done',result:'原交付'});
 const edited=await f.task({action:'update',taskId:done.id,title:'更清楚的标题'},agent);
 assert.equal(edited.completedBy,'owner');assert.equal(edited.completedAt,done.completedAt);assert.equal(edited.lastEditorId,'grok');
 const reopened=await f.task({action:'update',taskId:done.id,status:'todo'},agent);
 assert.equal(reopened.completedBy,null);assert.equal(reopened.completedAt,null);
 const again=await f.task({action:'update',taskId:done.id,status:'done',result:'重新验收'},agent);
 assert.equal(again.completedBy,'grok');assert.ok(again.completedAt);
});

test('completion remains explicit, requires all Todos resolved plus result; closed task cannot receive new or reopened work',async t=>{
 const f=await setup(t),root=await f.task({title:'发布网站'}),child=await f.task({title:'检查页面',parentTaskId:root.id});
 await assert.rejects(f.task({action:'update',taskId:root.id,status:'done',result:'宣称完成'}),e=>e.code==='unfinished_todos');
 await f.task({action:'update',taskId:child.id,status:'done',result:'真实验证通过'});
 assert.equal((await f.list({taskId:root.id})).status,'todo');
 await assert.rejects(f.task({action:'update',taskId:root.id,status:'done'}),e=>e.code==='result_required');
 await f.task({action:'update',taskId:root.id,status:'done',result:'产物已核对并发布'});
 await assert.rejects(f.task({title:'新需求',parentTaskId:root.id}),e=>e.code==='task_closed');
 await assert.rejects(f.task({action:'update',taskId:child.id,status:'todo'}),e=>e.code==='task_closed');
 await f.task({action:'update',taskId:root.id,status:'doing'});await f.task({action:'update',taskId:child.id,status:'todo'});
 assert.equal((await f.list({filter:'active'})).items.length,1);
});

test('one level only; foreign parents, cycles and moving a task with children are rejected',async t=>{
 const f=await setup(t),root=await f.task({title:'任务'}),child=await f.task({title:'Todo',parentTaskId:root.id});
 await assert.rejects(f.task({title:'三层',parentTaskId:child.id}),e=>e.code==='invalid_parent');
 await assert.rejects(f.task({action:'update',taskId:root.id,parentTaskId:root.id}),e=>e.code==='invalid_parent');
 const other=await f.send('channel.create',{name:'别的群',memberIds:['grok']});
 const foreign=await f.send('channel.task',{channelId:other.id,action:'create',title:'私有任务'});
 await assert.rejects(f.task({title:'跨群',parentTaskId:foreign.id}),e=>e.code==='forbidden');
 await assert.rejects(f.list({parentTaskId:foreign.id}),e=>e.code==='forbidden');
 const r2=await f.task({title:'另一任务'});
 await assert.rejects(f.task({action:'update',taskId:root.id,parentTaskId:r2.id}),e=>e.code==='invalid_parent');
});

test('creator can organize own assigned Todo but cannot alter another executor progress; compatibility envelope works',async t=>{
 const f=await setup(t),channelId=f.c.id,root=await f.task({title:'任务'});
 const created=await f.task({title:'交给负责人执行',assigneeId:'grok'},{memberId:'check'});
 const wrap=args=>callTool(f.repo,f.identity,{memberId:'check'},'post_message',{requestId:crypto.randomUUID(),channelId,body:'HUB_SHARED_TOOL_V1\n'+JSON.stringify({name:'board_task',arguments:args})},{});
 const moved=await wrap({channelId,action:'update',taskId:created.id,parentTaskId:root.id,notifyAssignee:false});assert.equal(moved.parentTaskId,root.id);
 await assert.rejects(wrap({channelId,action:'update',taskId:created.id,parentTaskId:'',progress:'越权修改'}),e=>e.code==='forbidden');
 const read=await conversationTool(f.repo,f.identity,agent,'read_todo',{channelId});assert.equal(read.items.length,1);
});

test('paged task summaries count every child, not only first visible page; old roots remain visible',async t=>{
 const f=await setup(t),root=await f.task({title:'长期任务'});
 // Seed a large existing board in one transaction; user-facing writes tested above.
 await f.repo.transact('many-todos',{},async tx=>{for(let i=0;i<105;i++)tx.put('channel_task',{id:'todo-'+String(i).padStart(3,'0'),scopeId:f.c.id,parentId:root.id,parentTaskId:root.id,title:'Todo '+i,status:i<103?'done':'todo',version:1});});
 const roots=await f.list({});assert.deepEqual(roots.items[0].subtasks,{total:105,done:103,canceled:0,blocked:0,active:2});
 const page=await f.list({parentTaskId:root.id});assert.equal(page.items.length,100);assert.ok(page.next);
 const last=await f.list({parentTaskId:root.id,after:page.next});assert.equal(last.items.length,5);assert.equal(last.next,null);
 await assert.rejects(f.task({action:'update',taskId:root.id,status:'done',result:'不能遗漏后页'}),e=>e.code==='unfinished_todos');
});

test('concurrent closing and Todo creation cannot leave a finished parent with live work',async t=>{
 const f=await setup(t),root=await f.task({title:'并发任务'});await f.task({title:'已结束子项',parentTaskId:root.id,status:'done',result:'完成'});
 const results=await Promise.allSettled([f.task({action:'update',taskId:root.id,status:'done',result:'已核验'}),f.task({title:'同时追加',parentTaskId:root.id})]);
 const current=await f.list({taskId:root.id});assert.ok(current.status!=='done'||current.subtasks.active===0);assert.ok(results.some(r=>r.status==='rejected'));
});

test('secretary counts tasks once and surfaces blocked Todos without inflating project completion',async t=>{
 const f=await setup(t),root=await f.task({title:'功能上线'});
 await f.task({title:'实现',parentTaskId:root.id,status:'done',result:'已实现'});
 await f.task({title:'验收',parentTaskId:root.id,status:'blocked',blocker:'发现缺陷'});
 const overview=await secretaryOverview(f.repo,f.identity,owner),group=overview.groups.find(x=>x.id===f.c.id);
 assert.equal(group.total,1);assert.equal(group.done,0);assert.equal(group.blocked,1);assert.equal(group.tasks.length,1);
});
