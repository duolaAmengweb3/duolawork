import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startHarness} from './v1-harness.mjs';
const h=await startHarness();let local,browser;
try{
 const a=await h.member('grok-bot','负责人'),b=await h.member('grok-bot','核验员');
 const c=await h.command('channel.create',{name:'会议跨窗口验收',memberIds:[a.id,b.id],coordinatorId:a.id});
 const prepared=await h.command('channel.meeting',{channelId:c.id,action:'prepare',body:'讨论一个分歧'});
 const meeting=(action,args={})=>h.command('channel.meeting',{channelId:c.id,meetingId:prepared.id,action,...args});
 await meeting('plan',{title:'分歧讨论',goal:'比较依据',deliverable:'明确未知',body:'分别核查后比较',stages:[{name:'各自检查',private:true},{name:'整理结论',private:false}],agenda:[{title:'证据充分吗'}]});
 const m=await meeting('start');
 process.env.AGENT_HUB_DATA_DIR=path.join(h.directory,'local');process.env.AGENT_HUB_TEST_MODE='1';
 const {start}=await import('../local/server.mjs');local=await start({port:0,vaultKey:Buffer.alloc(32,22),config:{endpoint:h.base,adminKey:h.key,runnerId:'meeting-life-ui'}});
 browser=await chromium.launch({channel:'chrome',headless:true});const pages=[];
 for(let n=1;n<=2;n++){
  const context=await browser.newContext({viewport:{width:1440,height:960}}),page=await context.newPage();pages.push(page);
  await page.addInitScript(({id,meetingId,memberId,n})=>localStorage.setItem('hub-communication',JSON.stringify({channelId:id,chatKind:'group',meetingScopes:{[id]:meetingId},drafts:{[id]:'窗口'+n+'未发送草稿'},addressing:{[id]:{mentions:[memberId]}}})),{id:c.id,meetingId:m.id,memberId:b.id,n});
  await page.goto(local.url);await page.getByRole('heading',{name:c.name,exact:true}).waitFor();
  await page.getByText('正在参与会议：'+m.title,{exact:true}).waitFor();
 }
 await meeting('stop');
 for(const [index,page] of pages.entries()){
  await page.getByText('正在参与会议：'+m.title,{exact:true}).waitFor({state:'hidden',timeout:20000});
  assert.equal(await page.getByRole('textbox',{name:'群消息'}).inputValue(),'窗口'+(index+1)+'未发送草稿');
  await page.waitForFunction(({id,memberId})=>{const saved=JSON.parse(localStorage.getItem('hub-communication'));return saved.meetingScopes[id]===null&&saved.addressing[id].mentions.includes(memberId);},{id:c.id,memberId:b.id});
 }
 await pages[0].getByRole('button',{name:'查看记录与总结',exact:true}).click();
 await pages[0].getByRole('button',{name:'让负责人补齐总结',exact:true}).click();
 await pages[0].getByRole('button',{name:'负责人正在补齐',exact:true}).waitFor();
 await a.call('meeting',{requestId:crypto.randomUUID(),channelId:c.id,meetingId:m.id,action:'recover_summary',sourceVersion:m.version,summary:'讨论结束，现有记录不足，不能给出确定结论。',answers:m.agenda.map(x=>({agendaId:x.id,body:'仍缺实际证据',status:'unresolved'}))});
 await pages[0].getByText('讨论结束，现有记录不足，不能给出确定结论。',{exact:true}).waitFor();
 assert.equal((await h.request('/v2/meeting?id='+m.id)).meeting.status,'ended');
 await pages[0].screenshot({path:'evidence/meeting-lifecycle-ui.png'});
 await fs.writeFile('evidence/meeting-lifecycle-ui.json',JSON.stringify({at:new Date().toISOString(),scope:'two independent Chromium contexts and isolated real Hub; protocol actors',checks:['会议结束清理两个客户端的会议发送范围','两边草稿与显式提及保留','总结缺失可重试且只补总结不重开']},null,2));
 console.log('PASS meeting lifecycle UI');
}finally{await browser?.close();await local?.close();await h.stop();}
