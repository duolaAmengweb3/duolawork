// Opt-in feasibility test only. The GUI must already have done real local work.
// Never resumes or starts a replacement thread on another server.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startHarness} from '../tests/v1-harness.mjs';
if(process.argv[2]!=='--run-isolated-proof')throw Error('Requires --run-isolated-proof and an explicitly owned GUI proof location');
const exec=promisify(execFile),p=JSON.parse(await fs.readFile('/tmp/hub-codex-gui-proof-location.json','utf8'));
if(!path.basename(p.root).startsWith('hub-codex-gui-proof-')||p.threads?.length!==1||p.threads[0].source!=='vscode')throw Error('Ambiguous or unowned GUI proof session');
const h=await startHarness(),helper=path.join(p.project,'hub-gui-proof-tools.mjs');
const e={at:new Date().toISOString(),platform:'Official OpenAI VSCode extension 26.1021.22027',project:p.project,thread:p.threads[0],newThreadCreatedByProbe:false,preRegisteredHubTools:false,productionHubChanged:false,claudeTouched:false,checks:[]};
try{const prior=JSON.parse(await fs.readFile('evidence/codex-gui-working-session.json','utf8'));if(prior.failure)e.priorAttempts=[...(prior.priorAttempts||[]),{at:prior.at,failure:prior.failure,guiObservedResult:'Original GUI received queued message and remembered original context; sandbox initially blocked local Hub network, then test harness expired and removed its helper before retry completed'}];}catch{}
const save=()=>fs.writeFile('evidence/codex-gui-working-session.json',JSON.stringify(e,null,2)+'\n');
try{
 if(!(await fs.readFile(path.join(p.project,'scale.mjs'),'utf8')).includes('* 3'))throw Error('Original GUI work has not completed');
 await exec('npm',['test'],{cwd:p.project});e.checks.push('GUI-origin native conversation changed local code and project tests passed before collaboration');
 await h.request('/admin/action',{type:'platform.create',payload:{id:'codex',name:'Codex'}});
 const member=await h.member('codex','原 VSCode 工作会话'),channel=await h.command('channel.create',{name:'VSCode 原会话验证',memberIds:[member.id],wakeIntervalSeconds:0});
 const grant=path.join(h.directory,'proof-grant.json');await fs.writeFile(grant,JSON.stringify({endpoint:h.base,memberId:member.id,access_token:member.token}),{mode:0o600});
 const bridge='file://'+path.resolve('local/coding-client.mjs');
 await fs.writeFile(helper,`import {CodingMemberClient} from ${JSON.stringify(bridge)};import {createHash} from 'node:crypto';const c=new CodingMemberClient(${JSON.stringify(grant)});const [op,...a]=process.argv.slice(2),requestId=createHash('sha256').update(JSON.stringify([op,a])).digest('hex');const result=op==='list'?await c.tool('list_work'):op==='claim'?await c.tool('claim_work',{requestId,stepId:a[0]}):op==='reply'?await c.tool('post_message',{requestId,channelId:${JSON.stringify(channel.id)},turnId:a[0],body:a[1]}):{error:'unknown operation'};console.log(JSON.stringify(result));\n`);
 const message=await h.command('channel.post',{channelId:channel.id,body:'请说明刚才实际修改和测试结果，并说出之前只在本会话记住的识别词。不改文件，只在这里回复。'});
 e.hub={memberId:member.id,channelId:channel.id,messageId:message.id};
 const prompt=`This is a Hub collaboration request for this exact existing VSCode conversation. Keep your current project and session. Run node ${helper} list, select only the ready work of channelId=${channel.id}, run node ${helper} claim <stepId>, then node ${helper} reply <turnId> '<your reply>' to report your actual prior change, test result and the conversation-only marker you remember. Do not read another conversation or transcript, inspect credentials, change files or create other work. This helper only accesses an isolated local Hub test instance; no provider login is involved.`;
 const q=await exec('/Users/duola/.local/bin/codex',['queue','--thread',p.threads[0].id,'--message',prompt],{cwd:p.project,timeout:20000});
 e.queue={stdout:q.stdout,stderr:q.stderr};await save();console.log('Queued to exact GUI-owned session without --resume');
 const start=Date.now();let reply;
 while(Date.now()-start<420000){const v=await h.request('/v2/channel?id='+channel.id);reply=v.messages.find(m=>m.authorId===member.id&&m.number>message.number);if(reply)break;await new Promise(r=>setTimeout(r,1500));}
 if(!reply)throw Error('GUI-owned session did not claim/reply within 420 seconds; queue acceptance alone is not proof');
 if(!reply.body.includes('gui_context_red_84219'))throw Error('Original GUI context not proven');
 e.reply={id:reply.id,body:reply.body};e.checks.push('Existing GUI-origin session itself claimed and replied to isolated Hub with earlier conversation-only context');e.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({checks:e.checks,threadId:p.threads[0].id}));
}catch(err){e.failure=String(err.message);await save();console.log(JSON.stringify({failure:e.failure}));process.exitCode=1;}
finally{await fs.rm(helper,{force:true});await h.stop();e.isolatedHubAndGrantRemoved=true;await save();}
