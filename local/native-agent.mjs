import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import readline from 'node:readline';

export const NATIVE_ENGINES={codex:{name:'Codex',command:'codex',args:['app-server']},antigravity:{name:'Gemini · Antigravity',command:'agy_acp_server.par',args:[]}};
export const safeError=value=>String(value?.message||value||'原生进程连接失败').replace(/(?:Bearer\s+|sk-|ahv1_|ahr_)[A-Za-z0-9_+/=.-]+/g,'[凭证已隐藏]').replace(/https?:\/\/\S+/g,'[服务地址]').slice(0,1000);
// Only documented account metadata, never login tokens or raw auth responses.
export const codexAccountSummary=account=>({kind:account?.type||null,loggedIn:!!account,accountLabel:typeof account?.email==='string'&&account.email.length<=254?account.email:null});

export async function findExecutable(name,{home=os.homedir(),env=process.env}={}){
 const folders=[...(env.PATH||'').split(path.delimiter),path.join(home,'.local/bin'),'/opt/homebrew/bin','/usr/local/bin'];
 try{const base=path.join(home,'.nvm/versions/node');for(const v of (await fs.readdir(base)).sort().reverse())folders.push(path.join(base,v,'bin'));}catch{}
 for(const folder of [...new Set(folders.filter(Boolean))]){
  const file=path.join(folder,name+(process.platform==='win32'?'.cmd':''));
  try{await fs.access(file,1);return file;}catch{}
 }
 return null;
}
export async function discoverNative(){
 const engines=await Promise.all(Object.entries(NATIVE_ENGINES).map(async([id,engine])=>({id,name:engine.name,executable:await findExecutable(engine.command),kind:'native-local',sessionScope:'hub-owned',existingIdeSession:false})));
 return {engines,existingWindows:{codex:'单独核验；本机原生会话不冒充旧窗口',antigravity:'IDE／桌面版继续单列适配，不能以 Gemini CLI 成功替代'}};
}

export class NativeRpc extends EventEmitter{
 constructor({command,args=[],cwd,env=process.env,spawnProcess=spawn}){
  super();this.nextId=0;this.pending=new Map();this.closed=false;this.stderr='';
  this.child=spawnProcess(command,args,{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
  this.lines=readline.createInterface({input:this.child.stdout});
  this.errorLines=readline.createInterface({input:this.child.stderr});this.errorLines.on('line',line=>this.emit('stderrLine',line));
  this.lines.on('line',line=>this.read(line));
  this.child.stderr.on('data',data=>{this.emit('stderr',String(data));this.stderr=(this.stderr+safeError(String(data))).slice(-2000);});
  this.child.stdin.on('error',error=>this.failed(error));
  this.child.on('error',error=>this.failed(error));
  this.child.on('exit',(code,signal)=>this.failed(new Error('原生进程已退出 '+(signal||code)+(code?': '+this.stderr:''))));
 }
 read(line){
  let message;try{message=JSON.parse(line);}catch{this.emit('text',line);return;}
  if(message.id!==undefined&&(message.result!==undefined||message.error)){
   const pending=this.pending.get(message.id);if(!pending)return;
   this.pending.delete(message.id);clearTimeout(pending.timer);
   if(message.error){const error=new Error(message.error.message||'原生接口拒绝请求');error.code=message.error.code;pending.reject(error);}else pending.resolve(message.result);
  }else if(message.id!==undefined&&message.method){
   const reply=value=>{if(!this.closed&&!this.closing)this.send({jsonrpc:'2.0',id:message.id,...value});};
   Promise.resolve().then(()=>this.onRequest?.(message.method,message.params||{})).then(result=>reply({result:result??{}})).catch(error=>{try{reply({error:{code:-32000,message:safeError(error)}});}catch{}});
  }else if(message.method)this.emit('notification',message.method,message.params||{});
 }
 send(value){if(this.closed||this.closing||this.child.stdin.writableEnded)throw new Error('原生连接已经关闭');this.child.stdin.write(JSON.stringify(value)+'\n');}
 call(method,params={},timeout=60000){
  if(this.closed)return Promise.reject(new Error('原生连接已经关闭'));
  const id=++this.nextId;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('原生接口等待超时：'+method));},timeout);
   this.pending.set(id,{resolve,reject,timer});
   try{this.send({jsonrpc:'2.0',id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
  });
 }
 failed(error){
  if(this.closed)return;this.closed=true;
  for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(safeError(error)));}this.pending.clear();this.lines.close();this.errorLines.close();this.emit('closed',error);
 }
 async stop(){
  if(this.closed)return;this.closing=true;
  const kill=signal=>{try{if(process.platform!=='win32'&&this.child.pid)process.kill(-this.child.pid,signal);else this.child.kill(signal);}catch(e){if(e.code!=='ESRCH')throw e;}};
  this.child.stdin.end();kill('SIGTERM');
  await Promise.race([new Promise(resolve=>this.child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,2000))]);
  if(!this.closed)kill('SIGKILL');this.failed(new Error('本机接收已停止，原账号登录保留'));
 }
}

