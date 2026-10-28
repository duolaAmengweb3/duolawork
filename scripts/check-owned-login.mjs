// Read-only acceptance against the browser owned by the running Hub. This is
// not a login flow: no navigation, credentials, messages or storage access.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import WebSocket from 'ws';
import {LoginMonitor,collectLoginSignals} from '../local/login-status.mjs';

const root=path.join(os.homedir(),'.config/agent-hub');
const state=await(await fetch('http://127.0.0.1:8766/api/state')).json();
const account=state.accounts.find(a=>a.platformId==='muse'&&a.status!=='disabled');
if(!account)throw new Error('尚无 Muse 账号');
const owned=state.local.browsers.find(b=>b.accountId===account.id);
if(!owned)throw new Error('该账号的后台环境尚未恢复；未自动重新登录');
const directory=path.join(root,'profiles',account.id);
const command=execFileSync('/bin/ps',['-p',String(owned.pid),'-o','command='],{encoding:'utf8'});
if(!command.includes('--user-data-dir='+directory+' ')||!command.includes('--remote-debugging-port=0'))throw new Error('进程归属不符，已停止');
const port=Number((await fs.readFile(path.join(directory,'DevToolsActivePort'),'utf8')).split('\n')[0]);
const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target=targets.find(t=>{try{return ['page','other'].includes(t.type)&&['muse.ai','www.muse.ai'].includes(new URL(t.url).hostname);}catch{return false;}});
if(!target)throw new Error('当前后台环境不在 Muse，未跳转或刷新');
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
let id=0;
try{
 const page={url:()=>target.url,isClosed:()=>false,evaluate:async fn=>{
  if(fn!==collectLoginSignals)throw new Error('仅允许固定只读观察');
  return new Promise((resolve,reject)=>{
   const requestId=++id;
   const listener=raw=>{const result=JSON.parse(raw.toString());if(result.id!==requestId)return;clearTimeout(timer);ws.off('message',listener);result.error?reject(new Error(result.error.message)):resolve(result.result.result.value);};
   const timer=setTimeout(()=>{ws.off('message',listener);reject(new Error('观察超时'));},7000);
   ws.on('message',listener);ws.send(JSON.stringify({id:requestId,method:'Runtime.evaluate',params:{expression:'('+fn.toString()+')()',returnByValue:true}}));
  });
 }};
 const monitor=new LoginMonitor({file:path.join(root,'login-status.json')});
 const result=await monitor.check(account,{active:new Map([[account.id,{child:{pid:owned.pid},context:{pages:()=>[page]}}]])},{force:true});
 const evidence={at:new Date().toISOString(),platform:'muse',...result,readOnly:true,noProfileMutationRequested:true,realCommercialLoginTested:result.status==='authenticated',realCommercialAgentTested:false};
 await fs.writeFile('evidence/login.json',JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify(evidence,null,2));
}finally{ws.close();}
