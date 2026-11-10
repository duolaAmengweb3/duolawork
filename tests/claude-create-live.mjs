// Explicit real VPS acceptance via the same owner API used by the picker.
// Creates three dedicated conversations; never rebinds an existing user group.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
if(!process.argv.includes('--run-native-acceptance'))throw Error('Explicit native acceptance required');
const file='evidence/claude-create-live-20261107.json',memberId='member_bf4fdac30b4542c8988bb6725f47ec0b';
const once=async(route,body)=>{const r=await fetch('http://127.0.0.1:8766/api'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Error(value.message||value.error||'request failed');return value;};
const api=async(route,body)=>{for(let attempt=0;;attempt++){try{return await once(route,body);}catch(e){if(attempt>=4||!/(fetch failed|ECONN|temporar|502|503|504)/i.test(e.message))throw e;await new Promise(r=>setTimeout(r,1000*(attempt+1)));}}};
const command=async(type,args)=>(await api('/v2/commands',{type,requestId:randomUUID(),...args})).result;
const wait=async(fn,label)=>{const end=Date.now()+240000;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,1500));}throw Error(label+' timed out');};
let e;try{e=JSON.parse(await fs.readFile(file));}catch{e={at:new Date().toISOString(),memberId,cases:[],checks:[]};}
let saving=Promise.resolve();const save=()=>saving=saving.then(()=>fs.writeFile(file,JSON.stringify(e,null,2)+'\n'));
try{
 const original=await api('/v2/native-sessions?memberId='+memberId);e.originalBindings??=original.bindings;assert.equal(original.capabilities.create,true);
 for(const label of ['A','B','C'])if(!e.cases.find(c=>c.label===label)){const channel=await command('channel.create',{name:'验收 · Claude 独立新建 '+label+' · 1107',memberIds:[memberId]});e.cases.push({label,channelId:channel.id,marker:label+'_'+randomUUID().slice(0,8)});await save();}
 await Promise.all(e.cases.map(async c=>{
  if(c.binding)return;
  if(!c.commandId){const cmd=await api('/v2/native-sessions',{requestId:'create-live-'+c.channelId+'-'+(e.retry||0),memberId,channelId:c.channelId,mode:'new'});c.commandId=cmd.id;await save();}
  c.binding=await wait(async()=>{const cmd=await api('/v2/native-sessions?'+new URLSearchParams({memberId,commandId:c.commandId}));if(cmd.status==='failed')throw Error(cmd.message);return cmd.status==='completed'?cmd.binding:null;},'native registration');await save();
 }));
 assert.notEqual(e.cases[0].binding.sessionId,e.cases[1].binding.sessionId);assert.notEqual(e.cases[0].binding.workspace,e.cases[1].binding.workspace);
 console.log('Three new official native sessions registered and bound to separate groups.');
 await Promise.all(e.cases.map(async c=>{
  if(c.messageId)return;
  const body='专用并发验收。只在当前项目目录运行下面的 Python，完成后用 post_message 回到本群，回复识别词和开始/结束时间，不@任何人、不建文档和任务、不操作其他项目。记住识别词 '+c.marker+'，后续还会问你。\npython3 - <<\'PY\'\nimport time,json,os\nr={"marker":"'+c.marker+'","start":time.time(),"cwd":os.getcwd()}\ntime.sleep(8)\nr["end"]=time.time()\nopen("duolawork-concurrency-proof.json","w").write(json.dumps(r))\nprint(json.dumps(r))\nPY';
  c.postedAt=new Date().toISOString();const msg=await command('channel.post',{channelId:c.channelId,body});c.messageId=msg.id;await save();
 }));
 e.peakActive=e.peakActive||0;
 await wait(async()=>{const states=await Promise.all(e.cases.map(c=>api('/v2/channel?id='+c.channelId)));e.peakActive=Math.max(e.peakActive,states.filter(s=>s.activity.some(a=>a.memberId===memberId&&a.status==='active')).length);return states.every((s,i)=>{const c=e.cases[i],reply=s.messages.find(m=>m.authorId===memberId&&m.body.includes(c.marker));if(reply){c.reply={body:reply.body,at:reply.createdAt};c.activity=s.activity.filter(a=>a.memberId===memberId);}return !!reply;});},'native replies');
 assert.equal(e.peakActive,e.cases.length);
 for(const c of e.cases){for(const other of e.cases.filter(v=>v!==c))assert.ok(!c.reply.body.includes(other.marker));}
 const state=await api('/v2/native-sessions?memberId='+memberId);for(const [id,binding] of Object.entries(e.originalBindings))assert.deepEqual(state.bindings[id],binding);
 e.checks=['Three owner-created native VPS conversations register themselves','Distinct group/session/project bindings execute concurrently','All replies return with their own marker and original group bindings remain unchanged'];e.passed=true;e.finishedAt=new Date().toISOString();delete e.failure;console.log(JSON.stringify({passed:true,peakActive:e.peakActive,cases:e.cases.map(c=>({group:c.label,sessionId:c.binding.sessionId}))}));
}catch(error){e.failure=error.message;process.exitCode=1;console.error(error.message);}finally{await save();}
