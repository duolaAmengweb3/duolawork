import {id,fail,required,digest} from './repository.mjs';
import {seal,unseal} from './security.mjs';
import {access} from './workspace-objects.mjs';
import {requireManager} from './delegation.mjs';
import {appendActivity,activityPage} from './service-activity.mjs';
import {CONNECTOR_CATALOG,connectorAllowed,importConnectorConfig} from '../../shared/connector-catalog.mjs';
import {openRemoteMcp,mcpTools,publicMcpURL} from '../../shared/mcp-client.mjs';
import {oauthProvider} from './connector-oauth.mjs';
import {auth,UnauthorizedError} from '@modelcontextprotocol/sdk/client/auth.js';
import {resolveVaultConfig,assertVaultUses,recordVaultUse} from './vault.mjs';
import {vaultReferences,concealSecrets} from '../../shared/vault-references.mjs';
import {prepareToolCatalog,readToolCatalog} from './connector-catalog-storage.mjs';
import {saveApplication} from './connector-applications.mjs';
import {prepareConnectorResult,readConnectorResult} from './connector-result-storage.mjs';
import {saveWechat,checkWechat,performWechat,wechatIssue} from './wechat-connector.mjs';

export const MCP_CONNECTOR_TOOL={name:'connector',description:'使用团队共享的外部服务（GitHub、Cloudflare、飞书、微信公众号等）。先 connections 查连接，再 tools、call。公众号可先将 app_id/app_secret 保存到 Vault，再 connect(provider=wechat-mp,appId,credentialId,name,requestId) 直接接入，默认团队共享，不要求秘书身份。使用原聊天 channelId；写操作须提供唯一 requestId，结果不明查 result，不换编号重做。',inputSchema:{type:'object',properties:{channelId:{type:'string'},action:{type:'string',enum:['connections','tools','call','result','connect']},connectionId:{type:'string'},tool:{type:'string'},arguments:{type:'object',additionalProperties:true},requestId:{type:'string'},invocationId:{type:'string'},provider:{type:'string',enum:['wechat-mp']},appId:{type:'string'},credentialId:{type:'string'},name:{type:'string'}},required:['channelId','action'],additionalProperties:false}};
export const publicService=({credentials,...c})=>({...c,toolCount:c.toolCount??c.tools?.length??0});
const agentService=c=>{const value=publicService(c);return {...value,url:value.url?new URL(value.url).origin:null};};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function errorState(e){
 const providerIssue=wechatIssue(e);if(providerIssue)return providerIssue;
 if(typeof e.code==='string'&&e.code.startsWith('vault_'))return {code:e.code,message:e.message,state:'attention'};
 if(/does not support dynamic client registration/i.test(e.message||''))return {code:'oauth_app_required',message:'此服务需要先由 DuolaWork 配置官方登录应用，尚未接通；无需重复点击登录',state:'attention'};
 if(e.code==='host_offline')return {code:e.code,message:'工具所在电脑或 VPS 不在线，连接配置已保留',state:'offline'};
 if(e.code==='outcome_unknown')return {code:e.code,message:'未收到明确结果，请查看调用记录；操作可能已经执行，请勿重复提交',state:'attention'};
 if(e instanceof UnauthorizedError||e.code===401||e.status===401||e.name==='UnauthorizedError')return {code:'authorization_required',message:'需要完成服务授权，请打开此连接继续登录',state:'authorization_required'};
 if(e.code===403||e.status===403)return {code:'permission_denied',message:'外部服务未允许此操作，请检查该账号的服务权限',state:'attention'};
 if(e.code===429||e.status===429)return {code:'rate_limited',message:'外部服务正在限流，请稍后再试',state:'attention'};
 return {code:'service_unavailable',message:'暂时无法调用此服务，请检查地址、运行环境或稍后重试',state:'attention'};
}
async function fresh(repo,c,actor,channelId){
 const next=await repo.get('service_connection',c.id);
 if(next.version!==c.version||next.status==='disconnected'||channelId&&!connectorAllowed(next,actor,channelId))fail('connection_changed','连接或使用范围已变化，请刷新后再试',409);
 if(actor)await assertVaultUses(repo,(next.vaultReferences||[]).map(r=>({id:r.credentialId})),actor,channelId);
 return next;
}
async function credentials(repo,c,env){return c.credentials?unseal(c.credentials,env.ADMIN_KEY):{};}
export async function resolveConnectorCredentials(repo,c,actor,channelId,env,expectedUses){return resolveVaultConfig(repo,await credentials(repo,c,env),actor,channelId,env,{targetOrigin:c.url?new URL(c.url).origin:undefined,expectedUses});}
async function remote(repo,c,env,fn,{authorize=false,actor={owner:true},channelId}={}){
 const resolved=await resolveConnectorCredentials(repo,c,actor,channelId,env),secret=resolved.config;let o=c.authType==='oauth'?await oauthProvider(repo,c,env,{begin:authorize}):null;
 const initialToken=o?.data.tokens?.access_token;
 // Some providers expose initialize/tools/list anonymously. For an OAuth
 // connection, public discovery is not proof that the account has signed in.
 if(o&&!initialToken){const result=await auth(o.provider,{serverUrl:c.url,fetchFn:o.fetch});if(result!=='AUTHORIZED')throw new UnauthorizedError();}
 let session;
 try{
  try{session=await openRemoteMcp({url:c.url,headers:secret.headers||{},authProvider:o?.provider,fetch:o?.fetch||env.CONNECTOR_FETCH||fetch});}
  catch(e){
   const latest=o?await oauthProvider(repo,c,env):null;
   if(!latest?.data.tokens?.access_token||latest.data.tokens.access_token===initialToken)throw e;
   // Retry initialization only, before a tool has been submitted. Never retry fn.
   session=await openRemoteMcp({url:c.url,headers:secret.headers||{},authProvider:latest.provider,fetch:latest.fetch});
  }
  const result=await fn(session.client);await assertVaultUses(repo,resolved.uses,actor,channelId);await recordVaultUse(repo,resolved.uses,actor,channelId,actor.owner?'connector_check':'connector_call');return concealSecrets(result,resolved.secrets);
 }finally{await session?.client.close().catch(()=>{});}
}
async function hostRequest(repo,c,actor,args){
 const host=await repo.get('service_host',c.hostId,false);
 if(!host||host.status==='disconnected'||Date.now()-Date.parse(host.lastSeen||0)>30000)fail('host_offline','运行端离线',503);
 const jobId=id('connectorjob');
 await repo.transact(jobId,{},tx=>tx.put('service_job',{id:jobId,parentId:c.hostId,scopeId:c.id,status:'pending',connectionVersion:c.version,memberId:actor.memberId||'owner',channelId:args.channelId||null,invocationId:args.invocationId||null,action:args.action,tool:args.tool,arguments:args.arguments||{},createdAt:tx.now}));
 for(let i=0;i<50;i++){
  const job=await repo.get('service_job',jobId);
  if(job.status==='done')return readConnectorResult(repo,job);
  if(job.status==='failed')fail(job.code||'service_unavailable',job.message||'运行端调用失败',502);
  await sleep(700);
 }
 fail('outcome_unknown','运行端尚未返回明确结果',504);
}
async function perform(repo,c,actor,args,env){
 if(c.transport==='wechat')return performWechat(repo,c,actor,args,env);
 if(c.transport==='stdio')return hostRequest(repo,c,actor,args);
 return remote(repo,c,env,async client=>args.action==='tools'?mcpTools(client):client.callTool({name:args.tool,arguments:args.arguments||{}},undefined,{timeout:30000}),{actor,channelId:args.channelId});
}
async function check(repo,c,env,{authorize=false,actor={owner:true},channelId}={}){
 try{
  const native=c.transport==='wechat'?await checkWechat(repo,c,env,{actor,channelId}):null;
  const tools=native?native.tools:c.transport==='stdio'?await perform(repo,c,actor,{action:'tools',channelId},env):await remote(repo,c,env,mcpTools,{authorize,actor,channelId});
  const {chunks,...catalog}=await prepareToolCatalog(c.id,tools);
  await repo.transact(id('connectorcheck'),{},async tx=>{await fresh(tx,c);for(const chunk of chunks)tx.put('service_catalog_chunk',chunk);return tx.put('service_connection',{...c,...catalog,status:'connected',health:'ready',issueCode:null,message:native?.message||null,...(native?{capabilities:native.capabilities}:{}),checkedAt:tx.now});});
  return {connection:publicService(await repo.get('service_connection',c.id))};
 }catch(e){
  env.CONNECTOR_DIAGNOSTICS?.(e);
  const issue=errorState(e);
  const oauth=await repo.get('service_oauth',c.id,false),state=oauth?.sealed?await unseal(oauth.sealed,env.ADMIN_KEY):{};
  await repo.transact(id('connectorcheck'),{},async tx=>{await fresh(tx,c);return tx.put('service_connection',{...c,health:issue.state,issueCode:issue.code,message:issue.message,checkedAt:tx.now});});
  return {connection:publicService(await repo.get('service_connection',c.id)),...(state.authorizationUrl?{authorizationUrl:state.authorizationUrl}:{}),issue};
 }
}
export async function mcpConnectorSettings(repo,identity,actor,args,env){
 const nativeAccountSave=args.action==='save'&&args.provider==='wechat-mp'&&!actor.owner;
 if(nativeAccountSave)await access(repo,required(args.channelId,'聊天'),actor);else await requireManager(repo,actor);
 if(args.action==='setup')return {wechat:{execution:'DuolaWork 共享服务器',egressIp:env.CONNECTOR_EGRESS_IP||null,configUrl:'https://developers.weixin.qq.com/platform'}};
 if(args.action==='save'&&args.provider==='wechat-mp'){const c=await saveWechat(repo,identity,actor,args,env);return check(repo,c,env,{actor,channelId:args.channelId});}
 if(args.action==='catalog')return {items:CONNECTOR_CATALOG};
 if(args.action==='hosts')return {items:(await repo.list('service_host',{limit:500})).map(({tokenHash,pairingHash,...h})=>({...h,online:h.status!=='disconnected'&&Date.now()-Date.parse(h.lastSeen||0)<30000}))};
 if(args.action==='host.disconnect')return repo.transact(args.requestId,args,async tx=>{const host=await tx.get('service_host',required(args.hostId,'运行端'));tx.put('service_host',{...host,status:'disconnected',tokenHash:null,pairingHash:null});for(const j of await tx.list('service_job',{parent:host.id,status:'pending',limit:501}))tx.put('service_job',{...j,status:'failed',code:'not_started',message:'运行端已断开，未开始执行'});return {hostId:host.id,status:'disconnected'};});
 if(args.action==='host.create'){
  let hostId=id('servicehost'),code=id('pair');
  const saved=await repo.transact(args.requestId,{action:args.action,name:args.name},async tx=>{tx.put('service_host',{id:hostId,name:required(args.name,'运行端名称',100),status:'waiting',pairingHash:await digest(code),expiresAt:new Date(Date.now()+15*60000).toISOString()});return {hostId,code};});hostId=saved.hostId;code=saved.code;
  return {hostId,code,guide:env.CONNECTOR_ORIGIN+'/v2/connectors/host/guide',instruction:`请在你所在的电脑或 VPS 接入 DuolaWork 的共享工具运行端。读取 ${env.CONNECTOR_ORIGIN}/v2/connectors/host/guide，按说明安装，接入参数为 ${JSON.stringify({endpoint:env.CONNECTOR_ORIGIN,hostId,code})}。只安装工具连接端，不改 Agent 的账号、模型或原会话。配对码15分钟内有效且只用一次。`};
 }
 if(args.action==='import'){
  const items=importConnectorConfig(args.config),result=[];
  for(let i=0;i<items.length;i++)try{result.push(await mcpConnectorSettings(repo,identity,actor,{...items[i],hostId:args.hostId,action:'save',requestId:args.requestId+':'+i},env));}catch(e){result.push({name:items[i].name,error:e.code?e.message:'配置无效，请检查该项'});}
  return {items:result};
 }
 if(args.action==='save'){
  if(!actor.owner)fail('owner_required','请由用户添加外部账号或工具配置',403);
  const old=args.connectionId?await repo.get('service_connection',args.connectionId):null;
  if(old&&args.expectedVersion!==old.version)fail('version_conflict','连接已更新，请刷新',409);
  const preset=CONNECTOR_CATALOG.find(p=>p.id===args.provider);
  const transport=args.transport||old?.transport||'http';if(!['http','stdio'].includes(transport))fail('invalid_transport','不支持此接入方式');
  const secret=old?.credentials?await credentials(repo,old,env):{};
  const headers=args.headers??secret.headers??{};
  if(!headers||typeof headers!=='object'||Array.isArray(headers)||Object.keys(headers).some(k=>!/^[a-zA-Z0-9_-]+$/.test(k)||['host','cookie','connection','content-length'].includes(k.toLowerCase()))||Object.values(headers).some(v=>typeof v!=='string'||/[\r\n]/.test(v)))fail('invalid_headers','服务请求头无效');
  if(transport==='stdio'){
   const host=await repo.get('service_host',required(args.hostId||old?.hostId,'工具运行端'));
   if(host.status==='disconnected')fail('host_offline','此运行端已断开');
   secret.command=required(args.command||secret.command,'启动命令',2000);secret.args=args.args??secret.args??[];secret.env=args.env??secret.env??{};secret.cwd=args.cwd??secret.cwd??'';
   if(!Array.isArray(secret.args)||secret.args.some(v=>typeof v!=='string')||typeof secret.env!=='object'||Array.isArray(secret.env)||Object.values(secret.env).some(v=>typeof v!=='string'))fail('invalid_command','启动参数或环境变量格式无效');
  }else secret.headers=headers;
  if(args.oauthClientId!==undefined){
   if(args.oauthClientId!==secret.oauthClientId&&!args.oauthClientSecret)delete secret.oauthClientSecret;
   secret.oauthClientId=args.oauthClientId;
  }
  if(args.oauthClientSecret)secret.oauthClientSecret=args.oauthClientSecret;
  if(args.vaultBindings!==undefined){
   if(!Array.isArray(args.vaultBindings)||args.vaultBindings.length>40)fail('invalid_vault_reference','凭证引用配置无效');
   for(const b of args.vaultBindings){if(!['headers','env'].includes(b.target)||b.target!==(transport==='stdio'?'env':'headers')||typeof b.name!=='string'||! /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(b.name)||['__proto__','constructor','prototype','host','connection','content-length','cookie'].includes(b.name.toLowerCase())||typeof b.value!=='string'||/[\r\n]/.test(b.value)||!vaultReferences(b.value).length)fail('invalid_vault_reference','请求头或环境变量中的凭证引用无效');secret[b.target]={...secret[b.target],[b.name]:b.value};}
  }
  const refs=vaultReferences(secret);if(refs.some(r=>!r.location.startsWith('headers.')&&!r.location.startsWith('env.')))fail('invalid_vault_reference','凭证引用只能用于请求头或环境变量，不能写入命令行');
  if(JSON.stringify(secret).includes('vault://')&&!refs.length)fail('invalid_vault_reference','Vault 凭证引用格式不正确');
  const row={...old,id:old?.id||'mcp_'+(await digest(required(args.requestId,'请求编号'))).slice(0,32),serviceType:'mcp',provider:args.provider||old?.provider||'custom',name:required(args.name||old?.name||preset?.name,'连接名称',120),transport,url:transport==='http'?publicMcpURL(args.url||old?.url||preset?.url):null,hostId:transport==='stdio'?(args.hostId||old?.hostId):null,authType:args.authType||old?.authType||(Object.keys(headers).length?'headers':'oauth'),callbackOrigin:env.CONNECTOR_ORIGIN,blockedMemberIds:old?.blockedMemberIds||[],blockedChannelIds:old?.blockedChannelIds||[],tools:[],toolCount:0,catalog:null,status:'configured',health:'unchecked',version:(old?.version||0)+1,createdAt:old?.createdAt||new Date().toISOString()};
  row.vaultReferences=refs;if(!['oauth','headers','none'].includes(row.authType))fail('invalid_auth','登录方式无效');
  if(row.authType==='none'||old&&old.authType!==row.authType&&args.headers===undefined)secret.headers={};
  row.vaultReferences=vaultReferences(secret);await resolveVaultConfig(repo,secret,{owner:true},null,env,{targetOrigin:row.url?new URL(row.url).origin:undefined});
  // Hash the secret in the receipt; never retain submitted tokens in an input ledger.
  await repo.transact(args.requestId,{...row,createdAt:undefined,secretHash:await digest(JSON.stringify(secret))},async tx=>{if(old)await fresh(tx,old);if(old&&(old.url!==row.url||args.oauthClientId!==undefined))tx.put('service_oauth',{id:row.id,sealed:null,state:null});if(args.oauthClientId!==undefined)await saveApplication(tx,row,secret,env);return publicService(tx.put('service_connection',{...row,credentials:await seal(secret,env.ADMIN_KEY)}));});
  return check(repo,await repo.get('service_connection',row.id),env,{authorize:row.authType==='oauth'});
 }
 const c=await repo.get('service_connection',required(args.connectionId,'连接'));
 if(args.action==='tools'){if(c.status==='disconnected')fail('connection_changed','此连接已断开',409);const tools=await readToolCatalog(repo,c);await fresh(repo,c);return {tools};}
 if(args.action==='check'||args.action==='authorize')return check(repo,c,env,{authorize:args.action==='authorize'});
 if(args.action==='activity')return activityPage(repo,'connector_activity',{parent:c.id,after:args.after});
 if(args.action==='access'){
  const members=args.blockedMemberIds??c.blockedMemberIds??[],channels=args.blockedChannelIds??c.blockedChannelIds??[];
  if(!Array.isArray(members)||!Array.isArray(channels)||members.length>500||channels.length>500||members.some(m=>!identity.members.some(v=>v.id===m)))fail('invalid_scope','成员或聊天范围无效');
  for(const ch of channels)await repo.get('channel',ch);
  return repo.transact(args.requestId,args,async tx=>{await fresh(tx,c);if(args.expectedVersion!==c.version)fail('version_conflict','连接已更新，请刷新',409);return publicService(tx.put('service_connection',{...c,blockedMemberIds:members,blockedChannelIds:channels,version:c.version+1}));});
 }
 if(args.action==='disconnect')return repo.transact(args.requestId,args,async tx=>{await fresh(tx,c);if(args.expectedVersion!==c.version)fail('version_conflict','连接已更新，请刷新',409);tx.put('service_oauth',{id:c.id,sealed:null,state:null});return publicService(tx.put('service_connection',{...c,status:'disconnected',credentials:null,tools:[],toolCount:0,catalog:null,version:c.version+1}));});
 fail('invalid_action','连接操作无效');
}
export async function mcpConnectorTool(repo,actor,args,env){
 await access(repo,args.channelId,actor);
 if(args.action==='connect'){
  required(args.requestId,'请求编号',160);
  if(args.provider!=='wechat-mp')fail('invalid_provider','此接入方式用于微信公众号');
  const current=(await repo.list('service_connection',{limit:500})).find(c=>c.provider==='wechat-mp'&&c.appId===args.appId&&c.status!=='disconnected');
  if(current){if(!connectorAllowed(current,actor,args.channelId))fail('forbidden','当前成员或聊天已关闭这个公众号的访问',403);if(current.status==='connected'&&current.health==='ready')return {connection:agentService(current),alreadyConnected:true};return check(repo,current,env,{actor,channelId:args.channelId});}
  // Keep the real caller. Adding a supported account from a permitted Vault
  // reference never grants owner privileges or arbitrary host execution.
  const c=await saveWechat(repo,{},actor,args,env);return check(repo,c,env,{actor,channelId:args.channelId});
 }
 const all=(await repo.list('service_connection',{limit:500})).filter(c=>c.serviceType==='mcp'&&connectorAllowed(c,actor,args.channelId));
 if(args.action==='connections')return {items:all.map(c=>{const {tools,...value}=agentService(c);return value;})};
 const c=all.find(c=>c.id===args.connectionId);if(!c)fail('forbidden','此聊天或成员不可使用该连接',403);
 if(args.action==='tools'){const tools=await readToolCatalog(repo,c);await fresh(repo,c,actor,args.channelId);return {connection:agentService({...c,tools:undefined}),tools,health:c.health,message:c.message};}
 if(args.action==='result'){
  await fresh(repo,c,actor,args.channelId);
  const r=await repo.get('service_invocation',required(args.invocationId,'调用记录'));
  if(r.scopeId!==c.id||r.channelId!==args.channelId||r.memberId!==actor.memberId)fail('forbidden','只能查看自己在当前聊天的调用',403);
  if(r.status==='running'&&Date.now()-Date.parse(r.createdAt)>90000){
   return repo.transact(id('stalecall'),{},async tx=>{const current=await tx.get('service_invocation',r.id);if(current.status!=='running')return current;const next=tx.put('service_invocation',{...current,status:'unknown',message:'执行端未回传明确结果，请核对服务记录，勿重复执行'});const event=await tx.get('connector_activity',r.id,false);if(event)tx.put('connector_activity',{...event,status:'unknown',message:next.message});return next;});
  }
  const result=await readConnectorResult(repo,r);await fresh(repo,c,actor,args.channelId);
  return {...r,...(result!==undefined?{result}:{})};
 }
 if(args.action!=='call')fail('invalid_action','工具操作无效');
 const tools=c.catalog&&c.tools.length!==c.toolCount?await readToolCatalog(repo,c):c.tools;
 if(!tools?.some(t=>t.name===args.tool))fail('unknown_tool','此连接没有该工具，请先查看工具目录');
 required(args.requestId,'请求编号',160);
 const invocationId='invoke_'+await digest(c.id+':'+actor.memberId+':'+args.requestId),fingerprint=await digest(JSON.stringify({tool:args.tool,arguments:args.arguments||{},channelId:args.channelId}));
 const claim=await repo.transact(id('invocationclaim'),{fingerprint},async tx=>{const old=await tx.get('service_invocation',invocationId,false);if(old){if(old.fingerprint!==fingerprint)fail('idempotency_conflict','同一编号不能执行不同操作',409);return {started:false};}await fresh(tx,c,actor,args.channelId);tx.put('service_invocation',{id:invocationId,scopeId:c.id,channelId:args.channelId,memberId:actor.memberId,fingerprint,status:'running',tool:args.tool,createdAt:tx.now});tx.put('connector_activity',{id:invocationId,parentId:c.id,scopeId:args.channelId,memberId:actor.memberId,event:'call',tool:args.tool,status:'running',invocationId,message:'工具正在执行',createdAt:tx.now});return {started:true};});
 if(!claim.started){const r=await repo.get('service_invocation',invocationId),result=await readConnectorResult(repo,r);await fresh(repo,c,actor,args.channelId);return {invocationId,status:r.status,...(result!==undefined?{result}:{}),...(r.status!=='succeeded'?{message:r.message||'调用已提交，请查询结果；不要重复执行'}:{})};}
 let result,issue;
 try{result=await perform(repo,c,actor,{...args,invocationId},env);await access(repo,args.channelId,actor);await fresh(repo,c,actor,args.channelId);if(JSON.stringify(result).length>1500000)fail('outcome_unknown','结果过大，需在服务端核对');if(result?.isError)issue={code:'tool_error',message:'工具返回执行错误，请查看返回结果',state:'attention'};}catch(e){result=undefined;issue=errorState(e);if(!['authorization_required','permission_denied','rate_limited','host_offline'].includes(issue.code))issue={code:'outcome_unknown',message:'未取得明确结果；操作可能已执行，请查看记录，不要重复提交',state:'attention'};}
 if(c.provider==='feishu'&&result?.isError&&result.structuredContent?.duolawork?.code==='authorization_required')issue={code:'authorization_required',state:'authorization_required',message:'原飞书账号需要登录，请在官方 CLI 恢复后检查连接'};
 const {chunks,...storedResult}=await prepareConnectorResult(c.id,invocationId,result);
 const record=await repo.transact('finish-'+invocationId,{},async tx=>{const r=await tx.get('service_invocation',invocationId);for(const chunk of chunks)tx.put('service_result_chunk',chunk);return tx.put('service_invocation',{...r,status:issue?(issue.code==='outcome_unknown'?'unknown':'failed'):'succeeded',...(issue?{code:issue.code,message:issue.message}:{}),...storedResult,completedAt:tx.now});});
 await repo.transact(id('connectorhealth'),{},async tx=>{const current=await tx.get('service_connection',c.id);if(current.version!==c.version||current.status==='disconnected')return {};const connectionIssue=issue?.code==='tool_error'?null:issue;return tx.put('service_connection',{...current,health:connectionIssue?.state||'ready',issueCode:connectionIssue?.code||null,message:connectionIssue?.message||null,lastCallAt:tx.now});});
 await repo.transact(id('connectorreceipt'),{},async tx=>{const event=await tx.get('connector_activity',invocationId);return tx.put('connector_activity',{...event,status:record.status,message:record.message||'工具已返回结果',completedAt:record.completedAt});});
 return {invocationId,status:record.status,...(issue?{code:issue.code,message:issue.message}:{}),...(result?{result}:{})};
}
