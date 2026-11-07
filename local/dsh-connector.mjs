// Native DSH Host plugin. It adds Hub tools to the selected original Agent;
// model execution, native tools, project and session stay in that Host.
import fs from 'node:fs/promises';
import http from 'node:http';
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {CodingMemberClient} from './coding-client.mjs';
import {privateJson} from './storage.mjs';
import {safeError} from './native-agent.mjs';
import {acceptsWork,claimNativeConversation,receiveNativeConversation} from './session-routing.mjs';

export const name='agent-hub-existing-session';
export const inject=['sessionController','agents','tools','workingDirectory','workspaceRegistry','permissionPresets'];
const digest=value=>createHash('sha256').update(value).digest('hex');
const deliveryKey=w=>w.deliveryAttempt?w.stepId+':retry:'+w.deliveryAttempt:w.stepId;
// Captured from the immutable installed directory when this module loads.
// Updating files on disk is not proof that the original Host loaded the update.
const receiverRevision=await fs.readFile(new URL('../complete.json',import.meta.url),'utf8').then(JSON.parse).then(v=>v.revision).catch(()=>null);

export class DshConnector {
 constructor({ctx,stateFile,clientFactory=file=>new CodingMemberClient(file),pollMs=3000,allowProof=false,now=Date.now,receiptGraceMs=60000}){
  Object.assign(this,{ctx,stateFile,clientFactory,pollMs,allowProof,now,receiptGraceMs});
  this.bindings=new Map();this.bindingJobs=new Map();this.pollJobs=new Map();this.saveChain=Promise.resolve();this.removed=new Set();this.closed=false;this.busy=false;this.ready=false;this.dispatches=[];
 }
 async start(){
  this.state=JSON.parse(await fs.readFile(this.stateFile,'utf8'));
  if(typeof this.state.controlToken!=='string'||this.state.controlToken.length<32)throw Error('Missing private local control token');
  if((await fs.stat(this.stateFile)).mode&0o077)throw Error('Connector state must be private (0600)');
  this.server=http.createServer((req,res)=>this.handle(req,res));
  await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',resolve);});
  this.state.controlUrl='http://127.0.0.1:'+this.server.address().port;
  this.state.pid=process.pid;await privateJson(this.stateFile,this.state);
  for(const binding of [...(this.state.bindings||[])]){try{await this.bind(binding);}catch(error){this.dispatches.push({sessionId:binding.sessionId,error:safeError(error)});}}
  this.ready=true;
  this.timer=setInterval(()=>this.poll().catch(error=>{this.lastError=safeError(error);}),this.pollMs);this.timer.unref();
  return this;
 }
 save(){return this.saveChain=this.saveChain.catch(()=>{}).then(async()=>{
  const records=new Map((this.state.bindings||[]).filter(b=>!this.removed.has(b.sessionId)).map(b=>[b.sessionId,b]));
  for(const b of this.bindings.values())records.set(b.sessionId,{sessionId:b.sessionId,workspace:b.workspace,grantFile:b.grantFile,memberId:b.memberId,channelIds:b.channelIds,verification:b.verification,dispatched:[...b.dispatched],receiptRecovery:b.receiptRecovery});
  this.state={...this.state,bindings:[...records.values()]};await privateJson(this.stateFile,this.state);
 });}
 async sessionInfo(id){
  const listed=await this.sessions();
  const item=listed.items.find(x=>x.sessionId===id);
  if(!item)throw Error('Original DSH session does not exist; no replacement created');
  return item;
 }
 async sessions(){
  const listed=await this.ctx.sessionController.list({},new AbortController().signal),registry=this.ctx.workspaceRegistry,archived=new Set(registry?.archivedSessionIds||[]);
  const projects=(registry?.list?.()||[]).map(p=>({id:p.id,name:p.title,workspace:p.path,sessionIds:[...p.sessionIds]}));
  const bySession=new Map(projects.flatMap(p=>p.sessionIds.map(id=>[id,p])));
  return{...listed,projects,items:listed.items.filter(s=>!archived.has(s.sessionId)).map(s=>{const p=bySession.get(s.sessionId);return{...s,...(p?{projectId:p.id,projectName:p.name}:{})};})};
 }
 async bind(input){
  const pending=this.bindingJobs.get(input.sessionId);if(pending){await pending;return this.bindOnce(input);}
  const job=this.bindOnce(input);this.bindingJobs.set(input.sessionId,job);try{return await job;}finally{this.bindingJobs.delete(input.sessionId);}
 }
 async bindOnce({sessionId,workspace,grantFile,dispatched=[],channelIds,verification,receiptRecovery}){
  if(this.bindings.has(sessionId)){
   const b=this.bindings.get(sessionId),c=await this.clientFactory(grantFile).credentials();
   if(b.memberId!==c.memberId||await fs.realpath(workspace)!==b.workspace)throw Error('Original session is already bound to another Hub member');
   b.channelIds=channelIds;b.verification=verification;await this.save();return this.publicBinding(b);
  }
  await this.sessionInfo(sessionId);
  const found=await this.ctx.sessionController.resolveAgent(sessionId);
  if(found.error)throw found.error;
  const agent=found.agent;
  const actual=await fs.realpath(this.ctx.workingDirectory.get(agent.session));
  if(actual!==await fs.realpath(workspace))throw Error('Original session workspace does not match the selected project');
  if((await fs.stat(grantFile)).mode&0o077)throw Error('Hub member grant must be private (0600)');
  const client=this.clientFactory(grantFile),credential=await client.credentials();

  const b={sessionId,channelIds,verification,workspace:actual,grantFile,memberId:credential.memberId,client,dispatched:new Set(dispatched),receiptRecovery,disposers:[],toolCalls:[],abort:new AbortController()};
  const definitions=await client.tools();
  try{
   b.definitions=definitions;this.removed.delete(sessionId);this.bindings.set(sessionId,b);this.attachAgent(agent);
   await this.save();return this.publicBinding(b);
  }catch(error){for(const dispose of b.disposers)dispose();this.bindings.delete(sessionId);throw error;}
 }
 attachAgent(agent){
  const b=this.bindings.get(agent.id);if(!b||this.closed||b.agent===agent)return;
  for(const dispose of b.disposers)dispose();b.disposers=[];b.agent=agent;
  for(const tool of b.definitions){
    b.disposers.push(agent.ctx.tools.register({
     name:'hub_'+tool.name,description:tool.description||tool.name,parameters:tool.inputSchema,
     output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
     execute:async(args,exec)=>{
      if(this.closed||this.bindings.get(b.sessionId)!==b||exec.agent.id!==b.sessionId)throw Error('Hub tool is not authorized for this native session');
      let result;
      if(tool.name==='claim_work'){
        let channelId=args.channelId;
        if(!channelId||!(args.stepId?.startsWith('turn_')||args.stepId?.startsWith('inbox:after:'))){
          const {work}=await b.client.tool('list_work'),item=work.find(w=>w.stepId===args.stepId&&acceptsWork(b,w));
          if(!item)throw Error('工作属于其他聊天的会话，未领取');
          if(channelId&&channelId!==item.channelId)throw Error('工作属于其他聊天的会话，未领取');
          channelId=item.channelId;
        }
        if(channelId&&!acceptsWork(b,{channelId}))throw Error('工作属于其他聊天的会话，未领取');
        result=channelId&&(args.stepId?.startsWith('turn_')||args.stepId?.startsWith('inbox:after:'))
          ?await claimNativeConversation(b.client,{...args,channelId,sessionId:b.sessionId})
          :await b.client.tool(tool.name,args);
      }else if(tool.name==='receive_messages'){
        const channelId=args.channelId||(b.channelIds?.length===1?b.channelIds[0]:null);
        if(!channelId||!acceptsWork(b,{channelId}))throw Error('收件范围必须是当前原会话的聊天');
        result=await receiveNativeConversation(b.client,{args,channelId,sessionId:b.sessionId});
      }else result=await b.client.tool(tool.name,args);
      if(tool.name==='list_work')result.work=result.work.filter(w=>acceptsWork(b,w));
      b.toolCalls.push({name:tool.name,at:new Date().toISOString()});b.toolCalls=b.toolCalls.slice(-100);
      return result;
     },
    }));
  }
 }
 publicBinding(b){return{sessionId:b.sessionId,workspace:b.workspace,memberId:b.memberId,channelIds:b.channelIds,verification:b.verification,toolCalls:b.toolCalls,dispatchedCount:b.dispatched.size,dispatchedStepIds:[...new Set([...b.dispatched].map(key=>key.replace(/:retry:[0-9]+$/,'')))],lastError:b.lastError,receiptRecovery:b.receiptRecovery};}
 async reconcileReceipt(b,work){
  const pending=work.find(w=>['claimed','ready'].includes(w.status)&&w.stepId.startsWith('turn_')&&b.dispatched.has(deliveryKey(w))&&acceptsWork(b,w));
  if(!pending){if(b.receiptRecovery){b.receiptRecovery=null;await this.save();}return false;}
  const native=await this.sessionInfo(b.sessionId),now=this.now();
  if(this.closed||this.bindings.get(b.sessionId)!==b)return true;
  const previous=b.receiptRecovery;
  if(native.running===true){
   if(previous?.stepId===pending.stepId){previous.idleSince=null;previous.state=previous.attemptedAt?'recovering':'running';}
   // Long native work extends the existing lease; it is never replayed.
   if(!b.lastRunningReport||now-b.lastRunningReport>=60000){await b.client.api('/v2/self/conversation-state',{method:'POST',body:{requestId:randomUUID(),turnId:pending.stepId,state:'running'}});b.lastRunningReport=now;}
   return true;
  }
  if(native.running!==false)return true; // Unknown is not proof of termination.
  const recovery=previous?.stepId===pending.stepId&&(previous.deliveryAttempt||0)===(pending.deliveryAttempt||0)?previous:{stepId:pending.stepId,channelId:pending.channelId,deliveryAttempt:pending.deliveryAttempt||0,state:'observing',idleSince:now};
  b.receiptRecovery=recovery;recovery.idleSince??=now;
  if(now-recovery.idleSince<this.receiptGraceMs)return true;
  const state=await b.client.api('/v2/self/conversation-state?turnId='+encodeURIComponent(pending.stepId));
  if(!['active','ready'].includes(state.status)){b.receiptRecovery=null;await this.save();return true;}
  if(!recovery.attemptedAt){
   // Persist before queueing. A lost response or Host restart cannot repeat
   // completed side effects or create an unbounded recovery/model loop.
   recovery.attemptedAt=now;recovery.state='recovering';recovery.idleSince=now;await this.save();
   const text=`DuolaWork 回执恢复：这段原生对话已停止运行，但 ${pending.stepId} 的结果尚未回到原群 ${pending.channelId}。保留当前会话、模型、工具和已有结果。不要重做已完成的操作，不领取其他工作，不重新跑全量测试。用 hub_read_channel 查看本群最新补充，核对本轮已有结果；使用 hub_post_message，提供新的 requestId、channelId=${pending.channelId}、turnId=${pending.stepId}，回传真实结果或具体阻塞。${state.status==='active'?'原工作已领取，无需再次 claim_work。':'本条尚未领取，先 hub_claim_work 领取这一个 stepId 并提供 channelId，然后说明具体中断原因及未执行的工作，不声称完成。'}若已经回过群，核对对应消息后用 hub_stay_silent 结束此 turn。不能声称未验证的工作完成。只收尾这一条，后续由连接器正常投递。`;
   await this.ctx.sessionController.prompt({sessionId:b.sessionId,mode:'queue',requestId:digest(b.memberId+':receipt:'+deliveryKey(pending)),content:[{type:'text',text}]},b.abort.signal);
   return true;
  }
  await b.client.api('/v2/self/conversation-state',{method:'POST',body:{requestId:digest(b.memberId+':receipt-ended:'+deliveryKey(pending)),turnId:pending.stepId,state:'ended'}});
  recovery.state='unresolved';await this.save();return true;
 }
 async poll(){
  if(this.closed)return;
  const launched=[];
  for(const b of this.bindings.values()){
   if(this.pollJobs.has(b.sessionId))continue;
   const job=this.pollBinding(b).finally(()=>{this.pollJobs.delete(b.sessionId);this.busy=this.pollJobs.size>0;});
   this.pollJobs.set(b.sessionId,job);launched.push(job);
  }
  this.busy=this.pollJobs.size>0;await Promise.allSettled(launched);
 }
 async pollBinding(b){
   try{
    const signal=await b.client.api('/v2/signal',{timeout:15000});
    // A claimed message is absent from hasWork (ready notifications only).
    // Reconcile it even when no newer message happens to arrive.
    if(!signal.hasWork&&(!b.dispatched.size||this.now()-(b.lastReceiptCheck||0)<15000)){b.lastError=null;return;}
    const {work}=await b.client.tool('list_work');
    b.lastReceiptCheck=this.now();
    if(this.closed||this.bindings.get(b.sessionId)!==b)return;
    if(await this.reconcileReceipt(b,work))return;
    // A native queue belongs to one original session, never to its whole account.
    if(work.some(w=>b.dispatched.has(deliveryKey(w))&&acceptsWork(b,w)))return;
    const next=work.find(w=>w.status==='ready'&&acceptsWork(b,w)&&!b.dispatched.has(deliveryKey(w)));
    if(!next)return;
    await this.sessionInfo(b.sessionId);
    const found=await this.ctx.sessionController.resolveAgent(b.sessionId);if(found.error)throw found.error;
    if(this.closed||this.bindings.get(b.sessionId)!==b)return;this.attachAgent(found.agent);
    const requestId=digest(b.memberId+':'+deliveryKey(next));
    const text=`Hub 有一条发给你的真实工作。你仍是当前项目的同一个原生 Agent，保留模型、工具、规则和原会话记忆。直接使用 hub_claim_work 领取，参数包含新的 requestId 和 ${JSON.stringify({stepId:next.stepId,...(next.channelId?{channelId:next.channelId}:{})})}，无需先查询工作列表，只处理这条工作。严格按领取结果的指令执行。普通聊天用 hub_post_message 回到同一群，使用领取返回的 turnId；验证或交付任务按要求用 hub_submit_work 提交 attemptId、lease 和 items。所有写调用提供 requestId。不要只在原生界面输出而不回传。普通聊天不擅自创建任务、文档或额外分工。不要读其他会话或登录资料；不输出凭证。`;
    await this.ctx.sessionController.prompt({sessionId:b.sessionId,mode:'queue',requestId,content:[{type:'text',text}]},b.abort.signal);
    b.dispatched.add(deliveryKey(next));await this.save();
    this.dispatches.push({sessionId:b.sessionId,stepId:next.stepId,requestId,at:new Date().toISOString()});this.dispatches=this.dispatches.slice(-100);
    b.lastError=null;
   }catch(error){b.lastError=safeError(error);}
 }
 async unbind(id){const b=this.bindings.get(id);this.removed.add(id);this.bindings.delete(id);if(b){b.abort.abort();for(const dispose of b.disposers)dispose();}await this.save();return{disconnected:true,nativeSessionRetained:true};}
 async handle(req,res){
  const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  try{
   const expected=Buffer.from('Bearer '+this.state.controlToken),got=Buffer.from(req.headers.authorization||'');
   if(req.headers.origin||got.length!==expected.length||!timingSafeEqual(got,expected))return send(401,{error:'Local connector authorization required'});
   const route=new URL(req.url,'http://127.0.0.1').pathname;
   if(req.method==='GET'&&route==='/health'){
    const p=this.ctx.get?.('profileContext'),profile=p?.dir?{name:p.name,dir:await fs.realpath(p.dir)}:undefined;
    return send(200,{ready:this.ready,protocolVersion:7,receiverRevision,profile,provider:'deepseek-harness',bindings:[...this.bindings.values()].map(b=>this.publicBinding(b)),dispatches:this.dispatches,lastError:this.lastError});
   }
   if(req.method==='GET'&&route==='/sessions')return send(200,await this.sessions());
   if(req.method!=='POST')return send(404,{error:'Unknown connector route'});
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>65536)return send(413,{error:'Request too large'});}
   const body=JSON.parse(raw||'{}');
   if(!this.ready)return send(503,{error:'Native Host is restoring original bindings; retry after ready'});
   if(route==='/session-link/prompt'){
    const s=await this.sessionInfo(body.sessionId);
    if(await fs.realpath(s.cwd)!==await fs.realpath(body.workspace)||!/^sessionlink_\w+$/.test(body.requestId||'')||typeof body.prompt!=='string'||body.prompt.length>6000)throw Error('原对话关联请求无效');
    return send(200,await this.ctx.sessionController.prompt({sessionId:s.sessionId,mode:'queue',requestId:body.requestId,content:[{type:'text',text:body.prompt}]},new AbortController().signal));
   }
   if(route==='/sessions/create'){
    const workspace=await fs.realpath(body.workspace);if(!(await fs.stat(workspace)).isDirectory())throw Error('Workspace is not a directory');
    const created=await this.ctx.sessionController.create({cwd:workspace});
    // Hub-created work conversations use the owner's full-tools default.
    // Existing conversations retain their native permission settings.
    if(this.ctx.permissionPresets){const found=await this.ctx.sessionController.resolveAgent(created.sessionId);if(found.error)throw found.error;this.ctx.permissionPresets.set(found.agent.session,'danger-full-access');}
    if(this.ctx.workspaceRegistry){const project=await this.ctx.workspaceRegistry.create(workspace);await project.attachSession(created.sessionId);}
    return send(200,created);
   }
   if(route==='/bind')return send(200,await this.bind(body));
   if(route==='/unbind')return send(200,await this.unbind(body.sessionId));
   // Test-only native-owner controls; omitted from a normal Host installation.
   if(this.allowProof&&route==='/proof/create'){
    if(await fs.realpath(body.workspace)!==await fs.realpath(this.state.proofWorkspace))throw Error('Proof creation is restricted to the disposable project');
    const created=await this.ctx.sessionController.create({cwd:this.state.proofWorkspace});
    this.proofSession=created.sessionId;return send(200,created);
   }
   if(this.allowProof&&body.sessionId===this.proofSession){
    if(route==='/proof/prompt')return send(200,await this.ctx.sessionController.prompt({sessionId:body.sessionId,content:[{type:'text',text:body.text}],mode:'queue',requestId:body.requestId||randomUUID()},new AbortController().signal));
    if(route==='/proof/state'){
     const item=await this.sessionInfo(body.sessionId);
     const inspected=await this.ctx.sessionController.inspect(body.sessionId);
     const events=inspected.events||[];
     return send(200,{item,header:inspected.header,events});
    }
   }
   return send(404,{error:'Unknown or unauthorized connector route'});
  }catch(error){send(400,{error:safeError(error)});}
 }
 async stop(){
  this.closed=true;clearInterval(this.timer);
  for(const b of this.bindings.values()){b.abort.abort();for(const dispose of b.disposers)dispose();}
  if(this.server)await new Promise(resolve=>{this.server.close(resolve);this.server.closeIdleConnections();});
 }
}

export async function apply(ctx,config){
 const connector=await new DshConnector({ctx,stateFile:config.stateFile,pollMs:config.pollMs||3000,allowProof:config.allowProof===true}).start();
 ctx.on('agent/created',({agent})=>connector.attachAgent(agent));
 ctx.effect(()=>()=>connector.stop());
}
