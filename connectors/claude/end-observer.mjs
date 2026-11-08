import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {privateJson} from '../../local/storage.mjs';

const markerFile=(dir,sessionId)=>path.join(dir,'monitor-state',sessionId+'.ended.json');
const read=file=>fs.readFile(file,'utf8').then(JSON.parse);
export async function flushNativeEnd({client,session,connectionDir}){
 const file=markerFile(connectionDir,session.sessionId);let marker;
 try{marker=await read(file);}catch(e){if(e.code==='ENOENT')return;throw e;}
 if(marker.sessionId!==session.sessionId)return;
 const pending=[];
 for(const turn of marker.turns){
  try{
   const requestId='claude-ended-'+createHash('sha256').update(JSON.stringify([marker.eventId,turn.turnId,turn.lease])).digest('hex');
   await client.api('/v2/self/conversation-state',{method:'POST',timeout:4000,body:{requestId,turnId:turn.turnId,lease:turn.lease,expectedSessionId:session.sessionId,state:'ended',nativeEvent:marker.event}});
  }catch(e){if(![403,404,409].includes(e.status))pending.push(turn);}
 }
 let current;try{current=await read(file);}catch(e){if(e.code==='ENOENT')return;throw e;}
 // A later native turn may have finished while this marker was in transit.
 if(current.eventId!==marker.eventId)return;
 if(pending.length)await privateJson(file,{...marker,turns:pending},{durable:true});else await fs.rm(file,{force:true});
}
export async function observeNativeEnd({client,session,connectionDir,claims={},work,input}){
 if(input.session_id!==session.sessionId||!['Stop','StopFailure','SessionEnd'].includes(input.hook_event_name))return {ignored:true};
 // A persistent Monitor is a notification listener, not an unfinished turn.
 // Counting our own always-on Monitor here would recreate the permanent lock.
 if(input.background_tasks?.some(t=>t.type!=='monitor'&&!['completed','failed','cancelled'].includes(t.status)))return {deferred:true};
 const observedAt=Date.now(),turns=Object.values(claims).filter(c=>!c.acknowledged&&c.turnId?.startsWith('turn_')&&c.lease&&(!c.claimedAtLocal||c.claimedAtLocal<=observedAt)).map(c=>({turnId:c.turnId,lease:c.lease}));
 const file=markerFile(connectionDir,session.sessionId);
 const marker={sessionId:session.sessionId,eventId:randomUUID(),event:input.hook_event_name,observedAt:new Date(observedAt).toISOString(),turns};
 // Persist event metadata before network access. No transcript files are read;
 // response text in the hook input is neither stored nor forwarded.
 await privateJson(file,marker,{durable:true});
 try{
  // Upgrade outstanding pre-observer claims which did not retain a local lease.
  // This fallback is only taken during this synchronous native event, never on
  // a deferred replay where a newer execution might have started.
  for(const w of await work()){
   if(w.kind!=='conversation'||!['claimed','active','running'].includes(w.status)||turns.some(t=>t.turnId===w.stepId))continue;
   const state=await client.api('/v2/self/conversation-state?turnId='+encodeURIComponent(w.stepId),{timeout:4000});
   if(state.status==='active'&&state.nativeSessionId===session.sessionId&&state.lease)turns.push({turnId:w.stepId,lease:state.lease});
  }
  await privateJson(file,{...marker,turns},{durable:true});
 }catch{/* Known leases remain durable for the Monitor to reconcile later. */}
 await flushNativeEnd({client,session,connectionDir});
 return {observed:true};
}
