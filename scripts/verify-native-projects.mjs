// Explicit acceptance in owned proof projects. No production Hub messages or provider login changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {startHarness} from '../tests/v1-harness.mjs';
import {CodingManager} from '../local/coding-manager.mjs';
import {DshManager} from '../local/dsh-manager.mjs';
import {AntigravityDesktopHost} from '../local/antigravity-host.mjs';
import {DshDesktopHost} from '../local/dsh-desktop.mjs';
import {ChatSessions} from '../local/chat-sessions.mjs';
if(!process.argv.includes('--run-isolated'))throw Error('Use --run-isolated');
const h=await startHarness(),dataDir=path.join(h.directory,'local'),actual=path.join(os.homedir(),'.config/agent-hub');
const agHost=new AntigravityDesktopHost(actual),dshHost=new DshDesktopHost(actual),config={endpoint:h.base,adminKey:h.key};
const coding=new CodingManager({config,dataDir,interval:1500}),dsh=new DshManager({config,dataDir,host:dshHost,interval:1500}),ag=new DshManager({config,dataDir,host:agHost,platformId:'antigravity',fileName:'antigravity-desktop-members.json'});
coding.antigravityWorkingHost=agHost;
const sessions=new ChatSessions({coding,dsh,ag}),report={at:new Date().toISOString(),productionHubChanged:false,providerLoginChanged:false,checks:[]},cases=[],files=[];
const evidence='evidence/native-projects-acceptance.json';
async function save(){await fs.writeFile(evidence,JSON.stringify(report,null,2)+'\n');}
async function receive(c,after){const start=Date.now();while(Date.now()-start<300000){const v=await h.request('/v2/channel?id='+c.channel.id),reply=v.messages.find(m=>m.authorId===c.member.id&&m.number>after.number);if(reply)return{body:reply.body,elapsedMs:Date.now()-start};await new Promise(r=>setTimeout(r,1000));}throw Error(c.platform+' did not return a real native reply: '+(coding.records[c.member.id]?.message||dsh.records[c.member.id]?.message));}
try{
 await coding.load();await dsh.load();await ag.load();await agHost.start({launch:false});await dshHost.start({launch:false});
 const location=JSON.parse(await fs.readFile('/tmp/hub-codex-gui-proof-location.json'));
 if(!path.basename(location.root).startsWith('hub-codex-gui-proof-'))throw Error('Owned Codex proof not found');
 const agItem=(await agHost.sessions()).items.find(s=>s.workspace.includes('/hub-working-session-proof-')&&!s.running);
 const dshItem=(await dshHost.sessions()).items.find(s=>s.workspace.endsWith('/deepseek-harness/default-workspace')&&s.title==='Fix scale.mjs to pass npm test'&&!s.running);
 if(!agItem||!dshItem)throw Error('Owned native proof sessions unavailable');
 const bound=(await dshHost.call('/health')).bindings;if(bound.some(b=>b.sessionId===dshItem.id))throw Error('Proof session is already bound');
 const specs=[['codex',location.threads[0].id,location.project],['antigravity',agItem.id,agItem.workspace],['deepseek-harness',dshItem.id,dshItem.workspace]];
 for(const [platform,id,workspace]of specs){
  await h.request('/admin/action',{type:'platform.create',payload:{id:platform,name:platform}});
  const member=await h.member(platform,'原会话验收 '+platform),channel=await h.command('channel.create',{name:'原生项目验收 '+platform,memberIds:[member.id],wakeIntervalSeconds:0}),grantFile=path.join(dataDir,member.id,'grant.json');await fs.mkdir(path.dirname(grantFile),{recursive:true});await fs.writeFile(grantFile,JSON.stringify({endpoint:h.base,memberId:member.id,access_token:member.token}),{mode:0o600});
  const c={platform,id,workspace,member,channel,marker:'native_'+randomUUID().slice(0,8)},input=path.join(workspace,'.duolawork-acceptance-input.txt'),output=path.join(workspace,'.duolawork-acceptance-output.txt');
  for(const file of [input,output]){try{await fs.access(file);throw Error('Proof file already exists');}catch(e){if(e.code!=='ENOENT')throw e;}}await fs.writeFile(input,c.marker+'\n');files.push(input,output);Object.assign(c,{input,output});cases.push(c);
  if(platform==='deepseek-harness'){dsh.records[member.id]={memberId:member.id,grantFile,enabled:true,sourceReady:true,status:'idle',hostKind:'desktop',chatBindings:{}};await dsh.save();}
  else{coding.records[member.id]={memberId:member.id,engine:platform,protocol:platform==='codex'?'app-server':'acp',grantFile,enabled:true,sourceReady:true,status:'idle',permissionMode:'full',manualAssignments:true,cwd:workspace,sessions:{},chatBindings:{}};await coding.save();}
  const inventory=await sessions.options({memberId:member.id,channelId:channel.id});if(!inventory.items.some(s=>s.id===id))throw Error('Native session absent from picker');
  await sessions.assign({memberId:member.id,channelId:channel.id,mode:'existing',sessionId:id});
  report.checks.push({platform,sessionId:id,workspace,listed:true,selected:true,inventoryCount:inventory.items.length,projectCount:inventory.projects.length});
 }
 await coding.start();await dsh.start();
 await Promise.all(cases.map(async c=>{const m=await h.command('channel.post',{channelId:c.channel.id,body:`仅做本次连接验收：用你原生的文件工具读取当前项目中的 ${path.basename(c.input)}，把读到的内容写入同目录 ${path.basename(c.output)}。记住读到的识别词，回到本群回复识别词和“已在原项目写入”。只操作这两个文件，不搜索其他会话，不修改其他文件，不创建文档事项。`});const r=await receive(c,m);if(!r.body.includes(c.marker)||!(await fs.readFile(c.output,'utf8')).includes(c.marker))throw Error(c.platform+' exact native file round-trip failed');Object.assign(report.checks.find(r=>r.platform===c.platform),{firstReply:r,nativeFileVerified:true});await save();console.log(c.platform+' original session file round-trip passed');}));
 await coding.stop();await dsh.stop();await coding.load();await dsh.load();await coding.start();await dsh.start();
 await Promise.all(cases.map(async c=>{const m=await h.command('channel.post',{channelId:c.channel.id,body:'本机协作端已经重启。这次不要读任何文件，也不要搜索。请仅凭当前原会话记忆回复上一条验收消息中读到的识别词。只回这一句。'});const r=await receive(c,m);if(!r.body.includes(c.marker))throw Error(c.platform+' original context not retained');Object.assign(report.checks.find(r=>r.platform===c.platform),{afterRestart:r,contextRetained:true});await save();console.log(c.platform+' same session after restart passed');}));
 report.passed=true;
}catch(e){report.failure=e.message;process.exitCode=1;console.error(e.message);}
finally{await coding.stop();await dsh.stop();for(const c of cases)if(c.platform==='deepseek-harness')await dshHost.call('/unbind',{sessionId:c.id}).catch(()=>{});for(const file of files)await fs.rm(file,{force:true});await h.stop();report.temporaryBindingsAndFilesRemoved=true;report.finishedAt=new Date().toISOString();await save();}
