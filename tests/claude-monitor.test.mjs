import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {nativeIdentity,writeMonitorPlugin,MonitorBridge} from '../connectors/claude/monitor.mjs';
import {privateJson} from '../local/storage.mjs';
import {startHarness} from './v1-harness.mjs';
import {CodingMemberClient} from '../local/coding-client.mjs';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

test('monitor identifies only its actual native ancestor; never latest or unrelated session',async()=>{
 const reads=[];const options={pid:32,configDir:'/fixture',parent:async p=>p===32?16:1,stat:async()=>({birthtimeMs:123}),readJson:async p=>{reads.push(p);if(p.endsWith('/16.json'))return{pid:16,sessionId:'original',cwd:'/srv/project',title:'网站'};throw Object.assign(Error(),{code:'ENOENT'});}};
 const a=await nativeIdentity(options);assert.equal(a.sessionId,'original');assert.equal(a.workspace,'/srv/project');assert.deepEqual(reads,['/fixture/sessions/32.json','/fixture/sessions/16.json']);
 assert.equal(await nativeIdentity({...options,parent:async()=>1}),null);
 assert.equal(await nativeIdentity({...options,readJson:async()=>({pid:99,sessionId:'wrong',cwd:'/srv/other'})}),null);
});

test('monitor and MCP processes share exact routing but preserve independent receipt state across restart',async t=>{
 const h=await startHarness();t.after(()=>h.stop());
 await h.request('/admin/action',{type:'platform.create',payload:{id:'claude-code',name:'Claude'}});
 const m=await h.member('claude-code','monitor fixture');
 const connectionDir=path.join(h.directory,'monitor');
 await privateJson(path.join(connectionDir,'grant.json'),{memberId:m.id,endpoint:h.base,access_token:m.token});
 await privateJson(path.join(connectionDir,'monitor-sessions.json'),{runtimeId:'fixture',sessionIds:['native-one','native-two']});
 const client=new CodingMemberClient(path.join(connectionDir,'grant.json'));
 const identity=async()=>({sessionId:'native-one',workspace:'/fixture/project',title:'实际项目',instanceId:'test-1'});
 const notices=[],monitor=new MonitorBridge({connectionDir,client,identity,output:s=>notices.push(s)});
 await monitor.tick();
 await client.api('/v2/self/native-sessions',{method:'POST',body:{...await identity(),sessionId:'native-two',instanceId:'test-2',runtimeId:'fixture'}});
 const a=await h.command('channel.create',{name:'one',memberIds:[m.id]}),b=await h.command('channel.create',{name:'two',memberIds:[m.id]});
 for(const [channelId,sessionId] of [[a.id,'native-one'],[b.id,'native-two']])await h.request('/v2/native-sessions',{requestId:randomUUID(),memberId:m.id,channelId,sessionId,mode:'existing'});
 await h.command('channel.post',{channelId:a.id,body:'only-one'});await h.command('channel.post',{channelId:b.id,body:'only-two'});
 await monitor.tick();await monitor.tick();assert.equal(notices.length,1);
 const rpc=new MonitorBridge({connectionDir,client,identity,kind:'tools'}),work=(await rpc.tool('list_work')).work;
 assert.equal(work.length,1);assert.equal(work[0].channelId,a.id);
 const claim=await rpc.tool('claim_work',{requestId:randomUUID(),stepId:work[0].stepId});
 await monitor.tick();
 const restartedRpc=new MonitorBridge({connectionDir,client,identity,kind:'tools'});
 await restartedRpc.tool('post_message',{requestId:randomUUID(),channelId:a.id,turnId:claim.turnId,body:'real protocol receipt'});
 await assert.rejects(()=>restartedRpc.tool('post_message',{requestId:randomUUID(),channelId:b.id,turnId:claim.turnId,body:'wrong'}),/未分配/);
 await monitor.close();const state=await h.request('/v2/native-sessions?memberId='+m.id);assert.equal(state.items.find(s=>s.id==='native-one').online,false);assert.equal(state.bindings[a.id].sessionId,'native-one');
 // An unhandled notice from the old process must not impose its 120s retry
 // cooldown on a resumed process. The Hub still owns claim/idempotency checks.
 await h.command('channel.post',{channelId:a.id,body:'queued just before close'});await monitor.tick();await monitor.close();
 const resumed=new MonitorBridge({connectionDir,client,identity:async()=>({...await identity(),instanceId:'test-1-resumed'}),output:s=>notices.push(s)});
 const count=notices.length;await resumed.tick();assert.equal(notices.length,count+1);await resumed.close();
});

