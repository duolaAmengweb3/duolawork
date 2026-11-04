import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createHash,randomUUID} from 'node:crypto';

// Private immutable objects, separate from SQLite. Keys never become local paths.
// The same bucket contract can be backed by object storage without changing IDs.
export function diskObjects(root){
 const filename=key=>path.join(root,createHash('sha256').update(key).digest('hex'));
 const error=(code,message)=>Object.assign(new Error(message),{code,status:409});
 async function publish(tmp,destination){try{await fs.link(tmp,destination);}catch(e){if(e.code!=='EEXIST')throw e;}finally{await fs.unlink(tmp).catch(()=>{});}}
 async function temporary(){await fs.mkdir(root,{recursive:true,mode:0o700});const name=path.join(root,'.upload-'+randomUUID());return {name,handle:await fs.open(name,'wx',0o600)};}
 return {
  storageKind:'disk',
  async put(key,bytes){const tmp=await temporary();try{await tmp.handle.writeFile(bytes);await tmp.handle.sync();}finally{await tmp.handle.close();}await publish(tmp.name,filename(key));},
  async get(key){let stat;try{stat=await fs.stat(filename(key));}catch(e){if(e.code==='ENOENT')return null;throw e;}return {body:Readable.toWeb(createReadStream(filename(key))),size:stat.size};},
  async range(key,offset,length){let handle;try{handle=await fs.open(filename(key),'r');const bytes=Buffer.alloc(length);const {bytesRead}=await handle.read(bytes,0,length,offset);if(bytesRead!==length)throw error('file_corrupt','文件字节不完整');return new Uint8Array(bytes);}catch(e){if(e.code==='ENOENT')throw error('file_missing','文件字节缺失，记录保留');throw e;}finally{await handle?.close();}},
  async assemble(keys,key,expected){
   const tmp=await temporary(),hash=createHash('sha256');let size=0;
   try{for(const chunk of keys){for await(const bytes of createReadStream(filename(chunk))){size+=bytes.length;if(size>expected.size)throw error('hash_mismatch','文件大小校验失败');hash.update(bytes);await tmp.handle.write(bytes);}}
    if(size!==expected.size||hash.digest('hex')!==expected.sha256)throw error('hash_mismatch','文件校验失败，尚未发布');
    await tmp.handle.sync();await tmp.handle.close();await publish(tmp.name,filename(key));
   }catch(e){await tmp.handle.close().catch(()=>{});await fs.unlink(tmp.name).catch(()=>{});throw e;}
  },
  async delete(key){await fs.unlink(filename(key)).catch(e=>{if(e.code!=='ENOENT')throw e;});},
 };
}
