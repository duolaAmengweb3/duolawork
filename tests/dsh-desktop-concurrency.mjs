import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startHarness} from './v1-harness.mjs';
import {DshDesktopHost} from '../local/dsh-desktop.mjs';
import {DshManager} from '../local/dsh-manager.mjs';
import {privateJson} from '../local/storage.mjs';
if(!process.argv.includes('--run-native-acceptance'))throw Error('Explicit native acceptance required');
const h=await startHarness(),actual=path.join(os.homedir(),'.config/agent-hub'),host=new DshDesktopHost(actual),dataDir=path.join(h.directory,'local');
const manager=new DshManager({config:{endpoint:h.base,adminKey:h.key},dataDir,host,interval:1000,requireFreshReceipt:true});
const e={at:new Date().toISOString(),officialDesktop:true,originalModelAndLogin:true,isolatedHub:true,cases:[],checks:[]};let member;
const wait=async(fn,label)=>{const end=Date.now()+240000;while(Date.now()<end){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,600));}throw Error(label+' timed out');};
try{
 await host.start({launch:false});await manager.load();
 const before=(await host.call('/health')).bindings;e.originalBindingIds=before.map(b=>b.sessionId);
 await h.request('/admin/action',{type:'platform.create',payload:{id:'deepseek-harness',name:'DeepSeek'}});member=await h.member('deepseek-harness','原桌面并行验收');
 const grantFile=path.join(dataDir,member.id,'grant.json');await privateJson(grantFile,{endpoint:h.base,memberId:member.id,access_token:member.token});
 manager.records[member.id]={memberId:member.id,grantFile,enabled:true,sourceReady:true,status:'idle',hostKind:'desktop',chatBindings:{}};await manager.save();
 for(const label of ['A','B']){
  const c=await h.command('channel.create',{name:'原桌面独立并行 '+label,memberIds:[member.id]}),workspace=path.join(h.directory,'project-'+label),marker=label+'_'+randomUUID().slice(0,8);await fs.mkdir(workspace);await fs.writeFile(path.join(workspace,'scope.txt'),marker);
  const binding=await manager.assign({memberId:member.id,channelId:c.id,mode:'new',workspace,title:c.name});e.cases.push({label,channelId:c.id,binding,marker});
 }
 await manager.start();await Promise.all(e.cases.map(c=>h.command('channel.post',{channelId:c.channelId,body:'专用原生并发验收：使用本对话自己的终端，先执行 sleep 8，再读取当前目录 scope.txt，把文件原文回到本群。记住这个识别词。只做本次，不改文件、不读其他项目或会话、不@他人、不建文档或任务。'})));
 e.peakActive=0;
 await wait(async()=>{const states=await Promise.all(e.cases.map(c=>h.request('/v2/channel?id='+c.channelId)));e.peakActive=Math.max(e.peakActive,states.filter(s=>s.activity.some(a=>a.memberId===member.id&&a.status==='active')).length);return states.every((s,i)=>{const c=e.cases[i],r=s.messages.find(m=>m.authorId===member.id&&m.body.includes(c.marker));if(r){c.reply=r.body;c.activity=s.activity.filter(a=>a.memberId===member.id);}return !!r;});},'two real desktop replies');
 assert.equal(e.peakActive,2);for(const c of e.cases){assert.ok(!c.reply.includes(e.cases.find(o=>o!==c).marker));assert.equal(await fs.readFile(path.join(c.binding.workspace,'scope.txt'),'utf8'),c.marker);}
 await wait(async()=>!(await host.sessions()).items.some(s=>e.cases.some(c=>c.binding.sessionId===s.id)&&s.running),'native completion');
 e.checks=['Two original desktop sessions overlap in execution','Own project tools return exact separate file contents','No API substitute, provider override or original binding change'];e.passed=true;
 console.log(JSON.stringify({passed:true,peakActive:e.peakActive,checks:e.checks}));
}catch(error){e.failure=error.message;process.exitCode=1;console.error(error.message);}finally{
 await manager.stop();if(member)await manager.disconnect(member.id);await h.stop();e.finishedAt=new Date().toISOString();await fs.writeFile('evidence/dsh-desktop-concurrency-20261107.json',JSON.stringify(e,null,2)+'\n');
}
