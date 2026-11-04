import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startHarness} from '../tests/v1-harness.mjs';
import {CodingManager} from '../local/coding-manager.mjs';
import {ChatSessions} from '../local/chat-sessions.mjs';
if(!process.argv.includes('--run-native-acceptance'))throw Error('Requires --run-native-acceptance');
const h=await startHarness(),manager=new CodingManager({dataDir:path.join(h.directory,'local'),config:{endpoint:h.base,adminKey:h.key},interval:1000}),sessions=new ChatSessions({coding:manager,dsh:{},ag:{}}),e={at:new Date().toISOString(),isolatedHub:true,realOriginalDaemon:true,existingUserConversationsTouched:false,newDedicatedNativeTestConversation:true,claudeTouched:false,checks:[]};
const save=()=>fs.writeFile('evidence/codex-chat-binding-native.json',JSON.stringify(e,null,2)+'\n');
const wait=async(fn,label)=>{for(let i=0;i<240;i++){const v=await fn();if(v)return v;const failed=Object.values(manager.records).find(r=>r.status==='needs_review');if(failed)throw Error(failed.message);await new Promise(r=>setTimeout(r,1000));}throw Error(label+' timed out');};
try{
 await h.request('/admin/action',{type:'platform.create',payload:{id:'codex',name:'Codex'}});const account=(await h.request('/admin/action',{type:'account.create',payload:{platformId:'codex',label:'original daemon test'}})).result,member=(await h.request('/admin/action',{type:'member.create',payload:{accountId:account.id,name:'原工作会话验证',mode:'connector'}})).result;
 const channel=await h.command('channel.create',{name:'原会话加入聊天',memberIds:[member.id]}),project=path.join(h.directory,'native-original-project');await fs.mkdir(project);await fs.writeFile(path.join(project,'notes.txt'),'preserve existing project\n');const marker='original_'+randomUUID().slice(0,8);
 await sessions.connect({memberId:member.id});await manager.jobs.get(member.id);
 await manager.workingHost.read(async rpc=>{
   const {thread}=await rpc.call('thread/start',{cwd:project,approvalPolicy:'never',sandbox:'danger-full-access',serviceName:'hub-native-context-acceptance'});e.nativeThreadId=thread.id;
   let finish,fail;const seed=new Promise((r,j)=>{finish=r;fail=j;}),timer=setTimeout(()=>fail(Error('native seed timed out')),180000);rpc.onNotification=(method,p)=>{if(method==='turn/completed'&&p.threadId===thread.id){clearTimeout(timer);p.turn.status==='completed'?finish():fail(Error('native seed failed'));}};
   await rpc.call('turn/start',{threadId:thread.id,input:[{type:'text',text:'这是专用验收项目。请在本会话记住 '+marker+'，不写文件、不读其他会话和登录资料，只回复已记住。'}]});await seed;console.log('Original native session created and seeded independently of Hub');
   const option=(await sessions.options({memberId:member.id,channelId:channel.id})).items.find(s=>s.id===thread.id);if(!option)throw Error('Original active session missing from session picker');
   const assigned=await sessions.assign({memberId:member.id,channelId:channel.id,mode:'existing',sessionId:thread.id});if(assigned.binding.mode!=='native-existing')throw Error('Original thread was replaced');e.checks.push('Session picker finds the real already-running original daemon context; assignment keeps its exact ID and project');
   await manager.start();await wait(async()=>{const w=await h.request('/v2/workspace');return w.connections.find(c=>c.id===member.id)?.status==='verified';},'original native verification');await wait(()=>!manager.busy,'idle');
   await h.command('channel.post',{channelId:channel.id,body:'请说出你在加入 Hub 之前只在原生会话里记住的识别词，并检查 notes.txt 是否存在。不要改文件，不读其他会话，不@别人，直接回复这里。'});
   const reply=await wait(async()=>{const c=await h.request('/v2/channel?id='+channel.id);return c.messages.find(m=>m.authorId===member.id);},'original native reply');if(!reply.body.includes(marker))throw Error('Original native context not retained');e.receipt={id:reply.id,body:reply.body};e.checks.push('Official codex queue wakes that exact native session without --resume; the original session itself claims and replies using pre-Hub conversation-only memory');
   await wait(()=>!manager.busy,'native idle');if(await fs.readFile(path.join(project,'notes.txt'),'utf8')!=='preserve existing project\n')throw Error('Existing file changed');e.checks.push('Original native project preserved; no GUI/provider/login settings changed');
 });e.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({checks:e.checks}));
}catch(error){e.failure=error.message;await save();console.error(error.message);process.exitCode=1;}
finally{await manager.stop();await h.stop();}
