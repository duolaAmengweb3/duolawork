import {seedSkills} from './builtin-skills.mjs';
import {parse} from 'yaml';
import {fail,id,required,digest} from './repository.mjs';
import {requireManager,workspaceGrant} from './delegation.mjs';
import {access} from './workspace-objects.mjs';
const string={type:'string'},strings={type:'array',items:string,maxItems:100};
export const SKILL_TOOLS=[{name:'read_skill',description:'按需读取本群/本成员可用的标准 SKILL.md 方法和资源。未给skillId返回用途清单；执行脚本必须留在原 Agent 环境，Hub 不替换原生工具或扩大权限。',inputSchema:{type:'object',properties:{channelId:string,skillId:string,path:string},required:['channelId'],additionalProperties:false}},{name:'report_skill_use',description:'记录自己实际使用了哪一版技能及结果，不等于 Hub 独立验证或原生安装。脚本执行需说明命令、实际退出结果和产物。',inputSchema:{type:'object',properties:{requestId:string,channelId:string,skillId:string,version:{type:'integer'},summary:string},required:['requestId','channelId','skillId','version','summary'],additionalProperties:false}}];
export function parseSkill(files){
 if(!files||typeof files!=='object'||Array.isArray(files)||Object.keys(files).length>40)fail('invalid_skill','技能文件无效');
 for(const [name,body] of Object.entries(files))if(name.startsWith('/')||name.includes('\\')||name.split('/').some(p=>!p||p==='..'||p==='.')||typeof body!=='string')fail('invalid_skill','技能文件路径或正文无效');
 if(JSON.stringify(files).length>150000)fail('too_large','技能包请控制在150KB以内，较大资源可保留来源链接');
 const content=files['SKILL.md'];if(typeof content!=='string')fail('invalid_skill','需要包含 SKILL.md');
 const match=content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);if(!match)fail('invalid_skill','SKILL.md 需要 YAML 名称和用途说明');
 let metadata;try{metadata=parse(match[1],{maxAliasCount:0});}catch{fail('invalid_skill','技能元数据不是有效 YAML');}
 const name=required(metadata?.name,'技能名称',64),description=required(metadata?.description,'技能用途',1024);
 if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))fail('invalid_skill','技能名称请使用小写字母、数字和短横线');
 return {name,description,compatibility:String(metadata.compatibility||'').slice(0,500),hasScripts:Object.keys(files).some(f=>f.startsWith('scripts/')),files};
}
export const skillAvailable=(s,actor,channelId)=>s.status==='enabled'&&(!s.channelIds?.length||s.channelIds.includes(channelId))&&(!s.memberIds?.length||actor.owner||s.memberIds.includes(actor.memberId));
const publicSkill=({files,...s})=>({...s,fileNames:Object.keys(files||{})});
export async function skillCatalog(repo,actor,channelId){await access(repo,channelId,actor);await seedSkills(repo);return (await repo.list('workspace_skill',{limit:500})).filter(s=>skillAvailable(s,actor,channelId)).map(publicSkill);}
export async function skillTool(repo,actor,name,args){
 const catalog=await skillCatalog(repo,actor,args.channelId);
 if(!args.skillId)return {items:catalog};
 const skill=await repo.get('workspace_skill',args.skillId);
 if(!catalog.some(s=>s.id===skill.id))fail('forbidden','此技能未在当前范围启用',403);
 if(name==='read_skill'){
  const path=args.path||'SKILL.md';if(!Object.hasOwn(skill.files,path))fail('not_found','技能文件不存在',404);
  return {...publicSkill(skill),path,body:skill.files[path],sha256:await digest(skill.files[path]),execution:skill.hasScripts?'脚本由原 Agent 在自己的环境执行；未标记安装。':'共享方法；按当前任务需要参考。'};
 }
 if(args.version!==skill.version)fail('version_conflict','技能已更新，请重新读取',409);
 return repo.transact(args.requestId,{actor,args},async tx=>{
  const current=await tx.get('workspace_skill',skill.id);if(!skillAvailable(current,actor,args.channelId)||current.version!==args.version)fail('version_conflict','技能范围或版本已改变',409);
  return tx.put('skill_use',{id:id('skill_use'),scopeId:args.channelId,parentId:skill.id,memberId:actor.memberId||'owner',version:args.version,summary:required(args.summary,'实际使用结果',4000),evidence:'agent_reported',createdAt:tx.now});
 });
}
export async function skillSettings(repo,identity,actor,args){
 await requireManager(repo,actor);
 await seedSkills(repo);
 if(args.action==='read')return repo.get('workspace_skill',required(args.skillId,'技能',100));
 if(!['list','save','rollback'].includes(args.action))fail('invalid_action','技能操作无效');
 if(args.sourceUrl){const url=new URL(args.sourceUrl);if(url.protocol!=='https:'||url.hostname!=='raw.githubusercontent.com'||url.username||url.password||!url.pathname.endsWith('/SKILL.md'))fail('invalid_source','请填写公开 GitHub 的 SKILL.md 原文链接');const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(12000)});if(!response.ok)fail('source_unavailable','技能来源无法读取');const body=await response.text();if(body.length>150000)fail('too_large','技能过大');args={...args,files:{'SKILL.md':body},source:args.sourceUrl};}
 if(args.action==='list')return {items:(await repo.list('workspace_skill',{limit:500,order:'recent'})).map(publicSkill)};
 return repo.transact(args.requestId,{actor,args},async tx=>{
  await requireManager(tx,actor);
  const old=args.skillId?await tx.get('workspace_skill',args.skillId):null;
  if(old&&old.version!==args.expectedVersion)fail('version_conflict','技能已有变化，请刷新',409);
  let spec;
  if(args.action==='rollback'){const history=await tx.get('skill_version',args.skillId+':'+args.version);spec=parseSkill(history.files);}
  else if(args.files)spec=parseSkill(args.files);
  else if(!old)fail('invalid_skill','请添加 SKILL.md');
  const channelIds=args.channelIds??old?.channelIds??[],memberIds=args.memberIds??old?.memberIds??[];
  if(!Array.isArray(channelIds)||!Array.isArray(memberIds)||channelIds.length>100||memberIds.length>100)fail('invalid_scope','技能范围无效');
  for(const cid of channelIds)await tx.get('channel',cid);
  if(memberIds.some(mid=>!identity.members.some(m=>m.id===mid&&m.status!=='disabled')))fail('invalid_member','技能成员不可用');
  const status=args.enabled===undefined?(old?.status||'enabled'):args.enabled?'enabled':'disabled';
  const next=tx.put('workspace_skill',{...old,...spec,id:old?.id||id('skill'),source:String(args.source??old?.source??'本地导入').slice(0,1000),channelIds,memberIds,status,version:(old?.version||0)+1,lastEditorId:actor.memberId||'owner',createdAt:old?.createdAt||tx.now});
  tx.put('skill_version',{...next,id:next.id+':'+next.version,parentId:next.id,createdAt:tx.now});
  return publicSkill(next);
 });
}
