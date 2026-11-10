import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand} from '../cloud/collaboration/conversation.mjs';
import {channelResources} from '../cloud/collaboration/channel-resources.mjs';
import {mcpConnectorTool} from '../cloud/collaboration/mcp-connectors.mjs';
import {connectorTool} from '../cloud/collaboration/connectors.mjs';
import {skillCatalog,skillTool,skillSettings} from '../cloud/collaboration/skills.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';
import {connectorHostRequest} from '../cloud/collaboration/connector-hosts.mjs';
import {digest} from '../cloud/collaboration/repository.mjs';
const owner={owner:true},actor={memberId:'grok'};
async function setup(t){
 const f=await fixture(t);let n=0,writes=0,onCall=async()=>{};
 const command=(type,args)=>conversationCommand(f.repo,f.identity,owner,{requestId:'space-'+(++n),type,...args});
 const a=await command('channel.create',{name:'项目A',memberIds:['grok'],coordinatorId:'grok'}),b=await command('channel.create',{name:'项目B',memberIds:['grok'],coordinatorId:'grok'});
 const env={ADMIN_KEY:'isolated-test-key',CONNECTOR_FETCH:async(url,init={})=>{if(init.method==='GET')return new Response(null,{status:405});const m=JSON.parse(init.body||'{}');if(m.method?.startsWith('notifications/'))return new Response(null,{status:202});let result;if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(m.method==='tools/call'){writes++;await onCall();result={content:[{type:'text',text:'actual-fixture-result'}]};}return new Response(JSON.stringify({jsonrpc:'2.0',id:m.id,result}),{headers:{'content-type':'application/json'}});}};
 await f.repo.transact('seed-space-services',{},tx=>{for(const id of ['account-a','account-b'])tx.put('service_connection',{id,provider:'github-mcp',serviceType:'mcp',name:'GitHub',account:id,transport:'http',url:'https://fixture.invalid/mcp',authType:'none',credentials:null,status:'connected',health:'ready',version:1,tools:[{name:'write',inputSchema:{type:'object'}}]});tx.put('service_connection',{id:'private-account',provider:'feishu',name:'Private title',account:'private-identity',serviceType:'mcp',channelIds:[b.id],status:'connected',version:1});tx.put('service_connection',{id:'legacy',provider:'github',account:'legacy-account',status:'connected',version:1,repositories:['org/repo'],credentials:'not-returned-in-group-list'});});
 const skill=await skillSettings(f.repo,f.identity,owner,{action:'save',requestId:'space-skill',files:{'SKILL.md':'---\nname: source-check\ndescription: 核对资料引用\n---\n使用原始来源。'}},env);
 const list=(channelId=a.id,who=owner)=>channelResources(f.repo,who,{channelId,action:'list'});
 const change=async(args,channelId=a.id,who=owner)=>{const current=await list(channelId,who);return channelResources(f.repo,who,{requestId:'resource-'+(++n),channelId,expectedVersion:current.version,...args});};
 return {...f,a,b,env,skill,command,list,change,get writes(){return writes;},onCall:fn=>onCall=fn};
}
test('group resources default open, expose only safe metadata and respect existing private scopes',async t=>{
 const f=await setup(t),group=await f.list();assert.equal(group.connections.find(c=>c.id==='account-a').enabled,true);assert.equal(group.connections.find(c=>c.id==='private-account').globalAllowed,false);
 assert.equal(JSON.stringify(group).includes('not-returned-in-group-list'),false);const agent=await f.list(f.a.id,actor);assert.ok(!agent.connections.some(c=>c.id==='private-account'));assert.equal(JSON.stringify(agent).includes('private-identity'),false);
 await assert.rejects(f.change({action:'connection',connectionId:'private-account',enabled:true}),e=>e.code==='resource_unavailable');
 await assert.rejects(f.list(f.a.id,{memberId:'check'}),e=>e.code==='forbidden');
});
test('hosted tools respect group switches before claiming and before delivering a real result',async t=>{
 const f=await setup(t),token='isolated-host-credential',tokenHash=await digest(token);
 await f.repo.transact('host-setup',{},async tx=>{tx.put('service_host',{id:'host',status:'connected',tokenHash});const c=await tx.get('service_connection','account-a');tx.put('service_connection',{...c,hostId:'host'});for(const [id,channelId]of [['blocked-job',f.a.id],['allowed-job',f.b.id]])tx.put('service_job',{id,parentId:'host',scopeId:c.id,status:'pending',channelId,memberId:'grok',connectionVersion:1,createdAt:tx.now});});
 await f.change({action:'connection',connectionId:'account-a',enabled:false});
 const polled=await connectorHostRequest(f.repo,f.identity,{action:'poll',hostId:'host',batch:true},token,f.env);assert.deepEqual(polled.jobs.map(j=>j.id),['allowed-job']);assert.equal((await f.repo.get('service_job','blocked-job')).code,'connection_changed');
 await f.change({action:'connection',connectionId:'account-a',enabled:false},f.b.id);
 const result=await connectorHostRequest(f.repo,f.identity,{action:'complete',hostId:'host',jobId:'allowed-job',lease:polled.jobs[0].lease,result:{content:[{type:'text',text:'external-result-after-revocation'}]}},token,f.env);assert.equal(result.status,'failed');assert.equal((await f.repo.get('service_job','allowed-job')).code,'outcome_unknown');assert.equal(JSON.stringify(await f.repo.get('service_job','allowed-job')).includes('external-result-after-revocation'),false);
});
test('group switches enforce real MCP and legacy entry access while other groups and global revisions remain intact',async t=>{
 const f=await setup(t);await f.change({action:'connection',connectionId:'account-a',enabled:false});
 assert.ok(!(await mcpConnectorTool(f.repo,actor,{channelId:f.a.id,action:'connections'},f.env)).items.some(c=>c.id==='account-a'));
 await assert.rejects(mcpConnectorTool(f.repo,actor,{channelId:f.a.id,action:'tools',connectionId:'account-a'},f.env),e=>e.code==='forbidden');
 assert.equal((await mcpConnectorTool(f.repo,actor,{channelId:f.b.id,action:'tools',connectionId:'account-a'},f.env)).tools.length,1);
 await f.change({action:'connection',connectionId:'legacy',enabled:false});assert.equal((await connectorTool(f.repo,actor,{channelId:f.a.id,action:'connections'},f.env)).items.length,0);
 assert.equal((await connectorTool(f.repo,actor,{channelId:f.b.id,action:'connections'},f.env)).items.length,1);
 assert.equal((await f.repo.get('service_connection','account-a')).version,1);await f.change({action:'connection',connectionId:'account-a',enabled:true});assert.ok((await f.list()).connections.find(c=>c.id==='account-a').enabled);
});
test('default account selects real calls without excluding other explicitly selected accounts',async t=>{
 const f=await setup(t);await f.change({action:'default_account',provider:'github-mcp',connectionId:'account-b'});
 const catalog=await mcpConnectorTool(f.repo,actor,{channelId:f.a.id,action:'connections'},f.env);assert.equal(catalog.items.find(c=>c.preferred).id,'account-b');
 assert.equal((await mcpConnectorTool(f.repo,actor,{channelId:f.a.id,action:'tools',provider:'github-mcp'},f.env)).connection.id,'account-b');
 const result=await mcpConnectorTool(f.repo,actor,{channelId:f.a.id,action:'call',provider:'github-mcp',tool:'write',requestId:'default-real-call'},f.env);assert.equal(result.status,'succeeded');assert.equal((await f.repo.get('service_invocation',result.invocationId)).scopeId,'account-b');
 assert.equal((await mcpConnectorTool(f.repo,actor,{channelId:f.a.id,action:'tools',connectionId:'account-a'},f.env)).connection.id,'account-a');
 await f.change({action:'connection',connectionId:'account-b',enabled:false});await assert.rejects(mcpConnectorTool(f.repo,actor,{channelId:f.a.id,action:'tools',provider:'github-mcp'},f.env),e=>e.code==='forbidden');
});
test('skill group switch preserves content versions and cached authenticated tools cannot bypass it',async t=>{
 const f=await setup(t);await f.change({action:'skill',skillId:f.skill.id,enabled:false});assert.ok(!(await skillCatalog(f.repo,actor,f.a.id)).some(s=>s.id===f.skill.id));
 await assert.rejects(skillTool(f.repo,actor,'read_skill',{channelId:f.a.id,skillId:f.skill.id,version:1}),e=>e.code==='forbidden');
 const read=await skillTool(f.repo,actor,'read_skill',{channelId:f.b.id,skillId:f.skill.id,version:1});assert.match(read.body,/原始来源/);assert.equal((await f.repo.get('workspace_skill',f.skill.id)).version,1);
 const envelope={requestId:'cached-group-resource',channelId:f.a.id,body:'HUB_SHARED_TOOL_V1\n'+JSON.stringify({name:'channel_resources',arguments:{channelId:f.a.id,action:'list'}})};
 const old=await callTool(f.repo,f.identity,actor,'post_message',envelope,{});assert.equal(old.skills.find(s=>s.id===f.skill.id).enabled,false);assert.equal((await f.repo.list('channel_message',{scope:f.a.id})).length,0);
});
test('resource preferences keep folder scope and reject conflicting updates without touching credentials',async t=>{
 const f=await setup(t),folder=await f.command('channel.folder',{channelId:f.a.id,action:'create',title:'白皮书'}),other=await f.command('channel.folder',{channelId:f.b.id,action:'create',title:'其他资料'});
 await f.change({action:'folder',folderId:folder.id});assert.equal((await f.list()).defaultFolderId,folder.id);
 await assert.rejects(f.change({action:'folder',folderId:other.id}),e=>e.code==='invalid_folder');
 await assert.rejects(channelResources(f.repo,owner,{channelId:f.a.id,action:'folder',folderId:null,requestId:'stale-preference',expectedVersion:0}),e=>e.code==='version_conflict');
 assert.equal((await f.repo.get('service_connection','legacy')).credentials,'not-returned-in-group-list');
});
test('closing group access during a real external call suppresses its result without replaying the side effect',async t=>{
 const f=await setup(t);f.onCall(()=>f.change({action:'connection',connectionId:'account-a',enabled:false}));
 const args={channelId:f.a.id,action:'call',connectionId:'account-a',tool:'write',requestId:'close-during-call'},result=await mcpConnectorTool(f.repo,actor,args,f.env);
 assert.equal(result.status,'unknown');assert.equal(result.result,undefined);assert.equal(f.writes,1);await assert.rejects(mcpConnectorTool(f.repo,actor,args,f.env),e=>e.code==='forbidden');assert.equal(f.writes,1);
});
