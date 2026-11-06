import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionPickerStore} from '../ui/conversation/session-picker-store.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
test('picker caches per chat, coalesces reads, and refreshes without discarding visible inventory',async()=>{
 let count=0,clock=1;const waits=[];const store=createSessionPickerStore(()=>{count++;const d=deferred();waits.push(d);return d.promise;},{now:()=>clock});
 const first=store.load('m','a'),second=store.load('m','a');assert.equal(first,second);assert.equal(count,1);
 waits[0].resolve({items:[{id:'one'}]});await first;
 await store.load('m','a');assert.equal(count,1);
 clock+=21000;const refresh=store.load('m','a');assert.equal(store.snapshot('m','a').data.items[0].id,'one');assert.equal(store.snapshot('m','a').loading,true);
 waits[1].resolve({items:[{id:'two'}]});await refresh;
 assert.equal(store.snapshot('m','b').data,null);
});
test('one native write survives unsubscription; stale list cannot undo a completed binding',async()=>{
 const read=deferred(),write=deferred();let writes=0;
 const store=createSessionPickerStore((url,body)=>body?(writes++,write.promise):read.promise);
 const loading=store.load('m','a');read.resolve({items:[],binding:{sessionId:'old'}});await loading;
 const input={memberId:'m',channelId:'a',mode:'new'};const result=store.save(input);const unsubscribe=store.subscribe('m','a',()=>{});unsubscribe();
 assert.equal(store.save(input),result);assert.equal(writes,1);assert.equal(store.snapshot('m','a').pending.mode,'new');
 write.resolve({binding:{sessionId:'new'}});await result;
 assert.equal(store.snapshot('m','a').data.binding.sessionId,'new');assert.equal(store.snapshot('m','a').pending,null);
});
test('late read cannot revert successful write and unknown creation cannot automatically repeat',async()=>{
 const late=deferred();let reads=0,writes=0;
 const store=createSessionPickerStore((url,body)=>{if(body){writes++;return Promise.resolve({binding:{sessionId:'new'}});}return ++reads===1?Promise.resolve({items:[],binding:{sessionId:'old'}}):late.promise;});
 await store.load('m','a');const refresh=store.load('m','a',{force:true});await store.save({memberId:'m',channelId:'a',mode:'new'});late.resolve({items:[],binding:{sessionId:'old'}});await refresh;assert.equal(store.snapshot('m','a').data.binding.sessionId,'new');
 const uncertain=createSessionPickerStore((url,body)=>{writes++;return Promise.reject(Object.assign(Error('network'),{uncertain:true}));});
 const input={memberId:'m',channelId:'a',mode:'new'};await assert.rejects(uncertain.save(input));const before=writes;await assert.rejects(uncertain.save(input),/尚未确认/);assert.equal(writes,before);
});
