import test from 'node:test';
import assert from 'node:assert/strict';
import {CodingManager} from '../local/coding-manager.mjs';

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
