// Explicit native acceptance: two new dedicated threads, one account/member,
// separate projects and Hub channels. Never reads/modifies existing user work.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startHarness} from './v1-harness.mjs';
import {CodingManager} from '../local/coding-manager.mjs';
import {ChatSessions} from '../local/chat-sessions.mjs';
if(!process.argv.includes('--run-native-acceptance'))throw Error('Explicit native flag required');
const h=await startHarness(),manager=new CodingManager({dataDir:path.join(h.directory,'local'),config:{endpoint:h.base,adminKey:h.key},interval:500}),sessions=new ChatSessions({coding:manager,dsh:{},ag:{}});
const e={at:new Date().toISOString(),isolatedHub:true,realOriginalCodex:true,existingUserConversationsTouched:false,claudeTouched:false,checks:[]};
const wait=async(fn,label)=>{const deadline=Date.now()+240000;while(Date.now()<deadline){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,500));}throw Error(label+' timed out');};
const q=s=>"'"+s.replaceAll("'","'\\''")+"'";
try{
 await h.request('/admin/action',{type:'platform.create',payload:{id:'codex',name:'Codex'}});
 const account=(await h.request('/admin/action',{type:'account.create',payload:{platformId:'codex',label:'native parallel acceptance'}})).result;
 const member=(await h.request('/admin/action',{type:'member.create',payload:{accountId:account.id,name:'原 Codex 并发验收',mode:'connector'}})).result;
 await sessions.connect({memberId:member.id});await manager.jobs.get(member.id);sessions.start();await manager.start();
 const cases=[];
 for(const label of ['A','B']){
  const channel=await h.command('channel.create',{name:'并发独立项目 '+label,memberIds:[member.id]}),project=path.join(h.directory,'native-'+label),marker=label+'_'+randomUUID().slice(0,8);await fs.mkdir(project);await fs.writeFile(path.join(project,'scope.txt'),marker+'\n');
  await manager.workingHost.read(async rpc=>{
   const {thread}=await rpc.call('thread/start',{cwd:project,approvalPolicy:'never',sandbox:'danger-full-access',serviceName:'hub-parallel-acceptance'});
   const turn=async text=>{let finish,fail;const ended=new Promise((r,j)=>{finish=r;fail=j;}),timer=setTimeout(()=>fail(Error('native setup timeout')),180000);rpc.onNotification=(method,p)=>{if(method==='turn/completed'&&p.threadId===thread.id){clearTimeout(timer);p.turn.status==='completed'?finish():fail(Error('native setup failed'));}};await rpc.call('turn/start',{threadId:thread.id,input:[{type:'text',text}]});await ended;};
   await turn('这是专用并发验收对话。记住识别词 '+marker+'。不读其他会话、不写文件，只回复已记住。');
   const link=await sessions.createLink({memberId:member.id,channelId:channel.id}),input=JSON.parse(link.skill.match(/传入：(\{.+?\})。/)[1]),file=path.join(h.directory,'link-'+label+'.json');await fs.writeFile(file,JSON.stringify(input),{mode:0o600});
   await turn('用自己的终端执行一次以下命令，然后结束，等原通道确认。不打印配对码或凭证，不读其他项目：\n'+[process.execPath,path.resolve('connectors/runtime/session-link.mjs')].map(q).join(' ')+' < '+q(file));await fs.rm(file);
   await wait(async()=>{const l=await h.request('/v2/session-links?id='+link.id);if(l.status==='failed')throw Error(l.message);return l.status==='completed';},'current-thread binding');
   assert.equal(manager.records[member.id].chatBindings[channel.id].sessionId,thread.id);cases.push({channelId:channel.id,sessionId:thread.id,project,marker});
  });await wait(()=>!manager.busy,'setup idle');
 }
 await Promise.all(cases.map(c=>h.command('channel.post',{channelId:c.channelId,body:'专用并发验收：先用自己的终端执行 sleep 5，再读取当前目录 scope.txt，并回到本群报告加入前的识别词和文件内容。只处理本次，不访问其他项目或会话，不改文件，不建文档任务。'})));
 let peak=0;
 await wait(async()=>{
  const state=await Promise.all(cases.map(c=>h.request('/v2/channel?id='+c.channelId)));
  peak=Math.max(peak,state.filter(c=>c.activity.some(t=>t.memberId===member.id&&t.status==='active')).length);
  return state.every((c,i)=>c.messages.some(m=>m.authorId===member.id&&m.body.includes(cases[i].marker)));
 },'independent replies');
 for(const c of cases){const d=await h.request('/v2/channel?id='+c.channelId),other=cases.find(x=>x!==c),reply=d.messages.find(m=>m.authorId===member.id&&m.body.includes(c.marker));assert.ok(!reply.body.includes(other.marker));assert.equal(await fs.readFile(path.join(c.project,'scope.txt'),'utf8'),c.marker+'\n');c.reply=reply.body;}
 assert.equal(peak,2,'two actual native threads must overlap in claimed execution');
 await wait(()=>!manager.busy,'native completion');e.peakActive=peak;e.conversations=cases;e.checks=['One connected account/member binds two distinct original conversations','Two real native executions overlap without cross-project or memory mix','Both replies return to their own Hub channel and original files are unchanged'];e.finishedAt=new Date().toISOString();console.log(JSON.stringify({passed:true,peak,checks:e.checks}));
}catch(error){e.failure=error.message;console.error(error);process.exitCode=1;}
finally{await sessions.stop();await manager.stop();await h.stop();await fs.writeFile('evidence/codex-native-concurrency.json',JSON.stringify(e,null,2)+'\n');}
