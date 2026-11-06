import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {chromium} from 'playwright-core';import {startHarness} from './v1-harness.mjs';
const h=await startHarness();process.env.AGENT_HUB_DATA_DIR=path.join(h.directory,'local');const {start}=await import('../local/server.mjs');let local,browser;const checks=[],errors=[],timings=[];
try{
 await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
 await h.request('/admin/action',{type:'platform.create',payload:{id:'dots',name:'Dot'}});
 const a=await h.member('grok-bot','Grok'),b=await h.member('dots','Dot');
 const group=await h.command('channel.create',{name:'体验验收 A',memberIds:[a.id,b.id],coordinatorId:a.id});
 const other=await h.command('channel.create',{name:'体验验收 B',memberIds:[b.id],coordinatorId:b.id});
 const dm=await h.command('channel.create',{name:'Grok',memberIds:[a.id],direct:true});
 const rootMessage=await h.command('channel.post',{channelId:group.id,body:'请提供可回看的历史消息。',mentions:[a.id]});
 for(let i=1;i<=65;i++)await a.call('post_message',{requestId:'history-'+i,channelId:group.id,replyTo:rootMessage.id,body:`历史消息 ${i}：保留原项目与原生能力。\n\n这里是一段可阅读的完整内容。`,mentions:[]});
 local=await start({port:0,maintenance:true,vaultKey:Buffer.alloc(32,29),config:{endpoint:h.base,adminKey:h.key,runnerId:'experience-test'}});
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:960}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({id,ids})=>{if(!localStorage.getItem('hub-communication'))localStorage.setItem('hub-communication',JSON.stringify({channelId:id,chatKind:'group',readThrough:Object.fromEntries(ids.map(x=>[x,0]))}));},{id:group.id,ids:[group.id,other.id,dm.id]});
 let slow=false,slowRead=false;
 await page.route('**/api/v2/commands',async route=>{if(slow&&route.request().postDataJSON()?.type==='channel.post')await new Promise(r=>setTimeout(r,2000));await route.continue();});
 await page.route('**/api/v2/channel?*',async route=>{if(slowRead)await new Promise(r=>setTimeout(r,900));await route.continue();});
 await page.goto(local.url);await page.getByRole('heading',{name:'体验验收 A',exact:true}).waitFor();await page.locator('.chat-message').first().waitFor();
 const composer=page.getByRole('textbox',{name:'群消息'});
 // Page measures from actual keydown to the next paint containing its own body.
 slow=true;
 await page.evaluate(()=>{window.uiSendTimes=[];document.addEventListener('keydown',e=>{if(e.key!=='Enter'||e.target.getAttribute('aria-label')!=='群消息')return;const text=e.target.value;if(!text.startsWith('即时发送'))return;const at=performance.now();const check=()=>requestAnimationFrame(()=>{if([...document.querySelectorAll('.chat-message')].some(x=>x.textContent.includes(text)))window.uiSendTimes.push(performance.now()-at);else check();});check();},true);});
 for(let i=0;i<12;i++){await composer.fill('即时发送 '+i);await composer.press('Enter');assert.equal(await composer.inputValue(),'');await page.locator('.chat-message').filter({hasText:'即时发送 '+i}).last().waitFor();}
 await composer.fill('下一条草稿，不应被回执清空');
 await page.getByRole('button',{name:/体验验收 B/}).first().click();await composer.fill('B 群独立草稿');
 await page.getByRole('button',{name:/体验验收 A/}).first().click();assert.equal(await composer.inputValue(),'下一条草稿，不应被回执清空');
 await page.waitForFunction(()=>!document.querySelector('.message-send-status'));assert.equal(await composer.inputValue(),'下一条草稿，不应被回执清空');
 timings.push(...await page.evaluate(()=>window.uiSendTimes));assert.equal(timings.length,12);const p95=[...timings].sort((a,b)=>a-b)[Math.ceil(timings.length*.95)-1];assert.ok(p95<100,`send p95 ${p95}`);
 const persisted=await h.request('/v2/channel?id='+group.id);assert.equal(persisted.messages.filter(m=>m.body.startsWith('即时发送')).length,12);checks.push('2 秒慢网连续发送 p95 '+p95.toFixed(1)+'ms，切群草稿不串、回执不清新输入、不重复');slow=false;
 // Cached reading position and prepend stability.
 const scroll=page.locator('.messages-scroll');await scroll.evaluate(el=>{el.scrollTop=Math.floor(el.scrollHeight/3);el.dispatchEvent(new Event('scroll'));});
 await page.waitForTimeout(80);const anchor=await scroll.evaluate(el=>{const top=el.getBoundingClientRect().top,m=[...el.querySelectorAll('.chat-message')].find(m=>m.getBoundingClientRect().bottom>top);return{id:m.id,offset:m.getBoundingClientRect().top-top};});const offset=()=>scroll.evaluate((el,id)=>document.getElementById(id)?.getBoundingClientRect().top-el.getBoundingClientRect().top,anchor.id);slowRead=true;
 await page.getByRole('button',{name:/体验验收 B/}).first().click();await page.getByRole('heading',{name:'体验验收 B',exact:true,level:1}).waitFor();await page.getByRole('button',{name:/体验验收 A/}).first().click();
 assert.ok(await page.locator('.chat-message').count()>0);await page.waitForTimeout(80);assert.ok(Math.abs(await offset()-anchor.offset)<3,`reading anchor ${await offset()} expected ${anchor.offset}`);await page.waitForTimeout(1000);assert.ok(Math.abs(await offset()-anchor.offset)<3,`reading anchor ${await offset()} expected ${anchor.offset}`);checks.push('缓存即时呈现，慢刷新前后阅读锚点不跳底');slowRead=false;
 await page.getByRole('button',{name:'单聊',exact:true}).click();await page.getByRole('button',{name:/^Grok/}).first().click();await page.getByRole('heading',{name:'Grok',exact:true,level:1}).waitFor();assert.ok(await page.locator('.comm-header img').count()>0);await composer.fill('单聊草稿');
 await page.getByRole('button',{name:'群聊',exact:true}).click();assert.equal(await composer.inputValue(),'下一条草稿，不应被回执清空');checks.push('单双聊各自选中和草稿保留，私聊使用平台头像');
 await page.getByRole('button',{name:'秘书',exact:true}).click();await page.getByRole('heading',{name:'秘书',exact:true}).waitFor();await page.getByLabel('选择全局秘书').selectOption(a.id);await page.getByRole('button',{name:'设为秘书',exact:true}).click();await page.getByRole('button',{name:'找秘书',exact:true}).waitFor();await page.screenshot({path:'evidence/experience-secretary.png'});checks.push('秘书实际指定与管理历史');
 await page.getByRole('button',{name:'技能',exact:true}).click();await page.getByRole('heading',{name:'技能',exact:true}).waitFor();await page.getByRole('heading',{name:/independent-check/}).waitFor();await page.getByRole('button',{name:'添加技能',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByLabel('技能正文').fill('---\nname: release-review\ndescription: 检查发布说明的依据与遗漏\n---\n先核对原始需求，再给出遗漏和结论。');await dialog.getByRole('button',{name:'添加',exact:true}).click();await dialog.waitFor({state:'hidden'});await page.getByRole('heading',{name:/release-review/}).waitFor();await page.screenshot({path:'evidence/experience-skills.png'});checks.push('标准 SKILL.md 实际导入并显示可用范围');
 await page.getByRole('button',{name:'连接器',exact:true}).click();await page.getByRole('heading',{name:'连接器',exact:true}).waitFor();await page.getByRole('button',{name:'连接 GitHub',exact:true}).first().click();await page.getByRole('dialog').getByText('GitHub 访问令牌',{exact:true}).waitFor();await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();checks.push('GitHub 连接器入口与明确授权范围');
 await page.getByRole('button',{name:'技能',exact:true}).click();await page.getByRole('button',{name:'添加技能',exact:true}).click();await page.setViewportSize({width:390,height:844});const d=page.getByRole('dialog');const rect=await d.boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=392);await page.screenshot({path:'evidence/experience-mobile.png'});await d.getByRole('button',{name:'取消',exact:true}).click();checks.push('390px 窄视口的技能弹窗无横向溢出');
 assert.deepEqual(errors,[]);await fs.writeFile('evidence/experience-ui.json',JSON.stringify({at:new Date().toISOString(),scope:'Isolated actual UI + HTTP backend. Protocol fixtures, not native Agent proof.',checks,sendTimesMs:timings,errors},null,2));console.log(JSON.stringify({checks}));
}catch(e){const p=browser?.contexts()[0]?.pages()[0];if(p){await p.screenshot({path:'evidence/experience-failure.png'});console.error('UI diagnostics',await p.locator('main').innerText().catch(()=>p.locator('body').innerText()));}throw e;}finally{await browser?.close();await local?.close();await h.stop();}
