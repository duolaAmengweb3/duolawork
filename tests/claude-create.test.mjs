import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {startHarness} from './v1-harness.mjs';
import {NativeSessionCreator,launchNative} from '../connectors/claude/create-session.mjs';

test('Claude owner creates independent native sessions, requires real registration and preserves newer choices',async t=>{
 const h=await startHarness();t.after(()=>h.stop());await h.request('/admin/action',{type:'platform.create',payload:{id:'claude-code',name:'Claude'}});
 const m=await h.member('claude-code','native'),api=(body)=>h.request('/v2/self/native-sessions',body,m.token);
 const one={sessionId:randomUUID(),instanceId:'one',runtimeId:'original-vps',workspace:'/srv/project',title:'original'};
 const two={...one,sessionId:randomUUID(),instanceId:'two',canCreate:true};
 await api(one);const a=await h.command('channel.create',{name:'group A',memberIds:[m.id]}),b=await h.command('channel.create',{name:'group B',memberIds:[m.id]});
 const select=(channelId,args)=>h.request('/v2/native-sessions',{requestId:randomUUID(),memberId:m.id,channelId,...args});
 await select(a.id,{mode:'existing',sessionId:one.sessionId});
 await assert.rejects(()=>select(a.id,{mode:'new'}),/尚未提供新建能力/);
 await api({...one,canCreate:true});await api(two);
 const c=await select(a.id,{mode:'new',workspace:'/srv/project'});assert.equal(c.status,'pending');c.sessionId=randomUUID();
 assert.equal((await select(a.id,{mode:'new'})).id,c.id,'double-click does not launch twice');
 const action=(s,action,extra={})=>api({action,sessionId:s.sessionId,instanceId:s.instanceId,commandId:c.id,requestId:randomUUID(),...extra});
 assert.equal((await action(one,'claim-create')).owned,true);assert.equal((await action(two,'claim-create')).owned,false);
 await assert.rejects(()=>action(two,'complete-create'),/其他接收器/);
 await assert.rejects(()=>action(one,'complete-create'),/尚未接通/);
 await api({...one,sessionId:c.sessionId,instanceId:'created-A',canCreate:true});
 await assert.rejects(()=>action(one,'complete-create',{workspace:'/wrong',createdSessionId:c.sessionId}),/项目不一致/);
 const done=await action(one,'complete-create',{workspace:'/srv/project',createdSessionId:c.sessionId});assert.equal(done.binding.sessionId,c.sessionId);
 const second=await select(b.id,{mode:'new'});second.sessionId=randomUUID();assert.notEqual(second.sessionId,c.sessionId);
 await api({action:'claim-create',sessionId:two.sessionId,instanceId:two.instanceId,commandId:second.id,requestId:randomUUID()});
 await api({...two,sessionId:second.sessionId,instanceId:'created-B',workspace:'/srv/independent'});
 await api({action:'complete-create',sessionId:two.sessionId,instanceId:two.instanceId,commandId:second.id,createdSessionId:second.sessionId,workspace:'/srv/independent',requestId:randomUUID()});
 for(const id of [a.id,b.id])await h.command('channel.post',{channelId:id,body:'independent work'});
 const work=(await m.call('list_work')).work.filter(w=>[a.id,b.id].includes(w.channelId));assert.equal(work.length,2);assert.ok(work.every(w=>w.status==='ready'));
 const claims=await Promise.all(work.map(w=>m.call('claim_work',{requestId:randomUUID(),channelId:w.channelId,stepId:w.stepId,expectedSessionId:w.channelId===a.id?c.sessionId:second.sessionId})));
 assert.ok(claims.every(v=>v.turnId&&v.lease),'both native resources execute concurrently');
 await assert.rejects(()=>select(a.id,{mode:'existing',sessionId:one.sessionId}),/正在处理/);
 for(const cl of claims)await m.call('post_message',{requestId:randomUUID(),channelId:cl.channelId,turnId:cl.turnId,body:'done'});
 await select(a.id,{mode:'existing',sessionId:one.sessionId});
 const stale=await select(a.id,{mode:'new'});stale.sessionId=randomUUID();await api({action:'claim-create',sessionId:one.sessionId,instanceId:one.instanceId,commandId:stale.id,requestId:randomUUID()});
 await select(a.id,{mode:'existing',sessionId:two.sessionId});
 await api({...one,sessionId:stale.sessionId,instanceId:'created-stale',canCreate:true});
 const rejected=await api({action:'complete-create',sessionId:one.sessionId,instanceId:one.instanceId,commandId:stale.id,createdSessionId:stale.sessionId,workspace:'/srv/project',requestId:randomUUID()});assert.equal(rejected.status,'failed');
 await h.command('channel.post',{channelId:a.id,body:'new binding only'});
 const next=(await m.call('list_work')).work.find(w=>w.channelId===a.id);
 await assert.rejects(()=>m.call('claim_work',{requestId:randomUUID(),channelId:a.id,stepId:next.stepId,expectedSessionId:c.sessionId}),/会话/);
 assert.ok((await m.call('claim_work',{requestId:randomUUID(),channelId:a.id,stepId:next.stepId,expectedSessionId:two.sessionId})).turnId);
});

