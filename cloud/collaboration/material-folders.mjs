import {materialCommand} from './materials.mjs';
import {fail,id,required} from './repository.mjs';
const materialKinds={document:'channel_doc',file:'shared_file',link:'channel_link'};
const string={type:'string'};
export const FOLDER_TOOLS=[
 {name:'manage_folder',description:'在本群资料区创建、重命名或移动文件夹。action=create/update/delete；parentFolderId 留空为资料根目录。只允许删除空文件夹，不能跨群移动。',inputSchema:{type:'object',properties:{requestId:string,channelId:string,action:string,folderId:string,title:string,parentFolderId:string,expectedVersion:{type:'integer',minimum:1}},required:['requestId','channelId','action'],additionalProperties:false}},
 {name:'move_material',description:'将本群文档、文件或链接移动到资料文件夹，kind=document/file/link。folderId 留空移到根目录。ID和内容版本不变，原消息引用继续有效。',inputSchema:{type:'object',properties:{requestId:string,channelId:string,kind:{type:'string',enum:Object.keys(materialKinds)},id:string,folderId:string,expectedVersion:{type:'integer',minimum:0}},required:['requestId','channelId','kind','id'],additionalProperties:false}},
];
export async function folderAccess(repo,channelId,folderId){if(!folderId)return null;const f=await repo.get('channel_folder',folderId);if(f.scopeId!==channelId||f.status==='deleted')fail('invalid_folder','文件夹不属于本群或已删除',403);return f;}
export async function allFolders(repo,channelId){const result=[];let after='';for(;;){const rows=await repo.list('channel_folder',{scope:channelId,after,limit:501});result.push(...rows);if(rows.length<501)break;after=rows.at(-1).id;}return result.filter(f=>f.status!=='deleted');}
export async function allPlacements(repo,channelId){const result=[];let after='';for(;;){const rows=await repo.list('material_placement',{scope:channelId,after,limit:501});result.push(...rows);if(rows.length<501)break;after=rows.at(-1).id;}return result;}
export async function placeMaterial(tx,channelId,kind,objectId,folderId,actor,expectedVersion){
 if(!materialKinds[kind])fail('invalid_kind','只支持移动文档、文件或链接');
 const item=await tx.get(materialKinds[kind],objectId);if(item.scopeId!==channelId||item.status==='deleted')fail('forbidden','资料不属于本群或已移除',403);
 await folderAccess(tx,channelId,folderId);
 const key=kind+':'+objectId,old=await tx.get('material_placement',key,false);
 if(expectedVersion!==undefined&&expectedVersion!==(old?.version||0))fail('version_conflict','这份资料的位置已变化，请刷新后再移动',409);
 return tx.put('material_placement',{id:key,scopeId:channelId,parentId:folderId||channelId,folderId:folderId||null,objectKind:kind,objectId,version:(old?.version||0)+1,lastEditorId:actor.memberId||'owner',createdAt:old?.createdAt||tx.now});
}
export async function folderCommand(tx,actor,cmd,channel){
 if(cmd.type==='channel.material.move')return placeMaterial(tx,channel.id,cmd.kind,cmd.id,cmd.folderId,actor,cmd.expectedVersion);
 if(!['create','update','delete'].includes(cmd.action))fail('invalid_action','文件夹操作无效');
 const old=cmd.action==='create'?null:await folderAccess(tx,channel.id,cmd.folderId);
 if(cmd.action!=='create'&&!old)fail('folder_required','请选择文件夹');
 if(old&&cmd.expectedVersion!==undefined&&cmd.expectedVersion!==old.version)fail('version_conflict','文件夹已变化，请刷新后再操作',409);
 const folders=await allFolders(tx,channel.id);
 if(cmd.action==='delete'){
  if(folders.some(f=>f.parentFolderId===old.id))fail('folder_not_empty','文件夹内还有子文件夹，请先移动内容');
  for(const item of await allPlacements(tx,channel.id)){if(item.folderId!==old.id)continue;const doc=await tx.get(materialKinds[item.objectKind],item.objectId,false);if(doc&&doc.status!=='deleted')fail('folder_not_empty','文件夹内还有资料，请先移出，资料不会被删除');}
  return materialCommand(tx,actor,{action:'delete',kind:'folder',id:old.id,expectedVersion:old.version},channel);
 }
 const parentFolderId=cmd.parentFolderId===undefined?(old?.parentFolderId||null):(cmd.parentFolderId||null);
 await folderAccess(tx,channel.id,parentFolderId);
 let ancestor=parentFolderId,depth=0;const visited=new Set([old?.id].filter(Boolean));
 while(ancestor){if(visited.has(ancestor))fail('folder_cycle','不能把文件夹移动到自身或它的子文件夹里');visited.add(ancestor);if(++depth>32)fail('folder_depth','文件夹层级过深，请选择上层目录');ancestor=folders.find(f=>f.id===ancestor)?.parentFolderId;}
 const title=required(cmd.title??old?.title,'文件夹名称',100);
 if(/[\\/\u0000-\u001f]/.test(title)||['.','..'].includes(title))fail('invalid_folder_name','名称不能包含路径分隔符或控制字符');
 if(folders.some(f=>f.id!==old?.id&&(f.parentFolderId||null)===parentFolderId&&f.title.toLocaleLowerCase()===title.toLocaleLowerCase()))fail('folder_exists','这个位置已有同名文件夹');
 return tx.put('channel_folder',{...old,id:old?.id||id('folder'),scopeId:channel.id,parentId:parentFolderId||channel.id,parentFolderId,title,status:'active',version:(old?.version||0)+1,authorId:old?.authorId||actor.memberId||'owner',lastEditorId:actor.memberId||'owner',createdAt:old?.createdAt||tx.now});
}
