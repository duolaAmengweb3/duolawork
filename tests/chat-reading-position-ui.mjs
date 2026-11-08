import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import net from 'node:net';import {chromium,_electron} from 'playwright-core';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-reading-'));process.env.AGENT_HUB_DATA_DIR=directory;
const {startNodeHarness}=await import('./node-server-harness.mjs');const {start}=await import('../local/server.mjs');const h=await startNodeHarness();let local,browser,app,p;const checks=[],errors=[];
try{
 const member=await h.member('阅读测试 Agent');const channel=await h.command('channel.create',{name:'历史阅读隔离验收',memberIds:[member.id],coordinatorId:member.id});
 const source=await h.command('channel.post',{channelId:channel.id,body:'开始隔离阅读验收'});
 const post=body=>member.client.tool('post_message',{requestId:crypto.randomUUID(),channelId:channel.id,replyTo:source.id,body,purpose:'result',mentions:[]});
 for(let i=1;i<=65;i++)await post('历史消息 '+i+'\n\n'+('这段文字用于检查阅读时的新消息、分页与窗口变化。'.repeat(4)));
 if(process.env.HUB_TEST_EXECUTABLE){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({endpoint:h.base,adminKey:h.key,runnerId:'reading-installed-isolated',port}),{mode:0o600});app=await _electron.launch({executablePath:process.env.HUB_TEST_EXECUTABLE,args:[],env:{...process.env,AGENT_HUB_DATA_DIR:directory,AGENT_HUB_TEST_MODE:'1'},timeout:20000});p=await app.firstWindow();}
 else{local=await start({port:0,maintenance:true,vaultKey:Buffer.alloc(32,29),config:{endpoint:h.base,adminKey:h.key,runnerId:'reading-isolated'}});browser=await chromium.launch({channel:'chrome',headless:true});p=await browser.newPage({viewport:{width:1440,height:960}});await p.goto(local.url);}
 p.on('pageerror',e=>errors.push(e.message));p.setDefaultTimeout(10000);await p.locator('.channel-list > button').filter({hasText:'历史阅读隔离验收'}).click();await p.getByLabel('群消息',{exact:true}).waitFor();await p.locator('.chat-message').last().waitFor();
 const sc=p.getByLabel('聊天记录',{exact:true});
 const anchor=()=>sc.evaluate(el=>{const box=el.getBoundingClientRect(),m=[...el.querySelectorAll('.chat-message')].find(m=>m.getBoundingClientRect().bottom>box.top);return{id:m?.id,offset:m?m.getBoundingClientRect().top-box.top:0,top:el.scrollTop};});
 const position=before=>sc.evaluate((el,before)=>{const m=document.getElementById(before.id);return m?m.getBoundingClientRect().top-el.getBoundingClientRect().top:null;},before);
 const hold=async before=>{const actual=await position(before);assert(actual!==null,'正在阅读的消息被移出了列表');assert(Math.abs(actual-before.offset)<4,'阅读锚点偏移 '+before.offset+' -> '+actual);};
 // Delay fallback history reads. A reader must not wait for a lost anchor to be refetched.
 await p.route('**/v2/channel?*',async route=>{if(new URL(route.request().url()).searchParams.has('before'))await new Promise(r=>setTimeout(r,900));await route.continue();});
 await sc.evaluate(el=>el.scrollTop=55);await p.waitForTimeout(300);const boundary=await anchor();
 const one=await post('Agent 新到消息 1');await p.locator('#'+one.id).waitFor();await hold(boundary);
 await p.waitForTimeout(1100);await hold(boundary);checks.push('阅读最新分页边界时，新消息到达不移除原文，不依赖慢历史回补');
 await p.unrouteAll({behavior:'wait'});
 const second=await post('Agent 新到消息 2');await p.locator('#'+second.id).waitFor();await hold(boundary);await p.getByRole('button',{name:'2 条新消息 · 回到最新',exact:true}).waitFor();
 await p.getByRole('button',{name:'2 条新消息 · 回到最新',exact:true}).click();await p.waitForFunction(()=>{const e=document.querySelector('.messages-scroll');return e.scrollHeight-e.scrollTop-e.clientHeight<4;});assert.equal(await p.locator('.new-message-jump').count(),0);
 const third=await post('Agent 新到消息 3');await p.locator('#'+third.id).waitFor();await p.waitForFunction(()=>{const e=document.querySelector('.messages-scroll');return e.scrollHeight-e.scrollTop-e.clientHeight<4;});checks.push('历史阅读只显示新消息数量，主动回到最新后恢复自动跟随');
 // A real wheel scroll, including updates during momentum, never snaps back.
 await sc.hover();await p.mouse.wheel(0,-700);await p.waitForTimeout(80);const during=await anchor();const fourth=await post('滚轮操作中的新消息');await p.locator('#'+fourth.id).waitFor();await p.waitForTimeout(320);await hold(during);checks.push('滚轮浏览期间和停止后都不被新消息拉回');
 // The scroll container itself changes height when surrounding controls change.
 const beforeResize=await anchor();await sc.evaluate(el=>{el.style.maxHeight='280px';});await p.waitForTimeout(160);await hold(beforeResize);await sc.evaluate(el=>{el.style.maxHeight='';});await p.waitForTimeout(160);await hold(beforeResize);checks.push('聊天区域高度变化保留同一消息和阅读偏移');
 await sc.evaluate(el=>el.scrollTop=0);await p.waitForTimeout(300);await p.getByRole('button',{name:'查看更早消息',exact:true}).click();await p.getByLabel('聊天记录').getByText(/^历史消息 1\n/).waitFor();await sc.evaluate(el=>el.scrollTop=160);await p.waitForTimeout(300);const early=await anchor();
 for(let i=0;i<4;i++){const m=await post('加载历史后的新消息 '+i);await p.locator('#'+m.id).waitFor();await hold(early);}checks.push('手动加载早期历史后连续收消息，原阅读位置保持');
 assert.deepEqual(errors,[]);const report={at:new Date().toISOString(),scope:process.env.HUB_TEST_EXECUTABLE?'Packaged Electron and isolated real HTTP backend':'Built browser and isolated real HTTP backend',executablePath:process.env.HUB_TEST_EXECUTABLE||null,checks,errors};await fs.writeFile(process.env.HUB_READING_EVIDENCE||'/tmp/chat-reading-position-ui.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(e){await p?.screenshot({path:'/tmp/chat-reading-failure.png'});throw e;}finally{await browser?.close();await app?.close();await local?.close();await h.stop();await fs.rm(directory,{recursive:true,force:true});}
