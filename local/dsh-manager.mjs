import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DshHost} from './dsh-host.mjs';
import {DshDesktopHost} from './dsh-desktop.mjs';
import {privateJson} from './storage.mjs';
import {CodingMemberClient} from './coding-client.mjs';
import {requestJson} from './transport.mjs';
import {safeError} from './native-agent.mjs';
import {nativeBindings,publicAssignments} from './session-routing.mjs';
export class DshManager {
 constructor({config,dataDir,host,request=requestJson,maintenance=false,interval=4000,platformId="deepseek-harness",engine=platformId,fileName="dsh-members.json",requireFreshReceipt=false}){Object.assign(this,{config,dataDir,request,interval,platformId,engine,requireFreshReceipt});this.injectedHost=!!host;this.host=host||new DshDesktopHost(dataDir);this.legacyHost=host||new DshHost(dataDir);this.file=path.join(dataDir,fileName);this.records={};this.jobs=new Map();this.connecting=new Set();this.stopped=maintenance;this.writes=Promise.resolve();}
 async load(){await this.host.load();if(this.legacyHost!==this.host)await this.legacyHost.load();try{this.records=JSON.parse(await fs.readFile(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('原生成员记录无法读取，原会话保留');}for(const r of Object.values(this.records))if(r.status==='connecting'){r.status='needs_review';r.message='连接尚未完成，原会话保留；点击继续即可';}}
 recordHost(r){return this.injectedHost||r?.hostKind==='desktop'?this.host:this.legacyHost;}
 hostFor(memberId){return this.records[memberId]?this.recordHost(this.records[memberId]):this.host;}
 save(){const copy=structuredClone(this.records);return this.writes=this.writes.catch(()=>{}).then(()=>privateJson(this.file,copy));}
 get busy(){return this.jobs.size>0||this.connecting.size>0||Object.values(this.records).some(r=>r.status==='working');}
 status(){return Object.values(this.records).map(({memberId,status,message,sessionId,title,cwd,mode,enabled,verified,lastReceiptAt,hostKind,chatBindings,sourceReady})=>({memberId,engine:this.engine,hostKind:hostKind||'managed',status,message,sessionId,title,cwd,mode,enabled,verified,lastReceiptAt,manualAssignments:!!chatBindings,sourceReady:sourceReady||enabled&&['idle','working'].includes(status),assignments:publicAssignments({chatBindings}),sessionCount:chatBindings?new Set(Object.values(chatBindings).map(b=>b.sessionId)).size:sessionId?1:0}));}
 owner(route,body){return this.request(this.config.endpoint+route,{token:this.config.adminKey,...(body===undefined?{}:{method:'POST',body})});}
 client(r){return new CodingMemberClient(r.grantFile,{request:this.request});}
 async prepare({memberId}={}){if(!this.preparing){this.prepareError=null;this.preparing=this.hostFor(memberId).start({launch:true}).catch(e=>{this.prepareError=safeError(e);}).finally(()=>{this.preparing=null;});}return{preparing:true};}
 async connect(input){if(this.jobs.has(input.memberId)||this.connecting.has(input.memberId))return this.status();this.connecting.add(input.memberId);try{return await this.connectOnce(input);}finally{this.connecting.delete(input.memberId);}}
 async connectOnce({memberId,sessionId,mode='existing'}){
  if(!/^member_[a-zA-Z0-9_-]+$/.test(memberId||'')||!['existing','new'].includes(mode))throw Error('原生成员参数不正确');
  if(this.jobs.has(memberId))return this.status();
  const workspace=await this.owner('/v2/workspace'),m=workspace.members.find(x=>x.id===memberId&&x.platformId===this.platformId);if(!m)throw Error('成员与所选原生平台不匹配');
  const existing=this.records[memberId];if(existing?.sessionId&&sessionId&&existing.sessionId!==sessionId)throw Error('此成员已有工作会话，请先解除连接再绑定其他会话');
  if(Object.values(this.records).some(r=>r.memberId!==memberId&&r.enabled&&sessionId&&r.sessionId===sessionId))throw Error('此工作会话已由另一位成员接入，请选择其他会话');
  const r=existing||{memberId,grantFile:path.join(this.dataDir,'dsh-members',memberId,'grant.json'),mode,hostKind:this.host.kind||'managed'};this.records[memberId]=r;r.enabled=true;r.status='connecting';r.message='正在连接原生会话';await this.save();
  const job=this.setup(r,{sessionId,mode}).catch(async e=>{r.status='needs_review';r.message=safeError(e);await this.save();}).finally(()=>this.jobs.delete(memberId));this.jobs.set(memberId,job);return this.status();
 }
 async migrateExisting(){const old=Object.values(this.records).filter(r=>r.sessionId&&!r.chatBindings);if(!old.length)return;const {items}=await this.owner('/v2/channels');if(!Array.isArray(items))return;for(const r of old)await this.migrateAssignments(r,items);}
 async connectSource({memberId}){
  if(this.jobs.has(memberId))return this.status();
  const w=await this.owner('/v2/workspace'),m=w.members.find(m=>m.id===memberId&&m.platformId===this.platformId);if(!m)throw Error('成员与运行端不匹配');
  const r=this.records[memberId]||{memberId,grantFile:path.join(this.dataDir,'dsh-members',memberId,'grant.json'),hostKind:this.host.kind||'managed',chatBindings:{}};
  this.records[memberId]=r;r.enabled=true;r.status='connecting';r.message='正在连接原生运行端';await this.save();
  const job=(async()=>{await this.recordHost(r).start({launch:true});await this.ensureGrant(r);r.sourceReady=true;r.status='idle';r.message='运行端已连接，请在聊天中选择工作会话';await this.save();})().catch(async e=>{r.sourceReady=false;r.status='needs_review';r.message=safeError(e);await this.save();}).finally(()=>this.jobs.delete(memberId));this.jobs.set(memberId,job);return this.status();
 }
 async ensureGrant(r){
  try{await fs.access(r.grantFile);}catch(e){if(e.code!=='ENOENT')throw e;const skill=await this.owner('/v2/connect/skill',{memberId:r.memberId});if(!skill.pairingCode)throw Error('未取得配对授权');const grant=await this.request(this.config.endpoint+'/v2/connect/redeem',{method:'POST',body:{code:skill.pairingCode,attemptId:r.memberId+':'+randomUUID()}});await privateJson(r.grantFile,{...grant,expiresAt:Date.now()+grant.expires_in*1000});}
  await this.client(r).api('/v2/self/connection',{method:'POST',body:{requestId:randomUUID(),transport:'pull',pollSeconds:15}});
 }
 async migrateAssignments(r,channels){
  if(r.chatBindings)return;
  // Preserve only conversations which existed at migration. A future chat must
  // never silently inherit the old member-wide native context.
  r.chatBindings=Object.fromEntries(channels.filter(c=>c.memberIds.includes(r.memberId)).map(c=>[c.id,{sessionId:r.sessionId,workspace:r.cwd,title:r.title,mode:'existing',migrated:true}]));
  r.verificationSessionId=r.sessionId;await this.save();
 }
 async assign({memberId,channelId,sessionId,mode='existing',workspace,title,channels}){
  const r=this.records[memberId];if(!r?.enabled||this.jobs.has(memberId))throw Error('请先连接原生运行端，等待准备完成');
  if(!['existing','new'].includes(mode))throw Error('请选择已有会话或新建会话');
  const host=this.recordHost(r);await host.start({launch:false});await this.migrateAssignments(r,channels);
  const old=r.chatBindings[channelId],listed=await host.sessions();
  if(old&&listed.items.find(s=>s.id===old.sessionId)?.running)throw Error('当前工作还未结束，请完成后再更换会话');
  if(old){const health=await host.call('/health'),pending=new Set(health.bindings?.find(b=>b.sessionId===old.sessionId)?.dispatchedStepIds||[]),{work}=await this.client(r).tool('list_work');if(work.some(w=>pending.has(w.stepId)))throw Error('原会话还有已发送的工作，请结束后再更换');}
  if(mode==='new'){
   if(r.creationPending)throw Error('上次创建结果待确认，请刷新已有会话列表，未重复创建');
   const cwd=workspace?await fs.realpath(workspace):path.join(this.dataDir,'dsh-members',memberId,'chats',channelId);await fs.mkdir(cwd,{recursive:true,mode:0o700});
   r.creationPending=true;await this.save();const created=await host.create(cwd);sessionId=created.sessionId;r.creationPending=false;await this.save();
  }
  const selected=(await host.sessions()).items.find(s=>s.id===sessionId);if(!selected?.workspace)throw Error('请选择存在且关联本地项目的会话');
  for(const other of Object.values(this.records))if(other.memberId!==memberId&&other.enabled&&nativeBindings(other).some(b=>b.sessionId===sessionId))throw Error('这个原生会话已有另一位工作成员，请选择其他会话');
  r.chatBindings[channelId]={sessionId,workspace:selected.workspace,title:mode==='new'?(title||selected.title):selected.title,mode};if(!Object.values(r.chatBindings).some(b=>b.sessionId===r.verificationSessionId))r.verificationSessionId=sessionId;
  r.sourceReady=true;r.status='idle';await this.save();await this.syncBindings(r);
  const current=await this.client(r).api('/v2/self/status');if(!r.proofRunId){r.verified=false;const proof=await this.client(r).api('/v2/self/check',{method:'POST',body:{requestId:randomUUID()}});r.proofRunId=proof.runId||proof.result?.runId;}
  await this.save();return r.chatBindings[channelId];
 }
 async syncBindings(r){
  const host=this.recordHost(r),wanted=nativeBindings(r),health=await host.call('/health');
  for(const b of wanted){const prior=health.bindings?.find(p=>p.sessionId===b.sessionId&&p.memberId===r.memberId);if(!prior||JSON.stringify(prior.channelIds)!==JSON.stringify(b.channelIds)||prior.verification!==b.verification)await host.call('/bind',{...b,grantFile:r.grantFile});}
  for(const b of health.bindings||[])if(b.memberId===r.memberId&&!wanted.some(n=>n.sessionId===b.sessionId))await host.call('/unbind',{sessionId:b.sessionId});
 }
 async setup(r,{sessionId,mode}){
  const host=this.recordHost(r);await host.start({launch:true});let sessions=await host.sessions();
  if(!r.sessionId){
   if(mode==='new'){
    if(r.creationPending)throw Error('上次创建结果尚未确认，请在已有会话列表中选择；未重复创建');
    r.cwd=path.join(this.dataDir,'dsh-members',r.memberId,'workspace');await fs.mkdir(r.cwd,{recursive:true,mode:0o700});r.creationPending=true;await this.save();
    const created=await host.create(r.cwd);r.sessionId=created.sessionId;r.creationPending=false;await this.save();sessions=await host.sessions();
   }else r.sessionId=sessionId;
  }
  const s=sessions.items.find(x=>x.id===r.sessionId);if(!s)throw Error('请选择一个真实工作会话，未新建替代会话');r.cwd=s.workspace;r.title=s.title;
  try{await fs.access(r.grantFile);}catch(e){if(e.code!=='ENOENT')throw e;const skill=await this.owner('/v2/connect/skill',{memberId:r.memberId}),code=skill.pairingCode;if(!code)throw Error('未取得配对授权');const grant=await this.request(this.config.endpoint+'/v2/connect/redeem',{method:'POST',body:{code,attemptId:r.memberId+':'+randomUUID()}});await privateJson(r.grantFile,{...grant,expiresAt:Date.now()+grant.expires_in*1000});}
  const client=this.client(r);await client.api('/v2/self/connection',{method:'POST',body:{requestId:randomUUID(),transport:'pull',pollSeconds:15}});
  if(!r.enabled)return;
  await host.call('/bind',{sessionId:r.sessionId,workspace:r.cwd,grantFile:r.grantFile});
  if(this.requireFreshReceipt){
   if(!r.proofRunId){r.verified=false;r.proofRequestId??=createHash('sha256').update(r.memberId+':original-session:'+r.sessionId).digest('hex');await this.save();const proof=await client.api('/v2/self/check',{method:'POST',body:{requestId:r.proofRequestId}});r.proofRunId=proof.runId||proof.result?.runId;if(!r.proofRunId)throw Error('尚未取得原会话验证编号，原连接资料保留');await this.save();}
  }else{const current=await client.api('/v2/self/status');if(!current.complete)await client.api('/v2/self/check',{method:'POST',body:{requestId:randomUUID()}});}
  r.status='idle';r.message='正在验证，原生 Agent 回传后即可聊天';await this.save();
 }
 async tick(){
  if(this.stopped||this.ticking)return;this.ticking=true;const job=this.tickOnce();this.tickPromise=job;try{await job;}finally{this.ticking=false;if(this.tickPromise===job)this.tickPromise=null;}
 }
 async tickOnce(){
  await this.migrateExisting();
  for(const r of Object.values(this.records).filter(r=>!r.enabled&&r.disconnectPending))try{for(const b of nativeBindings(r))await this.recordHost(r).call('/unbind',{sessionId:b.sessionId});r.disconnectPending=false;}catch{}
  const active=Object.values(this.records).filter(r=>r.enabled&&!this.jobs.has(r.memberId));if(!active.length)return;
  for(const host of new Set(active.map(r=>this.recordHost(r))))await this.tickHost(host,active.filter(r=>this.recordHost(r)===host));
  await this.save();
 }
 async tickHost(host,active){
  let health;try{health=await host.call('/health');}catch{for(const r of active){r.status='offline';r.message='原生运行端已关闭；打开原桌面版后继续原会话';}return;}
  if(health.ready===false){for(const r of active){r.status='connecting';r.message='正在恢复原生工作会话，原登录和历史保留';}return;}
  for(const r of active)try{
   if(r.chatBindings){await this.syncBindings(r);const entries=nativeBindings(r);r.sourceReady=true;if(!entries.length){r.status='idle';r.message='运行端已连接，请在聊天中选择工作会话';continue;}const items=(await host.sessions()).items,missing=entries.some(b=>!items.some(s=>s.id===b.sessionId));if(missing){r.status='offline';r.message='某个工作会话暂不可用，原绑定保留';continue;}const status=await this.client(r).api('/v2/self/status');r.verified=!!status.complete&&(!this.requireFreshReceipt||!!r.proofRunId&&status.connection?.deliveryEvidence?.runId===r.proofRunId);r.status=entries.some(b=>items.find(s=>s.id===b.sessionId)?.running)?'working':'idle';r.message='运行端已连接，各聊天使用各自的工作会话';continue;}
   if(!health.bindings.some(b=>b.sessionId===r.sessionId&&b.memberId===r.memberId))await host.call('/bind',{sessionId:r.sessionId,workspace:r.cwd,grantFile:r.grantFile});
   const status=await this.client(r).api('/v2/self/status'),s=(await host.sessions()).items.find(s=>s.id===r.sessionId);
   if(!s){r.status='offline';r.message='原会话暂不可用，未新建替代会话';continue;}
   r.title=s.title;
   const fault=health.bindings.find(b=>b.sessionId===r.sessionId)?.lastError;if(fault){r.status='offline';r.message=fault;continue;}
   r.verified=!!status.complete&&(!this.requireFreshReceipt||!!r.proofRunId&&status.connection?.deliveryEvidence?.runId===r.proofRunId);r.status=s.running?'working':'idle';r.message=r.verified?(s.running?'原 Agent 正在工作，消息会进入同一会话':'已接入，保留原项目和工作会话'):'等待原 Agent 完成真实回传';if(r.verified)r.lastReceiptAt=status.connection?.lastReceiptAt||r.lastReceiptAt||new Date().toISOString();
  }catch(e){r.status='offline';r.message=safeError(e);}
 }
 async resume({memberId}){const r=this.records[memberId];if(!r)throw Error('原生成员不存在');return r.chatBindings?this.connectSource({memberId}):this.connect({memberId,sessionId:r.sessionId,mode:r.mode});}
 async disconnect(memberId){const r=this.records[memberId];if(!r)return;r.enabled=false;await this.jobs.get(memberId);try{for(const b of nativeBindings(r))await this.recordHost(r).call('/unbind',{sessionId:b.sessionId});}catch(e){r.disconnectPending=true;}r.status='disconnected';r.message='Hub 连接已解除，原 Agent、项目和历史保留';r.verified=false;await this.save();}
 async start(){this.stopped=false;for(const host of new Set(Object.values(this.records).filter(r=>r.enabled).map(r=>this.recordHost(r))))await host.start({launch:false}).catch(()=>{});await this.tick();if(!this.timer){this.timer=setInterval(()=>this.tick().catch(()=>{}),this.interval);this.timer.unref();}}
 async stop(){this.stopped=true;clearInterval(this.timer);this.timer=null;await this.tickPromise?.catch(()=>{});await Promise.allSettled([...this.jobs.values()]);await this.save();} // Never terminate an original native Agent to close Hub.
}
