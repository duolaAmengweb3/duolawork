import test from 'node:test';
import assert from 'node:assert/strict';
import {LoginMonitor} from '../local/login-status.mjs';
import {loginPresentation} from '../shared/platforms.mjs';
import {ManualLoginSessions} from '../local/manual-login.mjs';

test('纯手动登录期间不读取页面、不沿用缓存冒充已登录',async()=>{
 const monitor=new LoginMonitor({file:'/nonexistent/hub-manual-fixture'});monitor.loading=Promise.resolve();monitor.records.account_fixture={status:'authenticated',lastConfirmedAt:'old-proof'};
 const manager={isManual:()=>true,get active(){throw new Error('must not read browser');}};
 const value=await monitor.check({id:'account_fixture'},manager,{force:true});
 assert.equal(value.status,'manual_login');assert.equal(value.method,'human-only-chrome');assert.match(loginPresentation(value).detail,/不读取或控制/);
});

test('手动登录切换尚在进行时也禁止自动恢复',()=>{
 const manual=new ManualLoginSessions({});manual.transitions.add('account_fixture');assert.equal(manual.has('account_fixture'),true);
 manual.transitions.delete('account_fixture');assert.equal(manual.has('account_fixture'),false);
});
