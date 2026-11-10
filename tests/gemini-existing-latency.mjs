// Explicit real-native acceptance in two already dedicated test groups only.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {requestJson} from '../local/transport.mjs';
if(!process.argv.includes('--run-native-acceptance'))throw Error('Explicit native flag required');
const c=JSON.parse(await fs.readFile(path.join(os.homedir(),'.config/agent-hub/config.json'))),memberId='member_ccdf940ba6d3426da01b9f65048909e2';
const request=(r,body)=>requestJson(c.endpoint+r,{token:c.adminKey,...(body?{method:'POST',body}:{} )});
const channels=['channel_8ac79a0812c24fa0b1360f2161d9205d','channel_81d9795c7b4b454bb5dcbffb13db41b8'];
const before=await request('/v2/native-runtime?memberId='+memberId),e={at:new Date().toISOString(),platform:'original Antigravity CLI on VPS',receiverRevision:before.record.receiverRevision,modelOverride:false,providerCredentialsTouched:false,existingSessions:channels.map(id=>before.bindings[id]),samples:[]};
assert.notEqual(e.existingSessions[0].sessionId,e.existingSessions[1].sessionId);
const token='DW-LATENCY-'+crypto.randomUUID().slice(0,8),turns=[];
const wait=async(fn,label)=>{const end=Date.now()+240000;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,1000));}throw Error(label+' timed out');};
try{
 for(let i=0;i<2;i++){
  const body=`DuolaWork 自动验收（所有者已授权；本消息由验收脚本发送）：仅处理当前专用验收群，不修改文件或登录，不通知其他成员。请先执行原生终端命令 pwd 和 sleep ${i===0?30:1}，然后通过 Hub post_message 回本群，正文仅包含识别词 ${token}-${i}、实际 pwd 结果及“原项目和工具保留”。不要把别的群内容带回来。`;
  const {result}=await request('/v2/commands',{type:'channel.post',requestId:crypto.randomUUID(),channelId:channels[i],body,mentions:[memberId]});turns.push({channelId:channels[i],messageId:result.id,createdAt:result.createdAt,token:token+'-'+i});
  if(i===0)await wait(async()=>{const r=await request('/v2/channel?id='+channels[0]+'&view=chat');return r.activity.some(t=>t.messageId===result.id&&t.status==='active');},'slow A claimed');
 }
 let peak=0;
 await wait(async()=>{const values=await Promise.all(turns.map(t=>request('/v2/channel?id='+t.channelId+'&view=chat')));peak=Math.max(peak,values.filter((v,i)=>v.activity.some(t=>t.messageId===turns[i].messageId&&t.status==='active')).length);
  for(let i=0;i<values.length;i++){const reply=values[i].messages.find(m=>m.authorId===memberId&&m.body.includes(turns[i].token));if(reply)turns[i].reply={id:reply.id,body:reply.body,createdAt:reply.createdAt};turns[i].activity=values[i].activity.find(t=>t.messageId===turns[i].messageId);}
  return turns.every(t=>t.reply);
 },'native results');
 e.samples=turns;e.peakActive=peak;e.fastBFinishedBeforeA=Date.parse(turns[1].reply.createdAt)<Date.parse(turns[0].reply.createdAt);e.slowARequestedSeconds=30;e.completedAt=new Date().toISOString();
 assert.equal(peak,2);assert(e.fastBFinishedBeforeA);for(const [i,t]of turns.entries()){assert(t.reply.body.includes('/home/claude/'));assert(!t.reply.body.includes(turns[1-i].token));}
 const after=await request('/v2/native-runtime?memberId='+memberId);assert.deepEqual(channels.map(id=>after.bindings[id]),e.existingSessions);e.bindingsPreserved=true;e.passed=true;console.log(JSON.stringify({passed:true,peak,fastBFinishedBeforeA:e.fastBFinishedBeforeA}));
}catch(error){e.error=error.message;e.samples=turns;process.exitCode=1;console.error(error.message);}
finally{await fs.writeFile('/tmp/duolawork-latency-gemini-native.json',JSON.stringify(e,null,2));}
