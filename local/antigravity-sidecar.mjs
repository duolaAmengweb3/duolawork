import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {timingSafeEqual,createHash} from 'node:crypto';
import {privateJson} from './storage.mjs';
import {CodingMemberClient} from './coding-client.mjs';
import {safeError} from './native-agent.mjs';
const execute=promisify(execFile);
const UUID=/^[a-f0-9-]{36}$/i;

// Native authentication is inherited from the official Sidecar parent, kept in
// memory, and never copied into Hub state, prompts, logs or provider settings.
export class AntigravityNative {
 constructor({env=process.env,exec=execute}={}){this.env=env;this.exec=exec;}
 async compatibility(){const {stdout}=await this.exec('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString','/Applications/Antigravity.app/Contents/Info.plist']);return{supported:stdout.trim()==='2.28.0'};}
 async rpc(method,body={}){
  if(!['GetAllCascadeTrajectories','GetConversationMetadata'].includes(method))throw Error('Unsupported native read');
  const address=this.env.ANTIGRAVITY_LS_ADDRESS;if(!address||!this.env.ANTIGRAVITY_CSRF_TOKEN)throw Error('Official Sidecar environment unavailable');
  const u=new URL('http://'+address.replace(/^https?:\/\//,''));if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw Error('Native service is not loopback');
  return new Promise((resolve,reject)=>{
   const req=http.request({hostname:u.hostname,port:u.port,path:'/exa.language_server_pb.LanguageServerService/'+method,method:'POST',headers:{'Content-Type':'application/json','x-codeium-csrf-token':this.env.ANTIGRAVITY_CSRF_TOKEN}},res=>{
    let raw='';res.on('data',b=>{raw+=b;if(Buffer.byteLength(raw)>8e6)req.destroy(Error('Native metadata too large'));});res.on('end',()=>{try{const d=JSON.parse(raw);if(res.statusCode!==200)throw Error('Native metadata request failed ('+res.statusCode+')');resolve(d);}catch(e){reject(e);}});
   });req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('Native metadata timed out')));req.end(JSON.stringify(body));
  });
 }
 async summaries(){return (await this.rpc('GetAllCascadeTrajectories')).trajectorySummaries||{};}
 async metadata(id){if(!UUID.test(id||''))throw Error('Invalid native conversation');return this.rpc('GetConversationMetadata',{conversationId:id});}
 async send(id,text){
  if(!UUID.test(id||''))throw Error('Invalid native conversation');
  const exe=this.env.ANTIGRAVITY_AGENTAPI_EXE;
  if(!exe||!path.isAbsolute(exe))throw Error('Official agentapi executable unavailable');
  // ANTIGRAVITY_AGENTAPI_EXE is the official multicall binary, not the shell shim.
  await this.exec(exe,['agentapi','send-message',id,text],{env:this.env,timeout:20000,maxBuffer:1024*1024});
 }
}

export function nativeSession(id,s){
 const workspace=s.workspaces?.[0]?.workspaceFolderAbsoluteUri||s.workspaces?.[0]?.workspaceFolderUri||s.workspaceUri||s.workspacePath||'';
 let cwd=workspace;try{if(workspace.startsWith('file:'))cwd=fileURLToPath(workspace);}catch{cwd='';}
 return{id,title:s.summary||s.title||'未命名会话',workspace:cwd,running:!!s.isRunning||s.status!=='CASCADE_RUN_STATUS_IDLE',nativeStatus:s.status||null};
}

