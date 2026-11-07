import {fail,id,required,digest} from './repository.mjs';
import {seal,unseal,readJSON} from './security.mjs';
import {requireManager} from './delegation.mjs';
import {access} from './workspace-objects.mjs';
import {appendActivity,activityPage} from './service-activity.mjs';
const string={type:'string'};
export const CONNECTOR_TOOLS=[{name:'github',description:'读取已授权 GitHub 仓库的资料、Issue、PR和文件；activity 查看本群实际读取记录。返回读取时间和来源；失败按原因处理，不反复要求重新授权。只读共享连接，不复制原 Agent 登录。',inputSchema:{type:'object',properties:{channelId:string,connectionId:string,action:{type:'string',enum:['connections','activity','repository','issues','pulls','issue','file']},repository:string,number:{type:'integer',minimum:1},path:string,page:{type:'integer',minimum:1},after:string},required:['channelId','action'],additionalProperties:false}}];
const publicConnection=({credentials,...c})=>c;
const repositoryName=value=>{if(typeof value!=='string'||! /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)||value.includes('..'))fail('invalid_repository','仓库请填写 owner/repository');return value;};
const allowed=(c,actor,channelId)=>c.status==='connected'&&(!c.channelIds.length||c.channelIds.includes(channelId))&&(!c.memberIds.length||actor.owner||c.memberIds.includes(actor.memberId));
async function githubFetch(token,path,fetchImpl){
 let response;try{response=await fetchImpl('https://api.github.com'+path,{headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2026-03-10','User-Agent':'DuolaWork'},signal:AbortSignal.timeout(12000),redirect:'error'});}catch(error){fail(error.name==='TimeoutError'||error.name==='AbortError'?'connection_timeout':'connection_network',error.name==='TimeoutError'||error.name==='AbortError'?'GitHub 响应超时，请稍后重试':'暂时无法连接 GitHub，请检查网络后重试',503);}
 if(!response.ok){
  if(response.status===401)fail('authorization_expired','GitHub 授权已失效，请更新此连接的授权',401);
  let message='';try{message=(await readJSON(response,10000)).message||'';}catch{}
  if(response.status===429||response.status===403&&(response.headers.get('x-ratelimit-remaining')==='0'||response.headers.has('retry-after')||/rate limit|secondary rate/i.test(message))){
   const seconds=Number(response.headers.get('retry-after')),reset=Number(response.headers.get('x-ratelimit-reset'));
   const wait=seconds>0?Math.ceil(seconds):reset>0?Math.max(1,Math.ceil(reset-Date.now()/1000)):60;
   fail('rate_limited',`GitHub 调用较频繁，请在约 ${wait} 秒后重试，无需重新授权`,429);
  }
  if(response.status===403)fail('permission_denied','GitHub 未允许读取此资源，请检查仓库权限或组织授权',403);
  if(response.status===404)fail('resource_unavailable','资源不存在或此账号不可见，请核对仓库和路径',404);
  fail('github_unavailable','GitHub 服务暂时不可用，请稍后重试',503);
 }
 try{return await readJSON(response,1500000);}catch{fail('invalid_response','GitHub 返回的数据不完整，请重试',502);}
}
async function recordRead(repo,actor,connection,args,started,error){
 return appendActivity(repo,'connector_activity',{parentId:connection.id,scopeId:args.channelId||null,memberId:actor.memberId||'owner',connectionVersion:connection.version,account:connection.account,action:args.action,repository:args.repository,path:args.path||null,number:args.number||null,status:error?'failed':'succeeded',code:error?.code||null,message:error?.message||'已读取实际资源',durationMs:Date.now()-started,source:'https://api.github.com'+(args.resourcePath||'/repos/'+args.repository)});
}
export async function connectorSettings(repo,identity,actor,args,env,fetchImpl=fetch){
 await requireManager(repo,actor);
 if(!['list','activity','check','connect','update','disconnect'].includes(args.action))fail('invalid_action','连接操作无效');
 if(args.action==='list'){
  // One database request for all latest receipts; indexed lookup per connection,
  // without one network round trip per account or loading entire histories.
  const [connections,latest]=await Promise.all([repo.list('service_connection',{limit:500}),repo.db.prepare("SELECT c.id,(SELECT a.body FROM hub_v2_records a WHERE a.workspace_id=c.workspace_id AND a.kind='connector_activity' AND a.parent_id=c.id ORDER BY a.updated_at DESC,a.rowid DESC LIMIT 1) AS activity FROM hub_v2_records c WHERE c.workspace_id=? AND c.kind='service_connection'").bind(repo.workspaceId).all()]);
  const records=new Map(latest.results.map(r=>[r.id,r.activity?JSON.parse(r.activity):null]));
  return {items:connections.map(c=>({...publicConnection(c),latestRead:records.get(c.id)||null})),native:'原 Agent 的已有工具和连接器仍由原环境管理。'};
 }
 if(args.action==='activity'){await repo.get('service_connection',args.connectionId);return activityPage(repo,'connector_activity',{parent:args.connectionId,after:args.after});}
 if(args.action==='check'){
  const c=await repo.get('service_connection',args.connectionId);if(c.status!=='connected')fail('authorization_required','请先连接此账号',409);
  const repository=repositoryName(args.repository||c.repositories[0]);if(!c.repositories.includes(repository))fail('forbidden','请选择已关联仓库',403);
  const started=Date.now();let result,error;
  try{const {token}=await unseal(c.credentials,env.ADMIN_KEY);result=await githubFetch(token,'/repos/'+repository,fetchImpl);const fresh=await repo.get('service_connection',c.id);await requireManager(repo,actor);if(fresh.version!==c.version||fresh.status!=='connected')fail('connection_changed','授权已变化，请重新检查',409);}catch(e){error=e;}
  const receipt=await recordRead(repo,actor,c,{action:'repository',repository},started,error);
  if(error)throw error;return {account:c.account,repository,readAt:receipt.createdAt,receiptId:receipt.id,result};
 }
 if(args.action==='connect'&&!actor.owner)fail('owner_required','请让用户在连接器页面完成 GitHub 授权，令牌不要放到聊天里',403);
 let account;
 const tokenFingerprint=args.token?await digest(args.token):undefined;
 if(args.action==='connect')account=await githubFetch(required(args.token,'GitHub 令牌',5000),'/user',fetchImpl);
 return repo.transact(args.requestId,{...args,token:tokenFingerprint,actor},async tx=>{
  await requireManager(tx,actor);
  const old=args.connectionId?await tx.get('service_connection',args.connectionId):null;
  if(old&&args.expectedVersion!==old.version)fail('version_conflict','连接已被更新，请刷新',409);
  if(args.action==='disconnect'){
   if(!old)fail('not_found','连接不存在',404);
   return publicConnection(tx.put('service_connection',{...old,credentials:null,status:'disconnected',version:old.version+1,updatedBy:actor.memberId||'owner'}));
  }
  if(old?.status==='disconnected'&&!account)fail('authorization_required','请重新填写 GitHub 授权令牌');
  if(!old&&!account)fail('invalid_input','请先连接 GitHub');
  const sourceRepos=args.repositories??old?.repositories??[];if(!Array.isArray(sourceRepos))fail('invalid_repository','仓库列表无效');
  const repositories=sourceRepos.map(repositoryName),channelIds=args.channelIds??old?.channelIds??[],memberIds=args.memberIds??old?.memberIds??[];
  if(!Array.isArray(channelIds)||!Array.isArray(memberIds)||[repositories,channelIds,memberIds].some(a=>a.length>100))fail('invalid_scope','连接使用范围无效');
  for(const cid of channelIds)await tx.get('channel',cid);
  if(memberIds.some(mid=>!identity.members.some(m=>m.id===mid&&m.status!=='disabled')))fail('invalid_member','成员不可用');
  const next=tx.put('service_connection',{...old,id:old?.id||id('github'),provider:'github',account:account?.login||old.account,accountId:account?.id||old.accountId,credentials:account?await seal({token:args.token},env.ADMIN_KEY):old.credentials,repositories,channelIds,memberIds,status:'connected',capabilities:['read_repositories','read_issues','read_pull_requests','read_files'],version:(old?.version||0)+1,checkedAt:account?tx.now:old.checkedAt,createdAt:old?.createdAt||tx.now,updatedBy:actor.memberId||'owner'});
  return publicConnection(next);
 });
}
export async function connectorTool(repo,actor,args,env,fetchImpl=fetch){
 await access(repo,args.channelId,actor);
 const connections=(await repo.list('service_connection',{limit:500})).filter(c=>allowed(c,actor,args.channelId));
 if(args.action==='connections')return {items:connections.map(publicConnection)};
 const connection=connections.find(c=>c.id===args.connectionId);if(!connection)fail('forbidden','此聊天或成员没有该连接的使用权',403);
 if(args.action==='activity')return activityPage(repo,'connector_activity',{parent:connection.id,scope:args.channelId,after:args.after});
 const repoName=repositoryName(args.repository);
 if(!connection.repositories.includes(repoName))fail('forbidden','此仓库尚未关联到连接',403);
 let path='/repos/'+repoName;
 if(['issues','pulls'].includes(args.action))path+='/'+args.action+'?per_page=30&page='+Math.max(1,Math.min(100,Number(args.page)||1));
 else if(args.action==='issue'){if(!Number.isSafeInteger(args.number)||args.number<1)fail('invalid_input','Issue编号无效');path+='/issues/'+args.number;}
 else if(args.action==='file'){if(typeof args.path!=='string'||args.path.split('/').some(p=>!p||p==='..'))fail('invalid_path','文件路径无效');path+='/contents/'+args.path.split('/').map(encodeURIComponent).join('/');}
 else if(args.action!=='repository')fail('invalid_action','不支持此 GitHub 操作');
 const started=Date.now();let result,error;
 try{
  const {token}=await unseal(connection.credentials,env.ADMIN_KEY);result=await githubFetch(token,path,fetchImpl);
  const fresh=await repo.get('service_connection',connection.id);await access(repo,args.channelId,actor);
  if(fresh.version!==connection.version||!allowed(fresh,actor,args.channelId))fail('connection_changed','连接授权已变化，请重新读取',409);
 }catch(e){error=e;}
 const receipt=await recordRead(repo,actor,connection,{...args,resourcePath:path},started,error);if(error)throw error;
 return {account:connection.account,repository:repoName,result,access:'read_only',readAt:receipt.createdAt,receiptId:receipt.id,source:'https://api.github.com'+path};
}
