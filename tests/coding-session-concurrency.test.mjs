import test from 'node:test';
import assert from 'node:assert/strict';
import {CodingManager} from '../local/coding-manager.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {recordNativeCompletion} from '../local/native-completion.mjs';

function setup({verified=true,ready=false}={}) {
 const manager=new CodingManager({config:{},dataDir:'/unused-concurrency-fixture'});
 const record={memberId:'gemini',engine:'antigravity-cli',enabled:true,sourceReady:true,status:'idle',executionReady:ready,chatBindings:{a:{sessionId:'one'},b:{sessionId:'two'},c:{sessionId:'three'},d:{sessionId:'one'}}};
 manager.records={gemini:record};manager.save=async()=>{};
 manager.client=()=>({api:async route=>{assert.equal(route,'/v2/self/status');return{complete:verified};},tool:async name=>{assert.equal(name,'list_work');return{work:Object.keys(record.chatBindings).map(channelId=>({channelId,status:'ready'}))};}});
 manager.syncExecutionBindings=async()=>{};
 let release;const gate=new Promise(r=>release=r),calls=[];
 manager.check=async state=>{calls.push({session:state.executionSessionId,channels:Object.keys(state.chatBindings)});await gate;};
 return{manager,record,calls,release};
}

test('verified original CLI receivers dispatch distinct sessions before any one session finishes',async()=>{
 const f=setup(),run=f.manager.tick();
 try{await new Promise(r=>setTimeout(r,30));assert.deepEqual(f.calls.map(x=>x.session).sort(),['one','three','two']);assert.deepEqual(f.calls.find(x=>x.session==='one').channels,['a','d']);}
 finally{f.release();await run;}
});

test('already migrated receivers have no fixed two-session ceiling and concurrent ticks cannot duplicate dispatch',async()=>{
 const f=setup({ready:true}),first=f.manager.tick();
 try{await new Promise(r=>setTimeout(r,30));const second=f.manager.tick();await new Promise(r=>setTimeout(r,30));assert.equal(f.calls.length,3);f.release();await second;}
 finally{f.release();await first;}
});

test('unverified connections still complete their verification before parallel chat execution',async()=>{
 const f=setup({verified:false}),run=f.manager.tick();
 try{await new Promise(r=>setTimeout(r,30));assert.equal(f.calls.length,1);assert.equal(f.calls[0].session,undefined);assert.equal(f.record.executionReady,false);}
 finally{f.release();await run;}
});

test('preparing one conversation holds only that native session, including its aliases',async()=>{
 const f=setup({ready:true});let finishPrepare;const prepareGate=new Promise(r=>finishPrepare=r);f.manager.assignSession=async()=>{f.record.status='connecting';await prepareGate;return{};};
 const assigning=f.manager.assign({memberId:'gemini',channelId:'a',sessionId:'one',mode:'existing'});await new Promise(r=>setTimeout(r,5));
 const running=f.manager.tick();
 try{await new Promise(r=>setTimeout(r,30));assert.deepEqual(f.calls.map(x=>x.session).sort(),['three','two']);assert.equal(f.manager.dispatchBlocked(f.manager.executionRecords(f.record).find(s=>s.executionSessionId==='one')),true);}
 finally{f.release();finishPrepare();await assigning;await running;}
 assert.equal(f.manager.dispatchHolds.size,0);await f.manager.tick();assert.ok(f.calls.some(x=>x.session==='one'));
});

test('remote routing hold survives preparation until cloud activation and releases on failure',async()=>{
 const f=setup({ready:true}),release=f.manager.holdDispatch({memberId:'gemini',channelId:'a',sessionId:'two'});
 f.manager.assignSession=async()=>{throw Error('original preserved');};
 await assert.rejects(f.manager.assign({memberId:'gemini',channelId:'a',sessionId:'two'}),/original preserved/);
 assert.equal(f.manager.dispatchHolds.size,1);const running=f.manager.tick();
 try{await new Promise(r=>setTimeout(r,30));assert.deepEqual(f.calls.map(x=>x.session),['three']);}finally{f.release();await running;release();}
 assert.equal(f.record.chatBindings.a.sessionId,'one');assert.equal(f.manager.dispatchHolds.size,0);
});

test('native background completion retains the process and claim through receiver shutdown without another model turn',async()=>{
 const f=setup({ready:true});let reads=0;const state={memberId:'gemini',enabled:true,inFlight:{at:new Date().toISOString(),stepId:'turn-bg'}};f.manager.stopped=true;
 const client={api:async()=>{reads++;assert.ok(state.inFlight);return{status:reads<3?'active':'done'};}};
 await f.manager.waitForNativeReceipt(state,client,{stepId:'turn-bg'},{rpc:{closed:false}},{interval:2,timeout:1000});assert.equal(reads,3);assert.equal(f.calls.length,0);
});

