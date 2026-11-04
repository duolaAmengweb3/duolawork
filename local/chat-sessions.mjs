import {randomUUID} from 'node:crypto';
import {SESSION_CAPABILITIES,publicAssignments} from './session-routing.mjs';
import {presentSessions,sessionProjects,sessionErrorMessage} from './session-presentation.mjs';

export class ChatSessions {
  constructor({coding,dsh,ag}) { Object.assign(this,{coding,dsh,ag});this.jobs=new Map();this.locks=new Map(); }
  owner(...args) { return this.coding.owner(...args); }
  async member(id) {
    const w=await this.owner('/v2/workspace'),m=w.members.find(m=>m.id===id);
    if(!m)throw Error('成员已移出工作区');return m;
  }
  manager(m) { return m.platformId==='codex'||m.platformId==='gemini-cli'?this.coding:m.platformId==='antigravity'?(this.ag.records[m.id]?.enabled||!this.coding.records[m.id]?.enabled?this.ag:this.coding):m.platformId==='deepseek-harness'?this.dsh:null; }
  async status(memberId) {
    const m=await this.member(memberId),manager=this.manager(m),r=manager?.records[memberId];
    if(m.platformId==='claude-code'){const r=await this.owner('/v2/native-sessions?memberId='+memberId);return{...r,assignments:r.record.assignments,capabilities:SESSION_CAPABILITIES['claude-code']};}
    const capabilities={...(SESSION_CAPABILITIES[m.platformId]||{kind:'fixed'})};if(manager===this.coding)Object.assign(capabilities,{kind:'sessions',existing:true,create:true,label:m.platformId==='codex'?'Codex 工作会话':'Gemini 后台会话'});
    return {capabilities,record:manager===this.coding?manager.status().members.find(r=>r.memberId===memberId):manager?.status().find(r=>r.memberId===memberId),assignments:publicAssignments(r||{})};
  }
  async connect({memberId}) {
    const m=await this.member(memberId),manager=this.manager(m);if(!manager)throw Error('这个平台使用固定 Agent 接入');
    // A second account must not silently attach to the same default login.
    // Existing members and same-account legacy assignments remain intact.
    if(!manager.records[memberId]?.enabled){
      const w=await this.owner('/v2/workspace');
      const existing=w.members.find(peer=>peer.id!==memberId&&peer.platformId===m.platformId&&peer.accountId!==m.accountId&&peer.status!=='disabled'&&manager.records[peer.id]?.enabled);
      if(existing)throw Error(`这台电脑的 ${m.platformId==='codex'?'Codex':'Agent'} 已连接为「${existing.name}」。不同项目请在它的聊天里选择工作会话；另一个账号需要连接它自己的环境，不能直接复用这个登录。`);
    }
    if(manager===this.coding)await manager.connect({memberId,engine:m.platformId==='codex'?'codex':'antigravity',sourceOnly:true});
    else {
      if(manager===this.ag&&this.coding.records[memberId]?.enabled)await this.coding.pause({memberId});
      await manager.connectSource({memberId});
    }
    return this.status(memberId);
  }
  async options({memberId,channelId}) {
    const m=await this.member(memberId),manager=this.manager(m),status=await this.status(memberId);
    const channels=channelId?await this.channel(memberId,channelId):[];
    if(m.platformId==='claude-code'){const items=presentSessions(status.items.filter(s=>s.online),{bindings:status.bindings,channels,platform:'Claude'});const binding=status.bindings[channelId];return{...status,items,projects:sessionProjects(items),binding:binding?{...binding,...items.find(s=>s.id===binding.sessionId)}:null};}
    if(!manager)return {...status,items:[]};
    const r=manager.records[memberId];if(!r?.enabled)return {...status,items:[]};
    const listed=manager===this.coding?await manager.sessionOptions(memberId):await manager.hostFor(memberId).sessions();
    const items=presentSessions(listed.items,{bindings:r.chatBindings,channels,dataDir:manager.dataDir,platform:m.platformId==='codex'?'Codex':m.platformId==='deepseek-harness'?'DeepSeek':'Gemini'}),binding=r.chatBindings?.[channelId]||(!r.chatBindings&&r.sessionId?{sessionId:r.sessionId,title:r.title,workspace:r.cwd,migrated:true}:null);
    const legacyGemini=manager===this.coding&&m.platformId!=='codex';
    return {...status,...listed,existingHint:listed.existingHint?sessionErrorMessage(listed.existingHint):legacyGemini?'此账号当前连接的是 Gemini 后台助手，下面是它的对话，不包含 Antigravity 桌面里的项目和对话。':'',items,projects:sessionProjects(items,listed.projects),binding:binding?{...binding,...items.find(s=>s.id===binding.sessionId)}:null};
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
    const m=await this.member(input.memberId),manager=this.manager(m);if(m.platformId==='claude-code')return this.owner('/v2/native-sessions',{method:'POST',body:{...input,requestId:randomUUID()}});if(!manager)throw Error('这个 Agent 的原身份固定，不需要选择会话');
    const channels=await this.channel(input.memberId,input.channelId);
    if(input.mode==='new'&&manager!==this.coding&&SESSION_CAPABILITIES[m.platformId]?.create!==true)throw Error(SESSION_CAPABILITIES[m.platformId]?.createHint||'此平台尚未支持在 Hub 新建会话');
    const title=channels.find(c=>c.id===input.channelId).name;
    return {binding:await manager.assign({...input,title,channels})};
  }
}
