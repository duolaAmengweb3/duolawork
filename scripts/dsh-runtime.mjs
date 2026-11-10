// Local development/verification installation, separate from the shipped Hub UI.
// Owns only the explicitly installed DSH Host under this private directory.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {privateJson} from '../local/storage.mjs';
const exec=promisify(execFile),repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root=path.join(os.homedir(),'.local/share/agent-hub/deepseek-proof');
const modelFile=path.join(os.homedir(),'.config/agent-hub-dsh-test/model.json');
const stateFile=path.join(root,'connector.json'),processFile=path.join(root,'web-process-rc5.json'),logFile=path.join(root,'web-rc5.log');
const cli=path.join(root,'npm/node_modules/@deepseek-ai/dsh/lib/bin.js');
const project=path.join(root,'project');
async function state(){return JSON.parse(await fs.readFile(stateFile,'utf8'));}
async function request(route){const s=await state();const r=await fetch(s.controlUrl+route,{headers:{Authorization:'Bearer '+s.controlToken},signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error('Native Host is not ready');return r.json();}
async function running(){try{return await request('/health');}catch{return null;}}
async function ownedProcess(){
 const p=JSON.parse(await fs.readFile(processFile,'utf8'));
 const {stdout}=await exec('/bin/ps',['-p',String(p.pid),'-o','args=']);
 if(!stdout.includes(cli)&&!stdout.includes(path.join(root,'npm/node_modules/.bin/dsh')))throw Error('Stored PID belongs to another process; left untouched');
 return p;
}
async function start({proof=false}={}){
 const alive=await running();if(alive)return alive;
 // Fail before launching a Host if a partial checkout lacks connector dependencies.
 await import(pathToFileURL(path.join(repo,'local/dsh-connector.mjs')).href);
 await fs.access(cli);const model=JSON.parse(await fs.readFile(modelFile,'utf8'));
 if(!model.apiKey||!model.model||new URL(model.baseUrl).origin!=='https://api.b.ai')throw Error('Private B.AI model configuration is incomplete or its origin does not match');
 if((await fs.stat(modelFile)).mode&0o077)throw Error('Model configuration must have mode 0600');
 await fs.mkdir(root,{recursive:true,mode:0o700});
 let s;try{s=await state();}catch(e){if(e.code!=='ENOENT')throw e;s={controlToken:randomBytes(32).toString('base64url'),bindings:[]};}
 s.proofWorkspace=project;delete s.controlUrl;await privateJson(stateFile,s);
 const patch=[
  {id:'llm-pi-ai',config:{providers:{'b-ai':{apiKeyEnv:'BAI_API_KEY',displayName:'B.AI test',api:model.protocol,baseURL:model.baseUrl,models:[{id:model.model,name:model.model,contextWindow:131072,maxTokens:4096}]}}}},
  {id:'agent-default-model',config:{provider:'b-ai',model:model.model}},
  {id:'session-log-deepseek',disabled:true},
  {insert:[{id:'hub-native',name:path.join(repo,'local/dsh-connector.mjs'),config:{stateFile,allowProof:proof}}]},
 ];
 const patchFile=path.join(root,'hub-web-patch.json');await privateJson(patchFile,patch);
 const env={...process.env,DSH_HOME:path.join(root,'web-home-rc5'),BAI_API_KEY:model.apiKey};delete env.ALL_PROXY;delete env.all_proxy;
 const log=await fs.open(logFile,'w',0o600);
 const child=spawn(process.execPath,[cli,'web','--patch',patchFile,'--no-open','--host','127.0.0.1','--port','0'],{cwd:project,env,stdio:['ignore',log.fd,log.fd],detached:true});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 child.unref();await log.close();await privateJson(processFile,{pid:child.pid,home:env.DSH_HOME,project,proof});
 for(let i=0;i<60;i++){const result=await running();if(result&&(await state()).pid===child.pid)return result;await new Promise(r=>setTimeout(r,500));}
 throw Error('DSH startup timed out; private runtime log retained');
}
async function stop(){
 if(!await running())return;
 const sessions=await request('/sessions');if(sessions.items.some(s=>s.running))throw Error('Native Agent is still working; no restart or termination performed');
 const p=await ownedProcess();process.kill(p.pid,'SIGINT');
 for(let i=0;i<40;i++){try{process.kill(p.pid,0);}catch{return;}await new Promise(r=>setTimeout(r,250));}
 throw Error('Native Host has not exited; not force-killed');
}
try{
 const command=process.argv[2]||'status';
 if(command==='stop')await stop();
 else if(command==='restart'){await stop();await start({proof:process.argv.includes('--proof')});}
 else if(command==='start'||command==='open'){
  await start({proof:process.argv.includes('--proof')});
  if(command==='open'){
   const log=await fs.readFile(logFile,'utf8');const url=log.match(/dsh web:\s+(https?:\/\/\S+)/)?.[1];
   if(!url||!['127.0.0.1','[::1]'].includes(new URL(url).hostname))throw Error('Missing local DSH browser entry');
   await exec('/usr/bin/open',[url]);
  }
 }else if(command!=='status')throw Error('Usage: node scripts/dsh-runtime.mjs start|open|status|restart|stop [--proof]');
 const health=await running();console.log(JSON.stringify({installed:true,version:'0.2.1-rc.5',running:!!health,connectedSessions:health?.bindings.length||0,modelConfiguration:'private local file',formalHubUIInstalled:false}));
}catch(error){console.error(String(error.message).replace(/sk-[A-Za-z0-9_-]+/g,'[hidden]'));process.exitCode=1;}
