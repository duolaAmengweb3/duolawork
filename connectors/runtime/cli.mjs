#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {CodingManager} from '../../local/coding-manager.mjs';
import {DshManager} from '../../local/dsh-manager.mjs';
import {DshOriginalHost} from '../../local/dsh-original-host.mjs';
import {AntigravityDesktopHost} from '../../local/antigravity-host.mjs';
import {installCliAttachment,attachCurrentCli} from '../../local/antigravity-cli-bridge.mjs';
import {CodingMemberClient} from '../../local/coding-client.mjs';
import {privateJson} from '../../local/storage.mjs';
import {requestJson} from '../../local/transport.mjs';
import {nativeForm} from '../../shared/native-forms.mjs';
import {queueSessionLink} from '../../local/session-link-runner.mjs';
import {safeError,findExecutable} from '../../local/native-agent.mjs';
const execute=promisify(execFile),entry=fileURLToPath(import.meta.url);
const root=process.env.DUOLAWORK_RUNTIME_DIR||path.join(os.homedir(),'.config','duolawork-runtime');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const read=file=>fs.readFile(file,'utf8').then(JSON.parse);
const folder=alias=>{if(!/^[a-zA-Z0-9_-]{1,100}$/.test(alias||''))throw Error('连接名称无效');return path.join(root,alias);};
export async function setup(input){
  const {endpoint,alias,memberId,code,form,platformId}=input,f=nativeForm(form,platformId),base=folder(alias);
  if(Number(process.versions.node.split('.')[0])<22)throw Error('连接器需要 Node.js 22 或以上');
  if(!f.systems.includes(process.platform))throw Error(f.name+' 的这种运行形态尚未支持当前系统，未更换原软件');
  if(f.manager==='coding'){
    const executable=await findExecutable(f.engine==='antigravity-cli'?'agy':f.engine==='gemini-cli'?'gemini':'codex');
    if(!executable)throw Error('请在已经安装并登录 '+f.name+' 的原环境运行这段说明');
    if(f.engine==='antigravity-cli'){
      const {stdout}=await execute(executable,['--version'],{timeout:10000}),v=stdout.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
      if(!v||Number(v[1])<1||Number(v[1])===1&&Number(v[2])<5)throw Error('当前 Antigravity CLI 版本不含所需接口，请先用官方 agy update 升至 1.5.0 或以上，再执行同一说明。此次未兑换配对码、未改变登录。');
    }
  }
  const u=new URL(endpoint);if(u.protocol!=='https:'&&!(process.env.AGENT_HUB_CONNECTOR_TEST==='1'&&u.hostname==='127.0.0.1'))throw Error('Hub 地址必须是 HTTPS');
  if(u.username||u.password||u.pathname!=='/'||u.search||u.hash||!/^member_[a-zA-Z0-9_-]+$/.test(memberId||''))throw Error('接入说明无效');
  const configFile=path.join(base,'runtime.json'),grantFile=path.join(base,'grant.json');let config,grant;
  if(f.engine==='antigravity-cli'&&process.env.AGENT_HUB_CONNECTOR_TEST!=='1'){
    const hooks=await read(path.join(os.homedir(),'.gemini/config/hooks.json')).catch(e=>{if(e.code==='ENOENT')return{};throw e;});
    const command=[process.execPath,path.join(base,'native-hook.mjs')].map(quote).join(' ');
    const prior=hooks['duolawork-native-cli'];if(prior&&(prior.SessionStart?.[0]?.command||prior.SessionStart?.[0]?.hooks?.[0]?.command)!==command)throw Error('这个 Antigravity CLI 环境已连接另一成员。请把另一账号的说明发到它自己的电脑、服务器或系统用户中。原连接未改变，配对码未兑换。');
  }
  try{config=await read(configFile);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(config&&(config.memberId!==memberId||config.endpoint!==u.origin||config.form!==form))throw Error('这个连接位置已属于另一个账号或运行形态，原资料保留');
  if(f.manager==='dsh-original')await new DshOriginalHost(base).register();
  try{grant=await read(grantFile);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(grant&&(grant.memberId!==memberId||grant.endpoint!==u.origin))throw Error('原授权属于其他账号，未覆盖');
  if(grant){
    try{await new CodingMemberClient(grantFile).api('/v2/self/status');}
    catch(e){if(![401,403].includes(e.status))throw e;await privateJson(path.join(base,'previous-grant.json'),grant);grant=null;}
  }
  if(!grant){
    const attemptFile=path.join(base,'pair-attempt.json'),fingerprint=createHash('sha256').update(u.origin+':'+code).digest('hex');let attempt;
    try{attempt=await read(attemptFile);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(attempt?.fingerprint!==fingerprint){attempt={fingerprint,id:randomUUID()};await privateJson(attemptFile,attempt);}
    grant=await requestJson(u.origin+'/v2/connect/redeem',{method:'POST',body:{code,attemptId:attempt.id}});
    if(grant.memberId!==memberId)throw Error('配对结果不属于这个成员');
    await privateJson(grantFile,{...grant,expiresAt:Date.now()+grant.expires_in*1000});await fs.rm(attemptFile,{force:true});
  }
  config??={memberId,platformId,form,endpoint:u.origin,runtimeId:randomUUID(),label:os.hostname(),createdAt:new Date().toISOString()};
  await privateJson(configFile,config);
  const client=new CodingMemberClient(grantFile);await client.api('/v2/self/connection',{method:'POST',body:{requestId:randomUUID(),transport:'pull',pollSeconds:15}});
  const service=await installService(alias,base);
  let attachment;
  if(f.engine==='antigravity-cli'){
    if(process.env.AGENT_HUB_CONNECTOR_TEST==='1')attachment=await attachCurrentCli(base);
    else attachment=await installCliAttachment(base);
  }
  return{stage:'connecting',message:'原环境连接器已启动，项目和对话将在 DuolaWork 中自动出现。选定对话并收到 Agent 的真实回复后才表示协作可用。',service,...(attachment?{nativeAttachment:attachment}: {})};
}

export async function installService(alias,base){
  // One persistent process per account. Restarts preserve config, native login,
  // and explicit per-chat bindings. There is no listening public port.
  const launcher=path.join(base,'service.mjs');
  const stage=async()=>{
    await fs.copyFile(path.join(path.dirname(entry),'service.mjs'),launcher);
    await fs.chmod(launcher,0o600);
    await privateJson(path.join(base,'program.json'),{node:process.execPath,entry,alias,revision:randomUUID()});
  };
  const args=[launcher];
  if(process.env.AGENT_HUB_CONNECTOR_TEST==='1'){await stage();return{kind:'test',args:[entry,'run',alias]};}
  if(process.platform==='darwin'){
    const label='com.duola.runtime.'+alias,file=path.join(os.homedir(),'Library/LaunchAgents',label+'.plist');
    const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
    const content=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[process.execPath,...args].map(x=>'<string>'+xml(x)+'</string>').join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH||'')}</string></dict><key>StandardErrorPath</key><string>${xml(path.join(base,'service.log'))}</string></dict></plist>`;
    let before;try{before=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
    if(before&&before!==content)throw Error('原服务配置与当前环境不同，原连接保留；请在原环境核对系统服务路径后更新');
    await stage();
    if(!before){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content,{mode:0o600});}
    try{await execute('launchctl',['print','gui/'+process.getuid()+'/'+label]);}catch{await execute('launchctl',['bootstrap','gui/'+process.getuid(),file]);}
    return{kind:'launchd'};
  }
  const system=process.getuid()===0,unit='duolawork-'+alias+'.service',dir=system?'/etc/systemd/system':path.join(os.homedir(),'.config/systemd/user'),file=path.join(dir,unit),ctl=system?[]:['--user'];
  const esc=s=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')+'"';
  const content=`[Unit]\nDescription=DuolaWork native account connector\nAfter=network-online.target\n[Service]\nType=simple\nExecStart=${[process.execPath,...args].map(esc).join(' ')}\nEnvironment=${esc('PATH='+process.env.PATH)}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=infinity\nKillMode=mixed\n[Install]\nWantedBy=${system?'multi-user.target':'default.target'}\n`;
  let before;try{before=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(before&&before!==content)throw Error('已有服务版本不同，未中断原工作或覆盖连接；请在原工作结束后更新连接器');
  if(!system){const {stdout}=await execute('loginctl',['show-user',String(process.getuid()),'-p','Linger','--value']);if(stdout.trim()!=='yes')throw Error('这台服务器尚未允许当前用户服务在退出 SSH 后常驻，请由管理员为此用户启用 linger 后再执行同一说明。原服务未更改。');}
  await stage();
  await fs.mkdir(dir,{recursive:true});if(!before)await fs.writeFile(file,content,{mode:0o600});
  await execute('systemctl',[...ctl,'daemon-reload']);await execute('systemctl',[...ctl,'enable','--now',unit]);
  return{kind:'systemd'};
}

export async function run(alias,{interval=4000,managerFactory}={}){
  const base=folder(alias),config=await read(path.join(base,'runtime.json')),grantFile=path.join(base,'grant.json'),client=new CodingMemberClient(grantFile),f=nativeForm(config.form,config.platformId),instanceId=randomUUID(),lockFile=path.join(base,'service-lock.json');
  const receiverRevision=(await read(path.resolve(path.dirname(entry),'../../runtime-version.json')).catch(()=>({}))).revision;
  let lock;try{lock=await fs.open(lockFile,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;const prior=await read(lockFile);let alive=true;try{process.kill(prior.pid,0);}catch(err){if(err.code==='ESRCH')alive=false;else throw err;}if(alive)throw Error('这个账号的连接器已经运行');await fs.rm(lockFile);lock=await fs.open(lockFile,'wx',0o600);}
  await lock.writeFile(JSON.stringify({pid:process.pid,instanceId}));
  let context=await client.api('/v2/self/runtime');if(context.member.platformId!==config.platformId)throw Error('成员平台已改变，未连接其他账号');
  const manager=managerFactory?managerFactory():f.manager==='coding'?new CodingManager({config:{endpoint:config.endpoint},dataDir:base}):new DshManager({config:{endpoint:config.endpoint},dataDir:base,...(f.manager==='antigravity'?{host:new AntigravityDesktopHost(base),platformId:config.platformId,engine:'antigravity',fileName:'antigravity-desktop-members.json',requireFreshReceipt:true}:f.manager==='dsh-original'?{host:new DshOriginalHost(base),requireFreshReceipt:true}:{})});
  await manager.load();
  manager.owner=async(route)=>{if(route==='/v2/workspace')return{members:[context.member]};if(route==='/v2/channels')return{items:context.channels};throw Error('远程成员没有所有者管理权限');};
  // Reuse one grant file, including token refresh locks, across every helper.
  const record=manager.records[config.memberId];if(record)record.grantFile=grantFile;
  else if(f.manager==='coding')manager.records[config.memberId]={memberId:config.memberId,engine:f.engine,cwd:path.join(base,'workspace'),grantFile,sessions:{},chatBindings:{},manualAssignments:true,protocol:f.engine==='codex'?'app-server':'acp',permissionMode:'full'};
  else manager.records[config.memberId]={memberId:config.memberId,grantFile,hostKind:manager.host.kind||'desktop',chatBindings:{}};
  if(f.manager==='coding'){
    // An interrupted receiver is not a new connection. Reconcile its exact
    // native turn with cloud receipts before deciding what remains to do.
    if(record?.inFlight){record.enabled=true;record.status='needs_review';}
    else await manager.connect({memberId:config.memberId,engine:f.engine,sourceOnly:true});
  }else await manager.connectSource({memberId:config.memberId});
  // Do not resume persisted work until this runtime owns a fresh heartbeat and
  // has reconciled the authoritative chat bindings (including a lost ACK).
  await manager.jobs.get(config.memberId);manager.stopped=true;
  let stopped=false,pending=false,commandBusy=false,managerStarting=null,catalogJob=null,catalogAt=0,catalog={items:[],projects:[]};const linkJobs=new Map();
  const reportError=e=>privateJson(path.join(base,'last-error.json'),{at:new Date().toISOString(),message:safeError(e)}).catch(()=>{});
  const reconcile=async current=>{
    if(current.runtime?.runtimeId!==config.runtimeId)throw Error('原环境身份未确认，未派发消息');
    const r=manager.records[config.memberId],bindings=current.runtime.bindings||{};
    if(r.inFlight&&JSON.stringify(r.chatBindings)!==JSON.stringify(bindings))throw Error('原工作仍在执行，未变更接收对话');
    r.chatBindings=structuredClone(bindings);r.sessions={...r.sessions,...Object.fromEntries(Object.entries(bindings).map(([id,b])=>[id,b.sessionId]))};
    r.verificationSessionId=Object.values(bindings).some(b=>b.sessionId===r.verificationSessionId)?r.verificationSessionId:Object.values(bindings)[0]?.sessionId;
    await manager.save();if(manager.syncBindings)await manager.syncBindings(r);
  };
  const localJournal=path.join(base,'commands.json');let journal;try{journal=await read(localJournal);}catch(e){if(e.code!=='ENOENT')throw e;journal={};}
  const tick=async()=>{if(pending||stopped)return;pending=true;try{
    context=await client.api('/v2/self/runtime');
    const r=manager.records[config.memberId],s=f.manager==='coding'?manager.status().members.find(s=>s.memberId===config.memberId):manager.status().find(s=>s.memberId===config.memberId);
    if(r.sourceReady&&!catalogJob&&Date.now()-catalogAt>30000){catalogAt=Date.now();catalogJob=Promise.resolve().then(()=>f.manager==='coding'?manager.sessionOptions(config.memberId):manager.hostFor(config.memberId).sessions()).then(next=>{catalog=next;}).catch(reportError).finally(()=>{catalogJob=null;});}
    context=await client.api('/v2/self/runtime',{method:'POST',body:{action:'heartbeat',receiverRevision,runtimeId:config.runtimeId,instanceId,form:config.form,label:config.label,sourceReady:!!r.sourceReady,status:s.status,message:s.message,executions:(s.assignments||[]).filter(b=>b.pendingStepId||b.nativeState).map(({channelId,sessionId,pendingStepId,deliveryState,workState,workMessage,nativeState,observedAt})=>({channelId,sessionId,pendingStepId,deliveryState,workState,workMessage,nativeState,observedAt})),items:catalog.items.map(s=>({...s,title:String(s.title||'未命名对话').slice(0,200)})),projects:catalog.projects||[]}});
    if(!commandBusy){await reconcile(context);if(!stopped){if(!manager.timer&&!managerStarting)managerStarting=manager.start().catch(reportError).finally(()=>{managerStarting=null;});else manager.stopped=false;
      if(f.manager==='coding'&&r.inFlight&&r.status==='needs_review'&&!manager.jobs.has(config.memberId))await manager.resume({memberId:config.memberId});
    }}
    const links=(await client.api('/v2/self/session-links')).items.filter(l=>l.executor==='runtime'&&l.runtimeId===config.runtimeId);
    for(const link of links){
      if(link.status==='confirming'&&!linkJobs.has(link.id)){
        const job=queueSessionLink(manager,link,base).catch(async e=>{await client.api('/v2/self/session-links',{method:'POST',body:{action:'failed',id:link.id,requestId:'link-fail-'+link.id,message:safeError(e)}}).catch(()=>{});}).finally(()=>linkJobs.delete(link.id));linkJobs.set(link.id,job);
      }else if(link.status==='verified'){
        try{context=await client.api('/v2/self/runtime',{method:'POST',body:{action:'link',runtimeId:config.runtimeId,instanceId,requestId:'link-apply-'+link.id,linkId:link.id}});}catch(e){await client.api('/v2/self/session-links',{method:'POST',body:{action:'failed',id:link.id,requestId:'link-cas-'+link.id,message:safeError(e)}});}
      }
    }
    const command=context.commands.find(c=>c.runtimeId===config.runtimeId);
    if(command&&!commandBusy&&!(command.linkIntentId&&(r.inFlight||manager.jobs.has(config.memberId)))){commandBusy=true;void (async()=>{
      // Pause dispatch while the candidate is prepared and committed. A failed
      // cloud CAS must never make this receiver send work to a different session.
      manager.stopped=true;let routingConfirmed=false;
      try{
        let outcome=journal[command.id];
        if(!outcome){
          journal[command.id]={pending:true};await privateJson(localJournal,journal);
          try{const binding=await manager.assign({...command,memberId:config.memberId,channels:context.channels,prepareOnly:true});outcome={binding};}catch(e){outcome={error:safeError(e)};}
          journal[command.id]=outcome;await privateJson(localJournal,journal);
        }else if(outcome.pending)outcome={error:'上次选择对话时连接器意外退出，原绑定保留。请刷新项目列表，核对后选择已有对话；未重复新建。'};
        context=await client.api('/v2/self/runtime',{method:'POST',body:{action:'complete',runtimeId:config.runtimeId,instanceId,requestId:'prepare-'+command.id,commandId:command.id,...outcome}});
        if(outcome.error){await reconcile(context);routingConfirmed=true;return;}
        await manager.commitBinding({memberId:config.memberId,channelId:command.channelId,binding:outcome.binding,verify:false});
        context=await client.api('/v2/self/runtime',{method:'POST',body:{action:'activate',runtimeId:config.runtimeId,instanceId,requestId:'activate-'+command.id,commandId:command.id}});
        await reconcile(context);routingConfirmed=true;
        await manager.commitBinding({memberId:config.memberId,channelId:command.channelId,binding:context.runtime.bindings[command.channelId]});
        catalogAt=0;
      }catch(e){
        // Activation may have committed before the response was lost. Never
        // blindly roll back. Read cloud truth; while offline keep dispatch held.
        try{context=await client.api('/v2/self/runtime');await reconcile(context);routingConfirmed=true;}catch{}
        throw e;
      }finally{manager.stopped=stopped||!routingConfirmed;}
    })().catch(async e=>{await privateJson(path.join(base,'last-error.json'),{at:new Date().toISOString(),message:safeError(e)});}).finally(()=>{commandBusy=false;});}
  }catch(e){
    if([401,403].includes(e.status)){
      const r=manager.records[config.memberId];r.enabled=false;r.status='needs_review';r.message='DuolaWork 连接授权已解除，请在软件中重新连接；原登录和对话保留';manager.stopped=true;await manager.save();
    }
    await privateJson(path.join(base,'last-error.json'),{at:new Date().toISOString(),message:safeError(e)});
  }finally{pending=false;}};
  const timer=setInterval(()=>void tick(),interval);await tick();
  const close=async()=>{if(stopped)return;stopped=true;clearInterval(timer);manager.stopped=true;while(pending||commandBusy||managerStarting||catalogJob||manager.jobs.size||linkJobs.size)await new Promise(r=>setTimeout(r,100));await manager.stop();await client.api('/v2/self/runtime',{method:'POST',body:{action:'release',runtimeId:config.runtimeId,instanceId}}).catch(()=>{});await lock.close();await fs.rm(lockFile,{force:true});};
  process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());return{manager,close,tick};
}
if(process.argv[1]&&await fs.realpath(process.argv[1]).catch(()=>'')===entry){const [command,alias]=process.argv.slice(2);(async()=>{if(command==='setup'){let raw='';for await(const c of process.stdin){raw+=c;if(raw.length>10000)throw Error('接入参数过大');}console.log(JSON.stringify(await setup(JSON.parse(raw))));}else if(command==='run')await run(alias);else throw Error('请使用软件复制的接入说明');})().catch(e=>{console.error('DuolaWork: '+safeError(e));process.exitCode=1;});}
