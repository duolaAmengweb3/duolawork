import test from 'node:test';
import assert from 'node:assert/strict';
import {accountConnectionState,hasVerifiedTools} from '../shared/platforms.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentConnections} from '../local/connections.mjs';

test('关闭浏览器的暂停状态跨重启保留，不影响其他账号，明确打开后才恢复',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-pause-test-'));
 try{
  const a={id:'account_first',platformId:'muse'},b={id:'account_second',platformId:'grok-bot'},restored=[];
  const options={file:path.join(dir,'connections.json'),browsers:{isManual:()=>false,ensureBackground:async account=>restored.push(account.id)},logins:{load:async()=>{},records:{[a.id]:{status:'authenticated'},[b.id]:{status:'authenticated'}}},cloud:{}};
  const state={settings:{automation:true},accounts:[a,b],members:[a,b].map(account=>({id:'member_'+account.id,accountId:account.id,status:'ready',evidence:{kind:'browser_roundtrip'}})),tasks:[]};
  await new AgentConnections(options).pauseBrowser(a);
  const recovered=new AgentConnections(options);await recovered.sync(state);
  assert.deepEqual(restored,[b.id]);assert.equal(recovered.snapshot()[a.id].browserPaused,true);
  await recovered.enable(a);restored.length=0;await recovered.sync(state);
  assert.deepEqual(restored,[a.id,b.id]);assert.equal(recovered.snapshot()[a.id].browserPaused,false);
  assert.equal(options.logins.records[a.id].status,'authenticated','pause must not log the account out');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('关闭动作发生在后台读取登录记录期间，也不能随后重新拉起浏览器',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-pause-race-'));
 try{
  let entered,release;const enteredPromise=new Promise(resolve=>{entered=resolve;}),releasePromise=new Promise(resolve=>{release=resolve;});
  const account={id:'account_first',platformId:'muse'},restored=[];
  const connections=new AgentConnections({file:path.join(dir,'connections.json'),browsers:{isManual:()=>false,ensureBackground:async a=>restored.push(a.id)},logins:{records:{[account.id]:{status:'authenticated'}},load:async()=>{entered();await releasePromise;}},cloud:{}});
  const sync=connections.sync({settings:{automation:true},accounts:[account],members:[],tasks:[]});
  await enteredPromise;await connections.pauseBrowser(account);release();await sync;
  assert.deepEqual(restored,[]);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('saved account flags never assert a website login or a working Agent',()=>{
 const account={id:'account-a',status:'connected'};
 for(const members of [[],[{accountId:account.id,status:'ready'}]]){
  const state=accountConnectionState(account,members);
  assert.equal(state.value,'unverified');
  assert.equal(state.label,'协作未接通');
  assert.equal(state.loginLabel,'网页登录未自动核验');
 }
});

test('a real tool receipt has bounded wording and belongs to its own account',()=>{
 const m={accountId:'account-a',status:'ready',lastSeenAt:'2026-10-27T06:00:00Z',evidence:{evidenceId:'note-a',at:'2026-10-27T06:00:00Z',kind:'native_roundtrip'}};
 assert.equal(hasVerifiedTools(m),true);
 const state=accountConnectionState({id:'account-a'},[m]);
 assert.equal(state.label,'工具已验证');
 assert.match(state.detail,/自动接单与交付仍需单独验证/);
 assert.equal(state.loginLabel,'网页登录未自动核验');
 assert.equal(accountConnectionState({id:'account-b'},[m]).value,'unverified');
 assert.equal(hasVerifiedTools({...m,status:'unverified'}),false);
 assert.equal(hasVerifiedTools({...m,evidence:{...m.evidence,kind:'manual'}}),false);
});
