import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {privateJson} from './storage.mjs';
const execute=promisify(execFile),here=path.dirname(fileURLToPath(import.meta.url));
const SIDECAR='duola-agent-hub';
const assets=['antigravity-sidecar.mjs','antigravity-tools.mjs','coding-client.mjs','storage.mjs','native-agent.mjs','transport.mjs','network.mjs'];
export function sidecarConfig(raw){const d=raw===null?{}:JSON.parse(raw);if(d.sidecars?.[SIDECAR]&&d.sidecars[SIDECAR].enabled!==true)throw Error('Hub 原生连接已在 Antigravity 中停用，请由用户重新启用');return{...d,sidecars:{...d.sidecars,[SIDECAR]:{...(d.sidecars?.[SIDECAR]||{}),enabled:true}}};}
export class AntigravityDesktopHost {
 constructor(dataDir,{home=os.homedir(),exec=execute,source=here}={}){Object.assign(this,{dataDir,home,exec,source});this.kind='antigravity-desktop';this.root=process.env.AGENT_HUB_TEST_MODE==='1'&&process.env.AGENT_HUB_TEST_ANTIGRAVITY_BRIDGE_ROOT||path.join(dataDir,'native-bridges/antigravity-desktop');this.stateFile=path.join(this.root,'connector.json');}
 async load(){}
 async discover(){
  const app='/Applications/Antigravity.app';try{await fs.access(app);}catch{return{installed:false,running:false};}
  const version=(await this.exec('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(app,'Contents/Info.plist')])).stdout.trim();
  const ps=(await this.exec('/bin/ps',['-ax','-o','pid=,command='])).stdout;const exe=app+'/Contents/Resources/bin/language_server';
  const rows=ps.split('\n').map(l=>l.match(/^\s*(\d+)\s+(.+)$/)).filter(m=>m&&m[2].startsWith(exe+' ')&&m[2].includes('--standalone'));
  if(rows.length>1)throw Error('多个 Antigravity 桌面运行端，未猜测实例');
  return{app,version,installed:true,supported:version==='2.28.0',running:rows.length===1,pid:rows[0]?Number(rows[0][1]):null};
 }
 async call(route,body){
  const s=JSON.parse(await fs.readFile(this.stateFile)),url=new URL(s.controlUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw Error('Invalid native Hub endpoint');
  const r=await fetch(new URL(route,url),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+s.controlToken,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(body?30000:15000)});const d=await r.json();if(!r.ok)throw Error(d.error||'官方桌面连接尚未就绪');return d;
 }
 async status(){const d=await this.discover();let online=false;if(d.running)try{const s=JSON.parse(await fs.readFile(this.stateFile));online=s.nativePid===d.pid&&!!(await this.call('/health')).ready;}catch{}return{...d,hostKind:this.kind,configured:true,online,progress:this.progress,model:'沿用原桌面会话的模型'};}
 async deploy(){
  await fs.mkdir(this.root,{recursive:true,mode:0o700});try{await fs.access(this.stateFile);}catch(e){if(e.code!=='ENOENT')throw e;await privateJson(this.stateFile,{controlToken:randomBytes(32).toString('base64url'),bindings:[],deliveries:{}});}
  const bytes=await Promise.all(assets.map(f=>fs.readFile(path.join(this.source,f))));const hash=createHash('sha256');for(const b of bytes)hash.update(b);const revision=hash.digest('hex').slice(0,20),folder=path.join(this.root,'revisions',revision);
  try{await fs.access(path.join(folder,'complete.json'));}catch{
   const temp=path.join(this.root,'revisions','.stage-'+randomUUID());await fs.mkdir(path.join(temp,'local'),{recursive:true,mode:0o700});for(let i=0;i<assets.length;i++)await fs.writeFile(path.join(temp,'local',assets[i]),bytes[i]);await fs.mkdir(path.join(temp,'node_modules'),{recursive:true});await fs.cp(path.dirname(fileURLToPath(import.meta.resolve('undici/package.json'))),path.join(temp,'node_modules/undici'),{recursive:true});await privateJson(path.join(temp,'package.json'),{type:'module'});await privateJson(path.join(temp,'complete.json'),{revision});await fs.rename(temp,folder);
  }
  const dir=path.join(this.home,'.gemini/config/sidecars',SIDECAR),manifestFile=path.join(dir,'sidecar.json');await fs.mkdir(dir,{recursive:true,mode:0o700});
  let oldManifest;try{oldManifest=JSON.parse(await fs.readFile(manifestFile));if(oldManifest.hubOwner!==this.stateFile)throw Error('同名 Sidecar 属于其他连接，未覆盖');}catch(e){if(e.code!=='ENOENT')throw e;}
  const manifest={hubOwner:this.stateFile,command:'node',args:[path.join(folder,'local/antigravity-sidecar.mjs'),this.stateFile],restart_policy:'on-failure',display_name:'Agent Hub 原会话连接',description:'仅唤醒用户选择的原会话；原工作忙碌时排队'};
  if(JSON.stringify(oldManifest)!==JSON.stringify(manifest))await privateJson(manifestFile,manifest);
  const file=path.join(this.home,'.gemini/config/config.json');let before;try{before=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;before=null;}
  const after=sidecarConfig(before);if(JSON.stringify(after)===JSON.stringify(JSON.parse(before||'{}')))return revision;
  await fs.mkdir(path.join(this.root,'config-backups'),{recursive:true,mode:0o700});await fs.writeFile(path.join(this.root,'config-backups',Date.now()+'.json'),before||'{}',{mode:0o600});
  if(await fs.readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;})!==before)throw Error('Antigravity 配置刚有变化，原文件保留');await privateJson(file,after);return revision;
 }
 async start({launch=false}={}){if(this.starting)return this.starting;this.starting=this.startOnce(launch).finally(()=>this.starting=null);return this.starting;}
 async reloadOwnSidecar(){
  const file=path.join(this.home,'.gemini/config/config.json'),before=JSON.parse(await fs.readFile(file));
  if(before.sidecars?.[SIDECAR]?.enabled!==true)throw Error('Hub 原生连接已被用户停用');
  await privateJson(file,{...before,sidecars:{...before.sidecars,[SIDECAR]:{...before.sidecars[SIDECAR],enabled:false}}});
  try{for(let i=0;i<30;i++){try{await this.call('/health');}catch{break;}await new Promise(r=>setTimeout(r,100));}}
  finally{const current=JSON.parse(await fs.readFile(file));if(current.sidecars?.[SIDECAR]?.enabled===false)await privateJson(file,{...current,sidecars:{...current.sidecars,[SIDECAR]:{...current.sidecars[SIDECAR],enabled:true}}});}
 }
 async startOnce(launch){let d=await this.discover();if(!d.installed)throw Error('请先安装并登录官方 Antigravity 桌面版');if(!d.supported)throw Error('此桌面版本尚未通过兼容验证，未更换原软件');if(!d.running){if(!launch)throw Error('原 Antigravity 桌面版已退出，打开后继续原会话');await this.open();for(let i=0;i<60;i++){d=await this.discover();if(d.running)break;await new Promise(r=>setTimeout(r,300));}}this.progress='正在连接官方桌面原会话';try{const revision=await this.deploy();let old;try{old=await this.call('/health');}catch{}if(old&&old.revision!==revision)await this.reloadOwnSidecar();for(let i=0;i<100;i++){if((await this.status()).online){const health=await this.call('/health');if(health.revision===revision)return health;}await new Promise(r=>setTimeout(r,300));}throw Error('官方 Sidecar 尚未就绪，原登录和会话保留');}finally{this.progress=null;}}
 sessions(){return this.call('/sessions');}
 create(){throw Error('请在官方桌面开启工作会话，或选择 Hub 的独立后台助手');}
 async open(){await this.exec('/usr/bin/open',['-a','/Applications/Antigravity.app']);return{opened:true};}
}
