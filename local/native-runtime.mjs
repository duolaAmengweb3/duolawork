import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fetch} from 'undici';
import {networkDispatcher,requestJson} from './transport.mjs';
import {privateJson} from './storage.mjs';
import {findExecutable} from './native-agent.mjs';
const exec=promisify(execFile);
export const CODEX_RELEASE={version:'0.165.0',assets:{"darwin-arm64":{"name":"codex-aarch64-apple-darwin","url":"https://github.com/openai/codex/releases/download/rust-v0.165.0/codex-aarch64-apple-darwin.tar.gz","sha256":"78ea9c178d2dc8fde71d6494df3b9eab902fd6d6de0a84e65234220d93bb6144","bytes":102366249},"darwin-x64":{"name":"codex-x86_64-apple-darwin","url":"https://github.com/openai/codex/releases/download/rust-v0.165.0/codex-x86_64-apple-darwin.tar.gz","sha256":"f46451741936ebdf5201b8becd0820a41be2a01d271b98703e0d9a1670c99993","bytes":111288240},"linux-arm64":{"name":"codex-aarch64-unknown-linux-musl","url":"https://github.com/openai/codex/releases/download/rust-v0.165.0/codex-aarch64-unknown-linux-musl.tar.gz","sha256":"6522e056d0be7f531da915c9a81ae05bc70811b782542499cc0a9776d3abf5d3","bytes":107804617},"linux-x64":{"name":"codex-x86_64-unknown-linux-musl","url":"https://github.com/openai/codex/releases/download/rust-v0.165.0/codex-x86_64-unknown-linux-musl.tar.gz","sha256":"be635d3486a5bd060d0fff582ae6d30160280c31344dd85719707fa920e187f0","bytes":115837472}}};
// Pinned Google release, verified against ACP Registry on 2026-11-03.
export const ACP_RELEASE={version:'1.4.5',assets:{
 'darwin-arm64':{url:'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip',sha256:'886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f',bytes:97923855,files:{'agy_acp_server.par':178915920,'localharness_external':122957936}},
 'darwin-x64':{url:'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-x86_64.zip',sha256:'b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a',bytes:103577295,files:{'agy_acp_server.par':183127600,'localharness_external':127612208}},
 'linux-x64':{url:'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-x86_64.zip',sha256:'923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b',bytes:321783181,files:{'agy_acp_server.par':826226766,'localharness_external':133926136}},
 'linux-arm64':{url:'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-arm64.zip',sha256:'7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056',bytes:307829008,files:{'agy_acp_server.par':831194025,'localharness_external':127512832}}
}};
export async function downloadVerified(asset,file,{progress=()=>{},fetchImpl=fetch}={}){
 let target=asset.url,response;const deadline=AbortSignal.timeout(5*60000);
 for(let redirects=0;redirects<5;redirects++){
  response=await fetchImpl(target,{dispatcher:networkDispatcher(),redirect:'manual',signal:deadline});
  if(![301,302,303,307,308].includes(response.status))break;
  const next=new URL(response.headers.get('location'),target);await response.body?.cancel();if(next.protocol!=='https:'||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','dl.google.com'].includes(next.hostname))throw new Error('官方下载跳转到了未核验的主机');target=next.href;
 }
 if(!response.ok)throw new Error('官方组件下载失败：HTTP '+response.status);
 const hash=createHash('sha256'),handle=await fs.open(file,'wx',0o600);let bytes=0;
 try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>asset.bytes)throw new Error('下载内容超过已核验版本大小');hash.update(chunk);await handle.write(chunk);progress({downloadedBytes:bytes,totalBytes:asset.bytes});}}
 finally{await handle.close();}
 if(bytes!==asset.bytes||hash.digest('hex')!==asset.sha256)throw new Error('官方组件校验不通过，未安装');
}
export class NativeRuntime{
 constructor(dataDir){this.root=path.join(dataDir,'native-runtimes');this.jobs=new Map();this.state={};}
 async find(engine){
  if(engine==='codex'){const installed=await findExecutable('codex');if(installed)return{command:installed,source:'existing',args:['app-server']};try{const meta=JSON.parse(await fs.readFile(path.join(this.root,'codex/active.json'),'utf8'));await fs.access(meta.command,1);return meta;}catch{return null;}}
  const base=path.join(this.root,'antigravity',ACP_RELEASE.version,process.platform+'-'+process.arch),command=path.join(base,'agy_acp_server.par');
  try{const meta=JSON.parse(await fs.readFile(path.join(base,'installed.json'),'utf8'));if(meta.version!==ACP_RELEASE.version)return null;for(const [name,size] of Object.entries(ACP_RELEASE.assets[process.platform+'-'+process.arch]?.files||{})){const stat=await fs.stat(path.join(base,name));if(!stat.isFile()||stat.size!==size)return null;}await fs.access(command,1);return{command,harness:path.join(base,'localharness_external'),args:process.platform==='linux'?['--uid=']:[],version:ACP_RELEASE.version,source:'managed'};}catch{return null;}
 }
 async ensure(engine,onProgress=()=>{}){
  const ready=await this.find(engine);if(ready)return ready;
  if(this.jobs.has(engine))return this.jobs.get(engine);
  const job=(engine==='codex'?this.installCodex(onProgress):this.installAcp(onProgress)).finally(()=>this.jobs.delete(engine));this.jobs.set(engine,job);return job;
 }
 async installAcp(onProgress){
  const key=process.platform+'-'+process.arch,asset=ACP_RELEASE.assets[key];if(!asset)throw new Error('当前系统暂未验证自动安装，请使用受支持的 macOS 或 Linux 环境');
  const parent=path.join(this.root,'antigravity',ACP_RELEASE.version);await fs.mkdir(parent,{recursive:true,mode:0o700});const stage=path.join(parent,'.install-'+randomUUID()),archive=path.join(stage,'download.zip'),destination=path.join(parent,key);await fs.mkdir(stage,{mode:0o700});
  try{
   onProgress({phase:'installing',message:'正在下载 Google 官方连接组件'});await downloadVerified(asset,archive,{progress:p=>onProgress({phase:'installing',...p,message:'正在下载 Google 官方连接组件'})});
   const {stdout}=await exec('unzip',['-Z','-1',archive]);const members=stdout.trim().split('\n');if(members.length!==2||members.some(name=>!Object.hasOwn(asset.files,name)))throw new Error('官方组件压缩包内容与核验版本不符');
   const unpack=path.join(stage,'runtime');await fs.mkdir(unpack,{mode:0o700});await exec('unzip',['-q',archive,'-d',unpack],{timeout:120000});
   for(const [name,size] of Object.entries(asset.files)){const f=path.join(unpack,name),stat=await fs.lstat(f);if(!stat.isFile()||stat.size!==size)throw new Error('官方运行文件大小不符');await fs.chmod(f,0o755);}
   await privateJson(path.join(unpack,'installed.json'),{version:ACP_RELEASE.version,sha256:asset.sha256,source:asset.url,at:new Date().toISOString()});
   try{await fs.rename(unpack,destination);}catch(e){if(!['EEXIST','ENOTEMPTY'].includes(e.code)||!await this.find('antigravity'))throw e;}
   onProgress({phase:'installed',message:'官方连接组件已准备好'});return this.find('antigravity');
  }finally{await fs.rm(stage,{recursive:true,force:true});}
 }
 async installCodex(onProgress){
  const asset=CODEX_RELEASE.assets[process.platform+'-'+process.arch];if(!asset)throw new Error('此系统暂未提供 Codex 自动安装');
  const destination=path.join(this.root,'codex');await fs.mkdir(destination,{recursive:true,mode:0o700});const stage=await fs.mkdtemp(path.join(destination,'.install-')),archive=path.join(stage,'download.tar.gz');
  try{
   onProgress({phase:'installing',message:'正在下载 OpenAI 官方 Codex 运行组件'});await downloadVerified(asset,archive,{progress:p=>onProgress({phase:'installing',...p,message:'正在下载 OpenAI 官方 Codex 运行组件'})});
   const {stdout}=await exec('tar',['-tzf',archive]);if(stdout.trim()!==asset.name)throw new Error('Codex 压缩包内容与核验版本不符');await exec('tar',['-xzf',archive,'-C',stage],{timeout:120000});
   const binary=path.join(stage,asset.name),stat=await fs.lstat(binary);if(!stat.isFile())throw new Error('Codex 运行文件不正确');await fs.chmod(binary,0o755);const command=path.join(destination,'codex-'+CODEX_RELEASE.version);await fs.rename(binary,command);
   const meta={command,args:['app-server'],source:'managed',version:CODEX_RELEASE.version};await privateJson(path.join(destination,'active.json'),meta);return meta;
  }finally{await fs.rm(stage,{recursive:true,force:true});}
 }
 async discover(){return{engines:await Promise.all(['codex','antigravity'].map(async id=>({id,name:id==='codex'?'Codex':'Gemini · Antigravity',...(await this.find(id)),installed:!!await this.find(id),canInstall:id==='codex'||!!ACP_RELEASE.assets[process.platform+'-'+process.arch]})))};}
}
