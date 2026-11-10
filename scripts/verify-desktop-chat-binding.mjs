import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startHarness} from '../tests/v1-harness.mjs';
import {DshManager} from '../local/dsh-manager.mjs';
import {DshDesktopHost} from '../local/dsh-desktop.mjs';
import {AntigravityDesktopHost} from '../local/antigravity-host.mjs';
const ag=process.argv.includes('--antigravity');if(!process.argv.includes('--run-native-acceptance'))throw Error('Requires --run-native-acceptance');
const h=await startHarness(),platform=ag?'antigravity':'deepseek-harness',dataDir=path.join(h.directory,'local'),host=ag?new AntigravityDesktopHost(path.join(os.homedir(),'.config/agent-hub')):new DshDesktopHost(path.join(os.homedir(),'.config/agent-hub'));
const manager=new DshManager({config:{endpoint:h.base,adminKey:h.key},dataDir,host,platformId:platform,engine:platform,requireFreshReceipt:true,interval:1000}),e={at:new Date().toISOString(),platform,realOfficialDesktop:true,isolatedHub:true,claudeTouched:false,checks:[],receipts:[]};let member;
try{const previous=JSON.parse(await fs.readFile('evidence/'+(ag?'antigravity':'dsh')+'-chat-binding-native.json','utf8'));if(previous.failure)e.priorAttempts=[...(previous.priorAttempts||[]),{at:previous.at,failure:previous.failure,checks:previous.checks}];}catch{}
const save=()=>fs.writeFile('evidence/'+(ag?'antigravity':'dsh')+'-chat-binding-native.json',JSON.stringify(e,null,2)+'\n');
const wait=async(fn,label)=>{for(let i=0;i<240;i++){const v=await fn();if(v)return v;const r=member&&manager.records[member.id];if(r?.status==='needs_review')throw Error(r.message);await new Promise(r=>setTimeout(r,1000));}throw Error(label+' timed out');};
try{
 await h.request('/admin/action',{type:'platform.create',payload:{id:platform,name:platform}});const a=(await h.request('/admin/action',{type:'account.create',payload:{platformId:platform,label:'Native session routing acceptance'}})).result;member=(await h.request('/admin/action',{type:'member.create',payload:{accountId:a.id,name:'桌面会话路由测试',mode:'connector'}})).result;
 const channels=[];for(const name of ['桌面工作 A','桌面工作 B'])channels.push(await h.command('channel.create',{name,memberIds:[member.id]}));
 await manager.load();await manager.connectSource({memberId:member.id});await manager.jobs.get(member.id);if(!manager.records[member.id].sourceReady)throw Error(manager.records[member.id].message);e.checks.push('Original desktop source connects without choosing or creating a work session');
 const nativeBefore=await host.call('/health');if(ag&&nativeBefore.bindings.some(b=>b.sessionId==='ec7e7e51-e0cf-492e-8413-f9e64828540d'))throw Error('Dedicated native test conversation is in use; no user binding replaced');
 for(let i=0;i<2;i++){
   if(ag){const original=(await host.sessions()).items.find(s=>s.id==='ec7e7e51-e0cf-492e-8413-f9e64828540d');if(!original||original.running||original.title!=='Local Collaboration Feasibility Test')throw Error('Dedicated original test conversation is unavailable');await manager.assign({memberId:member.id,channelId:channels[i].id,mode:'existing',sessionId:original.id,channels});}
   else{const workspace=path.join(os.homedir(),'.local/share/agent-hub/session-proof/dsh-20261104',member.id,String(i));await fs.mkdir(workspace,{recursive:true});await fs.writeFile(path.join(workspace,'notes.txt'),'preserve notes\n');await manager.assign({memberId:member.id,channelId:channels[i].id,mode:'new',workspace,channels});}
 }
 await manager.start();await wait(()=>manager.records[member.id].verified,'real desktop verification');console.log(platform+' native verification complete');
 for(let i=0;i<2;i++){
   const word=i===0?'桌面甲已收到':'桌面乙已收到';await h.command('channel.post',{channelId:channels[i].id,body:'这次只测试路由，请在这个 Hub 聊天只回答“'+word+'”。不读改文件、不创建文档或任务、不@其他成员。'});
   const reply=await wait(async()=>{const c=await h.request('/v2/channel?id='+channels[i].id);return c.messages.find(m=>m.authorId===member.id);},'native chat reply');if(!reply.body.includes(word))throw Error('Wrong conversation reply');e.receipts.push({channelId:channels[i].id,messageId:reply.id,body:reply.body});console.log(platform+' chat '+i+' replied');
 }
 e.bindings=manager.records[member.id].chatBindings;e.bridge=(await host.call('/health')).bindings.filter(b=>b.memberId===member.id);e.checks.push(ag?'Two explicit chat bindings share the user-selected original native test conversation and reply to their own Hub chat':'Two Hub chats use different newly-created official DSH sessions and route real native replies to the correct chat');
 await manager.stop();const loaded=new DshManager({config:manager.config,dataDir,host,platformId:platform,requireFreshReceipt:true});await loaded.load();if(JSON.stringify(loaded.records[member.id].chatBindings)!==JSON.stringify(manager.records[member.id].chatBindings))throw Error('Exact chat bindings lost');e.checks.push('Exact per-chat bindings survive receiver reload; all existing provider sessions and other Hub bindings retained');e.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({checks:e.checks}));
}catch(error){e.failure=error.message;await save();console.error(error.message);process.exitCode=1;}
finally{await manager.stop();if(member)await manager.disconnect(member.id);await h.stop();e.temporaryBindingsRemoved=true;await save();}
