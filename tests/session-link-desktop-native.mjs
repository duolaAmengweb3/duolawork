// Explicit native acceptance: isolated Hub, a pre-existing dedicated AG proof
// conversation and a newly-created DSH proof conversation. Never user work.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startHarness} from './v1-harness.mjs';
import {CodingManager} from '../local/coding-manager.mjs';
import {DshManager} from '../local/dsh-manager.mjs';
import {DshDesktopHost} from '../local/dsh-desktop.mjs';
import {AntigravityDesktopHost} from '../local/antigravity-host.mjs';
import {ChatSessions} from '../local/chat-sessions.mjs';
if(!process.argv.includes('--run-native-acceptance'))throw Error('Requires explicit native acceptance');
const isAg=process.argv.includes('--antigravity'),platform=isAg?'antigravity':'deepseek-harness',h=await startHarness(),dataDir=path.join(h.directory,'local'),actual=path.join(os.homedir(),'.config/agent-hub');
const host=isAg?new AntigravityDesktopHost(actual):new DshDesktopHost(actual),config={endpoint:h.base,adminKey:h.key},coding=new CodingManager({config,dataDir}),manager=new DshManager({config,dataDir,host,platformId:platform,fileName:isAg?'antigravity-desktop-members.json':'dsh-members.json',requireFreshReceipt:true,interval:1000});
const sessions=new ChatSessions({coding,ag:isAg?manager:{records:{}},dsh:isAg?{records:{}}:manager}),e={at:new Date().toISOString(),platform,realOfficialDesktop:true,isolatedHub:true,existingUserConversationsTouched:false,checks:[]};let member,id;
const q=s=>"'"+s.replaceAll("'","'\\''")+"'";
const wait=async(fn,label)=>{for(let i=0;i<240;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,1000));}throw Error(label+' timed out');};
try{
 await coding.load();await manager.load();await host.start({launch:false});
 const originalBindings=(await host.call('/health')).bindings;
 if(isAg){const original=(await host.sessions()).items.find(s=>s.workspace.includes('/hub-working-session-proof-')&&!s.running&&!originalBindings.some(b=>b.sessionId===s.id));if(!original)throw Error('Dedicated original proof conversation is unavailable');id=original.id;}
 else{const project=path.join(h.directory,'native-desktop-project');await fs.mkdir(project);id=(await host.create(project)).sessionId;}
 e.nativeSessionId=id;
 await h.request('/admin/action',{type:'platform.create',payload:{id:platform,name:platform}});member=await h.member(platform,'桌面原对话配对验收');const channel=await h.command('channel.create',{name:'桌面配对',memberIds:[member.id]});
 const grantFile=path.join(dataDir,member.id,'grant.json');await fs.mkdir(path.dirname(grantFile),{recursive:true});await fs.writeFile(grantFile,JSON.stringify({endpoint:h.base,memberId:member.id,access_token:member.token}),{mode:0o600});
 manager.records[member.id]={memberId:member.id,grantFile,enabled:true,sourceReady:true,status:'idle',hostKind:host.kind,chatBindings:{}};await manager.save();
 // Point only the disposable fixture to the already-installed original bridge.
 const bridge=path.join(dataDir,'native-bridges',isAg?'antigravity-desktop':'dsh-desktop');await fs.mkdir(path.dirname(bridge),{recursive:true});await fs.symlink(host.root,bridge);
 const link=await sessions.createLink({memberId:member.id,channelId:channel.id}),input=JSON.parse(link.skill.match(/传入：(\{.+?\})。/)[1]),file=path.join(h.directory,'link.json');await fs.writeFile(file,JSON.stringify(input),{mode:0o600});
 const marker='desktop_'+randomUUID().slice(0,8),command=[process.execPath,path.resolve('connectors/runtime/session-link.mjs')].map(q).join(' ')+' < '+q(file),prompt='专用连接验收：只在这段原对话记住 '+marker+'。请使用本对话终端工具运行以下命令一次，执行后结束本轮，等待 DuolaWork 自动确认。不要修改项目或其他账号，不输出配对码：\n'+command;
 const s=(await host.sessions()).items.find(s=>s.id===id);sessions.start();await manager.start();
 if(isAg)await host.queue({sessionId:id,workspace:s.workspace,prompt});else await host.call('/session-link/prompt',{sessionId:id,workspace:s.workspace,prompt,requestId:'sessionlink_'+randomUUID().replaceAll('-','')});
 await wait(async()=>{const l=await h.request('/v2/session-links?id='+link.id);if(l.status==='failed')throw Error(l.message);return l.status==='completed';},'original desktop confirmation');
 if(manager.records[member.id].chatBindings[channel.id].sessionId!==id)throw Error('Wrong native conversation');e.checks.push('Native desktop tool identifies the current original conversation and completes its own queued confirmation');
 await wait(async()=>!(await host.sessions()).items.find(s=>s.id===id)?.running,'native turn finished');
 await h.command('channel.post',{channelId:channel.id,body:'不读文件，不搜索其他会话。只凭本段原对话记忆回答加入 DuolaWork 前记住的识别词。'});
 const reply=await wait(async()=>{const c=await h.request('/v2/channel?id='+channel.id);return c.messages.find(m=>m.authorId===member.id&&m.body.includes(marker));},'native original-context reply');e.reply=reply.body;e.checks.push('Original desktop conversation replies to Hub using its pre-link context');
 await wait(async()=>!(await host.sessions()).items.find(s=>s.id===id)?.running,'native reply finished');e.finishedAt=new Date().toISOString();console.log(JSON.stringify({passed:true,platform,checks:e.checks}));
}catch(error){e.failure=error.message;console.error(error.message);process.exitCode=1;}
finally{await sessions.stop();await manager.stop();if(member)await manager.disconnect(member.id);await h.stop();await fs.writeFile('evidence/session-link-'+(isAg?'antigravity-desktop':'dsh-desktop')+'-native.json',JSON.stringify(e,null,2)+'\n');}
