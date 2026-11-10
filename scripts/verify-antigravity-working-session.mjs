// Feasibility only, using Google's documented Sidecar + agentapi.
// Scope: the explicitly created disposable desktop conversation below.
// Never reads provider login files, exports native credentials or changes model settings.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import {startHarness} from '../tests/v1-harness.mjs';
const {values}=parseArgs({options:{project:{type:'string'},conversation:{type:'string'},'context-marker':{type:'string'},'run-isolated-proof':{type:'boolean'}}});
if(!values['run-isolated-proof']||!values.project||!values.conversation||!values['context-marker'])throw new Error('Requires explicit --run-isolated-proof --project <disposable project> --conversation <owned test session> --context-marker <prior conversation-only marker>');
const project=await fs.realpath(values.project),conversationId=values.conversation,contextMarker=values['context-marker'];
if(!path.basename(project).startsWith('hub-working-session-proof-')||!(await fs.readFile(path.join(project,'AGENTS.md'),'utf8')).includes('This is a disposable feasibility repository.'))throw new Error('Only the explicitly disposable feasibility project is allowed');
if(!/^[a-f0-9-]{36}$/i.test(conversationId)||!contextMarker.trim())throw new Error('Invalid test conversation or context marker');
const h=await startHarness(),name='agent-hub-proof-'+randomUUID().slice(0,8);
const config=path.join(os.homedir(),'.gemini/config/config.json'),sidecar=path.join(os.homedir(),'.gemini/config/sidecars',name);
const receipt=path.join(project,name+'-receipt.json'),helper=path.join(project,name+'-tools.mjs');
const evidence={at:new Date().toISOString(),scope:'Official Antigravity desktop 2.28.0 existing GUI conversation + disposable project + isolated real Hub Worker/D1',realGUI:true,conversationId,project,providerLoginRead:false,modelChanged:false,claudeTouched:false,checks:[]};
const evidenceFile='evidence/antigravity-working-session.json';
const save=()=>fs.writeFile(evidenceFile,JSON.stringify(evidence,null,2)+'\n');
let originalConfig,registered=false,member,channel;
try{
 originalConfig=await fs.readFile(config,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 const before=originalConfig===null?{}:JSON.parse(originalConfig);
 await h.request('/admin/action',{type:'platform.create',payload:{id:'antigravity',name:'Gemini · Antigravity'}});
 member=await h.member('antigravity','正在原项目工作的 Gemini');
 channel=await h.command('channel.create',{name:'已有 Gemini 原生会话协作',memberIds:[member.id],wakeIntervalSeconds:0});
 const grant=path.join(h.directory,'proof-grant.json');await fs.writeFile(grant,JSON.stringify({endpoint:h.base,memberId:member.id,access_token:member.token}),{mode:0o600});
 const bridgeModule=path.resolve('local/coding-client.mjs');
 await fs.writeFile(helper,`import {CodingMemberClient} from ${JSON.stringify('file://'+bridgeModule)};import {createHash} from 'node:crypto';const client=new CodingMemberClient(${JSON.stringify(grant)});const [op,...a]=process.argv.slice(2);const requestId=createHash('sha256').update(JSON.stringify([op,a])).digest('hex');const result=op==='list'?await client.tool('list_work'):op==='claim'?await client.tool('claim_work',{requestId,stepId:a[0]}):op==='reply'?await client.tool('post_message',{requestId,channelId:${JSON.stringify(channel.id)},turnId:a[0],body:a[1]}):{error:'unknown operation'};console.log(JSON.stringify(result));\n`);
 const message=await h.command('channel.post',{channelId:channel.id,body:'请汇报刚才在原项目里实际做的修改和测试结果，并说出原会话记住的识别词。只聊天，不改文件。'});
 evidence.hub={channelId:channel.id,memberId:member.id,messageId:message.id};
 const prompt=`当前用户正在验证把这个已有工作会话接入 Hub 协作。保留当前项目和本会话记忆。Hub 群有一条真实消息，channelId=${channel.id}。请用本机已准备的测试工具逐步操作：先运行 node ${helper} list，只选择该群的 ready 工作；运行 node ${helper} claim <stepId>；按返回消息，说明本会话前面实际做过的修改、实际 npm test 结果，以及之前只在会话里记住的识别词（不要读取其他会话或转录日志来找）。最后运行 node ${helper} reply <turnId> '<你的中文答复>' 回到同一个 Hub 群。工具程序只使用隔离 Hub 的测试成员凭证，不涉及 Google 登录或其他项目。不要查看工具程序或凭证内容，不修改项目文件、不新建文档或任务。`;
 await fs.mkdir(sidecar,{recursive:true,mode:0o700});
 const script=path.join(sidecar,'once.mjs');
 await fs.writeFile(script,`import fs from 'node:fs/promises';import {execFile} from 'node:child_process';import {promisify} from 'node:util';const exec=promisify(execFile),file=${JSON.stringify(receipt)},id=${JSON.stringify(conversationId)};let lock;try{lock=await fs.open(file+'.lock','wx',0o600);}catch{process.exit(0)}await lock.close();const result={at:new Date().toISOString(),conversationId:id,hasNativeAddress:!!process.env.ANTIGRAVITY_LS_ADDRESS};try{const metadata=await exec('/Users/duola/.gemini/antigravity/bin/agentapi',['get-conversation-metadata',id],{env:process.env,timeout:15000});result.metadataRead=true;result.metadataKeys=Object.keys(JSON.parse(metadata.stdout));const sent=await exec('/Users/duola/.gemini/antigravity/bin/agentapi',['send-message',id,${JSON.stringify(prompt)}],{env:process.env,timeout:20000});result.sent=true;result.responseKeys=Object.keys(JSON.parse(sent.stdout));}catch(e){result.error=String(e.stdout||e.message).replace(/Bearer\\s+[A-Za-z0-9._-]+/g,'[hidden]').slice(0,900)}await fs.writeFile(file,JSON.stringify(result,null,2),{mode:0o600});\n`);
 await fs.writeFile(path.join(sidecar,'sidecar.json'),JSON.stringify({command:process.execPath,args:[script],restart_policy:'never',description:'One-shot Agent Hub validation restricted to a disposable conversation',display_name:'Hub 单会话可行性验证（一次）'},null,2),{mode:0o600});
 const next={...before,sidecars:{...(before.sidecars||{}),[name]:{enabled:true}}};
 await fs.writeFile(config,JSON.stringify(next,null,2)+'\n',{mode:0o600});registered=true;
 console.log('Registered one-shot official sidecar for only the disposable conversation');
 const start=Date.now();let reply;
 while(Date.now()-start<240000){
  try{evidence.sidecar=JSON.parse(await fs.readFile(receipt,'utf8'));if(evidence.sidecar.error)throw new Error(evidence.sidecar.error);}catch(e){if(e.code!=='ENOENT')throw e;}
  const view=await h.request('/v2/channel?id='+channel.id);reply=view.messages.find(m=>m.authorId===member.id&&m.number>message.number);
  if(reply)break;
  if(!evidence.sidecar&&Date.now()-start>45000)throw new Error('Official sidecar did not start after registration; no application restart or session replacement attempted');
  await new Promise(r=>setTimeout(r,1500));
 }
 if(!reply)throw new Error('Original Gemini GUI session did not reply back to the isolated Hub');
 if(!reply.body.includes(contextMarker))throw new Error('Reply does not prove prior GUI session context');
 evidence.reply={id:reply.id,body:reply.body};evidence.checks.push('Official sidecar used inherited native authentication without extracting provider credentials');evidence.checks.push('agentapi sent Hub collaboration to the exact pre-existing GUI conversation, which claimed and replied with prior conversation context');evidence.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({checks:evidence.checks,conversationId}));
}catch(e){evidence.failure=String(e.message).slice(0,1600);await save();console.log(JSON.stringify({failure:evidence.failure}));process.exitCode=1;}
finally{
 if(registered){const current=JSON.parse(await fs.readFile(config,'utf8'));delete current.sidecars?.[name];if(Object.keys(current.sidecars||{}).length===0&&!JSON.parse(originalConfig||'{}').sidecars)delete current.sidecars;if(JSON.stringify(current)===JSON.stringify(JSON.parse(originalConfig||'{}'))){if(originalConfig===null)await fs.unlink(config);else await fs.writeFile(config,originalConfig);}else await fs.writeFile(config,JSON.stringify(current,null,2)+'\n');evidence.ownSidecarConfigurationRemoved=true;}
 await fs.rm(sidecar,{recursive:true,force:true});await fs.rm(helper,{force:true});await h.stop();await save();
}
