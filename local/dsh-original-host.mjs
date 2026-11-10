import fs from 'node:fs/promises';
import path from 'node:path';
import {DshDesktopHost,desktopPatch} from './dsh-desktop.mjs';
import {privateJson} from './storage.mjs';

const read=file=>fs.readFile(file,'utf8').then(JSON.parse);

// The official shell-env registry supplies these facts for each native tool
// call. Never infer an original Host from a recently modified directory.
export async function originalDshContext(env=process.env){
 if(env.DSH_SHELL!=='1'||!env.DSH_PROFILE_DIR||!env.DSH_HOME||!/^[-\w]{1,100}$/.test(env.DSH_PROFILE||'')||!env.DSH_SESSION_ID)throw Error('请把接入说明发给正在使用的 DeepSeek Harness，让它在原对话里执行；不要在另一个终端猜测项目或会话');
 const profile=await fs.realpath(env.DSH_PROFILE_DIR),home=await fs.realpath(env.DSH_HOME);
 if(profile!==await fs.realpath(path.join(home,'profiles',env.DSH_PROFILE))||!/^[a-zA-Z0-9_-]{1,100}$/.test(env.DSH_SESSION_ID))throw Error('原生运行环境无法核对，未连接其他项目');
 const pkg=await read(path.join(profile,'package.json'));
 if(!Array.isArray(pkg.dsh?.profile?.bundles))throw Error('这不是可识别的官方 Harness 运行配置');
 if((await fs.stat(profile)).uid!==process.getuid())throw Error('请在 Harness 原系统用户下执行接入说明');
 return{profile,home,name:env.DSH_PROFILE,sessionId:env.DSH_SESSION_ID};
}

export class DshOriginalHost extends DshDesktopHost{
 constructor(dataDir,options={}){super(dataDir,options);this.kind='original';this.root=path.join(dataDir,'native-bridges/dsh-original');this.stateFile=path.join(this.root,'connector.json');this.originFile=path.join(this.root,'origin.json');}
 async register(env=process.env){
  const origin=await originalDshContext(env);let prior;
  try{prior=await read(this.originFile);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(prior&&(prior.profile!==origin.profile||prior.home!==origin.home))throw Error('此成员已经连接另一个 Harness 环境，原连接保留');
  // Validate ownership before granting access or changing the original profile.
  const raw=await fs.readFile(path.join(origin.profile,'cordis.patch.yml'),'utf8');
  desktopPatch(raw,{entry:'preflight-only',stateFile:this.stateFile});
  await privateJson(this.originFile,prior||origin);
  await this.deploy(origin.profile);
  await this.startOnce();
  if(!(await this.sessions()).items.some(s=>s.id===origin.sessionId))throw Error('原 Host 未找到执行安装的这段对话，未绑定其他会话');
  return origin;
 }
 async discover(){
  let origin;try{origin=await read(this.originFile);}catch(e){if(e.code==='ENOENT')return{installed:false,running:false};throw e;}
  let health;try{health=await this.call('/health');}catch{}
  const running=health?.profile?.dir===origin.profile;
  return{installed:true,supported:true,running,profile:origin.profile,online:running&&health.ready,version:health?.protocolVersion};
 }
 async status(){const d=await this.discover();return{hostKind:'original',requiresApiKey:false,installed:d.installed,supported:d.supported,configured:d.installed,model:'沿用原 Harness 的模型',online:d.online,running:d.running,progress:this.progress};}
 async startOnce(){
  const origin=await read(this.originFile).catch(()=>{throw Error('请在原 Harness 对话里执行接入说明');});
  await this.deploy(origin.profile);
  for(let n=0;n<50;n++){
   let h;try{h=await this.call('/health');}catch{}
   if(h?.ready&&h.protocolVersion>=7&&h.profile?.dir===origin.profile)return h;
   await new Promise(r=>setTimeout(r,300));
  }
  throw Error('原 Harness 尚未加载连接组件。请让原 Agent 检查当前插件加载状态；原登录、项目和对话均保留，没有另开运行环境');
 }
 async open(){throw Error('请在原电脑或服务器打开已有的 DeepSeek Harness，连接会自动恢复');}
 async configure(){throw Error('沿用原 Harness 的登录和模型，请在原软件中修改');}
}
