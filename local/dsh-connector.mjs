// Native DSH Host plugin. It adds Hub tools to the selected original Agent;
// model execution, native tools, project and session stay in that Host.
import fs from 'node:fs/promises';
import http from 'node:http';
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {CodingMemberClient} from './coding-client.mjs';
import {privateJson} from './storage.mjs';
import {safeError} from './native-agent.mjs';
import {acceptsWork} from './session-routing.mjs';

export const name='agent-hub-existing-session';
export const inject=['sessionController','agents','tools','workingDirectory','workspaceRegistry'];
const digest=value=>createHash('sha256').update(value).digest('hex');

export class DshConnector {
 constructor({ctx,stateFile,clientFactory=file=>new CodingMemberClient(file),pollMs=3000,allowProof=false}){
  Object.assign(this,{ctx,stateFile,clientFactory,pollMs,allowProof});
  this.bindings=new Map();this.bindingJobs=new Map();this.removed=new Set();this.closed=false;this.busy=false;this.ready=false;this.dispatches=[];
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
 async save(){
  const records=new Map((this.state.bindings||[]).filter(b=>!this.removed.has(b.sessionId)).map(b=>[b.sessionId,b]));
  for(const b of this.bindings.values())records.set(b.sessionId,{sessionId:b.sessionId,workspace:b.workspace,grantFile:b.grantFile,memberId:b.memberId,channelIds:b.channelIds,verification:b.verification,dispatched:[...b.dispatched]});
  this.state={...this.state,bindings:[...records.values()]};await privateJson(this.stateFile,this.state);
 }
 async sessionInfo(id){
  const listed=await this.sessions();
  const item=listed.items.find(x=>x.sessionId===id);
  if(!item)throw Error('Original DSH session does not exist; no replacement created');
  return item;
 }
 async sessions(){const listed=await this.ctx.sessionController.list({},new AbortController().signal),archived=new Set(this.ctx.workspaceRegistry?.archivedSessionIds||[]);return{...listed,items:listed.items.filter(s=>!archived.has(s.sessionId))};}
 async bind(input){
  const pending=this.bindingJobs.get(input.sessionId);if(pending){await pending;return this.bindOnce(input);}
  const job=this.bindOnce(input);this.bindingJobs.set(input.sessionId,job);try{return await job;}finally{this.bindingJobs.delete(input.sessionId);}
 }
 async bindOnce({sessionId,workspace,grantFile,dispatched=[],channelIds,verification}){
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

  const b={sessionId,channelIds,verification,workspace:actual,grantFile,memberId:credential.memberId,client,dispatched:new Set(dispatched),disposers:[],toolCalls:[],abort:new AbortController()};
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
      if(tool.name==='claim_work'){const {work}=await b.client.tool('list_work');if(!work.some(w=>w.stepId===args.stepId&&acceptsWork(b,w)))throw Error('工作属于其他聊天的会话，未领取');}
      const result=await b.client.tool(tool.name,args);if(tool.name==='list_work')result.work=result.work.filter(w=>acceptsWork(b,w));
      b.toolCalls.push({name:tool.name,at:new Date().toISOString()});b.toolCalls=b.toolCalls.slice(-100);
      return result;
     },
    }));
  }
 }
 publicBinding(b){return{sessionId:b.sessionId,workspace:b.workspace,memberId:b.memberId,channelIds:b.channelIds,verification:b.verification,toolCalls:b.toolCalls,dispatchedCount:b.dispatched.size,dispatchedStepIds:[...b.dispatched],lastError:b.lastError};}
 async poll(){
  if(this.closed||this.busy)return;this.busy=true;
  try{
   for(const b of this.bindings.values())try{
    const signal=await b.client.api('/v2/signal',{timeout:15000});
    if(!signal.hasWork){b.lastError=null;continue;}
    const {work}=await b.client.tool('list_work');
    if(this.closed||this.bindings.get(b.sessionId)!==b)continue;
    if([...this.bindings.values()].some(other=>other.memberId===b.memberId&&work.some(w=>other.dispatched.has(w.stepId))))continue;
    const next=work.find(w=>w.status==='ready'&&acceptsWork(b,w)&&!b.dispatched.has(w.stepId));
    if(!next)continue;
    await this.sessionInfo(b.sessionId);
    const found=await this.ctx.sessionController.resolveAgent(b.sessionId);if(found.error)throw found.error;
    if(this.closed||this.bindings.get(b.sessionId)!==b)continue;this.attachAgent(found.agent);
    const requestId=digest(b.memberId+':'+next.stepId);
    const text=`Hub 有一条发给你的真实工作。你仍是当前项目的同一个原生 Agent，保留模型、工具、规则和原会话记忆。使用 hub_list_work 读取；只处理 stepId=${next.stepId}，channelId=${next.channelId||''}。使用 hub_claim_work 领取，严格按领取结果的指令执行。普通聊天用 hub_post_message 回到同一群，使用领取返回的 turnId；验证或交付任务按要求用 hub_submit_work 提交 attemptId、lease 和 items。所有写调用提供 requestId。不要只在原生界面输出而不回传。普通聊天不擅自创建任务、文档或额外分工。不要读其他会话或登录资料；不输出凭证。`;
    await this.ctx.sessionController.prompt({sessionId:b.sessionId,mode:'queue',requestId,content:[{type:'text',text}]},b.abort.signal);
    b.dispatched.add(next.stepId);await this.save();
    this.dispatches.push({sessionId:b.sessionId,stepId:next.stepId,requestId,at:new Date().toISOString()});this.dispatches=this.dispatches.slice(-100);
    b.lastError=null;
   }catch(error){b.lastError=safeError(error);}
  }finally{this.busy=false;}
 }
 async unbind(id){const b=this.bindings.get(id);this.removed.add(id);this.bindings.delete(id);if(b){b.abort.abort();for(const dispose of b.disposers)dispose();}await this.save();return{disconnected:true,nativeSessionRetained:true};}
 async handle(req,res){
  const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  try{
   const expected=Buffer.from('Bearer '+this.state.controlToken),got=Buffer.from(req.headers.authorization||'');
   if(req.headers.origin||got.length!==expected.length||!timingSafeEqual(got,expected))return send(401,{error:'Local connector authorization required'});
   const route=new URL(req.url,'http://127.0.0.1').pathname;
   if(req.method==='GET'&&route==='/health')return send(200,{ready:this.ready,protocolVersion:6,provider:'deepseek-harness',bindings:[...this.bindings.values()].map(b=>this.publicBinding(b)),dispatches:this.dispatches,lastError:this.lastError});
   if(req.method==='GET'&&route==='/sessions')return send(200,await this.sessions());
   if(req.method!=='POST')return send(404,{error:'Unknown connector route'});
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>65536)return send(413,{error:'Request too large'});}
   const body=JSON.parse(raw||'{}');
   if(!this.ready)return send(503,{error:'Native Host is restoring original bindings; retry after ready'});
   if(route==='/sessions/create'){
    const workspace=await fs.realpath(body.workspace);if(!(await fs.stat(workspace)).isDirectory())throw Error('Workspace is not a directory');
    return send(200,await this.ctx.sessionController.create({cwd:workspace}));
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
