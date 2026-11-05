import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {startHarness} from './v1-harness.mjs';
import {CodingMemberClient} from '../local/coding-client.mjs';
import {privateJson} from '../local/storage.mjs';
import {ClaudeChannel} from '../connectors/claude/channel.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {z} from 'zod';

test('remote Claude pairing, two native sessions, routing, persistence, disconnect and bundled MCP Channel protocol',async t=>{
 const h=await startHarness();t.after(()=>h.stop());
 await h.request('/admin/action',{type:'platform.create',payload:{id:'claude-code',name:'Claude Code'}});
 const account=(await h.request('/admin/action',{type:'account.create',payload:{platformId:'claude-code',label:'fixture VPS'}})).result;
 const member=(await h.request('/admin/action',{type:'member.create',payload:{accountId:account.id,name:'Claude VPS',mode:'connector'}})).result;
 const setup=await h.request('/v2/connect/claude',{memberId:member.id});assert.match(setup.install,/--compressed/);assert.match(setup.install,/createHash/);assert.ok(setup.skill.includes(setup.pairingCode));
 const recipe=await (await fetch(h.base+'/v2/connectors/claude/guide')).json();assert.equal(recipe.protocol,'agent-hub-claude/2');assert.match(recipe.setup.command,/setup$/);
 const download=await fetch(h.base+'/v2/connectors/claude/download?version='+setup.sha256);assert.equal(download.status,200);const bundle=Buffer.from(await download.arrayBuffer());assert.equal(createHash('sha256').update(bundle).digest('hex'),setup.sha256);
 const file=path.join(h.directory,'connector.cjs');await fs.writeFile(file,bundle);
 const nativeHome=path.join(h.directory,'remote-data');const env={...process.env,AGENT_HUB_CONNECTOR_TEST:'1',AGENT_HUB_CLAUDE_DIR:nativeHome};
 const {spawn}=await import('node:child_process');
 const install=async(input)=>{const pair=spawn(process.execPath,[file,'setup'],{env,stdio:['pipe','pipe','pipe']});pair.stdin.end(JSON.stringify(input));let output='';pair.stdout.on('data',d=>output+=d);pair.stderr.on('data',d=>output+=d);return{code:await new Promise(r=>pair.on('exit',r)),output};};
 const input={endpoint:h.base,alias:'claude1',memberId:member.id,code:setup.pairingCode,sessionId:'original-native-session'},first=await install(input);assert.equal(first.code,0,first.output);assert.doesNotMatch(first.output,/access_token|refresh_token|ahv1_/);const prepared=JSON.parse(first.output);assert.equal(prepared.stage,'waiting_owner');assert.ok(prepared.resumeCommand.includes('original-native-session'));
 const before=await fs.readFile(path.join(nativeHome,'claude1/grant.json'));const retry=await install(input);assert.equal(retry.code,0,retry.output);assert.deepEqual(await fs.readFile(path.join(nativeHome,'claude1/grant.json')),before,'A repeated one-paste instruction preserves the account grant');
 const conflict=await install({...input,memberId:'member_another'});assert.equal(conflict.code,1);assert.deepEqual(await fs.readFile(path.join(nativeHome,'claude1/grant.json')),before);
 const grantFile=path.join(nativeHome,'claude1/grant.json'),client=new CodingMemberClient(grantFile),grant=await client.credentials();assert.equal((await fs.stat(grantFile)).mode&0o777,0o600);
 assert.equal((await client.api('/v2/self/status')).connection.setup.stage,'waiting_owner');
 const one={sessionId:randomUUID(),instanceId:randomUUID(),runtimeId:'vps-fixture',title:'网站开发',workspace:'/srv/website'},two={...one,sessionId:randomUUID(),instanceId:randomUUID(),title:'App 开发',workspace:'/srv/app'};
 const register=s=>client.api('/v2/self/native-sessions',{method:'POST',body:s});await register(one);await register(two);
 assert.equal((await client.api('/v2/self/status')).complete,false,'Metadata does not verify native Claude');
 await assert.rejects(()=>register({...one,instanceId:randomUUID()}),/已有连接器/);
 const a=await h.command('channel.create',{name:'网站群',memberIds:[member.id]}),b=await h.command('channel.create',{name:'App群',memberIds:[member.id]});
 const assign=(channelId,sessionId)=>h.request('/v2/native-sessions',{requestId:randomUUID(),memberId:member.id,channelId,sessionId,mode:'existing'});
 await assign(a.id,one.sessionId);await assign(b.id,two.sessionId);
 let notices=0;const bridge=new ClaudeChannel({client,session:one,stateFile:path.join(h.directory,'one.json'),notify:async()=>{notices++;}});await bridge.load();
 await client.api('/v2/self/check',{method:'POST',body:{requestId:'fixture-probe'}});
 await bridge.tick();await bridge.tick();assert.equal(notices,1);
 const probe=(await bridge.tool('list_work',{})).work[0];assert.ok(probe);
 const claim=await bridge.tool('claim_work',{requestId:randomUUID(),stepId:probe.stepId});await bridge.tool('submit_work',{requestId:randomUUID(),attemptId:claim.attemptId,lease:claim.lease,items:[{title:'fixture only',body:claim.input.instruction.match(/proof_[a-z0-9]+/)[0]}]});
 await h.command('channel.post',{channelId:a.id,body:'website question'});await h.command('channel.post',{channelId:b.id,body:'app question'});
 const work=await bridge.work();assert.equal(work.length,1);assert.equal(work[0].channelId,a.id);
 const other=new ClaudeChannel({client,session:two,stateFile:path.join(h.directory,'two.json'),notify:async()=>{}});await other.load();const foreign=(await other.work())[0];assert.equal(foreign.channelId,b.id);
 await assert.rejects(()=>bridge.tool('claim_work',{requestId:randomUUID(),stepId:foreign.stepId}),/未分配/);
 const c=await bridge.tool('claim_work',{requestId:randomUUID(),stepId:work[0].stepId});await assert.rejects(()=>assign(a.id,two.sessionId),/正在处理/);
 await bridge.tool('post_message',{requestId:randomUUID(),channelId:a.id,turnId:c.turnId,body:'website fixture result'});
 // Launch the actual distributed bundle as an MCP subprocess; Claude itself is
 // replaced only at the standard protocol boundary, no model/subscription used.
 await register({...two,status:'offline'});
 const runFile=path.join(h.directory,'run.json');await privateJson(runFile,{...two,instanceId:randomUUID()});
 const sdk=new Client({name:'native-protocol-fixture',version:'1.0.0'}),transport=new StdioClientTransport({command:process.execPath,args:[file,'serve',grantFile,runFile,path.join(h.directory,'mcp-state')],env,stderr:'pipe'});t.after(()=>sdk.close());
 let notification; sdk.setNotificationHandler(z.object({method:z.literal('notifications/claude/channel'),params:z.any()}),n=>{notification=n;});await sdk.connect(transport);
 const until=Date.now()+15000;while(!notification&&Date.now()<until)await new Promise(r=>setTimeout(r,100));assert.ok(notification,'Official channel event emitted');assert.equal(notification.params.meta.session_id,two.sessionId);
 const call=async(name,args={})=>{const r=await sdk.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
 const listing=await sdk.listTools();assert.ok(listing.tools.some(x=>x.name==='post_message'));assert.ok(!listing.tools.some(x=>/shell|terminal|exec|receive_messages/.test(x.name)));
 assert.ok(listing.tools.some(x=>x.name==='link_current_conversation'));assert.ok(listing.tools.some(x=>x.name==='confirm_current_conversation'));
 const cc=await call('claim_work',{requestId:randomUUID(),stepId:foreign.stepId});await call('post_message',{requestId:randomUUID(),channelId:b.id,turnId:cc.turnId,body:'App protocol fixture'});
 await sdk.close();const records=await h.request('/v2/native-sessions?memberId='+member.id);assert.equal(records.bindings[b.id].sessionId,two.sessionId);
 await h.request('/admin/action',{type:'member.disconnect',memberId:member.id});
 await assert.rejects(()=>client.api('/v2/self/native-sessions'));
});

test('Claude current-conversation code uses the registered native channel, survives restart and rejects stale replacement',async t=>{
 const h=await startHarness();t.after(()=>h.stop());await h.request('/admin/action',{type:'platform.create',payload:{id:'claude-code',name:'Claude Code'}});
 const m=await h.member('claude-code','Claude original'),channel=await h.command('channel.create',{name:'code selection',memberIds:[m.id]});
 const one={sessionId:randomUUID(),instanceId:randomUUID(),runtimeId:'original-server',title:'原项目对话',workspace:'/srv/project'},two={...one,sessionId:randomUUID(),instanceId:randomUUID(),title:'另一段对话'};
 const client={api:(route,options)=>h.request(route,options?.body,m.token)};
 for(const s of [one,two])await client.api('/v2/self/native-sessions',{body:s});
 const create=()=>h.request('/v2/session-links',{action:'create',memberId:m.id,channelId:channel.id,form:'claude-code'});
 const parse=l=>JSON.parse(l.skill.match(/参数 (\{.+?\})。/)[1]);
 let notifications=[];const stateFile=path.join(h.directory,'claude-link.json'),bridge=new ClaudeChannel({client,session:one,stateFile,notify:async n=>notifications.push(n)});await bridge.load();
 const link=await create();await bridge.tool('link_current_conversation',parse(link));await bridge.linkTick();await bridge.linkTick();assert.equal(notifications.length,1);
 assert.equal((await h.request('/v2/native-sessions?memberId='+m.id)).bindings[channel.id],undefined);
 const pending=(await client.api('/v2/self/session-links')).items.find(l=>l.id===link.id);
 const other=new ClaudeChannel({client,session:two,stateFile:path.join(h.directory,'other.json'),notify:async()=>{}});await other.load();
 await assert.rejects(()=>other.tool('confirm_current_conversation',{id:link.id,challenge:pending.challenge}),/不是这段/);
 await bridge.tool('confirm_current_conversation',{id:link.id,challenge:pending.challenge});
 const restarted=new ClaudeChannel({client,session:one,stateFile,notify:async n=>notifications.push(n)});await restarted.load();await restarted.linkTick();
 assert.equal((await h.request('/v2/session-links?id='+link.id)).status,'completed');assert.equal((await h.request('/v2/native-sessions?memberId='+m.id)).bindings[channel.id].sessionId,one.sessionId);
 const stale=await create();await restarted.tool('link_current_conversation',parse(stale));const p=(await client.api('/v2/self/session-links')).items.find(l=>l.id===stale.id);
 await restarted.tool('confirm_current_conversation',{id:stale.id,challenge:p.challenge});
 await h.request('/v2/native-sessions',{requestId:randomUUID(),memberId:m.id,channelId:channel.id,sessionId:two.sessionId,mode:'existing'});await restarted.linkTick();
 assert.equal((await h.request('/v2/session-links?id='+stale.id)).status,'failed');assert.equal((await h.request('/v2/native-sessions?memberId='+m.id)).bindings[channel.id].sessionId,two.sessionId);
});

test('launcher adds per-launch plugin/MCP only and preserves official resume argument and metadata boundary',async t=>{
 process.env.AGENT_HUB_CONNECTOR_IMPORT='1';const {prepareLaunch,hook}=await import('../connectors/claude/cli.mjs');
 const root=await fs.mkdtemp('/tmp/hub-claude-launch-');t.after(()=>fs.rm(root,{recursive:true,force:true}));
 // CLI is tested in a separate process with an isolated home; no user's Claude
 // installation or login is queried by this test.
 const script=path.resolve('connectors/claude/cli.mjs');
 const code=`process.env.AGENT_HUB_CONNECTOR_IMPORT='1';const {prepareLaunch}=await import(${JSON.stringify('file://'+script)});console.log(JSON.stringify(await prepareLaunch({alias:'test',cwd:'/srv/user-project'})));`;
 await privateJson(path.join(root,'test/grant.json'),{memberId:'fixture'});
 const value=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,AGENT_HUB_CLAUDE_DIR:root},encoding:'utf8'}));assert.ok(value.args.includes('--plugin-dir'));assert.ok(!value.args.some(x=>/api.key|model|setting-sources|dangerously-skip-permissions/.test(x)));
 const runFile=path.join(value.runDir,'session.json');await hook(runFile,{session_id:'native-123',cwd:'/srv/user-project',session_title:'原项目',transcript_path:'/never-read',model:'never-copy'});const metadata=JSON.parse(await fs.readFile(runFile));assert.equal(metadata.sessionId,'native-123');assert.ok(!('model' in metadata));assert.ok(!('transcript_path' in metadata));
});
