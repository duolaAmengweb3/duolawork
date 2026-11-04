import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {privateJson} from './storage.mjs';
const str={type:'string'};
export const LOCAL_FILE_TOOLS=[
 {name:'download_shared_file',description:'把获授权的共享文件准确下载到当前运行环境的私有缓存，校验SHA256后返回实际本地路径；不是用户Mac的路径。不会覆盖项目文件。',inputSchema:{type:'object',properties:{resourceId:str,version:{type:'integer',minimum:1}},required:['resourceId'],additionalProperties:false}},
 {name:'publish_local_file',description:'将当前环境内明确选择的单个成果文件发布到群共享空间，自动分块/续传/校验。不会上传目录或无关文件。更新已有文件时传resourceId和expectedVersion。',inputSchema:{type:'object',properties:{channelId:str,path:str,name:str,mime:str,resourceId:str,expectedVersion:{type:'integer',minimum:1}},required:['channelId','path'],additionalProperties:false}}
];
async function sha(file){const hash=createHash('sha256');for await(const b of createReadStream(file))hash.update(b);return hash.digest('hex');}
export async function localFileTool(client,name,args){
 const root=path.join(path.dirname(client.file),'shared-cache');await fs.mkdir(root,{recursive:true,mode:0o700});
 if(name==='download_shared_file'){
  let part=await client.api('/v2/tools/read_shared_file',{method:'POST',body:{resourceId:args.resourceId,...(args.version?{version:args.version}:{})}});
  const version=part.version,key=createHash('sha256').update(args.resourceId+':'+version).digest('hex'),safe=part.name.replace(/[\x00-\x1f/\\]/g,'_');
  const directory=path.join(root,key);await fs.mkdir(directory,{recursive:true,mode:0o700});
  const target=path.join(directory,safe),tmp=path.join(directory,'.download-'+randomUUID()),out=await fs.open(tmp,'wx',0o600),hash=createHash('sha256');let size=0;
  try{while(true){if(part.version!==version||part.offset!==size)throw Error('资料版本或分块不一致，未写入项目');const bytes=Buffer.from(part.base64,'base64');hash.update(bytes);await out.write(bytes);size+=bytes.length;if(part.nextOffset===null)break;part=await client.api('/v2/tools/read_shared_file',{method:'POST',body:{resourceId:args.resourceId,version,offset:part.nextOffset}});}
   if(size!==part.size||hash.digest('hex')!==part.sha256)throw Error('下载校验失败，未交付缓存路径');await out.sync();await out.close();await fs.rename(tmp,target);
   return {path:target,resourceId:args.resourceId,version,size,sha256:part.sha256,currentVersion:part.currentVersion};
  }catch(e){await out.close().catch(()=>{});await fs.unlink(tmp).catch(()=>{});throw e;}
 }
 if(name==='publish_local_file'){
  const source=path.resolve(args.path),info=await fs.lstat(source);if(!info.isFile())throw Error('请选择一个具体的普通文件，不能上传目录或符号链接');
  const hash=await sha(source),key=createHash('sha256').update(JSON.stringify({channel:args.channelId,path:source,hash,resourceId:args.resourceId,expectedVersion:args.expectedVersion})).digest('hex'),manifest=path.join(root,'upload-'+key+'.json');
  let state;try{state=JSON.parse(await fs.readFile(manifest,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!state){state={requestId:randomUUID(),source,sha256:hash};await privateJson(manifest,state);}
  if(!state.uploadId){const u=await client.api('/v2/tools/begin_file',{method:'POST',body:{requestId:state.requestId,channelId:args.channelId,name:args.name||path.basename(source),mime:args.mime||'application/octet-stream',size:info.size,sha256:hash,...(args.resourceId?{resourceId:args.resourceId,expectedVersion:args.expectedVersion}:{})}});state={...state,uploadId:u.id,chunkSize:u.chunkSize};await privateJson(manifest,state);}
  const progress=await client.api('/v2/tools/file_upload_status',{method:'POST',body:{uploadId:state.uploadId}}),received=new Set(progress.received),input=await fs.open(source,'r');
  try{if(progress.status!=='published')for(let index=0;index<progress.chunks;index++){if(received.has(index))continue;const bytes=Buffer.alloc(Math.min(progress.chunkSize,info.size-index*progress.chunkSize)),{bytesRead}=await input.read(bytes,0,bytes.length,index*progress.chunkSize);if(bytesRead!==bytes.length)throw Error('原文件发生变化，尚未共享');await client.api('/v2/tools/write_file_chunk',{method:'POST',body:{uploadId:state.uploadId,index,base64:bytes.toString('base64')}});}}finally{await input.close();}
  const result=await client.api('/v2/tools/finish_file',{method:'POST',body:{uploadId:state.uploadId},timeout:120000});await fs.unlink(manifest).catch(()=>{});return result;
 }
 throw Error('未知本地文件工具');
}
