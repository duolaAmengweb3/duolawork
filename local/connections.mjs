import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {privateJson} from './storage.mjs';
import {GrokTransport} from './grok.mjs';
import {MuseTransport} from './muse.mjs';
import {BUILTIN_PLATFORMS} from '../shared/platforms.mjs';

export class AgentConnections{
 constructor({cloud,browsers,logins,file}){Object.assign(this,{cloud,browsers,logins,file});this.transport=new MuseTransport(browsers);this.grok=new GrokTransport(browsers);this.records={};this.jobs=new Map();this.restoreAfter=new Map();this.writes=Promise.resolve();this.loaded=false;}
 async load(){this.loading??=(async()=>{try{const value=JSON.parse(await fs.readFile(this.file,'utf8'));if(value.schemaVersion!==1||!value.accounts||typeof value.accounts!=='object'||Array.isArray(value.accounts))throw new Error('invalid journal');this.records=value.accounts;}catch(e){if(e.code!=='ENOENT')throw new Error('任务连接记录无法读取，保留原账号并停止自动连接。');}})();return this.loading;}
 async save(accountId,patch){this.records[accountId]={...this.records[accountId],...patch,updatedAt:new Date().toISOString()};this.writes=this.writes.catch(()=>{}).then(()=>privateJson(this.file,{schemaVersion:1,accounts:this.records}));await this.writes;}
 snapshot(){return Object.fromEntries(Object.entries(this.records).map(([id,r])=>[id,{status:r.status,message:r.message||'',memberId:r.memberId||null,updatedAt:r.updatedAt}]));}
 async enable(account){await this.load();if(['muse','grok-bot'].includes(account.platformId)&&!this.records[account.id]?.enabled)await this.save(account.id,{enabled:true,status:'waiting_login',message:'登录后自动接入，无需填写连接参数。'});}
 transportFor(account){return account.platformId==='grok-bot'?this.grok:this.transport;}
 supports(account,member){return ['muse','grok-bot'].includes(account?.platformId)&&member?.evidence?.kind==='browser_roundtrip'&&member.evidence.transport===(account.platformId==='grok-bot'?'grok-bot-web':'muse-web')&&member.status==='ready';}
 async sync(state){
  await this.load();if(this.stopped||!state.settings.automation)return;
  for(const account of state.accounts.filter(a=>['muse','grok-bot'].includes(a.platformId)&&a.status!=='disabled')){
   if(this.browsers.isManual?.(account.id)){
    // A running human SSO session is never inspected. After the owned browser
    // actually exits, return its saved profile without asking for another login.
    if(this.browsers.manual.status()[account.id]?.running!==false)continue;
    if(state.tasks.some(t=>t.steps.some(s=>s.accountId===account.id&&s.status==='running')))continue;
    try{await this.browsers.manual.close(account.id,{finish:true});await this.browsers.ensureBackground(account,{url:account.entryUrl||BUILTIN_PLATFORMS.find(p=>p.id===account.platformId)?.entryUrl});}
    catch(e){await this.save(account.id,{status:'restoring',message:'登录资料已保留，恢复时遇到问题：'+e.message});continue;}
   }
   if(this.jobs.has(account.id))continue;
   const member=state.members.find(m=>m.accountId===account.id&&m.status!=='disabled');
   if(member?.paused)continue;
   // Only a previously confirmed session may be restored silently. The
   // observer remains read-only; it does not perform login or reset cookies.
   await this.logins.load?.();
   const remembered=this.logins.records?.[account.id];
   if(remembered?.status==='authenticated'&&this.browsers.ensureBackground&&Date.now()>(this.restoreAfter.get(account.id)||0)){
    try{await this.browsers.ensureBackground(account,{url:this.records[account.id]?.conversationUrl||account.entryUrl||BUILTIN_PLATFORMS.find(p=>p.id===account.platformId)?.entryUrl});}
    catch(e){this.restoreAfter.set(account.id,Date.now()+60000);await this.save(account.id,{status:'restoring',message:'后台恢复暂未完成：'+e.message});continue;}
   }
   if(this.stopped)return;
   if(member?.status==='ready'){if(member.evidence?.kind==='browser_roundtrip'&&this.records[account.id]?.status!=='ready')await this.save(account.id,{status:'ready',memberId:member.id,message:'任务连接已验证，原 Agent 继续负责规划与执行。'});continue;}
   const login=await this.logins.check(account,this.browsers);
   if(login.status!=='authenticated')continue;
   await this.enable(account);
   const record=this.records[account.id];
   // A sent-but-uncertain operation is resumed read-only, never retransmitted.
   if(record?.status==='needs_review'&&!record.sentAt)continue;
   const promise=this.connect(account,member).catch(async e=>{await this.save(account.id,{status:e.code==='WAITING_IDLE'?'waiting_idle':e.code==='PLATFORM_APPROVAL'?'platform_approval':e.code==='BOT_SELECTION_REQUIRED'?'choose_bot':'needs_review',message:e.message});}).finally(()=>this.jobs.delete(account.id));
   this.jobs.set(account.id,promise);
  }
 }
 async connect(account,existing){
  await this.load();if(this.stopped)return;const transport=this.transportFor(account),label=account.platformId==='grok-bot'?'Grok Bot':'Muse';let member=existing;
  await transport.prepare?.(account);
  if(!member)member=(await this.cloud.action({type:'member.create',payload:{accountId:account.id,name:account.label,mode:'browser'}})).result;
  const challenge=(await this.cloud.action({type:'member.challenge',memberId:member.id})).result;
  if(challenge.verified)return;
  let record=this.records[account.id]||{};
  if(record.nonce&&record.nonce!==challenge.nonce&&record.sentAt)throw new Error('旧连接验证仍有不明回执，先核对，未重发。');
  await this.save(account.id,{status:'connecting',memberId:member.id,nonce:challenge.nonce,...(account.platformId==='grok-bot'?{conversationUrl:transport.page(account).url()}:{}),message:`正在让原 ${label} 完成一次真实任务往返。`});
  record=this.records[account.id];
  if(!record.sentAt){
   // Check for drafts and platform approvals before recording a possible send.
   const idle=await transport.inspect(account,challenge.nonce);
   if((idle.draft&&!idle.ownedDraft)||idle.busy){const e=new Error(`${label} 正在工作或有草稿，待空闲后自动接入。`);e.code='WAITING_IDLE';throw e;}
   if(idle.approval){const e=new Error(`${label} 有待本人处理的批准。`);e.code='PLATFORM_APPROVAL';throw e;}
   if(this.stopped)return;
   await transport.send(account,challenge.nonce,'接入往返验证：请计算 19 + 23，成果正文只放计算结果 42。无需上网，不修改任何文件或任务。',()=>this.save(account.id,{status:'awaiting_result',sentAt:new Date().toISOString(),message:`验证任务已记录并派往 ${label}，等待真实回复。`}));
  }
  const result=await transport.wait(account,challenge.nonce,{onState:status=>this.save(account.id,{status,message:status==='platform_approval'?`等待你在 ${label} 原窗口处理平台批准。`:`${label} 正在执行接入验证，等待完整成果。`})});
  if(result.body.trim()!=='42')throw new Error(`${label} 验证成果不符合要求，未标记接通。`);
  await this.cloud.action({type:'member.browser.verify',memberId:member.id,payload:{nonce:challenge.nonce,reply:result.reply,transport:account.platformId==='grok-bot'?'grok-bot-web':'muse-web',replyHash:createHash('sha256').update(result.reply).digest('hex')}});
  await this.cloud.action({type:'account.update',accountId:account.id,payload:{status:'connected'}});
  await this.save(account.id,{status:'ready',message:`原 ${label} 已接收验证任务并返回匹配结果，可以开始派任务。`});
 }
 async run(account,attempt,input,onState){
  if(this.stopped)throw new Error('工作台正在退出，未派发新任务。');
  const marker=attempt.id,transport=this.transportFor(account);
  await transport.prepare?.(account);
  await transport.send(account,marker,input,async()=>{});
  return transport.wait(account,marker,{timeoutMs:600000,onState});
 }
 async resume(account,attempt,onState){
  // A restarted observer only reads the original attempt's result. No send,
  // login reset, new task, or new claim is allowed here.
  return this.transportFor(account).wait(account,attempt.id,{timeoutMs:Math.max(4000,600000-(Date.now()-Date.parse(attempt.dispatchedAt||attempt.claimedAt))),onState});
 }
}
