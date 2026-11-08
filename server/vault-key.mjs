import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';

const valid=value=>typeof value==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(value)&&Buffer.from(value,'base64').length===32;
async function create(file,value){const out=await fs.open(file,'wx',0o600);try{await out.writeFile(value+'\n');await out.sync();}finally{await out.close();}}
export async function loadVaultKey(db,config){
 if(config.vaultEncryptionKey!==undefined)return valid(config.vaultEncryptionKey)?{key:config.vaultEncryptionKey}:{state:'locked'};
 const directory=config.vaultKeyDirectory||path.join(path.dirname(config.database),'.vault-keys'),file=path.join(directory,'master.key'),recovery=path.join(directory,'recovery.key');
 await fs.mkdir(directory,{recursive:true,mode:0o700});await fs.chmod(directory,0o700);
 let key;try{key=(await fs.readFile(file,'utf8')).trim();}catch(e){if(e.code!=='ENOENT')return {state:'locked'};}
 if(key!==undefined&&!valid(key))return {state:'locked'};
 if(!key){
  let saved;try{saved=(await fs.readFile(recovery,'utf8')).trim();}catch(e){if(e.code!=='ENOENT')return {state:'locked'};}
  if(saved!==undefined&&!valid(saved))return {state:'locked'};
  const count=await db.prepare("SELECT COUNT(*) AS n FROM hub_v2_records WHERE kind='vault_entry' AND status<>'purged'").first();
  if(!saved&&Number(count?.n)>0)return {state:'locked'};
  key=saved||randomBytes(32).toString('base64');try{await create(file,key);}catch(e){if(e.code!=='EEXIST')throw e;key=(await fs.readFile(file,'utf8')).trim();if(!valid(key))return {state:'locked'};}
 }
 await fs.chmod(file,0o600);
 try{await create(recovery,key);}catch(e){if(e.code!=='EEXIST')throw e;if((await fs.readFile(recovery,'utf8')).trim()!==key)return {state:'locked'};}
 await fs.chmod(recovery,0o600);
 return {key,state:'ready',keyId:createHash('sha256').update(key).digest('hex').slice(0,16)};
}
