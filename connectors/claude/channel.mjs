import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {CodingMemberClient} from '../../local/coding-client.mjs';
import {privateJson} from '../../local/storage.mjs';
import {refreshSessionInfo} from './session-info.mjs';

// The MCP subprocess has only Hub credentials. Native files/shell remain the
// parent Claude's tools in its own environment, never RPC methods on the Mac.
export class ClaudeChannel {
  constructor({client,session,notify,stateFile}){Object.assign(this,{client,session,notify,stateFile});this.sent={};this.claims={};this.pending=null;}
  async load(){try{const s=JSON.parse(await fs.readFile(this.stateFile));this.sent=s.sent||{};this.claims=s.claims||{};}catch(e){if(e.code!=='ENOENT')throw e;}}
  save(){return privateJson(this.stateFile,{sent:this.sent,claims:this.claims});}
  async scope(){return this.client.api('/v2/self/native-sessions');}
  allowed(w,r){return w.channelId?r.bindings[w.channelId]?.sessionId===this.session.sessionId:r.verificationSessionId===this.session.sessionId;}
  async work(){const [r,{work}]=await Promise.all([this.scope(),this.client.tool('list_work')]);return work.filter(w=>this.allowed(w,r));}
  tick(){return this.pending??=(async()=>{
    const work=await this.work(),current=new Set(work.map(w=>w.stepId));
    for(const key of Object.keys(this.sent))if(!current.has(key))delete this.sent[key];
    // Only one outstanding notification at a time; SDK writes are not receipts.
    const w=work.find(w=>w.status!=='ready')||work.find(w=>w.status==='ready');if(!w)return;
    const prior=this.sent[w.stepId];if(prior&&(Date.now()-prior.at<120000||prior.count>=3))return;
    this.sent[w.stepId]={at:Date.now(),count:(prior?.count||0)+1};await this.save();
    try{await this.notify({method:'notifications/claude/channel',params:{content:`Hub 有一条发给你的消息。调用 list_work，然后 claim_work 领取 stepId=${w.stepId}，按领取结果回复原聊天。验证工作按原指令提交。用你当前会话的原生工具完成工作；不要把回复只留在终端。`,meta:{step_id:w.stepId,session_id:this.session.sessionId}}});}
    catch(e){delete this.sent[w.stepId];await this.save();throw e;}
  })().finally(()=>{this.pending=null;});}
  async tool(name,args){
    if(['setup_connection','check_connection','report_setup_status','receive_messages'].includes(name))throw Error('连接由本机接收器维护；请使用 list_work 与 claim_work');
    const r=await this.scope();
    if(args.channelId&&r.bindings[args.channelId]?.sessionId!==this.session.sessionId)throw Error('这个聊天未分配给当前 Claude 会话');
    if(name==='list_work')return{work:await this.work()};
    if(name==='claim_work'){
      if(!(await this.work()).some(w=>w.stepId===args.stepId))throw Error('此工作未分配给当前会话');
      const result=await this.client.tool(name,args);this.claims[result.attemptId||result.turnId]={attemptId:result.attemptId,turnId:result.turnId};await this.save();return result;
    }
    if(args.attemptId&&!this.claims[args.attemptId])throw Error('当前会话没有领取此工作');
    if(args.turnId&&!Object.values(this.claims).some(c=>c.turnId===args.turnId))throw Error('当前会话没有领取这条消息');
    return this.client.tool(name,args);
  }
}

export async function serve({grantFile,runFile,stateDir}){
  const client=new CodingMemberClient(grantFile);
  const server=new Server({name:'agent-hub',version:'1.0.0'},{capabilities:{tools:{},experimental:{'claude/channel':{}}},instructions:'这是原生 Claude 会话的 Hub 协作通道。收到通知后用 list_work、claim_work 领取；普通聊天用 post_message 回原群，验证按指令 submit_work。使用你原来的项目和工具。不要输出任何凭证，不要自行配置别人的连接。'});
  let bridge,session,closed=false,polling=false,lastHeartbeat=0,checkId;
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:(await client.tools()).filter(t=>!['setup_connection','check_connection','report_setup_status','receive_messages'].includes(t.name))}));
  server.setRequestHandler(CallToolRequestSchema,async req=>{try{if(!bridge)throw Error('正在等待原生会话登记');const value=await bridge.tool(req.params.name,req.params.arguments||{});return{content:[{type:'text',text:JSON.stringify(value)}]};}catch(e){return{isError:true,content:[{type:'text',text:e.status===401||e.status===403?'Hub 授权已失效，请查看成员连接':e.message}]};}});
  const heartbeat=async()=>{session=await refreshSessionInfo(session);return client.api('/v2/self/native-sessions',{method:'POST',body:session});};
  async function tick(){if(polling||closed)return;polling=true;try{
    const next=JSON.parse(await fs.readFile(runFile,'utf8'));
    if(!next.sessionId)return;
    if(session?.sessionId!==next.sessionId){
      if(session)await client.api('/v2/self/native-sessions',{method:'POST',body:{...session,status:'offline'}});
      session=next;const stateFile=path.join(stateDir,next.sessionId+'.json');bridge=new ClaudeChannel({client,session,stateFile,notify:n=>server.notification(n)});await bridge.load();lastHeartbeat=0;
    }
    if(Date.now()-lastHeartbeat>25000){await heartbeat();lastHeartbeat=Date.now();}
    const status=await client.api('/v2/self/status');
    if(!status.complete&&!checkId){
      const r=await bridge.scope();if(r.verificationSessionId===session.sessionId){const requestId='claude-probe-'+session.sessionId;await client.api('/v2/self/check',{method:'POST',body:{requestId}});checkId=requestId;}
    }
    await bridge.tick();
  }catch(e){if(e.code!=='ENOENT')process.stderr.write('Agent Hub: '+(e.status===403?'连接已撤销或会话被占用':e.status===401?'授权需要重新连接':'连接暂未就绪，保留状态重试')+'\n');}finally{polling=false;}}
  await server.connect(new StdioServerTransport());
  const timer=setInterval(()=>void tick(),5000);await tick();
  const close=async()=>{if(closed)return;closed=true;clearInterval(timer);while(polling)await new Promise(r=>setTimeout(r,25));if(bridge?.pending)await bridge.pending.catch(()=>{});if(session)await client.api('/v2/self/native-sessions',{method:'POST',body:{...session,status:'offline'}}).catch(()=>{});await server.close();};
  process.stdin.on('end',()=>void close());process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
  return{server,close};
}
