import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {parseDocument,isSeq,isMap} from 'yaml';
import {privateJson} from './storage.mjs';
const exec=promisify(execFile),here=path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ID='duola-agent-hub-desktop';
const runtimeFiles=['dsh-connector.mjs','coding-client.mjs','shared-file-client.mjs','session-routing.mjs','storage.mjs','native-agent.mjs','transport.mjs','network.mjs'];
const read=file=>fs.readFile(file,'utf8').then(JSON.parse);

// Patch only Hub's own plugin node. YAML tags and comments remain data, never evaluated here.
export function desktopPatch(raw,{entry,stateFile}){
 const doc=parseDocument(raw,{keepSourceTokens:true,customTags:[{tag:'tag:yaml.org,2002:js',resolve:s=>s}]});
 if(doc.errors.length||!isSeq(doc.contents))throw Error('桌面版插件配置不是有效列表，原文件保留');
 let existing;
 for(const item of doc.contents.items){
  if(!isMap(item))continue;
  const insert=item.get('insert');if(!isSeq(insert))continue;
  for(const child of insert.items)if(isMap(child)&&child.get('id')===BRIDGE_ID){
   if(existing)throw Error('发现重复的 Hub 桌面插件，未覆盖');
   if(child.getIn(['config','stateFile'])!==stateFile)throw Error('同名桌面插件属于其他连接，未覆盖');
   existing=child;
  }
 }
 if(existing){if(existing.get('name')===entry)return raw;existing.set('name',entry);}
 else doc.contents.add({insert:[{id:BRIDGE_ID,name:entry,config:{stateFile,allowProof:false}}]});
 return String(doc);
}

