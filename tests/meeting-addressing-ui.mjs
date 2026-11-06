import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startHarness} from './v1-harness.mjs';
const h=await startHarness();process.env.AGENT_HUB_DATA_DIR=path.join(h.directory,'local');
const {start}=await import('../local/server.mjs');let local,browser;const checks=[],errors=[];
try {
 await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
 const host=await h.member('grok-bot','会议负责人'),peer=await h.member('grok-bot','指定成员');
 const c=await h.command('channel.create',{name:'会议与点名验收',memberIds:[host.id,peer.id],coordinatorId:host.id});
 const m=await h.command('channel.meeting',{channelId:c.id,action:'prepare',body:'讨论如何改进协作'});
 local=await start({port:0,maintenance:true,vaultKey:Buffer.alloc(32,36),config:{endpoint:h.base,adminKey:h.key,runnerId:'meeting-addressing-test'}});
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:960}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(id=>{if(!localStorage.getItem('hub-communication'))localStorage.setItem('hub-communication',JSON.stringify({channelId:id,chatKind:'group'}));},c.id);
 await page.goto(local.url);await page.getByRole('heading',{name:c.name,exact:true}).waitFor();
 await page.locator('.meeting-status-strip').getByText('筹备中',{exact:true}).waitFor();
 assert.equal(await page.locator('.chat-composer .composing-reply').count(),0);
 checks.push('群内已有筹备会议不自动把普通输入归入会议');
 // Enter the meeting explicitly, through the visible meeting record.
 await page.locator('.meeting-status-strip').getByRole('button').first().click();
 await page.getByRole('button',{name:'回到群聊继续沟通',exact:true}).click();
 await page.locator('.chat-composer .composing-reply').filter({hasText:'筹备会议'}).waitFor();
 await page.getByRole('button',{name:'提及成员',exact:true}).click();await page.getByRole('button',{name:'提及 指定成员',exact:true}).click();
 await page.locator('.composer-recipient').getByText('发给 指定成员',{exact:true}).waitFor();
 const composer=page.getByRole('textbox',{name:'群消息'});await composer.fill('请你确认在线');await composer.press('Enter');assert.equal(await composer.inputValue(),'');
 const card=page.locator('.chat-message').filter({hasText:'请你确认在线'}).last();await card.locator('.message-mentions').getByText('@指定成员',{exact:true}).waitFor();
 let snapshot;await assertEventually(async()=>{snapshot=await h.request('/v2/channel?id='+c.id);return snapshot.messages.some(x=>x.body==='请你确认在线');});
 const msg=snapshot.messages.find(x=>x.body==='请你确认在线');assert.deepEqual(msg.mentions,[peer.id]);assert.deepEqual(msg.recipientIds,[peer.id]);assert.equal(msg.meetingChat,true);
 const claim=await peer.call('receive_messages',{requestId:'peer-claim',channelId:c.id});assert.equal(claim.input.meeting,undefined);
 await peer.call('post_message',{requestId:'peer-answer',channelId:c.id,turnId:claim.turnId,replyTo:msg.id,body:'收到你的点名，可以正常交流',mentions:[]});
 await page.locator('.chat-message').getByText('收到你的点名，可以正常交流',{exact:true}).waitFor();
 checks.push('会议里选择@后提示、发送气泡和HTTP实际收件人一致，成员可领取并回复');
 await page.getByRole('button',{name:'提及全员',exact:true}).click();await page.locator('.composer-recipient').getByText('通知全员 · 2 位成员',{exact:true}).waitFor();
 await composer.fill('会议结束时保留这段草稿');
 await h.command('channel.meeting',{channelId:c.id,meetingId:m.id,action:'stop'});
 await page.locator('.meeting-status-strip').getByText('已结束',{exact:true}).waitFor();
 assert.equal(await page.locator('.chat-composer .composing-reply').count(),0);assert.equal(await composer.inputValue(),'会议结束时保留这段草稿');
 assert.equal(await page.getByRole('button',{name:'取消提及全员',exact:true}).count(),1);
 await page.reload();await page.getByRole('heading',{name:c.name,exact:true}).waitFor();
 assert.equal(await page.locator('.chat-composer .composing-reply').count(),0);assert.equal(await composer.inputValue(),'会议结束时保留这段草稿');
 await composer.press('Enter');await assertEventually(async()=>{snapshot=await h.request('/v2/channel?id='+c.id);return snapshot.messages.some(x=>x.body==='会议结束时保留这段草稿');});
 const after=snapshot.messages.find(x=>x.body==='会议结束时保留这段草稿');assert.equal(after.meetingId,undefined);assert.equal(after.mentionAll,true);assert.deepEqual(after.recipientIds,[host.id,peer.id]);
 checks.push('后台结束会议即撤掉输入标签，草稿与@全员不丢；重开后发送普通消息不带旧会议');
 const auto=await h.command('channel.meeting',{channelId:c.id,action:'prepare',body:'给出下一步建议'});
 const planned=await host.call('meeting',{requestId:'autonomous-plan',channelId:c.id,meetingId:auto.id,action:'plan',ownerMessageId:auto.lastOwnerMessageId,title:'下一步建议',goal:'确定下一步',deliverable:'一条可执行的建议',mode:'crosscheck',body:'结合已知信息给出建议',agenda:[{title:'现在先做什么'}]});
 await page.locator('.meeting-status-strip').getByText('筹备中',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'按此安排开始',exact:true}).count(),0);
 await host.call('meeting',{requestId:'autonomous-start',channelId:c.id,meetingId:auto.id,action:'start'});
 await page.locator('.meeting-status-strip').getByText('进行中',{exact:true}).waitFor();
 await host.call('meeting',{requestId:'autonomous-finish',channelId:c.id,meetingId:auto.id,action:'finish',sourceVersion:planned.version,round:0,summary:'先收集三位用户的实际反馈。',answers:planned.agenda.map(a=>({agendaId:a.id,body:'先收集反馈，目前证据尚不足。',status:'unresolved'}))});
 await page.locator('.meeting-status-strip').getByText('已结束',{exact:true}).waitFor();
 checks.push('负责人通过真实工具直接开会与交付结束，界面随动作更新，全程无用户确认门槛');

 assert.deepEqual(errors,[]);await page.screenshot({path:'evidence/meeting-addressing-ui.png'});
 await fs.writeFile('evidence/meeting-addressing-ui.json',JSON.stringify({at:new Date().toISOString(),scope:'Isolated HTTP Hub and actual Chrome UI; protocol members, not production model latency.',checks,errors},null,2));console.log(JSON.stringify({checks}));
} catch(e) { if(browser){const p=browser.contexts()[0]?.pages()[0];await p?.screenshot({path:'evidence/meeting-addressing-failure.png'});console.error((await p?.locator('body').innerText())?.slice(-4000));}throw e;}
finally {await browser?.close();await local?.close();await h.stop();}
async function assertEventually(check){for(let i=0;i<60;i++){if(await check())return;await new Promise(r=>setTimeout(r,150));}assert.fail('Expected meeting routing update');}
