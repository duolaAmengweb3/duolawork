import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadCoalescer} from '../ui/conversation/read-coalescer.mjs';
test('100 burst invalidations become one trailing read and another conversation stays independent',async()=>{
 const read=createReadCoalescer();let release,calls=0,other=0;
 const job=()=>{if(++calls===1)return new Promise(r=>release=r);};
 const requests=[read('one:chat',job)];for(let i=0;i<100;i++)requests.push(read('one:chat',job));
 await read('two:chat',async()=>{other++;});assert.equal(other,1);assert.equal(calls,1);
 release();await Promise.all(requests);assert.equal(calls,2);
 await assert.rejects(read('one:chat',async()=>{throw Error('offline');}),/offline/);
 await read('one:chat',async()=>{calls++;});assert.equal(calls,3);
});
