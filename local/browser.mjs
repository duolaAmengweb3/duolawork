import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isIP } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { dataDir, privateJson } from './storage.mjs';
import { prepareBrowserProfile, browserVersionRecord } from './data-policy.mjs';
import { assertHttpUrl } from '../shared/platforms.mjs';
import {BackgroundPage} from './background-page.mjs';
import {ManualLoginSessions} from './manual-login.mjs';
import {closeOwnedBrowser} from './browser-process.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));

export function normalizeBrowserProxy(value='') {
 if(typeof value!=='string')throw new Error('请输入本机代理地址');
 if(!value.trim())return '';
 let url;try{url=new URL(value.trim());}catch{throw new Error('请输入完整本机代理地址，例如 http://127.0.0.1:17898');}
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!url.port||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('只接受不含账号密码的本机 HTTP 代理地址；家宽凭证由已有代理服务保管');
 return url.origin;
}
export function browserProxyArgs(value) {
 const proxy=normalizeBrowserProxy(value);
 return proxy?[`--proxy-server=${proxy}`,'--proxy-bypass-list=localhost;127.0.0.1;[::1]','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']:[];
}
export class BrowserManager {
 constructor({root=path.join(dataDir,'profiles'),executable,limit=()=>1,proxy=()=>'',testMode=false}={}){this.root=path.resolve(root);this.registryFile=path.join(path.dirname(this.root),'browser-profiles.json');this.profileWrites=Promise.resolve();this.executable=executable;this.limit=limit;this.proxy=proxy;this.testMode=testMode;this.active=new Map();this.starting=new Set();this.restoring=new Map();this.automatedStarting=new Set();this.pendingOperations=new Set();this.operationsByAccount=new Map();this.closingAccounts=new Set();this.accountClosures=new Map();this.pendingLaunches=new Map();this.disconnected=new Map();this.manual=new ManualLoginSessions(this);}
 async operation(run,accountId){if(this.closingAll||this.closingAccounts.has(accountId))throw new Error('专用浏览器正在退出，请稍后再打开');const job=run();this.pendingOperations.add(job);const jobs=this.operationsByAccount.get(accountId)||new Set();jobs.add(job);this.operationsByAccount.set(accountId,jobs);try{return await job;}finally{this.pendingOperations.delete(job);jobs.delete(job);if(!jobs.size)this.operationsByAccount.delete(accountId);}}
 remember(accountId,entry){this.active.set(accountId,entry);this.disconnected.delete(entry.child.pid);entry.browser.on('disconnected',()=>{if(this.active.get(accountId)===entry)this.active.delete(accountId);if(this.ownedPid(entry.child.pid,path.join(this.root,accountId)))this.disconnected.set(entry.child.pid,entry);});}
 async dispose(accountId,entry){await closeOwnedBrowser(entry,()=>this.ownedPid(entry.child.pid,path.join(this.root,accountId)));if(this.active.get(accountId)===entry)this.active.delete(accountId);this.disconnected.delete(entry.child.pid);}
 isManual(id){return this.manual.has(id);}
 async openManual(account,{url}={}){return this.operation(()=>{const proxyUrl=normalizeBrowserProxy(this.proxy());return this.manual.open(account,{url,proxyUrl,proxyArgs:browserProxyArgs(proxyUrl)});},account.id);}
 async registry(){try{const data=JSON.parse(await fs.readFile(this.registryFile,'utf8'));if(data.schemaVersion!==1||!data.accounts||typeof data.accounts!=='object')throw new Error('invalid registry');return data;}catch(e){if(e.code==='ENOENT')return{schemaVersion:1,accounts:{}};throw new Error('浏览器账号目录索引无法读取，保留全部登录资料并停止打开。');}}
 async checkProfile(accountId,directory){const registered=(await this.registry()).accounts[accountId];if(!registered)return;try{if(path.resolve(registered.directory)!==path.resolve(directory))throw new Error('directory changed');const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('directory invalid');await fs.access(path.join(directory,'hub-profile.json'));}catch{throw new Error('原账号登录资料目录缺失或已移动，已停止打开；不会创建空白环境要求重新登录。');}}
 async recordProfile(accountId,directory){this.profileWrites=this.profileWrites.then(async()=>{const registry=await this.registry();registry.accounts[accountId]={directory:path.resolve(directory)};await privateJson(this.registryFile,registry);});return this.profileWrites;}
 async findChrome(){const candidates=[this.executable,process.env.AGENT_HUB_CHROME,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium',process.platform==='linux'?'/usr/bin/google-chrome':null].filter(Boolean);for(const c of candidates)try{await fs.access(c);return c;}catch{}throw new Error('未找到完整 Chrome。请安装 Chrome 后重新打开工作台，不会使用日常资料目录。');}
 ownedPid(pid,dir){try{if(!Number.isSafeInteger(pid)||pid<=0)return false;const profile=JSON.parse(readFileSync(path.join(dir,'hub-profile.json'),'utf8'));if(!profile.browserExecutable)return false;const command=execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8',timeout:2000});return command.startsWith(profile.browserExecutable+' ')&&command.includes('--user-data-dir='+dir+' ')&&command.includes('--remote-debugging-port=0');}catch{return false;}}
 async recover(accounts){for(const account of accounts.filter(a=>a.status!=='disabled')){if(this.active.has(account.id)||this.isManual(account.id)||!/^account_[a-z0-9]+$/.test(account.id))continue;const dir=path.join(this.root,account.id);try{const record=JSON.parse(await fs.readFile(path.join(dir,'hub-owner.json'),'utf8'));if(record.accountId!==account.id)continue;if(record.mode==='manual-login'){await this.manual.recover(account,record,dir);continue;}if(!this.ownedPid(record.pid,dir))continue;if(normalizeBrowserProxy(record.proxyUrl||'')!==normalizeBrowserProxy(this.proxy()))continue;const [port,route]=(await fs.readFile(path.join(dir,'DevToolsActivePort'),'utf8')).trim().split('\n');const endpoint=`ws://127.0.0.1:${Number(port)}${route}`;let browser,workPage;try{browser=await chromium.connectOverCDP(endpoint,{timeout:15000});}catch(e){if(!(record.headed??!!record.visible)||!String(e.message).includes('Browser context management is not supported'))throw e;
 // Chrome with its final window closed cannot initialise a CDP context until
 // a target exists. A blank hidden target restores the engine, not a login.
 workPage=await BackgroundPage.create(endpoint,'about:blank');try{browser=await chromium.connectOverCDP(endpoint,{timeout:15000});}catch(e){workPage.close();throw e;}}
 const self=this;const child={pid:record.pid,get exitCode(){return self.ownedPid(record.pid,dir)?null:0;},kill(signal){if(self.ownedPid(record.pid,dir))process.kill(record.pid,signal);}};this.remember(account.id,{child,browser,context:browser.contexts()[0],workPage,endpoint:`ws://127.0.0.1:${Number(port)}${route}`,headed:record.headed??!!record.visible,visible:!!record.visible,lastUsed:Date.now(),accountId:account.id,proxyUrl:normalizeBrowserProxy(record.proxyUrl||''),recovered:true});}catch(e){if(e.code==='ENOENT')await this.manual.recoverUntracked(account,dir).catch(()=>{});/* Never terminate unknown processes. */}}}
 open(account,options={}){return this.operation(()=>this.openAccount(account,options),account.id);}
 async openAccount(account,{url,visible=true,navigate=true,background=false}={}){if(!/^account_[a-z0-9]+$/.test(account.id))throw new Error('账号编号无效');if(this.isManual(account.id))throw new Error('此账号正在纯手动登录；完成后请在工作台点击“登录完成，返回工作台”，当前不会读取或控制登录页面。');const target=assertHttpUrl(url||account.entryUrl,{allowLoopback:this.testMode}),proxyUrl=normalizeBrowserProxy(this.proxy());if(this.starting.has(account.id))throw new Error('此账号浏览器正在启动，请稍候');let current=this.active.get(account.id);if(current&&current.headed!==(visible||background))throw new Error('此账号已有不同运行模式的专用窗口，请先在工作台关闭后再切换，避免打断登录或任务。');
 if(current&&current.proxyUrl!==proxyUrl)throw new Error('此账号窗口使用旧出口，请先关闭专用窗口后重新打开，登录资料会保留。');
 if(current&&background)return this.ensureBackground(account,{url:target});
 if(current){const existing=current.context.pages()[0],page=existing||await current.context.newPage();if(visible)await page.bringToFront();if(navigate||!existing)await page.goto(!existing&&current.workPage?.url()!=='about:blank'?current.workPage?.url()||target:target,{waitUntil:'domcontentloaded',timeout:30000}).catch(e=>{if(!visible)throw e;throw new Error('专用浏览器已打开，但登录网站连接失败。请检查当前出口；未自动切换到其他网络，也未清除登录资料。');});current.lastUsed=Date.now();return{accountId:account.id,visible,reused:true};}
 // Persistent account sessions are not executing jobs. A user's login must
 // never be blocked by an idle signed-in Agent consuming an execution slot.
 const automated=!visible&&!background;
 if(automated&&[...this.active.values()].filter(entry=>!entry.headed).length+this.automatedStarting.size>=this.limit())throw new Error('已达到自动执行上限，请等待当前执行结束。账号登录不受此限制。');
 this.starting.add(account.id);if(automated)this.automatedStarting.add(account.id);
 let launch,retainVisibleWindow=false;
 try{await fs.mkdir(this.root,{recursive:true,mode:0o700});const dir=path.join(this.root,account.id);await this.checkProfile(account.id,dir);await fs.mkdir(dir,{recursive:true,mode:0o700});
 // Non-default dedicated profile. A recorded PID is never blindly killed after restart.
 try{await fs.access(path.join(dir,'SingletonLock'));throw new Error('此专用账号目录已有浏览器在运行；请先从工作台关闭该账号窗口，不会结束未知进程。');}catch(e){if(e.code!=='ENOENT')throw e;}
 await fs.rm(path.join(dir,'DevToolsActivePort'),{force:true});
 const profile=await prepareBrowserProfile(dir,account.id,()=>this.findChrome(),{requestedBrowser:this.executable||process.env.AGENT_HUB_CHROME});profile.accountId=account.id;const executable=profile.executable;const version=execFileSync(executable,['--version'],{encoding:'utf8',timeout:5000}).trim();await privateJson(profile.info,browserVersionRecord(profile,version));if(this.closingAll||this.closingAccounts.has(account.id))throw new Error('专用浏览器正在退出，已取消启动');const child=spawn(executable,[`--user-data-dir=${dir}`,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check','--restore-last-session',...browserProxyArgs(proxyUrl),...(background?['--no-startup-window']:visible?[]:['--headless=new']),...(background?[]:['about:blank'])],{stdio:'ignore'});
 launch={child,accountId:account.id};this.pendingLaunches.set(account.id,launch);let spawnError;child.on('error',error=>{spawnError=error;});
 let endpoint;for(let i=0;i<120;i++){if(this.closingAll||this.closingAccounts.has(account.id))throw new Error('专用浏览器正在退出，已取消启动');if(spawnError)throw spawnError;if(child.exitCode!==null||child.signalCode)throw new Error('专用浏览器退出：资料目录可能已被占用，请在工作台关闭该账号窗口再重试。');try{const txt=await fs.readFile(path.join(dir,'DevToolsActivePort'),'utf8');const [port,route]=txt.trim().split('\n');endpoint=`ws://127.0.0.1:${Number(port)}${route}`;if(Number(port)>0)break;}catch{}await pause(100);}
 if(!endpoint)throw new Error('专用浏览器启动超时，未修改日常 Chrome。');
 launch.endpoint=endpoint;const browser=launch.browser=await chromium.connectOverCDP(endpoint,{timeout:30000});if(this.closingAll||this.closingAccounts.has(account.id))throw new Error('专用浏览器正在退出，已取消启动');
 const context=browser.contexts()[0];const entry=Object.assign(launch,{child,browser,context,endpoint,headed:visible||background,visible,lastUsed:Date.now(),accountId:account.id,proxyUrl});this.remember(account.id,entry);await this.recordProfile(account.id,dir);await privateJson(path.join(dir,'hub-owner.json'),{pid:child.pid,accountId:account.id,visible,headed:visible||background,proxyUrl,startedAt:new Date().toISOString()});if(background){entry.workPage=await BackgroundPage.create(endpoint,target);return{accountId:account.id,visible:false,background:true,reused:false};}const page=context.pages().at(-1)||await context.newPage();if(visible)await page.bringToFront();retainVisibleWindow=visible;await page.goto(target,{waitUntil:'domcontentloaded',timeout:30000}).catch(e=>{if(!visible)throw e;throw new Error('专用浏览器已打开，但登录网站连接失败。请检查家宽出口；未自动切换到其他网络，也未清除登录资料。');});return{accountId:account.id,visible,reused:false};
 }catch(error){if(launch&&(!retainVisibleWindow||this.closingAll||this.closingAccounts.has(account.id))){try{await this.dispose(account.id,launch);}catch(cleanup){this.disconnected.set(launch.child.pid,launch);throw new AggregateError([error,cleanup],error.message+'；'+cleanup.message);}}throw error;}finally{this.pendingLaunches.delete(account.id);this.starting.delete(account.id);this.automatedStarting.delete(account.id);}}
 ensureBackground(account,options={}){return this.operation(()=>this.restoreBackground(account,options),account.id);}
 async restoreBackground(account,{url=account.entryUrl}={}){
  if(this.isManual(account.id))throw new Error('正在纯手动登录，后台恢复已暂停');
  if(this.restoring.has(account.id))return this.restoring.get(account.id);
  const job=(async()=>{await this.recover([account]);let entry=this.active.get(account.id);
   if(!entry)return this.open(account,{url,visible:false,background:true});
   if(entry.proxyUrl!==normalizeBrowserProxy(this.proxy()))throw new Error('账号仍使用原出口，未切换网络或清理资料。');
   if(!entry.headed)throw new Error('原账号浏览器运行模式不兼容，未切换登录环境。');
   // Keep the profile loaded when its final visible window is closed, but do
   // not navigate over an existing login, SSO window or unfinished draft.
   if(entry.context.pages().some(p=>!p.isClosed())){if(!entry.workPage||entry.workPage.isClosed())entry.workPage=await BackgroundPage.create(entry.endpoint,'about:blank');return{reused:true,background:false};}
   if(entry.workPage&&!entry.workPage.isClosed()){if(entry.workPage.url()==='about:blank')await entry.workPage.goto(assertHttpUrl(url,{allowLoopback:this.testMode}));return{reused:true,background:true};}
   entry.workPage=await BackgroundPage.create(entry.endpoint,assertHttpUrl(url,{allowLoopback:this.testMode}));return{reused:true,background:true};
  })().finally(()=>this.restoring.delete(account.id));this.restoring.set(account.id,job);return job;
 }
 list(){return [...this.active.values()].map(x=>({accountId:x.accountId,pid:x.child.pid,visible:x.headed&&x.context.pages().some(p=>!p.isClosed()),background:!!x.workPage&&!x.workPage.isClosed(),lastUsed:x.lastUsed,proxyUrl:x.proxyUrl||''})).concat(this.manual.list());}
 close(id,{waitForStartup=true}={}){
  // Manual login transitions already own this account operation and must not
  // wait for themselves. External closes block and drain pending opens.
  if(!waitForStartup)return this.closeKnown(id);
  if(this.accountClosures.has(id))return this.accountClosures.get(id);
  this.closingAccounts.add(id);
  const job=Promise.resolve().then(async()=>{
   const entries=[...new Set([this.active.get(id),this.pendingLaunches.get(id),...this.disconnected.values()].filter(entry=>entry?.accountId===id))];
   const operations=[...(this.operationsByAccount.get(id)||[])];
   await Promise.allSettled(entries.map(entry=>this.dispose(id,entry)));
   await Promise.allSettled(operations);
   const result=await this.closeKnown(id);
   return{...result,closed:result.closed||entries.length>0||operations.length>0};
  }).finally(()=>{this.closingAccounts.delete(id);this.accountClosures.delete(id);});
  this.accountClosures.set(id,job);return job;
 }
 async closeKnown(id){const entries=[...new Set([this.active.get(id),...this.disconnected.values()].filter(entry=>entry?.accountId===id))];if(!entries.length)return this.manual.close(id);const results=await Promise.allSettled(entries.map(entry=>this.dispose(id,entry)));const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'专用浏览器尚未全部退出，登录资料已保留');return{closed:true};}
 closeAll(){
  if(this.closingAll)return this.closingAll;
  // Block new opens before yielding. Include processes still in CDP startup
  // and disconnected clients; neither is necessarily present in active.
  this.closingAll=Promise.resolve().then(async()=>{
   const first=[...new Set([...this.active.values(),...this.pendingLaunches.values(),...this.disconnected.values()])];
   const firstResults=await Promise.allSettled(first.map(entry=>this.dispose(entry.accountId,entry)));
   await Promise.allSettled([...this.pendingOperations]);
   const remaining=[...new Set([...this.active.values(),...this.disconnected.values()])];
   const results=await Promise.allSettled([...remaining.map(entry=>this.dispose(entry.accountId,entry)),this.manual.closeAll()]);
   const errors=[...firstResults,...results].filter(r=>r.status==='rejected').map(r=>r.reason);
   if(errors.length)throw new AggregateError(errors,'专用浏览器未能全部保存退出，已保留现场');
  }).finally(()=>{this.closingAll=null;});
  return this.closingAll;
 }
 async run(account,config,prompt,onSent){if(!config?.consent||!config?.inputSelector||!config?.responseSelector)throw new Error('此平台还没有经过验证的浏览器适配，不能自动派发。');await this.open(account,{url:config.conversationUrl,visible:false});const b=this.active.get(account.id),page=b.context.pages()[0];
 if(new URL(page.url()).origin!==new URL(config.conversationUrl).origin)throw new Error('页面跳转到了登录或其他站点，需要本人确认');
 const input=page.locator(config.inputSelector);if(await input.count()!==1)throw new Error('输入框不唯一或页面结构变化，已停止，未发送');
 await input.fill(prompt,{timeout:10000});const before=await page.locator(config.responseSelector).allTextContents();await onSent();if(config.sendSelector)await page.locator(config.sendSelector).click({timeout:10000});else await input.press('Enter');
 let text='',stableAt=0;for(let i=0;i<Math.min(300,Math.max(1,Math.ceil((config.timeoutMs||300000)/1000)));i++){await pause(1000);const responses=await page.locator(config.responseSelector).allTextContents();const latest=responses.at(-1)||'';if(responses.length<=before.length)continue;if(latest!==text){text=latest;stableAt=Date.now();}if(text&&Date.now()-stableAt>5000&&config.doneSelector&&await page.locator(config.doneSelector).count()>0)return{body:text,conversationUrl:page.url()};}
 throw new Error('网页已发送但无法确认完整结束，进入待核对，不重复发送。');
 }
}

export async function checkBrowserNetwork(value) {
 const proxyUrl=normalizeBrowserProxy(value);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-hub-network-'));
 const manager=new BrowserManager({root:path.join(dir,'profiles'),proxy:()=>proxyUrl});
 try{
  await manager.open({id:'account_networkcheck',entryUrl:'https://www.cloudflare.com/cdn-cgi/trace'},{visible:false});
  const page=manager.active.get('account_networkcheck').context.pages()[0];
  const response=await page.goto('https://www.cloudflare.com/cdn-cgi/trace',{waitUntil:'domcontentloaded',timeout:25000});
  if(!response?.ok())throw new Error('出口检查未取得有效响应');
  const fields=Object.fromEntries((await page.locator('body').innerText()).split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)];}));
  if(!isIP(fields.ip||'')||!fields.loc)throw new Error('出口检查没有返回有效 IP 和地区');
  return{proxyUrl,ip:fields.ip,country:fields.loc,checkedAt:new Date().toISOString(),method:'dedicated-chrome',scope:'浏览器网页出口；不代表平台账号已通过风控'};
 }catch{throw new Error(proxyUrl?'专用浏览器代理检查失败，未切换直连；请检查本机代理服务是否运行及上游是否可用。':'系统网络检查失败，未修改网络设置或账号资料。');}
 finally{await manager.closeAll();await fs.rm(dir,{recursive:true,force:true});}
}
