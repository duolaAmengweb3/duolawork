import {fail} from './repository.mjs';
import {base64,unbase64} from './security.mjs';
const text=new TextEncoder(),decode=new TextDecoder();
async function master(env,workspace){
 let bytes;try{bytes=unbase64(env.VAULT_ENCRYPTION_KEY||'');}catch{}
 if(bytes?.length!==32)fail('vault_locked','凭证库密钥不可用，原密文保留；请恢复凭证库密钥',503);
 const material=await crypto.subtle.importKey('raw',bytes,'HKDF',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:text.encode(workspace),info:text.encode('DuolaWork Vault v1')},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function sealVault(value,env,{workspace,id,version}){
 const iv=crypto.getRandomValues(new Uint8Array(12)),aad=text.encode(JSON.stringify([workspace,id,version]));
 const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},await master(env,workspace),text.encode(JSON.stringify(value)));
 return {format:1,iv:base64(iv),data:base64(new Uint8Array(data))};
}
export async function unsealVault(value,env,context){
 const key=await master(env,context.workspace);
 try{return JSON.parse(decode.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unbase64(value.iv),additionalData:text.encode(JSON.stringify([context.workspace,context.id,context.version]))},key,unbase64(value.data))));}
 catch{fail('vault_locked','凭证无法解密，原记录保留；请核对恢复材料',503);}
}
async function backupKey(password,salt){
 if(typeof password!=='string'||password.length<12||password.length>1000)fail('weak_backup_password','备份密码至少 12 个字符',400);
 const k=await crypto.subtle.importKey('raw',text.encode(password),'PBKDF2',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:600000},k,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function exportVaultBackup(value,password){
 const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
 const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:text.encode('DuolaWork Vault Backup v1')},await backupKey(password,salt),text.encode(JSON.stringify(value)));
 return {format:'duolawork-vault-backup',version:1,kdf:'PBKDF2-SHA256',iterations:600000,salt:base64(salt),iv:base64(iv),data:base64(new Uint8Array(data))};
}
export async function importVaultBackup(bundle,password){
 if(bundle?.format!=='duolawork-vault-backup'||bundle.version!==1||bundle.kdf!=='PBKDF2-SHA256'||bundle.iterations!==600000||typeof bundle.data!=='string'||bundle.data.length>7000000)fail('invalid_backup','不是支持的 Vault 加密备份',400);
 try{const salt=unbase64(bundle.salt),iv=unbase64(bundle.iv);if(salt.length!==16||iv.length!==12)throw Error('invalid backup');return JSON.parse(decode.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:text.encode('DuolaWork Vault Backup v1')},await backupKey(password,salt),unbase64(bundle.data))));}
 catch{fail('invalid_backup','备份密码不正确或文件已损坏，未导入任何凭证',400);}
}
