import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startHarness} from './v1-harness.mjs';
const h=await startHarness();process.env.AGENT_HUB_DATA_DIR=path.join(h.directory,'local');
const {start}=await import('../local/server.mjs');let local,browser,release;
try {
 await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
 const member=await h.member('grok-bot','消息刷新验收');
 const channel=await h.command('channel.create',{name:'消息刷新验收',memberIds:[member.id]});
 await h.command('channel.post',{channelId:channel.id,body:'已有消息'});
 local=await start({port:0,maintenance:true,vaultKey:Buffer.alloc(32,31),config:{endpoint:h.base,adminKey:h.key,runnerId:'message-refresh'}});
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
 await page.addInitScript(id=>localStorage.setItem('hub-communication',JSON.stringify({channelId:id,chatKind:'group'})),channel.id);
 let hold=false,captured;const held=new Promise(r=>captured=r),gate=new Promise(r=>release=r);
 await page.route('**/api/v2/channel?*',async route=>{
  if(!hold)return route.continue();hold=false;const response=await route.fetch();captured();await gate;await route.fulfill({response});
 });
 await page.goto(local.url);await page.getByRole('heading',{name:'消息刷新验收',exact:true}).waitFor();
 await page.locator('.chat-message').filter({hasText:'已有消息'}).waitFor();
 hold=true;await held;
 const composer=page.getByRole('textbox',{name:'群消息'});await composer.fill('发送成功后不能消失');await composer.press('Enter');
 const sent=page.locator('.chat-message').filter({hasText:'发送成功后不能消失'});await sent.waitFor();
 await page.waitForFunction(()=>!document.querySelector('.message-send-status'));
 await page.evaluate(()=>{window.messageDisappeared=false;new MutationObserver(()=>{if(![...document.querySelectorAll('.chat-message')].some(m=>m.textContent.includes('发送成功后不能消失')))window.messageDisappeared=true;}).observe(document.querySelector('.messages-scroll'),{childList:true,subtree:true});});
 release();await page.waitForTimeout(500);
 assert.equal(await sent.count(),1,'A pre-send refresh must not remove the acknowledged message');
 assert.equal(await page.evaluate(()=>window.messageDisappeared),false,'The message must stay visible continuously');
 await page.waitForTimeout(6500);assert.equal(await sent.count(),1,'The next refresh must not duplicate the message');
 const persisted=await h.request('/v2/channel?id='+channel.id);assert.equal(persisted.messages.filter(m=>m.body==='发送成功后不能消失').length,1);
 await fs.writeFile('evidence/message-refresh-ui.json',JSON.stringify({at:new Date().toISOString(),passed:true,checks:['late pre-send snapshot cannot erase acknowledged message','no transient disappearance','next poll deduplicates','one persisted message']},null,2)+'\n');
 console.log('PASS: acknowledged message stays visible across stale refresh; no duplicate persisted');
} finally {release?.();await browser?.close();await local?.close();await h.stop();}
