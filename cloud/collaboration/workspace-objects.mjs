import {taskCommand,enrichTask,taskSourceMessages} from './task-deliverables.mjs';
import {validateTaskGroup,listTaskGroups,taskSummaries} from './task-groups.mjs';
import {bindTaskSkills} from './skill-bindings.mjs';
import {memoryAuthority,queueMemoryIndex,recordMemoryEvent,sourcesAvailable} from './memory-context.mjs';
import {workspaceGrant} from './delegation.mjs';
import {placeMaterial} from './material-folders.mjs';
import {fail,id,required} from './repository.mjs';
import {publicMeeting} from './meetings.mjs';

const kinds={memory:'channel_memory',task:'channel_task',link:'channel_link',document:'channel_doc',file:'shared_file',meeting:'channel_meeting',message:'channel_message'};
const schemas={string:{type:'string'},number:{type:'integer',minimum:1},array:{type:'array',items:{type:'string'},maxItems:30}};
const refSchema={type:'array',maxItems:20,items:{type:'object',properties:{kind:{type:'string',enum:Object.keys(kinds)},id:{type:'string'},version:{type:'integer',minimum:1}},required:['kind','id'],additionalProperties:false}};
const tool=(name,description,props,requiredKeys)=>({name,description,inputSchema:{type:'object',properties:Object.fromEntries(Object.entries(props).map(([k,v])=>[k,typeof v==='object'?v:schemas[v]])),required:requiredKeys,additionalProperties:false}});
export const SPACE_TOOLS=[
 tool('read_space_object','读取消息引用的资料、Todo、记忆及具体版本；kind 为 document/file/link/task/memory/message/meeting。文件原件仍用 read_shared_file。',{channelId:'string',kind:'string',id:'string',version:'number'},['channelId','kind','id']),
 tool('search_memory','按问题召回获授权的共享记忆，合并语义和关键词检索并说明降级状态；只使用有效且有来源的内容，待核实不当用户指令。',{channelId:'string',query:'string',after:'string'},['channelId']),
 tool('read_memory','读取一条共享记忆及修订和来源。',{channelId:'string',memoryId:'string'},['channelId','memoryId']),
 tool('revise_memory','修正共享记忆，先读取并带 expectedVersion。成员自动维护并保留来源，不需用户逐条确认；提案不冒充用户决定。停用用 status=inactive。',{requestId:'string',channelId:'string',memoryId:'string',expectedVersion:'number',title:'string',body:'string',category:'string',status:'string',reason:'string',authority:'string',conditions:'string',memoryScope:'string',sourceMessageId:'string',sourceQuote:'string',refs:refSchema},['requestId','channelId','memoryId','expectedVersion']),
 tool('read_todo','读取任务或 Todo；不传 taskId 时按任务列出，parentTaskId 列出其 Todo。支持 query/filter(active/done/all)/after 分页。',{channelId:'string',taskId:'string',parentTaskId:'string',query:'string',filter:'string',after:'string',view:'string',submissionId:'string'},['channelId']),
];
export const referenceSchema=refSchema;
export async function access(repo,channelId,actor){const c=await repo.get('channel',channelId);if(!actor.owner&&!c.memberIds.includes(actor.memberId)&&!await workspaceGrant(repo,actor))fail('forbidden','你不在这个群内',403);return c;}
async function exactVersion(repo,kind,parent,version){
 const database=repo.db||repo.repo.db,workspaceId=repo.workspaceId||repo.repo.workspaceId;
 const row=await database.prepare("SELECT id FROM hub_v2_records WHERE workspace_id=? AND kind=? AND parent_id=? AND CAST(json_extract(body,'$.version') AS INTEGER)=? LIMIT 1").bind(workspaceId,kind,parent,version).first();
 return row?repo.get(kind,row.id):null;
}
export async function validateRefs(repo,channelId,refs=[]){
 if(!Array.isArray(refs)||refs.length>20)fail('invalid_refs','最多关联20项资料');
 const out=[];
 for(const r of refs){
  if(!r||!kinds[r.kind]||typeof r.id!=='string')fail('invalid_refs','引用格式无效');
  const item=await repo.get(kinds[r.kind],r.id);
  if(item.scopeId!==channelId||item.status==='deleted'||item.hidden)fail('forbidden','引用不在本群或已移除',403);
  const version=r.version??item.version??1;
  if(!Number.isInteger(version)||version<1||version>(item.version||1))fail('invalid_version','引用版本不存在');
  if(version!==(item.version||1)&&!['document','file','memory','task'].includes(r.kind))fail('version_conflict','此引用已有变化，请重新选择',409);
  if(version!==(item.version||1)){
   const historyKind={document:'channel_doc_version',file:'shared_file_version',memory:'channel_memory_version',task:'channel_task_version'}[r.kind];
   if(!await exactVersion(repo,historyKind,item.id,version))fail('invalid_version','历史版本不存在');
  }
  out.push({kind:r.kind,id:item.id,version,title:item.title||item.name||item.body?.slice(0,70)||'消息',channelId});
 }
 return [...new Map(out.map(r=>[r.kind+':'+r.id,r])).values()];
}
const text=(v,max=12000)=>typeof v==='string'?v.trim().slice(0,max):'';
function checkVersion(old,cmd){if(old&&cmd.expectedVersion!==undefined&&cmd.expectedVersion!==(old.version||1))fail('version_conflict','内容已更新，请刷新后再修改',409);}
async function save(repo,kind,next,old,actor,reason){
 if(old&&!old.version)repo.put(kind+'_version',{...old,id:old.id+':1',parentId:old.id,version:1});
 const result=repo.put(kind,{...next,version:old?(old.version||1)+1:1,lastEditorId:actor.memberId||'owner',updatedAt:repo.now});
 repo.put(kind+'_version',{...result,id:result.id+':'+result.version,parentId:result.id,reason:text(reason,1000),createdAt:repo.now});
 return result;
}
export async function spaceCommand(tx,identity,actor,cmd,channel,helpers){
 const type=cmd.type,authorId=actor.memberId||'owner';
 if(type==='channel.link'){
  const old=cmd.linkId?await tx.get('channel_link',cmd.linkId):null;
  if(old?.scopeId&&old.scopeId!==channel.id)fail('forbidden','链接不属于本群',403);
  checkVersion(old,cmd);
  if(cmd.action==='delete'){if(!actor.owner&&old.authorId!==authorId)fail('forbidden','只能移除自己添加的链接',403);return tx.put('channel_link',{...old,status:'deleted',version:(old.version||1)+1});}
  let url;try{url=new URL(cmd.url);}catch{fail('invalid_url','请输入完整的网址');}if(!['https:','http:'].includes(url.protocol)||url.username||url.password)fail('invalid_url','只支持不含登录密码的网页链接');
  const link=tx.put('channel_link',{id:old?.id||id('link'),scopeId:channel.id,parentId:channel.id,title:required(cmd.title,'链接名称',300),url:url.href,body:text(cmd.body),status:'active',version:(old?.version||0)+1,authorId:old?.authorId||authorId,createdAt:old?.createdAt||tx.now,updatedAt:tx.now});
  if(cmd.folderId)await placeMaterial(tx,channel.id,'link',link.id,cmd.folderId,actor);
  return link;
 }
 if(['channel.remember','channel.memory.update','channel.memory.review'].includes(type)){
  const old=cmd.memoryId?await tx.get('channel_memory',cmd.memoryId):null;
  if(old&&old.scopeId!==channel.id)fail('forbidden','记忆不属于本群',403);
  if(old?.status==='deleted')fail('not_found','这条记忆已删除',404);
  if(type!=='channel.remember'&&!old)fail('invalid_memory','请选择记忆');
  checkVersion(old,cmd);
  let status=cmd.status??old?.status??'approved';
  if(!['approved','pending','inactive','rejected'].includes(status))fail('invalid_status','记忆状态无效');
  if(type==='channel.memory.review'&&!actor.owner&&!await workspaceGrant(tx,actor))fail('forbidden','请用户确认',403);
  const refs=cmd.refs===undefined?(old?.refs||[]):await validateRefs(tx,channel.id,cmd.refs);
  const category=cmd.category||old?.category||'background';
  if(!['background','requirement','decision','experience'].includes(category))fail('invalid_category','记忆类型无效');
  const provenance=await memoryAuthority(tx,actor,cmd,channel,refs,old);
  if(!actor.owner&&!refs.length)fail('source_required','自动记忆需要来源，不要求用户审批');
  if(!await sourcesAvailable(tx,actor,{scopeId:channel.id,refs}))fail('source_changed','来源已变化，请读取最新版本',409);
  if(!actor.owner&&['user_directive','observation'].includes(provenance.authority)&&cmd.status===undefined)status='approved';
  const result=await save(tx,'channel_memory',{...old,...provenance,id:old?.id||id('memory'),scopeId:channel.id,parentId:channel.id,title:required(cmd.title??old?.title,'记忆标题',160),body:required(cmd.body??old?.body,'记忆正文',12000),category,refs,status,authorId:old?.authorId||authorId,evidence:actor.owner?'用户记录':provenance.authority==='user_directive'?'依据用户原话':provenance.authority==='observation'?'有来源的背景事实':'成员提案，未作为用户决定',createdAt:old?.createdAt||tx.now},old,actor,cmd.reason);
  queueMemoryIndex(tx,result);return result;
 }
 if(type==='channel.task')return taskCommand(tx,identity,actor,cmd,channel,helpers,{save,validateRefs});

 return null;
}
export const publicMemory=m=>({...m,version:m.version||1,category:m.category||'background',evidence:m.evidence||'历史记录，未保留原始依据',refs:m.refs||[]});
export async function readSpaceObject(repo,actor,args,{recordRead=true}={}){
 await access(repo,args.channelId,actor);
 const kind=args.kind|| (args.memoryId?'memory':args.taskId?'task':'memory');
 if(!['memory','task','link','document','file','meeting','message'].includes(kind))fail('invalid_kind','对象类型无效');
 const key=args.id||args.memoryId||args.taskId;
 if(!key&&kind==='task'&&(args.grouped||args.parentTaskId))return listTaskGroups(repo,args.channelId,args);
 if(!key){
  const q=text(args.query,300).toLocaleLowerCase();
  let sql="SELECT body FROM hub_v2_records WHERE workspace_id=? AND kind=? AND scope_id=? AND id>? AND COALESCE(status,'')!='deleted' AND COALESCE(json_extract(body,'$.hidden'),0)=0";
  const params=[repo.workspaceId,kinds[kind],args.channelId,args.after||''];
  if(!actor.owner&&kind==='memory')sql+=" AND status='approved'";
  if(q){sql+=" AND (instr(lower(COALESCE(json_extract(body,'$.title'),'')),?)>0 OR instr(lower(COALESCE(json_extract(body,'$.body'),'')),?)>0)";params.push(q,q);}
  const result=await repo.db.prepare(sql+' ORDER BY id LIMIT 101').bind(...params).all();
  const rows=result.results.map(r=>JSON.parse(r.body));
  const items=rows.slice(0,100).map(({objectKey,...m})=>kind==='meeting'?publicMeeting(m,actor):m).filter(Boolean);
  return {items:kind==='memory'?(await Promise.all(items.map(async m=>actor.owner||await sourcesAvailable(repo,actor,m)?publicMemory(m):null))).filter(Boolean):items,next:rows.length>100?rows[99].id:null,retrieval:'keyword'};
 }
 let item=await repo.get(kinds[kind],key);
 if(kind==='task'&&item.scopeId===args.channelId&&args.view==='history'){const table=args.submissionId?'channel_task_check':'channel_task_submission';const items=(await repo.list(table,{scope:args.channelId,parent:item.id,after:args.after||'',limit:101})).filter(x=>!args.submissionId||x.submissionId===args.submissionId);return{items:items.slice(0,100),next:items.length>100?items[99].id:null};}
 if(kind==='meeting'){item=publicMeeting(item,actor);if(!item)fail('forbidden','无权查看这场会议',403);}
 if(item.scopeId!==args.channelId||item.status==='deleted'||item.hidden||(!actor.owner&&kind==='memory'&&item.status!=='approved'))fail('forbidden','此内容不可访问',403);
 let versions=[];
 if(['memory','task','document','file'].includes(kind))versions=await repo.list(kind==='document'?'channel_doc_version':kind==='file'?'shared_file_version':kinds[kind]+'_version',{parent:key,limit:100,order:'recent'});
 const selected=args.version?Number(args.version):item.version||1;
 const data=selected===(item.version||1)?item:await exactVersion(repo,kind==='document'?'channel_doc_version':kind==='file'?'shared_file_version':kinds[kind]+'_version',key,selected);
 if(!data)fail('not_found','历史版本不存在',404);
 // Agent memory reads never revive inactive/superseded content as live context.
 if(!actor.owner&&kind==='memory'&&!await sourcesAvailable(repo,actor,item))fail('source_changed','记忆来源已变化，请核对当前原件',409);
 if(!actor.owner&&kind==='memory'&&selected!==(item.version||1))fail('forbidden','成员只能读取当前有效记忆',403);
 const {objectKey,...safeData}=data;
 if(recordRead&&actor.memberId&&['memory','document'].includes(kind))await repo.transact('read:'+id('r'),{kind,key,actor},tx=>tx.put('shared_read',{id:key+':'+actor.memberId,parentId:key,scopeId:item.scopeId,memberId:actor.memberId,version:selected,createdAt:tx.now}));
 const taskInfo=kind==='task'?{sourceMessages:await taskSourceMessages(repo,{id:args.channelId},data),subtasks:selected===(item.version||1)?(await taskSummaries(repo,[item]))[0].subtasks:null,parentTask:data.parentTaskId?((p)=>({id:p.id,title:p.title,status:p.status}))(await repo.get('channel_task',data.parentTaskId)):null}:{};
 return {...(kind==='task'?await enrichTask(repo,safeData,{historical:selected!==(item.version||1)}):safeData),...taskInfo,id:item.id,currentVersion:item.version||1,version:selected,versions:actor.owner?versions.map(({objectKey,...v})=>v):[],...(kind==='memory'?{evidence:publicMemory(item).evidence}:{})};
}
