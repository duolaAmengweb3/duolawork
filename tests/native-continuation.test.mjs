import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand} from '../cloud/collaboration/conversation.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';
import {registerExecutionBindings} from '../cloud/collaboration/execution-bindings.mjs';
import {ClaudeChannel} from '../connectors/claude/channel.mjs';
import {sessionTool} from '../local/coding-session-tools.mjs';
import {CodingMemberClient} from '../local/coding-client.mjs';
import {privateJson} from '../local/storage.mjs';

async function setup(t){
 const f=await fixture(t),actor={memberId:'grok'};f.identity.members[0].platformId='claude-code';let seq=0,clock=Date.now();
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dw-continuation-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const requestId=()=>`continuation-${++seq}`;
 const command=(type,args={},who={owner:true})=>conversationCommand(f.repo,f.identity,who,{requestId:requestId(),type,...args});
 const channel=await command('channel.create',{name:'current project',memberIds:['grok']});
 const scope={bindings:{},verificationSessionId:'session-one'},options={clock:()=>clock,sleep:async ms=>{clock+=ms;}};
 const bind=async(channelId,sessionId)=>{
  await registerExecutionBindings(f.repo,f.identity,actor,{requestId:requestId(),bindings:[{channelId,sessionId}]});scope.bindings[channelId]={sessionId};
 };
 await bind(channel.id,'session-one');
 const client={api:async route=>{assert.equal(route,'/v2/self/native-sessions');return scope;},tool:(name,args={})=>callTool(f.repo,f.identity,actor,name,args,{},options)};
 const notices=[],bridge=new ClaudeChannel({client,session:{sessionId:'session-one'},stateFile:path.join(directory,'tools.json'),notify:async n=>notices.push(n)});await bridge.load();
 const send=(body='new work',channelId=channel.id)=>command('channel.post',{channelId,body});
 const claim=async()=>{const work=await bridge.work();return bridge.tool('claim_work',{requestId:requestId(),stepId:work.find(w=>w.status==='ready').stepId});};
 const reply=c=>bridge.tool('post_message',{requestId:requestId(),channelId:c.channelId,turnId:c.turnId,body:'actual fixture reply'});
 return {...f,actor,directory,requestId,command,channel,scope,options,bind,client,bridge,notices,send,claim,reply,advance:ms=>{clock+=ms;}};
}

for(const count of [1,2,3,4,5,10,17])test(`Claude adapter: ${count} native monitors isolate busy work, deduplicate wakes and retain scoped claims after restart`,async t=>{
 const f=await setup(t),channels=[f.channel];
 for(let i=1;i<count;i++)channels.push(await f.command('channel.create',{name:`native ${i}`,memberIds:['grok']}));
 const notices=[],bridges=[];
 for(const [i,c] of channels.entries()){
  const sessionId=`claude-native-${i}`;await f.bind(c.id,sessionId);
  const b=new ClaudeChannel({client:f.client,session:{sessionId},stateFile:path.join(f.directory,`native-${i}.json`),notify:async n=>notices.push(n)});await b.load();bridges.push(b);await f.send(`Work ${i}`,c.id);
 }
 await Promise.all(bridges.flatMap(b=>[b.tick(),b.tick()]));assert.equal(notices.length,count);
 const claims=await Promise.all(bridges.map(async b=>b.tool('claim_work',{requestId:f.requestId(),stepId:(await b.work()).find(w=>w.status==='ready').stepId})));
 for(const c of channels)await f.send('Queued next instruction',c.id);
 await Promise.all(bridges.map(b=>b.tick()));assert.equal(notices.length,count,'active native work is not interrupted');
 const first=bridges[0],claim=claims[0];await first.tool('post_message',{requestId:f.requestId(),channelId:claim.channelId,turnId:claim.turnId,body:'first native done'});
 const restarted=new ClaudeChannel({client:f.client,session:first.session,stateFile:first.stateFile,notify:async n=>notices.push(n)});await restarted.load();await restarted.tick();assert.equal(notices.length,count+1,'other active sessions cannot block this next wake');
 assert.ok(restarted.claims[claim.turnId]);
 if(count>1)await assert.rejects(restarted.tool('post_message',{requestId:f.requestId(),channelId:claims[1].channelId,turnId:claims[1].turnId,body:'wrong context'}),/未分配/);
});

test('Claude continuation claims the next message in the same session and survives tool-process restart',async t=>{
 const f=await setup(t);await f.send('first');const first=await f.claim();await f.reply(first);await f.send('second');
 const restarted=new ClaudeChannel({client:f.client,session:f.bridge.session,stateFile:f.bridge.stateFile,notify:async()=>{}});await restarted.load();
 const args={requestId:f.requestId(),stepId:first.input.continuation.stepId};
 const next=await restarted.tool('claim_work',args);assert.equal(next.status,'claimed');assert.notEqual(next.turnId,first.turnId);assert.equal(next.channelId,f.channel.id);
 assert.equal((await restarted.tool('claim_work',args)).turnId,next.turnId,'one request remains idempotent');
 await restarted.tool('post_message',{requestId:f.requestId(),channelId:f.channel.id,turnId:next.turnId,body:'continued in original fixture session'});
 const empty=await restarted.tool('claim_work',{requestId:f.requestId(),stepId:next.input.continuation.stepId});assert.equal(empty.status,'empty');
 assert.ok(!Object.hasOwn(restarted.claims,'undefined'),'empty continuation does not invent a claim');
 const wait=await f.repo.get('channel_wait',f.channel.id+':grok');assert.equal(wait.status,'finished');
});

