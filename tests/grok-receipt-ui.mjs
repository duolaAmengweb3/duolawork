import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startHarness} from './v1-harness.mjs';
import {Repository} from '../cloud/collaboration/repository.mjs';
const h=await startHarness();process.env.AGENT_HUB_DATA_DIR=path.join(h.directory,'local');
const {start}=await import('../local/server.mjs');let local,browser;
const checks=[],errors=[],repo=new Repository(h.db,'v1-test');
try{
 await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
 const grok=await h.member('grok-bot','Grok'),c=await h.command('channel.create',{name:'Grok 接收状态验收',memberIds:[grok.id],coordinatorId:grok.id});
 const a=await h.command('channel.post',{channelId:c.id,body:'请核对这份终审意见。'}),b=await h.command('channel.post',{channelId:c.id,body:'补充：请附上核验依据。'});
 const ta=`turn_${a.id}_${grok.id}`,tb=`turn_${b.id}_${grok.id}`,na=`notice_${ta}`,nb=`notice_${tb}`;
 await repo.transact('fixture-platform-receipt',{},async tx=>{
  const n=await tx.get('outbox',na),child=await tx.get('outbox',nb);
  tx.put('outbox',{...n,status:'accepted',completedAt:new Date().toISOString()});
  tx.put('outbox',{...child,status:'coalesced',coalescedInto:na});
 });
 local=await start({port:0,vaultKey:Buffer.alloc(32,37),config:{endpoint:h.base,adminKey:h.key,runnerId:'grok-receipt-ui'}});
 browser=await chromium.launch({channel:'chrome',headless:true});const p=await browser.newPage({viewport:{width:1440,height:960}});p.on('pageerror',e=>errors.push(e.message));
 await p.goto(local.url);await p.getByRole('heading',{name:c.name,exact:true}).waitFor();
 await p.locator('.pending-member').filter({hasText:'2 条消息等待成员接收'}).waitFor();await p.locator('.pending-member').click();
 await p.waitForFunction(()=>[...document.querySelectorAll('.delivery-state')].filter(e=>e.textContent==='等待成员接收').length===2);
 assert.equal(await p.getByText('已送达',{exact:true}).count(),0);
 checks.push('Both the original message and coalesced supplement show waiting for Agent receipt, never delivered');
 await repo.transact('fixture-retry-receipt',{},async tx=>tx.put('outbox',{...(await tx.get('outbox',na)),unclaimedRetry:true}));
 await p.locator('.pending-member').filter({hasText:'尚未接收 · 已重新通知'}).waitFor();
 await p.waitForFunction(()=>[...document.querySelectorAll('.delivery-state')].filter(e=>e.textContent==='尚未接收 · 已重新通知').length===2);
 checks.push('Automatic recovery state reaches both chat indicator and exact-message detail');
 await repo.transact('fixture-unclaimed',{},async tx=>{for(const turnId of [ta,tb])tx.put('channel_turn',{...(await tx.get('channel_turn',turnId)),status:'stalled',reason:'已多次通知原平台，但成员仍未接收；消息已保留，可重试或查看原 Agent。'});});
 await p.waitForFunction(()=>[...document.querySelectorAll('.delivery-state')].filter(e=>e.textContent==='成员尚未接收').length===2);
 await p.locator('.delivery-entry details').first().locator('summary').click();await p.getByText('已多次通知原平台，但成员仍未接收；消息已保留，可重试或查看原 Agent。',{exact:true}).first().waitFor();
 checks.push('Failed receipt displays a concrete reason next to the original message, with retry available');
 const claim=await grok.call('receive_messages',{requestId:'fixture-late-claim',channelId:c.id});assert.equal(claim.input.triggerMessageIds.length,2);
 await grok.call('post_message',{requestId:'fixture-real-return',channelId:c.id,turnId:claim.turnId,body:'已核对，并附上核验依据。'});
 await p.locator('.chat-message').getByText('已核对，并附上核验依据。',{exact:true}).waitFor();
 await p.getByText('当前没有待处理的消息。',{exact:true}).waitFor();
 checks.push('Late authenticated receipt merges both requests and actual post_message clears pending state');
 assert.deepEqual(errors,[]);await p.screenshot({path:'evidence/grok-receipt-ui.png'});
 await fs.writeFile('evidence/grok-receipt-ui.json',JSON.stringify({at:new Date().toISOString(),isolated:true,realChrome:true,commercialGrokTested:false,checks,errors},null,2));console.log(JSON.stringify({checks}));
}catch(e){const p=browser?.contexts()[0]?.pages()[0];if(p){console.error((await p.locator('body').innerText()).slice(-4000));await p.screenshot({path:'evidence/grok-receipt-ui-failure.png'});}throw e;}
finally{await browser?.close();await local?.close();await h.stop();}
