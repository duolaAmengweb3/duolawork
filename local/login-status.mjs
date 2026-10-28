import fs from 'node:fs/promises';
import {privateJson} from './storage.mjs';
import {accountPages} from './background-page.mjs';

// This function only inspects visible controls. Never read cookies, storage,
// message bodies, credentials or account identifiers to detect a login.
export function collectLoginSignals(){
 const visible=el=>!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden';
 const controls=[...document.querySelectorAll('button,a,[role="button"]')].filter(visible);
 const names=controls.map(el=>(el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent||'').trim());
 const named=re=>names.some(s=>s.length<100&&re.test(s));
 const composer=[...document.querySelectorAll('textarea,[role="textbox"][contenteditable="true"],[contenteditable="true"][aria-label]')].some(el=>visible(el)&&!el.disabled&&!el.readOnly);
 return {
  ready:document.readyState==='complete'||document.readyState==='interactive',
  composer,
  settings:named(/^(设置|Settings)$/i),
  library:named(/^(资源库|Library)$/i),
  goals:named(/^(目标|Goals)$/i),
  accountMenu:named(/^(账户菜单|账号菜单|Account menu|User menu|Profile menu)([，,:\s]|$)/i),
  bots:named(/^(机器人|Bots|新建 Bot|New Bot|Create Bot)$/i),
  signIn:named(/^(登录|登入|Log in|Sign in|Continue with (Google|Facebook|Meta)|使用(Google|Facebook|Meta)登录)$/i),
  password:[...document.querySelectorAll('input[type="password"]')].some(visible),
  challenge:[...document.querySelectorAll('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"]')].some(visible),
 };
}

export function classifyLogin(platformId,url,signals={}){
 let parsed;try{parsed=new URL(url);}catch{return 'unknown';}
 if(!['muse','grok-bot'].includes(platformId))return 'unsupported';
 if(!loginHosts(platformId).includes(parsed.hostname)){
  return ['accounts.x.ai','auth.muse.ai','accounts.google.com','accountscenter.meta.com','www.facebook.com','www.meta.com'].includes(parsed.hostname)?'signing_in':'unknown';
 }
 if(signals.challenge)return 'verification_required';
 if(!signals.ready)return 'unknown';
 if(platformId==='grok-bot'){
  if(signals.password||signals.signIn)return 'login_required';
  return signals.accountMenu&&(signals.composer||signals.bots)?'authenticated':'unknown';
 }
 // A composer alone is insufficient: several services allow guest chats.
 if(signals.composer&&signals.settings&&signals.library&&signals.goals&&!signals.password)return 'authenticated';
 if(signals.password||signals.signIn)return 'login_required';
 return 'unknown';
}
export const loginHosts=id=>id==='muse'?['muse.ai','www.muse.ai']:id==='grok-bot'?['grok.com','www.grok.com']:[];

export class LoginMonitor{
 constructor({file,interval=15000}){this.file=file;this.interval=interval;this.records={};this.cache=new Map();this.pending=new Map();this.writes=Promise.resolve();this.loaded=false;}
 async load(){this.loading??=(async()=>{try{const value=JSON.parse(await fs.readFile(this.file,'utf8'));if(value.schemaVersion===1)this.records=value.accounts||{};}catch{/* An unreadable observation cache must never reset browser data. */}})();return this.loading;}
 async check(account,manager,{force=false}={}){
  await this.load();
  if(manager.isManual?.(account.id))return{status:'manual_login',lastConfirmedAt:this.records[account.id]?.lastConfirmedAt||null,checkedAt:null,active:true,method:'human-only-chrome'};
  const cached=this.cache.get(account.id),entry=manager.active.get(account.id);
  if(!entry){const previous=this.records[account.id];return{status:previous?.status==='authenticated'?'saved':'unknown',lastConfirmedAt:previous?.lastConfirmedAt||null,checkedAt:previous?.checkedAt||null,active:false,method:'dedicated-browser-dom'};}
  if(!force&&cached&&Date.now()-cached.time<this.interval&&cached.pid===entry.child.pid)return cached.value;
  if(this.pending.has(account.id))return this.pending.get(account.id);
  const job=this.observe(account,entry).finally(()=>this.pending.delete(account.id));this.pending.set(account.id,job);return job;
 }
 async observe(account,entry){
  let status='unknown';
  try{
   const pages=accountPages(entry);
   // Never navigate or open a page. Read only this account's owned context.
   const hosts=loginHosts(account.platformId);
   const page=pages.find(p=>{try{return hosts.includes(new URL(p.url()).hostname);}catch{return false;}})||pages.at(-1);
   if(page){let host;try{host=new URL(page.url()).hostname;}catch{}
    let timer;
    const signals=hosts.includes(host)?await Promise.race([
     page.evaluate(collectLoginSignals),
     new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('登录观察超时')),5000);}),
    ]).finally(()=>clearTimeout(timer)):{};
    status=classifyLogin(account.platformId,page.url(),signals);
   }
  }catch{/* Lost context or network errors are unknown, never an instruction to relogin. */}
  const checkedAt=new Date().toISOString(),previous=this.records[account.id];
  const lastConfirmedAt=status==='authenticated'?checkedAt:previous?.lastConfirmedAt||null;
  const value={status,lastConfirmedAt,checkedAt,active:true,method:'dedicated-browser-dom'};
  this.cache.set(account.id,{time:Date.now(),pid:entry.child.pid,value});
  // Persist only meaningful observations, not a write on every UI poll.
  if(['authenticated','login_required','verification_required'].includes(status)){
   this.records[account.id]={status,lastConfirmedAt,checkedAt};
   if(previous?.status!==status){
    this.writes=this.writes.catch(()=>{}).then(()=>privateJson(this.file,{schemaVersion:1,accounts:this.records}));
    await this.writes;
   }
  }
  return value;
 }
 async snapshot(accounts,manager){return Object.fromEntries(await Promise.all(accounts.filter(a=>a.status!=='disabled').map(async a=>[a.id,await this.check(a,manager)])));}
}