test('Claude rejects continuation from another original session and stops a binding changed during the wait',async t=>{
 const f=await setup(t);await f.send();const first=await f.claim();await f.reply(first);
 const other=new ClaudeChannel({client:f.client,session:{sessionId:'session-two'},stateFile:path.join(f.directory,'other.json'),notify:async()=>{}});await other.load();
 await assert.rejects(()=>other.tool('claim_work',{requestId:f.requestId(),stepId:first.input.continuation.stepId}),/没有领取/);
 let message;
 f.options.sleep=async ms=>{f.advance(ms);await f.bind(f.channel.id,'session-two');message=await f.send('for the newly selected session');};
 await assert.rejects(()=>f.bridge.tool('claim_work',{requestId:f.requestId(),stepId:first.input.continuation.stepId}),e=>e.code==='session_changed');
 assert.equal((await f.repo.get('channel_turn',`turn_${message.id}_grok`)).status,'ready');
 const result=await other.tool('claim_work',{requestId:f.requestId(),stepId:`turn_${message.id}_grok`});assert.equal(result.turnId,`turn_${message.id}_grok`);assert.equal(result.channelId,f.channel.id);
});

test('native CLI helper supports virtual continuation, preserves request id, and rejects another channel',async t=>{
 const f=await setup(t),record={memberId:'grok',chatBindings:{[f.channel.id]:{sessionId:'session-one'}}};
 const run=(stepId,args={})=>sessionTool({record,channelId:f.channel.id,operation:'call',name:'claim_work',args:{stepId,requestId:f.requestId(),...args},client:f.client});
 const m=await f.send(),first=await run(`turn_${m.id}_grok`);
 await f.command('channel.post',{channelId:f.channel.id,turnId:first.turnId,body:'first done'},f.actor);await f.send('second');
 const requestId=f.requestId(),next=await run(first.input.continuation.stepId,{requestId});assert.equal(next.status,'claimed');assert.equal((await run(first.input.continuation.stepId,{requestId})).turnId,next.turnId);
 await f.command('channel.post',{channelId:f.channel.id,turnId:next.turnId,body:'second done'},f.actor);
 const channel=await f.command('channel.create',{name:'other project',memberIds:['grok']});await f.bind(channel.id,'session-two');
 const foreign=await f.send('foreign',channel.id),c=await f.client.tool('claim_work',{requestId:f.requestId(),stepId:`turn_${foreign.id}_grok`,expectedSessionId:'session-two'});
 await f.command('channel.post',{channelId:channel.id,turnId:c.turnId,body:'foreign done'},f.actor);
 await assert.rejects(()=>run(c.input.continuation.stepId),e=>e.code==='forbidden');
 await assert.rejects(()=>run(next.input.continuation.stepId,{channelId:channel.id}),/不属于/);
});

test('an active Claude step is never reminded, even after cooldown, process restart or queued additions',async t=>{
 const f=await setup(t);await f.send();await f.bridge.tick();assert.equal(f.notices.length,1);const c=await f.claim();
 f.bridge.sent[c.turnId].at=Date.now()-130000;await f.bridge.save();await f.send('queued supplement');
 await f.bridge.tick();assert.equal(f.notices.length,1);
 const restarted=new ClaudeChannel({client:f.client,session:f.bridge.session,stateFile:path.join(f.directory,'new-monitor-process.json'),notify:async n=>f.notices.push(n)});await restarted.load();
 await restarted.tick();assert.equal(f.notices.length,1,'an empty local notification ledger cannot repeat an active claim');
 await f.reply(c);await Promise.all([restarted.tick(),restarted.tick()]);assert.equal(f.notices.length,2,'queued work wakes once after the active response');
 assert.notEqual(f.notices[1].params.meta.step_id,c.turnId);
});

test('a failed native notification retains the unclaimed message and can retry',async t=>{
 const f=await setup(t);await f.send();let count=0;
 f.bridge.notify=async()=>{if(++count===1)throw Error('fixture disconnected');};
 await assert.rejects(()=>f.bridge.tick(),/disconnected/);await f.bridge.tick();assert.equal(count,2);
 assert.equal((await f.bridge.work())[0].status,'ready','a notification is not a claim');
});

test('native client deadline exceeds the bounded 45 second receive, while ordinary tools keep their deadline',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dw-client-timeout-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const file=path.join(directory,'grant.json');await privateJson(file,{memberId:'fixture',endpoint:'https://fixture.invalid',access_token:'fixture-only'});
 const timeouts=[],client=new CodingMemberClient(file,{request:async(_url,opts)=>{timeouts.push(opts.timeout);return{status:'empty'};}});
 await client.tool('claim_work',{requestId:'one',stepId:'inbox:after:turn_fixture'});await client.tool('receive_messages',{requestId:'two',waitSeconds:45});await client.tool('list_work');
 assert.deepEqual(timeouts,[55000,55000,30000]);
});
