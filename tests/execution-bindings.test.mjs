import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {fixture} from './collaboration-helper.mjs';import {registerExecutionBindings} from '../cloud/collaboration/execution-bindings.mjs';import {conversationCommand,claimConversation,conversationWork} from '../cloud/collaboration/conversation.mjs';
test('one account runs two native sessions while one shared session remains exclusive and active bindings cannot change',async t=>{
 const f=await fixture(t);f.identity.members.find(m=>m.id==='grok').platformId='codex';const actor={memberId:'grok'},owner={owner:true};
 const send=cmd=>conversationCommand(f.repo,f.identity,owner,{requestId:randomUUID(),...cmd});
 const groups=[];for(const name of ['项目 A','项目 B','同一原对话'])groups.push(await send({type:'channel.create',name,memberIds:['grok']}));
 await registerExecutionBindings(f.repo,f.identity,actor,{requestId:'bind',bindings:groups.map((g,i)=>({channelId:g.id,sessionId:i===1?'session-b':'session-a'}))});
 for(const g of groups)await send({type:'channel.post',channelId:g.id,body:'处理本群要求'});
 const work=await conversationWork(f.repo,f.identity,'grok'),claim=i=>claimConversation(f.repo,f.identity,actor,{requestId:randomUUID(),stepId:work.find(w=>w.channelId===groups[i].id).stepId});
 const [a,b]=await Promise.all([claim(0),claim(1)]);assert.ok(a.turnId&&b.turnId);assert.notEqual(a.turnId,b.turnId);
 await assert.rejects(claim(2),e=>e.code==='resource_busy');
 await assert.rejects(registerExecutionBindings(f.repo,f.identity,actor,{requestId:'change-busy',bindings:[{channelId:groups[0].id,sessionId:'different'}]}),e=>e.code==='resource_busy');
 const resources=(await f.repo.list('resource')).filter(r=>r.status==='busy');assert.equal(resources.length,2);
 const foreign=await send({type:'channel.create',name:'其他群',memberIds:['check']});
 await assert.rejects(registerExecutionBindings(f.repo,f.identity,actor,{requestId:'foreign',bindings:[{channelId:foreign.id,sessionId:'session-a'}]}),e=>e.code==='forbidden');
});
