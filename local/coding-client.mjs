import {LOCAL_FILE_TOOLS,localFileTool} from './shared-file-client.mjs';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {privateJson} from './storage.mjs';
import {requestJson} from './transport.mjs';

// Only this member's grant is loaded. Provider login files are never copied,
// printed, replaced or used as Hub credentials.
export class CodingMemberClient{
 constructor(file,{request=requestJson}={}){this.file=file;this.request=request;}
 async credentials(){const d=JSON.parse(await fs.readFile(this.file,'utf8'));if(!d.memberId||!d.endpoint||!d.access_token)throw new Error('本机成员凭证不可用，原文件保留');return d;}
 async refresh(previous){
  const lock=this.file+'.refresh-lock';let handle;
  for(let i=0;i<30;i++){
   try{handle=await fs.open(lock,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,at:Date.now()}));break;}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,300));const d=await this.credentials();if(d.access_token!==previous.access_token)return d;let owner;try{owner=JSON.parse(await fs.readFile(lock,'utf8'));}catch{}if(owner?.pid){try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')throw new Error('上次刷新意外中断，凭证保留；请重新连接此成员，不自动重用刷新令牌');}}}
  }
  if(!handle)throw new Error('成员凭证正在刷新，请稍后重试');
  try{
   const latest=await this.credentials();if(latest.access_token!==previous.access_token)return latest;
   const response=await this.request(latest.endpoint+'/v2/oauth/token',{method:'POST',body:{grant_type:'refresh_token',refresh_token:latest.refresh_token,client_id:latest.client_id},timeout:15000});
   const next={...latest,...response,expiresAt:Date.now()+(response.expires_in||3600)*1000};await privateJson(this.file,next);return next;
  }finally{await handle.close();await fs.unlink(lock).catch(()=>{});}
 }
 async api(route,{method='GET',body,timeout=30000}={}){
  let d=await this.credentials();if(d.expiresAt&&d.expiresAt<Date.now()+30000)d=await this.refresh(d);
  try{return await this.request(d.endpoint+route,{method,body,token:d.access_token,timeout});}
  catch(e){if(e.status!==401&&e.statusCode!==401)throw e;d=await this.refresh(d);return this.request(d.endpoint+route,{method,body,token:d.access_token,timeout});}
 }
 async tools(){const response=await this.api('/v2/mcp',{method:'POST',body:{jsonrpc:'2.0',id:randomUUID(),method:'tools/list',params:{}}});if(response.error)throw new Error(response.error.message);return [...response.result.tools,...LOCAL_FILE_TOOLS];}
 async tool(name,args={}){if(LOCAL_FILE_TOOLS.some(t=>t.name===name))return localFileTool(this,name,args);return this.api('/v2/tools/'+encodeURIComponent(name),{method:'POST',body:args});}
}
