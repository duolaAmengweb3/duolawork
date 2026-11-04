import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {NativeAgent,safeError,codexAccountSummary} from '../local/native-agent.mjs';
import {CodingMemberClient} from '../local/coding-client.mjs';
import {CodingManager,rememberAccount} from '../local/coding-manager.mjs';
import {privateJson} from '../local/storage.mjs';
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-native-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return await fs.realpath(dir);}
test('account identity uses official metadata and prevents silent login replacement without storing credentials',()=>{
 const a=codexAccountSummary({type:'chatgpt',email:'original@example.test',access_token:'must-not-retain'}),r={engine:'codex'};
 assert.deepEqual(a,{kind:'chatgpt',loggedIn:true,accountLabel:'original@example.test'});rememberAccount(r,a);
 assert.throws(()=>rememberAccount(r,codexAccountSummary({type:'chatgpt',email:'another@example.test'})),/切换账号/);
 assert.throws(()=>rememberAccount(r,codexAccountSummary(null)),/退出登录/);assert.equal(r.accountLabel,'original@example.test');
});
class Rpc extends EventEmitter{
 constructor(){super();this.calls=[];this.sent=[];}
 send(v){this.sent.push(v);}
 async call(method,params){this.calls.push({method,params});if(method==='initialize')return{};if(method==='account/read')return{account:{type:'chatgpt'}};if(method==='thread/start'||method==='thread/resume')return{thread:{id:params.threadId||'thread1'},model:'native-default'};if(method==='turn/start')return{turn:{id:'turn1'}};}
 async stop(){this.closed=true;this.emit('closed',new Error('stopped'));}
}
test('native Codex keeps original provider configuration and exact saved thread; Hub tools execute as the bound member',async()=>{
 const rpc=new Rpc(),seen=[];const agent=new NativeAgent({engine:'codex',command:'/native/codex',cwd:'/work',rpcFactory:()=>rpc,toolCall:async(name,args)=>{seen.push({name,args});return{ok:true};}});
 await agent.initialize();const s=await agent.session({id:'saved-thread',tools:[{name:'list_work',inputSchema:{type:'object'}}]});assert.equal(s.id,'saved-thread');
 for(const c of rpc.calls)for(const key of ['modelProvider','approvalPolicy','sandbox','model'])assert.equal(c.params[key],undefined);
 const run=agent.run({session:s,prompt:'native message'});await new Promise(r=>setImmediate(r));
 await assert.rejects(()=>agent.request('item/tool/call',{threadId:'other',tool:'hub_list_work',arguments:{}}));
 const result=await agent.request('item/tool/call',{threadId:s.id,tool:'hub_list_work',arguments:{}});assert.equal(result.success,true);assert.equal(seen.length,1);
 rpc.emit('notification','turn/completed',{threadId:s.id,turn:{id:'old-turn',status:'completed'}});assert.equal(agent.busy,true);
 rpc.emit('notification','item/completed',{threadId:s.id,turnId:'turn1',item:{type:'agentMessage',text:'native reply'}});
 rpc.emit('notification','turn/completed',{threadId:s.id,turn:{id:'turn1',status:'completed'}});assert.equal((await run).text,'native reply');await agent.stop();
});
test('native turn startup rejection does not leave an unhandled completion or busy session',async()=>{
 const rpc=new Rpc();const call=rpc.call.bind(rpc);rpc.call=(method,params)=>method==='turn/start'?Promise.reject(new Error('provider denied')):call(method,params);
 const agent=new NativeAgent({engine:'codex',command:'/native/codex',rpcFactory:()=>rpc});await agent.initialize();await assert.rejects(()=>agent.run({session:{id:'t'},prompt:'x'}),/provider denied/);assert.equal(agent.busy,false);await agent.stop();
});
test('idle signal polling never starts a model or claims work; failed reads do not create replies',async t=>{
 const dir=await temp(t),file=path.join(dir,'grant.json');await privateJson(file,{memberId:'member_test',endpoint:'https://hub.test',access_token:'private-test'});let starts=0;const routes=[];
 const manager=new CodingManager({config:{},dataDir:dir,request:async url=>{routes.push(url);return{hasWork:false};},agentFactory:()=>{starts++;}});
 manager.records.member_test={memberId:'member_test',engine:'codex',enabled:true,status:'idle',grantFile:file};await manager.tick();assert.equal(starts,0);assert.deepEqual(routes,['https://hub.test/v2/signal']);assert.equal(manager.busy,false);
});
test('crash recovery preserves the exact session and refuses to silently replay unknown execution',async t=>{
 const dir=await temp(t);await privateJson(path.join(dir,'native-coding.json'),{member_test:{memberId:'member_test',engine:'codex',enabled:true,status:'working',sessions:{channel1:'native-session'},inFlight:{stepId:'turn1'}}});
 const manager=new CodingManager({config:{},dataDir:dir,request:async()=>{throw new Error('must not poll');}});await manager.load();assert.equal(manager.records.member_test.sessions.channel1,'native-session');assert.equal(manager.records.member_test.status,'needs_review');await manager.tick();assert.equal(manager.jobs.size,0);
});
test('token refresh is serialized across independent MCP and receiver clients without losing rotated credentials',async t=>{
 const dir=await temp(t),file=path.join(dir,'grant.json');await privateJson(file,{memberId:'member_test',endpoint:'https://hub.test',access_token:'old-test',refresh_token:'refresh-test',client_id:'member-client',expiresAt:1});let refreshes=0;
 const request=async(url,options)=>{if(url.endsWith('/oauth/token')){refreshes++;await new Promise(r=>setTimeout(r,100));return{access_token:'new-test',refresh_token:'rotated-test',expires_in:3600};}assert.equal(options.token,'new-test');return{ok:true};};
 const a=new CodingMemberClient(file,{request}),b=new CodingMemberClient(file,{request});await Promise.all([a.api('/v2/signal'),b.api('/v2/signal')]);assert.equal(refreshes,1);const next=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(next.refresh_token,'rotated-test');assert.equal((await fs.stat(file)).mode&0o777,0o600);
});
test('ACP uses a member-owned profile and leaves global model, auth and permission files alone',async t=>{
 const dir=await temp(t),r={memberId:'member_12345678901234567890',engine:'antigravity',cwd:path.join(dir,'workspace')};await fs.mkdir(r.cwd);let captured;
 const manager=new CodingManager({config:{},dataDir:dir,runtime:{ensure:async()=>({command:'/native/agy_acp_server.par',args:[],harness:'/native/localharness_external'})},agentFactory:options=>{captured=options;return{initialize:async()=>{},stop:async()=>{}};}});
 await manager.prepareNative(r,{tool:async()=>({})});assert.equal(captured.env.GEMINI_HOME,path.join(dir,'coding',r.memberId,'google'));assert.equal(captured.env.AGY_ACP_FORCE_FILE_STORAGE,'1');assert.ok(r.mcpServers[0].args[0].endsWith('/local/coding-mcp.mjs'));assert.equal(r.mcpServers[0].name,'hub_'+r.memberId.slice(-16));
 const settings=JSON.parse(await fs.readFile(path.join(captured.env.GEMINI_HOME,'antigravity-acp/settings.json'),'utf8'));assert.deepEqual(settings,{auth:{type:'oauth-personal'}});assert.equal(captured.env.GEMINI_API_KEY,undefined);assert.equal(captured.extraArgs.includes('--dangerously-skip-permissions'),false);
});
test('one-time native permissions never create session-wide or persistent command approvals',async t=>{
 const manager=new CodingManager({config:{},dataDir:await temp(t)}),record={memberId:'member_test'};
 const promise=manager.approve(record,{engine:'codex',method:'item/commandExecution/requestApproval',params:{command:'ls',cwd:'/work'}});const [pending]=manager.status().approvals;manager.decide({id:pending.id,allow:true});assert.deepEqual(await promise,{decision:'accept'});assert.equal(manager.approvals.size,0);
});
test('secret-shaped errors are redacted before being shown in Hub',()=>{assert.ok(!safeError('Bearer ahv1_secretvalue https://private.test/secret').includes('secretvalue'));});

