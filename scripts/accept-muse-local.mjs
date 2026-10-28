// Real commercial acceptance: the original Muse, not a model API or fixture.
// Only a public read and a two-step same-Agent handoff; no publishing or spending.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:8766',source='https://agent-hub-local.duola-ai-project-radar.workers.dev/health';
const get=async p=>{const r=await fetch(base+p);if(!r.ok)throw new Error('Local HTTP '+r.status);return r.json();};
const action=async data=>{const r=await fetch(base+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await r.json();if(!r.ok)throw new Error(value.message);return value.result;};
let state=await get('/api/state');
const member=state.members.find(m=>m.platformId==='muse'&&m.status==='ready'&&m.evidence?.kind==='browser_roundtrip');
assert.ok(member,'Muse real receipt must be verified first');
const sourceTag=process.argv.includes('--framed')?'muse-framed-acceptance-v2':'muse-local-acceptance';
let task=state.tasks.find(t=>t.source===sourceTag);
if(!task)task=await action({type:'task.create',payload:{title:sourceTag==='muse-framed-acceptance-v2'?'Muse 后台自动协作验收':'Muse 自动收发验收',source:sourceTag,goal:'使用原 Muse 的正常工具读取公开服务，再把真实结果传给下一步写成中文说明；不修改任何外部设置。',steps:[
 {memberId:member.id,title:'读取公开服务的实时结果',instruction:`请用你正常的网页或终端工具实际读取 ${source} 。将该接口当前返回的 ok、service、version、time 四个字段原样组成 JSON，作为成果正文，不要编码成字符串。来源必须含这个实际读取的 HTTPS 地址。time 必须来自刚才的实时响应，不能猜测；若访问失败则明确失败，不编造结果。不调用工作台管理接口，不改文件，不改连接器或例行任务。`,minLength:80,requireSources:true,outputType:'json'},
 {memberId:member.id,title:'接收前序成果并生成中文说明',instruction:'只根据输入中 previousResults 的第一步完整成果，写一段至少 80 字的中文说明，清楚列出该服务名称、版本和响应时间。响应时间必须逐字保留第一步的 time 值，说明这是原 Muse 读取公开接口的结果。本步骤不要重新访问接口。sources 沿用第一步来源。不要称为两个不同 Agent 协作，这是同一个 Muse 的两步任务交接。',minLength:80,requireSources:true,outputType:'text'},
]}});
console.log(JSON.stringify({taskId:task.id,status:task.status}));let previous='';
const end=Date.now()+12*60000;
while(Date.now()<end){
 state=await get('/api/state');task=state.tasks.find(t=>t.id===task.id);
 const progress=JSON.stringify({status:task.status,steps:task.steps.map(s=>({title:s.title,status:s.status,attempt:s.attempts.at(-1)?.status}))});if(progress!==previous){console.log(progress);previous=progress;}
 if(task.status==='completed')break;
 if(['needs_review','needs_approval','failed'].includes(task.status)||task.steps.some(s=>s.attempts.at(-1)?.status==='platform_approval'))throw new Error('Native task requires review: '+JSON.stringify(task.steps.map(s=>({status:s.status,message:s.attempts.at(-1)?.message}))));
 await new Promise(r=>setTimeout(r,3000));
}
assert.equal(task.status,'completed','real Muse task did not complete');
const outputs=await Promise.all(task.steps.map(s=>get('/api/artifacts/'+s.artifactId)));
const first=JSON.parse(outputs[0].body);assert.equal(first.ok,true);assert.ok(first.service);assert.ok(first.version);assert.ok(Date.parse(first.time)>=Date.parse(task.createdAt)-1000,'server time must be read during this real task');
assert.ok(outputs[1].body.includes(first.time),'step two must receive the exact first-step result');
assert.ok(task.steps.every(s=>s.attempts.length===1),'acceptance must not hide retries');
assert.ok(task.steps.every(s=>state.artifacts.find(a=>a.id===s.artifactId)?.sources.includes(source)));
const report={at:new Date().toISOString(),buildId:state.local.build.id,sourceTag,taskId:task.id,platform:'muse',status:task.status,steps:task.steps.map(s=>({title:s.title,status:s.status,attempts:s.attempts.length,artifactId:s.artifactId})),checks:['original logged-in Muse automatically accepts work in a hidden headed Chrome page','real public endpoint read by Muse with fresh server timestamp','complete body and HTTPS source returned to Hub','same original Agent receives previous full result in step two','one dispatch per step, no manual retransmission','no foreground account window required'],serverTime:first.time,realCommercialLoginTested:true,realCommercialAgentTested:true,crossAgentCollaborationTested:false};
await fs.writeFile('evidence/muse-real.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
