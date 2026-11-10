import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {concealSecrets,vaultReferences} from '../shared/vault-references.mjs';
import {privateJson} from './storage.mjs';
const run=promisify(execFile),string={type:'string'},hash=v=>createHash('sha256').update(v).digest('hex');
export const LOCAL_VAULT_TOOLS=[{name:'run_with_credentials',description:'在你当前运行环境启动一个明确的子进程，把 Vault 字段引用注入指定环境变量；值不作为工具结果返回，已知秘密在输出中遮盖。不改变原 Agent 登录、模型、项目或全局环境。requestId 防重复执行；结果不明不要换编号重做。env 值必须是 vault://凭证ID/字段。',inputSchema:{type:'object',properties:{requestId:string,channelId:string,command:string,args:{type:'array',items:string},cwd:string,env:{type:'object',additionalProperties:string},timeoutMs:{type:'integer',minimum:1000,maximum:120000}},required:['requestId','channelId','command','env'],additionalProperties:false}}];
export async function runWithCredentials(client,args,{execute=run}={}){
 if(typeof args.requestId!=='string'||!args.requestId||args.requestId.length>160||typeof args.command!=='string'||!args.command||args.command.length>2000||args.args&&(!Array.isArray(args.args)||args.args.length>200||args.args.some(v=>typeof v!=='string'))||args.timeoutMs!==undefined&&(!Number.isInteger(args.timeoutMs)||args.timeoutMs<1000||args.timeoutMs>120000))throw Error('请提供请求编号、有效命令、参数和超时时间');
 if(vaultReferences({command:args.command,args:args.args,cwd:args.cwd}).length)throw Error('凭证引用只能放在 env 中，不能写入命令行参数');
 const cwd=path.resolve(args.cwd||process.cwd());if(!(await fs.stat(cwd)).isDirectory())throw Error('工作目录不存在');
 const directory=path.join(path.dirname(client.file),'vault-executions');await fs.mkdir(directory,{recursive:true,mode:0o700});
 const file=path.join(directory,hash(path.resolve(client.file)+'\0'+args.requestId)+'.json'),fingerprint=hash(JSON.stringify({channelId:args.channelId,command:args.command,args:args.args||[],cwd,env:args.env,timeoutMs:args.timeoutMs||30000}));
 let handle;try{handle=await fs.open(file,'wx',0o600);await handle.writeFile(JSON.stringify({fingerprint,status:'preparing'}));await handle.sync();}catch(e){if(e.code!=='EEXIST')throw e;const previous=JSON.parse(await fs.readFile(file,'utf8'));if(previous.fingerprint!==fingerprint)throw Error('同一个请求编号不能执行不同命令');return previous.result||{status:'unknown',message:'此命令已经提交，未自动重复执行；请核对原运行环境'};}finally{await handle?.close();}
 let values,submitted=false;
 try{
  const lease=await client.api('/v2/tools/vault',{method:'POST',body:{action:'prepare',requestId:'native-'+hash(path.resolve(client.file)+'\0'+args.requestId),channelId:args.channelId,references:args.env}});
  const grant=await client.api('/v2/self/vault/redeem',{method:'POST',body:{leaseId:lease.leaseId}});values=grant.environment;
  await privateJson(file,{fingerprint,status:'running'},{durable:true});
  let result;submitted=true;
  try{const r=await execute(args.command,args.args||[],{cwd,env:{...process.env,...values},timeout:args.timeoutMs||30000,maxBuffer:500000,windowsHide:true});result={status:'succeeded',exitCode:0,stdout:concealSecrets(r.stdout||'',Object.values(values)),stderr:concealSecrets(r.stderr||'',Object.values(values))};}
  catch(e){result={status:typeof e.code==='number'?'failed':'unknown',exitCode:typeof e.code==='number'?e.code:null,stdout:concealSecrets(e.stdout||'',Object.values(values)),stderr:concealSecrets(e.stderr||'',Object.values(values)),message:typeof e.code==='number'?'子进程已结束，返回非零退出码':'子进程未明确完成，请在原环境核对；未自动重试'};}
  await privateJson(file,{fingerprint,status:result.status,result},{durable:true});return result;
 }catch(e){const result=submitted?{status:'unknown',message:'命令已提交，但结果保存失败，请在原环境核对；未自动重试'}:{status:'failed',message:e.code?.startsWith('vault_')?e.message:'凭证准备失败，未启动命令；请检查凭证和原环境连接'};await privateJson(file,{fingerprint,status:result.status,result},{durable:true}).catch(()=>{});return result;}
 finally{if(values)for(const key of Object.keys(values))delete values[key];}
}
