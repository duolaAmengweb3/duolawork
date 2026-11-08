import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {CodingMemberClient} from '../../local/coding-client.mjs';
import {privateJson} from '../../local/storage.mjs';
import {refreshSessionInfo} from './session-info.mjs';
import {claimNativeConversation} from '../../local/session-routing.mjs';
import {readNativeInbox,deliveryReceipt,subscribeNativeChanges,CONTINUE_PRIMARY_WORK} from '../../local/native-delivery.mjs';
import {normalizeToolArguments} from '../../shared/tool-arguments.mjs';
export const sessionLinkTools=[
 {name:'link_current_conversation',description:'Link this exact original Claude conversation using the instruction copied by the user from DuolaWork. Reuses the existing account.',inputSchema:{type:'object',properties:{id:{type:'string'},code:{type:'string'}},required:['id','code']}},
 {name:'confirm_current_conversation',description:'Confirm an original-conversation challenge received through this Claude channel.',inputSchema:{type:'object',properties:{id:{type:'string'},challenge:{type:'string'}},required:['id','challenge']}},
];

// The MCP subprocess has only Hub credentials. Native files/shell remain the
// parent Claude's tools in its own environment, never RPC methods on the Mac.
export class ClaudeChannel {
  constructor({client,session,notify,stateFile}){Object.assign(this,{client,session,notify,stateFile});this.sent={};this.claims={};this.pending=null;}
  async load(){try{const s=JSON.parse(await fs.readFile(this.stateFile));this.sent=s.sent||{};this.claims=s.claims||{};this.linkSent=s.linkSent||{};}catch(e){if(e.code!=='ENOENT')throw e;}}
  save(){const snapshot=structuredClone({sent:this.sent,claims:this.claims,linkSent:this.linkSent||{}});return this.writes=(this.writes||Promise.resolve()).catch(()=>{}).then(()=>privateJson(this.stateFile,snapshot,{durable:true}));}
  async linkTick(){
    const {items=[]}=await this.client.api('/v2/self/session-links');this.linkSent??={};
    for(const l of items.filter(l=>l.executor==='claude'&&l.session?.id===this.session.sessionId)){
      if(l.status==='confirming'&&!this.linkSent[l.id]){this.linkSent[l.id]=true;await this.save();try{await this.notify({method:'notifications/claude/channel',params:{content:'用户指定的原对话关联确认。请调用 confirm_current_conversation，参数 '+JSON.stringify({id:l.id,challenge:l.challenge})+'。这只关联当前对话，不改项目、模型或原任务。',meta:{session_id:this.session.sessionId}}});}catch(e){delete this.linkSent[l.id];await this.save();throw e;}}
      if(l.status==='verified')try{await this.client.api('/v2/self/session-links',{method:'POST',body:{action:'apply-claude',id:l.id,requestId:'claude-link-apply-'+l.id}});}catch(e){
        // A busy original conversation keeps receiving its existing work.
        // Stale instructions must not silently overwrite a later user choice.
        if(/聊天刚刚选择了其他对话/.test(e.message))await this.client.api('/v2/self/session-links',{method:'POST',body:{action:'failed',id:l.id,requestId:'claude-link-failed-'+l.id,message:e.message}});
        else if(!/等待原工作|暂时离线/.test(e.message))throw e;
      }
    }
  }
  async scope(){return this.client.api('/v2/self/native-sessions');}
  allowed(w,r){return w.channelId?r.bindings[w.channelId]?.sessionId===this.session.sessionId:r.verificationSessionId===this.session.sessionId;}
  async work(scope){const [r,{work}]=await Promise.all([scope||this.scope(),readNativeInbox(this.client)]);return work.filter(w=>this.allowed(w,r));}
  tick(scope){if(this.pending){this.tickAgain=true;return this.pending;}return this.pending=(async()=>{
    const work=await this.work(scope),current=new Set(work.map(w=>w.stepId));
    for(const key of Object.keys(this.sent))if(!current.has(key))delete this.sent[key];
    // A real claim is the receipt. Do not remind an executing conversation or
    // interrupt it with another wake; queued work remains on the server.
    if(work.some(w=>['claimed','active','running','needs_review'].includes(w.status)))return;
    const w=work.find(w=>w.status==='ready');if(!w)return;
    const prior=this.sent[w.stepId];if(prior?.phase!=='received'&&prior&&(Date.now()-prior.at<120000||prior.count>=3))return;
    this.sent[w.stepId]={at:Date.now(),count:(prior?.count||0)+1,phase:'received',delivery:w.delivery};await this.save();
    await deliveryReceipt(this.client,w,this.session.sessionId);
    try{await this.notify({method:'notifications/claude/channel',params:{content:`Hub 有一条发给你的消息。直接调用 claim_work，使用新的 requestId 及 ${JSON.stringify({stepId:w.stepId,...(w.channelId?{channelId:w.channelId}:{})})}；无需先查询工作列表。按领取结果回复原聊天。验证工作按原指令提交。用你当前会话的原生工具完成工作；不要把回复只留在终端。${CONTINUE_PRIMARY_WORK}`,meta:{step_id:w.stepId,session_id:this.session.sessionId,...(w.channelId?{channel_id:w.channelId}:{})}}});this.sent[w.stepId].phase='notified';await this.save();await deliveryReceipt(this.client,w,this.session.sessionId,'accepted').catch(()=>{});}
    catch(e){delete this.sent[w.stepId];await this.save();throw e;}
  })().finally(()=>{this.pending=null;if(this.tickAgain){this.tickAgain=false;void this.tick().catch(()=>{});}});}
  async tool(name,args){
    args=normalizeToolArguments(name,args);
    if(name==='link_current_conversation')return this.client.api('/v2/self/session-links',{method:'POST',body:{action:'redeem',id:args.id,code:args.code,runtimeId:this.session.runtimeId,session:{id:this.session.sessionId,workspace:this.session.workspace,title:this.session.title},requestId:'claude-link-'+args.id+'-'+this.session.sessionId}});
    if(name==='confirm_current_conversation')return this.client.api('/v2/self/session-links',{method:'POST',body:{action:'confirm',id:args.id,challenge:args.challenge,sessionId:this.session.sessionId,requestId:'claude-link-confirm-'+args.id}});
    if(['setup_connection','check_connection','report_setup_status','receive_messages'].includes(name))throw Error('连接由本机接收器维护；请使用 list_work 与 claim_work');
    if(name==='list_work')return{work:await this.work()};
    if(name==='claim_work'){
      let channelId;
      if(args.stepId?.startsWith('inbox:after:')){
        const prior=Object.values(this.claims).find(c=>c.turnId===args.stepId.slice(12));
        if(!prior)throw Error('当前会话没有领取此续接的原消息');
        if(args.channelId&&prior.channelId&&args.channelId!==prior.channelId)throw Error('续接不能切换原聊天');
        channelId=prior.channelId||args.channelId;
        if(!channelId)throw Error('原聊天尚未登记，未领取后续消息');
      }else if(args.stepId?.startsWith('turn_')&&args.channelId){
        // Claim is the authority: the server checks this exact turn, group,
        // native session, membership and lease atomically. A preflight list is
        // both redundant and subject to a binding race before the real claim.
        channelId=args.channelId;
      }else{
        const work=(await this.work()).find(w=>w.stepId===args.stepId);
        if(!work)throw Error('此工作未分配给当前会话');
        channelId=work.channelId;
      }
      const result=channelId&&(args.stepId?.startsWith('turn_')||args.stepId?.startsWith('inbox:after:'))
        ?await claimNativeConversation(this.client,{...args,channelId,sessionId:this.session.sessionId})
        :await this.client.tool(name,{...args,...(channelId?{channelId,expectedSessionId:this.session.sessionId}:{})});
      const key=result.attemptId||result.turnId;
      if(key){this.claims[key]={attemptId:result.attemptId,turnId:result.turnId,channelId:result.channelId||channelId,lease:result.lease,claimedAtLocal:Date.now()};await this.save();}
      return result;
    }
    const r=await this.scope();
    if(args.channelId&&r.bindings[args.channelId]?.sessionId!==this.session.sessionId)throw Error('这个聊天未分配给当前 Claude 会话');
    if(args.attemptId&&!this.claims[args.attemptId])throw Error('当前会话没有领取此工作');
    if(args.turnId&&!Object.values(this.claims).some(c=>c.turnId===args.turnId))throw Error('当前会话没有领取这条消息');
    const result=await this.client.tool(name,args);
    const acknowledged=args.turnId||(name==='submit_work'&&args.attemptId?.startsWith('turn_')?args.attemptId:null);
    if(acknowledged&&['stay_silent','post_message','submit_work'].includes(name)&&!args.body?.startsWith('HUB_SHARED_TOOL_V1\n')){for(const claim of Object.values(this.claims))if(claim.turnId===acknowledged)claim.acknowledged=true;await this.save();}
    // Upgrade old stored claims when this session sends its actual reply.
    if(args.turnId&&args.channelId){const prior=Object.values(this.claims).find(c=>c.turnId===args.turnId);if(prior&&!prior.channelId){prior.channelId=args.channelId;await this.save();}}
    return result;
  }
}

