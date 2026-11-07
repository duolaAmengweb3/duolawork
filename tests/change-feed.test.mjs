import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './collaboration-helper.mjs';
import {Repository} from '../cloud/collaboration/repository.mjs';
import {changes} from '../cloud/collaboration/change-feed.mjs';
import {watchChanges} from '../local/change-watcher.mjs';

async function fixture(t){const db=database();t.after(()=>db.close());const repo=new Repository(db,'feed');await repo.transact('seed',{},tx=>{
  tx.put('channel',{id:'public',memberIds:['alice']});tx.put('channel',{id:'private',memberIds:['bob']});return {};
});return {db,repo,cursor:(await changes(repo,{owner:true})).cursor};}
const save=(repo,id,channelId='public')=>repo.transact(id,{id},tx=>tx.put('channel_message',{id,scopeId:channelId,body:'message body must never enter the journal'}));

test('committed invalidations wake immediately, idempotent writes emit once, failed transactions emit nothing',async t=>{
 const {repo,db,cursor}=await fixture(t);
 const waiting=changes(repo,{memberId:'alice'},{after:cursor});await new Promise(r=>setImmediate(r));
 const at=performance.now();await save(repo,'m1');const update=await waiting;
 assert.ok(performance.now()-at<500);assert.equal(update.changes.length,1);assert.equal(update.changes[0].id,'m1');assert.ok(!JSON.stringify(update).includes('message body'));
 await save(repo,'m1');assert.deepEqual((await changes(repo,{owner:true},{after:update.cursor,waitMs:0})).changes,[]);
 await assert.rejects(repo.transact('failed',{},tx=>{tx.put('channel_message',{id:'never',scopeId:'public'});throw Error('rollback');}),/rollback/);
 assert.equal(await repo.get('channel_message','never',false),null);
 const other=new Repository({prepare:db.prepare,batch:db.batch},'feed');await save(repo,'m2');
 assert.equal((await changes(other,{memberId:'alice'},{after:update.cursor,waitMs:0})).changes[0].id,'m2');
});

test('member scopes, private auth records and revoked authorization stay isolated during a held request',async t=>{
 const {repo,cursor}=await fixture(t);
 await save(repo,'secret','private');await repo.transact('token',{},tx=>tx.put('member_auth',{id:'token-hash',status:'active',secret:'no'}));
 assert.deepEqual((await changes(repo,{memberId:'alice'},{after:cursor,waitMs:0})).changes,[]);
 const after=(await changes(repo,{owner:true})).cursor;let revoked=false;
 const wait=changes(repo,{memberId:'alice'},{after,authorize:async()=>{if(revoked)throw Error('revoked');return{memberId:'alice'};}});
 await new Promise(r=>setImmediate(r));revoked=true;await save(repo,'after-revocation');await assert.rejects(wait,/revoked/);
});

test('expired or future cursor resets, cancellation stops waits, multiple pages drain without dropping changes',async t=>{
 const {repo,cursor}=await fixture(t);
 for(let i=0;i<105;i++)await save(repo,'page-'+i);
 const one=await changes(repo,{owner:true},{after:cursor,waitMs:0}),two=await changes(repo,{owner:true},{after:one.cursor,waitMs:0});
 assert.equal(one.changes.length+two.changes.length,105);assert.equal((await changes(repo,{owner:true},{after:999999,waitMs:0})).reset,true);
 const controller=new AbortController(),wait=changes(repo,{owner:true},{after:two.cursor,signal:controller.signal});controller.abort();await assert.rejects(wait);
 await repo.db.prepare('UPDATE hub_v2_clock SET revision=20000 WHERE workspace_id=?').bind('feed').run();
 assert.equal((await changes(repo,{owner:true},{after:0,waitMs:0})).reset,true);
 await assert.rejects(changes(repo,{owner:true},{after:'bad',waitMs:0}));
});

test('consumer replays failed refreshes, advances only after success, and aborts its outstanding request',async()=>{
 let reads=0,applies=0;const cursors=[],seen=[];let watcher;
 const alive=setTimeout(()=>{},1000);
 try{
 watcher=watchChanges({retryMs:1,request:async(route,signal)=>{reads++;seen.push(route);if(reads<=2)return{cursor:7,reset:true,changes:[]};return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},onChange:async()=>{if(++applies===1)throw Error('temporary read failure');},onCursor:n=>{cursors.push(n);setTimeout(()=>watcher.stop(),1);}});
 await watcher.finished;assert.deepEqual(cursors,[7]);assert.equal(seen[0],seen[1]);assert.equal(applies,2);
 }finally{clearTimeout(alive);watcher?.stop();}
});

test('100 protocol-only saves measure every receipt without a model or hidden warmup',async t=>{
 const {repo}=await fixture(t);let cursor=(await changes(repo,{owner:true})).cursor;const samples=[];
 for(let i=0;i<100;i++){
   const waiting=changes(repo,{memberId:'alice'},{after:cursor});await new Promise(r=>setImmediate(r));
   const start=performance.now();await save(repo,'measure-'+i);const page=await waiting;cursor=page.cursor;
   assert.equal(page.changes[0].id,'measure-'+i);samples.push(performance.now()-start);
 }
 const sorted=[...samples].sort((a,b)=>a-b);assert.ok(sorted[94]<1000);
 t.diagnostic(JSON.stringify({scope:'in-process SQLite commit to change notification, not remote native/model latency',count:100,p50:sorted[49],p95:sorted[94],max:sorted[99]}));
});