test('new requests can continue a settled failed session without replaying the failed turn',async()=>{
 const f=setup({ready:true});const state=f.manager.executionRecords(f.record).find(s=>s.executionSessionId==='one');state.status='needs_review';state.lastFailure={stepId:'failed'};
 f.manager.client=()=>({tool:async()=>({work:[{stepId:'failed',channelId:'a',status:'ready'}]})});await f.manager.tick();assert.equal(f.calls.length,0);
 f.manager.client=()=>({tool:async()=>({work:[{stepId:'failed',channelId:'a',status:'ready'},{stepId:'new-request',channelId:'a',status:'ready'}]})});const running=f.manager.tick();await new Promise(r=>setTimeout(r,5));f.release();await running;assert.deepEqual(f.calls.map(x=>x.session),['one']);
});

test('a Hub reply does not release the native session before its official fully-idle event',async()=>{
 const f=setup({ready:true});let reads=0;const state={memberId:'gemini',nativeLifecycle:'stop-hook-v1',enabled:true,inFlight:{at:new Date().toISOString(),stepId:'turn-tail'}};
 await f.manager.waitForNativeReceipt(state,{api:async()=>({status:'done'})},{stepId:'turn-tail'},{rpc:{closed:false}},{interval:2,timeout:1000,readCompletion:async()=>{assert.ok(state.inFlight);return{fullyIdle:++reads===3};}});assert.equal(reads,3);assert.equal(state.message,'已回复，原会话正在收尾');
 await assert.rejects(f.manager.waitForNativeReceipt(state,{api:async()=>({status:'active'})},{stepId:'turn-tail'},{rpc:{closed:false}},{interval:2,timeout:1000,readCompletion:async()=>({fullyIdle:true})}),/原生执行已结束，但尚未回群/);
});

test('receiver restart cannot release a replied native session whose background work is still alive',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dw-native-tail-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const f=setup({ready:true}),id=randomUUID();f.manager.dataDir=dir;
 const state={memberId:'gemini',nativeLifecycle:'stop-hook-v1',enabled:true,executionSessionId:id,managedNativePid:process.pid,managedNativeSessionIds:[id],inFlight:{stepId:'turn_tail'}},client={api:async route=>route.includes('conversation-state')?{status:'done'}:{complete:true}};
 await recordNativeCompletion(dir,{memberId:'gemini',sessionId:id,stepId:'turn_previous',fullyIdle:true});
 assert.equal(await f.manager.settleOriginal(state,client),false);assert.ok(state.inFlight);assert.equal(state.status,'working');
 await recordNativeCompletion(dir,{memberId:'gemini',sessionId:id,stepId:'turn_tail',fullyIdle:true});
 assert.equal(await f.manager.settleOriginal(state,client),true);assert.equal(state.inFlight,null);assert.equal(state.status,'idle');
});

for(const engine of ['codex','gemini-cli','antigravity-cli','antigravity'])for(const count of [1,2,3,4,5,10,17]){
 test(`${engine}: ${count} independent sessions stay concurrent with aliases, interleaved completions and overlapping polls`,async()=>{
  const f=setup({ready:true}),active=new Set(),releases=new Map(),seen=[];f.record.engine=engine;
  const ids=Array.from({length:count},(_,i)=>`native-${i}`);
  f.record.chatBindings=Object.fromEntries(ids.flatMap(id=>[[`chat-${id}`,{sessionId:id}],[`alias-${id}`,{sessionId:id}]]));
  const queued=new Set(ids);let duplicate=false;
  f.manager.client=()=>({tool:async()=>({work:[...queued].flatMap(id=>[{channelId:`chat-${id}`,status:'ready'},{channelId:`alias-${id}`,status:'ready'}])})});
  f.manager.check=async state=>{const id=state.executionSessionId;duplicate ||= active.has(id);active.add(id);seen.push(id);assert.deepEqual(Object.keys(state.chatBindings).sort(),[`alias-${id}`,`chat-${id}`]);await new Promise(r=>releases.set(id,r));queued.delete(id);active.delete(id);};
  const runs=[f.manager.tick()];const flush=()=>new Promise(r=>setImmediate(r));await flush();
  assert.equal(active.size,count);assert.deepEqual(new Set(seen),new Set(ids));
  runs.push(f.manager.tick());await flush();assert.equal(seen.length,count);
  // Finish arbitrary sessions; a slow one must not hold the others, and aliases
  // must never become a second concurrent writer to the same native context.
  for(const id of [...ids.filter((_,i)=>i%2),...ids.filter((_,i)=>!(i%2)).reverse()]){releases.get(id)();await flush();runs.push(f.manager.tick());await flush();assert.equal(seen.length,count);}
  await Promise.all(runs);assert.equal(duplicate,false);assert.equal(f.manager.jobs.size,0);
  queued.add(ids[0]);const next=f.manager.tick();await flush();assert.equal(seen.length,count+1);releases.get(ids[0])();await next;
 });
}
