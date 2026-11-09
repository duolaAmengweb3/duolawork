import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium,_electron} from 'playwright-core';
import net from 'node:net';
import {startHarness} from './v1-harness.mjs';
const h=await startHarness();process.env.AGENT_HUB_DATA_DIR=path.join(h.directory,'local');const {start}=await import('../local/server.mjs');let local,browser,app;const errors=[],checks=[];
try{
 await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
 const peer=await h.member('grok-bot','执行者');
 const c=await h.command('channel.create',{name:'成果核对验收',memberIds:[peer.id],coordinatorId:peer.id});
 const source=await h.command('channel.post',{channelId:c.id,body:'请交付实际结果，并核对原件；不要只写计划。'});
 let task=await h.command('channel.task',{channelId:c.id,action:'create',title:'交付可用结果',sourceMessageId:source.id,assigneeId:peer.id,notifyAssignee:false});
 let p;
 if(process.env.HUB_TEST_EXECUTABLE){
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  await fs.mkdir(process.env.AGENT_HUB_DATA_DIR,{recursive:true});await fs.writeFile(path.join(process.env.AGENT_HUB_DATA_DIR,'config.json'),JSON.stringify({endpoint:h.base,adminKey:h.key,runnerId:'task-delivery-installed-isolated',port}),{mode:0o600});
  app=await _electron.launch({executablePath:process.env.HUB_TEST_EXECUTABLE,args:[],env:{...process.env,AGENT_HUB_TEST_MODE:'1'},timeout:20000});p=await app.firstWindow();
 }else{local=await start({port:0,maintenance:false,vaultKey:Buffer.alloc(32,18),config:{endpoint:h.base,adminKey:h.key,runnerId:'task-delivery-ui'}});browser=await chromium.launch({channel:'chrome',headless:true});p=await browser.newPage({viewport:{width:1440,height:1000}});await p.goto(local.url);}
 p.on('pageerror',e=>errors.push(e.message));await p.getByRole('heading',{name:c.name,level:1,exact:true}).waitFor();const space=p.getByRole('complementary',{name:'协作空间'});
 await space.getByRole('button',{name:'Todo',exact:true}).click();await space.getByRole('button',{name:/交付可用结果 执行者/}).click();await space.getByText('请交付实际结果，并核对原件；不要只写计划。',{exact:true}).waitFor();checks.push('当前详情直接展示用户原话，不只显示负责人摘要');
 await space.getByRole('button',{name:'调整要求与核对人',exact:true}).click();await space.getByLabel('核对人',{exact:true}).selectOption('owner');await space.getByRole('button',{name:'保存要求',exact:true}).click();await space.getByText('由我核对',{exact:false}).waitFor().catch(()=>{});
 task=await h.request('/v2/space-object?'+new URLSearchParams({channelId:c.id,kind:'task',id:task.id}));assert.equal(task.workSpec.checkMode,'designated');assert.equal(task.workSpec.reviewerId,'owner');checks.push('同一详情调整完成条件和核对人，没有新增工作台');
 // Real authenticated protocol peer submits; UI owner checks as owner, not as that peer.
 task=await peer.call('board_task',{requestId:crypto.randomUUID(),channelId:c.id,taskId:task.id,action:'submit',expectedVersion:task.version,workSpecVersion:task.workSpec.version,submission:{body:'## 实际成果\n可读取的结果已保存。<script>window.__unsafe=1</script>',coverage:[{id:'outcome',location:'实际成果'}]}});
 await p.reload();await p.getByRole('heading',{name:c.name,level:1,exact:true}).waitFor();await space.getByRole('button',{name:'Todo',exact:true}).click();await space.getByRole('button',{name:/交付可用结果 执行者/}).click();await space.getByText('待核对',{exact:true}).waitFor();assert.equal(await p.evaluate(()=>window.__unsafe),undefined);checks.push('成果提交保持待核对，正文脚本不执行');
 await space.getByRole('button',{name:'核对这份成果',exact:true}).click();await space.getByLabel('核对 交付可用结果',{exact:true}).selectOption('met');await space.getByLabel('依据 交付可用结果',{exact:true}).fill('实际成果正文，已检查可读取');await space.getByLabel('核对说明',{exact:true}).fill('已对照原用户要求和实际产物，结果可用。');await space.getByRole('button',{name:'保存核对',exact:true}).click();await space.getByText('已通过',{exact:true}).waitFor();
 task=await h.request('/v2/space-object?'+new URLSearchParams({channelId:c.id,kind:'task',id:task.id}));assert.equal(task.status,'done');assert.equal(task.delivery.check.authorId,'owner');assert.equal(task.delivery.submission.authorId,peer.id);checks.push('核对通过后真实完成，执行者与用户核对身份分开');
 await space.getByText('成果提交记录',{exact:true}).click();await space.locator('.space-history article').first().waitFor();
 await p.setViewportSize({width:920,height:780});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);await p.screenshot({path:process.env.HUB_TEST_EXECUTABLE?'evidence/screenshots/task-deliverables-installed.png':'evidence/screenshots/task-deliverables.png'});checks.push('提交历史可读，窄窗口无溢出，无页面异常');
 await fs.writeFile(process.env.HUB_TASK_DELIVERY_EVIDENCE||'evidence/task-deliverables-ui.json',JSON.stringify({at:new Date().toISOString(),scope:process.env.HUB_TEST_EXECUTABLE?'installed Electron with isolated HTTP and data, not native model acceptance':'isolated HTTP and browser, not native model acceptance',executablePath:process.env.HUB_TEST_EXECUTABLE||null,checks,errors},null,2)+'\n');console.log(JSON.stringify(checks));
}finally{await browser?.close();await app?.close();await local?.close();await h.stop();}
