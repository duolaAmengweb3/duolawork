import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {AntigravityNative,AntigravitySidecar} from './antigravity-sidecar.mjs';
import {privateJson} from './storage.mjs';
import {recordNativeCompletion} from './native-completion.mjs';

const entry=fileURLToPath(import.meta.url),uuid=/^[a-f0-9-]{36}$/i;
const execute=promisify(execFile);
const read=file=>fs.readFile(file,'utf8').then(JSON.parse);
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const bridgeDir=base=>path.join(base,'native-bridges','antigravity-cli');
const original=env=>!env.DUOLAWORK_MANAGED_CLI&&uuid.test(env.ANTIGRAVITY_CONVERSATION_ID||'')&&!!env.ANTIGRAVITY_LS_ADDRESS&&Object.hasOwn(env,'ANTIGRAVITY_CSRF_TOKEN')&&path.basename(env.ANTIGRAVITY_APP_DATA_DIR||'')==='antigravity-cli';

// Executed by the ORIGINAL CLI, not by an unauthenticated second instance.
// Native credentials remain inherited process memory. Only our loopback token
// and non-secret native identity are persisted.
export async function attachCurrentCli(base,{env=process.env}={}){
 if(!original(env))return{attached:false};
 const sessionId=env.ANTIGRAVITY_CONVERSATION_ID,dir=bridgeDir(base),file=path.join(dir,sessionId+'.json');
 const launchKey=createHash('sha256').update(env.ANTIGRAVITY_LS_ADDRESS+':'+sessionId).digest('hex');
 await fs.mkdir(dir,{recursive:true,mode:0o700});
 try{const old=await read(file);if(old.launchKey===launchKey){const health=await bridgeCall(file,'/health');if(health.ready)return{attached:true,sessionId};}}catch{}
 const lock=file+'.lock';try{await fs.mkdir(lock,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;if(Date.now()-(await fs.stat(lock)).mtimeMs<15000)return{attached:false,starting:true};await fs.rm(lock,{recursive:true});return attachCurrentCli(base,{env});}
 try{
  await privateJson(file,{controlToken:randomBytes(32).toString('base64url'),bindings:[],deliveries:{},sessionId,launchKey,launchAt:Date.now()});
  const child=spawn(process.execPath,[entry,'serve',base,sessionId],{detached:true,stdio:'ignore',env});child.unref();
  const deadline=Date.now()+2000;while(Date.now()<deadline){try{if((await bridgeCall(file,'/health')).ready)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  return{attached:true,sessionId};
 }finally{await fs.rm(lock,{recursive:true,force:true});}
}
export async function bridgeCall(file,route,body){
 const s=await read(file),url=new URL(s.controlUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw Error('原会话连接尚未就绪');
 const response=await fetch(new URL(route,url),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+s.controlToken,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(body?25000:2000)});
 const result=await response.json();if(!response.ok)throw Error(result.error||'原会话连接暂不可用');return result;
}
export class AntigravityCliHost {
 constructor(base){this.base=base;}
 file(id){if(!uuid.test(id||''))throw Error('无效的原会话');return path.join(bridgeDir(this.base),id+'.json');}
 async sessions(){
  let names;try{names=await fs.readdir(bridgeDir(this.base));}catch(e){if(e.code==='ENOENT')return{items:[]};throw e;}
  const rows=await Promise.all(names.filter(n=>uuid.test(n.replace(/\.json$/,''))).map(async n=>{try{return(await bridgeCall(path.join(bridgeDir(this.base),n),'/sessions')).items.map(s=>({...s,source:'antigravity-cli',runtime:'cli',mode:'native-existing'}));}catch{return[];}}));
  return{items:rows.flat()};
 }
 async attached(id){try{return!!(await bridgeCall(this.file(id),'/health')).ready;}catch{return false;}}
 async executionState({sessionId}){
  const session=(await bridgeCall(this.file(sessionId),'/sessions')).items.find(s=>s.id===sessionId);
  if(!session)return{state:'unreachable'};
  // Missing status and permission waits are not proof that native work ended.
  if(session.nativeStatus==='CASCADE_RUN_STATUS_IDLE'&&session.running===false)return{state:'idle'};
  return{state:session.running===true?'running':'unknown'};
 }
 async assertAvailable(workspace){
  const {stdout}=await execute('ps',['-ax','-o','pid=,args=']);
  for(const line of stdout.split('\n')){
   const m=line.match(/^\s*(\d+)\s+(.+)$/);
   if(!m||!/(?:\/|\s)(?:agy|antigravity)(?:\s|$)/.test(m[2])||/\bacp\b|\bagentapi\b/.test(m[2]))continue;
   let cwd;
   try{if(process.platform==='linux')cwd=await fs.readlink('/proc/'+m[1]+'/cwd');else{const r=await execute('/usr/sbin/lsof',['-a','-p',m[1],'-d','cwd','-Fn']);cwd=r.stdout.split('\n').find(l=>l.startsWith('n'))?.slice(1);}}catch{try{process.kill(Number(m[1]),0);}catch(e){if(e.code==='ESRCH')continue;}throw Error('原 Antigravity 终端状态暂未确认，消息保留，未另开同一对话');}
   if(cwd&&await fs.realpath(cwd)===await fs.realpath(workspace))throw Error('原 Antigravity 终端仍在打开，但接收连接暂未就绪。请在原终端继续一条消息以恢复连接；原工作和对话保留。');
  }
 }
 async queue({sessionId,workspace,prompt}){
  const deadline=Date.now()+20*60000;
  while(Date.now()<deadline){const result=await bridgeCall(this.file(sessionId),'/queue',{sessionId,workspace,prompt});if(result.sent)return;if(!result.waiting)throw Error('原终端没有确认接收，未重复发送');await new Promise(r=>setTimeout(r,1500));}
  throw Error('原终端仍在工作，消息保留，未打断当前任务');
 }
}

export async function installCliAttachment(base,{home=os.homedir(),env=process.env}={}){
 const namespace='duolawork-native-cli',file=path.join(home,'.gemini','config','hooks.json');
 let before=null;try{before=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 const config=before?JSON.parse(before):{},prior=config[namespace];
 const loader=path.join(base,'native-hook.mjs'),command=[process.execPath,loader].map(quote).join(' ');
 // One OS login profile represents one original account; another member must
// not silently borrow it. Different users/profiles/machines are independent.
 if(prior&&(prior.SessionStart?.[0]?.command||prior.SessionStart?.[0]?.hooks?.[0]?.command)!==command)throw Error('这个 Antigravity CLI 环境已经属于另一成员。请将另一账号的接入说明发到它自己的环境，原连接未改变。');
 await fs.mkdir(base,{recursive:true,mode:0o700});
  await fs.writeFile(loader,`import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';const base=${JSON.stringify(base)};try{const p=JSON.parse(await fs.readFile(path.join(base,'program.json')));const m=await import(pathToFileURL(path.resolve(path.dirname(p.entry),'../../local/antigravity-cli-bridge.mjs')));await m.cliHookMain(base);}catch{console.log('{"decision":"allow"}');}\n`,{mode:0o600});
 const hook={type:'command',command,timeout:5};
 config[namespace]={SessionStart:[hook],PreInvocation:[hook],PreToolUse:[{matcher:'*',hooks:[hook]}],Stop:[hook]};
 if(JSON.stringify(config)!==JSON.stringify(before?JSON.parse(before):{})){
  await fs.mkdir(path.dirname(file),{recursive:true});if(before)await fs.writeFile(path.join(base,'native-hooks-before.json'),before,{mode:0o600});
  const current=await fs.readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(current!==before)throw Error('原生配置刚有变化，未覆盖，请重新执行同一接入说明');
  await privateJson(file,config);
 }
 return attachCurrentCli(base,{env});
}
export async function cliHook(base,input,{env=process.env}={}){
 if(original(env))await attachCurrentCli(base,{env});
 const nativeDir=env.ANTIGRAVITY_APP_DATA_DIR||path.join(os.homedir(),'.gemini/antigravity-cli');
 // Global hooks are shared with the desktop. Only this CLI conversation may
 // attach itself; no desktop session or other account is silently connected.
 if(!await isCliTranscript(input,nativeDir))return input.toolCall?{decision:'allow'}:{};
 const bootstrap=[process.execPath,path.join(base,'native-hook.mjs'),'--attach'].map(quote).join(' ');
 const records=await read(path.join(base,'native-coding.json')).catch(()=>({}));
 const executions=Object.values(records).flatMap(r=>[r,...Object.values(r.executions||{}).map(s=>({...r,...s}))]);
 const managed=executions.some(r=>{
  if(!r.managedNativeSessionIds?.includes(input.conversationId)||!r.managedNativePid)return false;
  try{process.kill(r.managedNativePid,0);return true;}catch{return false;}
 });
 if(managed&&env.DUOLAWORK_MANAGED_CLI==='1'&&typeof input.fullyIdle==='boolean'){
  for(const r of executions)if(r.engine==='antigravity-cli'&&r.enabled&&r.inFlight?.stepId&&r.managedNativeSessionIds?.includes(input.conversationId)&&await nativeHubScope(input,r.inFlight.stepId,{ANTIGRAVITY_APP_DATA_DIR:nativeDir},{managedMemberId:r.memberId,channelId:r.inFlight.key})){
   await recordNativeCompletion(base,{memberId:r.memberId,sessionId:input.conversationId,stepId:r.inFlight.stepId,fullyIdle:input.fullyIdle,terminationReason:input.terminationReason});break;
  }
  return {};
 }
 if(!input.toolCall){
  if(managed||!await read(path.join(base,'runtime.json')).catch(()=>null))return{};
  if(await new AntigravityCliHost(base).attached(input.conversationId))return{};
  const attempts=path.join(bridgeDir(base),input.conversationId+'.bootstrap.json');
  const prior=await read(attempts).catch(()=>({}));if(Date.now()-(prior.at||0)<30000)return{};
  await privateJson(attempts,{at:Date.now()});
  return{injectSteps:[{systemMessage:{systemMessage:'DuolaWork 已由用户接入这个账号。原终端刚启动，请先用 run_command 原样运行一次：'+bootstrap+'。这是恢复本对话接收连接的本机命令；不需要重新登录，不改变项目，不发送群消息。执行后继续用户原来的请求；失败时正常处理用户请求，不循环重试。'}}]};
 }
 if(!managed&&input.toolCall.name==='run_command'&&input.toolCall.args?.CommandLine?.trim()===bootstrap)return{decision:'auto_approve',reason:'恢复用户已接入的原终端连接'};
 if(input.toolCall.name==='run_command'){
  const names=await fs.readdir(path.join(base,'session-links')).catch(()=>[]);
  for(const name of names.filter(n=>n.endsWith('.dispatch.json'))){
   const d=await read(path.join(base,'session-links',name));
   if(d.sessionId===input.conversationId&&['sending','sent'].includes(d.status)&&Date.now()-Date.parse(d.at)<86400000&&input.toolCall.args?.CommandLine?.trim()===d.command)return{decision:'auto_approve',reason:'确认用户刚刚指定的原对话关联'};
  }
 }
 // Full authorization applies only to an actual Hub dispatch in this exact
 // native conversation. A user's own turns retain their original policies.
 for(const r of executions){
  if(r.engine!=='antigravity-cli'||!r.enabled||r.permissionMode!=='full')continue;
  // ACP background continuations can request terminal tools after prompt() has
  // returned. Keep the already granted policy scoped to this managed Hub turn,
  // including when the native foreground approval handler is no longer active.
  if(env.DUOLAWORK_MANAGED_CLI==='1'&&r.inFlight?.stepId&&r.managedNativeSessionIds?.includes(input.conversationId)&&r.managedNativePid){
   let alive=true;try{process.kill(r.managedNativePid,0);}catch{alive=false;}
   if(alive&&await nativeHubScope(input,r.inFlight.stepId,{ANTIGRAVITY_APP_DATA_DIR:nativeDir},{managedMemberId:r.memberId,channelId:r.inFlight.key}))return{decision:'auto_approve',reason:'用户已授权的 DuolaWork 原生后台工作；保留原生显式拒绝规则'};
  }
  // A cloud receipt can arrive before the native Agent finishes its final
  // read-back. Keep that same turn authorized through native completion; the
  // next human message immediately restores the original permission policy.
  for(const [stepId,delivery] of Object.entries(r.nativeDeliveries||{}).slice(-32).reverse()){
   if(delivery.sessionId===input.conversationId&&['sending','sent'].includes(delivery.status)&&await nativeHubScope(input,stepId,{ANTIGRAVITY_APP_DATA_DIR:nativeDir}))return{decision:'auto_approve',reason:'用户授权的 DuolaWork 工作；保留原生显式拒绝规则'};
  }
 }
 return{decision:'allow'};
}
async function isCliTranscript(input,nativeDir){
 if(!uuid.test(input.conversationId||'')||!['transcript.jsonl','transcript_full.jsonl'].includes(path.basename(input.transcriptPath||'')))return false;
 try{return await fs.realpath(path.dirname(input.transcriptPath))===await fs.realpath(path.join(nativeDir,'brain',input.conversationId,'.system_generated/logs'));}catch{return false;}
}
export async function cliHookMain(base){
 if(process.argv[2]==='--attach'){console.log(JSON.stringify(await attachCurrentCli(base)));return;}
 let raw='';for await(const c of process.stdin){raw+=c;if(raw.length>2000000)throw Error('Hook input too large');}
 console.log(JSON.stringify(await cliHook(base,JSON.parse(raw||'{}'))));
}
export async function nativeHubScope(input,stepId,env,{managedMemberId,channelId}={}){
 // agentapi injects a SYSTEM message, not a user prompt, so lastUserInput is
 // intentionally unchanged. Inspect only the current conversation's official
 // hook transcript and only its ordering of user/Hub messages. Never expose or
 // use model thinking, other conversation logs or provider credential files.
 if(!uuid.test(input.conversationId||'')||!env.ANTIGRAVITY_APP_DATA_DIR)return false;
 const expected=path.join(env.ANTIGRAVITY_APP_DATA_DIR,'brain',input.conversationId,'.system_generated/logs/transcript.jsonl');
 let file;
 try{
  // 1.5 hooks supply transcript_full.jsonl while the documented compact log
  // remains transcript.jsonl. Validate the exact native directory, then read
  // the compact event ordering rather than the full model transcript.
  if(!['transcript.jsonl','transcript_full.jsonl'].includes(path.basename(input.transcriptPath||''))||await fs.realpath(path.dirname(input.transcriptPath))!==await fs.realpath(path.dirname(expected)))return false;
  file=await fs.open(expected,'r');const {size}=await file.stat(),length=Math.min(size,1024*1024),buffer=Buffer.alloc(length);await file.read(buffer,0,length,size-length);
  const lines=buffer.toString('utf8').split('\n');if(size>length)lines.shift();
  for(const line of lines.reverse()){
   let row;try{row=JSON.parse(line);}catch{continue;}
   if(row.type==='USER_INPUT'){
    const content=String(row.content||'').replace(/^<USER_REQUEST>\s*/, '');
    return !!managedMemberId&&content.startsWith('你是 Agent Hub 成员 '+managedMemberId+'，')&&content.includes('本轮只处理 stepId='+stepId+'，channelId='+channelId+'。');
   }
   if(row.source==='SYSTEM'&&row.type==='SYSTEM_MESSAGE'&&/\[Message\].* content=DuolaWork collaboration /.test(row.content||''))return row.content.includes(' content=DuolaWork collaboration '+stepId+'\n');
  }
 }catch{return false;}finally{await file?.close();}
 return false;
}
export async function serveCli(base,sessionId){
 if(!original(process.env)||process.env.ANTIGRAVITY_CONVERSATION_ID!==sessionId)throw Error('必须由对应的原生终端启动');
 const native=new AntigravityNative({cli:true}),summaries=native.summaries.bind(native);
 native.compatibility=async()=>({supported:true});
 native.summaries=async()=>{const all=await summaries();return all[sessionId]?{[sessionId]:all[sessionId]}:{};};
 const sidecar=await new AntigravitySidecar({stateFile:path.join(bridgeDir(base),sessionId+'.json'),native}).start();
 let failed=0,checking=false,closed=false;
 const close=async()=>{if(closed)return;closed=true;clearInterval(timer);await sidecar.stop();};
 const timer=setInterval(async()=>{if(checking||closed)return;checking=true;try{await native.summaries();failed=0;}catch{if(++failed>=3)await close();}finally{checking=false;}},5000);
 process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());return{sidecar,close};
}
if(process.argv[1]&&path.resolve(process.argv[1])===entry&&process.argv[2]==='serve')await serveCli(process.argv[3],process.argv[4]);
