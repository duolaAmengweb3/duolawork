import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startHarness} from './v1-harness.mjs';
const h=await startHarness();process.env.AGENT_HUB_DATA_DIR=path.join(h.directory,'local');const {start}=await import('../local/server.mjs');let local,browser;const errors=[],checks=[];
try{
 await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
 const leader=await h.member('grok-bot','负责人'),peer=await h.member('grok-bot','核查成员');
 const c=await h.command('channel.create',{name:'持续任务交互验收',memberIds:[leader.id,peer.id],coordinatorId:leader.id});
 const source=await h.command('channel.post',{channelId:c.id,body:'请整理方案，先不对外发布'});
 let task=await leader.call('board_task',{requestId:crypto.randomUUID(),channelId:c.id,action:'plan',intent:{goal:'交付可修改的方案',范围:['讨论和整理','暂不发布'],交付:{格式:'简洁建议'}},messageIds:[source.id]});
 local=await start({port:0,maintenance:false,vaultKey:Buffer.alloc(32,18),config:{endpoint:h.base,adminKey:h.key,runnerId:'task-intents-ui'}});browser=await chromium.launch({channel:'chrome',headless:true});const p=await browser.newPage({viewport:{width:1440,height:1000}});p.on('pageerror',e=>errors.push(e.message));await p.goto(local.url);await p.getByRole('heading',{name:c.name,level:1,exact:true}).waitFor();
 const card=p.locator('.task-intent-card').first();await card.getByRole('button',{name:/交付可修改的方案/}).click();const space=p.getByRole('complementary',{name:'协作空间'});await space.getByRole('heading',{name:'任务理解',exact:false}).waitFor();checks.push('群内意图卡片打开当前任务，动态范围可读，无确认关卡');
 await space.getByLabel('补充任务',{exact:true}).fill('补充：加入成本比较');await space.getByRole('button',{name:'发送补充',exact:true}).click();await p.locator('.message-markdown').getByText('补充：加入成本比较',{exact:true}).waitFor();
 let data=await h.request('/v2/channel?id='+c.id),supp=data.messages.find(m=>m.body==='补充：加入成本比较');assert.deepEqual(supp.recipientIds,[leader.id]);assert.equal(supp.taskCard.action,'supplement');assert.equal(supp.taskIds[0],task.id);checks.push('侧栏补充即时回群，默认负责人，服务端同一条消息关联任务');
 await space.getByLabel('补充任务通知对象').selectOption(peer.id);await space.getByLabel('补充任务',{exact:true}).fill('只请你核查来源');await space.getByRole('button',{name:'发送补充',exact:true}).click();await p.locator('.message-markdown').getByText('只请你核查来源',{exact:true}).waitFor();data=await h.request('/v2/channel?id='+c.id);assert.deepEqual(data.messages.find(m=>m.body==='只请你核查来源').recipientIds,[peer.id]);checks.push('显式@只通知对应成员，未被任务负责人的默认路由覆盖');
 await space.getByLabel('补充任务',{exact:true}).fill('暂存草稿');await p.reload();await p.getByRole('heading',{name:c.name,level:1,exact:true}).waitFor();await p.locator('.task-intent-card').first().getByRole('button',{name:/交付可修改的方案/}).click();await space.getByLabel('补充任务',{exact:true}).waitFor();assert.equal(await space.getByLabel('补充任务',{exact:true}).inputValue(),'暂存草稿');checks.push('任务草稿跨刷新保留');
 await space.locator('.task-understanding').getByRole('button',{name:'修改',exact:true}).click();await space.getByLabel('任务目标',{exact:true}).fill('交付方案并保留成本对照');await space.getByRole('button',{name:'保存并继续',exact:true}).click();await space.locator('.task-understanding').getByText('交付方案并保留成本对照',{exact:true}).waitFor();task=await h.request('/v2/space-object?'+new URLSearchParams({channelId:c.id,kind:'task',id:task.id}));assert.equal(task.intent.goal,'交付方案并保留成本对照');assert.equal(task.intentVersion,2);checks.push('人类直接修改理解，保存立即生效并通知跟进人');
 await space.getByRole('button',{name:'添加到会话',exact:true}).first().click();await p.locator('.chat-composer .composer-references').getByText('交付方案并保留成本对照',{exact:false}).waitFor();checks.push('添加到会话沿用主输入框，不丢任务引用');
 await p.setViewportSize({width:1000,height:800});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);await fs.mkdir('evidence/screenshots',{recursive:true});await p.screenshot({path:'evidence/screenshots/task-intents.png'});await fs.writeFile('evidence/task-intents-ui.json',JSON.stringify({at:new Date().toISOString(),scope:'isolated real HTTP/browser, not native model acceptance',checks,errors},null,2)+'\n');console.log(JSON.stringify(checks));
}finally{await browser?.close();await local?.close();await h.stop();}
