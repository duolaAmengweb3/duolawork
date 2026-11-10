import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fixture} from './collaboration-helper.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';
import {conversationCommand,conversationRuntime} from '../cloud/collaboration/conversation.mjs';
import {registerExecutionBindings} from '../cloud/collaboration/execution-bindings.mjs';
import {ClaudeChannel} from '../connectors/claude/channel.mjs';
import {observeNativeEnd,flushNativeEnd} from '../connectors/claude/end-observer.mjs';
import {nativeExecutionState} from '../connectors/claude/session-info.mjs';

async function setup(t){
 const f=await fixture(t),actor={memberId:'grok'};f.identity.members[0].platformId='claude-code';let seq=0;
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dw-receipt-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const requestId=()=>`receipt-${++seq}`,command=(type,args={},who={owner:true})=>conversationCommand(f.repo,f.identity,who,{requestId:requestId(),type,...args});
 const channels=await Promise.all(['ATEL','DM','independent'].map(name=>command('channel.create',{name,memberIds:['grok']})));
 const scope={bindings:Object.fromEntries(channels.map((c,i)=>[c.id,{sessionId:i===2?'other':'original'}]))};
 await registerExecutionBindings(f.repo,f.identity,actor,{requestId:requestId(),bindings:channels.map(c=>({channelId:c.id,sessionId:scope.bindings[c.id].sessionId}))});
 const tool=(name,args={})=>callTool(f.repo,f.identity,actor,name,args,{});
 const client={tool,api:async(route,options={})=>{
  if(route==='/v2/self/native-sessions')return scope;
  if(route==='/v2/self/delivery')return {};
  if(route.startsWith('/v2/self/conversation-state'))return conversationRuntime(f.repo,actor,options.body||{action:'read',turnId:new URL('http://fixture'+route).searchParams.get('turnId')});
  throw Error('Unexpected fixture API '+route);
 }};
 const notices=[],bridge=new ClaudeChannel({client,session:{sessionId:'original'},stateFile:path.join(dir,'tools.json'),notify:async n=>notices.push(n)});await bridge.load();
 const send=(i,body='test requirement')=>command('channel.post',{channelId:channels[i].id,body});
 const claim=async i=>{const message=await send(i);return tool('claim_work',{requestId:requestId(),stepId:`turn_${message.id}_grok`,channelId:channels[i].id,expectedSessionId:scope.bindings[channels[i].id].sessionId});};
 const end=(claims={},input={},overrides={})=>observeNativeEnd({client,session:bridge.session,connectionDir:dir,claims,work:()=>bridge.work(),input:{session_id:'original',hook_event_name:'Stop',...input},...overrides});
 return {...f,actor,dir,requestId,command,channels,scope,tool,client,bridge,notices,send,claim,end};
}
test('Claude rejects a retired cached notification before notifying the original session',async t=>{
 const f=await setup(t),work={stepId:'retired',channelId:f.channels[0].id,status:'ready',delivery:{attempt:0,message:{version:1}}};
 f.bridge.work=async()=>[work];f.client.api=async()=>({applied:false,status:'removed'});
 await f.bridge.tick();assert.equal(f.notices.length,0);assert.equal(f.bridge.sent.retired,undefined);assert.equal(Object.keys(f.bridge.claims).length,0);
});

test('bad tool fields return controlled errors, observed aliases work, and another member remains forbidden',async t=>{
 const f=await setup(t),claim=await f.claim(0),doc=await f.tool('create_doc',{requestId:f.requestId(),channelId:f.channels[0].id,title:'scope',body:'actual stored bytes'});
 for(const [name,args]of [['read_doc',{}],['read_doc',{documentId:123}],['stay_silent',{requestId:f.requestId(),reason:'read'}],['stay_silent',{requestId:f.requestId(),turnId:claim.turnId,reason:123}]])
  await assert.rejects(()=>f.tool(name,args),e=>e.status===400&&e.code==='invalid_arguments');
 assert.equal((await f.repo.get('channel_turn',claim.turnId)).status,'active');
 assert.equal((await f.repo.get('channel_turn',claim.turnId)).lastAckError.code,'invalid_arguments');
 await assert.rejects(()=>f.tool('read_doc',{documentId:doc.id,docId:'different'}),e=>e.code==='conflicting_arguments');
 assert.equal((await f.tool('read_doc',{docId:doc.id})).body,'actual stored bytes');
 await assert.rejects(()=>callTool(f.repo,f.identity,{memberId:'check'},'read_doc',{docId:doc.id},{}),e=>e.status===403);
 await assert.rejects(()=>callTool(f.repo,f.identity,{memberId:'check'},'stay_silent',{requestId:f.requestId(),stepId:claim.turnId,reason:'read'},{}),e=>e.status===403);
 await f.tool('stay_silent',{requestId:f.requestId(),stepId:claim.turnId,reason:'no additional information'});
 const done=await f.repo.get('channel_turn',claim.turnId);assert.equal(done.status,'silent');assert.equal(done.lastAckError,null);assert.equal((await f.repo.get('resource',done.resourceKey)).status,'idle');
});

