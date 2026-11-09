#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {privateJson} from '../../local/storage.mjs';
import {requestJson} from '../../local/transport.mjs';
import {CodingMemberClient} from '../../local/coding-client.mjs';
import {serve} from './channel.mjs';
import {refreshSessionInfo} from './session-info.mjs';
import {claudeResumeAction} from '../../shared/claude-onboarding.mjs';
import {runMonitor,serveMonitor,writeMonitorPlugin,nativeIdentity,monitorStopped} from './monitor.mjs';

const base=process.env.AGENT_HUB_CLAUDE_DIR||path.join(os.homedir(),'.config','agent-hub-claude');
const executable=path.resolve(process.argv[1]||'connector.cjs');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
async function read(file){return JSON.parse(await fs.readFile(file,'utf8'));}
function location(alias){if(!/^[a-zA-Z0-9_-]{1,60}$/.test(alias||''))throw Error('成员别名只使用字母、数字、横线，例如 claude1');return path.join(base,alias);}
export async function pair({endpoint,code,alias,memberId}){
  const url=new URL(endpoint);if(url.protocol!=='https:'&&!(process.env.AGENT_HUB_CONNECTOR_TEST==='1'&&url.hostname==='127.0.0.1'))throw Error('Hub 地址必须是 HTTPS');
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('请使用 Hub 的完整根地址');
  const dir=location(alias),file=path.join(dir,'grant.json');
  try{await fs.access(file);throw Error('这个别名已配对，保留原连接；新增成员请换一个别名');}catch(e){if(e.code!=='ENOENT')throw e;}
  const attemptFile=path.join(dir,'pair-attempt.json'),fingerprint=createHash('sha256').update(url.origin+':'+code).digest('hex');
  let attempt;try{attempt=await read(attemptFile);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(attempt?.fingerprint!==fingerprint){attempt={fingerprint,id:randomUUID()};await privateJson(attemptFile,attempt);}
  const grant=await requestJson(url.origin+'/v2/connect/redeem',{method:'POST',body:{code,attemptId:attempt.id}});
  if(memberId&&grant.memberId!==memberId)throw Error('配对码属于其他成员，未覆盖连接');
  await privateJson(file,{...grant,expiresAt:Date.now()+grant.expires_in*1000});
  await new CodingMemberClient(file).api('/v2/self/connection',{method:'POST',body:{requestId:'claude-'+grant.memberId,transport:'pull',pollSeconds:15}});
  await fs.rm(attemptFile,{force:true});return grant.memberName;
}
export async function setup({endpoint,code,alias,memberId,sessionId}, {cli=executable}={}){
  if(!/^member_[a-zA-Z0-9_-]+$/.test(memberId||''))throw Error('接入说明缺少有效的成员编号，请从 Hub 重新复制');
  if(sessionId&&!/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId))throw Error('原会话编号无效，请勿猜测');
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<22||major===22&&minor<19)throw Error('连接器需要 Node.js 22.19 或以上；请由安装步骤准备独立运行环境，不修改系统 Node');
  if(!['darwin','linux'].includes(process.platform))throw Error('此连接器当前支持 macOS 和 Linux');
  const grantFile=path.join(location(alias),'grant.json');let grant;
  try{grant=await read(grantFile);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(grant){
    if(grant.memberId!==memberId||grant.endpoint!==new URL(endpoint).origin)throw Error('此连接位置属于其他账号，原资料保留，请使用正确的接入说明');
  }else await pair({endpoint,code,alias,memberId});
  const client=new CodingMemberClient(grantFile);
  await client.api('/v2/self/connection',{method:'POST',body:{requestId:'claude-'+memberId,transport:'pull',pollSeconds:15}});
  const [state,sessions]=await Promise.all([client.api('/v2/self/status'),client.api('/v2/self/native-sessions')]);
  const online=sessions.items.some(s=>s.online);
  if(state.complete&&online)return{stage:'ready',message:'已连接，原 Claude 已完成真实回复验证。'};
  if(online)return{stage:'verifying',message:'原会话已在线，正在等待它完成 Hub 验证。'};
  const resume={nodePath:process.execPath,connectorPath:cli,alias,sessionId,workspace:process.cwd()};
  const resumeCommand=claudeResumeAction(resume).command;
  const nextStep='还差一次重新打开 Claude。当前工作结束后输入 /exit，再把恢复命令粘贴到退出后的终端并回车。出现 DuolaWork / Agent Hub 连接提示时确认。随后自动验证，不用再发配对码；Hub 显示“已连接，可以聊天”才算完成。';
  await privateJson(path.join(location(alias),'setup.json'),{memberId,preparedAt:new Date().toISOString(),resumeCommand,workspace:process.cwd()});
  await client.api('/v2/self/status',{method:'POST',body:{stage:'waiting_owner',action:'claude_resume',resume,message:'安装已完成，还差一次重新打开 Claude。恢复命令已放到 DuolaWork 的连接页，按页面步骤完成即可。'}});
  return{stage:'waiting_owner',nextStep,resumeCommand,requiresNativeConfirmation:true};
}
export async function setupMonitor({endpoint,code,alias,memberId}, {cli=executable,identity=nativeIdentity,configDir=process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude')}={}){
  if(!/^member_[a-zA-Z0-9_-]+$/.test(memberId||''))throw Error('请从 DuolaWork 重新复制接入说明');
  const current=await identity();if(!current)throw Error('请把接入说明发到正在使用的 Claude Code 对话；未取得原会话信息，没有新开会话');
  const dir=location(alias),grantFile=path.join(dir,'grant.json');let grant;
  try{grant=await read(grantFile);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(grant){if(grant.memberId!==memberId||grant.endpoint!==new URL(endpoint).origin)throw Error('这个连接属于其他账号，原资料保留');}
  else await pair({endpoint,code,alias,memberId});
  const client=new CodingMemberClient(grantFile),name='duolawork-'+createHash('sha256').update(memberId).digest('hex').slice(0,12);
  // A user plugin is the documented persistent installation scope. Repository
  // plugins cannot start monitors. Never edit settings.json or the native login.
  const pluginDir=path.join(configDir,'skills',name);
  await writeMonitorPlugin({pluginDir,connectionDir:dir,cli,name});
  const sessionsFile=path.join(dir,'monitor-sessions.json');let linked;
  try{linked=await read(sessionsFile);}catch(e){if(e.code!=='ENOENT')throw e;linked={runtimeId:randomUUID(),sessionIds:[]};await privateJson(sessionsFile,linked);}
  await privateJson(path.join(dir,'linked-sessions',current.sessionId+'.json'),{sessionId:current.sessionId});
  await privateJson(path.join(dir,'setup.json'),{memberId,preparedAt:new Date().toISOString(),transport:'monitor',pluginDir,workspace:current.workspace,sessionId:current.sessionId});
  await client.api('/v2/self/connection',{method:'POST',body:{requestId:'claude-'+memberId,transport:'pull',pollSeconds:15}});
  const state=await client.api('/v2/self/status');
  const sessions=await client.api('/v2/self/native-sessions');
  if(state.complete&&sessions.items.some(s=>s.id===current.sessionId&&s.online))return{stage:'ready',message:'原会话已在线，并已完成真实回复验证。'};
  await client.api('/v2/self/status',{method:'POST',body:{stage:'waiting_owner',action:'claude_reload',message:'接收插件已准备好。在当前 Claude 输入 /reload-plugins，加载后会自动验证。以后照常打开 Claude 即可。'}});
  return{stage:'waiting_owner',reloadCommand:'/reload-plugins',message:'准备好了。在这个 Claude 对话输入 /reload-plugins，之后会自动验证。无需退出或重新登录；以后照常打开 Claude。'};
}
async function stdinJson(limit=200000){let raw='';for await(const part of process.stdin){raw+=part;if(raw.length>limit)throw Error('输入过大');}return JSON.parse(raw);}
export async function prepareLaunch({alias,cwd=process.cwd(),cli=executable}){
  const dir=location(alias),grantFile=path.join(dir,'grant.json');await read(grantFile);
  const runDir=path.join(dir,'runs',randomUUID());await fs.mkdir(runDir,{recursive:true,mode:0o700});
  const runtimeFile=path.join(base,'runtime.json');let runtime;try{runtime=await read(runtimeFile);}catch(e){if(e.code!=='ENOENT')throw e;runtime={id:randomUUID()};await privateJson(runtimeFile,runtime);}
  const runFile=path.join(runDir,'session.json');
  await privateJson(runFile,{instanceId:randomUUID(),runtimeId:runtime.id,workspace:cwd});
  const plugin=path.join(runDir,'plugin');await privateJson(path.join(plugin,'.claude-plugin','plugin.json'),{name:'agent-hub-session',version:'1.0.0',description:'登记本次原生会话，不读取会话正文或登录凭证'});
  await privateJson(path.join(plugin,'hooks','hooks.json'),{hooks:{SessionStart:[{hooks:[{type:'command',command:[process.execPath,cli,'hook',runFile].map(quote).join(' '),timeout:10}]}]}});
  const mcp=path.join(runDir,'mcp.json');await privateJson(mcp,{mcpServers:{'agent-hub':{command:process.execPath,args:[cli,'serve',grantFile,runFile,path.join(dir,'sessions')]}}});
  return{runDir,args:['--plugin-dir',plugin,'--mcp-config',mcp,'--dangerously-load-development-channels','server:agent-hub','--allowedTools','mcp__agent-hub__*']};
}
export async function hook(runFile,input){
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(input.session_id||''))throw Error('未收到原生会话编号');
  const state=await read(runFile);await privateJson(runFile,await refreshSessionInfo({...state,sessionId:input.session_id,workspace:input.cwd||state.workspace,title:input.session_title||'未命名对话'}));
}
export async function main(argv=process.argv.slice(2)){
  const [command,...args]=argv;
  if(command==='monitor'||command==='monitor-mcp'){
    // Snapshot the bundle at process startup; never infer loaded code from a
    // later installation/config change or the current server release.
    const loadedRevision=createHash('sha256').update(await fs.readFile(executable)).digest('hex');
    if(command==='monitor'){
      if(args[1]==='--runtime-revision'&&args[2]!==loadedRevision)throw Error('接收器启动版本与插件登记不同，请重新加载 DuolaWork 插件');
      await runMonitor(args[0],loadedRevision);
    }else await serveMonitor(args[0],loadedRevision);
    return;
  }
  if(command==='monitor-stop'){try{await monitorStopped(args[0],await stdinJson(2000000));}catch{/* A hook must not interrupt the user's original turn; its durable marker retries. */}return;}
  if(command==='prepare-monitor'){
    const {connectionDir,pluginDir,sessionId}=await stdinJson();
    const current=await nativeIdentity();
    if(!current||sessionId&&current.sessionId!==sessionId)throw Error('请在要接入的原 Claude 对话里执行，不猜测会话');
    const sessionsFile=path.join(connectionDir,'monitor-sessions.json');let linked;
    try{linked=await read(sessionsFile);}catch(e){if(e.code!=='ENOENT')throw e;linked={runtimeId:randomUUID(),sessionIds:[]};}
    if(!linked.sessionIds.includes(current.sessionId))linked.sessionIds.push(current.sessionId);
    await privateJson(sessionsFile,linked);
    console.log(JSON.stringify(await writeMonitorPlugin({connectionDir,pluginDir,cli:executable})));return;
  }
  if(command==='setup'){console.log(JSON.stringify(await setup(await stdinJson()),null,2));return;}
  if(command==='setup-monitor'){console.log(JSON.stringify(await setupMonitor(await stdinJson()),null,2));return;}
  if(command==='pair'){
    const [endpoint,alias='claude1']=args;const rl=createInterface({input:process.stdin,output:process.stdout});let code;try{code=(await rl.question('粘贴 Hub 显示的一次性配对码：')).trim();}finally{rl.close();}
    const name=await pair({endpoint,alias,code});console.log(`已配对 ${name}。在原项目目录运行：node ${quote(executable)} start ${alias} --resume`);return;
  }
  if(command==='start'){
    const [alias='claude1',...nativeArgs]=args;
    if(nativeArgs.some(a=>!['--resume','--continue'].includes(a)&&a.startsWith('-')))throw Error('启动器只接收 --resume [会话ID] 或 --continue；其他配置沿用原 Claude');
    const grantFile=path.join(location(alias),'grant.json'),client=new CodingMemberClient(grantFile),grant=await client.credentials();await client.api('/v2/self/connection',{method:'POST',body:{requestId:'claude-'+grant.memberId,transport:'pull',pollSeconds:15}});
    const prepared=await prepareLaunch({alias});console.log('将打开原生 Claude。首次请确认官方自定义通道提示；原会话仍在运行时请先正常退出它，再恢复该会话。');
    const child=spawn('claude',[...prepared.args,...nativeArgs],{stdio:'inherit',cwd:process.cwd(),env:process.env});
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',c=>resolve(c??1));});process.exitCode=code;return;
  }
  if(command==='hook'){let raw='';for await(const part of process.stdin){raw+=part;if(raw.length>200000)throw Error('会话登记过大');}await hook(args[0],JSON.parse(raw));return;}
  if(command==='serve'){await serve({grantFile:args[0],runFile:args[1],stateDir:args[2]});return;}
  if(command==='status'){const dir=location(args[0]||'claude1'),client=new CodingMemberClient(path.join(dir,'grant.json'));const s=await client.api('/v2/self/native-sessions');console.log(JSON.stringify({message:s.record.message,sessions:s.items.map(s=>({name:s.title,online:s.online}))},null,2));return;}
  console.log('Agent Hub Claude 连接器\n需要 Node.js 22.19+ 和已登录的原生 Claude Code。\npair <Hub HTTPS地址> [别名]  配对\nstart [别名] --resume        用原生选择器恢复会话并接入\nstart [别名]                 新建原生会话并接入\nstatus [别名]                查看连接状态\n所有工作在执行这些命令的机器上进行。');
}
if(process.env.AGENT_HUB_CONNECTOR_IMPORT!=='1')main().catch(e=>{console.error('Agent Hub: '+e.message);process.exitCode=1;});
