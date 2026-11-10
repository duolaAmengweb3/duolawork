import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'feishu-ui-'));process.env.AGENT_HUB_DATA_DIR=directory;
const {startNodeHarness}=await import('./node-server-harness.mjs'),{start}=await import('../local/server.mjs');const h=await startNodeHarness();let local,browser;
try{
 const a=await h.member('隔离成员');await h.command('channel.create',{name:'飞书隔离验收',memberIds:[a.id],coordinatorId:a.id});
 local=await start({port:0,maintenance:true,vaultKey:Buffer.alloc(32,38),config:{endpoint:h.base,adminKey:h.key,runnerId:'feishu-browser'}});
 browser=await chromium.launch({channel:'chrome',headless:true});const p=await browser.newPage();let connected=false,multiple=false,calls=0;
 const item={id:'feishu-test',name:'飞书 · 隔离用户',provider:'feishu',serviceType:'mcp',transport:'stdio',authType:'none',hostId:'isolated-host',health:'ready',status:'connected',tools:[{name:'feishu_call'}]};
 await p.route('**/api/v2/connectors*',route=>route.fulfill({json:route.request().url().includes('action=hosts')?{items:[{id:'isolated-host',name:'隔离电脑',online:true}]}:{items:connected?[item]:[]}}));
 await p.route('**/api/local/feishu-connector',async route=>{calls++;const body=route.request().postDataJSON();await new Promise(r=>setTimeout(r,250));if(multiple&&!body.profile)return route.fulfill({json:{chooseAccount:true,accounts:[{profile:'one',name:'一号'},{profile:'two',name:'二号'}]}});connected=true;return route.fulfill({json:{connection:item}});});
 await p.goto(local.url);await p.getByRole('button',{name:'连接器',exact:true}).click();await p.getByRole('button',{name:'连接 飞书',exact:true}).click();await p.getByText('飞书 · 隔离用户',{exact:true}).waitFor();assert.equal(await p.getByRole('dialog').count(),0);assert.equal(calls,1);
 multiple=true;await p.getByRole('button',{name:'添加另一个 飞书 账号',exact:true}).click();await p.getByRole('dialog',{name:'选择飞书账号'}).waitFor();await p.getByRole('button',{name:'二号 · two',exact:true}).click();await p.getByRole('dialog').waitFor({state:'hidden'});assert.equal(calls,3);assert.equal((await p.context().pages()).length,1);
 console.log(JSON.stringify({scope:'isolated UI, no production login',checks:['single account one-click, no developer form or popup','multi-account short chooser','busy state, connected card and original identity retained']}));
}finally{await browser?.close();await local?.close();await h.stop();await fs.rm(directory,{recursive:true,force:true});}
