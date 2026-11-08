import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {startHarness} from './v1-harness.mjs';
const h=await startHarness();try{
 await h.request('/admin/action',{type:'platform.create',payload:{id:'claude-code',name:'Claude'}});
 const m=await h.member('claude-code','isolated receipt validation');
 const request=async(name,args)=>{const r=await fetch(h.base+'/v2/tools/'+name,{method:'POST',headers:{Authorization:'Bearer '+m.token,'Content-Type':'application/json'},body:JSON.stringify(args)});return{status:r.status,body:await r.json()};};
 const cases=[];
 for(const [name,args]of [['read_doc',{}],['read_doc',{documentId:123}],['stay_silent',{requestId:crypto.randomUUID(),reason:'no turn'}],['stay_silent',{requestId:crypto.randomUUID(),turnId:'x',stepId:'y',reason:'conflict'}]]){
  const r=await request(name,args);assert.equal(r.status,400,JSON.stringify(r));cases.push({name,status:r.status,code:r.body.error?.code||r.body.code});
 }
 const channel=await h.command('channel.create',{name:'private test',memberIds:[m.id]});
 const doc=await m.call('create_doc',{requestId:crypto.randomUUID(),channelId:channel.id,title:'test',body:'real stored doc'});
 const read=await request('read_doc',{docId:doc.id});assert.equal(read.status,200);assert.equal(read.body.body,'real stored doc');cases.push({name:'read_doc alias',status:read.status});
 await h.command('channel.post',{channelId:channel.id,body:'read receipt'});
 const w=(await m.call('list_work')).work.find(x=>x.channelId===channel.id);
 const claim=await m.call('claim_work',{requestId:crypto.randomUUID(),stepId:w.stepId});
 const silent=await request('stay_silent',{requestId:crypto.randomUUID(),stepId:claim.turnId,reason:'read, no further information'});assert.equal(silent.status,200);cases.push({name:'stay_silent alias',status:silent.status});
 await fs.mkdir('docs/evidence/claude-receipt-recovery-20261108',{recursive:true});await fs.writeFile('docs/evidence/claude-receipt-recovery-20261108/http.json',JSON.stringify({at:new Date().toISOString(),isolated:true,cases},null,2));console.log(JSON.stringify(cases));
}finally{await h.stop();}
