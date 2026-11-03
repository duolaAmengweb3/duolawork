// Real native DSH Web Host plus an isolated actual Hub Worker/D1.
// API credentials remain in the external private runtime configuration.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {startHarness} from '../tests/v1-harness.mjs';
if(process.argv[2]!=='--run-isolated-proof')throw Error('Requires explicit --run-isolated-proof');
const root=path.join(os.homedir(),'.local/share/agent-hub/deepseek-proof'),project=path.join(root,'project');
const control=JSON.parse(await fs.readFile(path.join(root,'connector.json'),'utf8'));
const modelConfig=JSON.parse(await fs.readFile(path.join(os.homedir(),'.config/agent-hub-dsh-test/model.json'),'utf8'));
const installed=JSON.parse(await fs.readFile(path.join(root,'npm/node_modules/@deepseek-ai/dsh/package.json'),'utf8'));
const h=await startHarness(),exec=promisify(execFile);
const evidence={at:new Date().toISOString(),runtime:`Official @deepseek-ai/dsh ${installed.version} Web Host`,model:modelConfig.model,provider:`B.AI via native ${modelConfig.protocol} adapter`,project,productionHubChanged:false,claudeTouched:false,checks:[],guiCreated:false};
const save=()=>fs.writeFile('evidence/dsh-working-session.json',JSON.stringify(evidence,null,2)+'\n');
async function api(route,body){const r=await fetch(control.controlUrl+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.controlToken,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(route+': '+JSON.stringify(d));return d;}
function textOf(state){return(state.events||[]).filter(e=>e.type==='assistant/message').flatMap(e=>(e.data?.message?.content||e.data?.content||[]).filter(c=>c.type==='text').map(c=>c.text)).join('\n');}
async function turn(text){
 const before=await api('/proof/state',{sessionId:evidence.sessionId});const seq=before.events.at(-1)?.seq??-1;
 await api('/proof/prompt',{sessionId:evidence.sessionId,text,requestId:randomUUID()});
 const started=Date.now();while(Date.now()-started<300000){
  const state=await api('/proof/state',{sessionId:evidence.sessionId});
  const ended=state.events.find(e=>e.type==='turn/end'&&e.seq>seq);
  if(ended&&!state.item.running)return{seconds:(Date.now()-started)/1000,text:textOf({...state,events:state.events.filter(e=>e.seq>seq)}),state,ended};
  await new Promise(r=>setTimeout(r,1500));
 }throw Error('Native DSH turn did not finish within five minutes');
}
let member,bound=false;
try{
 if(process.argv.includes('--resume')){
  const original=JSON.parse(await fs.readFile('evidence/dsh-working-session.json','utf8'));Object.assign(evidence,original);
  const expected=original.hub.reply.match(/dsh_context_[a-f0-9]+/)?.[0];if(!expected)throw Error('Missing prior conversation proof');
  const native=await api('/sessions');if(!native.items.some(s=>s.sessionId===evidence.sessionId))throw Error('Original persisted session disappeared after Host restart');
  await h.request('/admin/action',{type:'platform.create',payload:{id:'deepseek-harness',name:'DeepSeek Harness'}});
  member=await h.member('deepseek-harness','重启后原 DSH 会话');const channel=await h.command('channel.create',{name:'DSH 原会话重启恢复验证',memberIds:[member.id],wakeIntervalSeconds:0});
  const grantFile=path.join(h.directory,'dsh-member.json');await fs.writeFile(grantFile,JSON.stringify({endpoint:h.base,memberId:member.id,access_token:member.token}),{mode:0o600});
  await api('/bind',{sessionId:evidence.sessionId,workspace:project,grantFile});bound=true;
  const message=await h.command('channel.post',{channelId:channel.id,body:'请直接说出我们之前只在会话里记住的识别词，并简短说出之前在当前项目做过的实际修改和测试。不改文件，不建任务或文档。'});
  let reply;const started=Date.now();while(Date.now()-started<300000){const v=await h.request('/v2/channel?id='+channel.id);reply=v.messages.find(m=>m.authorId===member.id&&m.number>message.number);if(reply)break;await new Promise(r=>setTimeout(r,1500));}
  if(!reply?.body.includes(expected))throw Error('Restarted Host did not resume original conversation context');
  const restartHistory=[...(evidence.restartVerifications||[])];
  if(evidence.restartVerification&&!restartHistory.some(x=>x.at===evidence.restartVerification.at))restartHistory.push(evidence.restartVerification);
  evidence.restartVerification={at:new Date().toISOString(),sessionId:evidence.sessionId,replyId:reply.id,reply:reply.body,seconds:(Date.now()-started)/1000};
  evidence.restartVerifications=[...restartHistory,evidence.restartVerification];await save();console.log(JSON.stringify({restartPassed:true,sessionId:evidence.sessionId}));
 }else{
 await fs.writeFile(path.join(project,'package.json'),JSON.stringify({type:'module',scripts:{test:'node test.mjs'}}));
 await fs.writeFile(path.join(project,'scale.mjs'),'export const scale = n => n * 2;\n');
 await fs.writeFile(path.join(project,'test.mjs'),"import assert from 'node:assert/strict';\nimport {scale} from './scale.mjs';\nassert.equal(scale(4),12);\nconsole.log('project tests passed');\n");
 const notes=await fs.readFile(path.join(project,'notes.txt'),'utf8');
 await exec('git',['init','-b','proof-existing-work'],{cwd:project});
 await exec('git',['add','AGENTS.md','README.md','package.json','scale.mjs','test.mjs'],{cwd:project});
 await exec('git',['-c','user.name=Hub Verification','-c','user.email=verification@example.invalid','commit','-m','Initial isolated DSH work task'],{cwd:project});
 const created=await api('/proof/create',{workspace:project});evidence.sessionId=created.sessionId;await save();
 const marker='dsh_context_'+randomUUID().slice(0,8);
 console.log('1. Original native DSH session is working in its local project');
 const first=await turn(`Read AGENTS.md and the current project. Fix scale.mjs so npm test passes and actually run npm test. Preserve notes.txt and Git branch proof-existing-work. Remember this conversation-only marker: ${marker}. Do not write it to any file. Do not inspect credentials, other sessions or projects. No Hub work yet. Briefly report actual results.`);
 await exec('npm',['test'],{cwd:project});
 evidence.originalWork={seconds:first.seconds,text:first.text,turnEnd:first.ended};evidence.checks.push('Original DSH Web Host session changed local code and passed npm test before Hub attachment');await save();
 await h.request('/admin/action',{type:'platform.create',payload:{id:'deepseek-harness',name:'DeepSeek Harness'}});
 member=await h.member('deepseek-harness','原 DSH 工作会话');
 const channel=await h.command('channel.create',{name:'DSH 原会话接入验证',memberIds:[member.id],wakeIntervalSeconds:0});
 const grantFile=path.join(h.directory,'dsh-member.json');await fs.writeFile(grantFile,JSON.stringify({endpoint:h.base,memberId:member.id,access_token:member.token}),{mode:0o600});
 await api('/bind',{sessionId:evidence.sessionId,workspace:project,grantFile});bound=true;
 console.log('2. Native Host connector automatically wakes the exact original session');
 const userMessage=await h.command('channel.post',{channelId:channel.id,body:'请汇报你刚才实际做的代码修改、真实测试结果，并说出本会话之前记住的识别词。只在这里回复，不修改文件、不创建任务或文档。'});
 let reply;const started=Date.now();
 while(Date.now()-started<300000){
  const view=await h.request('/v2/channel?id='+channel.id);reply=view.messages.find(m=>m.authorId===member.id&&m.number>userMessage.number);
  if(reply)break;await new Promise(r=>setTimeout(r,1500));
 }
 if(!reply)throw Error('Native DSH session did not reply to actual Hub');
 if(!reply.body.includes(marker))throw Error('Reply does not preserve original conversation-only context');
 const health=await api('/health');const b=health.bindings.find(b=>b.sessionId===evidence.sessionId);
 for(const tool of ['list_work','claim_work','post_message'])if(!b.toolCalls.some(c=>c.name===tool))throw Error('DSH did not itself call '+tool);
 evidence.hub={channelId:channel.id,messageId:userMessage.id,replyId:reply.id,reply:reply.body,seconds:(Date.now()-started)/1000,tools:b.toolCalls,dispatches:health.dispatches};
 evidence.checks.push('Automatic connector queued the original session; its scoped native Hub tools claimed and replied with original conversation context');await save();
 // Wait for the original native turn to settle before continuing local work.
 for(let n=0;n<120;n++){const s=await api('/proof/state',{sessionId:evidence.sessionId});if(!s.item.running)break;await new Promise(r=>setTimeout(r,500));}
 console.log('3. Original DSH session continues local development after collaboration');
 const last=await turn('Continue normal local work in this same session and project. Add an assertion scale(0) === 0 to test.mjs and run npm test. Keep scale.mjs, notes.txt and the current Git branch unchanged. Do not use Hub tools for this turn. Briefly report actual results.');
 await exec('npm',['test'],{cwd:project});
 if(!await fs.readFile(path.join(project,'test.mjs'),'utf8').then(s=>s.includes('scale(0)')))throw Error('Original project work did not continue');
 if(await fs.readFile(path.join(project,'notes.txt'),'utf8')!==notes)throw Error('Pre-existing note changed');
 evidence.branch=(await exec('git',['branch','--show-current'],{cwd:project})).stdout.trim();if(evidence.branch!=='proof-existing-work')throw Error('Original branch changed');
 evidence.continuedWork={seconds:last.seconds,text:last.text,sessionId:last.state.item.sessionId,cwd:last.state.item.cwd};
 if(last.state.item.sessionId!==evidence.sessionId||await fs.realpath(last.state.item.cwd)!==await fs.realpath(project))throw Error('Native session or project changed');
 evidence.checks.push('Same original native DSH session continued local code work and passed tests; project, branch and pre-existing note preserved');evidence.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({checks:evidence.checks,sessionId:evidence.sessionId}));
 }
}catch(error){evidence.failure=String(error.message).replace(/sk-[A-Za-z0-9_-]+/g,'[hidden]').slice(0,2000);await save();console.log(JSON.stringify({failure:evidence.failure}));process.exitCode=1;}
finally{
 if(bound)await api('/unbind',{sessionId:evidence.sessionId}).catch(()=>{});
 await h.stop();evidence.isolatedMemberGrantRemoved=true;await save();
}
