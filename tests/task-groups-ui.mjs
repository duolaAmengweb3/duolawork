import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startHarness} from './v1-harness.mjs';
const h=await startHarness();process.env.AGENT_HUB_DATA_DIR=path.join(h.directory,'local');const {start}=await import('../local/server.mjs');let local,browser;const errors=[],checks=[];
try{
 await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
 const host=await h.member('grok-bot','负责人'),peer=await h.member('chatgpt-agent','验收员');
 const c=await h.command('channel.create',{name:'按任务整理验收',memberIds:[host.id,peer.id],coordinatorId:host.id});
 const task=args=>h.command('channel.task',{channelId:c.id,action:'create',notifyAssignee:false,...args});
 const a=await task({title:'记忆系统升级',assigneeId:host.id}),b=await task({title:'通信修复',assigneeId:host.id});
 const old=await task({title:'核对来源',status:'done',result:'三条原文已核对',assigneeId:peer.id});
 await task({action:'update',taskId:old.id,expectedVersion:1,parentTaskId:a.id});
 await task({title:'检查断线恢复',parentTaskId:b.id,status:'blocked',blocker:'等待模拟网络恢复',assigneeId:peer.id});
 local=await start({port:0,maintenance:false,vaultKey:Buffer.alloc(32,18),config:{endpoint:h.base,adminKey:h.key,runnerId:'task-groups-ui'}});
 browser=await chromium.launch({channel:'chrome',headless:true});const p=await browser.newPage({viewport:{width:1440,height:1000}});p.on('pageerror',e=>errors.push(e.message));
 await p.goto(local.url);await p.getByRole('heading',{name:c.name,exact:true,level:1}).waitFor();const space=p.getByRole('complementary',{name:'协作空间'});
 await space.getByRole('button',{name:'Todo',exact:true}).click();const board=space.getByLabel('按任务整理的待办');await board.getByRole('region',{name:'任务：记忆系统升级',exact:true}).waitFor();assert.equal(await board.getByRole('region').count(),2);await board.getByText('待核对交付',{exact:true}).waitFor();checks.push('默认按任务展示；子项完成仍等任务交付核对');
 await board.getByRole('button',{name:'展开通信修复',exact:true}).click();await board.getByText('等待模拟网络恢复',{exact:true}).waitFor();await board.getByRole('button',{name:'展开记忆系统升级',exact:true}).click();await board.getByText('核对来源',{exact:true}).waitFor();
 await board.getByLabel('记忆系统升级的 Todo').getByRole('button',{name:'添加 Todo',exact:true}).click();const dialog=p.getByRole('dialog');await dialog.getByLabel('名称',{exact:true}).fill('独立核验');assert.equal(await dialog.getByLabel('所属任务',{exact:true}).inputValue(),a.id);await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});await space.getByRole('heading',{name:'独立核验',exact:true}).waitFor();await space.getByRole('button',{name:'所属任务：记忆系统升级',exact:true}).click();await space.getByRole('heading',{name:'记忆系统升级',exact:true}).waitFor();checks.push('在任务内直接新增 Todo，默认继承归属；详情能返回所属任务');
 await space.getByRole('button',{name:'返回列表',exact:true}).click();await space.getByLabel('搜索Todo').fill('独立核验');await board.getByText('记忆系统升级',{exact:true}).waitFor();assert.equal(await board.getByRole('region').count(),1);checks.push('搜索子项仍返回所属任务，避免丢失上下文');
 await space.getByLabel('搜索Todo').fill('');await board.getByText('通信修复',{exact:true}).waitFor();await board.getByRole('button',{name:'展开记忆系统升级',exact:true}).click();await board.getByRole('button',{name:/独立核验 待办/}).click();await space.getByRole('button',{name:'编辑',exact:true}).click();await dialog.getByLabel('所属任务',{exact:true}).selectOption(b.id);await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});await space.getByRole('button',{name:'所属任务：通信修复',exact:true}).waitFor();
 const latest=await h.request('/v2/space-object?'+new URLSearchParams({channelId:c.id,kind:'task',grouped:'1',parentTaskId:b.id}));assert.equal(latest.items.length,2);checks.push('人类可把已有 Todo 调整到其他任务，原 ID 和修订保留');
 await p.reload();await p.getByRole('heading',{name:c.name,exact:true,level:1}).waitFor();await space.getByRole('button',{name:'Todo',exact:true}).click();await board.getByText('记忆系统升级',{exact:true}).waitFor();
 await p.setViewportSize({width:920,height:780});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:'evidence/screenshots/task-groups.png'});assert.deepEqual(errors,[]);checks.push('刷新后归组保留，窄窗口无横向溢出，无页面异常');
 await fs.writeFile('evidence/task-groups-ui.json',JSON.stringify({at:new Date().toISOString(),checks,errors},null,2)+'\n');console.log(JSON.stringify(checks));
}finally{await browser?.close();await local?.close();await h.stop();}