export class NativeAgent{
 constructor({engine,cwd,command,extraArgs=[],permissionMode='native',env=process.env,toolCall,onAuthorization=()=>{},onStopped=async()=>{},onApproval=async()=>{throw new Error('等待用户批准');},onProgress=()=>{},rpcFactory=options=>new NativeRpc(options)}){
  Object.assign(this,{engine,cwd,command,extraArgs,permissionMode,env,toolCall,onApproval,onProgress,onAuthorization,onStopped,rpcFactory});this.sessions=new Map();this.busy=false;
 }
 async readAccount(){if(this.engine!=='codex')return this.auth;const value=await this.rpc.call('account/read',{refreshToken:false});return this.auth=codexAccountSummary(value.account);}
 async initialize(){
  const spec=NATIVE_ENGINES[this.engine];if(!spec)throw new Error('这个本机原生运行环境尚未适配');
  this.rpc=this.rpcFactory({command:this.command,args:[...spec.args,...this.extraArgs],cwd:this.cwd,env:this.env});
  this.rpc.onRequest=(method,params)=>this.request(method,params);
  this.rpc.on('notification',(method,params)=>this.notification(method,params));
  const authorization=line=>{const match=line.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth[^\s"<>]*/);if(match)this.onAuthorization(match[0]);};
  this.rpc.on('text',authorization);this.rpc.on('stderrLine',authorization);
  const info={name:'agent-hub-native',version:'1.0.0'};
  this.capabilities=await this.rpc.call('initialize',this.engine==='codex'?{clientInfo:info,capabilities:{experimentalApi:true}}:{protocolVersion:1,clientInfo:info,clientCapabilities:{}});
  if(this.engine==='codex'){
   this.rpc.send({jsonrpc:'2.0',method:'initialized',params:{}});
   let account=await this.rpc.call('account/read',{refreshToken:false});
   this.auth=codexAccountSummary(account.account);
   if(!account.account&&account.requiresOpenaiAuth!==false){
    const login=await this.rpc.call('account/login/start',{type:'chatgpt'});
    this.onAuthorization(login.authUrl);
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.rpc.off('notification',handler);reject(new Error('本次官方登录已过期，请重新点击连接'));},5*60000);const handler=(method,p)=>{if(method==='account/login/completed'&&p.loginId===login.loginId){clearTimeout(timer);this.rpc.off('notification',handler);p.success?resolve():reject(new Error('官方登录未完成'));}};this.rpc.on('notification',handler);});
    account=await this.rpc.call('account/read',{refreshToken:false});this.auth=codexAccountSummary(account.account);
   }
  }else {
   if(this.capabilities.agentInfo?.name!=='antigravity-acp')throw new Error('运行组件不是 Google 官方 Antigravity ACP，未继续登录');
   await this.rpc.call('authenticate',{methodId:'oauth-personal'},5*60000);
   this.auth={kind:'native-google-oauth',loggedIn:true};
  }
  return this.auth;
 }
 async session({id,tools=[],mcpServers=[],cwd=this.cwd}){
  if(id&&this.sessions.has(id))return this.sessions.get(id);
  let data,session;
  if(this.engine==='codex'){
   const permission=this.permissionMode==='full'?{approvalPolicy:'never',sandbox:'danger-full-access'}:this.permissionMode==='ask'?{approvalPolicy:'on-request',sandbox:'workspace-write'}:{};
   data=await this.rpc.call(id?'thread/resume':'thread/start',id?{threadId:id,excludeTurns:true,...permission}:{cwd,dynamicTools:tools.map(t=>({name:'hub_'+t.name,description:t.description,inputSchema:t.inputSchema})),serviceName:'agent-hub',...permission});
   session={id:data.thread.id,model:data.model||null,modelProvider:data.modelProvider||data.thread.modelProvider||null};
  }else{
   const appended=this.capabilities.agentCapabilities?._meta?.antigravity?.systemPrompt?.append===true?{_meta:{antigravity:{systemPrompt:{append:'Hub 已授权协作工具的完整参数定义如下；可直接使用对应 MCP 工具，无需先运行终端命令扫描工具目录：'+JSON.stringify(tools)}}}}:{};
   data=await this.rpc.call(id?'session/resume':'session/new',{...(id?{sessionId:id}:{}),cwd,mcpServers,...appended},120000);
   session={id:id||data.sessionId,model:data.models?.currentModelId||null,modelProvider:'native-gemini'};
   if(['full','ask'].includes(this.permissionMode))await this.rpc.call('session/set_mode',{sessionId:session.id,modeId:this.permissionMode==='full'?'yolo':'default'});
  }
  this.sessions.set(session.id,session);return session;
 }
 async request(method,params){
  if(method==='item/tool/call'){
   if(!this.current||params.threadId!==this.current.session.id||!params.tool?.startsWith('hub_'))throw new Error('工具调用不属于当前绑定成员会话');
   try{const value=await this.toolCall(params.tool.slice(4),params.arguments);return{contentItems:[{type:'inputText',text:JSON.stringify(value)}],success:true};}
   catch(error){return{contentItems:[{type:'inputText',text:safeError(error)}],success:false};}
  }
  if(!this.current&&method!=='session/request_permission')throw new Error('当前没有对应的原生工作，未代替用户授权');
  return this.onApproval({engine:this.engine,method,params:{...params,...(this.current?.items?.get(params.itemId)?{item:this.current.items.get(params.itemId)}:{})},sessionId:this.current?.session.id||params.sessionId});
 }
 notification(method,params){
  const run=this.current;if(!run)return;
  if(this.engine==='codex'){
   if(params.threadId&&params.threadId!==run.session.id)return;
   if(run.turnId&&params.turnId&&params.turnId!==run.turnId)return;
   if(run.turnId&&params.turn?.id&&params.turn.id!==run.turnId)return;
   if(params.item?.id){run.items??=new Map();run.items.set(params.item.id,params.item);}
   if(method==='item/completed'&&params.item?.type==='agentMessage')run.text=params.item.text||run.text;
   if(method==='item/started'&&params.item?.type!=='agentMessage')this.onProgress({kind:'tool',name:params.item?.type||'working'});
   if(method==='turn/completed'){
    const failed=params.turn?.status==='failed'||params.turn?.status==='interrupted';
    failed?run.reject(new Error(params.turn?.error?.message||'原生工作未完成')):run.resolve({text:run.text,sessionId:run.session.id});
   }
  }else if(method==='session/update'&&params.sessionId===run.session.id){
   const update=params.update;
   if(update?.sessionUpdate==='agent_message_chunk'&&update.content?.type==='text')run.text+=update.content.text;
   if(['tool_call','tool_call_update'].includes(update?.sessionUpdate))this.onProgress({kind:'tool',name:update.title||update.kind||'working'});
  }
 }
 async run({session,prompt,timeout=20*60000}){
  if(this.busy)throw new Error('同一原生成员正在执行上一条请求');
  this.busy=true;
  let timer,run;
  try{
   const done=new Promise((resolve,reject)=>{run=this.current={session,text:'',resolve,reject};timer=setTimeout(()=>{reject(new Error('原生任务等待超时，状态保留，未重新执行'));this.rpc.stop().catch(()=>{});},timeout);});
   done.catch(()=>{});
   this.rpc.once('closed',run.reject);
   if(this.engine==='codex'){
    const started=await this.rpc.call('turn/start',{threadId:session.id,input:[{type:'text',text:prompt}]});run.turnId=started.turn?.id;
   }else{
    this.rpc.call('session/prompt',{sessionId:session.id,prompt:[{type:'text',text:prompt}]},timeout).then(result=>{
     if(result.stopReason==='cancelled')run.reject(new Error('原生请求已取消'));
     else run.resolve({text:run.text,sessionId:session.id});
    }).catch(error=>run.reject(error));
   }
   return await done;
  }finally{clearTimeout(timer);if(run)this.rpc.off('closed',run.reject);this.current=null;this.busy=false;}
 }
 async stop(){
  if(this.current&&this.engine!=='codex')try{this.rpc.send({jsonrpc:'2.0',method:'session/cancel',params:{sessionId:this.current.session.id}});}catch{}
  this.current?.reject(new Error('本机执行端已停止；任务状态保留，不自动重发'));
  await this.rpc?.stop();await this.onStopped();
 }
}

