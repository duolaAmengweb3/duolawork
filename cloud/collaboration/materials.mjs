import {queueMemoryIndex} from './memory-context.mjs';
import {fail,id,required} from './repository.mjs';
const kinds={document:'channel_doc',file:'shared_file',link:'channel_link',folder:'channel_folder'};
const string={type:'string'};
export const MATERIAL_TOOLS=[{name:'manage_material',description:'本群成员和用户都可删除、恢复或重命名资料。删除移入回收站，可恢复，ID不变。kind=document/file/link/folder；action=trash/delete/restore/rename。删除文件夹默认仅移除目录、保留内容；withContents=true才连同内容移除。先读取当前版本，写操作带expectedVersion。',inputSchema:{type:'object',properties:{requestId:string,channelId:string,action:{type:'string',enum:['trash','delete','restore','rename']},kind:{type:'string',enum:Object.keys(kinds)},id:string,title:string,expectedVersion:{type:'integer',minimum:1},withContents:{type:'boolean'}},required:['requestId','channelId','action'],additionalProperties:false}}];
async function listAll(tx,kind,scope){const result=[];let after='';for(;;){const rows=await tx.list(kind,{scope,after,limit:501});result.push(...rows);if(rows.length<501)return result;after=rows.at(-1).id;}}
async function invalidateSources(tx,channelId,kind,objectId){
 for(const memory of await listAll(tx,'channel_memory',channelId))if(memory.refs?.some(r=>r.kind===kind&&r.id===objectId)&&memory.status==='approved'){const inactive=tx.put('channel_memory',{...memory,status:'inactive',version:(memory.version||1)+1,sourceUnavailable:true,reason:'来源资料已删除，停止使用；恢复资料后需重新核实。'});queueMemoryIndex(tx,inactive);}
}
async function folderName(tx,scopeId,parentId,title,except,{restore=false}={}){
 const siblings=(await listAll(tx,'channel_folder',scopeId)).filter(f=>f.id!==except&&f.status!=='deleted'&&(f.parentFolderId||null)===(parentId||null));
 const used=new Set(siblings.map(f=>f.title.normalize('NFKC').toLocaleLowerCase()));
 if(!used.has(title.normalize('NFKC').toLocaleLowerCase()))return title;
 if(!restore)fail('duplicate_name','这个位置已有同名文件夹，请换一个名称',409);
 let n=1,candidate;do{candidate=title.slice(0,140)+'（恢复'+(n===1?'':n)+'）';n++;}while(used.has(candidate.normalize('NFKC').toLocaleLowerCase()));return candidate;
}
async function saveItem(tx,actor,kind,item,patch){
 const dbKind=kinds[kind],version=(item.version||1)+1;
 if(kind==='document'){
  if(!item.versionId)tx.put('channel_doc_version',{...item,id:`${item.id}:1`,parentId:item.id,version:item.version||1});
  const next={...item,...patch,version,versionId:id('shared_version'),lastEditorId:actor.memberId||'owner'};
  tx.put('channel_doc_version',{...next,id:next.versionId,parentId:item.id,reason:patch.status==='deleted'?'移入回收站':'资料管理',createdAt:tx.now});return tx.put(dbKind,next);
 }
 const next=tx.put(dbKind,{...item,...patch,version,lastEditorId:actor.memberId||'owner'});
 if(kind==='file')tx.put('shared_file_version',{...next,id:`${item.id}:${version}`,parentId:item.id,createdAt:tx.now});
 return next;
}
async function removeOne(tx,actor,kind,item,batchId){
 if(item.status==='deleted')return item;
 const next=await saveItem(tx,actor,kind,item,{status:'deleted',deletedAt:tx.now,deletedBy:actor.memberId||'owner'});
 tx.put('material_trash',{id:kind+':'+item.id,scopeId:item.scopeId,parentId:batchId,objectId:item.id,objectKind:kind,title:item.title||item.name,status:'deleted',previousStatus:item.status||'active',deletedVersion:next.version,batchId,deletedAt:tx.now,deletedBy:actor.memberId||'owner'});
 await invalidateSources(tx,item.scopeId,kind,item.id);return next;
}
export async function materialCommand(tx,actor,cmd,channel,context){
 if(cmd.action==='trash')return {items:await listAll(tx,'material_trash',channel.id).then(rows=>rows.filter(r=>r.status==='deleted'))};
 const kind=cmd.kind;if(!kinds[kind])fail('invalid_kind','资料类型无效');
 const item=await tx.get(kinds[kind],cmd.id);
 if(item.scopeId!==channel.id)fail('forbidden','资料不属于本群',403);
 if(cmd.expectedVersion!==(item.version||1))fail('version_conflict','资料已有变化，请刷新后操作',409);
 if(cmd.action==='restore'){
  const trash=await tx.get('material_trash',kind+':'+item.id);
  if(item.status!=='deleted'||trash.status!=='deleted')fail('invalid_status','这份资料已恢复');
  const batch=kind==='folder'?await tx.list('material_trash',{scope:channel.id,parent:trash.batchId,limit:501}):[trash];
  let result;
  for(const r of batch.filter(r=>r.status==='deleted')){
   const current=await tx.get(kinds[r.objectKind],r.objectId);
   if(current.version!==r.deletedVersion||current.status!=='deleted')continue;
   let parent=current.parentFolderId;
   if(r.objectKind==='folder'&&parent){const folder=await tx.get('channel_folder',parent,false);if(!folder||folder.status==='deleted'&&!batch.some(x=>x.objectId===parent))parent=null;}
   const restored=await saveItem(tx,actor,r.objectKind,current,{status:r.previousStatus,deletedAt:null,deletedBy:null,...(r.objectKind==='folder'?{parentFolderId:parent||null,parentId:parent||channel.id,title:await folderName(tx,channel.id,parent,current.title,current.id,{restore:true})}:{})});
   if(r.objectKind!=='folder'){const placement=await tx.get('material_placement',r.objectKind+':'+r.objectId,false);if(placement?.folderId){const folder=await tx.get('channel_folder',placement.folderId,false);if(!folder||folder.status==='deleted'&&!batch.some(x=>x.objectId===folder.id))tx.put('material_placement',{...placement,folderId:null,parentId:channel.id,version:placement.version+1});}}
   tx.put('material_trash',{...r,status:'restored',restoredAt:tx.now,restoredBy:actor.memberId||'owner'});if(current.id===item.id)result=restored;
  }
  const {objectKey,...safe}=result;return safe;
 }
 if(item.status==='deleted')fail('resource_deleted','资料在回收站，请先恢复',410);
 if(cmd.action==='rename'){
  const title=required(cmd.title,'名称',160);if(kind==='folder'&&/[\\/\u0000-\u001f]/.test(title))fail('invalid_input','文件夹名称无效');
  if(kind==='folder')await folderName(tx,channel.id,item.parentFolderId,title,item.id);
  const {objectKey,...safe}=await saveItem(tx,actor,kind,item,kind==='file'?{name:title}:{title});return safe;
 }
 if(cmd.action!=='delete')fail('invalid_action','资料操作无效');
 const batchId=id('trash');
 if(kind==='folder'){
  const folders=(await listAll(tx,'channel_folder',channel.id)).filter(f=>f.status!=='deleted'),placements=await listAll(tx,'material_placement',channel.id);
  if(cmd.withContents){
   const ids=new Set([item.id]);let changed=true;while(changed){changed=false;for(const f of folders)if(ids.has(f.parentFolderId)&&!ids.has(f.id)){ids.add(f.id);changed=true;}}
   for(const p of placements.filter(p=>ids.has(p.folderId)))await removeOne(tx,actor,p.objectKind,await tx.get(kinds[p.objectKind],p.objectId),batchId);
   for(const f of folders.filter(f=>ids.has(f.id)&&f.id!==item.id))await removeOne(tx,actor,'folder',f,batchId);
  }else{
   for(const p of placements.filter(p=>p.folderId===item.id))tx.put('material_placement',{...p,folderId:item.parentFolderId||null,parentId:item.parentFolderId||channel.id,version:p.version+1});
   for(const f of folders.filter(f=>f.parentFolderId===item.id))tx.put('channel_folder',{...f,parentFolderId:item.parentFolderId||null,parentId:item.parentFolderId||channel.id,version:f.version+1});
  }
 }
 const result=await removeOne(tx,actor,kind,item,batchId);
 if(context){
  const deleted=await tx.list('material_trash',{scope:channel.id,parent:batchId});const targets=new Set();
  for(const r of deleted)for(const row of [...await tx.list('shared_read',{parent:r.objectId}),...await tx.list('shared_watch',{parent:r.objectId})])if(row.memberId!==actor.memberId&&channel.memberIds.includes(row.memberId))targets.add(row.memberId);
  if(targets.size){const m=await context.helpers.channelMessage(tx,channel,actor,`资料已移到回收站：${item.title||item.name}。停止将已删除资料作为当前依据；原会话已读副本不会被远程抹除。`,{type:'material_change',resourceId:item.id,resourceAction:'deleted',hops:0,mentions:[...targets]});for(const mid of targets)await context.helpers.enqueue(tx,context.identity,channel,m,mid);}
 }
 const {objectKey,...safe}=result;return {...safe,undo:{kind,id:result.id,expectedVersion:result.version}};
}
