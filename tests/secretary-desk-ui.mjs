import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {chromium} from 'playwright-core';import {startHarness} from './v1-harness.mjs';
const h=await startHarness();process.env.AGENT_HUB_DATA_DIR=path.join(h.directory,'local');const {start}=await import('../local/server.mjs');let local,browser;const checks=[],errors=[];
try{
 await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
 const a=await h.member('grok-bot','秘书 Grok'),b=await h.member('grok-bot','同事');
 const c=await h.command('channel.create',{name:'秘书体验验收',memberIds:[a.id,b.id],coordinatorId:a.id});
 const base=await h.command('channel.post',{channelId:c.id,body:'核对项目进度',mentions:[a.id]});
 for(let i=1;i<=45;i++)await a.call('post_message',{requestId:'history-'+i,channelId:c.id,replyTo:base.id,body:`原群讨论 ${i}\n\n原阅读位置需要完整保留。`,mentions:[]});
 await h.request('/v2/management',{requestId:'assign',memberId:a.id,expectedVersion:0});
 const task=await h.command('channel.task',{channelId:c.id,action:'create',title:'整理发布结论',body:'需要明确候选和正式运行的区别'});
 local=await start({port:0,maintenance:true,vaultKey:Buffer.alloc(32,27),config:{endpoint:h.base,adminKey:h.key,runnerId:'secretary-test'}});
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1480,height:980}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(id=>localStorage.setItem('hub-communication',JSON.stringify({channelId:id,chatKind:'group'})),c.id);
 await page.goto(local.url);await page.getByRole('heading',{name:'秘书体验验收',exact:true,level:1}).waitFor();await page.locator('.chat-message').last().waitFor();
 const scroll=page.locator('.messages-scroll');await scroll.evaluate(el=>{el.scrollTop=el.scrollHeight/3;el.dispatchEvent(new Event('scroll'));});await page.waitForTimeout(300);const top=await scroll.evaluate(el=>el.scrollTop);
 await page.getByRole('button',{name:'秘书',exact:true}).click();const desk=page.getByRole('complementary',{name:'秘书工作台'});await desk.getByRole('button',{name:'日报',exact:true}).waitFor();assert.equal(await scroll.evaluate(el=>el.scrollTop),top);
 await desk.getByRole('button',{name:'全屏展开秘书'}).click();await desk.getByRole('button',{name:'收起全屏'}).click();await desk.getByRole('button',{name:'关闭秘书'}).click();assert.equal(await scroll.evaluate(el=>el.scrollTop),top);checks.push('打开、展开、关闭秘书不切群、不改变原阅读位置');
 await page.keyboard.press('Alt+KeyS');await desk.waitFor();await desk.getByRole('button',{name:'日报',exact:true}).click();const input=desk.getByRole('textbox',{name:'交代秘书'});assert.match(await input.inputValue(),/实际汇报/);
 let releasePoll,capturePoll;const pollGate=new Promise(r=>releasePoll=r),captured=new Promise(r=>capturePoll=r);let holdPoll=true;
 await page.route('**/v2/secretary',async route=>{if(route.request().method()==='GET'&&holdPoll){holdPoll=false;const response=await route.fetch();capturePoll();await pollGate;await route.fulfill({response});}else await route.continue();});
 await captured;await input.fill('请把当前项目的进展讲清楚');await input.press('Enter');assert.equal(await input.inputValue(),'');
 await desk.getByText('已发送',{exact:true}).waitFor();releasePoll();await page.waitForTimeout(300);
 assert.equal(await desk.locator('.secretary-receipt').filter({hasText:'请把当前项目的进展讲清楚'}).count(),1,'A stale in-flight poll cannot remove the acknowledged secretary request');
 await page.unroute('**/v2/secretary');await desk.getByRole('heading',{name:'请把当前项目的进展讲清楚'}).waitFor();
 assert.equal(await desk.locator('.secretary-receipt').filter({hasText:'请把当前项目的进展讲清楚'}).count(),1);checks.push('秘书发送确认保留到刷新读到回执，旧轮询不吞消息、不重复展示');
 const overview=await h.request('/v2/secretary');assert.equal(overview.requests.length,1);const r=overview.requests[0];assert.equal(r.context.channelId,c.id);
 const claimed=await a.call('receive_messages',{requestId:'receive-desk',channelId:r.channelId});assert.equal(claimed.input.secretaryRequests[0].id,r.id);
 await a.call('manage_workspace',{requestId:'update-result',action:'request_update',settings:{id:r.id,status:'done',progress:'已核对现有待办，发布结论尚未整理完成。'}});
 await a.call('post_message',{requestId:'answer-desk',channelId:r.channelId,turnId:claimed.turnId,body:'当前还需要整理发布结论。\n\n**下一步**：区分已经运行的版本与待启用候选。',mentions:[]});
 await desk.getByText('当前还需要整理发布结论。',{exact:true}).waitFor();await desk.getByText('已完成',{exact:true}).waitFor();checks.push('直接输入即时清空，真实HTTP委托携带当前群，Agent回执原位展示');
 // The server accepts a request but the browser loses the response. Retrying after reload must reuse the same request.
 await page.route('**/v2/secretary',async route=>{const body=route.request().postDataJSON();if(body?.action==='send'&&body.body==='模拟断网后继续交代'){await route.fetch();await route.abort('failed');}else await route.continue();});
 await input.fill('模拟断网后继续交代');await input.press('Enter');await desk.getByRole('button',{name:'重试这条'}).waitFor();
 await page.unroute('**/v2/secretary');await page.reload();await page.getByRole('button',{name:'秘书',exact:true}).click();await desk.getByRole('button',{name:'重试这条'}).waitFor();await desk.getByRole('button',{name:'重试这条'}).click();await desk.getByRole('button',{name:'重试这条'}).waitFor({state:'hidden'});assert.equal((await h.request('/v2/secretary')).requests.length,2);checks.push('发送响应丢失后重开和重试保留原请求，服务端不重复交办');
 await desk.getByRole('button',{name:'项目概览',exact:true}).first().click();await desk.getByText('0/1 项待办完成',{exact:false}).waitFor();checks.push('项目概览取真实Todo计数，不捏造项目完成率');
 await desk.getByRole('button',{name:'秘书设置'}).click();const dialog=page.getByRole('dialog');await dialog.getByText('每天给我项目日报',{exact:false}).click();await dialog.getByLabel('日报时间').fill('18:30');await dialog.getByRole('button',{name:'保存提醒'}).click();await dialog.waitFor({state:'hidden'});const settings=await h.request('/v2/secretary');assert.equal(settings.schedule.time,'18:30');assert.equal(settings.schedule.status,'enabled');checks.push('定时日报设置真实保存');
 await desk.getByRole('button',{name:'办事记录',exact:true}).click();await page.screenshot({path:'evidence/secretary-desk.png'});await desk.getByRole('button',{name:'关闭秘书'}).click();
 // Explicit start/stop controls and durable status in the main conversation.
 let meeting=await h.command('channel.meeting',{channelId:c.id,action:'prepare',body:'确认上线后如何跟进',coordinatorId:a.id});
 const claim=await a.call('receive_messages',{requestId:'meeting-prep',channelId:c.id});
 meeting=await a.call('meeting',{requestId:'meeting-plan',action:'plan',channelId:c.id,meetingId:meeting.id,ownerMessageId:meeting.lastOwnerMessageId,title:'上线跟进',goal:'明确后续验证',deliverable:'可执行的下一步',mode:'crosscheck',body:'各自核查，再汇总。',agenda:[{title:'需要验证什么'}]});
 await page.getByRole('button',{name:'查看安排',exact:true}).waitFor();await a.call('meeting',{requestId:'meeting-start',action:'start',channelId:c.id,meetingId:meeting.id});await page.locator('.meeting-status-strip').getByText('进行中',{exact:true}).waitFor();await page.getByRole('button',{name:'结束会议',exact:true}).click();await page.locator('.meeting-status-strip').getByText('已结束',{exact:true}).waitFor();checks.push('会议筹备、负责人自主开始、用户停止在顶部真实展示');
 const logos=await page.locator('img[src^="/brand/"]').evaluateAll(images=>images.map(i=>({src:i.getAttribute('src'),loaded:i.complete&&i.naturalWidth>0})));assert(logos.every(i=>i.loaded));assert(logos.some(i=>i.src.includes('loop.svg')));
 const svg=await page.request.get(local.url+'/brand/duolawork-bell-swing-primary-loop.svg');assert.match(await svg.text(),/prefers-reduced-motion:reduce/);const icon=await page.request.get(local.url+'/brand/favicon.svg');assert.equal(icon.status(),200);checks.push('官方Logo与动画素材加载，动态SVG含减少动态支持，favicon可用');
 await page.screenshot({path:'evidence/meeting-status-brand.png'});await page.setViewportSize({width:420,height:860});await page.getByRole('button',{name:'秘书',exact:true}).click();await desk.evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));const rect=await desk.boundingBox();assert(rect.x>=0&&rect.x+rect.width<=420);await page.screenshot({path:'evidence/secretary-desk-narrow.png'});checks.push('窄窗口秘书抽屉不横向溢出');
 assert.deepEqual(errors,[]);await fs.writeFile('evidence/secretary-desk-ui.json',JSON.stringify({at:new Date().toISOString(),scope:'Actual Chrome UI and isolated HTTP Hub; protocol Agent, not native model proof.',checks,logos,errors},null,2));console.log(JSON.stringify({checks}));
}catch(e){const p=browser?.contexts()[0]?.pages()[0];if(p){await p.screenshot({path:'evidence/secretary-desk-failure.png'});console.error((await p.locator('body').innerText()).slice(-10000));}throw e;}finally{await browser?.close();await local?.close();await h.stop();}
