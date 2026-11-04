import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DshHost} from './dsh-host.mjs';
import {privateJson} from './storage.mjs';
import {CodingMemberClient} from './coding-client.mjs';
import {requestJson} from './transport.mjs';
import {safeError} from './native-agent.mjs';
export class DshManager {
 constructor({config,dataDir,host,request=requestJson,maintenance=false,interval=4000}){Object.assign(this,{config,dataDir,request,interval});this.host=host||new DshHost(dataDir);this.file=path.join(dataDir,'dsh-members.json');this.records={};this.jobs=new Map();this.connecting=new Set();this.stopped=maintenance;this.writes=Promise.resolve();}
 async load(){await this.host.load();try{this.records=JSON.parse(await fs.readFile(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('DSH 成员记录无法读取，原会话保留');}for(const r of Object.values(this.records))if(r.status==='connecting'){r.status='needs_review';r.message='连接尚未完成，原会话保留；点击继续即可';}}
 save(){const copy=structuredClone(this.records);return this.writes=this.writes.catch(()=>{}).then(()=>privateJson(this.file,copy));}
 get busy(){return this.jobs.size>0||this.connecting.size>0||Object.values(this.records).some(r=>r.status==='working');}
 status(){return Object.values(this.records).map(({memberId,status,message,sessionId,title,cwd,mode,enabled,verified,lastReceiptAt})=>({memberId,engine:'deepseek-harness',status,message,sessionId,title,cwd,mode,enabled,verified,lastReceiptAt,sessionCount:sessionId?1:0}));}
 owner(route,body){return this.request(this.config.endpoint+route,{token:this.config.adminKey,...(body===undefined?{}:{method:'POST',body})});}
 client(r){return new CodingMemberClient(r.grantFile,{request:this.request});}
 async prepare(){if(!this.preparing){this.prepareError=null;this.preparing=this.host.start().catch(e=>{this.prepareError=safeError(e);}).finally(()=>{this.preparing=null;});}return{preparing:true};}
 async connect(input){if(this.jobs.has(input.memberId)||this.connecting.has(input.memberId))return this.status();this.connecting.add(input.memberId);try{return await this.connectOnce(input);}finally{this.connecting.delete(input.memberId);}}
 async connectOnce({memberId,sessionId,mode='existing'}){
  if(!/^member_[a-zA-Z0-9_-]+$/.test(memberId||'')||!['existing','new'].includes(mode))throw Error('DSH 成员参数不正确');
  if(this.jobs.has(memberId))return this.status();
  const workspace=await this.owner('/v2/workspace'),m=workspace.members.find(x=>x.id===memberId&&x.platformId==='deepseek-harness');if(!m)throw Error('成员不属于 DeepSeek Harness');
  const existing=this.records[memberId];if(existing?.sessionId&&sessionId&&existing.sessionId!==sessionId)throw Error('此成员已有工作会话，请先解除连接再绑定其他会话');
  if(Object.values(this.records).some(r=>r.memberId!==memberId&&r.enabled&&sessionId&&r.sessionId===sessionId))throw Error('此工作会话已由另一位成员接入，请选择其他会话');
  const r=existing||{memberId,grantFile:path.join(this.dataDir,'dsh-members',memberId,'grant.json'),mode};this.records[memberId]=r;r.enabled=true;r.status='connecting';r.message='正在连接原生会话';await this.save();
  const job=this.setup(r,{sessionId,mode}).catch(async e=>{r.status='needs_review';r.message=safeError(e);await this.save();}).finally(()=>this.jobs.delete(memberId));this.jobs.set(memberId,job);return this.status();
 }
 async setup(r,{sessionId,mode}){
  await this.host.start();let sessions=await this.host.sessions();
  if(!r.sessionId){
   if(mode==='new'){
    if(r.creationPending)throw Error('上次创建结果尚未确认，请在已有会话列表中选择；未重复创建');
    r.cwd=path.join(this.dataDir,'dsh-members',r.memberId,'workspace');await fs.mkdir(r.cwd,{recursive:true,mode:0o700});r.creationPending=true;await this.save();
    const created=await this.host.create(r.cwd);r.sessionId=created.sessionId;r.creationPending=false;await this.save();sessions=await this.host.sessions();
   }else r.sessionId=sessionId;
  }
  const s=sessions.items.find(x=>x.id===r.sessionId);if(!s)throw Error('请选择一个真实工作会话，未新建替代会话');r.cwd=s.workspace;r.title=s.title;
  try{await fs.access(r.grantFile);}catch(e){if(e.code!=='ENOENT')throw e;const skill=await this.owner('/v2/connect/skill',{memberId:r.memberId}),code=skill.pairingCode;if(!code)throw Error('未取得配对授权');const grant=await this.request(this.config.endpoint+'/v2/connect/redeem',{method:'POST',body:{code,attemptId:r.memberId+':'+randomUUID()}});await privateJson(r.grantFile,{...grant,expiresAt:Date.now()+grant.expires_in*1000});}
  const client=this.client(r);await client.api('/v2/self/connection',{method:'POST',body:{requestId:randomUUID(),transport:'pull',pollSeconds:15}});
  if(!r.enabled)return;
  await this.host.call('/bind',{sessionId:r.sessionId,workspace:r.cwd,grantFile:r.grantFile});
  const current=await client.api('/v2/self/status');if(!current.complete)await client.api('/v2/self/check',{method:'POST',body:{requestId:randomUUID()}});
  r.status='idle';r.message='正在验证，原生 Agent 回传后即可聊天';await this.save();
 }
 async tick(){
  if(this.stopped||this.ticking)return;this.ticking=true;try{await this.tickOnce();}finally{this.ticking=false;}
 }
 async tickOnce(){
  for(const r of Object.values(this.records).filter(r=>!r.enabled&&r.disconnectPending))try{await this.host.call('/unbind',{sessionId:r.sessionId});r.disconnectPending=false;}catch{}
  const active=Object.values(this.records).filter(r=>r.enabled&&r.sessionId&&!this.jobs.has(r.memberId));if(!active.length)return;
  let health;try{health=await this.host.call('/health');}catch{
   for(const r of active){r.status='offline';r.message='原生运行端已关闭；点击继续，沿用原工作会话';}await this.save();return;
  }
  if(health.ready===false){for(const r of active){r.status='connecting';r.message='正在恢复原生工作会话，原登录和历史保留';}await this.save();return;}
  for(const r of active)try{
   if(!health.bindings.some(b=>b.sessionId===r.sessionId&&b.memberId===r.memberId))await this.host.call('/bind',{sessionId:r.sessionId,workspace:r.cwd,grantFile:r.grantFile});
   const status=await this.client(r).api('/v2/self/status'),s=(await this.host.sessions()).items.find(s=>s.id===r.sessionId);
   if(!s){r.status='offline';r.message='原会话暂不可用，未新建替代会话';continue;}
   r.title=s.title;
   const fault=health.bindings.find(b=>b.sessionId===r.sessionId)?.lastError;if(fault){r.status='offline';r.message=fault;continue;}
   r.verified=!!status.complete;r.status=s.running?'working':'idle';r.message=r.verified?(s.running?'原 Agent 正在工作，消息会进入同一会话':'已接入，保留原项目和工作会话'):'等待原 Agent 完成真实回传';if(status.complete)r.lastReceiptAt=status.connection?.lastReceiptAt||r.lastReceiptAt||new Date().toISOString();
  }catch(e){r.status='offline';r.message=safeError(e);}
  await this.save();
 }
 async resume({memberId}){const r=this.records[memberId];if(!r)throw Error('DSH 成员不存在');return this.connect({memberId,sessionId:r.sessionId,mode:r.mode});}
 async disconnect(memberId){const r=this.records[memberId];if(!r)return;r.enabled=false;await this.jobs.get(memberId);try{await this.host.call('/unbind',{sessionId:r.sessionId});}catch(e){r.disconnectPending=true;}r.status='disconnected';r.message='Hub 连接已解除，原 Agent、项目和历史保留';r.verified=false;await this.save();}
 async start(){this.stopped=false;if(Object.values(this.records).some(r=>r.enabled))await this.host.start().catch(()=>{});await this.tick();if(!this.timer){this.timer=setInterval(()=>this.tick().catch(()=>{}),this.interval);this.timer.unref();}}
 async stop(){this.stopped=true;clearInterval(this.timer);this.timer=null;await Promise.allSettled([...this.jobs.values()]);await this.save();} // Never terminate an original native Agent to close Hub.
}
