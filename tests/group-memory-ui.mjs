import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startHarness} from './v1-harness.mjs';
const h=await startHarness();process.env.AGENT_HUB_DATA_DIR=path.join(h.directory,'local');const {start}=await import('../local/server.mjs');let local,browser;const errors=[],checks=[];
try{
 await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
 const host=await h.member('grok-bot','整理成员'),peer=await h.member('chatgpt-agent','接手成员');
 const c=await h.command('channel.create',{name:'无人工审批的群记忆验收',memberIds:[host.id,peer.id],coordinatorId:host.id});
 const source=await h.command('channel.post',{channelId:c.id,body:'周六活动预算800，必须在室内，网站任务另外处理。'});
 const topic=await host.call('group_memory',{requestId:'ui-topic',channelId:c.id,action:'record',title:'周六活动',body:'整理者误记预算1000',summary:'室内活动，预算1000，网站另排',phase:'goal',refs:[{kind:'message',id:source.id}]});
 const dissent=await h.command('channel.post',{channelId:c.id,body:'场地尚未确认，不能认为已经完成。'});
 await peer.call('group_memory',{requestId:'ui-dissent',channelId:c.id,topicId:topic.topic.id,expectedVersion:1,action:'record',body:dissent.body,phase:'question',refs:[{kind:'message',id:dissent.id}]});
 await host.call('group_memory',{requestId:'ui-correction',channelId:c.id,topicId:topic.topic.id,expectedVersion:2,action:'record',body:'已对照原文纠正：预算800，场地仍未确认',summary:'室内活动，预算800，网站另排',phase:'correction',supersededEpisodeIds:[topic.episode.id],refs:[{kind:'message',id:source.id}]});
 local=await start({port:0,maintenance:false,vaultKey:Buffer.alloc(32,18),config:{endpoint:h.base,adminKey:h.key,runnerId:'group-memory-ui'}});
 browser=await chromium.launch({channel:'chrome',headless:true});const p=await browser.newPage({viewport:{width:1440,height:1000}});p.on('pageerror',e=>errors.push(e.message));
 await p.goto(local.url);await p.getByRole('heading',{name:c.name,exact:true,level:1}).waitFor();const space=p.getByRole('complementary',{name:'协作空间'});
 await space.getByRole('button',{name:'记忆',exact:true}).click();await space.getByRole('tab',{name:'群记忆',exact:true}).waitFor();await space.getByRole('button',{name:/周六活动/}).click();await space.getByRole('heading',{name:'周六活动',exact:true}).waitFor();await space.getByText('场地尚未确认，不能认为已经完成。',{exact:true}).waitFor();assert.equal(await space.getByText(/有待核对的补充或分歧/).count(),1);checks.push('两名成员在页面关闭时记录；打开后直接看到当前理解、经历与未决问题，无审批');
 await space.getByText('需求 · 已被纠正',{exact:true}).waitFor();await space.getByText('已对照原文纠正：预算800，场地仍未确认',{exact:true}).waitFor();checks.push('旧错误经历明确标注已被纠正，当前理解与未决问题保留');
 await space.getByRole('button',{name:'查看原消息',exact:true}).first().click();await p.locator('#'+source.id).waitFor();
 await space.getByRole('button',{name:'返回话题',exact:true}).click();await space.getByLabel('搜索群记忆').fill('活动');await space.getByRole('button',{name:/周六活动/}).waitFor();await space.getByRole('tab',{name:'共享记忆',exact:true}).click();assert.equal(await space.getByRole('button',{name:/周六活动/}).count(),0);checks.push('群经历与共享知识分开，来源可定位，搜索/返回可用');
 await space.getByRole('tab',{name:'群记忆',exact:true}).click();await p.setViewportSize({width:900,height:760});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:'evidence/screenshots/group-memory.png'});assert.deepEqual(errors,[]);
 await fs.writeFile('evidence/group-memory-ui.json',JSON.stringify({at:new Date().toISOString(),checks,errors},null,2)+'\n');console.log(JSON.stringify(checks));
}finally{await browser?.close();await local?.close();await h.stop();}
