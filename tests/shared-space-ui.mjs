import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startHarness} from './v1-harness.mjs';
const h=await startHarness();process.env.AGENT_HUB_DATA_DIR=path.join(h.directory,'local');
const {start}=await import('../local/server.mjs');let local,browser;const checks=[],errors=[];
try{
 await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
 const member=await h.member('muse','资料成员'),peer=await h.member('muse','接收成员');
 local=await start({port:0,maintenance:false,vaultKey:Buffer.alloc(32,17),config:{endpoint:h.base,adminKey:h.key,runnerId:'shared-ui'}});
 const channel=await h.command('channel.create',{name:'跨环境资料验收',memberIds:[member.id,peer.id]});
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:960},acceptDownloads:true});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(local.url);await page.getByRole('heading',{name:'跨环境资料验收',exact:true,level:1}).waitFor();assert.equal(await page.title(),'DuolaWork · 你的 AI 团队');
 await page.locator('input[type=file]').first().setInputFiles({name:'共同资料.md',mimeType:'text/markdown',buffer:Buffer.from('所有成员读取同一份资料。')});
 await page.locator('.shared-file-row').filter({hasText:'共同资料.md'}).first().waitFor();await page.locator('.shared-file-row').filter({hasText:'共同资料.md'}).first().click();
 await page.getByRole('dialog').getByRole('heading',{name:'共同资料.md',exact:true}).waitFor();
 const downloading=page.waitForEvent('download');await page.getByRole('link',{name:'下载文件',exact:true}).click();const download=await downloading;assert.equal(await fs.readFile(await download.path(),'utf8'),'所有成员读取同一份资料。');checks.push('中文文件上传、会话附件、侧栏收录及真实下载');
 await page.getByRole('dialog').locator('input[type=file]').setInputFiles({name:'共同资料.md',mimeType:'text/markdown',buffer:Buffer.from('用户修订后的第二版。')});
 await page.getByRole('dialog').getByText('v2',{exact:true}).waitFor();await page.getByRole('button',{name:'恢复此版',exact:true}).click();await page.getByRole('dialog').getByText('v3',{exact:true}).waitFor();checks.push('上传新版本与历史恢复，版本递增');
 await page.getByRole('button',{name:'从共享空间移除',exact:false}).click();await page.getByRole('button',{name:'确认移除',exact:true}).click();await page.getByText('文件已从共享空间移除。恢复一个历史版本后，成员才能继续下载。',{exact:true}).waitFor();await page.getByRole('button',{name:'恢复此版',exact:true}).first().click();await page.getByRole('link',{name:'下载文件',exact:true}).waitFor();checks.push('删除说明与恢复，不清理本机原文件');
 await page.getByRole('button',{name:'Close',exact:true}).click();
 const files=await h.request('/v2/shared?channelId='+channel.id),file=files.items[0];
 const handoff=await member.call('handoff',{requestId:crypto.randomUUID(),channelId:channel.id,toMemberId:peer.id,summary:'已整理输入材料',remaining:'请核对材料并给出建议',refs:[{kind:'file',id:file.id,version:file.version}]});
 await page.locator('.handoff-card').first().waitFor();await page.locator('.handoff-card').first().click();await page.getByRole('dialog').getByText('请核对材料并给出建议',{exact:true}).waitFor();assert.equal(await page.getByText('等待对方接手',{exact:true}).count()>0,true);await peer.call('respond_handoff',{requestId:crypto.randomUUID(),handoffId:handoff.id,status:'received',summary:'已收到，核对指定资料'});await page.getByRole('dialog').getByText('对方已接手',{exact:true}).first().waitFor();checks.push('交接卡与接收者真实状态，非用户配置表单');
 await page.getByRole('button',{name:'Close',exact:true}).click();
 // Interrupt transport after persisting the Blob. Reload must not lose the upload.
 await page.route('**/api/v2/shared',route=>route.abort('connectionfailed'));
 await page.locator('input[type=file]').first().setInputFiles({name:'断网恢复.md',mimeType:'text/markdown',buffer:Buffer.from('断线也不能丢失。')});await page.getByText('断网恢复.md · 待上传',{exact:true}).first().waitFor({timeout:20000});await page.reload();await page.getByText('断网恢复.md · 待上传',{exact:true}).first().waitFor();await page.unroute('**/api/v2/shared');await page.getByRole('button',{name:'继续',exact:true}).first().click();await page.locator('.shared-file-row').filter({hasText:'断网恢复.md'}).first().waitFor({timeout:20000});await page.getByText('断网恢复.md · 待上传',{exact:true}).first().waitFor({state:'hidden'});checks.push('失败暂存、刷新恢复、原上传续传');
 await fs.mkdir('evidence',{recursive:true});await page.screenshot({path:'evidence/shared-space-ui.png',fullPage:true});assert.deepEqual(errors,[]);await fs.writeFile('evidence/shared-space-ui.json',JSON.stringify({at:new Date().toISOString(),pass:true,scope:'isolated browser UI; not native Agent acceptance',checks},null,2)+'\n');console.log(checks);
}finally{await browser?.close();await local?.close();await h.stop();}
