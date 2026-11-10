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

for(const platform of ['codex','antigravity','gemini-cli','deepseek-harness','claude-code'])for(const count of [1,2,3,4,5,10,17])test(`${platform}: server isolates ${count} native sessions and serializes aliases across completion and stale claims`,async t=>{
 const f=await fixture(t),actor={memberId:'grok'};f.identity.members[0].platformId=platform;
 const send=(cmd,who={owner:true})=>conversationCommand(f.repo,f.identity,who,{requestId:randomUUID(),...cmd});
 const groups=[];for(let i=0;i<count+1;i++)groups.push(await send({type:'channel.create',name:`Project ${i}`,memberIds:['grok']}));
 const session=i=>'native-'+(i===count?0:i);
 await registerExecutionBindings(f.repo,f.identity,actor,{requestId:randomUUID(),bindings:groups.map((g,i)=>({channelId:g.id,sessionId:session(i)}))});
 for(const [i,g] of groups.entries())await send({type:'channel.post',channelId:g.id,body:`Unique request ${i}`});
 const work=await conversationWork(f.repo,f.identity,'grok');
 const claim=(i,override)=>claimConversation(f.repo,f.identity,actor,{requestId:randomUUID(),stepId:work.find(w=>w.channelId===groups[i].id).stepId,expectedSessionId:override||session(i)});
 await assert.rejects(claim(0,'wrong-native'),e=>e.code==='session_changed');
 const claims=await Promise.all(groups.slice(0,count).map((_,i)=>claim(i)));assert.equal(new Set(claims.map(c=>c.turnId)).size,count);
 await assert.rejects(claim(count),e=>e.code==='resource_busy');
 const complete=i=>send({type:'channel.post',channelId:groups[i].id,turnId:claims[i].turnId,body:`Result of project ${i}`},actor);
 await complete(0);const alias=await claim(count);assert.equal(alias.channelId,groups[count].id);
 for(let i=count-1;i>0;i--)await complete(i);
 await send({type:'channel.post',channelId:groups[count].id,turnId:alias.turnId,body:'Alias completed in the same native session'},actor);
 assert.equal((await f.repo.list('resource')).filter(r=>r.status==='busy').length,0);
 await registerExecutionBindings(f.repo,f.identity,actor,{requestId:randomUUID(),bindings:[{channelId:groups[0].id,sessionId:'replacement'}]});
 const next=await send({type:'channel.post',channelId:groups[0].id,body:'New owner instruction after binding changed'});
 await assert.rejects(claimConversation(f.repo,f.identity,actor,{requestId:randomUUID(),stepId:`turn_${next.id}_grok`,expectedSessionId:session(0)}),e=>e.code==='session_changed');
});
