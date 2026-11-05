// Opt-in native proof: isolated original official Harness, real test model,
// actual Hub protocol. Never reads or runs the user's subscription Claude.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {startHarness} from './v1-harness.mjs';
import {privateJson} from '../local/storage.mjs';
import {DshOriginalHost} from '../local/dsh-original-host.mjs';
import {CodingMemberClient} from '../local/coding-client.mjs';

if(process.env.DUOLAWORK_DSH_NATIVE_TEST!=='1')throw Error('Requires DUOLAWORK_DSH_NATIVE_TEST=1');
const nativeRoot=path.join(os.homedir(),'.local/share/agent-hub/deepseek-proof/npm');
const model=JSON.parse(await fs.readFile(path.join(os.homedir(),'.config/agent-hub-dsh-test/model.json'),'utf8'));
const h=await startHarness(),dir=path.join(h.directory,'native-dsh'),home=path.join(dir,'home'),project=path.join(dir,'project'),runtimeRoot=path.join(dir,'receivers');
await fs.mkdir(project,{recursive:true});
const stateFile=path.join(dir,'proof-control.json'),patchFile=path.join(dir,'test-native-patch.json');
await privateJson(stateFile,{controlToken:randomBytes(32).toString('base64url'),bindings:[],proofWorkspace:project});
await privateJson(patchFile,[{id:'llm-pi-ai',config:{providers:{'b-ai':{apiKeyEnv:'BAI_API_KEY',displayName:'B.ai',api:'openai-completions',baseURL:model.baseUrl,models:[{id:model.model,name:model.model,contextWindow:131072,maxTokens:4096}]}}}},{id:'agent-default-model',config:{provider:'b-ai',model:model.model}},{id:'session-log-deepseek',disabled:true},{insert:[{id:'isolated-acceptance',name:path.resolve('local/dsh-connector.mjs'),config:{stateFile,allowProof:true}}]}]);
const log=await fs.open(path.join(dir,'native.log'),'w',0o600),env={...process.env,DSH_HOME:home,BAI_API_KEY:model.apiKey,AGENT_HUB_CONNECTOR_TEST:'1',DUOLAWORK_RUNTIME_DIR:runtimeRoot};delete env.ELECTRON_RUN_AS_NODE;
const cli=path.join(nativeRoot,'node_modules/@deepseek-ai/dsh/lib/bin.js');
const launch=()=>spawn(process.execPath,[cli,'web','--patch',patchFile,'--no-open','--host','127.0.0.1','--port','0'],{cwd:project,env,stdio:['ignore',log.fd,log.fd]});
let native=launch(),receiver;
const evidence={at:new Date().toISOString(),host:'official @deepseek-ai/dsh 0.2.1-rc.5',system:process.platform,model:model.model,productionDataTouched:false,claudeTouched:false,checks:[]};
const save=()=>fs.writeFile('evidence/remote-dsh-native.json',JSON.stringify(evidence,null,2)+'\n');
const wait=async(fn,label,ms=180000)=>{const end=Date.now()+ms;let last;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch(e){last=e.message;}await new Promise(r=>setTimeout(r,700));}throw Error(label+(last?': '+last:''));};
const call=async(route,body)=>{const s=JSON.parse(await fs.readFile(stateFile,'utf8')),r=await fetch(s.controlUrl+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+s.controlToken,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});const d=await r.json();if(!r.ok)throw Error(d.error);return d;};
let sessionId;
const turn=async(text)=>{const prior=await call('/proof/state',{sessionId}),seq=prior.events.at(-1)?.seq??-1;await call('/proof/prompt',{sessionId,text});return wait(async()=>{const s=await call('/proof/state',{sessionId});return s.events.some(e=>e.type==='turn/end'&&e.seq>seq)&&!s.item.running?s:null;},'Native turn did not end');};
const stop=async p=>{if(!p||p.exitCode!==null||p.signalCode!==null)return;p.kill('SIGINT');await new Promise(r=>p.once('exit',r));};
try{
 await wait(async()=>!!(await call('/health')).ready,'Native Host startup');
 sessionId=(await call('/proof/create',{workspace:project})).sessionId;evidence.sessionId=sessionId;
 const marker='原生白鹭'+randomUUID().slice(0,6);
 await turn('记住本对话识别词：'+marker+'。只留在对话里，不写入文件。回复“记住了”。');
 await h.request('/admin/action',{type:'platform.create',payload:{id:'deepseek-harness',name:'DeepSeek Harness'}});
 const account=(await h.request('/admin/action',{type:'account.create',payload:{platformId:'deepseek-harness',label:'Remote DSH proof'}})).result;
 const member=(await h.request('/admin/action',{type:'member.create',payload:{accountId:account.id,name:'原 Harness',mode:'connector'}})).result;
 const setup=await h.request('/v2/connect/native',{memberId:member.id,form:'deepseek-harness'}),input=JSON.parse(setup.skill.match(/setup：(\{.+?\})。/)[1]);
 // Native shell supplies DSH_PROFILE_DIR and DSH_SESSION_ID. No launcher guesses.
 const script=path.join(dir,'install.sh');
 await fs.writeFile(script,'#!/bin/sh\nAGENT_HUB_CONNECTOR_TEST=1 DUOLAWORK_RUNTIME_DIR='+JSON.stringify(runtimeRoot)+' '+process.execPath+' '+JSON.stringify(path.resolve('connectors/runtime/cli.mjs'))+' setup > '+JSON.stringify(path.join(dir,'setup-result.log'))+" 2>&1 <<'SETUP_INPUT'\n"+JSON.stringify(input)+'\nSETUP_INPUT\nresult=$?\ncat '+JSON.stringify(path.join(dir,'setup-result.log'))+'\nexit "$result"\n',{mode:0o700});
 await turn('请用你自己的终端工具运行 '+script+' 完成 DuolaWork 接入安装，只运行一次。这是已授权的专用测试，只使用当前原环境。不要输出文件中的接入码和凭证，不修改登录、模型或其他目录。成功或失败都立即结束本轮，简短报告真实结果，不自行修复或重试。');
 evidence.setupResult=await fs.readFile(path.join(dir,'setup-result.log'),'utf8');await save();
 const base=path.join(runtimeRoot,member.id),host=new DshOriginalHost(base);
 assert.equal((await host.sessions()).items.some(s=>s.id===sessionId),true);
 const origin=JSON.parse(await fs.readFile(host.originFile,'utf8'));assert.equal(origin.sessionId,sessionId);assert.equal(origin.profile,await fs.realpath(path.join(home,'profiles/web')));
 await fs.access(path.join(base,'grant.json'));evidence.checks.push('Original native shell installed the connector using its official profile/session identity');
 const startReceiver=()=>spawn(process.execPath,[path.resolve('connectors/runtime/cli.mjs'),'run',member.id],{env:{...process.env,DUOLAWORK_RUNTIME_DIR:runtimeRoot,AGENT_HUB_CONNECTOR_TEST:'1'},stdio:['ignore',log.fd,log.fd]});
 receiver=startReceiver();
 await wait(async()=>{const s=await h.request('/v2/native-runtime?memberId='+member.id);return s.record?.sourceReady;},'Original runtime heartbeat');
 const channel=await h.command('channel.create',{name:'Harness original remote proof',memberIds:[member.id]});
 const link=await h.request('/v2/session-links',{action:'create',memberId:member.id,channelId:channel.id}),linkInput=JSON.parse(link.skill.match(/传入：(\{.+?\})。/)[1]);
 const linkFile=path.join(dir,'link-input.json');await privateJson(linkFile,linkInput);const linkScript=path.join(dir,'link.sh');
 await fs.writeFile(linkScript,'#!/bin/sh\nAGENT_HUB_CONNECTOR_TEST=1 DUOLAWORK_RUNTIME_DIR='+JSON.stringify(runtimeRoot)+' '+process.execPath+' '+JSON.stringify(path.resolve('connectors/runtime/session-link.mjs'))+' < '+JSON.stringify(linkFile)+'\n',{mode:0o700});
 await turn('请用本对话的终端工具运行 '+linkScript+' 一次，将当前原对话关联进 DuolaWork。不要输出配对码，不修改其他配置。执行后结束本轮，等待自动确认消息。');
 await wait(async()=>{const l=await h.request('/v2/session-links?id='+link.id);if(l.status==='failed')throw Error(l.message);return l.status==='completed';},'Original conversation code and challenge');
 evidence.checks.push('Current conversation code selects the original native session and confirms through its actual queue');
 const client=new CodingMemberClient(path.join(base,'grant.json'));
 await wait(async()=>!!(await client.api('/v2/self/status')).complete,'Native round-trip verification');
 evidence.checks.push('Native original session claimed and submitted real Hub verification');
 const ask=async(body,expected)=>{const msg=await h.command('channel.post',{channelId:channel.id,body});return wait(async()=>{const c=await h.request('/v2/channel?id='+channel.id);return c.messages.find(m=>m.authorId===member.id&&m.number>msg.number&&m.body.includes(expected));},'Native Hub reply');};
 const reply=await ask('请回复本对话此前记住的识别词，不搜索或读取文件。',marker);evidence.contextReply=reply.body;
 await stop(receiver);receiver=startReceiver();await wait(async()=>{const s=await h.request('/v2/native-runtime?memberId='+member.id);return s.record?.sourceReady;},'Receiver recovery');
 const fileReply=await ask('在当前原项目创建 hello.txt，内容为 harness-original-ok。用自己的文件工具写入并读回，然后仅回复“已写入原项目”。','已写入原项目');
 assert.match(await fs.readFile(path.join(project,'hello.txt'),'utf8'),/harness-original-ok/);evidence.fileReply=fileReply.body;
 evidence.checks.push('Receiver restart retains original session and native file tools write to the original project');
 const after=await h.request('/v2/native-runtime?memberId='+member.id);assert.equal(after.bindings[channel.id].sessionId,sessionId);
 evidence.completedAt=new Date().toISOString();await save();console.log(JSON.stringify({passed:true,checks:evidence.checks}));
}catch(e){evidence.failure=e.message;await save();console.error(e.message);console.error('Private diagnostic directory: '+dir);process.exitCode=1;}
finally{await stop(receiver);await stop(native);await log.close();await h.stop();await save();}
