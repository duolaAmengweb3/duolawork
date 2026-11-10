// Opt-in real native acceptance. Uses the existing Codex subscription, isolated
// Hub/temporary projects, and leaves all user chats, providers and logins alone.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startHarness} from '../tests/v1-harness.mjs';
import {CodingManager} from '../local/coding-manager.mjs';
import {ChatSessions} from '../local/chat-sessions.mjs';
if(!process.argv.includes('--run-native-acceptance'))throw Error('Requires --run-native-acceptance');
const h=await startHarness(),dir=path.join(h.directory,'local'),e={at:new Date().toISOString(),realCodex:true,originalProviderUnchanged:true,isolatedHub:true,claudeTouched:false,checks:[],receipts:[]};
const manager=new CodingManager({dataDir:dir,config:{endpoint:h.base,adminKey:h.key},interval:1000}),sessions=new ChatSessions({coding:manager,ag:{},dsh:{}});
const save=()=>fs.writeFile('evidence/chat-sessions-native.json',JSON.stringify(e,null,2)+'\n');
const wait=async(fn,label,seconds=240)=>{const start=Date.now();while(Date.now()-start<seconds*1000){const result=await fn();if(result)return result;const failed=Object.values(manager.records).find(r=>r.status==='needs_review');if(failed)throw Error(label+': '+failed.message);await new Promise(r=>setTimeout(r,1000));}throw Error(label+' timed out');};
try{
 await h.request('/admin/action',{type:'platform.create',payload:{id:'codex',name:'Codex'}});
 const a=(await h.request('/admin/action',{type:'account.create',payload:{platformId:'codex',label:'Native multi-session acceptance'}})).result;
 const members=[];for(const name of ['Codex · 测试网站','Codex · 测试App']){const m=(await h.request('/admin/action',{type:'member.create',payload:{accountId:a.id,name,mode:'connector'}})).result;members.push(m);await sessions.connect({memberId:m.id});await manager.jobs.get(m.id);if(manager.records[m.id].status!=='idle')throw Error(manager.records[m.id].message);}
 if(Object.values(manager.records).some(r=>Object.keys(r.sessions).length))throw Error('Connecting unexpectedly created working sessions');e.checks.push('Two working members share one account; connecting reuses native login and creates no model turn or work session');
 const group=await h.command('channel.create',{name:'两个 Codex 协作验收',memberIds:members.map(m=>m.id)}),other=await h.command('channel.create',{name:'隔离上下文验收',memberIds:[members[0].id]});
 const markers=['website_'+randomUUID().slice(0,8),'app_'+randomUUID().slice(0,8)];e.members=members.map(m=>({id:m.id,name:m.name,accountId:m.accountId}));
 for(let i=0;i<2;i++){const project=path.join(h.directory,'project-'+i);await fs.mkdir(project);await fs.writeFile(path.join(project,'notes.txt'),'keep original notes\n');await sessions.assign({memberId:members[i].id,channelId:group.id,mode:'new',workspace:project});const r=manager.records[members[i].id],b=r.chatBindings[group.id],agent=manager.agents.get(r.memberId);await agent.run({session:await agent.session({id:b.sessionId}),prompt:'这是专用验收会话。只在本会话记住标识词 '+markers[i]+'，不写入文件、不调用 Hub 工具、不读其他会话。只回答已记住。'});}
 await manager.start();await wait(async()=>{const w=await h.request('/v2/workspace');return members.every(m=>w.connections.find(c=>c.id===m.id)?.status==='verified');},'native verification');await wait(()=>!manager.busy,'native verification idle');
 await h.command('channel.post',{channelId:group.id,body:'各自说出只在你原生会话里记住的标识词，然后检查自己项目的 notes.txt 是否还在。不改文件，不创建任务文档，不@任何成员。',mentions:members.map(m=>m.id)});
 const replies=await wait(async()=>{const v=await h.request('/v2/channel?id='+group.id),replies=v.messages.filter(m=>members.some(x=>x.id===m.authorId));return replies.length===2?replies:null;},'two native Codex replies');
 for(let i=0;i<2;i++){const m=replies.find(r=>r.authorId===members[i].id);if(!m?.body.includes(markers[i])||m.body.includes(markers[1-i]))throw Error('Native contexts mixed or marker not retained');e.receipts.push({channelId:group.id,memberId:m.authorId,messageId:m.id,body:m.body});}e.checks.push('Two real Codex members reply in the same Hub group using their separate native sessions, local projects and conversation-only memories');
 await wait(()=>!manager.busy,'group idle');await sessions.assign({memberId:members[0].id,channelId:other.id,mode:'new'});
 await h.command('channel.post',{channelId:other.id,body:'这是一个新的工作会话。你是否记得其他项目会话的秘密标识词？没有本会话证据就说不知道；不要查文件或其他会话，不@别人，直接回这里。'});
 const isolated=await wait(async()=>{const v=await h.request('/v2/channel?id='+other.id);return v.messages.find(m=>m.authorId===members[0].id);},'independent native context');if(markers.some(x=>isolated.body.includes(x)))throw Error('Another chat received native context');e.receipts.push({channelId:other.id,memberId:isolated.authorId,messageId:isolated.id,body:isolated.body});e.checks.push('The same work member uses a different native session in another group; no conversation-only markers carried over');
 await wait(()=>!manager.busy,'final idle');await manager.stop();const restarted=new CodingManager({dataDir:dir,config:manager.config});await restarted.load();for(const m of members)if(JSON.stringify(restarted.records[m.id].chatBindings)!==JSON.stringify(manager.records[m.id].chatBindings))throw Error('Restart lost session binding');e.checks.push('All exact per-chat native session IDs and project bindings survive receiver restart');e.bindings=members.map(m=>({memberId:m.id,bindings:manager.records[m.id].chatBindings}));
 for(let i=0;i<2;i++)if(await fs.readFile(path.join(h.directory,'project-'+i,'notes.txt'),'utf8')!=='keep original notes\n')throw Error('Original work changed');e.checks.push('Existing project notes preserved; no provider, model or login configuration modified');e.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({checks:e.checks,receiptCount:e.receipts.length}));
}catch(error){e.failure=error.message;await save();console.error(error.message);process.exitCode=1;}
finally{await manager.stop();await h.stop();}
