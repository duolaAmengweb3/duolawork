import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import readline from 'node:readline';
import {Agent,fetch as tlsFetch} from 'undici';
import {CodingMemberClient} from '../local/coding-client.mjs';
import {deliveryReceipt} from '../local/native-delivery.mjs';
import {privateJson} from '../local/storage.mjs';
const exec=promisify(execFile),target=JSON.parse(await fs.readFile(path.join(os.homedir(),'.config/agent-hub/server-deploy/target.json')));
const ssh=['-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2',...(target.identityFile?['-i',target.identityFile]:[]),...(target.directSSH?['-o','ProxyCommand=none']:[])];
const tlsHost=process.env.DUOLAWORK_WAN_DIRECT_TLS_HOST;
const evidenceFile=tlsHost?'/tmp/duolawork-message-delivery-wan-tls.json':'/tmp/duolawork-message-delivery-wan.json';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-wan-client-')),remoteFile='/tmp/duolawork-wan-control-'+crypto.randomUUID()+'.mjs';let control,tunnel,watcher,dispatcher;const pending=new Map(),networkRecoveries=[];let n=0;
const rpc=(op,args={})=>new Promise((resolve,reject)=>{const id=++n,t=setTimeout(()=>{pending.delete(id);reject(Error('WAN control timeout: '+op));},25000);pending.set(id,{resolve:v=>{clearTimeout(t);resolve(v);},reject:e=>{clearTimeout(t);reject(e);}});control.stdin.write(JSON.stringify({id,op,args})+'\n');});
try{
 await exec('scp',[...ssh,'tests/fixtures/wan-control.mjs',target.ssh+':'+remoteFile]);
 control=spawn('ssh',[...ssh,target.ssh,'/opt/agent-hub-node/bin/node',remoteFile,'/opt/agent-hub-server',...(tlsHost?[tlsHost]:[])],{stdio:['pipe','pipe','pipe']});
 let ready,rejectReady;const infoP=new Promise((r,j)=>{ready=r;rejectReady=j;});let stderr='';control.stderr.on('data',b=>stderr+=b);control.on('exit',code=>{const e=Error('WAN fixture exited '+code+': '+stderr);rejectReady(e);for(const p of pending.values())p.reject(e);pending.clear();});readline.createInterface({input:control.stdout}).on('line',line=>{const v=JSON.parse(line);if(!v.id)return ready(v);const p=pending.get(v.id);pending.delete(v.id);v.error?p?.reject(Error(v.error)):p?.resolve(v.result);});
 const info=await infoP,sock=net.createServer().listen(0,'127.0.0.1');await once(sock,'listening');const localPort=sock.address().port;await new Promise(r=>sock.close(r));
 if(!tlsHost)tunnel=spawn('ssh',[...ssh,'-N','-o','ExitOnForwardFailure=yes','-L',`127.0.0.1:${localPort}:127.0.0.1:${info.port}`,target.ssh],{stdio:'ignore'});
 if(tlsHost)dispatcher=new Agent({connect:{ca:info.cert}});
 const base=tlsHost?`https://${tlsHost}:${info.tlsPort}`:'http://127.0.0.1:'+localPort;
 const send=(url,options)=>tlsHost?tlsFetch(url,{...options,dispatcher}):fetch(url,options);
 // Only replay protocol requests which the server deduplicates by the SAME
 // requestId; never retry an unknown native side effect or account creation.
 const jsonRequest=async(url,{body,token,method=body===undefined?'GET':'POST',signal}={})=>{
  for(let attempt=0;;attempt++)try{const r=await send(url,{signal:signal||AbortSignal.timeout(25000),method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const v=await r.json();if(!r.ok)throw Object.assign(Error(JSON.stringify(v)),{status:r.status});return v;}
  catch(e){if(signal?.aborted||e.status||attempt>=2||method!=='GET'&&!body?.requestId)throw e;networkRecoveries.push({route:new URL(url).pathname,method,attempt:attempt+1,code:e.cause?.code||e.code||e.name,at:new Date().toISOString()});await new Promise(r=>setTimeout(r,300));}
 };
 const request=(route,body,token=info.key)=>jsonRequest(base+route,{body,token});
 for(let i=0;;i++){try{await request('/health');break;}catch(e){if(i>=50)throw e;await new Promise(r=>setTimeout(r,200));}}
 const command=async(type,args)=> (await request('/v2/commands',{type,requestId:crypto.randomUUID(),...args})).result;
 const account=(await request('/admin/action',{type:'account.create',payload:{platformId:'muse',label:'Isolated WAN fixture'}})).result;
 const member=(await request('/admin/action',{type:'member.create',payload:{accountId:account.id,name:'WAN protocol fixture',mode:'connector'}})).result;
 const {token}=await request('/admin/member-credential',{memberId:member.id});await rpc('seed',{memberId:member.id,accountId:account.id});
 const channel=await command('channel.create',{name:'Isolated WAN',memberIds:[member.id],coordinatorId:member.id}),sessionId='isolated-wan-native';await rpc('bind',{memberId:member.id,channelId:channel.id,sessionId});
 const grant=path.join(dir,'grant.json');await privateJson(grant,{endpoint:base,memberId:member.id,access_token:token});const client=new CodingMemberClient(grant,tlsHost?{request:jsonRequest}:{});
 const rtts=[];for(let i=0;i<20;i++){const t=performance.now();await request('/health');rtts.push(performance.now()-t);}
 let onEnvelope=()=>{},boot;const booted=new Promise(r=>boot=r),errors=[],samples=[];
 watcher=client.watch(async page=>{if(page.reset)boot();for(const w of page.inbox?.work||[])if(w.status==='ready')await onEnvelope(w);},{onError:e=>errors.push(e.message)});await booted;
 for(let i=0;i<100;i++){
  let resolve,reject;const done=new Promise((a,b)=>{resolve=a;reject=b;}),seen=new Set();
  onEnvelope=async w=>{if(w.delivery?.message?.body!=='WAN sample '+i||seen.has(w.stepId))return;seen.add(w.stepId);try{const arrived=performance.now();await privateJson(path.join(dir,'received.json'),w.delivery,{durable:true});const persisted=performance.now();const receipt=await deliveryReceipt(client,w,sessionId);resolve({w,receipt,receiverPersistMs:persisted-arrived,receiptRequestMs:performance.now()-persisted,clientArrivedAt:arrived});}catch(e){reject(e);}};
  const start=performance.now(),message=await command('channel.post',{channelId:channel.id,body:'WAN sample '+i});let timer;
  const {w,receipt,receiverPersistMs,receiptRequestMs,clientArrivedAt}=await Promise.race([done,new Promise((_,rej)=>timer=setTimeout(()=>rej(Error('WAN receive timeout '+i)),15000))]).finally(()=>clearTimeout(timer));
  samples.push({i,saveToReceiveAckMs:Date.parse(receipt.at)-Date.parse(message.createdAt),roundTripMs:performance.now()-start,postStartToEnvelopeMs:clientArrivedAt-start,receiverPersistMs,receiptRequestMs});
  await fs.writeFile(evidenceFile.replace('.json','-progress.json'),JSON.stringify({status:'measuring',count:samples.length,rtts,errors,networkRecoveries,samples},null,2));
  const claimed=await client.tool('claim_work',{requestId:crypto.randomUUID(),stepId:w.stepId,channelId:channel.id,expectedSessionId:sessionId});await client.tool('post_message',{requestId:crypto.randomUUID(),channelId:channel.id,turnId:claimed.turnId,body:'Isolated protocol result '+i});
  if((i+1)%20===0)console.log('WAN samples '+(i+1)+'/100');
 }
 console.log('WAN stopping notification watcher');watcher.stop();await watcher.finished;console.log('WAN saving offline recovery message');const late=await command('channel.post',{channelId:channel.id,body:'offline WAN recovery'});console.log('WAN restarting isolated server');await rpc('restart');assert((await client.inbox()).work.some(w=>w.delivery?.message?.id===late.id));
 const p95=v=>[...v].sort((a,b)=>a-b)[Math.ceil(v.length*.95)-1];
 const result={scope:tlsHost?'Mac to deployed VPS code in isolated Node/SQLite through direct TLS with pinned temporary certificate; independent TCP connections, no SSH tunnel for data; no CDN/model benchmark':'Mac to deployed VPS code in isolated Node/SQLite database over SSH encrypted WAN tunnel; receiver fsync and ACK; not public HTTPS proxy nor model benchmark',count:samples.length,errors,networkRecoveries,rttSamplesMs:rtts,p95RttMs:p95(rtts),p95SaveToReceiveAckMs:p95(samples.map(s=>s.saveToReceiveAckMs)),maxSaveToReceiveAckMs:Math.max(...samples.map(s=>s.saveToReceiveAckMs)),samples,restartRecovery:true};
 await fs.writeFile(evidenceFile,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,samples:undefined,rttSamplesMs:undefined}));assert.equal(errors.length,0);assert(result.p95SaveToReceiveAckMs<=1000);
}finally{
 watcher?.stop();await watcher?.finished;await dispatcher?.close();if(control&&control.exitCode===null)await rpc('stop').catch(()=>{});control?.stdin.end();tunnel?.kill('SIGTERM');await exec('ssh',[...ssh,target.ssh,'rm','-f',remoteFile]).catch(()=>{});await fs.rm(dir,{recursive:true,force:true});
}
