import {materialCommand} from './materials.mjs';
import {folderAccess,placeMaterial} from './material-folders.mjs';
import { fail, id, required, digest } from './repository.mjs';
import { channelAccess, meetingHelpers, CHANNEL_TOOLS, conversationTool } from './conversation.mjs';
import { base64, unbase64, readBounded } from './security.mjs';
import { fileStore } from './file-store.mjs';

export const CHUNK_SIZE = 65536;
// A versioned wire envelope for hosts that keep the original MCP tool catalog.
// Only the authenticated post_message tool interprets it; ordinary chat text
// (including quoted examples) never executes a command.
export const SHARED_TOOL_ENVELOPE = 'HUB_SHARED_TOOL_V1\n';
const string = { type: 'string' }, integer = { type: 'integer', minimum: 1 };
const refSchema = { type: 'array', maxItems: 30, items: { type: 'object', properties: { kind: { enum: ['file','doc'] }, id: string, version: integer }, required: ['kind','id','version'], additionalProperties: false } };
const tool = (name, description, properties, keys = Object.keys(properties)) => ({ name, description, inputSchema: { type: 'object', properties, required: keys, additionalProperties: false } });
export const SHARED_TOOLS = [
  tool('shared_files', '列出群内共享文件；文件 ID 与版本在所有环境相同。after 用于继续翻页。', {channelId:string, after:string}, ['channelId']),
  tool('begin_file', '发布文件前登记名称、大小和 SHA256。返回 uploadId/chunkSize；按分块上传后 finish_file 才算共享成功。同一 requestId 重试可续传。新文件可指定 folderId；更新已有文件必须带 resourceId/expectedVersion，保留原位置。', {requestId:string,channelId:string,name:string,mime:string,size:integer,sha256:string,resourceId:string,folderId:string,expectedVersion:integer}, ['requestId','channelId','name','size','sha256']),
  tool('write_file_chunk', '上传一块真实文件字节（base64，最多64KiB）。同一块重复提交安全；不同字节不能覆盖。', {uploadId:string,index:{type:'integer',minimum:0},base64:string}),
  tool('file_upload_status', '读取上传进度和已收到的分块，网络中断后继续同一次上传。', {uploadId:string}),
  tool('finish_file', '核对完整大小与哈希后发布文件版本；未完成分块不显示为共享成功。', {uploadId:string}),
  tool('read_shared_file', '读取获授权文件的指定版本，返回最多64KiB真实字节、SHA256及nextOffset；文本另返回text。必须继续分页才是完整文件。', {resourceId:string,version:integer,offset:{type:'integer',minimum:0}}, ['resourceId']),
  tool('handoff', '按需把工作交给群内另一成员。附上目标、已做/待做、确切资料版本与代码提交；普通聊天无需交接。调用会通知接收者。检查结论始终属于提交它的成员，不冒充独立验证。', {requestId:string,channelId:string,toMemberId:string,summary:string,remaining:string,refs:refSchema,code:{type:'object',properties:{url:string,commit:string},required:['url','commit'],additionalProperties:false},sourceMessageId:string}, ['requestId','channelId','toMemberId','summary','remaining']),
  tool('read_handoff', '读取交接内容及版本变化；读取不等于接受或完成。', {handoffId:string}),
  tool('respond_handoff', '接收者核对后回执：received已收到，blocked说明缺口，completed实际完成。checks记录实际运行内容及结果，代码检查必须绑定原提交。outputs引用真实成果版本。', {requestId:string,handoffId:string,status:{enum:['received','blocked','completed']},summary:string,checkedCommit:string,checks:{type:'array',maxItems:20,items:{type:'object',properties:{command:string,result:{enum:['passed','failed','not_run']},detail:string},required:['command','result'],additionalProperties:false}},outputs:refSchema}, ['requestId','handoffId','status','summary']),
];
const who = actor => actor.memberId || 'owner';
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)), x=>x.toString(16).padStart(2,'0')).join('');
const safeName = value => required(value,'文件名',200).replace(/[\x00-\x1f/\\]/g,'_');
const versionId = (resourceId, version) => resourceId + ':' + version;
export async function resourceReferences(repo, actor, channelId, refs = []) {
  if(!Array.isArray(refs)||refs.length>30) fail('invalid_references','最多关联30份资料');
  const result=[];
  for(const ref of refs){
    if(!['file','doc'].includes(ref.kind)||!Number.isSafeInteger(ref.version)||ref.version<1)fail('invalid_references','资料必须带确切版本');
    const kind=ref.kind==='file'?'shared_file':'channel_doc',resource=await repo.get(kind,ref.id);
    if(resource.scopeId!==channelId)fail('forbidden','不能引用其他群的私有资料',403);
    await channelAccess(repo,channelId,actor);
    if(resource.status==='deleted')fail('resource_deleted','资料已移除，不能作为新交接的输入',409);
    if(ref.kind==='file')await repo.get('shared_file_version',versionId(ref.id,ref.version));
    else if(resource.version!==ref.version){
      const versions=await repo.list('channel_doc_version',{parent:ref.id,limit:500});
      if(!versions.some(v=>v.version===ref.version))fail('not_found','资料版本不存在',404);
    }
    result.push({kind:ref.kind,id:ref.id,version:ref.version,title:resource.name||resource.title,currentVersion:resource.version,changed:resource.version!==ref.version});
  }return result;
}
async function notify(tx,identity,channel,actor,body,extra,targets=[]){
  const message=await meetingHelpers.channelMessage(tx,channel,actor,body,{...extra,hops:0,mentions:targets});
  for(const mid of new Set(targets))if(channel.memberIds.includes(mid)&&mid!==actor.memberId)await meetingHelpers.enqueue(tx,identity,channel,message,mid);
  return message;
}
async function readerIds(tx,resourceId){return [...await tx.list('shared_read',{parent:resourceId}),...await tx.list('shared_watch',{parent:resourceId})].map(r=>r.memberId);}
async function readReceipt(repo,actor,resource,version){
  if(!actor.memberId)return;
  await repo.transact('file-read:'+id('r'),{resourceId:resource.id,version,actor},tx=>tx.put('shared_read',{id:resource.id+':'+actor.memberId,parentId:resource.id,scopeId:resource.scopeId,memberId:actor.memberId,version,createdAt:tx.now}));
}
const publicFile = ({objectKey,...r}) => r;
const publicVersion = ({objectKey,...r}) => r;
export async function listSharedFiles(repo,actor,args){
  await channelAccess(repo,args.channelId,actor);
  const rows=await repo.list('shared_file',{scope:args.channelId,after:args.after||'',limit:101});
  return {items:rows.slice(0,100).filter(r=>r.status!=='deleted').map(publicFile),next:rows.length>100?rows[99].id:null};
}
export async function beginFile(repo,actor,args,env){
  const size=args.size,max=Number(env.SHARED_FILE_LIMIT||128*1024*1024),quota=Number(env.SHARED_SPACE_QUOTA||2*1024*1024*1024);
  if(!Number.isSafeInteger(size)||size<1||size>max)fail('file_limit',`单个文件需为1字节至${Math.round(max/1024/1024)}MB`,413);
  if(!/^[a-f0-9]{64}$/.test(args.sha256||''))fail('invalid_hash','需要文件的SHA256');
  const name=safeName(args.name),storage=env.SHARED_FILE_STORAGE||env.FILE_STORAGE||'r2';fileStore(env,storage);
  return repo.transact('shared-begin:'+who(actor)+':'+required(args.requestId,'请求编号',100),{...args,actor},async tx=>{
    await channelAccess(tx,args.channelId,actor);
    await folderAccess(tx,args.channelId,args.folderId);
    if(args.resourceId){const previous=await tx.get('shared_file',args.resourceId);if(previous.scopeId!==args.channelId)fail('forbidden','资料不属于此群',403);if(previous.status==='deleted'||previous.version!==args.expectedVersion)fail('version_conflict','资料已变化，请重读版本后发布',409);}
    const usage=await tx.get('shared_usage','bytes',false)||{id:'bytes',reserved:0,stored:0};
    if(usage.reserved+usage.stored+size>quota)fail('space_limit','共享空间容量不足，历史版本仍占空间；请联系管理员扩容，原文件保留',413);
    tx.put('shared_usage',{...usage,reserved:usage.reserved+size});
    const upload=tx.put('shared_upload',{id:id('upload'),scopeId:args.channelId,parentId:who(actor),authorId:who(actor),announce:args.announce!==false,folderId:args.folderId||null,name,mime:String(args.mime||'application/octet-stream').slice(0,120),size,sha256:args.sha256,resourceId:args.resourceId||id('shared_file'),expectedVersion:args.expectedVersion||0,storage,chunkSize:CHUNK_SIZE,chunks:Math.ceil(size/CHUNK_SIZE),status:'uploading',createdAt:tx.now});
    return upload;
  });
}
async function getUpload(repo,actor,uploadId){const u=await repo.get('shared_upload',uploadId);await channelAccess(repo,u.scopeId,actor);if(u.authorId!==who(actor))fail('forbidden','不能使用其他成员的上传记录',403);return u;}
export async function writeChunk(repo,actor,args,env){
  const u=await getUpload(repo,actor,args.uploadId),index=args.index;
  if(u.status!=='uploading')fail('upload_closed','上传已经结束',409);
  if(!Number.isInteger(index)||index<0||index>=u.chunks)fail('invalid_chunk','分块编号无效');
  let bytes;try{if(typeof args.base64!=='string'||args.base64.length>88000)throw Error();bytes=unbase64(args.base64);}catch{fail('invalid_chunk','文件分块编码无效');}
  if(bytes.length!==Math.min(CHUNK_SIZE,u.size-index*CHUNK_SIZE))fail('invalid_chunk','分块长度不符');
  const sha256=await hash(bytes),key=`${repo.workspaceId}/shared/${u.id}/${index}-${sha256}`;
  const previous=await repo.get('shared_chunk',u.id+':'+index,false);
  if(previous&&previous.sha256!==sha256)fail('chunk_conflict','已上传分块内容不同，请重新选择同一文件',409);
  await fileStore(env,u.storage).put(key,bytes);
  return repo.transact('shared-chunk:'+u.id+':'+index,{sha256},async tx=>{
    const current=await getUpload(tx,actor,u.id);if(current.status!=='uploading')fail('upload_closed','上传已经结束',409);
    return tx.put('shared_chunk',{id:u.id+':'+index,parentId:u.id,scopeId:u.scopeId,index,sha256,objectKey:key,size:bytes.length});
  }).then(r=>({index:r.index,received:r.size,sha256:r.sha256}));
}
async function chunksFor(repo,u){let after='',rows=[];do{const page=await repo.list('shared_chunk',{parent:u.id,after,limit:500});rows.push(...page);after=page.length===500?page.at(-1).id:'';}while(after);return rows.sort((a,b)=>a.index-b.index);}
export async function uploadStatus(repo,actor,args){const u=await getUpload(repo,actor,args.uploadId);return {...u,received:(await chunksFor(repo,u)).map(c=>c.index)};}
export async function finishFile(repo,identity,actor,args,env){
  const u=await getUpload(repo,actor,args.uploadId);
  if(u.status==='published'){const v=await repo.get('shared_file_version',versionId(u.resourceId,u.publishedVersion));return publicFile({...v,id:u.resourceId});}
  if(u.status!=='uploading')fail('upload_closed','上传已取消',409);
  const chunks=await chunksFor(repo,u);
  if(chunks.length!==u.chunks||chunks.some((c,i)=>c.index!==i))fail('upload_incomplete','文件尚未传完，可以继续上传缺失分块',409);
  const store=fileStore(env,u.storage),key=`${repo.workspaceId}/shared/${u.id}/complete-${u.sha256}`;
  if(store.assemble)await store.assemble(chunks.map(c=>c.objectKey),key,{size:u.size,sha256:u.sha256});
  else {const bytes=new Uint8Array(u.size);let offset=0;for(const c of chunks){const o=await store.get(c.objectKey);if(!o)fail('file_missing','分块字节缺失',409);const b=await readBounded(new Response(o.body),CHUNK_SIZE);bytes.set(b,offset);offset+=b.length;}if(offset!==u.size||await hash(bytes)!==u.sha256)fail('hash_mismatch','文件校验失败，尚未发布',409);await store.put(key,bytes);}
  return repo.transact('shared-finish:'+u.id,{uploadId:u.id},async tx=>{
    const upload=await getUpload(tx,actor,u.id),channel=await channelAccess(tx,u.scopeId,actor),previous=await tx.get('shared_file',u.resourceId,false);
    if((previous?.version||0)!==u.expectedVersion||previous?.status==='deleted')fail('version_conflict','文件已有新版本，原上传保留；请核对后重新发布',409);
    const version=(previous?.version||0)+1;
    const file=tx.put('shared_file',{...previous,id:u.resourceId,scopeId:u.scopeId,parentId:u.scopeId,name:u.name,mime:u.mime,size:u.size,sha256:u.sha256,objectKey:key,storage:u.storage,version,status:'published',authorId:previous?.authorId||who(actor),lastEditorId:who(actor),createdAt:previous?.createdAt||tx.now});
    if(!previous&&upload.folderId)await placeMaterial(tx,u.scopeId,'file',file.id,upload.folderId,actor);
    tx.put('shared_file_version',{...file,id:versionId(file.id,version),parentId:file.id,authorId:who(actor),createdAt:tx.now});
    tx.put('shared_upload',{...upload,status:'published',publishedVersion:version});
    const usage=await tx.get('shared_usage','bytes');tx.put('shared_usage',{...usage,reserved:usage.reserved-u.size,stored:usage.stored+u.size});
    if(!previous&&upload.announce===false)return publicFile(file);
    const message=await notify(tx,identity,channel,actor,`${previous?'更新':'共享'}文件：${file.name} · v${version}`,{type:'shared_file',resourceId:file.id,resourceVersion:version,fileName:file.name,fileSize:file.size,resourceAction:previous?'updated':'created'},previous?await readerIds(tx,file.id):[]);
    tx.put('shared_file',{...file,sourceMessageId:message.id});
    return publicFile({...file,sourceMessageId:message.id});
  });
}
export async function fileDetails(repo,actor,args){
  const file=await repo.get('shared_file',args.resourceId);await channelAccess(repo,file.scopeId,actor);
  const versions=await repo.list('shared_file_version',{parent:file.id,after:args.after||'',limit:101});
  return {...publicFile(file),versions:versions.slice(0,100).map(publicVersion).sort((a,b)=>b.version-a.version),next:versions.length>100?versions[99].id:null};
}
export async function fileBytes(repo,actor,args,env,{download=false}={}){
  const resource=await repo.get('shared_file',args.resourceId);await channelAccess(repo,resource.scopeId,actor);
  if(resource.status==='deleted')fail('resource_deleted','共享文件已移除',410);
  const v=args.version||resource.version;
  if(!Number.isInteger(v)||v<1)fail('invalid_version','版本无效');
  const file=await repo.get('shared_file_version',versionId(resource.id,v)),store=fileStore(env,file.storage);
  await readReceipt(repo,actor,resource,v);
  if(download){const object=await store.get(file.objectKey);if(!object)fail('file_missing','文件暂时不可用，记录保留',409);return new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Content-Length':String(file.size),'X-Content-SHA256':file.sha256,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
  const offset=args.offset||0;if(!Number.isSafeInteger(offset)||offset<0||offset>=file.size)fail('invalid_offset','偏移量无效');
  let bytes;
  if(store.range)bytes=await store.range(file.objectKey,offset,Math.min(CHUNK_SIZE,file.size-offset));
  else {const object=await store.get(file.objectKey);if(!object)fail('file_missing','文件字节缺失',409);bytes=(await readBounded(new Response(object.body),file.size)).slice(offset,offset+CHUNK_SIZE);}
  const end=offset+bytes.length;
  return {resourceId:resource.id,version:v,currentVersion:resource.version,name:file.name,mime:file.mime,size:file.size,sha256:file.sha256,offset,base64:base64(bytes),nextOffset:end<file.size?end:null,...(/^(text\/|application\/(json|xml))/.test(file.mime)?{text:new TextDecoder().decode(bytes)}:{})};
}
function codeRef(code){if(!code)return null;let url;try{url=new URL(code.url);}catch{fail('invalid_code','代码引用需要有效的仓库/PR地址');}if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!/^([a-f0-9]{40}|[a-f0-9]{64})$/i.test(code.commit||''))fail('invalid_code','代码引用需HTTPS地址和完整提交哈希，不携带凭证');return {url:url.href,commit:code.commit.toLowerCase()};}
export async function createHandoff(repo,identity,actor,args){
  return repo.transact('handoff:'+who(actor)+':'+required(args.requestId,'请求编号',100),{...args,actor},async tx=>{
    const channel=await channelAccess(tx,args.channelId,actor);
    if(!channel.memberIds.includes(args.toMemberId)||args.toMemberId===actor.memberId)fail('invalid_member','请选择群内另一位成员');
    if(!identity.members.some(m=>m.id===args.toMemberId&&m.status!=='disabled'))fail('invalid_member','接收成员已停用');
    if(args.sourceMessageId&&(await tx.get('channel_message',args.sourceMessageId)).scopeId!==channel.id)fail('forbidden','来源消息不在本群',403);
    const refs=await resourceReferences(tx,actor,channel.id,args.refs),code=codeRef(args.code);
    const h=tx.put('shared_handoff',{id:id('handoff'),scopeId:channel.id,parentId:args.toMemberId,fromMemberId:who(actor),toMemberId:args.toMemberId,summary:required(args.summary,'交接说明',6000),remaining:required(args.remaining,'需要继续的工作',6000),refs,code,sourceMessageId:args.sourceMessageId||null,status:'sent',createdAt:tx.now});
    for(const ref of refs)tx.put('shared_watch',{id:ref.id+':'+h.toMemberId,parentId:ref.id,scopeId:channel.id,memberId:h.toMemberId,version:ref.version,createdAt:tx.now});
    const m=await notify(tx,identity,channel,actor,h.summary,{type:'handoff',handoffId:h.id},[h.toMemberId]);
    return tx.put('shared_handoff',{...h,messageId:m.id});
  });
}
export async function readHandoff(repo,actor,args){const h=await repo.get('shared_handoff',args.handoffId);await channelAccess(repo,h.scopeId,actor);const refs=[];for(const r of h.refs){const current=await repo.get(r.kind==='file'?'shared_file':'channel_doc',r.id,false);refs.push({...r,currentVersion:current?.version,changed:!current||current.version!==r.version||current.status==='deleted',deleted:!current||current.status==='deleted'});}return {...h,refs,history:await repo.list('shared_handoff_event',{parent:h.id,order:'recent',limit:100})};}
export async function respondHandoff(repo,identity,actor,args){
  return repo.transact('handoff-response:'+who(actor)+':'+required(args.requestId,'请求编号',100),{...args,actor},async tx=>{
    const h=await tx.get('shared_handoff',args.handoffId),channel=await channelAccess(tx,h.scopeId,actor);
    if(actor.memberId!==h.toMemberId)fail('forbidden','只有接收成员本人可以回执',403);
    if(!['received','blocked','completed'].includes(args.status)||h.status==='completed')fail('invalid_status','交接已结束或回执状态无效',409);
    if(args.status==='completed'&&!['received','blocked'].includes(h.status))fail('not_received','先确认收到并核对输入，再报告完成',409);
    const checks=args.checks||[];if(!Array.isArray(checks)||checks.length>20||checks.some(c=>typeof c.command!=='string'||c.command.length>1000||!['passed','failed','not_run'].includes(c.result)||(c.detail?.length||0)>3000))fail('invalid_checks','请记录实际执行的检查与结果');
    if(h.code&&checks.some(c=>c.result!=='not_run')&&args.checkedCommit?.toLowerCase()!==h.code.commit)fail('commit_mismatch','检查结果必须绑定交接中的确切提交',409);
    const outputs=await resourceReferences(tx,actor,channel.id,args.outputs);
    const refs=h.refs.map(r=>({...r}));for(const r of refs){const current=await tx.get(r.kind==='file'?'shared_file':'channel_doc',r.id);r.currentVersion=current.version;r.changed=current.version!==r.version||current.status==='deleted';}
    const event=tx.put('shared_handoff_event',{id:id('handoff_event'),parentId:h.id,scopeId:h.scopeId,authorId:actor.memberId,status:args.status,summary:required(args.summary,'实际反馈',12000),checks,checkedCommit:args.checkedCommit||null,outputs,refs,createdAt:tx.now});
    const result=tx.put('shared_handoff',{...h,status:args.status,response:event.summary,checks,checkedCommit:event.checkedCommit,outputs,inputChanged:refs.some(r=>r.changed),respondedAt:tx.now});
    await notify(tx,identity,channel,actor,event.summary,{type:'handoff',handoffId:h.id},h.fromMemberId==='owner'?[]:[h.fromMemberId]);
    return result;
  });
}
export async function sharedCommand(repo,identity,actor,args,env){
  if(args.action==='begin')return beginFile(repo,actor,args,env);
  if(args.action==='chunk')return writeChunk(repo,actor,args,env);
  if(args.action==='finish')return finishFile(repo,identity,actor,args,env);
  if(args.action==='handoff')return createHandoff(repo,identity,actor,args);
  if(args.action==='respond')return respondHandoff(repo,identity,actor,args);
  if(args.action==='cancel')return repo.transact('cancel:'+required(args.requestId,'请求编号',100),{...args,actor},async tx=>{const u=await getUpload(tx,actor,args.uploadId);if(u.status!=='uploading')return u;const usage=await tx.get('shared_usage','bytes');tx.put('shared_usage',{...usage,reserved:usage.reserved-u.size});return tx.put('shared_upload',{...u,status:'canceled'});});
  if(['delete','restore'].includes(args.action))return repo.transact('file-action:'+required(args.requestId,'请求编号',100),{...args,actor},async tx=>{
    const file=await tx.get('shared_file',args.resourceId),channel=await channelAccess(tx,file.scopeId,actor);
    if(args.action==='delete'||args.action==='restore'&&!args.version&&file.status==='deleted'&&await tx.get('material_trash','file:'+file.id,false))return publicFile(await materialCommand(tx,actor,{...args,kind:'file',id:file.id},channel,{identity,helpers:meetingHelpers}));
    if(file.version!==args.expectedVersion)fail('version_conflict','文件已更新，请重读后再操作',409);
    const previous=args.action==='restore'?await tx.get('shared_file_version',versionId(file.id,args.version)):file;
    const next=tx.put('shared_file',{...file,...Object.fromEntries(['objectKey','storage','sha256','size','mime'].map(k=>[k,previous[k]])),version:file.version+1,status:args.action==='delete'?'deleted':'published',lastEditorId:actor.memberId||'owner'});
    tx.put('shared_file_version',{...next,id:versionId(file.id,next.version),parentId:file.id,createdAt:tx.now,authorId:actor.memberId||'owner'});
    const trash=await tx.get('material_trash','file:'+file.id,false);if(trash&&args.action==='restore')tx.put('material_trash',{...trash,status:'restored',restoredAt:tx.now,restoredBy:actor.memberId||'owner'});
    await notify(tx,identity,channel,actor,`${args.action==='delete'?'移除':'恢复'}文件：${file.name}`,{type:'shared_file',resourceId:file.id,resourceVersion:next.version,fileName:file.name,fileSize:next.size,resourceAction:args.action},await readerIds(tx,file.id));return publicFile(next);
  });
  fail('unknown_command','未知共享操作',404);
}
export async function sharedTool(repo,identity,actor,name,args,env){
  if(name==='shared_files')return listSharedFiles(repo,actor,args);
  if(name==='begin_file')return beginFile(repo,actor,args,env);
  if(name==='write_file_chunk')return writeChunk(repo,actor,args,env);
  if(name==='file_upload_status')return uploadStatus(repo,actor,args);
  if(name==='finish_file')return finishFile(repo,identity,actor,args,env);
  if(name==='read_shared_file')return fileBytes(repo,actor,args,env);
  if(name==='handoff')return createHandoff(repo,identity,actor,args);
  if(name==='read_handoff')return readHandoff(repo,actor,args);
  if(name==='respond_handoff')return respondHandoff(repo,identity,actor,args);
  fail('unknown_tool','未知共享工具',404);
}

