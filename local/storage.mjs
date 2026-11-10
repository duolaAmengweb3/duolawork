import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export const dataDir=process.env.AGENT_HUB_DATA_DIR||path.join(os.homedir(),'.config','agent-hub');
export async function privateJson(file,value,{durable=false}={}){
 const directory=path.dirname(file);await fs.mkdir(directory,{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';
 try{
  const handle=await fs.open(tmp,'wx',0o600);try{await handle.writeFile(JSON.stringify(value,null,2));if(durable)await handle.sync();}finally{await handle.close();}
  await fs.rename(tmp,file);
  if(durable){const folder=await fs.open(directory,'r');try{await folder.sync();}finally{await folder.close();}}
 }catch(error){await fs.unlink(tmp).catch(()=>{});throw error;}
}
export async function readConfig(){try{return JSON.parse(await fs.readFile(path.join(dataDir,'config.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;return{port:8766,runnerId:'local-'+randomUUID()};}}
export async function openVault(key,{resolveKey,defer=false}={}){
 await fs.mkdir(dataDir,{recursive:true,mode:0o700});
 const obtainKey=async()=>{
  if(key)return key;
  if(resolveKey){key=await resolveKey();if(!Buffer.isBuffer(key)||key.length!==32)throw new Error('本机密钥不可用，未重置账号资料');return key;}
  const keyPath=path.join(dataDir,'vault.key');
  try{key=await fs.readFile(keyPath);}catch(e){if(e.code!=='ENOENT')throw e;try{await fs.access(path.join(dataDir,'vault-key.oscrypt'));throw new Error('密钥由系统钥匙串保护，请打开 Agent Hub.app；未重置账号资料。');}catch(check){if(check.code!=='ENOENT')throw check;}key=randomBytes(32);await fs.writeFile(keyPath,key,{mode:0o600});}
  return key;
 };
 const file=path.join(dataDir,'vault.enc');let data={members:{},accounts:{}},raw;
 try{raw=await fs.readFile(file);}catch(e){if(e.code!=='ENOENT')throw e;}
 let loaded=!raw,loading;
 const unlock=()=>loading??=(async()=>{if(loaded)return;const actualKey=await obtainKey();try{const d=createDecipheriv('aes-256-gcm',actualKey,raw.subarray(0,12));d.setAuthTag(raw.subarray(12,28));const decoded=JSON.parse(Buffer.concat([d.update(raw.subarray(28)),d.final()]).toString());Object.assign(data,decoded);loaded=true;}catch{throw new Error('本地密钥库不能解密，未重置任何账号资料');}})();
 if(!defer)await unlock();
 // An empty workspace has no secrets to decrypt: starting it must not touch the OS keychain.
 let chain=Promise.resolve();return{data,unlock,get locked(){return !loaded;},save(){if(!loaded)throw new Error('工具密钥尚未解锁，保留原加密资料，不能覆盖保存。');chain=chain.then(async()=>{const actualKey=await obtainKey();const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',actualKey,iv);const cipher=Buffer.concat([c.update(JSON.stringify(data)),c.final()]);const tmp=file+'.tmp';await fs.writeFile(tmp,Buffer.concat([iv,c.getAuthTag(),cipher]),{mode:0o600});await fs.rename(tmp,file);});return chain;}};
}
