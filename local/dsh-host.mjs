import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {privateJson} from './storage.mjs';
import {findExecutable} from './native-agent.mjs';
const execute=promisify(execFile),here=path.dirname(fileURLToPath(import.meta.url));
export const DSH_VERSION='0.2.1-rc.5';
const read=file=>fs.readFile(file,'utf8').then(JSON.parse);
const exists=file=>fs.access(file).then(()=>true,()=>false);

// Only manages a Hub-owned Host. Provider secrets and native sessions stay outside the app bundle.
export class DshHost {
 constructor(dataDir,{home=os.homedir(),exec=execute}={}){this.dataDir=dataDir;this.home=home;this.exec=exec;this.registry=path.join(dataDir,'dsh-host.json');this.progress=null;}
 async load(){
  try{this.location=await read(this.registry);return;}catch(e){if(e.code!=='ENOENT')throw Error('DSH 安装记录无法读取，原会话保留');}
  const root=path.join(this.dataDir,'native-runtimes','dsh');
  this.location={root,install:path.join(root,'npm'),home:path.join(root,'home'),modelFile:path.join(root,'model.json'),controlFile:path.join(root,'connector.json'),processFile:path.join(root,'process.json'),logFile:path.join(root,'host.log'),patchFile:path.join(root,'hub-patch.json')};
  // Adopt only the explicit private installation created by this Hub's preceding acceptance, never another product's login.
  const old=path.join(this.home,'.local/share/agent-hub/deepseek-proof');
  if(this.dataDir===path.join(this.home,'.config/agent-hub')&&await exists(path.join(old,'web-process-rc5.json'))&&await exists(path.join(old,'connector.json'))){
   this.location={root:old,install:path.join(old,'npm'),home:path.join(old,'web-home-rc5'),modelFile:path.join(this.home,'.config/agent-hub-dsh-test/model.json'),controlFile:path.join(old,'connector.json'),processFile:path.join(old,'web-process-rc5.json'),logFile:path.join(old,'web-rc5.log'),patchFile:path.join(old,'hub-web-patch.json')};
  }
  await privateJson(this.registry,this.location);
 }
 async model(){try{return await read(this.location.modelFile);}catch(e){if(e.code!=='ENOENT')throw Error('DSH 模型配置无法读取，未重置');return null;}}
 async status(){const m=await this.model(),p=await this.package();let online=false;try{online=!!(await this.call('/health')).ready;}catch{}return{installed:!!p,version:p?.version,configured:!!m?.apiKey,model:m?.model||'',baseUrl:m?.baseUrl||'https://api.b.ai/v1',online,progress:this.progress};}
 async configure({apiKey,model='deepseek-v4.1-flash',baseUrl='https://api.b.ai/v1'}){
  const prior=await this.model(),key=apiKey?.trim()||prior?.apiKey;
  if(!key)throw Error('请填写你的 B.ai API Key');
  if(baseUrl!=='https://api.b.ai/v1')throw Error('当前入口使用 B.ai 官方接口');
  if(!/^[a-zA-Z0-9._:/-]{1,150}$/.test(model))throw Error('模型名称格式不正确');
  if((await this.status()).online)throw Error('DSH 正在运行；请先在原生界面结束工作再更换模型配置');
  await privateJson(this.location.modelFile,{protocol:'openai-completions',baseUrl,model,apiKey:key});return this.status();
 }
 async package(){try{const p=await read(path.join(this.location.install,'node_modules/@deepseek-ai/dsh/package.json'));return p.version===DSH_VERSION?p:null;}catch{return null;}}
 async ensure(){
  if(await this.package())return;
  const npm=await findExecutable('npm');if(!npm)throw Error('安装 DSH 需要 Node.js 和 npm；现有 Agent 不受影响');
  await fs.mkdir(this.location.install,{recursive:true,mode:0o700});this.progress='正在安装 DeepSeek 官方运行组件';
  try{await this.exec(npm,['install','--prefix',this.location.install,'--registry','https://registry.npmjs.org','--save-exact','--no-audit','--no-fund','@deepseek-ai/dsh@'+DSH_VERSION],{timeout:600000,maxBuffer:2*1024*1024});if(!await this.package())throw Error('官方运行组件版本检查失败');}finally{this.progress=null;}
 }
 async call(route,body){
  const s=await read(this.location.controlFile),url=new URL(s.controlUrl);
  if(url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw Error('DSH 本机接口地址不正确');
  const response=await fetch(new URL(route,url),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+s.controlToken,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(body?20000:4000)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'DSH 本机接口未就绪');return result;
 }
 async stopIdleOwned(){
  const items=await this.call('/sessions');if(items.items.some(s=>s.running))throw Error('DSH 还有工作正在进行，未中断原会话；结束后重新连接即可');
  const p=await read(this.location.processFile),cli=path.join(this.location.install,'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const {stdout}=await this.exec('/bin/ps',['-p',String(p.pid),'-o','args=']);
  if(!stdout.includes(cli))throw Error('DSH 进程归属无法确认，未关闭');
  process.kill(p.pid,'SIGINT');for(let i=0;i<80;i++){try{process.kill(p.pid,0);}catch{return;}await new Promise(r=>setTimeout(r,100));}throw Error('DSH 尚未正常退出，未强行终止');
 }
 async start(){
  if(this.starting)return this.starting;
  this.starting=this.startOnce().finally(()=>{this.starting=null;});return this.starting;
 }
 async startOnce(){
  let health;try{health=await this.call('/health');}catch{}
  if(health?.protocolVersion>=5){for(let i=0;i<100;i++){if(health.ready)return health;await new Promise(r=>setTimeout(r,300));health=await this.call('/health');}throw Error('DSH 正在恢复原会话，请稍后重试');}
  let webPort=0;try{const oldEntry=(await fs.readFile(this.location.logFile,'utf8')).match(/dsh web:\s+(https?:\/\/\S+)/)?.[1];if(oldEntry&&new URL(oldEntry).hostname==='127.0.0.1')webPort=Number(new URL(oldEntry).port);}catch{}
  if(health)await this.stopIdleOwned(); // Upgrade only an idle, positively owned Host; exact native home remains.
  const model=await this.model();if(!model?.apiKey)throw Error('还没有模型配置，请先填写 B.ai API Key');
  await this.ensure();const l=this.location;
  let s;try{s=await read(l.controlFile);}catch(e){if(e.code!=='ENOENT')throw e;s={controlToken:randomBytes(32).toString('base64url'),bindings:[]};}
  delete s.controlUrl;await privateJson(l.controlFile,s);
  const patch=[{id:'llm-pi-ai',config:{providers:{'b-ai':{apiKeyEnv:'BAI_API_KEY',displayName:'B.ai',api:'openai-completions',baseURL:model.baseUrl,models:[{id:model.model,name:model.model,contextWindow:131072,maxTokens:4096}]}}}},{id:'agent-default-model',config:{provider:'b-ai',model:model.model}},{id:'session-log-deepseek',disabled:true},{insert:[{id:'hub-native',name:path.join(here,'dsh-connector.mjs'),config:{stateFile:l.controlFile,allowProof:false}}]}];
  await privateJson(l.patchFile,patch);await fs.mkdir(l.home,{recursive:true,mode:0o700});
  const node=await findExecutable('node');if(!node)throw Error('本机缺少 Node.js');
  const env={...process.env,DSH_HOME:l.home,BAI_API_KEY:model.apiKey};delete env.ALL_PROXY;delete env.all_proxy;delete env.ELECTRON_RUN_AS_NODE;
  const log=await fs.open(l.logFile,'w',0o600),cli=path.join(l.install,'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const child=spawn(node,[cli,'web','--patch',l.patchFile,'--no-open','--host','127.0.0.1','--port',String(webPort)],{cwd:l.home,env,stdio:['ignore',log.fd,log.fd],detached:true});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();await log.close();await privateJson(l.processFile,{pid:child.pid,home:l.home,managedBy:'agent-hub'});
  for(let i=0;i<100;i++){try{const h=await this.call('/health');if(h.ready&&h.protocolVersion>=5)return h;}catch{}await new Promise(r=>setTimeout(r,300));}
  throw Error('DSH 启动未完成；会话和私有日志已保留，请重试');
 }
 async sessions(){const result=await this.call('/sessions');return{projects:result.projects||[],items:result.items.map(s=>({id:s.sessionId,title:s.projections?.values?.title||s.title||s.name||'未命名会话',workspace:s.cwd||'',projectId:s.projectId,projectName:s.projectName,updatedAt:s.updatedAt,source:'harness',running:!!s.running}))};}
 async create(workspace){return this.call('/sessions/create',{workspace});}
 async entry(){
  await this.start();const log=await fs.readFile(this.location.logFile,'utf8'),entry=log.match(/dsh web:\s+(https?:\/\/\S+)/)?.[1];
  if(!entry||new URL(entry).hostname!=='127.0.0.1')throw Error('尚未取得 DSH 本地界面');return entry;
 }
 async open(){const entry=await this.entry();if(process.platform==='darwin')await this.exec('/usr/bin/open',[entry]);else if(process.platform==='linux')await this.exec('xdg-open',[entry]);else throw Error('请在当前支持的 macOS 或 Linux 打开 DSH');return{opened:true};}
}