export async function sharedToolEnvelope(repo,identity,actor,message,env){
  const channel=await channelAccess(repo,message.channelId,actor);
  let envelope;
  try{envelope=JSON.parse(message.body.slice(SHARED_TOOL_ENVELOPE.length));}catch{fail('invalid_tool_envelope','共享工具请求必须是完整JSON');}
  const workspaceNames=['manage_material','coordinate','board_task','remember','revise_memory','read_space_object','search_memory','read_memory','read_todo','manage_folder','move_material'];
  const workspaceDefinition=envelope&&workspaceNames.includes(envelope.name)&&CHANNEL_TOOLS.find(t=>t.name===envelope.name);
  const definition=workspaceDefinition||envelope&&SHARED_TOOLS.find(t=>t.name===envelope.name);
  if(!definition)fail('unknown_tool','此兼容入口只接受已发布的共享工具',404);
  const args=envelope.arguments;
  if(!args||typeof args!=='object'||Array.isArray(args))fail('invalid_tool_envelope','工具参数必须是JSON对象');
  if(Object.keys(args).some(key=>!Object.hasOwn(definition.inputSchema.properties,key)))fail('invalid_tool_envelope','工具请求含不支持的参数');
  // Keep the outer tool's explicit group scope. No envelope may borrow a
  // channel grant or act on a different group's uploads, files or handoffs.
  const scopes=args.channelId?[args.channelId]:[];
  if(args.uploadId)scopes.push((await repo.get('shared_upload',args.uploadId)).scopeId);
  if(args.resourceId)scopes.push((await repo.get('shared_file',args.resourceId)).scopeId);
  if(args.handoffId)scopes.push((await repo.get('shared_handoff',args.handoffId)).scopeId);
  if(!scopes.length||scopes.some(scope=>scope!==channel.id))fail('forbidden','共享工具请求必须属于当前群',403);
  if(workspaceDefinition)return conversationTool(repo,identity,actor,envelope.name,{...args,requestId:message.requestId});
  return sharedTool(repo,identity,actor,envelope.name,{...args,requestId:message.requestId},env);
}
