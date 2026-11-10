import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startHarness} from './v1-harness.mjs';
const h=await startHarness();process.env.AGENT_HUB_DATA_DIR=path.join(h.directory,'local');const {start}=await import('../local/server.mjs');let local,browser;const checks=[],errors=[];
try{
 await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
 const a=await h.member('grok-bot','执行员'),b=await h.member('chatgpt-agent','核验员');
 const c=await h.command('channel.create',{name:'技能与读取验收',memberIds:[a.id,b.id],coordinatorId:a.id});
 const files={'SKILL.md':'---\nname: verify-source\ndescription: 核对交付来源\ncompatibility: Node 22\n---\nRead references/check.md','references/check.md':'核对原文','assets/data.bin':{encoding:'base64',data:'AP8BAg=='}};
 const skill=await h.request('/v2/skills',{action:'save',requestId:'skill',files,channelIds:[c.id]});
 const task=await h.command('channel.task',{channelId:c.id,action:'create',title:'来源核对任务',skillRefs:[{skillId:skill.id,version:1}],notifyAssignee:false});
 const read=await a.call('read_skill',{channelId:c.id,skillId:skill.id,taskId:task.id});
 const use=await a.call('report_skill_use',{requestId:'use',channelId:c.id,skillId:skill.id,version:1,readId:read.readId,taskId:task.id,summary:'三条来源已核对',environment:'隔离测试环境',dependencyStatus:'ready',refs:[{kind:'task',id:task.id}]});
 await b.call('review_skill_use',{requestId:'review',channelId:c.id,useId:use.id,outcome:'passed',summary:'独立核对三条原文',refs:[{kind:'task',id:task.id}]});
 await h.request('/v2/skills',{action:'save',requestId:'v2',skillId:skill.id,expectedVersion:1,files:{...files,'references/check.md':'新版方法'}});
 // Legacy usage is a real older persisted format; the new UI must preserve it.
 await h.db.prepare("INSERT INTO hub_v2_records(workspace_id,kind,id,parent_id,scope_id,revision,updated_at,body) VALUES('v1-test','skill_use','old-use',?,?,1,?,?)").bind(skill.id,c.id,'2026-11-01T00:00:00.000Z',JSON.stringify({id:'old-use',parentId:skill.id,scopeId:c.id,memberId:a.id,version:1,summary:'旧版实际使用记录',createdAt:'2026-11-01T00:00:00.000Z',updatedAt:'2026-11-01T00:00:00.000Z'})).run();
 local=await start({port:0,maintenance:false,vaultKey:Buffer.alloc(32,19),config:{endpoint:h.base,adminKey:h.key,runnerId:'services-ui'}});
 browser=await chromium.launch({channel:'chrome',headless:true});const p=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});p.on('pageerror',e=>errors.push(e.message));
 await p.goto(local.url);await p.getByRole('heading',{name:c.name,exact:true,level:1}).waitFor();
 await p.getByRole('button',{name:'技能',exact:true}).click();const row=p.locator('.service-row').filter({has:p.getByRole('heading',{name:/verify-source/})});await row.getByText('可供使用',{exact:true}).waitFor();await row.getByRole('button',{name:'查看资源与使用记录'}).click();const d=p.getByRole('dialog');
 await d.getByText('当前版本 v2 · 可按需使用',{exact:true}).waitFor();await d.getByText('旧版实际使用记录',{exact:true}).waitFor();await d.getByText('独立核对三条原文',{exact:true}).waitFor();assert.equal(await d.getByText('v1 · 核验通过',{exact:true}).count(),1);assert.ok(await d.getByText('任务：来源核对任务',{exact:true}).count()>0);checks.push('技能当前版本与历史成员使用、独立核验、任务记录分开；旧记录完整可见');
 await d.getByText('说明与资源 · 3 个文件',{exact:true}).click();const download=p.waitForEvent('download');await d.getByRole('button',{name:'assets/data.bin · 二进制资源'}).click();assert.deepEqual([...await fs.readFile(await (await download).path())],[0,255,1,2]);checks.push('二进制随包资源经实际页面下载后逐字节一致');
 const useRow=d.locator('.service-activity-row').filter({has:p.getByText('三条来源已核对',{exact:true})});await useRow.getByRole('button',{name:'记录我的核验'}).click();await d.getByLabel('核验依据').fill('人类核对来源链接与记录一致');await d.getByRole('button',{name:'保存核验记录'}).click();await d.getByText('人类核对来源链接与记录一致',{exact:true}).waitFor();checks.push('人类可按需要记录针对某次使用的核验，不给技能全局盖章');
 await p.setViewportSize({width:390,height:844});const rect=await d.boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=391);assert.equal(await d.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);await p.screenshot({path:'evidence/screenshots/services-detail-narrow.png'});await p.keyboard.press('Escape');await p.setViewportSize({width:1440,height:1000});
 await p.getByRole('button',{name:new RegExp(c.name)}).first().click();if(await p.getByRole('button',{name:'展开协作空间',exact:true}).count())await p.getByRole('button',{name:'展开协作空间',exact:true}).click();const space=p.getByRole('complementary',{name:'协作空间'});await space.getByRole('button',{name:'Todo',exact:true}).click();await space.getByRole('button',{name:/来源核对任务.*待办/}).click();await space.getByRole('button',{name:'查看实际使用记录'}).click();await space.getByText('独立核对三条原文',{exact:true}).waitFor();await space.getByRole('button',{name:'编辑',exact:true}).click();
 const picker=d.locator('.task-skill-picker');await picker.getByText(/verify-source/).waitFor();assert.equal(await picker.getByRole('checkbox',{name:/verify-source/}).isChecked(),true);assert.match(await picker.innerText(),/v1/);await d.getByRole('button',{name:'取消',exact:true}).click();checks.push('任务详情直接查看实际技能记录，编辑保持原固定版本而非自动升到 v2');
 await p.getByRole('button',{name:'技能',exact:true}).click();await row.getByRole('button',{name:'查看资源与使用记录'}).click();await d.getByText('当前版本 v2 · 可按需使用',{exact:true}).waitFor();await p.screenshot({path:'evidence/screenshots/services-detail.png'});await p.keyboard.press('Escape');
 // The HTTP endpoint must reject mutating GETs instead of accepting query-string actions.
 const bad=await fetch(h.base+'/v2/skills?action=save',{headers:{Authorization:'Bearer '+h.key}});assert.equal(bad.status,405);checks.push('读接口拒绝用 GET 修改配置');
 assert.deepEqual(errors,[]);await fs.writeFile('evidence/service-activity-ui.json',JSON.stringify({at:new Date().toISOString(),scope:'Isolated browser plus actual HTTP backend; protocol peers, not commercial native installation proof.',checks,errors},null,2)+'\n');console.log(JSON.stringify(checks));
}catch(e){const p=browser?.contexts()[0]?.pages()[0];if(p){await p.screenshot({path:'evidence/services-failure.png'});console.error((await p.locator('body').innerText()).slice(-9000));}throw e;}finally{await browser?.close();await local?.close();await h.stop();}
