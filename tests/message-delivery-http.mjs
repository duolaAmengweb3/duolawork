import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startNodeHarness} from './node-server-harness.mjs';
import {deliveryReceipt} from '../local/native-delivery.mjs';
import {privateJson} from '../local/storage.mjs';
const h=await startNodeHarness(),samples=[],errors=[];let watcher;
const p95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
try{
 const m=await h.member(),c=await h.command('channel.create',{name:'Transport benchmark',memberIds:[m.id],coordinatorId:m.id}),sessionId='protocol-native-one';await m.bind(c.id,sessionId);
 let onEnvelope=()=>{},boot;const ready=new Promise(r=>boot=r);
 watcher=m.client.watch(async page=>{if(page.reset)boot();for(const w of page.inbox?.work||[])if(w.status==='ready')await onEnvelope(w);},{onError:e=>errors.push(e.message)});
 await ready;
 // Includes first sample. fsync-like server commit plus private receiver file
 // rename precedes ACK. This measures loopback transport, not WAN or model SLA.
 for(let i=0;i<100;i++){
  let resolve,reject;const done=new Promise((a,b)=>{resolve=a;reject=b;}),seen=new Set();
  onEnvelope=async w=>{if(w.delivery?.message?.body!=='sample '+i||seen.has(w.stepId))return;seen.add(w.stepId);try{
   await privateJson(path.join(h.directory,'received.json'),w.delivery,{durable:true});
   assert.equal(JSON.parse(await fs.readFile(path.join(h.directory,'received.json'))).message.body,'sample '+i);
   const receipt=await deliveryReceipt(m.client,w,sessionId);
   resolve({w,receipt});
  }catch(e){reject(e);}};
  const started=performance.now(),message=await h.command('channel.post',{channelId:c.id,body:'sample '+i});
  let timer;const {w,receipt}=await Promise.race([done,new Promise((_,rej)=>timer=setTimeout(()=>rej(Error('receive timeout '+i)),5000))]).finally(()=>clearTimeout(timer));
  samples.push({i,messageId:message.id,turnId:w.stepId,roundTripMs:performance.now()-started,saveToReceiveAckMs:Date.parse(receipt.at)-Date.parse(message.createdAt)});
  assert.equal((await h.repo.get('channel_turn',w.stepId)).status,'ready');
  // Lost ACK retry is the same receipt and cannot start/repeat model work.
  assert.deepEqual(await deliveryReceipt(m.client,w,sessionId),receipt);
  const claimed=await m.client.tool('claim_work',{requestId:crypto.randomUUID(),stepId:w.stepId,channelId:c.id,expectedSessionId:sessionId});
  await m.client.tool('post_message',{requestId:crypto.randomUUID(),channelId:c.id,turnId:claimed.turnId,body:'Protocol fixture reply '+i});
 }
 watcher.stop();await watcher.finished;
 // Save without a listener, then restart the real server and receiver. The
 // durable inbox must deliver the original exact message, not a new task.
 const late=await h.command('channel.post',{channelId:c.id,body:'saved while receiver offline'});await h.restart();
 const recovered=await m.client.inbox();assert(recovered.work.some(w=>w.delivery?.message?.id===late.id));
 const all=(await h.repo.list('channel_message',{scope:c.id,limit:501}));assert.equal(all.length,201);assert.equal(new Set(all.map(m=>m.id)).size,201);
 const result={scope:'isolated Node HTTP/SQLite loopback, connector private-file persistence and server ACK; no provider/model; not production WAN SLA',count:samples.length,errors,p95SaveToReceiveAckMs:p95(samples.map(x=>x.saveToReceiveAckMs)),p95RoundTripMs:p95(samples.map(x=>x.roundTripMs)),maxSaveToReceiveAckMs:Math.max(...samples.map(x=>x.saveToReceiveAckMs)),samples,restartRecovery:true};
 const target=process.env.DUOLAWORK_TRANSPORT_EVIDENCE||'/tmp/duolawork-message-delivery-http.json';await fs.writeFile(target,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,samples:undefined}));
 assert.equal(errors.length,0);assert(result.p95SaveToReceiveAckMs<=1000);
}finally{watcher?.stop();await watcher?.finished;await h.stop();}