for(const count of [1,3,5,10])test(`Claude Monitor: ${count} independently scoped sessions continue while the first claim stays active`,async t=>{
 const h=await startHarness();t.after(()=>h.stop());await h.request('/admin/action',{type:'platform.create',payload:{id:'claude-code',name:'Claude'}});
 const m=await h.member('claude-code','parallel monitors'),connectionDir=path.join(h.directory,'parallel-monitor'),ids=Array.from({length:count},(_,i)=>'native-'+i);
 await privateJson(path.join(connectionDir,'grant.json'),{memberId:m.id,endpoint:h.base,access_token:m.token});await privateJson(path.join(connectionDir,'monitor-sessions.json'),{runtimeId:'fixture-parallel',sessionIds:ids});
 const rows=[];
 for(const [i,sessionId]of ids.entries()){
  const client=new CodingMemberClient(path.join(connectionDir,'grant.json')),identity=async()=>({sessionId,workspace:'/fixture/project-'+i,title:'Original '+i,instanceId:'instance-'+i}),notices=[];
  const monitor=new MonitorBridge({connectionDir,client,identity,launcher:async()=>null,output:x=>notices.push(x)});t.after(()=>monitor.close());await monitor.tick();
  const channel=await h.command('channel.create',{name:'Isolated '+i,memberIds:[m.id]});await h.request('/v2/native-sessions',{requestId:randomUUID(),memberId:m.id,channelId:channel.id,sessionId,mode:'existing'});
  rows.push({monitor,notices,channel,rpc:new MonitorBridge({connectionDir,client,identity,kind:'tools'})});
 }
 await Promise.all(rows.map(r=>h.command('channel.post',{channelId:r.channel.id,body:'Original requirement '+r.channel.id})));
 await Promise.all(rows.map(async r=>{await r.monitor.tick();await r.monitor.tick();assert.equal(r.notices.length,1);const work=(await r.rpc.tool('list_work')).work;assert.equal(work.length,1);assert.equal(work[0].channelId,r.channel.id);r.claim=await r.rpc.tool('claim_work',{requestId:randomUUID(),stepId:work[0].stepId});}));
 for(const r of rows.slice(1)){
  await r.rpc.tool('post_message',{requestId:randomUUID(),channelId:r.channel.id,turnId:r.claim.turnId,body:'Other session finished before first'});
  await h.command('channel.post',{channelId:r.channel.id,body:'Next independent requirement'});await r.monitor.tick();assert.equal(r.notices.length,2);
 }
 // The first native lease is still owned, so other sessions did not steal or
 // prematurely settle it. Its original claim can complete normally afterward.
 const first=rows[0];await first.rpc.tool('post_message',{requestId:randomUUID(),channelId:first.channel.id,turnId:first.claim.turnId,body:'First now completed'});
});

