import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {CodingManager} from '../local/coding-manager.mjs';
import {readConfig,dataDir,privateJson} from '../local/storage.mjs';
import {requestJson} from '../local/transport.mjs';
const config=await readConfig(),owner=(route,body)=>requestJson(config.endpoint+route,{token:config.adminKey,...(body===undefined?{}:{method:'POST',body})});
const command=(type,args={})=>owner('/v2/commands',{type,requestId:randomUUID(),...args}).then(r=>r.result);
let manager=new CodingManager({config,dataDir});await manager.load();
const record=Object.values(manager.records).find(r=>r.engine==='codex'),memberId=record.memberId;
const channel=await command('channel.create',{name:'验收 · Codex 原生工具与续接',memberIds:[memberId]});
const marker=randomUUID().slice(0,12),file='hub-native-proof-'+marker+'.txt';
const evidence={at:new Date().toISOString(),memberId,channelId:channel.id,file,turns:[],restartResumedSameSession:false};
async function waitReply(message,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){for(const item of manager.approvals.values()){
 const p=item.params,expected=record.cwd+'/'+file;
 const edits=p.item?.changes||[];
 const scopedEdit=item.method==='item/fileChange/requestApproval'&&edits.length&&edits.every(c=>c.path===expected||c.path===file);
 const scopedCommand=item.method==='item/commandExecution/requestApproval'&&p.cwd===record.cwd&&String(p.command).includes(file)&&!/(curl|wget|sudo|\\.config|\\.codex|\\.gemini|\\brm\\b)/.test(String(p.command));
 if(scopedEdit||scopedCommand){manager.decide({id:item.id,allow:true});console.log(JSON.stringify({approved:item.method,scope:'isolated acceptance file only'}));}
 else console.log(JSON.stringify({waitingApproval:item.method,details:JSON.stringify(p).slice(0,2500)}));
 }
 const view=await owner('/v2/channel?id='+channel.id);const reply=view.messages.find(m=>m.authorId===memberId&&m.number>message.number);if(reply){while(manager.busy&&Date.now()<end)await new Promise(r=>setTimeout(r,500));return reply;}if(manager.records[memberId].status==='needs_review')throw new Error(manager.records[memberId].message);await new Promise(r=>setTimeout(r,1200));}throw new Error('真实原生回复等待超时');}
try{
 await manager.start();
 const first=await command('channel.post',{channelId:channel.id,body:`接入验收：请用你自己的原生文件工具在工作目录新建 ${file}，内容为 ${marker}。不要调用模型API，不要创建 Hub 文档或任务。实际写入后只在这个群回复“文件已写入”及该文件名。`});
 const reply=await waitReply(first);const actual=await fs.readFile(record.cwd+'/'+file,'utf8');if(!actual.includes(marker))throw new Error('原生工具文件内容不匹配');
 evidence.turns.push({messageId:first.id,replyId:reply.id,reply:reply.body,fileVerified:true});const session=manager.records[memberId].sessions[channel.id];
 await manager.stop();manager=new CodingManager({config,dataDir});await manager.load();await manager.start();
 const follow=await command('channel.post',{channelId:channel.id,body:'继续刚才的验收：读取你上一条实际创建的那个本地文件，在内容末尾追加一行“续接成功”。不要创建新文件或 Hub 文档；实际完成后在群里回复文件的完整新内容。'});
 const next=await waitReply(follow);const updated=await fs.readFile(record.cwd+'/'+file,'utf8');if(!updated.includes('续接成功')||!next.body.includes(marker))throw new Error('续接后的文件或原生回复不匹配');
 evidence.turns.push({messageId:follow.id,replyId:next.id,reply:next.body,fileVerified:true});evidence.restartResumedSameSession=session===manager.records[memberId].sessions[channel.id];evidence.sessionId=session;if(!evidence.restartResumedSameSession)throw new Error('重启后原生会话发生变化');
 await command('channel.update',{channelId:channel.id,status:'archived'});evidence.archived=true;
 await privateJson(process.cwd()+'/evidence/codex-conversation.json',evidence);console.log(JSON.stringify(evidence));
}finally{await manager.stop();}
