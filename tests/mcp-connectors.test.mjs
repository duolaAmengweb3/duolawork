import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand} from '../cloud/collaboration/conversation.mjs';
import {mcpConnectorSettings,mcpConnectorTool} from '../cloud/collaboration/mcp-connectors.mjs';
import {connectorHostRequest} from '../cloud/collaboration/connector-hosts.mjs';
import {importConnectorConfig,CONNECTOR_CATALOG} from '../shared/connector-catalog.mjs';
import {publicMcpURL,openRemoteMcp,mcpTools} from '../shared/mcp-client.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';
import {unseal} from '../cloud/collaboration/security.mjs';
import {oauthProvider,finishConnectorOAuth} from '../cloud/collaboration/connector-oauth.mjs';
import {McpToolHost} from '../local/mcp-tool-host.mjs';
import {publicAddress} from '../server/connector-fetch.mjs';
const owner={owner:true},agent={memberId:'grok'},peer={memberId:'check'};
function remoteFixture(){
 let writes=0,failAfterWrite=false,onCall=async()=>{};
 const fetcher=async(url,init={})=>{
  if(init.method==='GET')return new Response(null,{status:405});
  const m=JSON.parse(init.body||'{}');
  if(m.method?.startsWith('notifications/'))return new Response(null,{status:202});
  let result;
  if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'test-service',version:'1'}};
  if(m.method==='tools/list')result={tools:[{name:'write',description:'test action',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]};
  if(m.method==='tools/call'){writes++;await onCall();if(failAfterWrite)throw new TypeError('credential-secret must never be logged');result={content:[{type:'text',text:m.params.arguments.text||'done'}]};}
  return new Response(JSON.stringify({jsonrpc:'2.0',id:m.id,result}),{headers:{'content-type':'application/json'}});
 };
 return {fetcher,get writes(){return writes;},fail(){failAfterWrite=true;},setOnCall(fn){onCall=fn;}};
}
async function setup(t){
 const f=await fixture(t),service=remoteFixture();
 const send=args=>conversationCommand(f.repo,f.identity,owner,{type:'channel.create',requestId:crypto.randomUUID(),...args});
 const c=await send({name:'MCP shared',memberIds:['grok','check'],coordinatorId:'grok'});
 const env={ADMIN_KEY:'isolated-connector-key',CONNECTOR_ORIGIN:'https://hub.test',CONNECTOR_FETCH:service.fetcher};
 const settings=args=>mcpConnectorSettings(f.repo,f.identity,owner,{requestId:crypto.randomUUID(),...args},env);
 const tool=(args,actor=agent)=>mcpConnectorTool(f.repo,actor,{channelId:c.id,...args},env);
 const save=async args=>(await settings({action:'save',name:'Shared service',provider:'custom',transport:'http',url:'https://tools.test/mcp',authType:'none',...args})).connection;
 return {...f,c,env,send,settings,tool,save,service};
}
test('one remote MCP supports all members, new groups, multiple accounts and post-hoc exclusions',async t=>{
 const f=await setup(t),c=await f.save(),other=await f.save({name:'second account'});
 assert.notEqual(c.id,other.id);assert.equal(c.tools.length,1);assert.equal(c.health,'ready');assert.equal(c.credentials,undefined);
 const another=await f.send({name:'new group',memberIds:['grok','check']});
 assert.equal((await f.tool({action:'connections'},peer)).items.length,2);
 assert.equal((await f.tool({action:'connections',channelId:another.id})).items.length,2);
 const changed=await f.settings({action:'access',connectionId:c.id,expectedVersion:c.version,blockedMemberIds:['check'],blockedChannelIds:[another.id]});
 assert.equal((await f.tool({action:'connections'},peer)).items.length,1);
 await assert.rejects(f.tool({action:'tools',connectionId:c.id},peer),e=>e.code==='forbidden');
 await assert.rejects(f.tool({action:'tools',connectionId:c.id,channelId:another.id}),e=>e.code==='forbidden');
 await f.settings({action:'access',connectionId:c.id,expectedVersion:changed.version,blockedMemberIds:[],blockedChannelIds:[]});
 assert.equal((await f.tool({action:'tools',connectionId:c.id},peer)).tools[0].name,'write');
});
test('simultaneous duplicate writes execute once; uncertain writes never replay and expose no raw errors',async t=>{
 const f=await setup(t),c=await f.save(),args={action:'call',connectionId:c.id,requestId:'write-1',tool:'write',arguments:{text:'hello'}};
 const result=await Promise.all([f.tool(args),f.tool(args)]);
 assert.equal(f.service.writes,1);assert.ok(result.some(r=>r.status==='succeeded'));
 assert.equal((await f.tool(args)).result.content[0].text,'hello');assert.equal(f.service.writes,1);
 await assert.rejects(f.tool({...args,arguments:{text:'different'}}),e=>e.code==='idempotency_conflict');
 f.service.fail();const unknown=await f.tool({...args,requestId:'write-2'});assert.equal(unknown.status,'unknown');
 assert.equal((await f.tool({...args,requestId:'write-2'})).status,'unknown');assert.equal(f.service.writes,2);
 assert.equal(JSON.stringify(await f.repo.list('connector_activity')).includes('credential-secret'),false);
});
test('revocation during an external call suppresses its data and stale versions cannot change scope',async t=>{
 const f=await setup(t),c=await f.save();
 f.service.setOnCall(()=>f.settings({action:'access',connectionId:c.id,expectedVersion:c.version,blockedMemberIds:['grok']}));
 const r=await f.tool({action:'call',connectionId:c.id,requestId:'revoke',tool:'write',arguments:{text:'secret result'}});
 assert.equal(r.result,undefined);assert.equal(r.status,'unknown');
 await assert.rejects(f.settings({action:'access',connectionId:c.id,expectedVersion:c.version}),e=>e.code==='version_conflict');
});
test('standard configuration import keeps multiple servers; old tool catalogs can use the common bridge',async t=>{
 const f=await setup(t),c=await f.save();
 const config={mcpServers:{a:{url:'https://a.test/mcp'},b:{command:'node',args:['tool.js'],env:{API_KEY:'private'}},off:{disabled:true}}};
 const imported=importConnectorConfig(config);assert.equal(imported.length,2);assert.equal(imported[1].env.API_KEY,'private');
 const r=await callTool(f.repo,f.identity,agent,'post_message',{channelId:f.c.id,requestId:'compat',body:'HUB_SHARED_TOOL_V1\n'+JSON.stringify({name:'connector',arguments:{channelId:f.c.id,action:'tools',connectionId:c.id}})},f.env);
 assert.equal(r.tools[0].name,'write');assert.equal((await f.repo.list('channel_message')).length,0);
 assert.ok(CONNECTOR_CATALOG.some(p=>p.id==='cloudflare'));assert.ok(CONNECTOR_CATALOG.some(p=>p.id==='vercel'));
 for(const url of ['http://public.test/mcp','https://localhost/mcp','https://127.0.0.1/mcp','https://[::1]/mcp','https://user:password@public.test/mcp'])assert.throws(()=>publicMcpURL(url));
 for(const ip of ['127.0.0.1','10.1.2.3','172.16.1.1','192.168.1.1','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1'])assert.equal(publicAddress(ip),false);
 assert.equal(publicAddress('1.1.1.1'),true);
});
test('tool host pairing is one-use; a real stdio subprocess serves members without exposing config',async t=>{
 const f=await setup(t),created=await f.settings({action:'host.create',name:'isolated tool host'});
 const paired=await connectorHostRequest(f.repo,f.identity,{action:'pair',...created,environment:{hostname:'test'}},null,f.env);
 await assert.rejects(connectorHostRequest(f.repo,f.identity,{action:'pair',...created},null,f.env),e=>e.code==='pairing_expired');
 await assert.rejects(connectorHostRequest(f.repo,f.identity,{action:'poll',hostId:paired.hostId},'wrong',f.env),e=>e.code==='unauthorized');
 const host=new McpToolHost({...paired,endpoint:'https://hub.test'});
 host.request=args=>connectorHostRequest(f.repo,f.identity,{hostId:paired.hostId,...args},paired.token,f.env);
 await host.tick();const task=host.start();t.after(async()=>{await host.stop();await task;});
 const c=(await f.settings({action:'save',name:'stdio fixture',transport:'stdio',hostId:paired.hostId,command:process.execPath,args:[new URL('./fixtures/mcp-stdio.mjs',import.meta.url).pathname],env:{TEST_MCP_SECRET:'never-publish'}})).connection;
 assert.equal(c.health,'ready');assert.equal(c.credentials,undefined);assert.equal(c.tools[0].name,'write');
 const r=await f.tool({action:'call',connectionId:c.id,requestId:'host-call',tool:'write',arguments:{text:'from real child'}},peer);
 assert.equal(r.status,'succeeded');assert.equal(r.result.content[0].text,'from real child');
 const hosts=await f.settings({action:'hosts'});assert.equal(hosts.items[0].tokenHash,undefined);
 assert.equal(JSON.stringify(await f.settings({action:'hosts'})).includes(paired.token),false);
});
test('OAuth registration and PKCE state persist encrypted and callback replay is rejected',async t=>{
 const f=await setup(t),c=await f.save({authType:'none'});
 const ctx=await oauthProvider(f.repo,c,f.env,{begin:true});
 await ctx.provider.saveCodeVerifier('private-verifier');await ctx.provider.saveTokens({access_token:'private-access',token_type:'Bearer'});
 const record=await f.repo.get('service_oauth',c.id);assert.equal(JSON.stringify(record).includes('private-access'),false);
 assert.equal((await unseal(record.sealed,f.env.ADMIN_KEY)).verifier,'private-verifier');
 await assert.rejects(finishConnectorOAuth(f.repo,f.env,new URLSearchParams({state:'unrecognized',code:'x'})),e=>e.code==='oauth_expired');
 await f.repo.transact('mark-used',{},tx=>tx.put('service_oauth',{...record,status:'used'}));
 await assert.rejects(finishConnectorOAuth(f.repo,f.env,new URLSearchParams({state:record.state,code:'x'})),e=>e.code==='invalid_oauth');
});
test('legacy SSE servers remain callable through the official fallback transport',async()=>{
 let stream;const encode=new TextEncoder();
 const send=value=>stream.enqueue(encode.encode('event: message\ndata: '+JSON.stringify(value)+'\n\n'));
 const fetcher=async(raw,init={})=>{
  const url=new URL(raw);
  if(url.pathname==='/sse'&&init.method==='POST')return new Response(null,{status:405});
  if(url.pathname==='/sse')return new Response(new ReadableStream({start(controller){stream=controller;controller.enqueue(encode.encode('event: endpoint\ndata: /messages\n\n'));}}),{headers:{'content-type':'text/event-stream'}});
  const m=JSON.parse(init.body);if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'legacy-sse',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'legacy result'}]}});
  return new Response(null,{status:202});
 };
 const {client}=await openRemoteMcp({url:'https://legacy.test/sse',fetch:fetcher});
 try{assert.equal((await mcpTools(client))[0].name,'echo');assert.equal((await client.callTool({name:'echo',arguments:{}})).content[0].text,'legacy result');}finally{await client.close();stream.close();}
});
test('full OAuth discovery, browser handoff, code exchange, reconnect and shared tool call use the SDK',async t=>{
 const f=await setup(t),base=remoteFixture();let exchanged=0,forceRefresh=false,refreshRequests=0;
 let diagnostic;f.env.CONNECTOR_DIAGNOSTICS=e=>diagnostic=e;
 f.env.CONNECTOR_FETCH=async(raw,init={})=>{
  const url=String(raw),json=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
  if(url.includes('oauth-protected-resource'))return json({resource:'https://tools.test/mcp',authorization_servers:['https://auth.test'],scopes_supported:['tools']});
  if(url.includes('.well-known/'))return json({issuer:'https://auth.test',authorization_endpoint:'https://auth.test/authorize',token_endpoint:'https://auth.test/token',registration_endpoint:'https://auth.test/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256']});
  if(url==='https://auth.test/register')return json({client_id:'test-client',redirect_uris:['https://hub.test/v2/connectors/oauth/callback'],token_endpoint_auth_method:'none'});
  if(url==='https://auth.test/token'){const body=new URLSearchParams(init.body);if(body.get('grant_type')==='refresh_token'){assert.equal(body.get('refresh_token'),'isolated-refresh-token');refreshRequests++;await new Promise(r=>setTimeout(r,refreshRequests===1?20:60));if(exchanged>=2)return new Response(JSON.stringify({error:'invalid_grant'}),{status:400,headers:{'content-type':'application/json'}});}else{assert.equal(body.get('code'),'test-code');assert.ok(body.get('code_verifier'));}exchanged++;return json({access_token:forceRefresh?'refreshed-oauth-token':'isolated-oauth-token',token_type:'Bearer',refresh_token:'isolated-refresh-token'});}
  const authorization=new Headers(init.headers).get('authorization');if(!authorization||forceRefresh&&!authorization.includes('refreshed-oauth-token'))return new Response(null,{status:401,headers:{'www-authenticate':'Bearer resource_metadata="https://tools.test/.well-known/oauth-protected-resource"'}});
  return base.fetcher(raw,init);
 };
 const start=await f.settings({action:'save',name:'OAuth service',url:'https://tools.test/mcp',authType:'oauth'});
 assert.equal(start.connection.health,'authorization_required',diagnostic?.stack);assert.ok(start.authorizationUrl);
 const authURL=new URL(start.authorizationUrl);assert.ok(authURL.searchParams.get('code_challenge'));assert.equal(authURL.searchParams.get('code_challenge_method'),'S256');
 const state=authURL.searchParams.get('state');await finishConnectorOAuth(f.repo,f.env,new URLSearchParams({code:'test-code',state}));assert.equal(exchanged,1);
 const checked=await f.settings({action:'check',connectionId:start.connection.id});assert.equal(checked.connection.health,'ready');
 forceRefresh=true;const results=await Promise.all([f.tool({action:'call',connectionId:start.connection.id,requestId:'oauth-write',tool:'write',arguments:{text:'authorized'}},peer),f.tool({action:'call',connectionId:start.connection.id,requestId:'oauth-write-2',tool:'write',arguments:{text:'concurrent authorized'}})]);assert.ok(results.every(r=>r.status==='succeeded'),JSON.stringify(results));assert.equal(exchanged,2);assert.equal(base.writes,2);assert.equal(refreshRequests,1,'one-use refresh token must be rotated only once');
 await assert.rejects(finishConnectorOAuth(f.repo,f.env,new URLSearchParams({code:'test-code',state})));assert.equal(exchanged,2);
});