export class AntigravitySidecar {
 constructor({stateFile,native=new AntigravityNative(),clientFactory=f=>new CodingMemberClient(f),pollMs=3000}={}){Object.assign(this,{stateFile,native,clientFactory,pollMs});this.bindings=new Map();this.ready=false;this.closed=false;this.writes=Promise.resolve();this.bindingWrites=Promise.resolve();}
 async save(){const s=structuredClone(this.state);this.writes=this.writes.catch(()=>{}).then(()=>privateJson(this.stateFile,s));return this.writes;}
 async start(){
  if((await fs.stat(this.stateFile)).mode&0o077)throw Error('Hub Sidecar state must be private');
  this.state=JSON.parse(await fs.readFile(this.stateFile));if(this.state.controlToken?.length<32)throw Error('Missing Hub control token');
  this.state.deliveries??={};
  for(const d of Object.values(this.state.deliveries))if(d.status==='sending')d.status='uncertain';
  for(const b of this.state.bindings||[])this.bindings.set(b.sessionId,{...b,client:this.clientFactory(b.grantFile),toolCalls:[]});
  this.server=http.createServer((req,res)=>this.handle(req,res));await new Promise((r,j)=>{this.server.once('error',j);this.server.listen(0,'127.0.0.1',r);});
  this.state.controlUrl='http://127.0.0.1:'+this.server.address().port;this.state.pid=process.pid;this.state.nativePid=process.ppid;await this.save();
  if((await this.native.compatibility?.())?.supported===false){this.startError='此官方桌面版本尚未通过兼容验证，未处理任何消息';return this;}
  await this.native.summaries();this.ready=true;this.timer=setInterval(()=>this.poll().catch(()=>{}),this.pollMs);this.timer.unref();return this;
 }
 async sessions(){return{items:Object.entries(await this.native.summaries()).map(([id,s])=>nativeSession(id,s))};}
 async bind(input){const job=this.bindingWrites.catch(()=>{}).then(()=>this.bindOnce(input));this.bindingWrites=job.catch(()=>{});return job;}
 async bindOnce({sessionId,workspace,grantFile}){
  const s=(await this.sessions()).items.find(s=>s.id===sessionId);if(!s)throw Error('原桌面会话不存在，未新建替代会话');
  if(!s.workspace||await fs.realpath(s.workspace)!==await fs.realpath(workspace))throw Error('原会话项目与所选项目不一致');
  if((await fs.stat(grantFile)).mode&0o077)throw Error('Hub grant must be private');
  const client=this.clientFactory(grantFile),c=await client.credentials();
  for(const b of this.bindings.values())if((b.sessionId===sessionId&&b.memberId!==c.memberId)||(b.memberId===c.memberId&&b.sessionId!==sessionId))throw Error('该会话或成员已有另一项连接');
  const prior=this.bindings.get(sessionId);if(prior)return this.publicBinding(prior);
  const b={sessionId,workspace:s.workspace,grantFile,memberId:c.memberId,client,toolCalls:[]};this.bindings.set(sessionId,b);await this.saveBindings();return this.publicBinding(b);
 }
 publicBinding(b){return{sessionId:b.sessionId,memberId:b.memberId,workspace:b.workspace,toolCalls:b.toolCalls,lastError:b.lastError,waitingForNative:b.waitingForNative||false};}
 async saveBindings(){this.state.bindings=[...this.bindings.values()].map(({sessionId,workspace,grantFile,memberId})=>({sessionId,workspace,grantFile,memberId}));await this.save();}
 async unbind(sessionId){this.bindings.delete(sessionId);await this.saveBindings();return{disconnected:true,nativeSessionRetained:true};}
 async poll(){
  if(this.closed||this.polling||!this.ready)return;this.polling=true;
  try{for(const b of this.bindings.values())try{
   if(!(await b.client.api('/v2/signal',{timeout:15000})).hasWork){b.lastError=null;continue;}
   const {work}=await b.client.tool('list_work');const next=work.find(w=>w.status==='ready');if(!next)continue;
   const key=b.memberId+':'+next.stepId,previous=this.state.deliveries[key];
   if(previous){if(previous.status==='uncertain')b.lastError='上次发送结果尚未确认，未重复执行；请查看原会话';continue;}
   const s=(await this.sessions()).items.find(s=>s.id===b.sessionId);if(!s)throw Error('原桌面会话暂不可用，未新建替代会话');
   if(!s.workspace||await fs.realpath(s.workspace)!==await fs.realpath(b.workspace))throw Error('原会话的项目发生变化，未向其他项目发送消息');
   if(s.running){b.waitingForNative=true;continue;}
   b.waitingForNative=false;if(this.closed||this.bindings.get(b.sessionId)!==b)continue;
   const helper=path.join(path.dirname(fileURLToPath(import.meta.url)),'antigravity-tools.mjs');
   const quote=v=>"'"+v.replaceAll("'","'\"'\"'")+"'";
   const command=['node',helper,this.stateFile,b.sessionId].map(quote).join(' ');
   const prompt='Hub 有一条发给你的真实消息。你仍是当前原生会话，保留原项目、规则、工具和已有记忆。Hub 工具入口：'+command+'。先执行该命令加 claim_step '+next.stepId+'（合并 list_work 核对和 claim_work 领取），按返回的真实指令工作，channelId='+(next.channelId||'')+'。其他工具用 call <工具名> <JSON参数>。普通聊天回传：post_message({requestId,channelId,turnId,body,mentions?})；验证或交付：submit_work({requestId,attemptId,lease,items:[{title,body}]} )。文档/事项/会议等工具需要时用 list_tools 查看定义。写入带稳定 requestId。不读或输出凭证，不读其他会话日志，不改提供方设置，不擅自创建文档、任务或分工。只在原界面回答不算回到 Hub。';
   this.state.deliveries[key]={status:'sending',sessionId:b.sessionId,stepId:next.stepId,at:new Date().toISOString()};await this.save();
   try{await this.native.send(b.sessionId,prompt);this.state.deliveries[key].status='sent';b.lastError=null;}catch{this.state.deliveries[key].status='uncertain';b.lastError='原会话消息发送结果待确认，未自动重复执行';}await this.save();
  }catch(e){b.lastError=safeError(e);}}finally{this.polling=false;}
 }
 async handle(req,res){
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  try{
   const a=Buffer.from(req.headers.authorization||''),b=Buffer.from('Bearer '+this.state.controlToken);
   if(req.headers.origin||a.length!==b.length||!timingSafeEqual(a,b))return send(401,{error:'Local Hub authorization required'});
   const route=new URL(req.url,'http://127.0.0.1').pathname;
   if(req.method==='GET'&&route==='/health')return send(200,{ready:this.ready,error:this.startError,protocolVersion:1,revision:path.basename(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),bindings:[...this.bindings.values()].map(b=>this.publicBinding(b))});
   if(req.method==='GET'&&route==='/sessions')return send(200,await this.sessions());
   if(req.method!=='POST')return send(404,{error:'Unknown route'});
   let raw='';for await(const c of req){raw+=c;if(Buffer.byteLength(raw)>200000)throw Error('Request too large');}const input=JSON.parse(raw||'{}');
   if(!this.ready)throw Error('Native Sidecar is starting');
   if(route==='/bind')return send(200,await this.bind(input));
   if(route==='/unbind')return send(200,await this.unbind(input.sessionId));
   if(route==='/tool'){
    const binding=this.bindings.get(input.sessionId);if(!binding)throw Error('此原会话的 Hub 连接已解除');
    if(input.operation==='claim_step'){
     const {work}=await binding.client.tool('list_work');binding.toolCalls.push({name:'list_work',at:new Date().toISOString()});
     if(this.bindings.get(input.sessionId)!==binding)throw Error('此原会话的 Hub 连接已解除');
     if(!work.some(w=>w.stepId===input.name&&w.status==='ready'))throw Error('指定工作已领取、已结束或不属于此成员，未领取其他消息');
     const requestId=createHash('sha256').update(binding.memberId+':claim:'+input.name).digest('hex');
     const result=await binding.client.tool('claim_work',{requestId,stepId:input.name});binding.toolCalls.push({name:'claim_work',at:new Date().toISOString()});binding.toolCalls=binding.toolCalls.slice(-100);return send(200,result);
    }
    const tools=await binding.client.tools();if(this.bindings.get(input.sessionId)!==binding)throw Error('此原会话的 Hub 连接已解除');if(input.operation==='list_tools')return send(200,{tools});
    if(input.operation!=='call'||!tools.some(t=>t.name===input.name))throw Error('Unknown Hub tool');
    const result=await binding.client.tool(input.name,input.args||{});binding.toolCalls.push({name:input.name,at:new Date().toISOString()});binding.toolCalls=binding.toolCalls.slice(-100);return send(200,result);
   }
   return send(404,{error:'Unknown route'});
  }catch(e){send(400,{error:safeError(e)});}
 }
 async stop(){this.closed=true;clearInterval(this.timer);if(this.server)await new Promise(r=>{this.server.close(r);this.server.closeIdleConnections();});await this.writes;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const sidecar=await new AntigravitySidecar({stateFile:process.argv[2]}).start();
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>sidecar.stop().finally(()=>process.exit(0)));
}
