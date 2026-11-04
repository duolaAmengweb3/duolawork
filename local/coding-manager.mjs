import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {privateJson} from './storage.mjs';
import {requestJson} from './transport.mjs';
import {CodingMemberClient} from './coding-client.mjs';
import {NativeAgent,findExecutable,safeError} from './native-agent.mjs';
import {NativeRuntime} from './native-runtime.mjs';
import {CodexWorkingHost} from './codex-working-host.mjs';
import {publicAssignments} from './session-routing.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const nativeLabel=r=>r.engine==='codex'?'Codex':'Gemini';
export function rememberAccount(record,auth){
 if(record.engine!=='codex'||!auth)return;
 if(record.accountLabel&&record.accountLabel!==auth.accountLabel)throw Error('这台电脑的 Codex 已切换账号或退出登录。原连接和工作会话保留，请连接正确的账号后继续。');
 if(auth.accountLabel)record.accountLabel=auth.accountLabel;
}
export class CodingManager{
 constructor({config,dataDir,maintenance=false,request=requestJson,agentFactory,runtime,interval=5000}){
  Object.assign(this,{config,dataDir,request,agentFactory,interval});this.runtime=runtime||new NativeRuntime(dataDir);this.workingHost=new CodexWorkingHost();this.file=path.join(dataDir,'native-coding.json');this.records={};this.jobs=new Map();this.sessionOperations=new Map();this.nativeUsedAt=new Map();this.agents=new Map();this.approvals=new Map();this.hubToolNames=new Map();this.stopped=maintenance;this.writes=Promise.resolve();
 }
 async load(){try{this.records=JSON.parse(await fs.readFile(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('本机接入记录无法读取，原文件保留');}
  for(const r of Object.values(this.records)){
   r.permissionMode??='full';
   if(!r.chatBindings){r.chatBindings=Object.fromEntries(Object.entries(r.sessions||{}).filter(([key])=>key.startsWith('channel_')).map(([channelId,sessionId])=>[channelId,{sessionId,workspace:r.cwd,title:'原工作会话',mode:'existing',migrated:true}]));r.manualAssignments=true;r.verificationSessionId=r.sessions?.verification||Object.entries(r.sessions||{}).find(([key])=>key.startsWith('probe_'))?.[1]||Object.values(r.chatBindings)[0]?.sessionId;r.sourceReady=['idle','working'].includes(r.status);}
   delete r.authorizationUrl;
   if(r.engine==='antigravity'&&r.protocol!=='acp'){
    r.legacyReceiver={protocol:'cli-headless',sessions:r.sessions,inFlight:r.inFlight};r.sessions={};r.protocol='acp';r.inFlight=null;r.status='disconnected';r.message='官方接入已准备好，点击连接完成首次登录';r.enabled=false;
   }else if(r.inFlight){r.status='needs_review';r.message='上次执行中断，原会话保留；请检查并继续未完成的工作';}
   else if(r.sourceReady&&r.enabled&&r.status==='connecting'){r.status='idle';r.message='账号连接已保留，等待新消息';}
   else if(['installing','connecting','waiting_login'].includes(r.status)){r.status='disconnected';r.message='上次连接未完成，点击连接继续；原登录资料保留';}
  }
 }
 async save(){const value=structuredClone(this.records);for(const r of Object.values(value))delete r.authorizationUrl;const next=this.writes.catch(()=>{}).then(()=>privateJson(this.file,value));this.writes=next;await next;}
 get busy(){return this.sessionOperations.size>0||Object.values(this.records).some(r=>['installing','connecting','working'].includes(r.status));}
 status(){return{members:Object.values(this.records).map(({memberId,engine,status,message,cwd,sessions,lastRunAt,lastCompletedAt,lastReceiptAt,enabled,authorizationUrl,downloadedBytes,totalBytes,permissionMode,chatBindings,sourceReady,manualAssignments,accountLabel})=>({memberId,engine,status,message,cwd,sessionCount:new Set(Object.values(sessions||{})).size,lastRunAt,lastCompletedAt,lastReceiptAt,enabled,authorizationUrl,downloadedBytes,totalBytes,permissionMode,sourceReady,manualAssignments,accountLabel,assignments:publicAssignments({chatBindings})})),approvals:[...this.approvals.values()].map(({id,memberId,title,detail,questions})=>({id,memberId,title,detail,questions})),running:!this.stopped};}
 async owner(route,body){return this.request(this.config.endpoint+route,{token:this.config.adminKey,...(body===undefined?{}:{method:'POST',body})});}
 async start(){this.stopped=false;if(this.timer)return;this.timer=setInterval(()=>this.tick().catch(()=>{}),this.interval);this.timer.unref();await this.tick();}
 launch(r,fn){if(this.jobs.has(r.memberId))return;const job=Promise.resolve().then(fn).catch(async e=>{if(r.enabled){r.status='needs_review';r.message=safeError(e);}delete r.authorizationUrl;await this.save();}).finally(()=>this.jobs.delete(r.memberId));this.jobs.set(r.memberId,job);}
 async connect({memberId,engine,sourceOnly=false}){
  if(!/^member_[a-zA-Z0-9_-]+$/.test(memberId||'')||!['codex','antigravity'].includes(engine))throw new Error('不支持这个原生成员');
  if(this.jobs.has(memberId))return this.status();
  const workspace=await this.owner('/v2/workspace'),member=workspace.members.find(m=>m.id===memberId);
  if(!member||!([engine,...(engine==='antigravity'?['gemini-cli']:[])].includes(member.platformId)))throw new Error('成员与原生运行环境不匹配');
  const base=path.join(this.dataDir,'coding',memberId);await fs.mkdir(base,{recursive:true,mode:0o700});let r=this.records[memberId];
  if(r?.engine&&r.engine!==engine)throw new Error('已有会话属于其他运行环境，未覆盖');
  if(r?.inFlight)throw new Error('上次工作尚未确认，请使用“继续原会话”');
  r??={memberId,engine,cwd:path.join(base,'workspace'),grantFile:path.join(base,'grant.json'),sessions:{},protocol:engine==='codex'?'app-server':'acp',permissionMode:'full'};
  if(sourceOnly){r.manualAssignments=true;r.chatBindings??=Object.fromEntries(Object.entries(r.sessions||{}).filter(([key])=>key!=='verification').map(([channelId,sessionId])=>[channelId,{sessionId,workspace:r.cwd,title:'原工作会话',mode:'existing',migrated:true}]));}this.records[memberId]=r;r.status='connecting';r.enabled=true;r.hubToolsAuthorized=true;r.message='正在准备官方连接';await this.save();this.launch(r,()=>this.setup(r));return this.status();
 }
 async setup(r){
  await fs.mkdir(r.cwd,{recursive:true,mode:0o700});
  let exists=false;try{await fs.access(r.grantFile);exists=true;}catch{}
  if(!exists){
   const skill=await this.owner('/v2/connect/skill',{memberId:r.memberId});const code=skill.pairingCode||skill.skill?.match(/配对码：([A-F0-9]{12})/)?.[1];if(!code)throw new Error('Hub 未返回有效的一次性配对码');
   const grant=await this.request(this.config.endpoint+'/v2/connect/redeem',{method:'POST',body:{code,attemptId:r.memberId+':'+randomUUID()}});await privateJson(r.grantFile,{...grant,expiresAt:Date.now()+grant.expires_in*1000});
  }
  const client=this.client(r);await client.api('/v2/self/connection',{method:'POST',body:{requestId:randomUUID(),transport:'pull',pollSeconds:15}});
  await this.prepareNative(r,client);r.sourceReady=true;if(!r.manualAssignments)await client.api('/v2/self/check',{method:'POST',body:{requestId:randomUUID()}});
  r.status='idle';r.inFlight=null;r.message=r.manualAssignments?'运行端已连接，请在聊天中选择或新建工作会话':'正在自动验证连接，原生 Agent 回复后即可聊天';await this.save();
 }
 client(r){return new CodingMemberClient(r.grantFile,{request:this.request});}
 async prepareNative(r,client){
  this.nativeUsedAt.set(r.memberId,Date.now());
  let agent=this.agents.get(r.memberId);if(agent&&!agent.rpc?.closed&&!agent.rpc?.closing){rememberAccount(r,agent.readAccount?await agent.readAccount():agent.auth);return agent;}
  const spec=await this.runtime.ensure(r.engine,p=>{Object.assign(r,p,{status:p.phase==='installing'?'installing':'connecting'});});
  let node=await findExecutable('node');if(!node&&process.versions.electron)node=process.execPath;
  if(!node)throw new Error('本机缺少 Node.js 运行环境');
  const env={...process.env,PATH:[path.dirname(spec.command),path.dirname(node),process.env.PATH||''].join(path.delimiter)};
  let processTemp;
  if(r.engine==='antigravity'){
   const provider=path.join(this.dataDir,'coding',r.memberId,'google'),temp=path.join(provider,'runtime-temp');await fs.mkdir(temp,{recursive:true,mode:0o700});processTemp=await fs.mkdtemp(path.join(temp,'run-'));
   const settings=path.join(provider,'antigravity-acp/settings.json');try{await fs.access(settings);}catch(e){if(e.code!=='ENOENT')throw e;await privateJson(settings,{auth:{type:'oauth-personal'}});}
   // Official ACP auth owns this separate profile. Never extract/copy IDE tokens.
   for(const key of Object.keys(env))if(['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_GENAI_USE_VERTEXAI','GEMINI_HOME','ANTIGRAVITY_HARNESS_PATH','BROWSER'].includes(key.toUpperCase()))delete env[key];
   Object.assign(env,{GEMINI_HOME:provider,AGY_ACP_FORCE_FILE_STORAGE:'1',ANTIGRAVITY_HARNESS_PATH:spec.harness,PYTHONUNBUFFERED:'1',TMPDIR:processTemp,ELECTRON_RUN_AS_NODE:'1'});
   const q=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";env.BROWSER=[node,path.join(here,'native-browser-helper.mjs')].map(q).join(' ')+' %s';
   r.mcpServers=[{name:'hub_'+r.memberId.slice(-16),command:node,args:[path.join(here,'coding-mcp.mjs'),r.grantFile],env:[{name:'ELECTRON_RUN_AS_NODE',value:'1'}]}];
  }
  const options={engine:r.engine,cwd:r.cwd,command:spec.command,extraArgs:r.engine==='antigravity'?spec.args:[],env,permissionMode:r.permissionMode||'full',
   toolCall:async(name,args)=>{const matches=w=>!r.manualAssignments||(w.channelId?r.inFlight?.key===w.channelId:r.inFlight?.stepId===w.stepId);
    if(name==='claim_work'&&r.manualAssignments){const {work}=await client.tool('list_work');if(!work.some(w=>w.stepId===args.stepId&&matches(w)))throw Error('工作属于其他聊天会话，未领取');}
    const result=await client.tool(name,args);if(name==='list_work'&&r.manualAssignments)result.work=result.work.filter(matches);if(['submit_work','post_message','stay_silent','ask_user'].includes(name)){r.lastReceiptAt=new Date().toISOString();await this.save();}return result;},
   onStopped:async()=>{if(processTemp)await fs.rm(processTemp,{recursive:true,force:true});},
   onApproval:request=>this.approve(r,request),onProgress:p=>{r.message='正在使用原生工具：'+safeError(p.name);},
   onAuthorization:url=>{if(!['https://accounts.google.com','https://auth.openai.com','https://auth0.openai.com'].includes(new URL(url).origin))return;r.status='waiting_login';r.authorizationUrl=url;r.message='请点击官方登录按钮完成这一次登录；后续自动复用';}
  };
  agent=this.agentFactory?this.agentFactory(options):new NativeAgent(options);this.agents.set(r.memberId,agent);
  try{rememberAccount(r,await agent.initialize());delete r.authorizationUrl;r.status=r.inFlight?'working':'connecting';return agent;}catch(e){await agent.stop().catch(()=>{});this.agents.delete(r.memberId);throw e;}
 }
 async tick(){
  if(this.stopped)return;
  for(const r of Object.values(this.records))if(r.status==='idle'&&!this.jobs.has(r.memberId)&&!this.sessionOperations.has(r.memberId)&&this.agents.has(r.memberId)&&Date.now()-(this.nativeUsedAt.get(r.memberId)||Date.parse(r.lastCompletedAt)||Date.now())>120000){const agent=this.agents.get(r.memberId);if(agent.busy||agent.rpc?.pending?.size)continue;this.agents.delete(r.memberId);await agent.stop().catch(()=>{});}
  await Promise.all(Object.values(this.records).filter(r=>r.enabled&&r.status==='idle'&&!this.jobs.has(r.memberId)&&!this.sessionOperations.has(r.memberId)).map(async r=>{const job=this.check(r);this.jobs.set(r.memberId,job);try{await job;}finally{this.jobs.delete(r.memberId);}}));
 }
 async check(r,{recover=false}={}){
  try{
   const client=this.client(r),signal=await client.api('/v2/signal',{timeout:15000});if(!r.enabled||this.stopped||this.sessionOperations.has(r.memberId)||(!signal.hasWork&&!recover))return;
   const {work}=await client.tool('list_work'),first=recover?work.find(w=>w.stepId===r.inFlight?.stepId):work.find(w=>w.status==='ready'&&(!r.manualAssignments||(w.channelId?r.chatBindings?.[w.channelId]:r.verificationSessionId)));
   if(this.sessionOperations.has(r.memberId))return;
   if(!first){r.inFlight=null;r.status='idle';r.message='已检查原回执，继续接收消息';await this.save();return;}
   const key=first.channelId||first.projectId||'verification';const binding=r.chatBindings?.[key]||(!first.channelId&&r.manualAssignments?Object.values(r.chatBindings||{}).find(b=>b.sessionId===r.verificationSessionId):null);r.inFlight={at:new Date().toISOString(),stepId:first.stepId,key};r.lastRunAt=r.inFlight.at;r.status='working';r.message='原生 Agent 正在处理消息';await this.save();
   if(binding?.mode==='native-existing'){await this.runExisting(r,first,binding,client);return;}
   const agent=await this.prepareNative(r,client),tools=await client.tools();this.hubToolNames.set(r.memberId,new Set(tools.map(t=>t.name)));const session=await agent.session({id:binding?.sessionId||(!first.channelId&&r.manualAssignments?r.verificationSessionId:r.sessions[key]),cwd:binding?.workspace||r.cwd,tools,mcpServers:r.mcpServers||[]});r.sessions[key]=session.id;await this.save();
   const prompt=`你是 Agent Hub 成员 ${r.memberId}，使用你自己的原生工具、模型、规则和本会话记忆。Hub 工具来自${r.engine==='codex'?' hub_ 前缀动态工具':' MCP hub_'+r.memberId.slice(-16)}。直接调用已提供的工具，不需要先通过终端扫描工具目录。常用签名：list_work({})；claim_work({requestId,stepId})；post_message({requestId,channelId,turnId,body,mentions?})；submit_work({requestId,attemptId,lease,items:[{title,body}]} )。先用 list_work 读取真实工作，本轮只处理 stepId=${first.stepId}，channelId=${first.channelId||'无'}。${recover?'上次运行中断：检查原领取和已经完成的操作，沿用原 attemptId/lease 继续未完成部分，不要重做副作用；不清楚时回报具体问题。':'用 claim_work 领取并遵循完整指令。'}普通群消息直接沟通，不擅自建任务或文档。使用所需原生工具完成后，必须调用 post_message 或 submit_work 回到这个 Hub 会话；只在原生终端输出不算回群。验证任务严格提交要求的内容，不自称验证通过。不轮询空跑、不改提供方配置、不替其他成员领取、不回显凭证。`;
   const result=await agent.run({session,prompt});if(result.sessionId){r.sessions[key]=result.sessionId;if(binding)binding.sessionId=result.sessionId;}
   const remaining=await client.tool('list_work');if(remaining.work.some(w=>w.stepId===first.stepId))throw new Error('原生运行结束，但 Hub 未收到该工作回复；原会话保留，请继续检查');
   const status=await client.api('/v2/self/status');r.lastReceiptAt=new Date().toISOString();r.lastCompletedAt=r.lastReceiptAt;r.inFlight=null;r.status='idle';r.message=status.complete?'已接入，正在后台接收消息':'本轮已回传，连接验证仍待完成';await this.save();
  }catch(e){r.message=safeError(e);if(r.inFlight||[401,403].includes(e.status))r.status='needs_review';await this.save();}
 }
 async assign(input){
  const {memberId}=input,prior=this.sessionOperations.get(memberId)||Promise.resolve();
  // Reserve synchronously: empty polling and idle cleanup cannot race a UI choice.
  const operation=prior.catch(()=>{}).then(async()=>{
   const r=this.records[memberId];if(r?.inFlight)throw Error('这个 Agent 正在处理消息，请等它回复后再更换对话。已有工作会继续。');
   await this.jobs.get(memberId);
   if(r?.inFlight)throw Error('这个 Agent 正在处理消息，请等它回复后再更换对话。已有工作会继续。');
   try{return await this.assignSession(input);}
   finally{this.nativeUsedAt.set(memberId,Date.now());if(r?.enabled&&r.sourceReady&&!r.inFlight){r.status='idle';r.message='账号已连接，继续接收消息';await this.save();}}
  });
  this.sessionOperations.set(memberId,operation);
  try{return await operation;}finally{if(this.sessionOperations.get(memberId)===operation)this.sessionOperations.delete(memberId);}
 }
 async assignSession({memberId,channelId,sessionId,mode='new',workspace,title}){
  const r=this.records[memberId];if(!r?.enabled||!r.sourceReady&&r.status!=='idle')throw Error('请先连接这个 Agent 的账号');
  if(!['existing','new'].includes(mode))throw Error('无效的会话选项');
  r.chatBindings??=Object.fromEntries(Object.entries(r.sessions||{}).filter(([id])=>id!=='verification').map(([id,s])=>[id,{sessionId:s,workspace:r.cwd,title:'原工作会话',mode:'existing',migrated:true}]));
  const client=this.client(r);let selected;
  if(mode==='existing'){
   selected=Object.values(r.chatBindings).find(b=>b.sessionId===sessionId);
   if(!selected&&r.engine==='codex'){const native=(await this.workingHost.sessions()).items.find(s=>s.id===sessionId);if(native){for(const other of Object.values(this.records))if(other.memberId!==memberId&&other.enabled&&Object.values(other.chatBindings||{}).some(b=>b.sessionId===sessionId))throw Error('此原生会话已有另一位工作成员');selected={sessionId:native.id,title:native.title,workspace:native.workspace,mode:'native-existing'};}}
   if(!selected)throw Error('请选择这位成员已有的工作会话；不会读取其他成员的上下文');
  }else{
   if(r.creationPending)throw Error('上次会话创建结果待确认，请先查看已有会话，未重复创建');
   const agent=await this.prepareNative(r,client),tools=await client.tools();
   const cwd=workspace?await fs.realpath(workspace):path.join(this.dataDir,'coding',memberId,'chats',channelId);await fs.mkdir(cwd,{recursive:true,mode:0o700});
   r.creationPending=true;await this.save();let session;
   try{session=await agent.session({cwd,tools,mcpServers:r.mcpServers||[]});}catch(error){if(typeof error.code==='number'){r.creationPending=false;await this.save();}throw error;}
   r.creationPending=false;selected={sessionId:session.id,workspace:cwd,title:title||'新对话',mode:'new',createdAt:new Date().toISOString()};
  }
  r.manualAssignments=true;r.sourceReady=true;r.chatBindings[channelId]={...selected};r.sessions[channelId]=selected.sessionId;r.verificationSessionId??=selected.sessionId;await this.save();
  const status=await client.api('/v2/self/status');if(!status.complete&&!r.proofRunId){const proof=await client.api('/v2/self/check',{method:'POST',body:{requestId:randomUUID()}});r.proofRunId=proof.runId||proof.result?.runId;await this.save();}
  return r.chatBindings[channelId];
 }
 async sessionOptions(memberId){const r=this.records[memberId];let native=[],existingHint='';if(r?.engine==='codex')try{native=(await this.workingHost.sessions()).items;}catch(e){existingHint=safeError(e);}
  const owned=Object.values(r?.chatBindings||{}).map(b=>({id:b.sessionId,title:b.title||'原工作会话',workspace:b.workspace,mode:b.mode,createdAt:b.createdAt}));const otherSessions=new Set(Object.values(this.records).filter(v=>v.memberId!==memberId&&v.enabled).flatMap(v=>Object.values(v.chatBindings||{}).map(b=>b.sessionId)));return {existingHint,items:[...new Map([...owned,...native.filter(s=>!otherSessions.has(s.id))].map(s=>[s.id,s])).values()]};}
 async runExisting(r,first,binding,client){
  const key=first.channelId||Object.entries(r.chatBindings).find(([,b])=>b.sessionId===r.verificationSessionId)?.[0];if(!key)throw Error('请选择负责连接验证的工作会话');
  r.nativeDeliveries??={};const delivery=r.nativeDeliveries[first.stepId];
  if(delivery&&delivery.status!=='sent')throw Error('原会话发送结果待确认，请查看原会话；未重复执行');
  const q=v=>"'"+v.replaceAll("'","'\"'\"'")+"'",helper=['node',path.join(here,'coding-session-tools.mjs'),this.file,r.memberId,key].map(q).join(' ');
  const prompt='Hub 有一条发给你这个原工作会话的消息，保留原项目、模型、工具和记忆。Hub 工具命令：'+helper+'。先运行命令加 claim_step '+first.stepId+'，按领取返回的真实指令完成；只处理这个工作。其他工具用 call <工具名> <JSON>，定义可用 list_tools 查询。普通消息必须用 post_message({requestId,channelId,turnId,body,mentions?}) 回到原 Hub 聊天；验证用 submit_work，不能只在原界面回答。不扫描登录资料、不读其他会话、不自动创建任务文档或分工。';
  if(!delivery){r.nativeDeliveries[first.stepId]={status:'sending',sessionId:binding.sessionId};await this.save();
  try{await this.workingHost.queue({sessionId:binding.sessionId,workspace:binding.workspace,prompt});r.nativeDeliveries[first.stepId].status='sent';await this.save();}catch(e){r.nativeDeliveries[first.stepId].status='uncertain';await this.save();throw e;}}
  const deadline=Date.now()+20*60000;
  while(r.enabled&&!this.stopped&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,1500));const {work}=await client.tool('list_work');if(!work.some(w=>w.stepId===first.stepId)){r.lastReceiptAt=new Date().toISOString();r.lastCompletedAt=r.lastReceiptAt;r.inFlight=null;r.status='idle';r.message='原 Codex 工作会话已回复';await this.save();return;}}
  throw Error('尚未收到原 Codex 会话回传，原工作和消息保留，未重复发送');
 }
 approve(r,{engine,method,params,sessionId}){
  const supported=engine==='antigravity'?method==='session/request_permission':['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput'].includes(method);
  if(!supported)throw new Error('原生 Agent 请求暂未支持的交互：'+method+'；未自动批准');
  if(engine==='antigravity'&&sessionId!==params.sessionId)throw new Error('原生批准请求的会话不匹配');
  if(r.permissionMode==='full'&&method!=='item/tool/requestUserInput'){
   if(engine==='antigravity'){const option=params.options?.find(o=>o.kind==='allow_once');if(option)return Promise.resolve({outcome:{outcome:'selected',optionId:option.optionId}});}
   else if(method==='item/permissions/requestApproval')return Promise.resolve({permissions:params.permissions,scope:'turn'});
   else return Promise.resolve({decision:'accept'});
  }
  const metadata=params.toolCall?._meta;
  if(engine==='antigravity'&&r.hubToolsAuthorized===true&&metadata?.is_mcp_tool_call===true&&metadata.mcp?.server==='hub_'+r.memberId.slice(-16)&&this.hubToolNames.get(r.memberId)?.has(metadata.mcp?.tool)){
   const once=params.options?.find(o=>o.kind==='allow_once');if(once)return Promise.resolve({outcome:{outcome:'selected',optionId:once.optionId}});
  }
  if(engine==='antigravity'&&r.hubToolsAuthorized===true)return this.metadataReadAllowed(r,sessionId,params.toolCall).then(allowed=>{
   const once=params.options?.find(o=>o.kind==='allow_once');return allowed&&once?{outcome:{outcome:'selected',optionId:once.optionId}}:this.queueApproval(r,{engine,method,params});
  });
  return this.queueApproval(r,{engine,method,params});
 }
 async metadataReadAllowed(r,sessionId,tool){
  if(!/^[a-zA-Z0-9-]{1,100}$/.test(sessionId||''))return false;
  const root=path.join(this.dataDir,'coding',r.memberId,'google/antigravity-acp/brain',sessionId,'mcp','hub_'+r.memberId.slice(-16));
  let candidate,directory=false;
  if(tool?.kind==='read')candidate=tool.rawInput?.AbsolutePath||tool.rawInput?.path;
  else if(tool?.kind==='execute'&&tool.rawInput?.Cwd===r.cwd){
   const command=tool.rawInput.CommandLine||'';
   const match=command.match(/^(ls(?: -la| -l| -a)?|cat) (?:'([^']+)'|"([^"]+)"|([^\s'";&|<>`$]+))$/);
   if(!match)return false;directory=match[1].startsWith('ls');candidate=match[2]||match[3]||match[4];
  }
  if(typeof candidate!=='string')return false;
  if(directory?candidate!==root:path.dirname(candidate)!==root||!this.hubToolNames.get(r.memberId)?.has(path.basename(candidate,'.json'))||!candidate.endsWith('.json'))return false;
  try{return await fs.realpath(root)===root&&await fs.realpath(candidate)===candidate;}catch{return false;}
 }
 queueApproval(r,{engine,method,params}){
  const id=randomUUID(),questions=method==='item/tool/requestUserInput'?params.questions:undefined;
  const raw=engine==='antigravity'?params.toolCall:params;
  const detail=JSON.stringify(raw,null,2);if(detail.length>40000)throw new Error('本次原生操作过长，未自动批准；请在原生环境检查');
  const title=questions?'Agent 需要你的补充':engine==='antigravity'?(params.toolCall?.title||'Agent 申请使用工具'):method.includes('fileChange')?'Agent 申请修改文件':'Agent 申请操作许可';
  r.message=title;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.approvals.delete(id);reject(new Error('等待本人确认超时，未自动批准'));},10*60000);this.approvals.set(id,{id,memberId:r.memberId,title,detail,questions,engine,method,params,resolve,reject,timer});});
 }
 decide({id,allow,answers}){
  const item=this.approvals.get(id);if(!item)throw new Error('这项确认已结束或过期');let result;
  if(item.engine==='antigravity'){const option=item.params.options?.find(o=>o.kind===(allow?'allow_once':'reject_once'));result=option?{outcome:{outcome:'selected',optionId:option.optionId}}:{outcome:{outcome:'cancelled'}};}
  else if(item.questions)result={answers:Object.fromEntries(item.questions.map(q=>[q.id,{answers:allow?[String(answers?.[q.id]||'')]:[]}]))};
  else if(item.method==='item/permissions/requestApproval')result={permissions:allow?item.params.permissions:{},scope:'turn'};
  else result={decision:allow?'accept':'decline'};
  clearTimeout(item.timer);this.approvals.delete(id);item.resolve(result);return{accepted:true};
 }
 async pause({memberId}){const r=this.records[memberId];if(!r)throw new Error('本机没有此成员');if(this.sessionOperations.has(memberId))throw new Error('正在连接对话，请稍等完成后再调整');if(r.inFlight||this.jobs.has(memberId))throw new Error('成员还在处理请求，请等本轮结束');r.enabled=false;r.status='paused';r.message='后台接收已暂停，登录与会话保留';await this.agents.get(memberId)?.stop();this.agents.delete(memberId);await this.save();return this.status();}
 async disconnect(memberId){if(this.sessionOperations.has(memberId))throw new Error('正在连接对话，请稍等完成后再解除连接');const r=this.records[memberId];if(!r)return;r.enabled=false;r.status='disconnected';r.message='Hub 连接已解除，原生登录和会话历史保留';delete r.authorizationUrl;for(const [id,a] of this.approvals)if(a.memberId===memberId){clearTimeout(a.timer);a.reject(new Error('Hub 连接已解除'));this.approvals.delete(id);}await this.agents.get(memberId)?.stop();this.agents.delete(memberId);await this.jobs.get(memberId);r.status='disconnected';r.message='Hub 连接已解除，原生登录和会话历史保留';await this.save();}
 async permissions({memberId,mode}){if(this.sessionOperations.has(memberId))throw new Error('正在连接对话，请稍等完成后再调整权限');const r=this.records[memberId];if(!r||!['full','ask'].includes(mode))throw new Error('权限选项不正确');if(r.inFlight)throw new Error('本轮工作结束后即可调整权限');await this.jobs.get(memberId);if(r.inFlight)throw new Error('本轮工作结束后即可调整权限');r.permissionMode=mode;await this.agents.get(memberId)?.stop();this.agents.delete(memberId);await this.save();return this.status();}
 async resume({memberId}){const r=this.records[memberId];if(!r)throw new Error('本机没有此成员');if(this.jobs.has(memberId))return this.status();r.enabled=true;if(r.inFlight){this.launch(r,()=>this.check(r,{recover:true}));}else if(['disconnected','needs_review'].includes(r.status)){return this.connect({memberId,engine:r.engine});}else{r.status='idle';r.message='继续接收消息';await this.save();}return this.status();}
 async stop(){this.stopped=true;clearInterval(this.timer);this.timer=null;for(const a of this.approvals.values()){clearTimeout(a.timer);a.reject(new Error('本机执行端停止，未批准操作'));}this.approvals.clear();await Promise.allSettled([...this.agents.values()].map(a=>a.stop()));this.agents.clear();await Promise.allSettled([...this.jobs.values()]);await this.save();}
}
