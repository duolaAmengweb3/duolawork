import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {chromium,_electron} from 'playwright-core';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-chat-recovery-'));
process.env.AGENT_HUB_DATA_DIR=directory;
const {startNodeHarness}=await import('./node-server-harness.mjs');
const {start}=await import('../local/server.mjs');
const h=await startNodeHarness();let local,browser,app,p;const results=[],errors=[];
try{
 const member=await h.member('Review agent');
 const a=await h.command('channel.create',{name:'草稿与历史 A',memberIds:[member.id],coordinatorId:member.id});
 const b=await h.command('channel.create',{name:'独立聊天 B',memberIds:[member.id],coordinatorId:member.id});
 const root=await h.command('channel.post',{channelId:a.id,body:'A 独有早期原文'});
 for(let i=0;i<58;i++)await h.command('channel.post',{channelId:a.id,body:'A 历史记录 '+i+'\n\n用于检查加载历史时切换聊天。'});
 const latest=await h.command('channel.post',{channelId:a.id,body:'引用早期原文的最新消息',replyTo:root.id});
 await h.command('channel.post',{channelId:b.id,body:'B 独有正文'});
 if(process.env.HUB_TEST_EXECUTABLE){
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({endpoint:h.base,adminKey:h.key,runnerId:'recovery-installed-isolated',port}),{mode:0o600});
  app=await _electron.launch({executablePath:process.env.HUB_TEST_EXECUTABLE,args:[],env:{...process.env,AGENT_HUB_DATA_DIR:directory,AGENT_HUB_TEST_MODE:'1'},timeout:20000});p=await app.firstWindow();
 }else{
  local=await start({port:0,maintenance:true,vaultKey:Buffer.alloc(32,25),config:{endpoint:h.base,adminKey:h.key,runnerId:'chat-recovery-isolated'}});
  browser=await chromium.launch({channel:'chrome',headless:true});p=await browser.newPage({viewport:{width:1440,height:960}});await p.goto(local.url);
 }
 p.on('pageerror',e=>errors.push(e.message));p.setDefaultTimeout(7000);
 let input=p.getByRole('textbox',{name:'群消息',exact:true});
 const select=async name=>{await p.getByRole('button',{name:new RegExp(name)}).first().click();await p.getByRole('heading',{name,exact:true,level:1}).waitFor();};
 const reset=async()=>{await p.unrouteAll({behavior:'wait'});await p.evaluate(id=>{localStorage.setItem('hub-communication',JSON.stringify({channelId:id,chatKind:'group'}));localStorage.removeItem('duolawork-outbox-v1');},a.id);await p.reload();await p.locator('#'+latest.id).waitFor();};
 const check=async(name,fn)=>{await reset();try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});}};
 await select('草稿与历史 A');await input.waitFor();
 await check('回复草稿按聊天保留，刷新后仍带原回复对象',async()=>{
  await p.locator('#'+latest.id).getByRole('button',{name:'回复 我',exact:true}).click();await input.fill('继续回复 A');
  await select('独立聊天 B');await input.fill('B 的草稿');await select('草稿与历史 A');
  assert.equal(await input.inputValue(),'继续回复 A');assert.equal(await p.getByRole('button',{name:'取消回复',exact:true}).count(),1);
  if(app){await app.close();app=await _electron.launch({executablePath:process.env.HUB_TEST_EXECUTABLE,args:[],env:{...process.env,AGENT_HUB_DATA_DIR:directory,AGENT_HUB_TEST_MODE:'1'},timeout:20000});p=await app.firstWindow();p.on('pageerror',e=>errors.push(e.message));p.setDefaultTimeout(7000);input=p.getByRole('textbox',{name:'群消息',exact:true});}else await p.reload();
  await input.waitFor();assert.equal(await input.inputValue(),'继续回复 A');await p.getByRole('button',{name:'取消回复',exact:true}).waitFor();
  await input.press('Enter');await p.waitForFunction(()=>!document.querySelector('.message-send-status'));
  const row=(await h.request('/v2/channel?id='+a.id)).messages.find(m=>m.body==='继续回复 A');assert.equal(row.replyTo,latest.id);
 });
 await check('失败消息原位修改重发，保留收件人、引用、回复和正在写的新草稿',async()=>{
  const message=p.locator('#'+latest.id);await message.getByRole('button',{name:'回复 我',exact:true}).click();
  await p.getByRole('button',{name:'提及成员',exact:true}).click();await p.getByRole('button',{name:'提及 Review agent',exact:true}).click();
  await message.getByRole('button',{name:'消息更多操作',exact:true}).click();await p.getByRole('menuitem',{name:'引用到聊天',exact:true}).click();
  const submitted=[];
  await p.route('**/v2/commands',async route=>{const body=route.request().postDataJSON();if(body.type==='channel.post'){submitted.push(body);if(body.body==='失败消息原稿')return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({message:'测试用确定性拒绝'})});}await route.continue();});
  await input.fill('失败消息原稿');await input.press('Enter');const row=p.locator('.chat-message').filter({hasText:'失败消息原稿'});await row.getByRole('button',{name:'修改',exact:true}).waitFor();const failed=p.locator('#'+await row.getAttribute('id'));await input.fill('正在写的下一条草稿');
  assert(await failed.getByRole('button',{name:'回复 我',exact:true}).isDisabled());assert(await failed.getByRole('button',{name:'消息更多操作',exact:true}).isDisabled());
  await failed.getByRole('button',{name:'修改',exact:true}).click();await failed.getByRole('textbox',{name:'修改消息',exact:true}).fill('失败消息修订版');assert.equal(await input.inputValue(),'正在写的下一条草稿');
  await failed.getByRole('button',{name:'重新发送',exact:true}).click();await p.waitForFunction(()=>!document.querySelector('.message-send-status'));
  const sent=(await h.request('/v2/channel?id='+a.id)).messages.find(m=>m.body==='失败消息修订版');assert(sent);assert.equal(sent.replyTo,latest.id);assert.deepEqual(sent.mentions,[member.id]);assert.equal(sent.refs[0].id,latest.id);
  assert.equal(await input.inputValue(),'正在写的下一条草稿');assert.equal(submitted.length,2);assert.notEqual(submitted[0].requestId,submitted[1].requestId);assert.equal((await h.request('/v2/channel?id='+a.id)).messages.filter(m=>m.body==='失败消息原稿').length,0);
 });
 await check('慢加载历史后切群，不把 A 的历史插入 B',async()=>{
  let started=false,finished=false;await p.route('**/v2/channel?*',async route=>{const u=new URL(route.request().url());if(u.searchParams.get('id')===a.id&&u.searchParams.has('before')){started=true;await new Promise(r=>setTimeout(r,1200));await route.continue();finished=true;return;}await route.continue();});
  await p.getByRole('button',{name:'查看更早消息',exact:true}).click();assert(started);await select('独立聊天 B');await p.waitForTimeout(1600);assert(finished);assert.equal(await p.locator('.chat-message').filter({hasText:'A 独有早期原文'}).count(),0);assert.equal(await p.locator('.chat-message').count(),1);
 });
 await check('点击较早消息的回复可定位原文，并返回原阅读位置',async()=>{
  assert.equal(await p.locator('#'+root.id).count(),0);await p.locator('#'+latest.id).locator('.reply-preview').click();await p.locator('#'+root.id).waitFor();
  await p.waitForFunction(id=>{const el=document.getElementById(id),box=document.querySelector('.messages-scroll').getBoundingClientRect(),r=el?.getBoundingClientRect();return r&&r.top<box.bottom&&r.bottom>box.top;},root.id);
  await p.getByRole('button',{name:'回到原阅读位置',exact:true}).click();await p.waitForFunction(id=>{const el=document.getElementById(id),box=document.querySelector('.messages-scroll').getBoundingClientRect(),r=el.getBoundingClientRect();return r.top<box.bottom&&r.bottom>box.top;},latest.id);
 });
 await check('定位原消息途中切群，迟到响应不污染另一个聊天',async()=>{
  let started=false;await p.route('**/v2/space-object?*',async route=>{if(new URL(route.request().url()).searchParams.get('id')===root.id){started=true;await new Promise(r=>setTimeout(r,1200));}await route.continue();});
  await p.locator('#'+latest.id).locator('.reply-preview').click();await p.waitForTimeout(60);assert(started);await select('独立聊天 B');await p.waitForTimeout(1600);assert.equal(await p.locator('.chat-message').count(),1);assert.equal(await p.getByRole('button',{name:'回到原阅读位置',exact:true}).count(),0);
 });
 assert.deepEqual(errors,[]);const report={at:new Date().toISOString(),scope:process.env.HUB_TEST_EXECUTABLE?'Installed desktop with isolated data and real HTTP backend; no native model calls.':'Actual browser UI and isolated real HTTP backend; no native model calls.',results,errors};
 const output=process.env.HUB_UX_EVIDENCE||'/tmp/chat-recovery-ui.json';await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));assert(results.every(r=>r.passed),'UX regression(s) failed; see '+output);
}finally{await browser?.close();await app?.close();await local?.close();await h.stop();await fs.rm(directory,{recursive:true,force:true});}
