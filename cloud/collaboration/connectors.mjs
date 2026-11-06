import {fail,id,required,digest} from './repository.mjs';
import {seal,unseal,readJSON} from './security.mjs';
import {requireManager} from './delegation.mjs';
import {access} from './workspace-objects.mjs';
const string={type:'string'};
export const CONNECTOR_TOOLS=[{name:'github',description:'读取已授权 GitHub 仓库的资料、Issue、PR和文件；connectionId选择实际账号，channelId限制使用范围。只读共享连接器，不修改代码或复制原 Agent 的 GitHub 登录。',inputSchema:{type:'object',properties:{channelId:string,connectionId:string,action:{type:'string',enum:['connections','repository','issues','pulls','issue','file']},repository:string,number:{type:'integer',minimum:1},path:string,page:{type:'integer',minimum:1}},required:['channelId','action'],additionalProperties:false}}];
const publicConnection=({credentials,...c})=>c;
const repositoryName=value=>{if(typeof value!=='string'||! /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)||value.includes('..'))fail('invalid_repository','仓库请填写 owner/repository');return value;};
const allowed=(c,actor,channelId)=>c.status==='connected'&&(!c.channelIds.length||c.channelIds.includes(channelId))&&(!c.memberIds.length||actor.owner||c.memberIds.includes(actor.memberId));
async function githubFetch(token,path,fetchImpl){
 const response=await fetchImpl('https://api.github.com'+path,{headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2026-03-10','User-Agent':'DuolaWork'},signal:AbortSignal.timeout(12000),redirect:'error'});
 if(!response.ok)fail(response.status===401?'authorization_expired':'github_unavailable',response.status===401?'GitHub 授权已失效，请更新连接':response.status===403?'GitHub 权限不足或达到调用上限':response.status===404?'该账号无法访问此仓库或资料':'GitHub 暂时不可用',response.status===404?404:409);
 return readJSON(response,1500000);
}
export async function connectorSettings(repo,identity,actor,args,env,fetchImpl=fetch){
 await requireManager(repo,actor);
 if(!['list','connect','update','disconnect'].includes(args.action))fail('invalid_action','连接操作无效');
 if(args.action==='list')return {items:(await repo.list('service_connection',{limit:500})).map(publicConnection),native:'原 Agent 的已有工具和连接器仍由原环境管理。'};
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
 const repoName=repositoryName(args.repository);
 if(!connection.repositories.includes(repoName))fail('forbidden','此仓库尚未关联到连接',403);
 let path='/repos/'+repoName;
 if(['issues','pulls'].includes(args.action))path+='/'+args.action+'?per_page=30&page='+Math.max(1,Math.min(100,Number(args.page)||1));
 else if(args.action==='issue'){if(!Number.isSafeInteger(args.number)||args.number<1)fail('invalid_input','Issue编号无效');path+='/issues/'+args.number;}
 else if(args.action==='file'){if(typeof args.path!=='string'||args.path.split('/').some(p=>!p||p==='..'))fail('invalid_path','文件路径无效');path+='/contents/'+args.path.split('/').map(encodeURIComponent).join('/');}
 else if(args.action!=='repository')fail('invalid_action','不支持此 GitHub 操作');
 const {token}=await unseal(connection.credentials,env.ADMIN_KEY),result=await githubFetch(token,path,fetchImpl);
 const fresh=await repo.get('service_connection',connection.id);await access(repo,args.channelId,actor);
 if(fresh.version!==connection.version||!allowed(fresh,actor,args.channelId))fail('connection_changed','连接授权已变化，请重新读取',409);
 return {account:connection.account,repository:repoName,result,access:'read_only'};
}
