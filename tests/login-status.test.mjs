import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LoginMonitor,classifyLogin} from '../local/login-status.mjs';
import {loginPresentation} from '../shared/platforms.mjs';

const authenticated={ready:true,composer:true,settings:true,library:true,goals:true};
test('登录只由平台界面组合确认，匿名输入框、其他站点和错误均不足以通过',()=>{
 assert.equal(classifyLogin('muse','https://muse.ai/',authenticated),'authenticated');
 assert.equal(classifyLogin('muse','https://muse.ai/',{ready:true,composer:true}),'unknown');
 assert.equal(classifyLogin('muse','https://example.com/',authenticated),'unknown');
 assert.equal(classifyLogin('muse','https://accounts.google.com/',authenticated),'signing_in');
 assert.equal(classifyLogin('muse','https://muse.ai/',{...authenticated,password:true}),'login_required');
 assert.equal(classifyLogin('muse','https://muse.ai/',{...authenticated,challenge:true}),'verification_required');
 assert.equal(classifyLogin('grok-bot','https://grok.com/',authenticated),'unknown');
 assert.equal(classifyLogin('grok-bot','https://grok.com/',{ready:true,composer:true,accountMenu:true}),'authenticated');
 assert.equal(classifyLogin('grok-bot','https://grok.com/',{ready:true,composer:true,signIn:true}),'login_required');
 assert.equal(classifyLogin('grok-bot','https://evil.example/',{ready:true,composer:true,accountMenu:true}),'unknown');
});

test('登录观察不打开、跳转或清理浏览器，缓存有节流，网络故障不触发重登',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-login-observation-'));
 try{
  const file=path.join(dir,'login-status.json'),account={id:'account_test',platformId:'muse'};
  let reads=0,signals=authenticated,fail=false;
  const page={url:()=> 'https://muse.ai/',isClosed:()=>false,evaluate:async()=>{reads++;if(fail)throw new Error('network lost');return signals;}};
  const manager={active:new Map([[account.id,{child:{pid:123},context:{pages:()=>[page]}}]])};
  const monitor=new LoginMonitor({file});
  const first=await monitor.check(account,manager);assert.equal(first.status,'authenticated');
  const before=await fs.readFile(file,'utf8');await monitor.check(account,manager);assert.equal(reads,1);
  const second=await monitor.check(account,manager,{force:true});assert.equal(second.status,'authenticated');
  assert.equal(await fs.readFile(file,'utf8'),before,'重复检查不刷写缓存');
  assert.equal((await fs.stat(file)).mode&0o777,0o600);
  fail=true;const uncertain=await monitor.check(account,manager,{force:true});assert.equal(uncertain.status,'unknown');assert.equal(uncertain.lastConfirmedAt,second.lastConfirmedAt);
  assert.equal(await fs.readFile(file,'utf8'),before,'网络故障不删除原确认记录');
  manager.active.clear();assert.equal((await monitor.check(account,manager)).status,'saved');
  const restarted=new LoginMonitor({file});assert.equal((await restarted.check(account,manager)).status,'saved');
  fail=false;signals={ready:true,signIn:true};manager.active.set(account.id,{child:{pid:124},context:{pages:()=>[page]}});
  assert.equal((await restarted.check(account,manager,{force:true})).status,'login_required');
  manager.active.clear();assert.equal((await restarted.check(account,manager)).status,'unknown','用户主动退出不能被历史记录恢复为已登录');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('已登录、保存的资料、无法确认与自动协作分别展示',()=>{
 assert.equal(loginPresentation({status:'authenticated'}).label,'已登录');
 assert.match(loginPresentation({status:'authenticated'}).detail,/协作状态见下方/);
 assert.equal(loginPresentation({status:'saved'}).label,'登录资料已保存');
 assert.equal(loginPresentation({status:'unknown'}).label,'登录待确认');
 assert.equal(loginPresentation({status:'login_required'}).label,'网站要求登录');
});
