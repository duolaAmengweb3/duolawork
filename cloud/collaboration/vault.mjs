import {id,fail,required,digest} from './repository.mjs';
import {access} from './workspace-objects.mjs';
import {requireManager} from './delegation.mjs';
import {activityPage} from './service-activity.mjs';
import {publicMcpURL} from '../../shared/mcp-client.mjs';
import {vaultReference,vaultReferences,replaceVaultReferences,concealSecrets} from '../../shared/vault-references.mjs';
import {sealVault,unsealVault,exportVaultBackup,importVaultBackup} from './vault-crypto.mjs';
import {readBounded} from './security.mjs';

const string={type:'string'},object={type:'object',additionalProperties:true};
export const VAULT_TOOL={name:'vault',description:'全局凭证库。list/info 返回可用凭证名称、字段和引用，不返回密钥。request 在指定服务地址代发 HTTP 并注入凭证；结果不明查 result，不重复写。原生命令用本地 run_with_credentials 注入 vault:// 引用。prepare 只给受信运行端一次性领取，不能把领取结果放进群或记忆。manage 仅供指定秘书修改名称和备注，不能扩大授权。',inputSchema:{type:'object',properties:{action:{type:'string',enum:['list','info','request','result','prepare','manage']},channelId:string,credentialId:string,requestId:string,query:string,after:string,invocationId:string,url:string,method:string,headers:object,body:{},auth:{type:'string',enum:['bearer','basic','headers','none']},references:object,operation:string,expectedVersion:{type:'integer'},name:string,description:string,blockedMemberIds:{type:'array',items:string},blockedChannelIds:{type:'array',items:string}},required:['action','channelId'],additionalProperties:false}};
const workspace=repo=>repo.workspaceId||repo.repo.workspaceId;
const context=(repo,e)=>({workspace:workspace(repo),id:e.id,version:e.version});
export const publicVaultEntry=e=>({id:e.id,name:e.name,type:e.type,description:e.description||'',service:e.service||'',allowedOrigins:e.allowedOrigins||[],status:e.status,fieldNames:e.fieldNames,fields:e.fieldNames.map(name=>({name,reference:vaultReference(e.id,name)})),blockedMemberIds:e.blockedMemberIds||[],blockedChannelIds:e.blockedChannelIds||[],version:e.version,createdAt:e.createdAt,updatedAt:e.updatedAt,expiresAt:e.expiresAt||null,lastUsedAt:e.lastUsedAt||null});
function fields(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||!Object.keys(input).length||Object.keys(input).length>40)fail('invalid_vault_fields','请添加 1–40 个凭证字段');
 if(Object.entries(input).some(([k,v])=>! /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(k)||['__proto__','constructor','prototype'].includes(k)||typeof v!=='string'||!v.length||v.length>30000)||JSON.stringify(input).length>120000)fail('invalid_vault_fields','字段名请用英文、数字或下划线；字段值不能为空或过大');
 return {...input};
}
function origins(input=[]){if(!Array.isArray(input)||input.length>30)fail('invalid_vault_origin','服务地址无效');return [...new Set(input.filter(Boolean).map(v=>new URL(publicMcpURL(v)).origin))];}
function visible(entry,actor,channelId){return actor.owner||entry.status==='active'&&(!entry.expiresAt||Date.parse(entry.expiresAt)>Date.now())&&!entry.blockedMemberIds?.includes(actor.memberId)&&!entry.blockedChannelIds?.includes(channelId);}
async function allowed(repo,actor,credentialId,channelId,{version}={}){
 if(!actor.owner){if(!actor.memberId)fail('forbidden','需要真实成员身份',403);await access(repo,required(channelId,'聊天'),actor);}
 const entry=await repo.get('vault_entry',required(credentialId,'凭证'));
 if(entry.status!=='active'||entry.expiresAt&&Date.parse(entry.expiresAt)<=Date.now())fail('vault_unavailable','凭证已停用、删除或过期',403);
 if(!visible(entry,actor,channelId))fail('vault_forbidden','当前成员或聊天已关闭此凭证的访问',403);
 if(version!==undefined&&version!==entry.version)fail('vault_changed','凭证或使用范围已更新，请重新取得引用',409);
 return entry;
}
const decrypt=(repo,entry,env)=>unsealVault(entry.sealed,env,context(repo,entry));
function audit(tx,entry,actor,channelId,event,status='succeeded',extra={}){
 const record={id:id('vaultuse'),parentId:entry.id,scopeId:channelId||'',credentialName:entry.name,credentialVersion:entry.version,memberId:actor.memberId||'owner',event,status,createdAt:tx.now,...extra};tx.put('vault_activity',record);return record;
}
export async function resolveVaultConfig(repo,config,actor,channelId,env,{targetOrigin,expectedUses}={}){
 const refs=vaultReferences(config),values=new Map(),uses=[],secrets=[];
 for(const credentialId of new Set(refs.map(r=>r.credentialId))){
  const e=await allowed(repo,actor,credentialId,channelId,{version:expectedUses?.find(u=>u.id===credentialId)?.version});
  if(targetOrigin&&e.allowedOrigins?.length&&!e.allowedOrigins.includes(targetOrigin))fail('vault_destination','凭证未允许发往这个服务地址',403);
  const data=await decrypt(repo,e,env);uses.push({id:e.id,version:e.version});secrets.push(...Object.values(data));
  for(const r of refs.filter(r=>r.credentialId===credentialId)){if(!Object.hasOwn(data,r.field))fail('vault_field_missing','凭证引用的字段已不存在',409);values.set(r.reference,data[r.field]);}
 }
 return {config:replaceVaultReferences(config,values),uses,secrets};
}
export async function assertVaultUses(repo,uses,actor,channelId){for(const use of uses||[])await allowed(repo,actor,use.id,channelId,{version:use.version});}
export async function recordVaultUse(repo,uses,actor,channelId,event,status='succeeded'){
 const write=async tx=>{for(const use of uses||[]){const e=await tx.get('vault_entry',use.id,false);if(!e)continue;audit(tx,{...e,version:use.version},actor,channelId,event,status);if(e.version===use.version)tx.put('vault_entry',{...e,lastUsedAt:tx.now});}return {};};
 if(uses?.length)return repo.repo?write(repo):repo.transact(id('vaultuse'),{},write);
}
async function list(repo,actor,args){
 const limit=101,query=(args.query||'').trim().slice(0,200),status=args.deleted===true||args.deleted==='1'?'deleted':['active','disabled'].includes(args.status)?args.status:null;
 let sql="SELECT body FROM hub_v2_records WHERE workspace_id=? AND kind='vault_entry' AND id>?";const params=[repo.workspaceId,args.after||''];
 if(status){sql+=' AND status=?';params.push(status);}else sql+=" AND status NOT IN ('deleted','purged')";
 if(query){sql+=" AND (json_extract(body,'$.name') LIKE ? ESCAPE '\\' OR json_extract(body,'$.service') LIKE ? ESCAPE '\\')";const q='%'+query.replace(/[\\%_]/g,'\\$&')+'%';params.push(q,q);}
 sql+=' ORDER BY id LIMIT ?';params.push(limit);
 const rows=(await repo.db.prepare(sql).bind(...params).all()).results.map(r=>JSON.parse(r.body));
 return {items:rows.slice(0,100).filter(e=>actor.owner||visible(e,actor,args.channelId)).map(publicVaultEntry),next:rows.length>100?rows[99].id:null};
}
function scope(args,old,identity){
 const members=args.blockedMemberIds??old?.blockedMemberIds??[],channels=args.blockedChannelIds??old?.blockedChannelIds??[];
 if(!Array.isArray(members)||!Array.isArray(channels)||members.length>1000||channels.length>1000||members.some(m=>!identity.members.some(x=>x.id===m)))fail('invalid_scope','凭证使用范围无效');
 return {blockedMemberIds:[...new Set(members)],blockedChannelIds:[...new Set(channels)]};
}
async function checkVersion(tx,entry,version){const current=await tx.get('vault_entry',entry.id);if(current.version!==version)fail('version_conflict','凭证刚被更新，请刷新后重试',409);return current;}
export async function vaultSettings(repo,identity,actor,args,env){
 await requireManager(repo,actor);
 if(args.action==='list')return {...await list(repo,actor,args),configured:!!env.VAULT_ENCRYPTION_KEY};
 if(args.action==='get'){if(!actor.owner)await allowed(repo,actor,args.credentialId,args.channelId);return {item:publicVaultEntry(await repo.get('vault_entry',args.credentialId))};}
 if(args.action==='activity'){const e=args.credentialId?await repo.get('vault_entry',args.credentialId):null;if(!actor.owner){if(!e)fail('owner_required','只有用户可查看凭证库全局记录',403);await allowed(repo,actor,e.id,args.channelId);}return activityPage(repo,'vault_activity',{parent:e?.id,after:args.after});}
 if(args.action==='reveal'){
  if(!actor.owner)fail('owner_required','只有用户可在凭证库页面查看真实值',403);
  const entry=await repo.get('vault_entry',args.credentialId);if(!['active','disabled'].includes(entry.status))fail('vault_unavailable','请先恢复凭证');const data=await decrypt(repo,entry,env);
  await repo.transact(args.requestId,{action:'reveal',credentialId:entry.id},async tx=>{await checkVersion(tx,entry,entry.version);audit(tx,entry,actor,null,'reveal');return {recorded:true};});
  return {fields:data,version:entry.version};
 }
 if(args.action==='export'){
  if(!actor.owner)fail('owner_required','只有用户可导出凭证备份',403);
  const rows=[];let after='';while(true){const page=await repo.list('vault_entry',{limit:501,after});rows.push(...page.filter(e=>!['deleted','purged'].includes(e.status)));if(rows.length>1000||rows.reduce((sum,e)=>sum+(e.sealed?.data.length||0),0)>8000000)fail('too_large','单次备份最多 1000 条或 8MB 凭证');if(page.length<501)break;after=page.at(-1).id;}
  const items=await Promise.all(rows.map(async e=>({...publicVaultEntry(e),values:await decrypt(repo,e,env)})));
  const data={sourceWorkspace:repo.workspaceId,createdAt:new Date().toISOString(),items};if(new TextEncoder().encode(JSON.stringify(data)).byteLength>5000000)fail('too_large','备份内容过大，请分批整理后导出');const bundle=await exportVaultBackup(data,args.password);await repo.transact(id('vaultexport'),{},tx=>{audit(tx,{id:'vault',name:'凭证库',version:1},actor,null,'export');return {recorded:true};});return {bundle};
 }
 if(args.action==='import'){
  if(!actor.owner)fail('owner_required','只有用户可导入凭证备份',403);
  const data=await importVaultBackup(args.bundle,args.password);
  if(!Array.isArray(data.items)||data.items.length>1000||data.items.some(e=>!e?.name||['blockedMemberIds','blockedChannelIds'].some(k=>e[k]!==undefined&&(!Array.isArray(e[k])||e[k].some(v=>typeof v!=='string')))||e.expiresAt&&!Number.isFinite(Date.parse(e.expiresAt))))fail('invalid_backup','备份内容无效，未导入');
  const sameWorkspace=data.sourceWorkspace===repo.workspaceId;
  const imported=await Promise.all(data.items.map(async e=>{const values=fields(e.values),entry={id:id('credential'),name:required(e.name,'凭证名称',120),type:['api_key','token','login','ssh','custom'].includes(e.type)?e.type:'custom',description:typeof e.description==='string'?e.description.slice(0,1000):'',service:typeof e.service==='string'?e.service.slice(0,200):'',allowedOrigins:origins(e.allowedOrigins),status:e.status==='disabled'?'disabled':'active',fieldNames:Object.keys(values),expiresAt:e.expiresAt||null,blockedMemberIds:sameWorkspace?(e.blockedMemberIds||[]).filter(m=>identity.members.some(x=>x.id===m)):[],blockedChannelIds:sameWorkspace?e.blockedChannelIds||[]:[],version:1};return {...entry,sealed:await sealVault(values,env,context(repo,entry))};}));
  return repo.transact(args.requestId,{action:'import',fingerprint:await digest(JSON.stringify(args.bundle))},async tx=>{const items=[];for(const e of imported){items.push(publicVaultEntry(tx.put('vault_entry',{...e,createdAt:tx.now,updatedAt:tx.now})));audit(tx,e,actor,null,'import');}return {items};});
 }
 if(args.action==='save'){
  if(args.fields!==undefined&&!actor.owner)fail('owner_required','凭证值请由用户在 Vault 页面录入',403);
  if(!actor.owner){if(!args.credentialId||['blockedMemberIds','blockedChannelIds','allowedOrigins','expiresAt','type','removedFields'].some(k=>args[k]!==undefined))fail('owner_required','凭证授权和生命周期由用户管理，秘书不能自行扩大权限',403);await allowed(repo,actor,args.credentialId,args.channelId);}
  const submitted=args.fields===undefined?undefined:fields(args.fields),entryId=args.credentialId||'credential_'+(await digest(required(args.requestId,'请求编号'))).slice(0,32);
  return repo.transact(args.requestId,{...args,fields:submitted?await digest(JSON.stringify(submitted)):undefined},async tx=>{
   const old=args.credentialId?await tx.get('vault_entry',args.credentialId):null;if(old)await checkVersion(tx,old,args.expectedVersion);
   if(old&&['deleted','purged'].includes(old.status))fail('vault_deleted','请先从回收站恢复此凭证',409);
   const values=old?{...await decrypt(repo,old,env),...submitted}:submitted||fields(null),version=(old?.version||0)+1;
   if(args.removedFields!==undefined){if(!Array.isArray(args.removedFields)||args.removedFields.some(v=>typeof v!=='string'))fail('invalid_vault_fields','删除字段格式无效');for(const k of args.removedFields)delete values[k];}fields(values);
   const entry={...old,id:entryId,name:required(args.name||old?.name,'凭证名称',120),type:args.type||old?.type||'custom',description:args.description??old?.description??'',service:args.service??old?.service??'',allowedOrigins:origins(args.allowedOrigins??old?.allowedOrigins??[]),fieldNames:Object.keys(values),status:old?.status||'active',version,expiresAt:args.expiresAt??old?.expiresAt??null,...scope(args,old,identity)};
   if(!['api_key','token','login','ssh','custom'].includes(entry.type)||typeof entry.description!=='string'||entry.description.length>1000||typeof entry.service!=='string'||entry.service.length>200||entry.expiresAt&&!Number.isFinite(Date.parse(entry.expiresAt)))fail('invalid_vault_item','凭证类型、说明或到期时间无效');
   const sealed=await sealVault(values,env,context(repo,entry)),row=tx.put('vault_entry',{...entry,sealed,createdAt:old?.createdAt||tx.now,updatedAt:tx.now});audit(tx,row,actor,null,old?'update':'create');return publicVaultEntry(row);
  });
 }
 const entry=await repo.get('vault_entry',required(args.credentialId,'凭证'));
 if(!['access','disable','enable','delete','restore','purge'].includes(args.action))fail('invalid_action','凭证库操作无效');
 if(!actor.owner)fail('owner_required','请由用户管理凭证授权、启停和删除，Agent 不能自行扩大权限',403);
 return repo.transact(args.requestId,{action:args.action,id:entry.id,version:args.expectedVersion,...(args.action==='access'?scope(args,entry,identity):{})},async tx=>{
  const e=await checkVersion(tx,entry,args.expectedVersion);
  if(args.action==='purge'&&(e.status!=='deleted'||args.confirm!==true))fail('invalid_action','只能在回收站明确彻底删除凭证');
  if(e.status==='deleted'&&!['restore','purge'].includes(args.action))fail('vault_deleted','此凭证已在回收站');
  // Scope/status revisions must also bind the sealed payload to the new version.
  const next={...e,version:e.version+1,updatedAt:tx.now};
  if(args.action==='access')Object.assign(next,scope(args,e,identity));
  else next.status={disable:'disabled',enable:'active',delete:'deleted',restore:'active',purge:'purged'}[args.action];
  next.sealed=args.action==='purge'?null:await sealVault(await decrypt(repo,e,env),env,context(repo,next));
  if(args.action==='purge'){next.fieldNames=[];next.name='已彻底删除';next.description='';next.service='';next.allowedOrigins=[];}
  tx.put('vault_entry',next);audit(tx,e,actor,null,args.action);return publicVaultEntry(next);
 });
}
const reservedEnv=new Set(['PATH','HOME','USER','SHELL','CODEX_HOME','CLAUDE_CONFIG_DIR','NODE_OPTIONS','LD_PRELOAD','DYLD_INSERT_LIBRARIES','PYTHONPATH','NODE_PATH','BASH_ENV','ENV','__proto__','constructor','prototype']);
async function prepare(repo,actor,args,env){
 const refs=args.references;if(!refs||typeof refs!=='object'||Array.isArray(refs)||!Object.keys(refs).length||Object.keys(refs).length>30||Object.entries(refs).some(([k,v])=>! /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k)||reservedEnv.has(k)||typeof v!=='string'||vaultReferences(v).length!==1||vaultReferences(v)[0].reference!==v))fail('invalid_vault_mapping','请选择凭证引用并使用普通环境变量名');
 const snapshot=await resolveVaultConfig(repo,refs,actor,args.channelId,env),leaseId='vaultlease_'+await digest(actor.memberId+':'+required(args.requestId,'请求编号'));
 return repo.transact(args.requestId,{action:'prepare',memberId:actor.memberId,channelId:args.channelId,references:refs},async tx=>{await assertVaultUses(tx,snapshot.uses,actor,args.channelId);tx.put('vault_lease',{id:leaseId,memberId:actor.memberId,scopeId:args.channelId,status:'ready',references:refs,uses:snapshot.uses,expiresAt:new Date(Date.now()+120000).toISOString(),createdAt:tx.now});return {leaseId,expiresAt:new Date(Date.now()+120000).toISOString(),environmentKeys:Object.keys(refs),instruction:'仅由当前原生运行端在 /v2/self/vault/redeem 领取，使用原成员授权；不要把值输出到聊天或记忆。'};});
}
export async function redeemVaultLease(repo,actor,args,env){
 if(!actor.memberId)fail('forbidden','需要原成员身份',403);
 const encrypted=await repo.transact(id('vaultredeem'),{},async tx=>{
  const lease=await tx.get('vault_lease',required(args.leaseId,'领取编号'));
  if(lease.memberId!==actor.memberId||lease.status!=='ready'||Date.parse(lease.expiresAt)<Date.now())fail('vault_lease_expired','凭证领取已使用、过期或不属于当前成员',403);
  await access(tx,lease.scopeId,actor);await assertVaultUses(tx,lease.uses,actor,lease.scopeId);
  for(const use of lease.uses){const e=await tx.get('vault_entry',use.id);audit(tx,e,actor,lease.scopeId,'native_use');tx.put('vault_entry',{...e,lastUsedAt:tx.now});}
  tx.put('vault_lease',{...lease,status:'consumed',consumedAt:tx.now});return {references:lease.references,uses:lease.uses,channelId:lease.scopeId};
 });
 const values=new Map();for(const use of encrypted.uses){const e=await allowed(repo,actor,use.id,encrypted.channelId,{version:use.version}),data=await decrypt(repo,e,env);for(const r of vaultReferences(encrypted.references).filter(r=>r.credentialId===e.id))values.set(r.reference,data[r.field]);}await assertVaultUses(repo,encrypted.uses,actor,encrypted.channelId);
 return {environment:replaceVaultReferences(encrypted.references,values)};
}
async function vaultRequest(repo,actor,args,env){
 const entry=await allowed(repo,actor,args.credentialId,args.channelId),url=publicMcpURL(args.url),origin=new URL(url).origin;
 if(!entry.allowedOrigins?.includes(origin))fail('vault_destination','请先在 Vault 中为这条凭证填写允许的服务地址',403);
 const method=(args.method||'GET').toUpperCase();if(!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(method))fail('invalid_method','HTTP 方法无效');
 if(args.headers&&(typeof args.headers!=='object'||Array.isArray(args.headers)||Object.entries(args.headers).some(([k,v])=>!/^[A-Za-z0-9_-]+$/.test(k)||typeof v!=='string'||/[\r\n]/.test(v))))fail('invalid_headers','请求头需要是有效名称和文本值');
 const secret=await decrypt(repo,entry,env),auth=args.auth||(entry.type==='login'?'basic':'bearer'),headers=new Headers(args.headers||{});
 for(const name of ['host','content-length','connection','transfer-encoding','proxy-authorization','upgrade'])if(headers.has(name))fail('invalid_headers','这个请求头不能通过凭证代理设置');
 if(auth==='bearer'){if(!secret.token||/[\r\n]/.test(secret.token))fail('vault_field_missing','Bearer 认证需要有效的单行 token 字段');headers.set('Authorization','Bearer '+secret.token);}
 else if(auth==='basic'){if(secret.username===undefined||secret.password===undefined)fail('vault_field_missing','Basic 认证需要 username 和 password 字段');headers.set('Authorization','Basic '+btoa(String.fromCharCode(...new TextEncoder().encode(secret.username+':'+secret.password))));}
 else if(!['none','headers'].includes(auth))fail('invalid_auth','认证方式无效');
 const template=v=>typeof v==='string'?v.replace(/\{\{([A-Za-z_][A-Za-z0-9_-]*)\}\}/g,(_m,k)=>{if(!Object.hasOwn(secret,k))fail('vault_field_missing','请求引用的凭证字段不存在');return secret[k];}):v;
 const actualHeaders=Object.fromEntries([...headers].map(([k,v])=>[k,template(v)]));
 try{new Headers(actualHeaders);}catch{fail('invalid_headers','凭证字段不能用于此请求头，请检查是否含换行或非 HTTP 文本');}
 const templateBody=v=>typeof v==='string'?template(v):Array.isArray(v)?v.map(templateBody):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,templateBody(x)])):v;
 let body=args.body;if(body!==undefined&&typeof body!=='string'){body=JSON.stringify(templateBody(body));if(!headers.has('Content-Type'))actualHeaders['Content-Type']='application/json';}else body=template(body);
 if(body&&body.length>180000)fail('too_large','请求内容过大');if(['GET','HEAD'].includes(method)&&body)fail('invalid_body','GET/HEAD 请求不能带正文');
 const invocationId='vaultcall_'+await digest(actor.memberId+':'+required(args.requestId,'请求编号')),fingerprint=await digest(JSON.stringify({credentialId:entry.id,channelId:args.channelId,url,method,headers:args.headers,body:args.body,auth}));
 const claim=await repo.transact(id('vaultcallclaim'),{fingerprint},async tx=>{const old=await tx.get('vault_invocation',invocationId,false);if(old){if(old.fingerprint!==fingerprint)fail('idempotency_conflict','同一编号不能发送不同的请求',409);return {started:false};}await allowed(tx,actor,entry.id,args.channelId,{version:entry.version});tx.put('vault_invocation',{id:invocationId,memberId:actor.memberId,scopeId:args.channelId,credentialId:entry.id,credentialVersion:entry.version,fingerprint,status:'running',createdAt:tx.now});return {started:true};});
 if(!claim.started)return requestResult(repo,actor,args.channelId,invocationId,env);
 let result,status='succeeded',message='请求已返回';
 try{
  const response=await (env.CONNECTOR_FETCH||fetch)(url,{method,headers:actualHeaders,...(body?{body}:{}),redirect:'error',signal:AbortSignal.timeout(20000)});
  const bytes=await readBounded(response,300000);let value=new TextDecoder().decode(bytes);try{value=JSON.parse(value);}catch{}
  await allowed(repo,actor,entry.id,args.channelId,{version:entry.version});const authorization=actualHeaders.Authorization||actualHeaders.authorization||'';result={httpStatus:response.status,body:concealSecrets(value,[...Object.values(secret),authorization,authorization.replace(/^(Bearer|Basic) /i,'')])};
  if(!response.ok){status='failed';message='服务返回 HTTP '+response.status;}
 }catch{status='unknown';message='没有取得可确认的结果，请核对服务记录；未自动重复请求';}
 const encrypted=result?await sealVault(result,env,{workspace:repo.workspaceId,id:invocationId,version:1}):null;
 await repo.transact('finish-'+invocationId,{},async tx=>{const row=await tx.get('vault_invocation',invocationId);tx.put('vault_invocation',{...row,status,message,result:encrypted,completedAt:tx.now});const e=await tx.get('vault_entry',entry.id);audit(tx,entry,actor,args.channelId,'http_request',status,{origin,method,httpStatus:result?.httpStatus||null});if(e.version===entry.version)tx.put('vault_entry',{...e,lastUsedAt:tx.now});return {status};});
 return {invocationId,status,message,...(result?{result}:{})};
}
async function requestResult(repo,actor,channelId,invocationId,env){
 let r=await repo.get('vault_invocation',invocationId);if(r.memberId!==actor.memberId||r.scopeId!==channelId)fail('forbidden','只能查看本成员在这个聊天的请求',403);
 // Historical redacted results survive rotation; current revocation still wins.
 await allowed(repo,actor,r.credentialId,channelId);
 if(r.status==='running'&&Date.parse(r.createdAt)<Date.now()-90000){await repo.transact('expire-'+r.id,{},async tx=>{const current=await tx.get('vault_invocation',r.id);if(current.status==='running')tx.put('vault_invocation',{...current,status:'unknown',message:'运行端未留下可确认的结果，请核对服务记录；未自动重复请求',completedAt:tx.now});return {};});r=await repo.get('vault_invocation',r.id);}
 return {invocationId:r.id,status:r.status,message:r.message,...(r.result?{result:await unsealVault(r.result,env,{workspace:repo.workspaceId,id:r.id,version:1})}:{})};
}
export async function vaultTool(repo,identity,actor,args,env){
 await access(repo,args.channelId,actor);
 if(args.action==='list')return list(repo,actor,args);
 if(args.action==='info')return {item:publicVaultEntry(await allowed(repo,actor,args.credentialId,args.channelId)),usage:'HTTP 使用 vault(action=request)，原生环境使用 run_with_credentials；连接器请求头/环境变量中可使用字段的 vault:// 引用。'};
 if(args.action==='prepare')return prepare(repo,actor,args,env);
 if(args.action==='request')return vaultRequest(repo,actor,args,env);
 if(args.action==='result')return requestResult(repo,actor,args.channelId,required(args.invocationId,'请求记录'),env);
 if(args.action==='manage'){if(args.operation!=='save')fail('owner_required','授权、启停和删除请由用户在 Vault 管理',403);return vaultSettings(repo,identity,actor,{...args,action:args.operation},env);}
 fail('invalid_action','凭证工具操作无效');
}
