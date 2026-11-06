// Explicit owner-authorized acceptance in one new disposable production group.
// Never changes existing groups, accounts, native sessions or Claude.
import fs from 'node:fs/promises';import os from 'node:os';import {randomUUID} from 'node:crypto';import assert from 'node:assert/strict';import {requestJson} from '../local/transport.mjs';
if(!process.argv.includes('--run-production-acceptance'))throw Error('Explicit production acceptance flag required');
const config=JSON.parse(await fs.readFile(os.homedir()+'/.config/agent-hub/config.json'));
const api=(route,body)=>requestJson(config.endpoint+route,{token:config.adminKey,...(body===undefined?{}:{method:'POST',body})});
const cmd=async(type,args)=>(await api('/v2/commands',{type,requestId:randomUUID(),...args})).result;
const e={at:new Date().toISOString(),origin:config.endpoint,checks:[],native:false};
const workspace=await api('/v2/workspace'),dot=workspace.members.find(m=>m.name==='Dot'),grok=workspace.members.find(m=>m.name==='grok2');
assert.ok(dot&&grok);
const group=await cmd('channel.create',{name:'验收 · 新版协作与记忆 1106',memberIds:[dot.id,grok.id],coordinatorId:dot.id});e.channelId=group.id;
await fs.writeFile('/tmp/duolawork-production-acceptance.json',JSON.stringify(e));
const memory=await cmd('channel.remember',{channelId:group.id,title:'收件规则',body:'测试样本：对外通告需使用简体中文，客户单独提出外语时例外。',category:'background',authority:'user_directive',conditions:'仅此验收群'});
e.memoryId=memory.id;
const wait=async(fn,label,ms=45000)=>{const end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,1000));}throw Error(label+' timed out');};
await wait(async()=>{const status=await api('/v2/memory-status');return status.state==='ready'&&status.pending===0;},'Live index');
const recall=await api('/v2/memory-search?'+new URLSearchParams({channelId:group.id,query:'给境内使用者发布更新，用哪种语言？'}));assert.equal(recall.retrieval,'hybrid');assert.ok(recall.items.some(i=>i.id===memory.id));e.checks.push('VPS actual Mem0/Qdrant/embedding semantic retrieval');
const updated=await cmd('channel.memory.update',{channelId:group.id,memoryId:memory.id,expectedVersion:1,body:'测试样本：对外通告需使用简体中文与英文双语。'});
const after=await api('/v2/memory-search?'+new URLSearchParams({channelId:group.id,query:'发布使用什么语言？'}));assert.ok(after.items.every(i=>i.id!==memory.id||i.version===2));e.checks.push('Correction never returns the old version while index catches up');
await api('/v2/memory-forget',{requestId:randomUUID(),channelId:group.id,memoryId:memory.id,expectedVersion:2});
const forgotten=await api('/v2/memory-search?'+new URLSearchParams({channelId:group.id,query:'对外通告使用什么语言？'}));assert.ok(!forgotten.items.some(i=>i.id===memory.id));e.checks.push('Forget immediately excludes authoritative result');
await wait(async()=>{const s=await api('/v2/memory-status');return s.pending===0;},'Vector cleanup');
const body=`这是独立验收材料，只处理本群。下面是 12 个小案例，不需要外网搜索、不操作本地文件、不创建会议或任务。
事实核对：
F1 原始数据 12+8+5，现有草稿写总数 30。核对并更正。
F2 原始数据成交20笔、退款2笔，草稿写退款率10%。没有问题应保留，不制造分歧。
F3 材料只说产品在内测，草稿写已全面上线。纠正未经支持的承诺。
F4 只有速度变快的口头说法，没有测量数据。不得声称提升50%。
产物修改：
E1 原文“今晚全部功能上线”，实际仅聊天缓存已上线。改成符合事实的一句通知。
E2 文稿需求是只给三段标题，草稿已展开2000字。交回三段标题，不继续扩写。
E3 用户最新说明“不做付费版，先内部试用”，原稿含付费套餐。删除收费承诺，保留内部试用。
E4 既有注意事项“需要原客户端在线”，修改不能漏掉此限制。
开放决策：
D1 两个方案 A每月10元，B每月20元，都满足唯一需求；没有额外收益证据，给出节省开支的建议。
D2 用户只说想做内容，受众和渠道未定。只提一个能影响下一步的具体问题，不自行分派生产整篇内容。
D3 负责人原判断F1=30。检查后应直接修正自己的结论，不坚持原判断。
D4 用户要一个只含框架的结果，但有成员建议直接开写。以用户范围为准，保留框架并说明待定项。
请将最终结果按 F1–D4 对应逐项写回本文件，保留原题。
`;
const doc=await cmd('channel.doc.create',{channelId:group.id,title:'12 个协作场景 · 原题与结果',body});e.documentId=doc.id;
await fs.writeFile('/tmp/duolawork-production-acceptance.json',JSON.stringify(e));
if(process.argv.includes('--native')){
 const prompt='请完成资料《12 个协作场景 · 原题与结果》中的核对和修改，保持用户要的范围。Dot 作为负责人，找 grok2 做一次独立核对，收到反馈后接着整合到原文档，并向我交付具体结论；grok2 只回复 Dot 发来的要求，不必再 @ 他。不要创建别的群、成员、任务或会议。不要为了讨论而讨论，资料不足就指出具体缺口。只做这份验收资料，结束后停止。';
 const message=await cmd('channel.post',{channelId:group.id,body:prompt});e.sourceMessageId=message.id;e.native=true;
}
await fs.writeFile('/tmp/duolawork-production-acceptance.json',JSON.stringify(e));await fs.writeFile('evidence/production-experience.json',JSON.stringify(e,null,2));console.log(JSON.stringify(e));
