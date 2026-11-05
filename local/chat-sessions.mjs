import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {queueSessionLink} from './session-link-runner.mjs';
import {SESSION_CAPABILITIES,publicAssignments} from './session-routing.mjs';
import {presentSessions,sessionProjects,sessionErrorMessage} from './session-presentation.mjs';

export class ChatSessions {
  constructor({coding,dsh,ag}) { Object.assign(this,{coding,dsh,ag});this.jobs=new Map();this.locks=new Map();this.linkJobs=new Map(); }
  owner(...args) { return this.coding.owner(...args); }
  async member(id) {
    const w=await this.owner('/v2/workspace'),m=w.members.find(m=>m.id===id);
    if(!m)throw Error('成员已移出工作区');return m;
  }
  manager(m) { return m.platformId==='codex'||m.platformId==='gemini-cli'?this.coding:m.platformId==='antigravity'?(this.ag.records[m.id]?.enabled||!this.coding.records[m.id]?.enabled?this.ag:this.coding):m.platformId==='deepseek-harness'?this.dsh:null; }
  async status(memberId) {
    const m=await this.member(memberId),manager=this.manager(m),r=manager?.records[memberId];
    if(m.platformId==='claude-code'){const r=await this.owner('/v2/native-sessions?memberId='+memberId);return{...r,assignments:r.record.assignments,capabilities:{...SESSION_CAPABILITIES['claude-code'],linkCurrent:true}};}
    if(manager){const remote=await this.owner('/v2/native-runtime?memberId='+memberId);if(remote.remote)return{...remote,capabilities:{...remote.capabilities,linkCurrent:remote.record.form!=='gemini-cli'},assignments:remote.record.assignments};}
    const capabilities={...(SESSION_CAPABILITIES[m.platformId]||{kind:'fixed'})};if(manager===this.coding)Object.assign(capabilities,{kind:'sessions',existing:true,create:true,label:m.platformId==='codex'?'Codex 工作会话':'Gemini 后台会话'});
    capabilities.linkCurrent=!!r?.enabled&&(manager===this.coding?['codex','antigravity-cli'].includes(r.engine):manager===this.ag||manager===this.dsh&&manager.hostFor(memberId).kind==='desktop');
    return {capabilities,record:manager===this.coding?manager.status().members.find(r=>r.memberId===memberId):manager?.status().find(r=>r.memberId===memberId),assignments:publicAssignments(r||{})};
  }
  async connect({memberId,form}) {
    if(form==='deepseek-harness')throw Error('原服务器上的 Harness 请使用“复制说明接入”，把说明发给原 Agent');
    const m=await this.member(memberId),manager=['gemini-cli','antigravity-cli'].includes(form)&&['gemini-cli','antigravity'].includes(m.platformId)?this.coding:this.manager(m);if(!manager)throw Error('这个平台使用固定 Agent 接入');
    // A second account must not silently attach to the same default login.
    // Existing members and same-account legacy assignments remain intact.
    if(!manager.records[memberId]?.enabled){
      const w=await this.owner('/v2/workspace');
      const existing=w.members.find(peer=>peer.id!==memberId&&peer.platformId===m.platformId&&peer.accountId!==m.accountId&&peer.status!=='disabled'&&manager.records[peer.id]?.enabled);
      if(existing)throw Error(`这台电脑的 ${m.platformId==='codex'?'Codex':'Agent'} 已连接为「${existing.name}」。不同项目请在它的聊天里选择工作会话；另一个账号需要连接它自己的环境，不能直接复用这个登录。`);
    }
    if(manager===this.coding)await manager.connect({memberId,engine:m.platformId==='codex'?'codex':['gemini-cli','antigravity-cli'].includes(form)?form:this.coding.records[memberId]?.engine||'antigravity',sourceOnly:true});
    else {
      if(manager===this.ag&&this.coding.records[memberId]?.enabled)await this.coding.pause({memberId});
      await manager.connectSource({memberId});
    }
    return this.status(memberId);
  }
  async createLink({memberId,channelId}){
    await this.channel(memberId,channelId);const m=await this.member(memberId),status=await this.status(memberId);
    if(m.platformId==='claude-code')return this.owner('/v2/session-links',{action:'create',memberId,channelId,form:'claude-code',executor:'claude'});
    if(status.remote)return this.owner('/v2/session-links',{action:'create',memberId,channelId});
    const manager=this.manager(m),r=manager?.records[memberId];if(!r?.enabled)throw Error('请先连接这个账号');
    const form=manager===this.coding?r.engine:manager===this.ag?'antigravity-desktop':manager.hostFor(memberId).kind==='desktop'?'deepseek-desktop':null;
    if(!form)throw Error('请从已有项目列表选择，这个运行形态尚未适配当前对话关联');
    return this.owner('/v2/session-links',{action:'create',memberId,channelId,executor:'local',form,locator:{dataDir:manager.dataDir,file:path.basename(manager.file)},previousBinding:r.chatBindings?.[channelId]||null});
  }
  start(){this.linkStopped=false;this.linkTimer=setInterval(()=>void this.tickLinks().catch(()=>{}),4000);this.linkTimer.unref();}
  async stop(){this.linkStopped=true;clearInterval(this.linkTimer);while(this.linkTicking)await new Promise(r=>setTimeout(r,20));await Promise.allSettled([...this.linkJobs.values()]);}
  async tickLinks(){
    if(this.linkStopped||this.linkTicking)return;this.linkTicking=true;
    try{const {items}=await this.owner('/v2/session-links');
      for(const l of items.filter(l=>l.executor==='local'&&l.locator?.dataDir===this.coding.dataDir)){
        if(this.linkStopped)break;
        if(this.linkJobs.has(l.id)||!['confirming','verified','applying'].includes(l.status))continue;
        const manager=this.manager(await this.member(l.memberId));
        if(l.status!=='confirming'&&(manager.records[l.memberId]?.inFlight||manager.jobs?.has(l.memberId)))continue;
        const job=(async()=>{
          if(l.status==='confirming'){await queueSessionLink(manager,l,manager.dataDir);return;}
          const current=manager.records[l.memberId]?.chatBindings?.[l.channelId]||null;
          if(current?.sessionId!==l.session.id&&JSON.stringify(current)!==JSON.stringify(l.previousBinding))throw Error('聊天刚刚选择了其他对话，旧配对说明没有覆盖它');
          await this.owner('/v2/session-links',{action:'begin',id:l.id,requestId:'link-begin-'+l.id});
          if(current?.sessionId!==l.session.id)await this.assign({memberId:l.memberId,channelId:l.channelId,mode:'existing',sessionId:l.session.id,expectedPreviousBinding:l.previousBinding});
          await this.owner('/v2/session-links',{action:'completed',id:l.id,requestId:'link-completed-'+l.id});
        })().catch(async e=>{await this.owner('/v2/session-links',{action:'failed',id:l.id,requestId:'link-failed-'+l.id,message:e.message}).catch(()=>{});}).finally(()=>this.linkJobs.delete(l.id));this.linkJobs.set(l.id,job);
      }
    }finally{this.linkTicking=false;}
  }
  async options({memberId,channelId}) {
    const m=await this.member(memberId),manager=this.manager(m),status=await this.status(memberId);
    const channels=channelId?await this.channel(memberId,channelId):[];
    if(status.capabilities?.remote){const items=presentSessions(status.items,{bindings:status.bindings,channels,platform:m.platformId==='claude-code'?'Claude':m.name});const binding=status.bindings[channelId];return{...status,items,projects:sessionProjects(items,status.projects),binding:binding?{...binding,...items.find(s=>s.id===binding.sessionId)}:null};}
    if(!manager)return {...status,items:[]};
    const r=manager.records[memberId];if(!r?.enabled)return {...status,items:[]};
    const listed=manager===this.coding?await manager.sessionOptions(memberId):await manager.hostFor(memberId).sessions();
    const items=presentSessions(listed.items,{bindings:r.chatBindings,channels,dataDir:manager.dataDir,platform:m.platformId==='codex'?'Codex':m.platformId==='deepseek-harness'?'DeepSeek':'Gemini'}),binding=r.chatBindings?.[channelId]||(!r.chatBindings&&r.sessionId?{sessionId:r.sessionId,title:r.title,workspace:r.cwd,migrated:true}:null);
    const legacyGemini=manager===this.coding&&r.engine==='antigravity';
    return {...status,...listed,newSessionHint:legacyGemini?'新对话使用 Gemini 后台助手；如需使用 Antigravity 桌面原会话，请在桌面新建后回到项目列表选择。':'',existingHint:listed.existingHint?sessionErrorMessage(listed.existingHint):'',items,projects:sessionProjects(items,listed.projects),binding:binding?{...binding,...items.find(s=>s.id===binding.sessionId)}:null};
  }
  async channel(memberId,channelId) {
    if(typeof channelId!=='string'||!/^channel_[a-zA-Z0-9_-]+$/.test(channelId))throw Error('请选择工作区里的聊天');
    const {items}=await this.owner('/v2/channels'),channel=items.find(c=>c.id===channelId);
    if(!channel?.memberIds.includes(memberId))throw Error('请先把这位工作成员加入聊天');return items;
  }
  async assign(input) {
    const {memberId,channelId}=input,key=memberId+':'+channelId;
    if(this.jobs.has(key))return this.jobs.get(key);
    // Lock before any native creation. A double click cannot create two sessions.
    const prior=this.locks.get(memberId)||Promise.resolve(),job=prior.catch(()=>{}).then(()=>this.assignOnce(input));this.locks.set(memberId,job);this.jobs.set(key,job);
    try{return await job;}finally{this.jobs.delete(key);}
  }
  async assignOnce(input) {
    const status=await this.status(input.memberId);
    if(status.remote){
      let command=await this.owner('/v2/native-runtime',{...input,requestId:input.requestId||randomUUID()});
      const deadline=Date.now()+150000;
      while(['pending','prepared','running'].includes(command.status)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,1000));command=await this.owner('/v2/native-runtime?'+new URLSearchParams({memberId:input.memberId,commandId:command.id}));}
      if(command.status==='completed')return{binding:command.binding};
      if(command.status==='failed')throw Error(command.message);
      throw Error('原环境还在处理这次选择，请刷新列表查看结果；不要重复新建对话。原绑定仍保留。');
    }
    const m=await this.member(input.memberId),manager=this.manager(m);if(m.platformId==='claude-code')return this.owner('/v2/native-sessions',{...input,requestId:randomUUID()});if(!manager)throw Error('这个 Agent 的原身份固定，不需要选择会话');
    const channels=await this.channel(input.memberId,input.channelId);
    if(Object.hasOwn(input,'expectedPreviousBinding')&&JSON.stringify(manager.records[input.memberId]?.chatBindings?.[input.channelId]||null)!==JSON.stringify(input.expectedPreviousBinding))throw Error('聊天刚刚选择了其他对话，旧配对说明没有覆盖它');
    if(input.mode==='new'&&manager!==this.coding&&SESSION_CAPABILITIES[m.platformId]?.create!==true)throw Error(SESSION_CAPABILITIES[m.platformId]?.createHint||'此平台尚未支持在 Hub 新建会话');
    const title=channels.find(c=>c.id===input.channelId).name;
    return {binding:await manager.assign({...input,title,channels})};
  }
}
