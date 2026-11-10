// Measures our existing callback adapters against a local HTTP receiver.
// No commercial provider is contacted. Callback acceptance is not native receipt.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createHmac} from 'node:crypto';
import {fixture} from './collaboration-helper.mjs';
import {seal} from '../cloud/collaboration/security.mjs';
import {dispatchOne} from '../cloud/collaboration/dispatcher.mjs';
import {eventMethod} from '../cloud/collaboration/events.mjs';
import {conversationCommand,claimConversation,conversationTool} from '../cloud/collaboration/conversation.mjs';
import {privateJson} from '../local/storage.mjs';

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-callback-'));
const secret='isolated-callback-test-only',key=Buffer.alloc(32,17),signing='whsec_'+key.toString('base64');
const results=[];
try {
 for(const kind of ['grok-bearer','grok-signed','dot-events']) {
  const cleanups=[],f=await fixture({after:fn=>cleanups.push(fn)}),samples=[],errors=[];
  let deliveries=0;
  const server=http.createServer(async(req,res)=>{
   try {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks).toString();
    if(kind==='grok-bearer')assert.equal(req.headers.authorization,'Bearer isolated-provider-key');
    else assert.equal(req.headers['webhook-signature'],'v1,'+createHmac('sha256',key).update(`${req.headers['webhook-id']}.${req.headers['webhook-timestamp']}.${bytes}`).digest('base64'));
    const body=JSON.parse(bytes);
    if(body.type==='verification'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({challenge:body.challenge}));return;}
    assert.equal(kind==='dot-events'?body.data.member_id:body.member_id,'grok');
    await privateJson(path.join(directory,kind+'.json'),body,{durable:true});deliveries++;
    res.writeHead(kind==='grok-signed'?202:200,{'Content-Type':'application/json'});res.end('{}');
   } catch(e){errors.push(e.message);res.writeHead(500);res.end('{}');}
  }).listen(0,'127.0.0.1');await once(server,'listening');
  // Dependency injection keeps production URL validation intact. Only this
  // isolated benchmark maps the already-validated official URL to loopback.
  const fetcher=(_url,options)=>fetch('http://127.0.0.1:'+server.address().port,options);
  try {
   await f.repo.transact(crypto.randomUUID(),{},async tx=>{
    const c=await tx.get('connection','grok');tx.put('connection',{...c,transport:kind==='dot-events'?'dots-events':'grok-webhook',credentials:await seal({url:'https://grok.com/webhook/automation/isolated-test',token:kind==='grok-bearer'?'isolated-provider-key':signing},secret)});
   });
   if(kind==='dot-events')await eventMethod(f.repo,'grok','events/subscribe',{name:'work.ready',arguments:{member_id:'grok'},delivery:{mode:'webhook',url:'https://chatgpt.com/isolated-test',secret:signing},ttlMs:3600000},secret,fetcher);
   const send=(type,args)=>conversationCommand(f.repo,f.identity,{owner:true},{type,requestId:crypto.randomUUID(),...args});
   const channel=await send('channel.create',{name:'Isolated callback benchmark',memberIds:['grok'],coordinatorId:'grok'});
   for(let i=0;i<100;i++){
    const message=await send('channel.post',{channelId:channel.id,body:kind+' sample '+i});
    const turn=(await f.repo.list('channel_turn',{scope:channel.id})).find(t=>t.messageId===message.id);
    const notice=await f.repo.get('outbox','notice_'+turn.id);
    await dispatchOne(f.repo,f.identity,notice.id,{ADMIN_KEY:secret},fetcher);
    const delivered=await f.repo.get('outbox',notice.id);assert.equal(delivered.status,'accepted');
    // completedAt is the dispatch operation's supplied timestamp, not the
    // wall-clock time after the HTTP response. Measure on this same machine.
    samples.push({i,saveToCallbackResponseMs:Date.now()-Date.parse(message.createdAt)});
    assert.equal((await f.repo.get('channel_turn',turn.id)).status,'ready','callback must not fabricate claim');
    await dispatchOne(f.repo,f.identity,notice.id,{ADMIN_KEY:secret},fetcher);assert.equal(deliveries,i+1,'accepted callback must not repeat');
    const claimed=await claimConversation(f.repo,f.identity,{memberId:'grok'},{requestId:crypto.randomUUID(),stepId:turn.id});
    await conversationTool(f.repo,f.identity,{memberId:'grok'},'post_message',{requestId:crypto.randomUUID(),channelId:channel.id,turnId:claimed.turnId,body:'Protocol fixture result '+i});
   }
   const sorted=samples.map(x=>x.saveToCallbackResponseMs).sort((a,b)=>a-b);
   assert(samples.every(x=>Number.isFinite(x.saveToCallbackResponseMs)&&x.saveToCallbackResponseMs>=0));
   results.push({kind,count:samples.length,errors,p95Ms:sorted[94],maxMs:sorted[99],samples,duplicateDeliveries:0,fabricatedNativeClaims:0});
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));for(const fn of cleanups)await fn();}
 }
 const result={scope:'Actual callback dispatch/signature/idempotency code, in-memory SQLite source, real loopback HTTP + fsync receiver; no official platform or model; not native received SLA',transports:results};
 await fs.writeFile('/tmp/duolawork-message-delivery-callback.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify({...result,transports:results.map(x=>({...x,samples:undefined}))}));
 assert(results.every(x=>x.errors.length===0));
} finally {await fs.rm(directory,{recursive:true,force:true});}
