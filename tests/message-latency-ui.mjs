import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-latency-ui-'));
process.env.AGENT_HUB_DATA_DIR=directory;
const {startNodeHarness}=await import('./node-server-harness.mjs');
const {start}=await import('../local/server.mjs');
const h=await startNodeHarness();let local,browser;const errors=[];
try{
 const member=await h.member('Protocol reviewer');const channel=await h.command('channel.create',{name:'UI latency',memberIds:[member.id],coordinatorId:member.id});
 const other=await h.command('channel.create',{name:'Other project',memberIds:[member.id],coordinatorId:member.id});
 local=await start({port:0,maintenance:true,vaultKey:Buffer.alloc(32,19),config:{endpoint:h.base,adminKey:h.key,runnerId:'latency-ui-isolated'}});
 browser=await chromium.launch({channel:'chrome',headless:true});const p=await browser.newPage({viewport:{width:1440,height:960}});p.on('pageerror',e=>errors.push(e.message));
 await p.goto(local.url);await p.getByRole('button',{name:/UI latency/}).first().click();
 const input=p.getByRole('textbox',{name:'群消息',exact:true});await input.waitFor();
 await p.evaluate(()=>{
  window.latencySamples=[];window.pendingSample=null;
  document.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&e.target.getAttribute('aria-label')==='群消息'&&e.target.value.startsWith('latency sample '))window.pendingSample={body:e.target.value,start:performance.now()};},true);
  new MutationObserver(()=>{const s=window.pendingSample;if(s&&[...document.querySelectorAll('.chat-message')].some(el=>el.textContent.includes(s.body))){window.pendingSample=null;requestAnimationFrame(()=>window.latencySamples.push({...s,paintMs:performance.now()-s.start}));}}).observe(document.body,{childList:true,subtree:true,characterData:true});
 });
 // Actual Enter handling and rendering, with deliberately slow command ACKs.
 // Samples include warm-up and outliers; no model/provider is invoked.
 await p.route('**/v2/commands',async route=>{if(route.request().postDataJSON()?.type==='channel.post')await new Promise(r=>setTimeout(r,120));await route.continue();});
 for(let i=0;i<100;i++){
  await input.fill('latency sample '+String(i).padStart(3,'0'));await input.press('Enter');
  await p.waitForFunction(n=>window.latencySamples.length===n,i+1);
 }
 await p.waitForFunction(()=>JSON.parse(localStorage.getItem('duolawork-outbox-v1')||'[]').length===0,{},{timeout:60000});
 const samples=await p.evaluate(()=>window.latencySamples);const sorted=samples.map(s=>s.paintMs).sort((a,b)=>a-b);
 const saved=await h.repo.list('channel_message',{scope:channel.id,limit:501});assert.equal(saved.length,100);assert.equal(new Set(saved.map(m=>m.requestId)).size,100);
 await input.fill('Draft survives changing groups');
 await p.getByRole('button',{name:/Other project/}).first().click();await p.getByRole('button',{name:/UI latency/}).first().click();assert.equal(await input.inputValue(),'Draft survives changing groups');
 const visible=p.locator('.chat-message');assert.equal(await visible.count(),50);
 // Keep this selector grounded in the rendered scrolling container.
 const scrollSelector=await p.evaluate(()=>{const m=document.querySelector('.chat-message');let e=m.parentElement;while(e&&e.scrollHeight<=e.clientHeight)e=e.parentElement;if(!e)throw Error('scroll container missing');e.dataset.latencyScroll='true';return '[data-latency-scroll="true"]';});
 await p.locator(scrollSelector).evaluate(el=>el.scrollTop=Math.max(10,el.scrollHeight/3));
 const before=await p.locator(scrollSelector).evaluate(el=>el.scrollTop);
 await h.command('channel.post',{channelId:channel.id,body:'Background update must not pull reader down'});
 await p.getByLabel('聊天记录').getByText('Background update must not pull reader down',{exact:true}).waitFor();
 const after=await p.locator(scrollSelector).evaluate(el=>el.scrollTop);assert(Math.abs(after-before)<120,'unexpected scroll jump '+before+' -> '+after);
 const result={scope:'built UI, actual Chromium Enter-to-animation-frame; isolated Node HTTP server; 120ms injected save-ACK delay; no model; not installed production desktop',count:samples.length,p50Ms:sorted[49],p95Ms:sorted[94],maxMs:sorted[99],errors,draftRetained:true,noDuplicateSaves:true,scrollRetained:true,samples};
 await fs.writeFile('/tmp/duolawork-message-latency-ui.json',JSON.stringify(result,null,2));console.log(JSON.stringify({...result,samples:undefined}));
 assert.equal(errors.length,0);assert(result.p95Ms<=100);
}finally{await browser?.close();await local?.close();await h.stop();await fs.rm(directory,{recursive:true,force:true});}
