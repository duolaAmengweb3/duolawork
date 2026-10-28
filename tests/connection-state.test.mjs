import test from 'node:test';
import assert from 'node:assert/strict';
import {accountConnectionState,hasVerifiedTools} from '../shared/platforms.mjs';

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
