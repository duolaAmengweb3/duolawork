import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DshManager} from '../local/dsh-manager.mjs';
import {DshHost} from '../local/dsh-host.mjs';
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-dsh-manager-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));let complete=false,online=true;const calls=[],bindings=[];
 const host={load:async()=>{},start:async()=>{},status:async()=>({online,configured:true,model:'fixture-model'}),sessions:async()=>({items:[{id:'original-session',title:'Original work',workspace:dir,running:false}]}),create:async()=>{throw Error('Must not create replacement');},call:async(route,body)=>{calls.push({route,body});if(!online)throw Error('offline');if(route==='/health')return{bindings};if(route==='/bind'){bindings.push({sessionId:body.sessionId,memberId:'member_one'});return{};}if(route==='/unbind'){bindings.length=0;return{nativeSessionRetained:true};}throw Error(route);}};
 const request=async(url,options={})=>{const route=new URL(url).pathname;calls.push({route,body:options.body});if(route==='/v2/workspace')return{members:[{id:'member_one',platformId:'deepseek-harness'},{id:'member_two',platformId:'deepseek-harness'}]};if(route==='/v2/connect/skill')return{pairingCode:'ONE_TIME_TEST'};if(route==='/v2/connect/redeem')return{memberId:'member_one',endpoint:'https://hub.test',access_token:'private-test-grant',expires_in:3600};if(route==='/v2/self/status')return{complete};return{};};
 const manager=new DshManager({config:{endpoint:'https://hub.test',adminKey:'private-admin-test'},dataDir:dir,host,request});await manager.load();
 return{dir,manager,host,calls,bindings,setComplete:v=>complete=v,setOnline:v=>online=v};
}
test('existing DSH binding preserves native work and becomes ready only after an actual provider receipt',async t=>{
 const f=await fixture(t);await f.manager.connect({memberId:'member_one',sessionId:'original-session'});await f.manager.jobs.get('member_one');await f.manager.tick();
 assert.equal(f.manager.records.member_one.sessionId,'original-session');assert.equal(f.manager.status()[0].verified,false);
 f.setComplete(true);await f.manager.tick();assert.equal(f.manager.status()[0].verified,true);
 const value=JSON.stringify(f.manager.status());assert.ok(!value.includes('private-test-grant'));assert.ok(!value.includes('private-admin-test'));
});
test('multiple members cannot silently share the same original native session or replace a bound session',async t=>{
 const f=await fixture(t);await f.manager.connect({memberId:'member_one',sessionId:'original-session'});await f.manager.jobs.get('member_one');
 await assert.rejects(f.manager.connect({memberId:'member_two',sessionId:'original-session'}),/另一位成员/);
 await assert.rejects(f.manager.connect({memberId:'member_one',sessionId:'another-session'}),/先解除连接/);
});
test('Hub reopens with the exact native session, private grant and model untouched; offline is not displayed as ready',async t=>{
 const f=await fixture(t);await f.manager.connect({memberId:'member_one',sessionId:'original-session'});await f.manager.jobs.get('member_one');await f.manager.stop();
 const original=await fs.readFile(f.manager.records.member_one.grantFile);const next=new DshManager({config:f.manager.config,dataDir:f.dir,host:f.host,request:f.manager.request});await next.load();f.bindings.length=0;f.setComplete(true);await next.start();
 assert.equal(next.status()[0].sessionId,'original-session');assert.equal(next.status()[0].verified,true);assert.deepEqual(await fs.readFile(next.records.member_one.grantFile),original);
 f.setOnline(false);await next.tick();assert.equal(next.status()[0].status,'offline');await next.stop();
});
test('disconnect does not terminate native work and retries only removal when the native Host was offline',async t=>{
 const f=await fixture(t);await f.manager.connect({memberId:'member_one',sessionId:'original-session'});await f.manager.jobs.get('member_one');f.setOnline(false);await f.manager.disconnect('member_one');assert.equal(f.manager.records.member_one.disconnectPending,true);
 f.setOnline(true);await f.manager.tick();assert.equal(f.manager.records.member_one.disconnectPending,false);assert.equal(f.manager.status()[0].enabled,false);assert.equal(f.manager.status()[0].sessionId,'original-session');
});
test('DSH model settings remain private and public status never returns API keys or native control tokens',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-dsh-host-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const h=new DshHost(dir,{home:dir});await h.load();await h.configure({apiKey:'private-bai-test-only'});
 assert.equal((await fs.stat(h.location.modelFile)).mode&0o777,0o600);assert.ok(!JSON.stringify(await h.status()).includes('private-bai-test-only'));
 await assert.rejects(h.configure({apiKey:'private-test',baseUrl:'https://untrusted.invalid/v1'}),/官方接口/);
});
test('repeat connect clicks share one setup, while an ambiguous new-session creation is not replayed',async t=>{
 const f=await fixture(t);await Promise.all([f.manager.connect({memberId:'member_one',sessionId:'original-session'}),f.manager.connect({memberId:'member_one',sessionId:'original-session'})]);await f.manager.jobs.get('member_one');assert.equal(f.calls.filter(c=>c.route==='/v2/connect/redeem').length,1);
 f.manager.records.member_two={memberId:'member_two',mode:'new',creationPending:true,enabled:true};await f.manager.connect({memberId:'member_two',mode:'new'});await f.manager.jobs.get('member_two');assert.equal(f.manager.records.member_two.status,'needs_review');assert.match(f.manager.records.member_two.message,/未重复创建/);
});

test('restoring Host bindings is not presented as a verified, available connection',async t=>{
 const f=await fixture(t);await f.manager.connect({memberId:'member_one',sessionId:'original-session'});await f.manager.jobs.get('member_one');f.setComplete(true);await f.manager.tick();
 const previous=f.host.call;f.host.call=async(route,body)=>route==='/health'?{ready:false,bindings:[]}:previous(route,body);await f.manager.tick();assert.equal(f.manager.status()[0].status,'connecting');
});
