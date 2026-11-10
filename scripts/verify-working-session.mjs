// Feasibility only: a live, existing native session joins collaboration.
// No production receiver, IDE profile, provider settings or user repository is changed.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import WebSocket from 'ws';
import {findExecutable,safeError} from '../local/native-agent.mjs';
import {startHarness} from '../tests/v1-harness.mjs';
if(process.argv.length!==3||process.argv[2]!=='--run-isolated-proof')throw new Error('Requires --run-isolated-proof; creates a disposable project and consumes native Codex turns, without touching existing user conversations');
const exec=promisify(execFile),h=await startHarness();
const project=await fs.mkdtemp(path.join(os.tmpdir(),'hub-working-session-proof-'));
const evidence={at:new Date().toISOString(),scope:'Real Codex on the existing local daemon plus isolated real Hub Worker/D1. Existing GUI attachment is NOT proven by this test.',realNativeAgent:true,realGUI:false,isolatedHub:true,productionConfigurationChanged:false,project,checks:[]};
const receiptFile=path.resolve('evidence/working-session.json');
try{const prior=JSON.parse(await fs.readFile(receiptFile,'utf8'));if(prior.failure)evidence.priorSetupFailures=[...(prior.priorSetupFailures||[]),{at:prior.at,message:prior.failure}];}catch{}
const save=()=>fs.writeFile(receiptFile,JSON.stringify(evidence,null,2)+'\n');
let rpc,threadId,watch,hubCalls=[];
// The daemon's application socket is WebSocket-over-UDS, not NDJSON.
// The supervisor control socket is a different service. Do not restart either.
function existingSocket(){
 const pids=execFileSync('/bin/ps',['-ax','-o','pid=,command='],{encoding:'utf8'}).split('\n').flatMap(row=>{
  const m=row.match(/^\s*(\d+)\s+(.+)$/);return m&&m[2].startsWith(path.join(os.homedir(),'.codex/packages/app-server-daemon/'))&&m[2].includes('--listen unix://')?[m[1]]:[];
 });
 const sockets=[...new Set(pids.flatMap(pid=>execFileSync('/usr/sbin/lsof',['-a','-p',pid,'-U','-Fn'],{encoding:'utf8'}).split('\n').filter(x=>x.startsWith('n/private/tmp/codex-daemon-'+process.getuid()+'/')).map(x=>x.slice(1))))];
 if(sockets.length!==1)throw new Error('Existing daemon socket is missing or ambiguous; no default session selected');
 return sockets[0];
}
class LiveSocketRpc extends EventEmitter{
 constructor(socket){super();this.pending=new Map();this.nextId=0;this.ws=new WebSocket('ws://localhost/',{createConnection:()=>net.createConnection(socket),handshakeTimeout:10000});this.ready=new Promise((resolve,reject)=>{this.ws.once('open',resolve);this.ws.once('error',reject)});this.ws.on('message',raw=>{const m=JSON.parse(String(raw));if(m.id!==undefined&&(m.result!==undefined||m.error)){const p=this.pending.get(String(m.id));if(p){this.pending.delete(String(m.id));clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}}else if(m.id!==undefined){Promise.resolve().then(()=>this.onRequest(m.method,m.params)).then(result=>this.send({jsonrpc:'2.0',id:m.id,result})).catch(e=>this.send({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:safeError(e)}}));}else this.emit('notification',m.method,m.params||{});});}
 send(m){if(this.ws.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify(m));}
 async call(method,params={},timeout=60000){await this.ready;const id=++this.nextId;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(String(id));reject(new Error('Native socket call timed out: '+method));},timeout);this.pending.set(String(id),{resolve,reject,timer});this.send({jsonrpc:'2.0',id,method,params});});}
 async stop(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Verification client closed'));}this.pending.clear();this.ws.close();}
}
function waitTurn(timeout=240000){
 if(watch)throw new Error('A turn is already being observed');
 let timer;
 const p=new Promise((resolve,reject)=>{
  watch={text:'',resolve:v=>{clearTimeout(timer);watch=null;resolve(v);},reject:e=>{clearTimeout(timer);watch=null;reject(e);}};
  timer=setTimeout(()=>watch?.reject(new Error('Observed native turn timed out')),timeout);
 });
 p.catch(()=>{});return p;
}
try{
 const codex=await findExecutable('codex');
 await fs.writeFile(path.join(project,'package.json'),JSON.stringify({type:'module',scripts:{test:'node test.mjs'}}));
 await fs.writeFile(path.join(project,'scale.mjs'),'export const scale = value => value * 2;\n');
 await fs.writeFile(path.join(project,'test.mjs'),"import assert from 'node:assert/strict';\nimport {scale} from './scale.mjs';\nassert.equal(scale(4),12);\nconsole.log('project tests passed');\n");
 await fs.writeFile(path.join(project,'notes.txt'),'Existing uncommitted user work: preserve this file.\n');
 await fs.writeFile(path.join(project,'AGENTS.md'),'This is a disposable feasibility repository. Read project files and run npm test. Keep notes.txt unchanged. Only edit files inside this repository. Never inspect provider settings, credentials or other projects.\n');
 await exec('git',['init','-b','proof-existing-work'],{cwd:project});
 await exec('git',['add','package.json','scale.mjs','test.mjs','AGENTS.md'],{cwd:project});
 await exec('git',['-c','user.name=Hub Verification','-c','user.email=verification@example.invalid','commit','-m','Initial failing task'],{cwd:project});
 await h.request('/admin/action',{type:'platform.create',payload:{id:'codex',name:'Codex',entryUrl:'https://chatgpt.com/'}});
 const member=await h.member('codex','原工作会话测试'),channel=await h.command('channel.create',{name:'已有工作会话协作验证',memberIds:[member.id],wakeIntervalSeconds:0});
 const listed=await h.request('/v2/mcp',{jsonrpc:'2.0',id:1,method:'tools/list',params:{}},member.token);
 const tools=listed.result.tools;
 const socket=existingSocket();evidence.nativeTransport='WebSocket over original daemon Unix socket';
 rpc=new LiveSocketRpc(socket);
 rpc.onRequest=async(method,p)=>{
  if(method!=='item/tool/call'||p.threadId!==threadId||!p.tool?.startsWith('hub_'))throw new Error('Unexpected request: '+method);
  const name=p.tool.slice(4);hubCalls.push(name);
  try{return{contentItems:[{type:'inputText',text:JSON.stringify(await member.call(name,p.arguments))}],success:true};}
  catch(e){return{contentItems:[{type:'inputText',text:safeError(e)}],success:false};}
 };
 rpc.on('notification',(method,p)=>{
  if(!watch||p.threadId&&p.threadId!==threadId)return;
  if(method==='item/completed'&&p.item?.type==='agentMessage')watch.text=p.item.text||watch.text;
  if(method==='turn/completed'){
   if(p.turn.status!=='completed')watch.reject(new Error(p.turn.error?.message||p.turn.status));
   else watch.resolve({turnId:p.turn.id,text:watch.text});
  }
 });
 await rpc.call('initialize',{clientInfo:{name:'agent-hub-existing-session-proof',version:'1.0'},capabilities:{experimentalApi:true}});
 rpc.send({jsonrpc:'2.0',method:'initialized',params:{}});
 const started=await rpc.call('thread/start',{cwd:project,approvalPolicy:'never',sandbox:'workspace-write',dynamicTools:tools.map(t=>({name:'hub_'+t.name,description:t.description,inputSchema:t.inputSchema})),serviceName:'hub-existing-session-feasibility'});
 threadId=started.thread.id;evidence.threadId=threadId;evidence.model=started.model;evidence.provider=started.modelProvider;
 const context='context_'+randomUUID().slice(0,12);
 console.log('Step 1: native session works in its local project');
 let waiting=waitTurn();
 await rpc.call('turn/start',{threadId,input:[{type:'text',text:`You are already working in this local repository. Read AGENTS.md and the project, fix scale.mjs so npm test passes, run npm test, preserve the pre-existing notes.txt and Git branch. Remember this conversation-only identifier: ${context}. Do not write it to any file. Briefly report the actual change and test result. Do not use Hub tools yet.`}]});
 evidence.originalWork=await waiting;
 await exec('npm',['test'],{cwd:project});
 evidence.initialDiff=(await exec('git',['diff','--','scale.mjs'],{cwd:project})).stdout;
 const before=await fs.readFile(path.join(project,'notes.txt'),'utf8');
 evidence.checks.push('Existing native session changed the local project, passed its test and kept pre-existing user work');await save();
 console.log('Step 2: Hub queues a message into that same live session');
 const userMessage=await h.command('channel.post',{channelId:channel.id,body:'请结合当前项目修改和测试结果汇报，并说出原会话里记住的识别词。只沟通，不修改项目文件。'});
 waiting=waitTurn();
 const queued=await exec(codex,['queue','--remote','unix://'+socket,'--thread',threadId,'--message',`This is a Hub collaboration message for your EXISTING local working session, not a new task environment. Use hub_list_work to find only channelId=${channel.id}, claim its ready work, then use hub_post_message with the claim's turnId to reply in that same channel. Describe your actual prior code change and test result, and include the conversation-only identifier you were told to remember earlier. Do not read another conversation, do not reconstruct from a transcript file, and do not modify project files. Do not mention other members or create tasks/documents.`],{cwd:project,timeout:30000});
 evidence.queue={exitSucceeded:true,stdout:safeError(queued.stdout)};
 evidence.collaborationTurn=await waiting;
 const view=await h.request('/v2/channel?id='+channel.id),reply=view.messages.find(m=>m.authorId===member.id&&m.number>userMessage.number);
 if(!reply?.body.includes(context))throw new Error('Same-session context was not delivered back to Hub');
 for(const name of ['list_work','claim_work','post_message'])if(!hubCalls.includes(name))throw new Error('Native agent did not call '+name);
 evidence.hub={channelId:channel.id,messageId:userMessage.id,replyId:reply.id,reply:reply.body,tools:hubCalls};
 if(await fs.readFile(path.join(project,'notes.txt'),'utf8')!==before)throw new Error('Existing user work changed');
 evidence.checks.push('External codex queue woke the SAME live session; it remembered prior conversation context and itself claimed/replied to the actual isolated Hub');await save();
 console.log('Step 3: original native client continues local work');
 waiting=waitTurn();
 await rpc.call('turn/start',{threadId,input:[{type:'text',text:'Continue normal local development after the Hub discussion. Add an assertion for scale(0) === 0 to the existing test.mjs, run npm test, keep scale.mjs and notes.txt unchanged. Briefly report the actual result; do not use Hub tools.'}]});
 evidence.continuedWork=await waiting;await exec('npm',['test'],{cwd:project});
 if(!(await fs.readFile(path.join(project,'test.mjs'),'utf8')).includes('scale(0)'))throw new Error('Original project work did not continue');
 const read=await rpc.call('thread/read',{threadId});
 if(await fs.realpath(read.thread.cwd)!==await fs.realpath(project))throw new Error('Working directory changed');
 evidence.sameThread=read.thread.id===threadId;evidence.sameCwd=await fs.realpath(read.thread.cwd)===await fs.realpath(project);
 evidence.branch=(await exec('git',['branch','--show-current'],{cwd:project})).stdout.trim();
 if(evidence.branch!=='proof-existing-work'||await fs.readFile(path.join(project,'notes.txt'),'utf8')!==before)throw new Error('Original environment was not preserved');
 evidence.finalDiff=(await exec('git',['diff'],{cwd:project})).stdout;
 evidence.checks.push('Original client continued the same thread and original repository after collaboration; branch, uncommitted work and project tests preserved');
 evidence.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({checks:evidence.checks,threadId,project,realGUI:false}));
}catch(e){evidence.failure=safeError(e);await save();throw e;}
finally{await rpc?.stop();await h.stop();}
