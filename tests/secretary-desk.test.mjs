import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {managementSettings,manageWorkspace} from '../cloud/collaboration/management.mjs';
import {secretaryCommand,secretaryOverview,secretaryMaintenance} from '../cloud/collaboration/secretary.mjs';
import {conversationCommand,claimConversation,conversationTool} from '../cloud/collaboration/conversation.mjs';
import {withConversationContext} from '../cloud/collaboration/inbox.mjs';
const owner={owner:true},agent={memberId:'grok'};
async function setup(t){const f=await fixture(t);f.identity.members.forEach(m=>m.name=m.id);await managementSettings(f.repo,f.identity,owner,{requestId:'secretary',expectedVersion:0,memberId:'grok'});return f;}
test('秘书委托去重，携带真实当前资料，正常回传与完成状态分别记录',async t=>{
 const f=await setup(t),c=await conversationCommand(f.repo,f.identity,owner,{type:'channel.create',requestId:'group',name:'项目 A',memberIds:['check']});
 const d=await conversationCommand(f.repo,f.identity,owner,{type:'channel.doc.create',requestId:'doc',channelId:c.id,title:'方案',body:'只核对，不改代码'});
 const input={action:'send',requestId:'one',body:'解释这份方案',context:{channelId:c.id,ref:{kind:'document',id:d.id}}};
 const a=await secretaryCommand(f.repo,f.identity,owner,input);assert.deepEqual(await secretaryCommand(f.repo,f.identity,owner,input),a);
 await assert.rejects(secretaryCommand(f.repo,f.identity,owner,{...input,body:'更改后的内容'}),e=>e.code==='idempotency_conflict');
 assert.equal((await f.repo.list('channel_message',{scope:a.channelId})).length,1);
 const claim=await claimConversation(f.repo,f.identity,agent,{requestId:'claim',receiveNext:true,channelId:a.channelId});
 const ctx=await withConversationContext(f.repo,f.identity,agent,claim);assert.equal(ctx.input.secretaryRequests[0].context.ref.title,'方案');
 await conversationTool(f.repo,f.identity,agent,'post_message',{requestId:'reply',channelId:a.channelId,turnId:claim.turnId,body:'方案强调保留原工作环境。',mentions:[]});
 let view=await secretaryOverview(f.repo,f.identity,owner);assert.equal(view.requests[0].displayStatus,'已回复');assert.equal(view.requests[0].replies[0].body,'方案强调保留原工作环境。');
 await manageWorkspace(f.repo,f.identity,agent,{action:'request_update',requestId:'done',settings:{id:a.id,status:'done',progress:'已解释方案，并指出仍待验证的部分'}});
 view=await secretaryOverview(f.repo,f.identity,owner);assert.equal(view.requests[0].displayStatus,'已完成');
 await f.repo.transact('unrelated-followups',{},async tx=>{for(let i=0;i<110;i++)tx.put('channel_message',{id:'later-'+i,scopeId:a.channelId,parentId:a.channelId,authorId:'grok',body:'无关后续消息',createdAt:tx.now});});
 view=await secretaryOverview(f.repo,f.identity,owner);assert.equal(view.requests[0].replies[0].body,'方案强调保留原工作环境。');assert.equal(view.requests[0].progress,'已解释方案，并指出仍待验证的部分');
 const question=await conversationCommand(f.repo,f.identity,owner,{type:'channel.ask',requestId:'pending-question',channelId:c.id,question:'选择哪个交付日期？',options:['周一','周二']});
 view=await secretaryOverview(f.repo,f.identity,owner);const pending=view.questions.find(q=>q.id===question.id);const original=await f.repo.get('channel_message',pending.messageId);assert.equal(original.questionId,question.id);assert.equal(original.scopeId,c.id);
 await assert.rejects(secretaryOverview(f.repo,f.identity,{memberId:'write'}),e=>e.code==='forbidden');
});
test('更换秘书撤销旧委托工具与旧提醒；日报跨服务重启同日只发一次',async t=>{
 const f=await setup(t);
 await secretaryCommand(f.repo,f.identity,owner,{action:'schedule',requestId:'daily',enabled:true,time:'18:00',timeZone:'Asia/Shanghai'});
 await secretaryMaintenance(f.repo,f.identity,'2026-11-06T09:59:00Z');assert.equal((await f.repo.list('secretary_request')).length,0);
 await secretaryMaintenance(f.repo,f.identity,'2026-11-06T10:00:00Z');await secretaryMaintenance(f.repo,f.identity,'2026-11-06T10:01:00Z');assert.equal((await f.repo.list('secretary_request')).length,1);
 await managementSettings(f.repo,f.identity,owner,{requestId:'change',expectedVersion:1,memberId:'check'});
 await assert.rejects(secretaryCommand(f.repo,f.identity,owner,{action:'send',requestId:'old-unsent',body:'给原秘书的请求',memberId:'grok',grantVersion:1}),e=>e.code==='delegation_changed');
 await secretaryMaintenance(f.repo,f.identity,'2026-11-07T10:00:00Z');assert.equal((await f.repo.list('secretary_request')).length,1);
 await assert.rejects(manageWorkspace(f.repo,f.identity,agent,{action:'overview'}),e=>e.code==='forbidden');
});
test('关注真实待办完结才通知；重复维护不会反复催问，用户可以取消',async t=>{
 const f=await setup(t),c=await conversationCommand(f.repo,f.identity,owner,{type:'channel.create',requestId:'group',name:'项目 B',memberIds:['grok']});
 await f.repo.transact('task',{},tx=>tx.put('channel_task',{id:'todo1',scopeId:c.id,parentId:c.id,title:'发布',status:'doing',version:1}));
 const w=await manageWorkspace(f.repo,f.identity,agent,{action:'watch',requestId:'watch',settings:{kind:'task',id:'todo1'}});
 await secretaryMaintenance(f.repo,f.identity);assert.equal((await f.repo.list('secretary_request')).length,0);
 await f.repo.transact('done',{},async tx=>tx.put('channel_task',{...await tx.get('channel_task','todo1'),status:'done',result:'已部署',version:2}));
 await secretaryMaintenance(f.repo,f.identity);await secretaryMaintenance(f.repo,f.identity);assert.equal((await f.repo.list('secretary_request')).length,1);assert.equal((await f.repo.get('secretary_watch',w.id)).status,'notified');
 await secretaryCommand(f.repo,f.identity,owner,{action:'cancel_watch',requestId:'cancel',watchId:w.id});assert.equal((await f.repo.get('secretary_watch',w.id)).status,'canceled');
 const overview=await secretaryOverview(f.repo,f.identity,owner);assert.equal(overview.groups[0].done,1);assert.equal(overview.groups[0].total,1);
});
