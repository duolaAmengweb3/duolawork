import test from 'node:test';
import assert from 'node:assert/strict';
import {CodingMemberClient} from '../local/coding-client.mjs';
import {deliveryReceipt} from '../local/native-delivery.mjs';
test('parallel sessions share one inbox read, and stopping a watch discards its stale snapshot',async()=>{
 const client=new CodingMemberClient('isolated-'+crypto.randomUUID());let finish,reads=0,watching;
 client.api=async(route,{signal}={})=>{if(route.startsWith('/v2/changes')){if(!watching){watching=true;return{cursor:1,reset:true,changes:[],inbox:{work:[{stepId:'old'}]}};}return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}reads++;return new Promise(resolve=>finish=resolve);};
 const one=client.inbox(),two=client.inbox();assert.equal(reads,1);finish({work:[]});assert.deepEqual(await one,await two);
 let boot;const ready=new Promise(r=>boot=r),watcher=client.watch(()=>boot());await ready;assert.equal((await client.inbox()).work[0].stepId,'old');
 watcher.stop();await watcher.finished;const fresh=client.inbox();assert.equal(reads,2);finish({work:[{stepId:'new'}]});assert.equal((await fresh).work[0].stepId,'new');
});
test('receipts retry with stable identity and a user message correction gets a new fenced receipt',async()=>{
 const bodies=[],client={api:async(_route,{body})=>{bodies.push(body);return body;}},work={stepId:'turn',delivery:{attempt:0,message:{version:1}}};
 await deliveryReceipt(client,work,'session');await deliveryReceipt(client,work,'session');work.delivery.message.version=2;await deliveryReceipt(client,work,'session');
 assert.equal(bodies[0].requestId,bodies[1].requestId);assert.notEqual(bodies[1].requestId,bodies[2].requestId);assert.equal(bodies[2].sourceVersion,2);
});
