import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startHarness} from './v1-harness.mjs';

const h=await startHarness();let local,browser;const errors=[],checks=[];
try{
 await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
 await h.request('/admin/action',{type:'platform.create',payload:{id:'claude-code',name:'Claude Code'}});
 await h.request('/admin/action',{type:'platform.create',payload:{id:'deepseek-harness',name:'DeepSeek Harness'}});
 const claude=await h.member('claude-code','Claude VPS'),deepseek=await h.member('deepseek-harness','DeepSeek 本地');
 const channel=await h.command('channel.create',{name:'原生接收故障验收',memberIds:[claude.id,deepseek.id],coordinatorId:claude.id});
 await h.command('channel.post',{channelId:channel.id,body:'请核对当前方案',mentions:[claude.id,deepseek.id]});
 process.env.AGENT_HUB_DATA_DIR=path.join(h.directory,'local');
 process.env.AGENT_HUB_TEST_MODE='1';
 const {start}=await import('../local/server.mjs');
 local=await start({port:0,maintenance:true,vaultKey:Buffer.alloc(32,25),config:{endpoint:h.base,adminKey:h.key,runnerId:'native-recovery-ui'}});
 const members=[
  {memberId:claude.id,enabled:true,status:'idle',sourceReady:true,message:'其他对话仍在线',assignments:[{channelId:channel.id,sessionId:'claude-original',title:'原项目讨论',nativeState:'unavailable',nativeIssueCode:'session_offline',nativeMessage:'群里绑定的原对话未在线，请在原环境打开该对话。',observedAt:new Date().toISOString()}]},
  {memberId:deepseek.id,enabled:true,status:'idle',sourceReady:true,assignments:[{channelId:channel.id,sessionId:'deepseek-original',title:'产品方案',nativeState:'unavailable',nativeMessage:'原项目文件夹无法打开',nativeIssueCode:'workspace_unavailable',observedAt:new Date().toISOString()}]},
 ];
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:960}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/local/coding/status',route=>route.fulfill({json:{members,approvals:[],running:true}}));
 await page.addInitScript(id=>localStorage.setItem('hub-communication',JSON.stringify({channelId:id,chatKind:'group'})),channel.id);
 await page.goto(local.url);await page.getByRole('heading',{name:channel.name,exact:true}).waitFor();
 await page.getByRole('textbox',{name:'群消息'}).fill('保留我的草稿');
 const chips=page.locator('.chat-session-chips');
 await chips.getByText('· 原会话未连接',{exact:true}).waitFor();
 await chips.getByText('· 对话暂不可用',{exact:true}).waitFor();
 assert.equal(await chips.locator('.session-dot.connected,.session-dot.idle').count(),0);
 assert.match(await page.locator('.conversation-activity').innerText(),/原会话未连接/);
 assert.match(await page.locator('.conversation-activity').innerText(),/对话暂不可用/);
 checks.push('已绑定但离线不显示绿点，待接收消息展示真实阻断原因');
 await page.locator('.conversation-activity button').first().click();
 await page.getByText(/原项目文件夹无法打开.*原消息保留/).waitFor();
 checks.push('消息进度可直接看到原因，不要求翻聊天记录猜测');
 await page.screenshot({path:'evidence/native-recovery-ui.png'});
 // Reconnection changes only availability, never the native binding or draft.
 members[1].assignments[0]={...members[1].assignments[0],nativeState:'idle',nativeMessage:undefined,nativeIssueCode:undefined};
 await chips.getByText('· 对话暂不可用',{exact:true}).waitFor({state:'hidden'});
 assert.equal(await page.getByRole('textbox',{name:'群消息'}).inputValue(),'保留我的草稿');
 assert.equal(members[1].assignments[0].sessionId,'deepseek-original');
 assert.ok((await h.request('/v2/channel?id='+channel.id)).activity.filter(t=>t.status==='ready').length===2);
 checks.push('连接恢复不重建会话、不清草稿、不伪造消息完成');
 assert.deepEqual(errors,[]);
 await fs.writeFile('evidence/native-recovery-ui.json',JSON.stringify({at:new Date().toISOString(),scope:'isolated protocol Hub and Chromium UI; native status fixtures, not production model proof',checks,errors},null,2));
 console.log(JSON.stringify({checks}));
}finally{await browser?.close();await local?.close();await h.stop();}