test('late native tool callback during shutdown cannot write to closed stdin or crash the host',async t=>{
 const dir=await temp(t),script=path.join(dir,'server.mjs');await fs.writeFile(script,"process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:99,method:'owned/tool',params:{}})+'\\n');process.stdin.resume();");
 const {NativeRpc}=await import('../local/native-agent.mjs');const rpc=new NativeRpc({command:process.execPath,args:[script],cwd:dir});let started;const ready=new Promise(r=>started=r);rpc.onRequest=async()=>{started();await new Promise(r=>setTimeout(r,60));return{ok:true};};await ready;await rpc.stop();await new Promise(r=>setTimeout(r,100));assert.equal(rpc.closed,true);assert.equal(rpc.pending.size,0);
});
test('official runtime download fails closed on a wrong hash or oversized payload',async t=>{
 const {downloadVerified}=await import('../local/native-runtime.mjs'),dir=await temp(t);const response=body=>({ok:true,body:(async function*(){yield Buffer.from(body);})()});
 await assert.rejects(()=>downloadVerified({url:'https://dl.google.com/fixture.zip',bytes:3,sha256:'wrong'},path.join(dir,'bad.zip'),{fetchImpl:async()=>response('abc')}),/校验/);
 await assert.rejects(()=>downloadVerified({url:'https://dl.google.com/fixture.zip',bytes:1,sha256:'wrong'},path.join(dir,'large.zip'),{fetchImpl:async()=>response('abc')}),/超过/);
});
test('ACP one-time permission decisions never authorize a different pending session or persist a global rule',async t=>{
 const manager=new CodingManager({config:{},dataDir:await temp(t)}),record={memberId:'member_test'};
 assert.throws(()=>manager.approve(record,{engine:'antigravity',method:'session/request_permission',sessionId:'a',params:{sessionId:'b'}}),/不匹配/);
 const p=manager.approve(record,{engine:'antigravity',method:'session/request_permission',sessionId:'s',params:{sessionId:'s',toolCall:{title:'write test file'},options:[{kind:'allow_once',optionId:'once'},{kind:'allow_always',optionId:'always'},{kind:'reject_once',optionId:'no'}]}});const [approval]=manager.status().approvals;manager.decide({id:approval.id,allow:true});assert.deepEqual(await p,{outcome:{outcome:'selected',optionId:'once'}});
});
test('connection consent covers only this members real MCP tool metadata, never shell titles or another server',async t=>{
 const manager=new CodingManager({config:{},dataDir:await temp(t)}),r={memberId:'member_12345678901234567890',hubToolsAuthorized:true};manager.hubToolNames.set(r.memberId,new Set(['list_work']));
 const request={engine:'antigravity',method:'session/request_permission',sessionId:'s',params:{sessionId:'s',toolCall:{title:'list work',_meta:{is_mcp_tool_call:true,mcp:{server:'hub_'+r.memberId.slice(-16),tool:'list_work'}}},options:[{kind:'allow_once',optionId:'once'}]}};
 assert.deepEqual(await manager.approve(r,request),{outcome:{outcome:'selected',optionId:'once'}});assert.equal(manager.approvals.size,0);
 request.params.toolCall._meta.mcp.server='another-server';const pending=manager.approve(r,request);await new Promise(r=>setImmediate(r));assert.equal(manager.approvals.size,1);const [item]=manager.status().approvals;manager.decide({id:item.id,allow:false});await pending;
 request.params.toolCall={title:'hub_'+r.memberId.slice(-16)+'_list_work',kind:'execute',rawInput:{CommandLine:'arbitrary shell command'}};const shell=manager.approve(r,request);await new Promise(r=>setImmediate(r));assert.equal(manager.approvals.size,1);manager.decide({id:manager.status().approvals[0].id,allow:false});await shell;
});
test('only immutable schemas for this exact session and server qualify as internal metadata reads',async t=>{
 const dir=await temp(t),r={memberId:'member_12345678901234567890',cwd:path.join(dir,'workspace')},manager=new CodingManager({config:{},dataDir:dir}),sid='native-session-1';manager.hubToolNames.set(r.memberId,new Set(['list_work']));const root=path.join(dir,'coding',r.memberId,'google/antigravity-acp/brain',sid,'mcp','hub_'+r.memberId.slice(-16));await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'list_work.json'),'{}');
 const req=command=>({kind:'execute',rawInput:{CommandLine:command,Cwd:r.cwd}});
 assert.equal(await manager.metadataReadAllowed(r,sid,req('cat '+root+'/list_work.json')),true);
 assert.equal(await manager.metadataReadAllowed(r,sid,req('cat '+root+'/grant.json')),false);
 assert.equal(await manager.metadataReadAllowed(r,sid,req('cat '+root+'/list_work.json; touch /tmp/side-effect')),false);
 assert.equal(await manager.metadataReadAllowed(r,sid,req('cat '+root+'/list_work.json > /tmp/side-effect')),false);
 await fs.unlink(path.join(root,'list_work.json'));await fs.symlink('/etc/hosts',path.join(root,'list_work.json'));assert.equal(await manager.metadataReadAllowed(r,sid,req('cat '+root+'/list_work.json')),false);
});
test('explicit full access is session-scoped in native Codex and remains unchanged across resume',async()=>{
 const rpc=new Rpc(),agent=new NativeAgent({engine:'codex',command:'/native/codex',permissionMode:'full',rpcFactory:()=>rpc});await agent.initialize();await agent.session({id:'hub-thread'});const resume=rpc.calls.find(c=>c.method==='thread/resume');assert.equal(resume.params.approvalPolicy,'never');assert.equal(resume.params.sandbox,'danger-full-access');assert.equal(resume.params.model,undefined);assert.equal(resume.params.modelProvider,undefined);await agent.stop();
});
test('full-access members do not create per-tool UI prompts; optional ask mode still does',async t=>{
 const m=new CodingManager({config:{},dataDir:await temp(t)}),r={memberId:'member_full',permissionMode:'full'};
 assert.deepEqual(await m.approve(r,{engine:'codex',method:'item/commandExecution/requestApproval',params:{command:'native task'}}),{decision:'accept'});
 assert.deepEqual(await m.approve(r,{engine:'antigravity',method:'session/request_permission',sessionId:'s',params:{sessionId:'s',options:[{kind:'allow_once',optionId:'once'}],toolCall:{kind:'execute'}}}),{outcome:{outcome:'selected',optionId:'once'}});assert.equal(m.approvals.size,0);
 r.permissionMode='ask';const p=m.approve(r,{engine:'codex',method:'item/commandExecution/requestApproval',params:{command:'native task'}});assert.equal(m.approvals.size,1);m.decide({id:m.status().approvals[0].id,allow:false});await p;
});