test('native creation journal survives timeout and restart without duplicate launch or provider changes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'claude-create-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const calls=[],launches=[],s={sessionId:'original',instanceId:'one',runtimeId:'native'};
 const c={id:'nativecmd_test',channelId:'channel_test',sessionId:randomUUID(),engine:'claude',runtimeId:'native',title:'group',status:'pending',workspace:''};let ready=false,now=0;
 const client={api:async(_,o)=>{calls.push(o.body);if(o.body.action==='claim-create')return {...c,owned:true};if(o.body.action==='complete-create'){if(!ready)throw Object.assign(Error('not ready'),{status:409});return{status:'completed'};}return{status:'failed'};}};
 const options={connectionDir:root,client,launcher:{binary:'/official/claude',options:['--model','original-model','--effort','high']},now:()=>now,query:async()=>({stdout:JSON.stringify([{id:c.sessionId.slice(0,8),sessionId:c.sessionId,cwd:await fs.realpath(path.join(root,'workspaces','channel_test')),name:c.title,startedAt:now}])}),execute:async(bin,args,opt)=>{launches.push({bin,args,opt});throw Error('timeout after native spawn');}};
 await new NativeSessionCreator(options).advance(s,c);assert.equal(launches.length,1);
 assert.ok(launches[0].args.includes('--bg'));assert.ok(!launches[0].args.includes('--session-id'));assert.ok(!launches[0].args.includes('--resume'));assert.ok(!launches[0].args.includes('--settings'));
 assert.ok(launches[0].args.includes('original-model'));assert.equal(launches[0].opt.cwd,await fs.realpath(path.join(root,'workspaces','channel_test')));
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'linked-sessions',c.sessionId+'.json'))).sessionId,c.sessionId);
 ready=true;await new NativeSessionCreator(options).advance(s,c);assert.equal(launches.length,1);assert.equal(JSON.parse(await fs.readFile(path.join(root,'create-commands',c.id+'.json'))).stage,'completed');
 const bad={...c,id:'nativecmd_bad',workspace:'/does-not-exist/'+randomUUID()};await new NativeSessionCreator(options).advance(s,bad);assert.equal(calls.at(-1).action,'fail-create');assert.equal(launches.length,1);
 ready=false;now=200000;await new NativeSessionCreator(options).advance(s,c);assert.equal(calls.at(-1).action,'fail-create');assert.equal(launches.length,1);
});


test('first native trust waits for terminal readiness and confirms the rendered selection only in an owned empty folder',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'claude-terminal-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const binary=path.join(root,'native');
 await fs.writeFile(binary,`#!${process.execPath}
if(!process.stdin.isTTY){process.stderr.write('Workspace not trusted');process.exit(1);}
process.stdin.setRawMode(true);process.stdin.resume();let ready=false,selected=false;
process.stdout.write(process.cwd()+'\\n❯ No, exit\\nYes, I trust this folder\\n');
setTimeout(()=>ready=true,100);
process.stdin.on('data',b=>{const s=b.toString();if(!ready)return;if(s==='\\x1b[B'){selected=true;process.stdout.write('\\x1b[1B❯');}else if(s==='\\r'){process.stdout.write(selected?'backgrounded · abcdef12':'wrong selection');process.exit(selected?0:2);}});
`,{mode:0o700});
 await assert.rejects(()=>launchNative(binary,[],{cwd:root,timeout:3000,createdEmptyWorkspace:false}),/Command failed/);
 const result=await launchNative(binary,[],{cwd:root,timeout:3000,createdEmptyWorkspace:true});assert.match(result.stdout,/backgrounded/);assert.doesNotMatch(result.stdout,/wrong selection/);
});