test('pasted association links an unselected original conversation without re-pairing the account',async t=>{
 const h=await startHarness();t.after(()=>h.stop());await h.request('/admin/action',{type:'platform.create',payload:{id:'claude-code',name:'Claude'}});
 const m=await h.member('claude-code','existing account'),connectionDir=path.join(h.directory,'monitor');
 await privateJson(path.join(connectionDir,'grant.json'),{memberId:m.id,endpoint:h.base,access_token:m.token});
 await privateJson(path.join(connectionDir,'monitor-sessions.json'),{runtimeId:'original-environment',sessionIds:[]});
 const client=new CodingMemberClient(path.join(connectionDir,'grant.json')),identity=async()=>({sessionId:'new-original',workspace:'/srv/original',title:'实际开发',instanceId:'exact-process'});
 const channel=await h.command('channel.create',{name:'coding group',memberIds:[m.id]});
 const link=await h.request('/v2/session-links',{action:'create',memberId:m.id,channelId:channel.id,form:'claude-code',executor:'claude'});
 const args=JSON.parse(link.skill.match(/参数 (\{.+?\})。/)[1]);
 const rpc=new MonitorBridge({connectionDir,client,identity,kind:'tools'});
 await assert.rejects(()=>rpc.tool('link_current_conversation',{...args,code:'WRONG'}),/不属于/);
 assert.equal(await rpc.current(),null);await assert.rejects(()=>rpc.tool('list_work'),/尚未加入/);
 await rpc.tool('link_current_conversation',args);assert.equal((await rpc.current()).sessionId,'new-original');
 const notices=[],monitor=new MonitorBridge({connectionDir,client,identity,output:s=>notices.push(s)});await monitor.tick();
 assert.ok(notices.some(n=>n.includes('confirm_current_conversation')));
 const pending=(await client.api('/v2/self/session-links')).items.find(l=>l.id===link.id);
 await rpc.tool('confirm_current_conversation',{id:link.id,challenge:pending.challenge});await monitor.tick();
 assert.equal((await h.request('/v2/native-sessions?memberId='+m.id)).bindings[channel.id].sessionId,'new-original');
 await monitor.close();
});

test('persistent plugin uses official Monitor and ordinary MCP without launcher, model or permission flags',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-plugin-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const pluginDir=path.join(root,'plugin'),connectionDir=path.join(root,'private');
 await writeMonitorPlugin({pluginDir,connectionDir,cli:'/app folder/connector.cjs',node:'/node folder/node'});
 const manifest=JSON.parse(await fs.readFile(path.join(pluginDir,'.claude-plugin/plugin.json'))),mcp=JSON.parse(await fs.readFile(path.join(pluginDir,'.mcp.json')));
 const monitors=JSON.parse(await fs.readFile(path.join(pluginDir,'monitors/monitors.json')));
 const hooks=JSON.parse(await fs.readFile(path.join(pluginDir,'hooks/hooks.json')));
 assert.deepEqual(Object.keys(hooks.hooks),['Stop','StopFailure','SessionEnd']);
 for(const entries of Object.values(hooks.hooks)){assert.match(entries[0].hooks[0].command,/monitor-stop/);assert.equal(entries[0].hooks[0].timeout,8);}
 assert.equal(monitors[0].when,'always');assert.match(monitors[0].command,/'\/node folder\/node'/);
 assert.equal(mcp.mcpServers.hub.args[1],'monitor-mcp');assert.doesNotMatch(JSON.stringify({manifest,mcp}),/dangerously|--resume|--continue|allowedTools|--model/);
 await assert.rejects(()=>writeMonitorPlugin({pluginDir,connectionDir:'/other',cli:'/app/c.cjs'}),/其他连接/);
 const cli=path.join(root,'runtime.cjs');await fs.writeFile(cli,'// first runtime');
 await writeMonitorPlugin({pluginDir,connectionDir,cli});
 const first=await fs.readFile(path.join(pluginDir,'monitors/monitors.json'),'utf8'),mcpFirst=await fs.readFile(path.join(pluginDir,'.mcp.json'),'utf8');
 await fs.writeFile(cli,'// updated runtime');await writeMonitorPlugin({pluginDir,connectionDir,cli});
 assert.notEqual(await fs.readFile(path.join(pluginDir,'monitors/monitors.json'),'utf8'),first);
 assert.notEqual(await fs.readFile(path.join(pluginDir,'.mcp.json'),'utf8'),mcpFirst,'native reloader sees a changed runtime, without changing member credentials');
});

