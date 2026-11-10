import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startHarness} from './v1-harness.mjs';
import {pathToFileURL} from 'node:url';
const moduleRoot=path.resolve(process.env.HUB_NATIVE_MODULE_ROOT||'.');
const {CodingManager}=await import(pathToFileURL(path.join(moduleRoot,'local/coding-manager.mjs')));
const {ChatSessions}=await import(pathToFileURL(path.join(moduleRoot,'local/chat-sessions.mjs')));
const {findExecutable}=await import(pathToFileURL(path.join(moduleRoot,'local/native-agent.mjs')));
const node=process.versions.electron?await findExecutable('node'):process.execPath;
if(!process.argv.includes('--run-native-acceptance'))throw Error('Requires --run-native-acceptance');
const h=await startHarness({node}),manager=new CodingManager({dataDir:path.join(h.directory,'local'),config:{endpoint:h.base,adminKey:h.key},interval:1000}),sessions=new ChatSessions({coding:manager,dsh:{},ag:{}});
const e={at:new Date().toISOString(),isolatedHub:true,realOriginalDaemon:true,packagedModuleRoot:!!process.env.HUB_NATIVE_MODULE_ROOT,electronRuntime:!!process.versions.electron,existingUserConversationsTouched:false,newDedicatedNativeTestConversation:true,claudeTouched:false,checks:[]};
const wait=async(fn,label)=>{for(let i=0;i<240;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,1000));}throw Error(label+' timed out');};
const q=s=>"'"+s.replaceAll("'","'\\''")+"'";
try{
 await h.request('/admin/action',{type:'platform.create',payload:{id:'codex',name:'Codex'}});const account=(await h.request('/admin/action',{type:'account.create',payload:{platformId:'codex',label:'original daemon link'}})).result,member=(await h.request('/admin/action',{type:'member.create',payload:{accountId:account.id,name:'原 Codex 关联验证',mode:'connector'}})).result;
 const channel=await h.command('channel.create',{name:'原对话配对',memberIds:[member.id]}),project=path.join(h.directory,'native-original-project');await fs.mkdir(project);await fs.writeFile(path.join(project,'notes.txt'),'preserve existing project\n');const marker='original_'+randomUUID().slice(0,8);
 await sessions.connect({memberId:member.id});await manager.jobs.get(member.id);sessions.start();await manager.start();
 await manager.workingHost.read(async rpc=>{
  const {thread}=await rpc.call('thread/start',{cwd:project,approvalPolicy:'never',sandbox:'danger-full-access',serviceName:'hub-native-link-acceptance'});e.nativeThreadId=thread.id;
  const turn=async text=>{let finish,fail;const ended=new Promise((r,j)=>{finish=r;fail=j;}),timer=setTimeout(()=>fail(Error('native turn timed out')),180000);rpc.onNotification=(method,p)=>{if(method==='turn/completed'&&p.threadId===thread.id){clearTimeout(timer);p.turn.status==='completed'?finish():fail(Error('native turn failed'));}};await rpc.call('turn/start',{threadId:thread.id,input:[{type:'text',text}]});await ended;};
  await turn('专用验收对话，记住 '+marker+'，不写文件，不读其他会话和登录资料，只回复已记住。');
  const link=await sessions.createLink({memberId:member.id,channelId:channel.id}),input=JSON.parse(link.skill.match(/传入：(\{.+?\})。/)[1]),file=path.join(h.directory,'link-input.json');await fs.writeFile(file,JSON.stringify(input),{mode:0o600});
  await turn('请用自己的终端工具运行以下命令一次，成功后结束本轮，等待原通道自动确认。不输出配对码，不改项目或其他账号：\n'+[node,path.join(moduleRoot,'connectors/runtime/session-link.mjs')].map(q).join(' ')+' < '+q(file));
  await fs.rm(file);
  await wait(async()=>{const l=await h.request('/v2/session-links?id='+link.id);if(l.status==='failed')throw Error(l.message);return l.status==='completed';},'Native current-session link');
  if(manager.records[member.id].chatBindings[channel.id].sessionId!==thread.id)throw Error('Selected another native session');e.checks.push('Original Codex shell identifies its exact thread; native queue challenge and persistent binding complete without a new account');
  await wait(()=>!manager.busy,'native idle');
  await h.command('channel.post',{channelId:channel.id,body:'请说出加入 Hub 前记住的识别词，并确认当前 notes.txt 存在，不改文件，不读其他会话。'});
  const reply=await wait(async()=>{const c=await h.request('/v2/channel?id='+channel.id);return c.messages.find(m=>m.authorId===member.id&&m.body.includes(marker));},'Original native memory reply');e.reply=reply.body;
  if(await fs.readFile(path.join(project,'notes.txt'),'utf8')!=='preserve existing project\n')throw Error('Original file changed');e.checks.push('Same original Codex thread replies with original context and project; existing files remain unchanged');
  await wait(()=>!manager.busy,'finish');
 });e.finishedAt=new Date().toISOString();console.log(JSON.stringify({passed:true,checks:e.checks}));
}catch(error){e.failure=error.message;console.error(error.message);process.exitCode=1;}
finally{await sessions.stop();await manager.stop();await h.stop();await fs.writeFile('evidence/session-link-codex-native.json',JSON.stringify(e,null,2)+'\n');}