export class DshDesktopHost {
 constructor(dataDir,{home=os.homedir(),execute=exec,source=here}={}){this.kind='desktop';this.dataDir=dataDir;this.home=home;this.execute=execute;this.source=source;this.root=process.env.AGENT_HUB_TEST_MODE==='1'&&process.env.AGENT_HUB_TEST_DSH_DESKTOP_BRIDGE_ROOT?process.env.AGENT_HUB_TEST_DSH_DESKTOP_BRIDGE_ROOT:path.join(dataDir,'native-bridges/dsh-desktop');this.stateFile=path.join(this.root,'connector.json');this.progress=null;}
 async load(){} // Opening Hub never reads provider login data or changes Desktop settings.
 async discover(){
  const locations=[path.join('/Applications','DeepSeek Harness.app'),path.join(this.home,'Applications','DeepSeek Harness.app')];
  const {stdout}=await this.execute('/bin/ps',['-ax','-o','pid=,command=']);
  const instances=[];
  for(const app of locations){
   const exe=path.join(app,'Contents/MacOS/DeepSeek Harness'),resources=path.join(app,'Contents/Resources'),entry=path.join(resources,'app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'),runtime=path.join(resources,'app.asar/dsh'),payload=path.join(resources,'runtime/primary-runtime');
   for(const line of stdout.split('\n')){
    const match=line.match(/^\s*(\d+)\s+(.+)$/);if(!match||!match[2].startsWith(exe+' ')||!match[2].includes(entry+' '))continue;
    const start=match[2].indexOf(runtime+' ',match[2].indexOf(entry)+entry.length),end=match[2].indexOf(' '+payload,start);
    if(start<0||end<0)continue;const profile=match[2].slice(start+runtime.length+1,end).trim();
    if(!path.isAbsolute(profile)||path.basename(profile)!=='desktop'||path.basename(path.dirname(profile))!=='profiles')continue;
    instances.push({app,profile,pid:Number(match[1])});
   }
  }
  if(instances.length>1)throw Error('发现多个官方桌面运行实例，未猜测或连接其他实例');
  let found=instances[0];
  if(!found)for(const app of locations){try{await fs.access(path.join(app,'Contents/Info.plist'));found={app,profile:path.join(this.home,'.dsh/profiles/desktop')};break;}catch{}}
  if(!found)return{installed:false,running:false};
  const {stdout:version}=await this.execute('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(found.app,'Contents/Info.plist')]);
  return{...found,version:version.trim(),installed:true,running:!!found.pid,supported:version.trim()==='0.2.1-rc.5'};
 }
 async call(route,body){
  const state=await read(this.stateFile),url=new URL(state.controlUrl);
  if(url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw Error('桌面版 Hub 接口地址无效');
  const r=await fetch(new URL(route,url),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+state.controlToken,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(body?20000:4000)});
  const d=await r.json();if(!r.ok)throw Error(d.error||'桌面版 Hub 工具尚未就绪');return d;
 }
 async status(){
  const d=await this.discover();let online=false;
  if(d.running)try{const s=await read(this.stateFile);if(s.pid===d.pid)online=!!(await this.call('/health')).ready;}catch{}
  return{hostKind:'desktop',requiresApiKey:false,installed:d.installed,version:d.version,supported:d.supported,configured:true,model:'沿用桌面版当前模型',online,running:d.running,progress:this.progress};
 }
 async deploy(profile){
  await fs.mkdir(this.root,{recursive:true,mode:0o700});
  let state;try{state=await read(this.stateFile);}catch(e){if(e.code!=='ENOENT')throw Error('桌面版连接记录损坏，原文件保留');state={controlToken:randomBytes(32).toString('base64url'),bindings:[]};await privateJson(this.stateFile,state);}
  const bytes=await Promise.all(runtimeFiles.map(f=>fs.readFile(path.join(this.source,f))));
  const hash=createHash('sha256');for(const b of bytes)hash.update(b);const revision=hash.digest('hex').slice(0,20),folder=path.join(this.root,'revisions',revision);
  try{await fs.access(path.join(folder,'complete.json'));}catch{
   const stage=path.join(this.root,'revisions','.stage-'+randomUUID());await fs.mkdir(path.join(stage,'local'),{recursive:true,mode:0o700});
   for(let i=0;i<runtimeFiles.length;i++)await fs.writeFile(path.join(stage,'local',runtimeFiles[i]),bytes[i]);
   const undici=path.dirname(fileURLToPath(import.meta.resolve('undici/package.json')));await fs.mkdir(path.join(stage,'node_modules'),{recursive:true,mode:0o700});await fs.cp(undici,path.join(stage,'node_modules/undici'),{recursive:true});
   await privateJson(path.join(stage,'package.json'),{type:'module'});await privateJson(path.join(stage,'complete.json'),{revision});
   try{await fs.rename(stage,folder);}catch(e){if(!['EEXIST','ENOTEMPTY'].includes(e.code))throw e;await fs.rm(stage,{recursive:true,force:true});}
  }
  const patchFile=path.join(profile,'cordis.patch.yml'),before=await fs.readFile(patchFile,'utf8'),after=desktopPatch(before,{entry:path.join(folder,'local/dsh-connector.mjs'),stateFile:this.stateFile});
  if(after===before)return;
  const backup=path.join(this.root,'profile-backups',createHash('sha256').update(before).digest('hex')+'.yml');await fs.mkdir(path.dirname(backup),{recursive:true,mode:0o700});try{await fs.writeFile(backup,before,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  if(await fs.readFile(patchFile,'utf8')!==before)throw Error('桌面版插件配置刚有变化，未覆盖；请重新连接');
  const temporary=patchFile+'.hub-'+randomUUID()+'.tmp';await fs.writeFile(temporary,after,{mode:0o600});await fs.rename(temporary,patchFile);
 }
 async start({launch=false}={}){
  if(this.starting)return this.starting;this.starting=this.startOnce({launch}).finally(()=>{this.starting=null;});return this.starting;
 }
 async startOnce({launch}){
  let d=await this.discover();if(!d.installed)throw Error('请先安装并登录官方 DeepSeek Harness 桌面版');if(!d.supported)throw Error('这个桌面版本尚未通过接入兼容验证，未更换或降级软件');
  if(!d.running){if(!launch)throw Error('官方桌面版已关闭，打开后会继续原会话');await this.deploy(d.profile);await this.open();for(let i=0;i<60;i++){d=await this.discover();if(d.running)break;await new Promise(r=>setTimeout(r,300));}if(!d.running)throw Error('请完成官方桌面版启动；没有另开本地 Web 版');}
  this.progress='正在连接已登录的官方桌面版';
  try{
   await this.deploy(d.profile);
   for(let i=0;i<100;i++){try{const state=await read(this.stateFile),health=await this.call('/health');if(state.pid===d.pid&&health.ready&&health.protocolVersion>=7)return health;if(state.pid===d.pid&&health.ready&&health.protocolVersion<7)throw Object.assign(Error('Hub 插件需要重新加载：请在 DeepSeek 当前工作结束后正常退出并重开一次，原登录、项目和会话保留，然后重新连接'),{reloadRequired:true});}catch(e){if(e.reloadRequired)throw e;}await new Promise(r=>setTimeout(r,300));}
   throw Error('桌面版尚未加载 Hub 插件，原登录和会话保留；请在原生插件页查看具体原因');
  }finally{this.progress=null;}
 }
 async sessions(){const r=await this.call('/sessions');return{projects:r.projects||[],existingHint:Array.isArray(r.projects)?'':'DeepSeek 下次正常重开后会同步项目名称，目前按项目文件夹显示。',items:r.items.map(s=>({id:s.sessionId,title:s.projections?.values?.title||s.title||s.name||'新会话',workspace:s.cwd||'',projectId:s.projectId,projectName:s.projectName,updatedAt:s.updatedAt,source:'desktop',running:!!s.running}))};}
 create(workspace){return this.call('/sessions/create',{workspace});}
 async open(){const d=await this.discover();if(!d.installed)throw Error('请先安装官方 DeepSeek Harness 桌面版');await this.execute('/usr/bin/open',['-a',d.app]);return{opened:true};}
 async configure(){throw Error('官方桌面接入沿用原登录与模型，请在官方软件内管理模型配置');}
}
