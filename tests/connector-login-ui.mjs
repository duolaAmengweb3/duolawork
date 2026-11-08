import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-login-ui-'));
process.env.AGENT_HUB_DATA_DIR=directory;
const {startNodeHarness}=await import('./node-server-harness.mjs'),{start}=await import('../local/server.mjs');
const h=await startNodeHarness();let local,browser;
try{
 const a=await h.member('隔离成员');await h.command('channel.create',{name:'登录隔离验收',memberIds:[a.id],coordinatorId:a.id});
 local=await start({port:0,maintenance:true,vaultKey:Buffer.alloc(32,37),config:{endpoint:h.base,adminKey:h.key,runnerId:'login-browser'}});
 browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext(),p=await context.newPage();
 let connection,fail=false,ready=false;
 await context.route('https://auth.example.test/**',route=>route.fulfill({contentType:'text/html',body:'<h1>Isolated provider consent</h1>'}));
 await p.route('**/api/v2/connectors',async route=>{
  if(route.request().method()==='GET')return route.fulfill({json:{items:connection?[{...connection,...(ready?{health:'ready',status:'connected',tools:[{name:'list_projects'}]}:{})}]:[]}});
  const args=route.request().postDataJSON();connection={id:'isolated-oauth',provider:'vercel',serviceType:'mcp',name:'Vercel',url:'https://mcp.vercel.com',authType:'oauth',transport:'http',health:'authorization_required',status:'configured',tools:[]};
  await new Promise(r=>setTimeout(r,450));
  return route.fulfill({json:{connection,...(fail?{issue:{message:'服务方暂未提供登录地址，请重试'}}:{authorizationUrl:'https://auth.example.test/authorize?state=isolated'})}});
 });
 await p.goto(local.url);await p.getByRole('button',{name:'连接器',exact:true}).click();
 await p.getByRole('button',{name:'连接 Vercel',exact:true}).click();
 const popupEvent=p.waitForEvent('popup');await p.getByRole('dialog').getByRole('button',{name:'保存并连接'}).click();
 const popup=await popupEvent;await popup.waitForURL('https://auth.example.test/**');await popup.getByRole('heading',{name:'Isolated provider consent'}).waitFor();await popup.close();
 await p.getByText('请在浏览器完成 Vercel 登录',{exact:true}).waitFor();
 const secondEvent=p.waitForEvent('popup');await p.getByRole('button',{name:'继续登录',exact:true}).click();await p.getByRole('button',{name:'正在连接…',exact:true}).waitFor();
 const second=await secondEvent;await second.waitForURL('https://auth.example.test/**');await second.close();
 ready=true;await p.getByText('连接已就绪',{exact:true}).waitFor();assert.equal(await p.getByRole('link',{name:'打开登录',exact:true}).count(),0);
 fail=true;ready=false;await p.getByRole('button',{name:'检查连接',exact:true}).click();await p.getByText('服务方暂未提供登录地址，请重试',{exact:false}).waitFor();
 assert.equal(context.pages().length,1,'an unsuccessful connection closes its waiting popup');
 console.log(JSON.stringify({scope:'isolated browser OAuth UI handoff, not real Vercel authorization',checks:['save directly opens OAuth consent','continue login directly opens consent with immediate progress','callback metadata refresh displays ready','missing login URL displays actionable error and closes waiting tab']}));
}finally{await browser?.close();await local?.close();await h.stop();await fs.rm(directory,{recursive:true,force:true});}
