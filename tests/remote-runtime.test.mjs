import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {startHarness} from './v1-harness.mjs';
import {CodingMemberClient} from '../local/coding-client.mjs';
import {NativeAgent} from '../local/native-agent.mjs';
import {EventEmitter} from 'node:events';
import {revision as currentRevision} from '../cloud/collaboration/runtime-download.mjs';

test('remote account setup is reusable; native catalog, commands and routing survive restart without granting owner access',async t=>{
 const h=await startHarness();t.after(()=>h.stop());
 await h.request('/admin/action',{type:'platform.create',payload:{id:'antigravity',name:'Antigravity'}});
 const account=(await h.request('/admin/action',{type:'account.create',payload:{platformId:'antigravity',label:'remote fixture'}})).result;
 const member=(await h.request('/admin/action',{type:'member.create',payload:{accountId:account.id,name:'Remote AG',mode:'connector'}})).result;
 const setup=await h.request('/v2/connect/native',{memberId:member.id,form:'antigravity-cli'});
 assert.match(setup.skill,/antigravity-cli/);assert.match(setup.skill,/原系统用户/);
 const recipe=await(await fetch(h.base+'/v2/connectors/native/guide')).json();assert.equal(recipe.protocol,'duolawork-native/1');
 const artifact=Buffer.from(await(await fetch(h.base+'/v2/connectors/native/download?version='+setup.sha256)).arrayBuffer());assert.equal(createHash('sha256').update(artifact).digest('hex'),setup.sha256);
 const input=JSON.parse(setup.skill.match(/setup：(\{.+?\})。/)[1]);
 const remoteDir=path.join(h.directory,'remote'),linked=path.join(h.directory,'linked-program');await fs.symlink(path.resolve('.'),linked,'dir');const entry=path.join(linked,'connectors/runtime/cli.mjs');
 const bin=path.join(h.directory,'bin');await fs.mkdir(bin);await fs.writeFile(path.join(bin,'agy'),'#!/bin/sh\necho 1.5.0\n',{mode:0o700});
 const install=async input=>{const p=spawn(process.execPath,[entry,'setup'],{env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,AGENT_HUB_CONNECTOR_TEST:'1',DUOLAWORK_RUNTIME_DIR:remoteDir},stdio:['pipe','pipe','pipe']});p.stdin.end(JSON.stringify(input));let out='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>out+=d);return{code:await new Promise(r=>p.once('exit',r)),out};};
 const first=await install(input);assert.equal(first.code,0,first.out);assert.doesNotMatch(first.out,/access_token|refresh_token|ahv1_/);
 const file=path.join(remoteDir,input.alias,'grant.json'),bytes=await fs.readFile(file);assert.equal((await install(input)).code,0);assert.deepEqual(await fs.readFile(file),bytes);
 assert.equal((await install({...input,form:'gemini-cli'})).code,1);assert.deepEqual(await fs.readFile(file),bytes);
 const client=new CodingMemberClient(file),config=JSON.parse(await fs.readFile(path.join(remoteDir,input.alias,'runtime.json'))),instanceId=randomUUID();
 const post=b=>client.api('/v2/self/runtime',{method:'POST',body:{runtimeId:config.runtimeId,instanceId,...b}});
 const heartbeat={action:'heartbeat',form:'antigravity-cli',label:'VPS fixture',sourceReady:true,status:'idle',message:'connected',receiverRevision:'0'.repeat(64),items:[{id:'native-one',title:'网站',workspace:'/srv/site'},{id:'native-two',title:'App',workspace:'/srv/app'}],projects:[]};
 const {receiverRevision,...legacyHeartbeat}=heartbeat;await post(legacyHeartbeat);assert.equal((await client.api('/v2/self/status')).complete,false,'Inventory cannot verify native model execution');
 const unknown=await h.request('/v2/native-runtime?memberId='+member.id);assert.equal(unknown.record.revisionState,'unknown');assert.equal(unknown.record.updateAvailable,false);assert.equal(unknown.updateSkill,undefined);
 await post(heartbeat);
 const outdated=await h.request('/v2/native-runtime?memberId='+member.id);assert.equal(outdated.record.updateAvailable,true);assert.match(outdated.updateSkill,/更新/);assert.doesNotMatch(outdated.updateSkill,/"code":|ahv1_/);
 await post({...heartbeat,receiverRevision:currentRevision,status:'syncing'});const upgraded=await h.request('/v2/native-runtime?memberId='+member.id);assert.equal(upgraded.record.updateAvailable,false);assert.equal(upgraded.updateSkill,undefined);assert.equal(upgraded.record.status,'syncing','Queued original work must not become offline');
 await assert.rejects(()=>post({...heartbeat,instanceId:'another'}),/另一个环境/);
 const channel=await h.command('channel.create',{name:'网站协作',memberIds:[member.id]}),other=await h.command('channel.create',{name:'另一个聊天',memberIds:[member.id]});
 const create=(channelId,sessionId)=>h.request('/v2/native-runtime',{requestId:randomUUID(),memberId:member.id,channelId,sessionId,mode:'existing'});
 const command=await create(channel.id,'native-one');assert.equal((await create(channel.id,'native-two')).id,command.id,'Repeated click cannot replace in-flight selection');
 assert.equal((await h.request('/v2/native-runtime?memberId='+member.id)).bindings[channel.id],undefined);
 await assert.rejects(()=>post({action:'complete',commandId:command.id,requestId:randomUUID(),binding:{sessionId:'native-two',workspace:'/srv/app'}}),/另一段对话/);
 await post({action:'complete',commandId:command.id,requestId:randomUUID(),binding:{sessionId:'native-one',workspace:'/srv/site',title:'网站'}});
 assert.equal((await h.request('/v2/native-runtime?memberId='+member.id)).bindings[channel.id],undefined);
 await post({action:'activate',commandId:command.id,requestId:randomUUID()});
 await post(heartbeat);let owner=await h.request('/v2/native-runtime?memberId='+member.id);assert.equal(owner.bindings[channel.id].sessionId,'native-one');
 const second=await create(other.id,'native-two');await post({action:'complete',commandId:second.id,requestId:randomUUID(),binding:{sessionId:'native-two',workspace:'/srv/app',title:'App'}});
 await post({action:'activate',commandId:second.id,requestId:randomUUID()});
 await post({...heartbeat,executions:[{channelId:channel.id,sessionId:'native-one',pendingStepId:'turn_one',deliveryState:'sent',workState:'working'},{channelId:other.id,sessionId:'native-two',pendingStepId:'turn_two',deliveryState:'queued',workState:'syncing'},{channelId:'foreign',sessionId:'native-one',pendingStepId:'wrong',deliveryState:'sent'}]});
 owner=await h.request('/v2/native-runtime?memberId='+member.id);
 assert.equal(owner.record.assignments.find(b=>b.channelId===channel.id).pendingStepId,'turn_one');assert.equal(owner.record.assignments.find(b=>b.channelId===other.id).pendingStepId,'turn_two');assert.equal(owner.record.assignments.length,2);
 await post(heartbeat);assert.ok((await h.request('/v2/native-runtime?memberId='+member.id)).record.assignments.every(b=>!b.pendingStepId),'Finished work must not leave stale running indicators');
 // In-product update sends one ordinary scoped request and waits for real revision.
 const update=await h.request('/v2/native-runtime',{memberId:member.id,action:'update',requestId:'owner-update'});
 assert.equal(update.status,'requested');assert.equal(update.channelId,channel.id);
 const repeated=await h.request('/v2/native-runtime',{memberId:member.id,action:'update',requestId:'owner-update-again'});assert.equal(repeated.messageId,update.messageId);
 const updateView=await h.request('/v2/native-runtime?memberId='+member.id);assert.equal(updateView.record.updateAvailable,true);assert.equal(updateView.record.canRequestUpdate,true);
 await post({...heartbeat,receiverRevision:currentRevision});assert.equal((await h.request('/v2/native-runtime?memberId='+member.id)).record.updateAvailable,false);
 await assert.rejects(()=>client.api('/v2/self/execution-bindings',{method:'POST',body:{requestId:'stale-routing',bindings:[{channelId:channel.id,sessionId:'stale-session'}]}}),/最新绑定/);
 const legacy=await create(other.id,'native-one');await post({action:'complete',commandId:legacy.id,requestId:randomUUID(),binding:{sessionId:'native-one',workspace:'/srv/site'}});
 await client.api('/v2/self/execution-bindings',{method:'POST',body:{requestId:'legacy-prepare-sync',bindings:[{channelId:other.id,sessionId:'native-one'}]}});
 assert.equal((await h.request('/v2/native-runtime?memberId='+member.id)).bindings[other.id].sessionId,'native-two','older receiver staging cannot publish before activation');
 await post({action:'activate',commandId:legacy.id,requestId:randomUUID()});
 const failed=await create(channel.id,'native-two');await post({action:'complete',commandId:failed.id,requestId:randomUUID(),error:'原对话仍在工作'});owner=await h.request('/v2/native-runtime?memberId='+member.id);assert.equal(owner.bindings[channel.id].sessionId,'native-one');
 await assert.rejects(()=>client.api('/v2/native-runtime?memberId='+member.id),/用户/);
 const self=await client.api('/v2/self/runtime');assert.equal(self.member.id,member.id);assert.ok(self.channels.every(c=>c.memberIds.length===1));
 // A long first native turn or slow project inventory must not stop heartbeats.
 await post({action:'release'});
 let finishNative,finishCatalog;const nativeGate=new Promise(r=>finishNative=r),catalogGate=new Promise(r=>finishCatalog=r);
 const fake={records:{[member.id]:{memberId:member.id,enabled:true,sourceReady:true,status:'idle',chatBindings:{},executions:{'native-one':{inFlight:{stepId:'previous-delivery',key:channel.id}}}}},jobs:new Map(),stopped:true,beats:0,starts:0,
  async load(){},async connect(){throw Error('must reconcile saved child delivery without reconnecting');},async save(){},async stop(){this.timer=null;},
  status(){this.beats++;return{members:[{memberId:member.id,status:'working',message:'Heartbeat '+this.beats,assignments:[]}]};},
  async sessionOptions(){await catalogGate;return{items:heartbeat.items,projects:[]};},
  async start(){this.starts++;this.timer=true;await nativeGate;}};
 const priorDir=process.env.DUOLAWORK_RUNTIME_DIR;process.env.DUOLAWORK_RUNTIME_DIR=remoteDir;
 let receiver,starting;
 try{
  const {run}=await import('../connectors/runtime/cli.mjs?heartbeat-test='+randomUUID());
  starting=run(input.alias,{interval:25,managerFactory:()=>fake});
  receiver=await Promise.race([starting,new Promise(r=>setTimeout(()=>r(null),1500))]);
  assert.ok(receiver,'Receiver must start before the native task/catalog finish');
  await receiver.tick();assert.ok(fake.beats>=2);assert.equal(fake.starts,1);
  const running=await h.request('/v2/native-runtime?memberId='+member.id);assert.equal(running.record.status,'working');assert.match(running.record.message,/Heartbeat/);
 }finally{finishNative();finishCatalog();receiver??=await starting;await receiver?.close();if(priorDir===undefined)delete process.env.DUOLAWORK_RUNTIME_DIR;else process.env.DUOLAWORK_RUNTIME_DIR=priorDir;}
 await h.request('/admin/action',{type:'member.disconnect',memberId:member.id});await assert.rejects(()=>post(heartbeat));
});

test('Gemini CLI and Antigravity CLI use their own protocols and never authenticate with another runtime profile',async()=>{
 for(const engine of ['gemini-cli','antigravity-cli']){
  const calls=[];class Rpc extends EventEmitter{async call(name,args){calls.push({name,args});if(name==='initialize')return{agentInfo:{name:engine},agentCapabilities:{loadSession:true}};if(name==='session/list')return{sessions:[]};if(name==='session/new')return{sessionId:'same',modes:{availableModes:[]}};return{};}async stop(){}}
  let launch;const agent=new NativeAgent({engine,cwd:'/native-project',command:engine,permissionMode:'native',rpcFactory:o=>{launch=o;return new Rpc();}});
  await agent.initialize();await agent.session({id:'exact-original-id',cwd:'/native-project'});
  assert.deepEqual(launch.args,engine==='gemini-cli'?['--acp']:['acp']);assert.equal(calls.some(c=>c.name==='authenticate'),false);
  assert.equal(calls[1].name,engine==='gemini-cli'?'session/load':'session/resume');assert.equal(calls[1].args.sessionId,'exact-original-id');assert.equal(calls.some(c=>c.name==='session/new'),false);
 }
});
