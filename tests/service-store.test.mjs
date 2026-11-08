import test from 'node:test';
import assert from 'node:assert/strict';
import {createServiceStore} from '../ui/conversation/service-store.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('navigation shares one metadata read, including empty lists, and returns warm data without another network wait',async()=>{
 let calls=0,time=100;const read=deferred(),store=createServiceStore(()=>{calls++;return read.promise;},{now:()=>time});const first=store.load('/v2/connectors'),second=store.load('/v2/connectors');assert.equal(first,second);await Promise.resolve();assert.equal(calls,1);read.resolve({items:[]});await first;
 const snapshot=store.snapshot('/v2/connectors');assert.equal(snapshot.data.items.length,0);await store.load('/v2/connectors');assert.equal(calls,1);assert.equal(store.snapshot('/v2/connectors'),snapshot);
 time+=31000;await store.load('/v2/connectors');assert.equal(calls,2);
});
test('stale refresh retains visible data and failure; revoked authorization clears cached metadata',async()=>{
 let fail=false,code=503;const store=createServiceStore(async()=>{if(fail)throw Object.assign(Error('offline'),{status:code});return {items:[{id:'existing'}]};});await store.load('/v2/connectors');fail=true;
 const read=store.load('/v2/connectors',{force:true});assert.equal(store.snapshot('/v2/connectors').data.items[0].id,'existing');assert.equal(store.snapshot('/v2/connectors').loading,true);await assert.rejects(read);assert.equal(store.snapshot('/v2/connectors').data.items[0].id,'existing');assert.equal(store.snapshot('/v2/connectors').error,'offline');code=401;await assert.rejects(store.load('/v2/connectors',{force:true}));assert.equal(store.snapshot('/v2/connectors').data,null);
});
test('mutations fence an older pending read and invalidate every cached filter',async()=>{
 const reads=[];const store=createServiceStore(()=>{const r=deferred();reads.push(r);return r.promise;});const old=store.load('/v2/vault?query=');await Promise.resolve();store.invalidate('/v2/vault');const fresh=store.load('/v2/vault?query=');await Promise.resolve();reads[1].resolve({items:[{id:'new'}]});await fresh;reads[0].resolve({items:[{id:'old'}]});await old;assert.equal(store.snapshot('/v2/vault?query=').data.items[0].id,'new');
});
test('workspace change drops old data and fences an old workspace response; secret endpoints cannot enter this cache',async()=>{
 const old=deferred(),store=createServiceStore(()=>old.promise);store.setScope('A');const request=store.load('/v2/connectors');await Promise.resolve();store.setScope('B');old.resolve({items:[{id:'A-only'}]});await request;assert.equal(store.snapshot('/v2/connectors').data,null);
 for(const key of['/v2/vault?action=reveal','/v2/vault?action=get','/v2/vault?action=export','/v2/connectors?action=authorize','/v2/skills?skillId=private-body'])assert.throws(()=>store.snapshot(key));
});
test('connection metadata is independent of slow host status; inactive cache entries remain bounded',async()=>{
 const host=deferred();let calls=0;const store=createServiceStore(route=>{calls++;return route.includes('hosts')?host.promise:Promise.resolve({items:[]});},{limit:3});const waiting=store.load('/v2/connectors?action=hosts');await store.load('/v2/connectors');assert.ok(store.snapshot('/v2/connectors').data);assert.equal(store.snapshot('/v2/connectors?action=hosts').data,null);host.resolve({items:[]});await waiting;for(let i=0;i<5;i++)await store.load('/v2/vault?query='+i);const before=calls;await store.load('/v2/connectors');assert.equal(calls,before+1);
});
