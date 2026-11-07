import {isNetworkError} from './network.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {privateJson} from './storage.mjs';
import {requestJson} from './transport.mjs';
import {CodingMemberClient} from './coding-client.mjs';
import {readNativeInbox,deliveryReceipt,subscribeNativeChanges,CONTINUE_PRIMARY_WORK} from './native-delivery.mjs';
import {NativeAgent,findExecutable,safeError} from './native-agent.mjs';
import {NativeRuntime} from './native-runtime.mjs';
import {CodexWorkingHost} from './codex-working-host.mjs';
import {AntigravityDesktopHost} from './antigravity-host.mjs';
import {GeminiCliProjects} from './gemini-cli-projects.mjs';
import {AntigravityCliHost} from './antigravity-cli-bridge.mjs';
import {readNativeCompletion} from './native-completion.mjs';
import {publicAssignments,claimNativeAssignment,receiveNativeConversation} from './session-routing.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const exec=promisify(execFile);
const executionKey=r=>r.executionSessionId?r.memberId+':'+r.executionSessionId:r.memberId;
const nativeLabel=r=>r.engine==='codex'?'Codex':'Gemini';
export function rememberAccount(record,auth){
 if(record.engine!=='codex'||!auth)return;
 if(record.accountLabel&&record.accountLabel!==auth.accountLabel)throw Error('这台电脑的 Codex 已切换账号或退出登录。原连接和工作会话保留，请连接正确的账号后继续。');
 if(auth.accountLabel)record.accountLabel=auth.accountLabel;
}
export class CodingManager{
 constructor({config,dataDir,maintenance=false,request=requestJson,agentFactory,runtime,interval=5000}){
  Object.assign(this,{config,dataDir,request,agentFactory,interval});this.runtime=runtime||new NativeRuntime(dataDir);this.workingHost=new CodexWorkingHost();this.file=path.join(dataDir,'native-coding.json');this.records={};this.jobs=new Map();this.sessionOperations=new Map();this.dispatchHolds=new Set();this.nativeUsedAt=new Map();this.agents=new Map();this.approvals=new Map();this.hubToolNames=new Map();this.stopped=maintenance;this.writes=Promise.resolve();this.watches=new Map();this.dispatching=new Set();
 }
 async load(){try{this.records=JSON.parse(await fs.readFile(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('本机接入记录无法读取，原文件保留');}
  for(const r of Object.values(this.records)){
   r.permissionMode??='full';
   if(!r.chatBindings){r.chatBindings=Object.fromEntries(Object.entries(r.sessions||{}).filter(([key])=>key.startsWith('channel_')).map(([channelId,sessionId])=>[channelId,{sessionId,workspace:r.cwd,title:'原工作会话',mode:'existing',migrated:true}]));r.manualAssignments=true;r.verificationSessionId=r.sessions?.verification||Object.entries(r.sessions||{}).find(([key])=>key.startsWith('probe_'))?.[1]||Object.values(r.chatBindings)[0]?.sessionId;r.sourceReady=['idle','working'].includes(r.status);}
   delete r.authorizationUrl;
   for(const state of Object.values(r.executions||{}))if(state.inFlight){state.status=state.nativeDeliveries?.[state.inFlight.stepId]?'syncing':'needs_review';state.message='正在核对原会话的工作回执';}
   if(r.engine==='antigravity'&&r.protocol!=='acp'){
    r.legacyReceiver={protocol:'cli-headless',sessions:r.sessions,inFlight:r.inFlight};r.sessions={};r.protocol='acp';r.inFlight=null;r.status='disconnected';r.message='官方接入已准备好，点击连接完成首次登录';r.enabled=false;
   }else if(r.inFlight){
    const original=r.nativeDeliveries?.[r.inFlight.stepId];
    r.status=original?'syncing':'needs_review';
    r.message=original?'正在同步原会话的消息状态，已有工作继续':'上次执行中断，原会话保留；请检查并继续未完成的工作';
   }
   else if(r.sourceReady&&r.enabled&&r.status==='connecting'){r.status='idle';r.message='账号连接已保留，等待新消息';}
   else if(['installing','connecting','waiting_login'].includes(r.status)){r.status='disconnected';r.message='上次连接未完成，点击连接继续；原登录资料保留';}
  }
 }
 workingHostFor(r){return r.engine==='antigravity-cli'?(this.antigravityCliHost??=new AntigravityCliHost(this.dataDir)):r.engine==='gemini-cli'?(this.geminiProjects??=new GeminiCliProjects()):r.engine==='antigravity'?(this.antigravityWorkingHost??=new AntigravityDesktopHost(this.dataDir)):this.workingHost;}
 async save(){const value=structuredClone(this.records);for(const r of Object.values(value))delete r.authorizationUrl;const next=this.writes.catch(()=>{}).then(()=>privateJson(this.file,value,{durable:true}));this.writes=next;await next;}
 get busy(){return this.sessionOperations.size>0||Object.values(this.records).some(r=>['installing','connecting','working'].includes(r.status)||Object.values(r.executions||{}).some(s=>s.inFlight&&s.status==='working'));}
 rawStatus(){return{members:Object.values(this.records).map(({memberId,engine,status,message,cwd,sessions,lastRunAt,lastCompletedAt,lastReceiptAt,enabled,authorizationUrl,downloadedBytes,totalBytes,permissionMode,chatBindings,sourceReady,manualAssignments,accountLabel,inFlight,nativeDeliveries})=>({memberId,engine,status,message,cwd,sessionCount:new Set(Object.values(sessions||{})).size,lastRunAt,lastCompletedAt,lastReceiptAt,enabled,authorizationUrl,downloadedBytes,totalBytes,permissionMode,sourceReady,manualAssignments,accountLabel,pendingReply:!!inFlight,pendingStepId:inFlight?.stepId||null,deliveryState:inFlight?nativeDeliveries?.[inFlight.stepId]?.status||null:null,assignments:publicAssignments({chatBindings})})),approvals:[...this.approvals.values()].map(({id,memberId,title,detail,questions})=>({id,memberId,title,detail,questions})),running:!this.stopped};}
 status(){const result=this.rawStatus();for(const item of result.members){const r=this.records[item.memberId],slots=Object.values(r.executions||{}),flight=slots.filter(s=>s.inFlight);
   item.assignments=item.assignments.map(b=>{const s=r.executions?.[b.sessionId];return {...b,...(s?.inFlight?{pendingStepId:s.inFlight.stepId,deliveryState:s.nativeDeliveries?.[s.inFlight.stepId]?.status||'working',workState:s.status,workMessage:s.message}:{})};});
   if(flight.length){item.pendingReply=true;item.status=flight.some(s=>s.status==='working')?'working':flight.some(s=>s.status==='needs_review')?'needs_review':'syncing';item.message=flight.length+' 段工作对话有消息正在处理';}
  }return result;}
 async owner(route,body){return this.request(this.config.endpoint+route,{token:this.config.adminKey,...(body===undefined?{}:{method:'POST',body})});}
 async start(){this.stopped=false;if(this.timer)return;this.timer=setInterval(()=>this.tick().catch(()=>{}),this.interval);this.timer.unref();await this.tick();}
 launch(r,fn){if(this.jobs.has(r.memberId))return;const job=Promise.resolve().then(fn).catch(async e=>{if(r.enabled){r.status='needs_review';r.message=safeError(e);}delete r.authorizationUrl;await this.save();}).finally(()=>this.jobs.delete(r.memberId));this.jobs.set(r.memberId,job);}
 async connect({memberId,engine,sourceOnly=false}){
  if(!/^member_[a-zA-Z0-9_-]+$/.test(memberId||'')||!['codex','antigravity','gemini-cli','antigravity-cli'].includes(engine))throw new Error('不支持这个原生成员');
  if(this.jobs.has(memberId))return this.status();
  const workspace=await this.owner('/v2/workspace'),member=workspace.members.find(m=>m.id===memberId);
  if(!member||!([engine,...(['antigravity','gemini-cli','antigravity-cli'].includes(engine)?['gemini-cli','antigravity']:[])].includes(member.platformId)))throw new Error('成员与原生运行环境不匹配');
  const base=path.join(this.dataDir,'coding',memberId);await fs.mkdir(base,{recursive:true,mode:0o700});let r=this.records[memberId];
  if(r?.engine&&r.engine!==engine)throw new Error('已有会话属于其他运行环境，未覆盖');
  if(r?.inFlight||Object.values(r?.executions||{}).some(s=>s.inFlight))throw new Error('上次工作尚未确认，请使用“继续原会话”');
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
 async prepareNative(r,client,{preserveStatus=false}={}){
  this.nativeUsedAt.set(executionKey(r),Date.now());
  let agent=this.agents.get(executionKey(r));if(agent&&!agent.rpc?.closed&&!agent.rpc?.closing){rememberAccount(r,agent.readAccount?await agent.readAccount():agent.auth);return agent;}
  const spec=['gemini-cli','antigravity-cli'].includes(r.engine)?{command:await findExecutable(r.engine==='gemini-cli'?'gemini':'agy'),args:[]}:await this.runtime.ensure(r.engine,p=>{Object.assign(r,p,{status:p.phase==='installing'?'installing':'connecting'});});
  if(!spec.command)throw Error('这个环境尚未安装对应的原生 CLI，请在原 Agent 所在的环境执行接入说明');
  if(r.engine==='antigravity-cli'){
   const {stdout}=await exec(spec.command,['--version'],{timeout:10000});const version=stdout.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
   if(!version||Number(version[1])<1||Number(version[1])===1&&Number(version[2])<5)throw Error('Antigravity CLI '+stdout.trim()+' 尚不支持此接入接口。请在原环境用 agy update 更新到 1.5.0 或以上，再重试；原登录和会话保留。');
  }
  let node=await findExecutable('node');if(!node&&process.versions.electron)node=process.execPath;
  if(!node)throw new Error('本机缺少 Node.js 运行环境');
  const env={...process.env,PATH:[path.dirname(spec.command),path.dirname(node),process.env.PATH||''].join(path.delimiter)};
  if(r.engine==='antigravity-cli')env.DUOLAWORK_MANAGED_CLI='1';
  let processTemp;
  if(['gemini-cli','antigravity-cli'].includes(r.engine))r.mcpServers=[{name:'hub_'+r.memberId.slice(-16),command:node,args:[path.join(here,'coding-mcp.mjs'),r.grantFile,this.file,r.memberId,r.executionSessionId||''],env:[]}];
  if(r.engine==='antigravity'){
   const provider=path.join(this.dataDir,'coding',r.memberId,'google'),temp=path.join(provider,'runtime-temp');await fs.mkdir(temp,{recursive:true,mode:0o700});processTemp=await fs.mkdtemp(path.join(temp,'run-'));
   const settings=path.join(provider,'antigravity-acp/settings.json');try{await fs.access(settings);}catch(e){if(e.code!=='ENOENT')throw e;await privateJson(settings,{auth:{type:'oauth-personal'}});}
   // Official ACP auth owns this separate profile. Never extract/copy IDE tokens.
   for(const key of Object.keys(env))if(['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_GENAI_USE_VERTEXAI','GEMINI_HOME','ANTIGRAVITY_HARNESS_PATH','BROWSER'].includes(key.toUpperCase()))delete env[key];
   Object.assign(env,{GEMINI_HOME:provider,AGY_ACP_FORCE_FILE_STORAGE:'1',ANTIGRAVITY_HARNESS_PATH:spec.harness,PYTHONUNBUFFERED:'1',TMPDIR:processTemp,ELECTRON_RUN_AS_NODE:'1'});
   const q=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";env.BROWSER=[node,path.join(here,'native-browser-helper.mjs')].map(q).join(' ')+' %s';
   r.mcpServers=[{name:'hub_'+r.memberId.slice(-16),command:node,args:[path.join(here,'coding-mcp.mjs'),r.grantFile,this.file,r.memberId,r.executionSessionId||''],env:[{name:'ELECTRON_RUN_AS_NODE',value:'1'}]}];
  }
  const options={engine:r.engine,cwd:r.cwd,command:spec.command,extraArgs:r.engine==='antigravity'?spec.args:[],env,permissionMode:r.permissionMode||'full',
   toolCall:async(name,args)=>{const matches=w=>!r.manualAssignments||(w.channelId?r.inFlight?.key===w.channelId:r.inFlight?.stepId===w.stepId);
    if(name==='claim_work')return claimNativeAssignment(client,{args,sessionId:r.executionSessionId||r.sessions?.[r.inFlight?.key]||r.chatBindings?.[r.inFlight?.key]?.sessionId,active:r.inFlight});
    if(name==='receive_messages')return receiveNativeConversation(client,{args,sessionId:r.executionSessionId||r.sessions?.[r.inFlight?.key],channelId:r.inFlight?.key?.startsWith('channel_')?r.inFlight.key:null});
    const result=await client.tool(name,args);if(name==='list_work'&&r.manualAssignments)result.work=result.work.filter(matches);if(['submit_work','post_message','stay_silent','ask_user'].includes(name)){r.lastReceiptAt=new Date().toISOString();await this.save();}return result;},
   onStopped:async()=>{if(processTemp)await fs.rm(processTemp,{recursive:true,force:true});},
   onApproval:request=>this.approve(r,request),onProgress:p=>{r.message='正在使用原生工具：'+safeError(p.name);},
   onAuthorization:url=>{if(!['https://accounts.google.com','https://auth.openai.com','https://auth0.openai.com'].includes(new URL(url).origin))return;r.status='waiting_login';r.authorizationUrl=url;r.message='请点击官方登录按钮完成这一次登录；后续自动复用';}
  };
  agent=this.agentFactory?this.agentFactory(options):new NativeAgent(options);this.agents.set(executionKey(r),agent);
  try{rememberAccount(r,await agent.initialize());delete r.authorizationUrl;if(!preserveStatus)r.status=r.inFlight?'working':'connecting';return agent;}catch(e){await agent.stop().catch(()=>{});this.agents.delete(executionKey(r));throw e;}
 }
 executionRecords(r){
  r.executions??={};const grouped=new Map();
  for(const [channelId,b] of Object.entries(r.chatBindings||{})){if(!grouped.has(b.sessionId))grouped.set(b.sessionId,{});grouped.get(b.sessionId)[channelId]=b;}
  return [...grouped].map(([sessionId,bindings])=>{
   const state=r.executions[sessionId]??={executionSessionId:sessionId,status:'idle',sessions:{},inFlight:null};
   Object.setPrototypeOf(state,r);state.chatBindings=bindings;state.verificationSessionId=null;return state;
  });
 }
 async syncExecutionBindings(r,chatBindings=r.chatBindings){
  const bindings=Object.entries(chatBindings||{}).map(([channelId,b])=>({channelId,sessionId:b.sessionId}));const fingerprint=JSON.stringify(bindings);
  if(!bindings.length||r.executionBindingsFingerprint===fingerprint)return;
  await this.client(r).api('/v2/self/execution-bindings',{method:'POST',body:{requestId:randomUUID(),bindings}});
  r.executionBindingsFingerprint=fingerprint;await this.save();
 }
 holdDispatch({memberId,channelId,sessionId}){
  const old=this.records[memberId]?.chatBindings?.[channelId]?.sessionId;
  const hold={memberId,channelId,sessions:new Set([old,sessionId].filter(Boolean))};this.dispatchHolds.add(hold);
  return ()=>this.dispatchHolds.delete(hold);
 }
 dispatchBlocked(r){
  if(!r.executionSessionId)return this.sessionOperations.has(r.memberId)||[...this.dispatchHolds].some(h=>h.memberId===r.memberId);
  return [...this.dispatchHolds].some(h=>h.memberId===r.memberId&&(h.sessions.has(r.executionSessionId)||Object.hasOwn(r.chatBindings||{},h.channelId)));
 }
 syncWatches(){
  if(!this.timer)return;
  for(const [id,stop] of this.watches)if(!this.records[id]?.enabled){stop();this.watches.delete(id);}
  for(const r of Object.values(this.records))if(r.enabled&&r.grantFile&&!this.watches.has(r.memberId))this.watches.set(r.memberId,subscribeNativeChanges(this.client(r),()=>{void this.tick().catch(()=>{});}));
 }
 async tickExecutions(r){
  if(r.inFlight||this.jobs.has(r.memberId))return;
  if(this.dispatching.has(r.memberId)){r.dispatchAgain=true;return;}
  this.dispatching.add(r.memberId);
  const launched=[];
  try{
  await this.syncExecutionBindings(r);
  const states=this.executionRecords(r);
  const {work}=await readNativeInbox(this.client(r));
  for(const state of states){const key=executionKey(state);if(this.jobs.has(key)||this.dispatchBlocked(state))continue;
   if(state.inFlight){const job=this.reconcileOriginal(state).finally(()=>this.jobs.delete(key));this.jobs.set(key,job);launched.push(job);continue;}
   if(!['idle','needs_review'].includes(state.status)||!work.some(w=>w.status==='ready'&&w.channelId&&state.chatBindings[w.channelId]&&(!state.lastFailure?.stepId||w.stepId!==state.lastFailure.stepId)))continue;
   const job=this.check(state,{work}).finally(()=>this.jobs.delete(key));this.jobs.set(key,job);launched.push(job);
  }
  }finally{this.dispatching.delete(r.memberId);if(r.dispatchAgain){delete r.dispatchAgain;if(!this.stopped)void this.tickExecutions(r).catch(()=>{});}}
  await Promise.allSettled(launched);
 }
 async tick(){
  if(this.stopped)return;
  this.syncWatches();
  // Hub may restart while the independently running native conversation keeps
  // working. Reconcile its durable delivery without starting or replaying it.
  const reconciled=new Set();
  await Promise.all(Object.values(this.records).filter(r=>r.enabled&&r.inFlight&&!this.jobs.has(r.memberId)&&!this.sessionOperations.has(r.memberId)).map(async r=>{
   reconciled.add(r.memberId);const job=this.reconcileOriginal(r);this.jobs.set(r.memberId,job);try{await job;}finally{this.jobs.delete(r.memberId);}
  }));
  if(this.stopped)return;
  for(const r of Object.values(this.records))if(r.status==='idle'&&!this.jobs.has(r.memberId)&&!this.sessionOperations.has(r.memberId)&&this.agents.has(r.memberId)&&Date.now()-(this.nativeUsedAt.get(r.memberId)||Date.parse(r.lastCompletedAt)||Date.now())>120000){const agent=this.agents.get(r.memberId);if(agent.busy||agent.rpc?.pending?.size)continue;this.agents.delete(r.memberId);await agent.stop().catch(()=>{});}
  for(const root of Object.values(this.records))for(const state of this.executionRecords(root)){const key=executionKey(state),agent=this.agents.get(key);if(agent&&state.status==='idle'&&!state.inFlight&&!this.jobs.has(key)&&Date.now()-(this.nativeUsedAt.get(key)||Date.now())>120000){this.agents.delete(key);await agent.stop().catch(()=>{});}}
  await Promise.all(Object.values(this.records).filter(r=>r.enabled&&!reconciled.has(r.memberId)&&!this.jobs.has(r.memberId)&&((r.executionReady&&Object.keys(r.chatBindings||{}).length&&(r.status==='idle'||this.sessionOperations.has(r.memberId)))||(r.status==='idle'&&!this.dispatchBlocked(r)))).map(async r=>{
   // Original interactive receivers settle on a later tick. Checking readiness
   // only after check() returns kept those verified accounts in the legacy
   // account-wide queue forever. Upgrade before dispatching their next work.
   if(!r.executionReady&&r.sourceReady&&Object.keys(r.chatBindings||{}).length){const status=await this.client(r).api('/v2/self/status').catch(()=>null);if(status?.complete){r.executionReady=true;await this.save();}}
   if(r.executionReady&&Object.keys(r.chatBindings||{}).length){await this.tickExecutions(r);return;}
   const job=this.check(r);this.jobs.set(r.memberId,job);try{await job;}finally{this.jobs.delete(r.memberId);}
   if(!r.inFlight&&r.status==='idle'&&r.sourceReady){const status=await this.client(r).api('/v2/self/status').catch(()=>null);if(status?.complete){r.executionReady=true;await this.save();}}
  }));
 }
 async settleOriginal(r,client){
  const flight=r.inFlight;if(!flight)return true;
  if(flight.stepId.startsWith('turn_')){
   let state;
   try{state=await client.api('/v2/self/conversation-state?turnId='+encodeURIComponent(flight.stepId));}
   catch(e){if(e.status!==404)throw e;r.status='needs_review';r.message='原通知记录暂不可核对，原工作保留，未重新执行';return false;}
   if(r.inFlight!==flight||this.stopped||!r.enabled)return false;
   if(['ready','active'].includes(state.status))return false;
   if(['done','silent'].includes(state.status)&&r.nativeLifecycle==='stop-hook-v1'&&r.managedNativePid){
    const sessionId=r.executionSessionId||r.chatBindings?.[flight.key]?.sessionId;
    if(sessionId&&r.managedNativeSessionIds?.includes(sessionId)){
     const native=await readNativeCompletion(this.dataDir,r.memberId,sessionId,flight.stepId);let alive=true;try{process.kill(r.managedNativePid,0);}catch{alive=false;}
     if(alive&&!native?.fullyIdle){r.status='working';r.message='已回复，原会话正在收尾';return false;}
    }
   }
   if(['done','silent'].includes(state.status)){const setup=await client.api('/v2/self/status');if(r.inFlight!==flight||this.stopped||!r.enabled)return false;r.inFlight=null;r.lastReceiptAt=state.completedAt||new Date().toISOString();r.lastCompletedAt=r.lastReceiptAt;r.status=setup.complete?'idle':'needs_review';r.message=!setup.complete?'原消息已结束，账号接入尚待完成':state.status==='silent'?'原消息已读，暂无补充':'原消息已回复，继续接收消息';}
   else {r.inFlight=null;r.status=['merged','removed'].includes(state.status)?'idle':'needs_review';r.message=state.reason||'原通知已结束；未自动重做';}
   return true;
  }
  const state=await client.api('/v2/self/status');if(r.inFlight!==flight)return false;
  r.inFlight=null;r.status=state.complete?'idle':'needs_review';r.message=state.complete?'原消息已结束，继续接收消息':'原消息已结束，账号接入尚待完成';
  if(state.complete){r.lastReceiptAt=new Date().toISOString();r.lastCompletedAt=r.lastReceiptAt;}return true;
 }
 async observeOriginal(r,client,now=Date.now()){
  const flight=r.inFlight;if(!flight?.stepId.startsWith('turn_'))return;
  const binding=r.chatBindings?.[flight.key],sessionId=r.nativeDeliveries?.[flight.stepId]?.sessionId||binding?.sessionId;
  const host=this.workingHostFor(r);if(!sessionId||!host.executionState)return;
  const previous=flight.observation;if(previous&&now-previous.checkedAt<15000)return;
  let state;try{state=(await host.executionState({sessionId})).state;}catch{state='unreachable';}
  if(r.inFlight!==flight||this.stopped||!r.enabled)return;
  const observation=flight.observation={state,checkedAt:now,since:previous?.state===state?previous.since:now};
  if(state==='running'){
   if(!previous?.reportedAt||now-previous.reportedAt>=60000){await client.api('/v2/self/conversation-state',{method:'POST',body:{requestId:randomUUID(),turnId:flight.stepId,state:'running'}});observation.reportedAt=now;}else observation.reportedAt=previous.reportedAt;
  }else if(['idle','unreachable'].includes(state)&&now-observation.since>=60000){
   if(state==='idle'&&binding?.workspace&&host.queue&&!flight.receiptRecovery){
    // Repair the receipt once in the same original session, without replaying
    // work. Persist before sending so a restart cannot create a retry loop.
    if(await this.settleOriginal(r,client))return;
    const q=v=>"'"+v.replaceAll("'","'\"'\"'")+"'";
    const helper=[process.execPath,path.join(here,'coding-session-tools.mjs'),this.file,r.memberId,flight.key].map(q).join(' ');
    flight.receiptRecovery={attemptedAt:now,status:'sending'};await this.save();
    const prompt='DuolaWork collaboration '+flight.stepId+'\n本轮回执核对：原会话已空闲，但这条已领取消息还没有正式回传。不要重新执行已做的操作，不要领取其他工作。使用原 Hub 工具 '+helper+' 加 claim_step '+flight.stepId+' 核对本轮真实要求与已有结果。若已完成，用 post_message 携带这个正确 turnId 回传实际结果；若已在群内回复，用 stay_silent 携带这个 turnId 说明对应消息依据；若无法完成，直接回复具体阻塞。不要声称未验证的工作已完成。仅核对并收尾此条，后续消息由连接器继续投递。';
    try{await host.queue({sessionId,workspace:binding.workspace,prompt});flight.receiptRecovery.status='sent';r.message='正在自动核对上一条回复，后续消息已保留';}
    catch(e){flight.receiptRecovery.status='uncertain';r.message=safeError(e);}
    observation.since=now;await this.save();return;
   }
   await client.api('/v2/self/conversation-state',{method:'POST',body:{requestId:randomUUID(),turnId:flight.stepId,state:state==='idle'?'ended':'unreachable'}});
   await this.settleOriginal(r,client);
  }
 }
 async reconcileOriginal(r){
  const flight=r.inFlight;
  try{
   const client=this.client(r),{work}=await client.tool('list_work');
   if(this.stopped||!r.enabled||r.inFlight!==flight)return;
   const pending=work.find(w=>w.stepId===flight.stepId),delivery=r.nativeDeliveries?.[flight.stepId];
   if(pending?.status==='ready'&&flight.deliveryPhase==='received'&&!delivery){await this.check(r,{recover:true});return;}
   if(!pending){
    await this.settleOriginal(r,client);
   }else if(pending.status==='claimed'){
    r.status='working';r.message='原会话正在处理消息';await this.observeOriginal(r,client);
   }else if(delivery?.status==='sent'){
    r.status='syncing';r.message='消息已交给原会话，等待实际领取';
   }else if(delivery?.status==='queued'||delivery?.sessionId&&r.engine==='codex'&&await this.workingHostFor(r).isQueued?.({sessionId:delivery.sessionId,workMarker:flight.stepId})){
    delivery.status='queued';r.status='syncing';r.message='消息已排进原会话，等待当前工作完成；不需要重新连接';
   }else{
    r.status='needs_review';r.message='上条消息的投递结果待确认，原会话保留，未重复发送';
   }
  }catch(e){r.status=[401,403].includes(e.status)?'needs_review':'syncing';r.message=safeError(e);}
  await this.save();
 }
 async check(r,{recover=false,work:providedWork}={}){
  try{
   const client=this.client(r);if(!r.enabled||this.stopped||this.dispatchBlocked(r))return;
   const {work}=providedWork?{work:providedWork}:await readNativeInbox(client),first=recover?work.find(w=>w.stepId===r.inFlight?.stepId):work.find(w=>w.status==='ready'&&(!r.lastFailure?.stepId||w.stepId!==r.lastFailure.stepId)&&(!(r.manualAssignments||r.executionSessionId)||(w.channelId?r.chatBindings?.[w.channelId]:r.verificationSessionId)));
   if(this.dispatchBlocked(r))return;
   if(!first){r.inFlight=null;r.status='idle';r.message='已检查原回执，继续接收消息';await this.save();return;}
   const key=first.channelId||first.projectId||'verification';const binding=r.chatBindings?.[key]||(!first.channelId&&r.manualAssignments?Object.values(r.chatBindings||{}).find(b=>b.sessionId===r.verificationSessionId):null);r.inFlight={at:new Date().toISOString(),stepId:first.stepId,key,delivery:first.delivery,deliveryPhase:'received'};r.lastRunAt=r.inFlight.at;r.status='working';r.message='消息已收到，正在准备原工作对话';await this.save();
   await deliveryReceipt(client,first,binding?.sessionId);
   r.inFlight.deliveryPhase='preparing';await this.save();
   if(r.engine==='antigravity-cli'&&binding){
    const host=this.workingHostFor(r);
    if(await host.attached(binding.sessionId)){
     // The original interactive process is authoritative. Discard our idle
     // cache before using its queue, so no second context can overwrite it.
     await this.agents.get(executionKey(r))?.stop();this.agents.delete(executionKey(r));
     await this.runExisting(r,first,binding,client);return;
    }
    await host.assertAvailable(binding.workspace);
   }
   if(binding?.mode==='native-existing'&&r.engine!=='antigravity-cli'){await this.runExisting(r,first,binding,client);return;}
   if(r.engine==='gemini-cli'&&binding)await this.workingHostFor(r).assertAvailable(binding.workspace);
   const agent=await this.prepareNative(r,client),tools=await client.tools();this.hubToolNames.set(r.memberId,new Set(tools.map(t=>t.name)));const session=await agent.session({id:binding?.sessionId||(!first.channelId&&r.manualAssignments?r.verificationSessionId:r.sessions[key]),cwd:binding?.workspace||r.cwd,tools,mcpServers:r.mcpServers||[]});r.sessions[key]=session.id;await this.save();
   const quote=v=>"'"+v.replaceAll("'","'\"'\"'")+"'";
   const bindingChannel=first.channelId||Object.entries(r.chatBindings||{}).find(([,b])=>b.sessionId===r.verificationSessionId)?.[0];
   const toolFallback=bindingChannel?['node',path.join(here,'coding-session-tools.mjs'),this.file,r.memberId,bindingChannel].map(quote).join(' '):null;
   const fallbackInstruction=toolFallback?' 若原会话缓存了旧工具列表而缺少本次所需工具，不换会话、不扫描凭证。直接使用本环境连接器：'+toolFallback+' list_tools 查看最新工具；'+toolFallback+' call <工具名> <JSON参数> 调用。这是同一成员、同一群的已授权工具入口。':'';
   const prompt=`你是 Agent Hub 成员 ${r.memberId}，使用你自己的原生工具、模型、规则和本会话记忆。Hub 工具来自${r.engine==='codex'?' hub_ 前缀动态工具':' MCP hub_'+r.memberId.slice(-16)}。直接调用已提供的工具，不需要先通过终端扫描工具目录。常用签名：list_work({})；claim_work({requestId,stepId,channelId?})；post_message({requestId,channelId,turnId,body,mentions?})；submit_work({requestId,attemptId,lease,items:[{title,body}]} )。本轮只处理 stepId=${first.stepId}，channelId=${first.channelId||'无'}。直接调用 claim_work，使用新的 requestId 和 ${JSON.stringify({stepId:first.stepId,...(first.channelId?{channelId:first.channelId}:{})})}；领取结果即真实工作，无需先查 list_work。${recover?'上次运行中断：检查原领取和已经完成的操作，沿用原 attemptId/lease 继续未完成部分，不要重做副作用；不清楚时回报具体问题。':'用 claim_work 领取并遵循完整指令。'}普通群消息直接沟通，不擅自建任务或文档。使用所需原生工具完成后，必须调用 post_message 或 submit_work 回到这个 Hub 会话；只在原生终端输出不算回群。验证任务严格提交要求的内容，不自称验证通过。不轮询空跑、不改提供方配置、不替其他成员领取、不回显凭证。${fallbackInstruction}`;
   if(r.engine==='antigravity-cli'){r.managedNativePid=agent.rpc.child?.pid;r.managedNativeSessionIds=[...agent.sessions.keys()];await this.save();}
   r.inFlight.deliveryPhase='dispatching';await this.save();
   const result=await agent.run({session,prompt:prompt+' '+CONTINUE_PRIMARY_WORK,onStarted:()=>deliveryReceipt(client,first,session.id,'started').catch(()=>{}),onPublicOutput:()=>deliveryReceipt(client,first,session.id,'public_output').catch(()=>{})});if(result.sessionId){r.sessions[key]=result.sessionId;if(binding)binding.sessionId=result.sessionId;}
   const remaining=await client.tool('list_work');
   if(r.engine==='antigravity-cli'&&r.nativeLifecycle==='stop-hook-v1')await this.waitForNativeReceipt(r,client,first,agent,{sessionId:session.id});
   else if(remaining.work.some(w=>w.stepId===first.stepId)){
    // ACP may end the foreground turn while a native background command keeps
    // running and resumes the same conversation later. Keep its process and MCP
    // scope alive until the real Hub receipt; never start a second model turn.
    if(r.engine==='antigravity-cli'&&remaining.work.some(w=>w.stepId===first.stepId&&w.status==='claimed'))await this.waitForNativeReceipt(r,client,first,agent);
    else throw new Error('原生运行结束，但 Hub 未收到该工作回复；原会话保留，请继续检查');
   }
   const status=await client.api('/v2/self/status');r.lastReceiptAt=new Date().toISOString();r.lastCompletedAt=r.lastReceiptAt;r.inFlight=null;r.status='idle';r.message=status.complete?'已接入，正在后台接收消息':'本轮已回传，连接验证仍待完成';await this.save();
  }catch(e){if(r.inFlight?.deliveryPhase==='received'&&(isNetworkError(e)||e.name==='HubNetworkError'||[502,503,504].includes(e.status))){r.receivedDelivery=r.inFlight;r.inFlight=null;r.status='idle';r.message='接收回执正在自动补传，原消息已保存，尚未启动工作';await this.save();return;}r.message=safeError(e);if(e.code!=='native_queued')r.lastFailure={stepId:r.inFlight?.stepId,message:r.message,at:new Date().toISOString()};if(e.code==='native_queued')r.status='syncing';else if(r.inFlight||[401,403].includes(e.status))r.status='needs_review';
   // A managed native execution ending in error is not a successful reply.
   if(r.inFlight?.stepId.startsWith('turn_')&&!r.nativeDeliveries?.[r.inFlight.stepId]&&e.code!=='native_queued')try{await this.client(r).api('/v2/self/conversation-state',{method:'POST',body:{requestId:randomUUID(),turnId:r.inFlight.stepId,state:'unreachable'}});}catch{}
   await this.save();}
 }
 async waitForNativeReceipt(r,client,first,agent,{interval=1500,timeout=20*60*1000,sessionId=r.executionSessionId,readCompletion=readNativeCompletion}={}){
  const deadline=Date.parse(r.inFlight?.at||new Date().toISOString())+timeout;
  r.message='原 Agent 仍在继续工作，等待实际回复';await this.save();
  while(r.enabled&&Date.now()<deadline){
   const state=await client.api('/v2/self/conversation-state?turnId='+encodeURIComponent(first.stepId));
   const replied=['done','silent'].includes(state.status),native=r.nativeLifecycle==='stop-hook-v1'?await readCompletion(this.dataDir,r.memberId,sessionId,first.stepId):null;
   if(replied&&(r.nativeLifecycle!=='stop-hook-v1'||native?.fullyIdle))return;
   if(replied&&r.message!=='已回复，原会话正在收尾'){r.message='已回复，原会话正在收尾';await this.save();}
   if(!replied&&!['ready','active'].includes(state.status))throw Error(state.reason||'原通知尚未完成，执行记录保留');
   if(!replied&&native?.fullyIdle)throw Error('原生执行已结束，但尚未回群；原结果保留，未自动重做');
   if(agent.rpc?.closed)throw Error('原生进程已关闭，执行记录保留');
   // Shutdown drains claimed native background work too. No new turn is started.
   await new Promise(resolve=>setTimeout(resolve,interval));
  }
  throw Error('原 Agent 尚未回传结果，原会话与已执行工作保留');
 }
 async assign(input){
  const {memberId}=input,release=this.holdDispatch(input),prior=this.sessionOperations.get(memberId)||Promise.resolve();
  // Reserve synchronously: empty polling and idle cleanup cannot race a UI choice.
  const operation=prior.catch(()=>{}).then(async()=>{
   const r=this.records[memberId];for(const id of new Set([input.sessionId,r?.chatBindings?.[input.channelId]?.sessionId].filter(Boolean)))await this.jobs.get(memberId+':'+id);if([input.sessionId,r?.chatBindings?.[input.channelId]?.sessionId].some(id=>r?.executions?.[id]?.inFlight))throw Error('这段工作对话正在处理消息，请等它回复后再更换');if(r?.inFlight)throw Error('这个 Agent 正在处理消息，请等它回复后再更换对话。已有工作会继续。');
   await this.jobs.get(memberId);
   if(r?.inFlight)throw Error('这个 Agent 正在处理消息，请等它回复后再更换对话。已有工作会继续。');
   try{return await this.assignSession(input);}
   finally{this.nativeUsedAt.set(memberId,Date.now());if(r?.enabled&&r.sourceReady&&!r.inFlight){r.status='idle';r.message='账号已连接，继续接收消息';await this.save();}}
  });
  this.sessionOperations.set(memberId,operation);
  try{return await operation;}finally{release();if(this.sessionOperations.get(memberId)===operation)this.sessionOperations.delete(memberId);}
 }
 async assignSession({memberId,channelId,sessionId,mode='new',workspace,title,prepareOnly=false}){
  const r=this.records[memberId];if(!r?.enabled||!r.sourceReady&&r.status!=='idle')throw Error('请先连接这个 Agent 的账号');
  if(!['existing','new'].includes(mode))throw Error('无效的会话选项');
  r.chatBindings??=Object.fromEntries(Object.entries(r.sessions||{}).filter(([id])=>id!=='verification').map(([id,s])=>[id,{sessionId:s,workspace:r.cwd,title:'原工作会话',mode:'existing',migrated:true}]));
  const client=this.client(r);let selected;
  if(mode==='existing'){
   selected=Object.values(r.chatBindings).find(b=>b.sessionId===sessionId);
   if(!selected){const host=this.workingHostFor(r);if(r.engine==='antigravity')await host.start({launch:false});const native=(r.engine==='antigravity-cli'?await this.cliSessionOptions(r):await host.sessions()).items.find(s=>s.id===sessionId);if(native){for(const other of Object.values(this.records))if(other.memberId!==memberId&&other.enabled&&Object.values(other.chatBindings||{}).some(b=>b.sessionId===sessionId))throw Error('此原生会话已有另一位工作成员');selected={sessionId:native.id,title:native.title,workspace:native.workspace,mode:['gemini-cli','antigravity-cli'].includes(r.engine)?'existing':'native-existing',source:native.source};}}
   if(!selected)throw Error('请选择这位成员已有的工作会话；不会读取其他成员的上下文');
  }else{
   if(r.creationPending)throw Error('上次会话创建结果待确认，请先查看已有会话，未重复创建');
   const agent=await this.prepareNative(r,client),tools=await client.tools();
   const cwd=workspace?await fs.realpath(workspace):path.join(this.dataDir,'coding',memberId,'chats',channelId);await fs.mkdir(cwd,{recursive:true,mode:0o700});
   r.creationPending=true;await this.save();let session;
   try{session=await agent.session({cwd,tools,mcpServers:r.mcpServers||[]});}catch(error){if(typeof error.code==='number'){r.creationPending=false;await this.save();}throw error;}
   r.creationPending=false;selected={sessionId:session.id,workspace:cwd,title:title||'新对话',mode:'new',createdAt:new Date().toISOString()};
  }
  if(prepareOnly)return {...selected};
  return this.commitBinding({memberId,channelId,binding:selected});
 }
 async commitBinding({memberId,channelId,binding:selected,verify=true}){
  const r=this.records[memberId],client=this.client(r);
  const next={...r.chatBindings,[channelId]:{...selected}};await this.syncExecutionBindings(r,next);
  r.manualAssignments=true;r.sourceReady=true;r.chatBindings=next;r.sessions[channelId]=selected.sessionId;r.verificationSessionId??=selected.sessionId;await this.save();
  if(verify){const status=await client.api('/v2/self/status');if(!status.complete&&!r.proofRunId){const proof=await client.api('/v2/self/check',{method:'POST',body:{requestId:randomUUID()}});r.proofRunId=proof.runId||proof.result?.runId;await this.save();}}
  return r.chatBindings[channelId];
 }
 async cliSessionOptions(r){
  const agent=await this.prepareNative(r,this.client(r),{preserveStatus:true}),items=[];let cursor;const seen=new Set();
  do{const page=await agent.rpc.call('session/list',cursor?{cursor}:{});for(const s of page.sessions||[]){if(s.sessionId&&s.cwd)items.push({id:s.sessionId,title:s.title||'未命名对话',workspace:s.cwd,updatedAt:s.updatedAt,source:'antigravity-cli',mode:'existing'});}cursor=page.nextCursor;if(cursor&&seen.has(cursor))throw Error('原对话列表分页异常');seen.add(cursor);}while(cursor);
  const live=(await this.workingHostFor(r).sessions()).items;
  return{items:[...new Map([...items,...live].map(s=>[s.id,s])).values()],projects:[]};
 }
 async sessionOptions(memberId){const r=this.records[memberId];let native=[],projects=[],existingHint='';if(r)try{const host=this.workingHostFor(r);if(r.engine==='antigravity')await host.start({launch:false});({items:native,projects=[]}=r.engine==='antigravity-cli'?await this.cliSessionOptions(r):await host.sessions());}catch(e){existingHint='原项目暂不可用：'+safeError(e);}
  const owned=Object.values(r?.chatBindings||{}).map(b=>({id:b.sessionId,title:b.title||'原工作会话',workspace:b.workspace,mode:b.mode,createdAt:b.createdAt}));const otherSessions=new Set(Object.values(this.records).filter(v=>v.memberId!==memberId&&v.enabled).flatMap(v=>Object.values(v.chatBindings||{}).map(b=>b.sessionId)));return {existingHint,projects,items:[...new Map([...owned,...native.filter(s=>!otherSessions.has(s.id))].map(s=>[s.id,s])).values()]};}
 async runExisting(r,first,binding,client){
  r.inFlight.deliveryPhase='dispatching';await this.save();
  const key=first.channelId||Object.entries(r.chatBindings).find(([,b])=>b.sessionId===r.verificationSessionId)?.[0];if(!key)throw Error('请选择负责连接验证的工作会话');
  r.nativeDeliveries??={};const delivery=r.nativeDeliveries[first.stepId];
  if(delivery&&delivery.status!=='sent')throw Error('原会话发送结果待确认，请查看原会话；未重复执行');
  const q=v=>"'"+v.replaceAll("'","'\"'\"'")+"'",helper=['node',path.join(here,'coding-session-tools.mjs'),this.file,r.memberId,key].map(q).join(' ');
  const prompt='DuolaWork collaboration '+first.stepId+'\nHub 有一条发给你这个原工作会话的消息，保留原项目、模型、工具和记忆。Hub 工具命令：'+helper+'。先运行命令加 claim_step '+first.stepId+'，按领取返回的真实指令完成；只处理这个工作。其他工具用 call <工具名> <JSON>，定义可用 list_tools 查询。普通消息必须用 post_message({requestId,channelId,turnId,body,mentions?}) 回到原 Hub 聊天；验证用 submit_work，不能只在原界面回答。'+CONTINUE_PRIMARY_WORK+'不扫描登录资料、不读其他会话、不自动创建任务文档或分工。';
  const stopWatching=await this.workingHostFor(r).watch?.({sessionId:binding.sessionId,workMarker:first.stepId,onApproval:a=>this.approve(r,a)});
  try{
  if(!delivery){r.nativeDeliveries[first.stepId]={status:'sending',sessionId:binding.sessionId};await this.save();
  try{await this.workingHostFor(r).queue({sessionId:binding.sessionId,workspace:binding.workspace,prompt,isCompleted:async()=>{if(!first.stepId.startsWith('turn_'))return false;const state=await client.api('/v2/self/conversation-state?turnId='+encodeURIComponent(first.stepId));return ['done','silent'].includes(state.status);}});r.nativeDeliveries[first.stepId].status='sent';await this.save();await deliveryReceipt(client,first,binding.sessionId,'accepted').catch(()=>{});}catch(e){r.nativeDeliveries[first.stepId].status=e.code==='native_queued'?'queued':'uncertain';await this.save();throw e;}}
  const deadline=Date.now()+20*60000;
  while(r.enabled&&!this.stopped&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,1500));const {work}=await client.tool('list_work');const pending=work.find(w=>w.stepId===first.stepId);
   if(!pending){if(await this.settleOriginal(r,client)){await this.save();return;}}
   else if(pending.status==='claimed'){const observation=r.inFlight?.observation;await this.observeOriginal(r,client);if(observation!==r.inFlight?.observation)await this.save();if(!r.inFlight)return;}
  }
  throw Error('尚未收到原工作会话回传，原工作和消息保留，未重复发送');
  }finally{await stopWatching?.();}
 }
 approve(r,{engine,method,params,sessionId}){
  const acp=['antigravity','antigravity-cli','gemini-cli'].includes(engine),supported=acp?method==='session/request_permission':['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput'].includes(method);
  if(!supported)throw new Error('原生 Agent 请求暂未支持的交互：'+method+'；未自动批准');
  if(acp&&sessionId!==params.sessionId)throw new Error('原生批准请求的会话不匹配');
  if(r.permissionMode==='full'&&method!=='item/tool/requestUserInput'){
   if(acp){const option=params.options?.find(o=>o.kind==='allow_once');if(option)return Promise.resolve({outcome:{outcome:'selected',optionId:option.optionId}});}
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
 async pause({memberId}){const r=this.records[memberId];if(!r)throw new Error('本机没有此成员');if(this.sessionOperations.has(memberId))throw new Error('正在连接对话，请稍等完成后再调整');if(r.inFlight||this.jobs.has(memberId)||Object.values(r.executions||{}).some(s=>s.inFlight))throw new Error('成员还在处理请求，请等本轮结束');r.enabled=false;r.status='paused';r.message='后台接收已暂停，登录与会话保留';await this.agents.get(memberId)?.stop();this.agents.delete(memberId);await this.save();return this.status();}
 async disconnect(memberId){if(this.sessionOperations.has(memberId))throw new Error('正在连接对话，请稍等完成后再解除连接');const r=this.records[memberId];if(!r)return;r.enabled=false;r.status='disconnected';r.message='Hub 连接已解除，原生登录和会话历史保留';delete r.authorizationUrl;for(const [id,a] of this.approvals)if(a.memberId===memberId){clearTimeout(a.timer);a.reject(new Error('Hub 连接已解除'));this.approvals.delete(id);}await this.agents.get(memberId)?.stop();this.agents.delete(memberId);for(const [key,agent]of this.agents)if(key.startsWith(memberId+':')){await agent.stop();this.agents.delete(key);}await Promise.allSettled([...this.jobs].filter(([key])=>key===memberId||key.startsWith(memberId+':')).map(([,job])=>job));r.status='disconnected';r.message='Hub 连接已解除，原生登录和会话历史保留';await this.save();}
 async permissions({memberId,mode}){if(this.sessionOperations.has(memberId))throw new Error('正在连接对话，请稍等完成后再调整权限');const r=this.records[memberId];if(!r||!['full','ask'].includes(mode))throw new Error('权限选项不正确');if(r.inFlight||Object.values(r.executions||{}).some(s=>s.inFlight))throw new Error('本轮工作结束后即可调整权限');await this.jobs.get(memberId);if(r.inFlight||Object.values(r.executions||{}).some(s=>s.inFlight))throw new Error('本轮工作结束后即可调整权限');r.permissionMode=mode;for(const [key,agent]of this.agents)if(key===memberId||key.startsWith(memberId+':')){await agent.stop();this.agents.delete(key);}await this.save();return this.status();}
 async resume({memberId}){const r=this.records[memberId];if(!r)throw new Error('本机没有此成员');if(this.jobs.has(memberId))return this.status();r.enabled=true;for(const state of this.executionRecords(r))if(state.inFlight&&state.status==='needs_review'&&!this.jobs.has(executionKey(state))){const key=executionKey(state),job=this.check(state,{recover:true}).finally(()=>this.jobs.delete(key));this.jobs.set(key,job);}if(r.inFlight){this.launch(r,()=>this.check(r,{recover:true}));}else if(['disconnected','needs_review'].includes(r.status)){return this.connect({memberId,engine:r.engine});}else{r.status='idle';r.message='继续接收消息';await this.save();}return this.status();}
 async stop(){this.stopped=true;for(const stop of this.watches.values())stop();this.watches.clear();clearInterval(this.timer);this.timer=null;for(const a of this.approvals.values()){clearTimeout(a.timer);a.reject(new Error('本机执行端停止，未批准操作'));}this.approvals.clear();await Promise.allSettled([...this.agents.values()].map(a=>a.stop()));this.agents.clear();await Promise.allSettled([...this.jobs.values()]);await this.save();}
}
