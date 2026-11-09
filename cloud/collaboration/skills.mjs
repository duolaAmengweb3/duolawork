import {seedSkills} from './builtin-skills.mjs';
import {parse} from 'yaml';
import {fail,id,required} from './repository.mjs';
import {requireManager,workspaceGrant} from './delegation.mjs';
import {access,validateRefs,readSpaceObject,referenceSchema} from './workspace-objects.mjs';
import {skillAllowed} from './skill-bindings.mjs';
import {fileText,fileBytes,fileHash,resourceWarnings,importGithubSkill} from './skill-package.mjs';
import {activityPage} from './service-activity.mjs';
const string={type:'string'},integer={type:'integer',minimum:1},strings={type:'array',items:string,maxItems:20};
const filesSchema={type:'object',additionalProperties:{anyOf:[string,{type:'object',properties:{encoding:{const:'base64'},data:string},required:['encoding','data'],additionalProperties:false}]}};
const tool=(name,description,properties,required)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
export const SKILL_TOOLS=[
 tool('read_skill','按需读取技能和资源；version/taskId 保留本次任务使用的版本，返回 readId。支持二进制资源 base64。执行仍在原环境；先核对 compatibility 和缺失资源，不代表已安装。',{channelId:string,skillId:string,path:string,version:integer,taskId:string},['channelId']),
 tool('report_skill_use','记录自己这一次使用、失败或缺依赖，关联任务、实际环境和结果。不是独立核验；旧版本回报必须带其 readId。不要上传凭证。',{requestId:string,channelId:string,skillId:string,version:integer,readId:string,taskId:string,summary:string,outcome:{type:'string',enum:['used','failed','blocked']},environment:string,dependencyStatus:{type:'string',enum:['ready','missing','unknown']},missingDependencies:strings,execution:{type:'array',maxItems:20,items:{type:'object',properties:{command:string,exitCode:{type:'integer'},artifact:string},required:['command','exitCode'],additionalProperties:false}},refs:referenceSchema},['requestId','channelId','skillId','version','summary']),
 tool('skill_activity','查看本群技能读取、使用和具体产物的核验记录；不同成员、版本、任务分别记录，不自动通知他人。',{channelId:string,skillId:string,taskId:string,after:string},['channelId']),
 tool('review_skill_use','核对另一位成员的某次技能使用及实际产物，保留证据和分歧。不能给自己的使用做独立核验，不扩大技能权限。',{requestId:string,channelId:string,useId:string,outcome:{type:'string',enum:['passed','failed']},summary:string,refs:referenceSchema},['requestId','channelId','useId','outcome','summary']),
 tool('save_method','从本群实际工作保存可复用方法，必须有来源、适用条件与局限。默认仅本群可用、非强制规范；有争议可保存为草稿。不自动发布全工作区，不执行脚本。',{requestId:string,channelId:string,skillId:string,expectedVersion:integer,files:filesSchema,conditions:string,limitations:string,refs:referenceSchema,draft:{type:'boolean'}},['requestId','channelId','files','conditions','limitations','refs'])
];
export function parseSkill(files){
 if(!files||typeof files!=='object'||Array.isArray(files)||Object.keys(files).length>40)fail('invalid_skill','技能文件无效');
 let size=0;
 for(const [name,body] of Object.entries(files)){
  if(name.startsWith('/')||name.includes('\\')||name.split('/').some(p=>!p||p==='..'||p==='.')||/[\x00-\x1f]/.test(name))fail('invalid_skill','技能文件路径无效');
  size+=fileBytes(body).length;
 }
 if(size>150000||JSON.stringify(files).length>220000)fail('too_large','技能包请控制在150KB以内，较大资源可保留来源链接');
 const content=fileText(files['SKILL.md']);if(!content)fail('invalid_skill','需要包含 UTF-8 文本 SKILL.md');
 const match=content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);if(!match)fail('invalid_skill','SKILL.md 需要 YAML 名称和用途说明');
 let metadata;try{metadata=parse(match[1],{maxAliasCount:0});}catch{fail('invalid_skill','技能元数据不是有效 YAML');}
 const name=required(metadata?.name,'技能名称',64),description=required(metadata?.description,'技能用途',1024);
 if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))fail('invalid_skill','技能名称请使用小写字母、数字和短横线');
 return {name,description,compatibility:String(metadata.compatibility||'').slice(0,500),hasScripts:Object.keys(files).some(f=>f.startsWith('scripts/')),resourceWarnings:resourceWarnings(files),files};
}
export const skillAvailable=skillAllowed;
export const publicSkill=({files,...s})=>({...s,fileNames:Object.keys(files||{}),availability:s.status==='enabled'?'available':s.status==='draft'?'draft':'disabled',nativeInstallation:'not_asserted'});
async function sourcesAccessible(repo,actor,skill){
 if(!skill.derivedFrom)return true;
 try{for(const ref of skill.derivedFrom.refs)await readSpaceObject(repo,actor,{channelId:skill.derivedFrom.channelId,kind:ref.kind,id:ref.id,version:ref.version},{recordRead:false});return true;}catch{return false;}
}
export async function skillCatalog(repo,actor,channelId){
 const channel=await access(repo,channelId,actor);await seedSkills(repo);
 const skills=(await repo.list('workspace_skill',{limit:500})).filter(s=>skillAvailable(s,actor,channelId,channel.resourcePreferences));
 return (await Promise.all(skills.map(async s=>await sourcesAccessible(repo,actor,s)?publicSkill(s):null))).filter(Boolean);
}
async function taskContext(repo,channelId,taskId){
 if(!taskId)return null;const task=await repo.get('channel_task',taskId);if(task.scopeId!==channelId)fail('forbidden','任务不属于本群',403);return task;
}
async function skillVersion(repo,skill,version){
 if(version===undefined||version===skill.version)return skill;
 if(!Number.isInteger(version)||version<1)fail('invalid_version','技能版本无效');
 const history=await repo.get('skill_version',skill.id+':'+version,false);if(!history)fail('invalid_version','技能版本不存在');return {...history,id:skill.id};
}
async function reviewUse(repo,actor,args){
 return repo.transact(args.requestId,{actor,args},async tx=>{
  await access(tx,args.channelId,actor);
  const current=await tx.get('skill_activity',args.useId,false),legacy=current?null:await tx.get('skill_use',args.useId,false);
  const use=current||(legacy?{...legacy,event:'use'}:null);
  if(!use||use.scopeId!==args.channelId||use.event!=='use')fail('invalid_use','请选择本群的一次使用记录');
  const skill=await tx.get('workspace_skill',use.parentId);
  if(!skillAvailable(skill,actor,args.channelId,(await access(tx,args.channelId,actor)).resourcePreferences)||!await sourcesAccessible(tx,actor,skill))fail('forbidden','技能当前不在你的使用范围',403);
  if(use.memberId===(actor.memberId||'owner'))fail('self_review','自己的使用不能标为独立核验',403);
  if(!['passed','failed'].includes(args.outcome))fail('invalid_outcome','请选择核验结论');
  const refs=await validateRefs(tx,args.channelId,args.refs||[]);if(!actor.owner&&!refs.length)fail('source_required','请关联实际核对的产物或消息');
  return tx.put('skill_activity',{id:id('skill_review'),parentId:use.parentId,scopeId:args.channelId,memberId:actor.memberId||'owner',event:'review',version:use.version,taskId:use.taskId||null,taskTitle:use.taskTitle||null,useId:use.id,outcome:args.outcome,summary:required(args.summary,'核验依据',4000),refs,evidence:actor.owner?'owner_reviewed':'peer_reviewed',createdAt:tx.now});
 });
}
async function saveMethod(repo,actor,args){
 const channel=await access(repo,args.channelId,actor),spec=parseSkill(args.files);
 const conditions=required(args.conditions,'适用条件',2000),limitations=required(args.limitations,'局限或不适用情况',2000);
 const refs=await validateRefs(repo,args.channelId,args.refs||[]);if(!refs.length)fail('source_required','请关联这个方法实际来自的任务、文档或消息');
 return repo.transact(args.requestId,{actor,args},async tx=>{
  await access(tx,args.channelId,actor);await validateRefs(tx,args.channelId,refs);
  const old=args.skillId?await tx.get('workspace_skill',args.skillId):null;
  if(old&&(old.derivedFrom?.channelId!==channel.id||old.channelIds?.length!==1))fail('forbidden','只能在本群修订本群沉淀的方法',403);
  if(old&&!actor.owner&&old.authorId!==actor.memberId&&channel.coordinatorId!==actor.memberId&&!await workspaceGrant(tx,actor))fail('forbidden','请由方法作者或负责人修订',403);
  if(old&&old.version!==args.expectedVersion)fail('version_conflict','方法已有更新，请先读取',409);
  const next=tx.put('workspace_skill',{...old,...spec,id:old?.id||id('skill'),authorId:old?.authorId||actor.memberId||'owner',source:'本群工作方法',derivedFrom:{channelId:channel.id,refs,conditions,limitations},channelIds:[channel.id],memberIds:old?.memberIds||[],status:args.draft?'draft':'enabled',mandatory:false,version:(old?.version||0)+1,lastEditorId:actor.memberId||'owner',createdAt:old?.createdAt||tx.now});
  tx.put('skill_version',{...next,id:next.id+':'+next.version,parentId:next.id,createdAt:tx.now});return publicSkill(next);
 });
}
export async function skillTool(repo,actor,name,args){
 if(name==='save_method')return saveMethod(repo,actor,args);
 if(name==='review_skill_use')return reviewUse(repo,actor,args);
 await access(repo,args.channelId,actor);const task=await taskContext(repo,args.channelId,args.taskId);
 if(name==='skill_activity'){
  if(args.skillId&&!actor.owner){const s=await repo.get('workspace_skill',args.skillId);if(!skillAvailable(s,actor,args.channelId,(await access(repo,args.channelId,actor)).resourcePreferences)||!await sourcesAccessible(repo,actor,s))fail('forbidden','技能当前不可用',403);}
  const page=await activityPage(repo,'skill_activity',{scope:args.channelId,parent:args.skillId,taskId:args.taskId,after:args.after});
  if(actor.owner)return page;
  const allowed=new Set((await skillCatalog(repo,actor,args.channelId)).map(s=>s.id));return {...page,items:page.items.filter(x=>allowed.has(x.parentId))};
 }
 const catalog=await skillCatalog(repo,actor,args.channelId);
 if(!args.skillId){if(name!=='read_skill')fail('invalid_skill','请选择技能');return {items:catalog};}
 const skill=await repo.get('workspace_skill',args.skillId);if(!catalog.some(s=>s.id===skill.id))fail('forbidden','此技能未在当前范围启用',403);
 if(name==='read_skill'){
  const selected=args.version??task?.skillRefs?.find(r=>r.skillId===skill.id)?.version??skill.version;
  const version=await skillVersion(repo,skill,selected);if(!await sourcesAccessible(repo,actor,version))fail('source_changed','方法来源已不可用，请核对最新来源',409);
  const path=args.path||'SKILL.md';if(!Object.hasOwn(version.files,path))fail('not_found','技能资源未提供，请补齐文件或核对来源',404);
  const value=version.files[path],sha256=await fileHash(value);
  const receipt=await repo.transact(id('skill_read'),{actor,args},async tx=>{await access(tx,args.channelId,actor);const fresh=await tx.get('workspace_skill',skill.id);if(fresh.version!==skill.version||!skillAvailable(fresh,actor,args.channelId,(await access(tx,args.channelId,actor)).resourcePreferences))fail('version_conflict','技能范围或版本已变化，请重试',409);if(!await sourcesAccessible(tx,actor,fresh)||!await sourcesAccessible(tx,actor,version))fail('source_changed','方法来源已变化，请核对来源',409);return tx.put('skill_activity',{id:id('skill_read'),event:'read',parentId:skill.id,scopeId:args.channelId,memberId:actor.memberId||'owner',version:selected,taskId:task?.id||null,taskTitle:task?.title||null,path,sha256,createdAt:tx.now});});
  return {...publicSkill(version),path,body:typeof value==='string'?value:value.data,encoding:typeof value==='string'?'utf-8':'base64',sha256,readId:receipt.id,readAt:receipt.createdAt,execution:'按当前任务需要参考；环境依赖由实际执行者检查，脚本在原环境执行，未宣称安装。'};
 }
 return repo.transact(args.requestId,{actor,args},async tx=>{
  await access(tx,args.channelId,actor);const current=await tx.get('workspace_skill',skill.id);if(!skillAvailable(current,actor,args.channelId,(await access(tx,args.channelId,actor)).resourcePreferences))fail('forbidden','技能范围已改变',403);
  const read=args.readId?await tx.get('skill_activity',args.readId):null;
  if(read&&(read.event!=='read'||read.parentId!==skill.id||read.version!==args.version||read.scopeId!==args.channelId||read.memberId!==(actor.memberId||'owner')||read.taskId&&read.taskId!==args.taskId))fail('invalid_read','读取记录不属于本次成员、任务或版本');
  if(args.version!==current.version&&!read)fail('version_conflict','旧版本使用请关联当时的 readId',409);
  if(!await sourcesAccessible(tx,actor,current))fail('source_changed','方法来源已不可用',409);
  const version=await skillVersion(tx,current,args.version),outcome=args.outcome||'used',dependencyStatus=args.dependencyStatus||'unknown';
  if(!['used','failed','blocked'].includes(outcome)||!['unknown','ready','missing'].includes(dependencyStatus))fail('invalid_outcome','使用状态无效');
  const execution=args.execution||[],missingDependencies=args.missingDependencies||[];
  if(!Array.isArray(execution)||execution.length>20||execution.some(x=>typeof x.command!=='string'||x.command.length>2000||!Number.isInteger(x.exitCode)||x.artifact&&(typeof x.artifact!=='string'||x.artifact.length>2000)))fail('invalid_execution','请提供真实命令、退出结果与产物位置');
  if(!Array.isArray(missingDependencies)||missingDependencies.length>20||missingDependencies.some(x=>typeof x!=='string'||x.length>500))fail('invalid_dependencies','依赖说明无效');
  if(dependencyStatus==='missing'&&outcome==='used')fail('invalid_outcome','必要依赖缺失时请记录为受阻，不能声称已使用成功');
  const refs=await validateRefs(tx,args.channelId,args.refs||[]);
  return tx.put('skill_activity',{id:id('skill_use'),event:'use',parentId:skill.id,scopeId:args.channelId,memberId:actor.memberId||'owner',version:version.version,taskId:task?.id||null,taskTitle:task?.title||null,readId:read?.id||null,summary:required(args.summary,'实际使用结果',4000),outcome,environment:String(args.environment||'未报告').slice(0,500),dependencyStatus,missingDependencies,execution,refs,evidence:'agent_reported',createdAt:tx.now});
 });
}
export async function skillSettings(repo,identity,actor,args,fetchImpl=fetch){
 await requireManager(repo,actor);await seedSkills(repo);
 if(args.action==='catalog')return {items:await skillCatalog(repo,actor,args.channelId)};
 if(args.action==='method')return saveMethod(repo,actor,args);
 if(args.action==='review')return reviewUse(repo,actor,args);
 if(args.action==='activity')return activityPage(repo,'skill_activity',{parent:required(args.skillId,'技能',100),after:args.after});
 if(args.action==='read')return repo.get('workspace_skill',required(args.skillId,'技能',100));
 if(args.action==='list')return {items:(await repo.list('workspace_skill',{limit:500,order:'recent'})).map(publicSkill)};
 if(!['save','rollback'].includes(args.action))fail('invalid_action','技能操作无效');
 if(args.sourceUrl)args={...args,...await importGithubSkill(args.sourceUrl,fetchImpl)};
 return repo.transact(args.requestId,{actor,args},async tx=>{
  await requireManager(tx,actor);const old=args.skillId?await tx.get('workspace_skill',args.skillId):null;
  if(old&&old.version!==args.expectedVersion)fail('version_conflict','技能已有变化，请刷新',409);
  let spec,history;
  if(args.action==='rollback'){history=await tx.get('skill_version',args.skillId+':'+args.version);spec=parseSkill(history.files);}
  else if(args.files)spec=parseSkill(args.files);else if(!old)fail('invalid_skill','请添加 SKILL.md');
  const channelIds=args.channelIds??old?.channelIds??[],memberIds=args.memberIds??old?.memberIds??[];
  if(!Array.isArray(channelIds)||!Array.isArray(memberIds)||channelIds.length>100||memberIds.length>100)fail('invalid_scope','技能范围无效');
  for(const cid of channelIds)await tx.get('channel',cid);
  if(memberIds.some(mid=>!identity.members.some(m=>m.id===mid&&m.status!=='disabled')))fail('invalid_member','技能成员不可用');
  if(old?.derivedFrom&&(channelIds.length!==1||channelIds[0]!==old.derivedFrom.channelId))fail('private_sources','此方法引用本群来源，不能直接扩大共享范围；请另存不含私有信息的方法');
  const status=args.enabled===undefined?(old?.status||'enabled'):args.enabled?'enabled':'disabled';
  if(old&&!await tx.get('skill_version',old.id+':'+old.version,false))tx.put('skill_version',{...old,id:old.id+':'+old.version,parentId:old.id});
  const next=tx.put('workspace_skill',{...old,...spec,id:old?.id||id('skill'),source:String(args.source??history?.source??old?.source??'本地导入').slice(0,1000),sourceRevision:(args.sourceRevision??history?.sourceRevision??(args.files?null:old?.sourceRevision))||null,channelIds,memberIds,status,mandatory:false,version:(old?.version||0)+1,lastEditorId:actor.memberId||'owner',createdAt:old?.createdAt||tx.now});
  tx.put('skill_version',{...next,id:next.id+':'+next.version,parentId:next.id,createdAt:tx.now});return publicSkill(next);
 });
}