test('official native end frees the exact session after receipt failure without inventing a reply or replaying work',async t=>{
 const f=await setup(t),first=await f.claim(0),independent=await f.claim(2);await f.send(1,'are you online');
 await f.bridge.tick();assert.equal(f.notices.length,0);
 await f.end({[first.turnId]:{turnId:first.turnId,lease:first.lease,claimedAtLocal:Date.now()}},{background_tasks:[{type:'monitor',status:'running'}]});
 const row=await f.repo.get('channel_turn',first.turnId);assert.equal(row.status,'stalled');assert.equal(row.completedAt,undefined);assert.ok(row.nativeEndedAt);assert.equal(row.nativeEndEvent,'Stop');
 assert.equal((await f.repo.get('resource',row.resourceKey)).status,'idle');assert.equal((await f.repo.get('channel_turn',independent.turnId)).status,'active');
 await f.bridge.tick();assert.equal(f.notices.length,1);assert.equal(f.notices[0].params.meta.channel_id,f.channels[1].id);
 assert.ok(!(await f.bridge.work()).some(w=>w.stepId===first.turnId));
});

test('background tasks, another session, another member and stale lease cannot release an active turn',async t=>{
 const f=await setup(t),first=await f.claim(0),claims={[first.turnId]:{turnId:first.turnId,lease:first.lease}};
 assert.equal((await f.end(claims,{background_tasks:[{status:'running'}]})).deferred,true);
 assert.equal((await f.end(claims,{session_id:'other'})).ignored,true);
 await assert.rejects(()=>conversationRuntime(f.repo,{memberId:'check'},{requestId:f.requestId(),turnId:first.turnId,state:'ended',lease:first.lease}),e=>e.status===403);
 await assert.rejects(()=>conversationRuntime(f.repo,f.actor,{requestId:f.requestId(),turnId:first.turnId,state:'ended',lease:first.lease,expectedSessionId:'other'}),e=>e.code==='session_changed');
 const stale=await conversationRuntime(f.repo,f.actor,{requestId:f.requestId(),turnId:first.turnId,state:'ended',lease:'stale',expectedSessionId:'original'});assert.equal(stale.observationApplied,false);assert.equal(stale.status,'active');
});

test('end report survives network loss using only its saved lease and never settles a newer execution',async t=>{
 const f=await setup(t),first=await f.claim(0),claims={[first.turnId]:{turnId:first.turnId,lease:first.lease}};
 const disconnected={api:async()=>{throw Error('fixture offline');}};
 await f.end(claims,{}, {client:disconnected,work:async()=>[]});
 const file=path.join(f.dir,'monitor-state/original.ended.json'),marker=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(marker.turns[0].lease,first.lease);assert.doesNotMatch(JSON.stringify(marker),/last_assistant_message|private final/);
 await f.repo.transact(f.requestId(),{},async tx=>{const r=await tx.get('channel_turn',first.turnId);tx.put('channel_turn',{...r,lease:'newer-lease'});return {};});
 await flushNativeEnd({client:f.client,session:f.bridge.session,connectionDir:f.dir});
 assert.equal((await f.repo.get('channel_turn',first.turnId)).status,'active');await assert.rejects(fs.access(file));
});

test('old claim ledger can use current native ownership; successful receipts remain valid for continuation',async t=>{
 const f=await setup(t);const message=await f.send(0),claim=await f.bridge.tool('claim_work',{requestId:f.requestId(),stepId:`turn_${message.id}_grok`,channelId:f.channels[0].id});
 assert.equal(f.bridge.claims[claim.turnId].lease,claim.lease);
 await f.bridge.tool('stay_silent',{requestId:f.requestId(),stepId:claim.turnId,reason:'no additional information'});
 assert.equal(f.bridge.claims[claim.turnId].acknowledged,true);
 const next=await f.claim(1);
 await f.end({[claim.turnId]:f.bridge.claims[claim.turnId]}, {last_assistant_message:'private final'});
 assert.equal((await f.repo.get('channel_turn',claim.turnId)).status,'silent');assert.equal((await f.repo.get('channel_turn',next.turnId)).status,'stalled');
});

test('a deferred Stop is durable and reconciles only exact official idle metadata, without another Stop or a timeout guess',async t=>{
 const f=await setup(t),claim=await f.claim(0),claims={[claim.turnId]:{turnId:claim.turnId,lease:claim.lease}};
 await f.end(claims,{background_tasks:[{type:'shell',status:'running'}]});
 const file=path.join(f.dir,'monitor-state/original.ended.json');assert.equal(JSON.parse(await fs.readFile(file,'utf8')).awaitNativeIdle,true);
 const session={...f.bridge.session,pid:123,workspace:'/original/project'};
 const query=rows=>nativeExecutionState(session,{binary:'/original/claude',run:async(binary,args)=>{assert.deepEqual(args,['agents','--all','--json','--cwd',session.workspace]);return {stdout:JSON.stringify(rows)};}});
 for(const rows of [[],[{sessionId:'original',pid:999,cwd:session.workspace,status:'idle',state:'done'}],[{sessionId:'original',pid:123,cwd:session.workspace,status:'working',state:'working'}]]){
  await flushNativeEnd({client:f.client,session,connectionDir:f.dir,nativeState:()=>query(rows)});assert.equal((await f.repo.get('channel_turn',claim.turnId)).status,'active');
 }
 await flushNativeEnd({client:f.client,session,connectionDir:f.dir,nativeState:()=>query([{sessionId:'original',pid:123,cwd:session.workspace,status:'idle',state:'done'}])});
 assert.equal((await f.repo.get('channel_turn',claim.turnId)).status,'stalled');await assert.rejects(fs.access(file));
});
