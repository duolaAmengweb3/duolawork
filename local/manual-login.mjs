import fs from 'node:fs/promises';
import {readFileSync,readlinkSync} from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {privateJson} from './storage.mjs';
import {prepareBrowserProfile,browserVersionRecord} from './data-policy.mjs';
import {assertHttpUrl} from '../shared/platforms.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Authentication is a human-only browser session. No CDP, WebDriver,
// page injection, credential reads, or automation concealment is used here.
export class ManualLoginSessions{
 constructor(manager){this.manager=manager;this.entries=new Map();this.transitions=new Set();}
 has(id){return this.entries.has(id)||this.transitions.has(id);}
 owned(pid,dir,proxyUrl){
  try{const command=execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8',timeout:2000});
   const profile=JSON.parse(readFileSync(path.join(dir,'hub-profile.json'),'utf8'));
   return command.startsWith(profile.browserExecutable+' ')&&command.includes('--user-data-dir='+dir+' ')&&!/--remote-debugging|--headless|--enable-automation/.test(command)&&
    (proxyUrl===undefined||(proxyUrl?command.includes('--proxy-server='+proxyUrl+' '):!command.includes('--proxy-server=')));
  }catch{return false;}
 }
 resolve(entry){
  if(this.owned(entry.pid,entry.dir,entry.proxyUrl))return entry.pid;
  // Chrome's own update/relaunch changes PID. Resolve only the exact bound
  // profile lock, executable and proxy, never another Chrome or profile.
  try{const pid=Number(readlinkSync(path.join(entry.dir,'SingletonLock')).match(/-(\d+)$/)?.[1]);if(pid&&this.owned(pid,entry.dir,entry.proxyUrl)){entry.pid=pid;return pid;}}catch{}
  return null;
 }
 async recover(account,record,dir){
  await this.manager.checkProfile(account.id,dir);
  // An exited manual session still waits for explicit return. A restart must
  // not silently attach automation while the user is authenticating.
  this.entries.set(account.id,{accountId:account.id,pid:record.pid,dir,proxyUrl:record.proxyUrl||'',startedAt:record.startedAt});
 }
 async recoverUntracked(account,dir){
  if(!(await this.manager.registry()).accounts[account.id])return;
  await this.manager.checkProfile(account.id,dir);
  const entry={accountId:account.id,pid:0,dir,proxyUrl:this.manager.proxy()||'',startedAt:new Date().toISOString()};
  if(!this.resolve(entry))return;
  this.entries.set(account.id,entry);
  await privateJson(path.join(dir,'hub-owner.json'),{...entry,mode:'manual-login'});
 }
 status(){return Object.fromEntries([...this.entries.values()].map(e=>[e.accountId,{running:!!this.resolve(e),startedAt:e.startedAt}]));}
 list(){return [...this.entries.values()].filter(e=>this.resolve(e)).map(e=>({accountId:e.accountId,pid:e.pid,manualLogin:true,visible:true,background:false,proxyUrl:e.proxyUrl}));}
 async open(account,{url,proxyUrl,proxyArgs}={}){
  if(!/^account_[a-z0-9]+$/.test(account.id))throw new Error('账号编号无效');
  const target=assertHttpUrl(url||account.entryUrl,{allowLoopback:this.manager.testMode});
  if(this.transitions.has(account.id)||this.manager.starting.has(account.id))throw new Error('此账号正在切换登录方式，请稍候');
  if(this.entries.has(account.id))return{manualLogin:true,reused:true,running:!!this.resolve(this.entries.get(account.id))};
  this.transitions.add(account.id);
  try{
   const dir=path.join(this.manager.root,account.id),current=this.manager.active.get(account.id);
   if(current){await this.manager.close(account.id);if(this.manager.ownedPid(current.child.pid,dir))throw new Error('原账号浏览器尚未退出，未同时打开同一资料目录');}
   await fs.mkdir(this.manager.root,{recursive:true,mode:0o700});await this.manager.checkProfile(account.id,dir);await fs.mkdir(dir,{recursive:true,mode:0o700});
   try{await fs.access(path.join(dir,'SingletonLock'));throw new Error('原账号目录仍被浏览器占用，已停止；不会打开第二实例或换空白目录');}catch(e){if(e.code!=='ENOENT')throw e;}
   const profile=await prepareBrowserProfile(dir,account.id,()=>this.manager.findChrome(),{requestedBrowser:this.manager.executable||process.env.AGENT_HUB_CHROME});profile.accountId=account.id;
   const version=execFileSync(profile.executable,['--version'],{encoding:'utf8',timeout:5000}).trim();await privateJson(profile.info,browserVersionRecord(profile,version));
   const child=spawn(profile.executable,[`--user-data-dir=${dir}`,'--no-first-run','--no-default-browser-check','--restore-last-session',...proxyArgs,...(this.manager.testMode?['--start-minimized']:[]),target],{stdio:'ignore'});
   let spawnError;child.on('error',error=>{spawnError=error;});
   for(let i=0;i<40;i++){if(spawnError)throw spawnError;if(child.exitCode!==null)throw new Error('普通 Chrome 未能打开，原登录资料已保留');if(this.owned(child.pid,dir))break;await wait(100);}
   if(!this.owned(child.pid,dir))throw new Error('无法确认手动登录浏览器归属，未接入或读取页面');
   const entry={accountId:account.id,pid:child.pid,dir,proxyUrl,startedAt:new Date().toISOString()};this.entries.set(account.id,entry);
   await this.manager.recordProfile(account.id,dir);
   await privateJson(path.join(dir,'hub-owner.json'),{...entry,mode:'manual-login'});
   return{manualLogin:true,reused:false,accountId:account.id};
  }finally{this.transitions.delete(account.id);}
 }
 async close(id,{finish=false}={}){
  const entry=this.entries.get(id);if(!entry)return{closed:false};
  const pid=this.resolve(entry);
  if(pid){process.kill(pid,'SIGTERM');for(let i=0;i<150&&this.resolve(entry);i++)await wait(100);if(this.resolve(entry))throw new Error('Chrome 尚未完成保存退出，已保留现场，未启动另一实例');}
  // A lock with an unrecognised owner must not lose its manual-session guard.
  try{await fs.access(path.join(entry.dir,'SingletonLock'));throw new Error('原账号目录仍有未确认的浏览器占用，保留登录现场，未切换控制方式');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(finish){await fs.rm(path.join(entry.dir,'hub-owner.json'),{force:true});this.entries.delete(id);}
  return{closed:true,manualLogin:!finish};
 }
 async closeAll(){for(const id of this.entries.keys())await this.close(id);}
}