export async function serve({grantFile,runFile,stateDir}){
  const client=new CodingMemberClient(grantFile);
  const server=new Server({name:'agent-hub',version:'1.0.0'},{capabilities:{tools:{},experimental:{'claude/channel':{}}},instructions:'这是原生 Claude 会话的 Hub 协作通道。收到带 stepId 的通知后直接用 claim_work 领取，保留通知中的 channelId；普通聊天用 post_message 回原群，验证按指令 submit_work。使用你原来的项目和工具。不要输出任何凭证，不要自行配置别人的连接。'});
  let bridge,session,closed=false,polling=false,lastHeartbeat=0,checkId;
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[...(await client.tools()).filter(t=>!['setup_connection','check_connection','report_setup_status','receive_messages'].includes(t.name)),...sessionLinkTools]}));
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
    await bridge.linkTick();await bridge.tick();
  }catch(e){if(e.code!=='ENOENT')process.stderr.write('Agent Hub: '+(e.status===403?'连接已撤销或会话被占用':e.status===401?'授权需要重新连接':'连接暂未就绪，保留状态重试')+'\n');}finally{polling=false;}}
  await server.connect(new StdioServerTransport());
  await tick();let lastFallback=Date.now();
  const stopWatching=subscribeNativeChanges(client,page=>{if(closed)return;if(page.reset||page.changes.some(c=>['session-link','native-command','execution_binding','connection'].includes(c.kind)))void tick();else void bridge?.tick().catch(()=>{});});
  const timer=setInterval(()=>{if(!stopWatching.available||Date.now()-lastFallback>=15000){lastFallback=Date.now();void tick();}},2000);
  const close=async()=>{if(closed)return;closed=true;stopWatching();clearInterval(timer);while(polling)await new Promise(r=>setTimeout(r,25));if(bridge?.pending)await bridge.pending.catch(()=>{});if(session)await client.api('/v2/self/native-sessions',{method:'POST',body:{...session,status:'offline'}}).catch(()=>{});await server.close();};
  process.stdin.on('end',()=>void close());process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
  return{server,close};
}
