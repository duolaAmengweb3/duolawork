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
import {connectorResponse} from '../server/connector-fetch.mjs';
import {Response as UndiciResponse} from 'undici';
import {parseErrorResponse} from '@modelcontextprotocol/sdk/client/auth.js';
import {applicationKey,configuredApplication} from '../cloud/collaboration/connector-applications.mjs';
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
test('large tool results complete atomically and replays read exact data without executing again',async t=>{
 const f=await setup(t),c=await f.save(),text='汉字🪻\\\"\n'.repeat(40000);
 const args={action:'call',connectionId:c.id,requestId:'large-response',tool:'write',arguments:{text}};
 const first=await f.tool(args);assert.equal(first.status,'succeeded');assert.equal(first.result.content[0].text,text);
 const stored=await f.repo.get('service_invocation',first.invocationId);
 assert.ok(stored.resultRef.parts>1);assert.equal(stored.result,undefined);
 const chunks=await f.repo.list('service_result_chunk',{parent:c.id,limit:501});
 assert.ok(chunks.every(r=>Buffer.byteLength(JSON.stringify(r))<180000));
 assert.deepEqual((await f.tool(args)).result,first.result);assert.equal(f.service.writes,1);
 const receipt=await f.tool({action:'result',connectionId:c.id,invocationId:first.invocationId});assert.deepEqual(receipt.result,first.result);
 await assert.rejects(f.tool({action:'result',connectionId:c.id,invocationId:first.invocationId},peer),e=>e.code==='forbidden');
 await f.settings({action:'access',connectionId:c.id,expectedVersion:c.version,blockedMemberIds:['grok']});
 await assert.rejects(f.tool(args),e=>e.code==='forbidden');assert.equal(f.service.writes,1);
});
test('registered OAuth apps are reused by trusted providers while account tokens stay independent',async t=>{
 const f=await setup(t),url=CONNECTOR_CATALOG.find(p=>p.id==='github-mcp').url;
 const a=await f.save({provider:'github-mcp',url,oauthClientId:'app-one',oauthClientSecret:'private-app-secret'});
 const b=await f.save({provider:'github-mcp',url});
 const ca=await oauthProvider(f.repo,a,f.env,{begin:true}),cb=await oauthProvider(f.repo,b,f.env,{begin:true});
 assert.equal(ca.provider.clientInformation().client_id,'app-one');assert.equal(cb.provider.clientInformation().client_secret,'private-app-secret');
 await ca.provider.saveTokens({access_token:'account-one-token',token_type:'Bearer'});
 await cb.provider.saveTokens({access_token:'account-two-token',token_type:'Bearer'});
 assert.equal((await ca.provider.tokens()).access_token,'account-one-token');assert.equal((await cb.provider.tokens()).access_token,'account-two-token');
 assert.equal(JSON.stringify(await f.repo.list('service_application')).includes('private-app-secret'),false);
 assert.deepEqual(await configuredApplication(f.repo,{provider:'github-mcp',url:'https://other.test/mcp'},f.env),{});
 assert.equal(applicationKey('custom',url),null);assert.equal(applicationKey('google-gmail','https://drivemcp.googleapis.com/mcp/v1'),null);
 const drive=await f.save({provider:'google-drive',url:CONNECTOR_CATALOG.find(p=>p.id==='google-drive').url,oauthClientId:'google-app',oauthClientSecret:'google-secret'});
 assert.equal((await configuredApplication(f.repo,{provider:'google-calendar',url:CONNECTOR_CATALOG.find(p=>p.id==='google-calendar').url},f.env)).oauthClientId,'google-app');
 const google=await oauthProvider(f.repo,drive,f.env,{begin:true});
 await google.provider.redirectToAuthorization(new URL('https://accounts.google.com/o/oauth2/v2/auth?scope=drive'));
 const redirect=new URL(google.data.authorizationUrl);assert.equal(redirect.searchParams.get('access_type'),'offline');assert.equal(redirect.searchParams.get('prompt'),'consent select_account');
 await google.provider.redirectToAuthorization(new URL('https://unrelated.test/auth'));assert.equal(new URL(google.data.authorizationUrl).searchParams.has('access_type'),false);
 // Replacing an application's client ID cannot inherit the old secret.
 const rotated=(await f.settings({action:'save',connectionId:a.id,expectedVersion:a.version,oauthClientId:'app-two'})).connection;
 assert.deepEqual(await configuredApplication(f.repo,a,f.env),{oauthClientId:'app-two'});
 assert.equal((await oauthProvider(f.repo,rotated,f.env,{begin:true})).provider.clientInformation().client_secret,undefined);
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
test('stdio large Unicode results complete within repository limits and replay without starting another job',async t=>{
 const f=await setup(t),created=await f.settings({action:'host.create',name:'large-result host'}),paired=await connectorHostRequest(f.repo,f.identity,{action:'pair',...created},null,f.env);
 const host=new McpToolHost({...paired,endpoint:'https://hub.test'});host.request=args=>connectorHostRequest(f.repo,f.identity,{hostId:paired.hostId,...args},paired.token,f.env);
 await host.tick();const task=host.start();t.after(async()=>{await host.stop();await task;});
 const c=(await f.settings({action:'save',name:'large stdio',transport:'stdio',hostId:paired.hostId,command:process.execPath,args:[new URL('./fixtures/mcp-stdio.mjs',import.meta.url).pathname]})).connection;
 const text='汉字🪻\\\"\n',args={action:'call',connectionId:c.id,requestId:'large-stdio',tool:'write',arguments:{text,repeat:40000}},r=await f.tool(args,peer);
 assert.equal(r.status,'succeeded');assert.equal(r.result.content[0].text,text.repeat(40000));
 const invocation=await f.repo.get('service_invocation',r.invocationId),jobs=await f.repo.list('service_job',{parent:paired.hostId,limit:50});
 assert.ok(invocation.resultRef);assert.equal(invocation.result,undefined);assert.ok(jobs.find(j=>j.invocationId===r.invocationId).resultRef);
 assert.ok((await f.repo.list('service_result_chunk',{parent:c.id,limit:501})).every(chunk=>Buffer.byteLength(JSON.stringify(chunk))<180000));
 assert.deepEqual((await f.tool(args,peer)).result,r.result);assert.deepEqual((await f.tool({action:'result',connectionId:c.id,invocationId:r.invocationId},peer)).result,r.result);
 assert.equal((await f.repo.list('service_job',{parent:paired.hostId,limit:50})).length,jobs.length);
 const failed=await f.tool({...args,requestId:'logical-error',arguments:{text:'missing scope',fail:true}},peer);assert.equal(failed.status,'failed');assert.equal((await f.repo.get('service_connection',c.id)).health,'ready','a completed tool error is not a disconnected transport');
 await f.settings({action:'access',connectionId:c.id,expectedVersion:c.version,blockedMemberIds:['check']});await assert.rejects(f.tool(args,peer),e=>e.code==='forbidden');
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
  if(url.includes('.well-known/'))return json({issuer:'https://auth.test',authorization_endpoint:'https://auth.test/authorize',token_endpoint:'https://auth.test/token',registration_endpoint:'https://auth.test/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],scopes_supported:['tools','offline_access'],code_challenge_methods_supported:['S256']});
  if(url==='https://auth.test/register')return json({client_id:'test-client',redirect_uris:['https://hub.test/v2/connectors/oauth/callback'],token_endpoint_auth_method:'none'});
  if(url==='https://auth.test/token'){const body=new URLSearchParams(init.body);if(body.get('grant_type')==='refresh_token'){assert.equal(body.get('refresh_token'),'isolated-refresh-token');refreshRequests++;await new Promise(r=>setTimeout(r,refreshRequests===1?20:60));if(exchanged>=2)return new Response(JSON.stringify({error:'invalid_grant'}),{status:400,headers:{'content-type':'application/json'}});}else{assert.equal(body.get('code'),'test-code');assert.ok(body.get('code_verifier'));}exchanged++;return json({access_token:forceRefresh?'refreshed-oauth-token':'isolated-oauth-token',token_type:'Bearer',...(!forceRefresh?{refresh_token:'isolated-refresh-token'}:{})});}
  const authorization=new Headers(init.headers).get('authorization');if(!authorization||forceRefresh&&!authorization.includes('refreshed-oauth-token'))return new Response(null,{status:401,headers:{'www-authenticate':'Bearer resource_metadata="https://tools.test/.well-known/oauth-protected-resource"'}});
  return base.fetcher(raw,init);
 };
 const start=await f.settings({action:'save',name:'OAuth service',url:'https://tools.test/mcp',authType:'oauth'});
 assert.equal(start.connection.health,'authorization_required',diagnostic?.stack);assert.ok(start.authorizationUrl);
 const authURL=new URL(start.authorizationUrl);assert.ok(authURL.searchParams.get('code_challenge'));assert.equal(authURL.searchParams.get('code_challenge_method'),'S256');
 assert.deepEqual(new Set(authURL.searchParams.get('scope').split(' ')),new Set(['tools','offline_access']));
 const state=authURL.searchParams.get('state');await finishConnectorOAuth(f.repo,f.env,new URLSearchParams({code:'test-code',state}));assert.equal(exchanged,1);
 const checked=await f.settings({action:'check',connectionId:start.connection.id});assert.equal(checked.connection.health,'ready');
 forceRefresh=true;const results=await Promise.all([f.tool({action:'call',connectionId:start.connection.id,requestId:'oauth-write',tool:'write',arguments:{text:'authorized'}},peer),f.tool({action:'call',connectionId:start.connection.id,requestId:'oauth-write-2',tool:'write',arguments:{text:'concurrent authorized'}})]);assert.ok(results.every(r=>r.status==='succeeded'),JSON.stringify(results));assert.equal(exchanged,2);assert.equal(base.writes,2);assert.equal(refreshRequests,1,'one-use refresh token must be rotated only once');
 assert.equal((await oauthProvider(f.repo,checked.connection,f.env)).data.tokens.refresh_token,'isolated-refresh-token','a non-rotating refresh response must retain its original refresh token');
 await assert.rejects(finishConnectorOAuth(f.repo,f.env,new URLSearchParams({code:'test-code',state})));assert.equal(exchanged,2);
});
test('large provider catalogs retain full Unicode schemas, remain callable and reuse storage on recheck',async t=>{
 const f=await setup(t),base=f.env.CONNECTOR_FETCH;
 const schema={type:'object',properties:{text:{type:'string',description:'中文😀\\\n'.repeat(35000)}}};
 const definitions=Array.from({length:40},(_,i)=>({name:i?'tool_'+i:'write',description:'provider tool '+i,inputSchema:i?{type:'object'}:schema}));
 f.env.CONNECTOR_FETCH=async(raw,init={})=>{
  const m=JSON.parse(init.body||'{}');
  if(m.method==='tools/list')return Response.json({jsonrpc:'2.0',id:m.id,result:{tools:definitions}});
  return base(raw,init);
 };
 const c=await f.save();assert.equal(c.health,'ready');assert.equal(c.toolCount,40);assert.ok(c.catalog);
 assert.ok(Buffer.byteLength(JSON.stringify(await f.repo.get('service_connection',c.id)))<180000);
 const chunks=await f.repo.list('service_catalog_chunk',{parent:c.id,limit:501});assert.ok(chunks.length>1);assert.ok(chunks.every(r=>Buffer.byteLength(JSON.stringify(r))<180000));
 const listed=await f.tool({action:'tools',connectionId:c.id},peer);assert.equal(listed.tools.length,40);assert.deepEqual(listed.tools[0].inputSchema,schema);
 const human=await f.settings({action:'tools',connectionId:c.id});assert.deepEqual(human.tools,listed.tools);
 const called=await f.tool({action:'call',connectionId:c.id,requestId:'large-catalog-call',tool:'write',arguments:{text:'catalog retains callable tools'}});assert.equal(called.status,'succeeded');
 await f.settings({action:'check',connectionId:c.id});assert.equal((await f.repo.list('service_catalog_chunk',{parent:c.id,limit:501})).length,chunks.length);
 await f.settings({action:'access',connectionId:c.id,expectedVersion:c.version,blockedMemberIds:[peer.memberId]});await assert.rejects(f.tool({action:'tools',connectionId:c.id},peer));
});
test('numeric HTTP errors remain actionable instead of throwing during error classification',async t=>{
 for(const [status,code]of [[403,'permission_denied'],[429,'rate_limited']]){
  const f=await setup(t);f.env.CONNECTOR_FETCH=async()=>new Response('Provider rejected request',{status});
  const r=await f.settings({action:'save',name:'HTTP failure',url:'https://tools.test/mcp',authType:'none'});
  assert.equal(r.issue.code,code);assert.equal(r.connection.health,'attention');
 }
});
test('npm undici OAuth errors are normalized for the official SDK without losing the provider reason',async()=>{
 const response=connectorResponse(new UndiciResponse(JSON.stringify({error:'invalid_client',error_description:'Provider requires a registered client'}),{status:400,headers:{'content-type':'application/json'}}));
 const error=await parseErrorResponse(response);assert.equal(error.name,'InvalidClientError');assert.match(error.message,/registered client/);assert.doesNotMatch(error.message,/object Response/);
});
test('anonymous tool discovery cannot mark an OAuth account connected, including confidential DCR servers',async t=>{
 const f=await setup(t),base=remoteFixture();let anonymousMCP=0,diagnostic;f.env.CONNECTOR_DIAGNOSTICS=e=>diagnostic=e;
 f.env.CONNECTOR_FETCH=async(raw,init={})=>{
  const url=String(raw);
  if(url.includes('oauth-protected-resource'))return Response.json({resource:'https://tools.test/mcp',authorization_servers:['https://auth.test']});
  if(url.includes('.well-known/'))return Response.json({issuer:'https://auth.test',authorization_endpoint:'https://auth.test/authorize',token_endpoint:'https://auth.test/token',registration_endpoint:'https://auth.test/register',response_types_supported:['code'],token_endpoint_auth_methods_supported:['client_secret_basic'],code_challenge_methods_supported:['S256']});
  if(url==='https://auth.test/register'){assert.equal(JSON.parse(init.body).token_endpoint_auth_method,'client_secret_basic');return Response.json({client_id:'isolated-client',client_secret:'isolated-secret',redirect_uris:['https://hub.test/v2/connectors/oauth/callback'],token_endpoint_auth_method:'client_secret_basic'});}
  if(url==='https://auth.test/token'){assert.match(new Headers(init.headers).get('authorization'),/^Basic /);return Response.json({access_token:'isolated-token',token_type:'Bearer'});}
  anonymousMCP++;return base.fetcher(raw,init);
 };
 const pending=await f.settings({action:'save',name:'Public catalog with private data',url:'https://tools.test/mcp',authType:'oauth'});
 assert.equal(pending.connection.health,'authorization_required',diagnostic?.stack);assert.ok(pending.authorizationUrl);assert.equal(anonymousMCP,0);
 await finishConnectorOAuth(f.repo,f.env,new URLSearchParams({state:new URL(pending.authorizationUrl).searchParams.get('state'),code:'test-code'}));
 const checked=await f.settings({action:'check',connectionId:pending.connection.id});assert.equal(checked.connection.health,'ready');
});