test('unlinked native conversations stay inert; notifications and tool claims never share state files',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-monitor-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await privateJson(path.join(root,'monitor-sessions.json'),{runtimeId:'fixture',sessionIds:['selected']});
 let sessionId='not-selected';const identity=async()=>({sessionId,workspace:'/srv/p',instanceId:'same-native-instance'});
 const monitor=new MonitorBridge({connectionDir:root,identity,client:{},output:()=>{}});
 assert.equal(await monitor.select(),null);await assert.rejects(()=>monitor.tool('list_work'),/尚未加入/);
 sessionId='selected';const a=await monitor.select();const tools=new MonitorBridge({connectionDir:root,identity,client:{},kind:'tools'}),b=await tools.select();
 assert.equal(a.session.instanceId,b.session.instanceId);assert.notEqual(a.stateFile,b.stateFile);
});

test('one-paste installer preserves existing login and account grant and requests only native plugin reload',async t=>{
 const h=await startHarness();t.after(()=>h.stop());await h.request('/admin/action',{type:'platform.create',payload:{id:'claude-code',name:'Claude'}});
 const account=(await h.request('/admin/action',{type:'account.create',payload:{platformId:'claude-code',label:'fixture'}})).result;
 const member=(await h.request('/admin/action',{type:'member.create',payload:{accountId:account.id,name:'fixture',mode:'connector'}})).result;
 const invite=await h.request('/v2/connect/claude',{memberId:member.id});
 const configDir=path.join(h.directory,'native'),base=path.join(h.directory,'connections');
 await privateJson(path.join(configDir,'settings.json'),{fixture:'keep exact'});await privateJson(path.join(configDir,'.credentials.json'),{fixture:'never read'});
 const before=await Promise.all(['settings.json','.credentials.json'].map(f=>fs.readFile(path.join(configDir,f))));
 const script=`process.env.AGENT_HUB_CONNECTOR_IMPORT='1';const {setupMonitor}=await import(${JSON.stringify('file://'+path.resolve('connectors/claude/cli.mjs'))});let s='';for await(const part of process.stdin)s+=part;console.log(JSON.stringify(await setupMonitor(JSON.parse(s),{configDir:process.env.CLAUDE_CONFIG_DIR,cli:'/fixture/connector.cjs',identity:async()=>({sessionId:'original',workspace:'/srv/user-project',title:'用户项目',instanceId:'native'})})));`;
 const setup=async input=>{const p=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,AGENT_HUB_CONNECTOR_TEST:'1',AGENT_HUB_CLAUDE_DIR:base,CLAUDE_CONFIG_DIR:configDir}});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.stdin.end(JSON.stringify(input));assert.equal(await new Promise(r=>p.on('exit',r)),0,err);return JSON.parse(out);};
 const input={endpoint:h.base,memberId:member.id,alias:'original',code:invite.pairingCode},a=await setup(input);
 assert.equal(a.reloadCommand,'/reload-plugins');assert.equal(a.resumeCommand,undefined);assert.doesNotMatch(JSON.stringify(a),/--resume|--channels|access_token/);
 const grantFile=path.join(base,'original/grant.json'),grant=await fs.readFile(grantFile);await setup(input);assert.deepEqual(await fs.readFile(grantFile),grant);
 assert.deepEqual(await Promise.all(['settings.json','.credentials.json'].map(f=>fs.readFile(path.join(configDir,f)))),before);
 const client=new CodingMemberClient(grantFile),state=await client.api('/v2/self/status');assert.equal(state.complete,false);assert.deepEqual(state.connection.setup.ownerAction,{type:'claude_reload',command:'/reload-plugins'});
 const plugins=await fs.readdir(path.join(configDir,'skills'));assert.equal(plugins.length,1);assert.ok(plugins[0].startsWith('duolawork-'));
 const s=JSON.parse(await fs.readFile(path.join(base,'original/linked-sessions/original.json')));assert.equal(s.sessionId,'original');
});
