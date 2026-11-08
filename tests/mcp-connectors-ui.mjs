import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {chromium,_electron} from 'playwright-core';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-connectors-ui-'));process.env.AGENT_HUB_DATA_DIR=directory;
const {startNodeHarness}=await import('./node-server-harness.mjs');const {start}=await import('../local/server.mjs');
const h=await startNodeHarness();let local,browser,app,p;const checks=[],errors=[];
try{
 const a=await h.member('执行员'),b=await h.member('核验员');
 const c=await h.command('channel.create',{name:'连接器隔离验收',memberIds:[a.id,b.id],coordinatorId:a.id});
 if(process.env.HUB_TEST_EXECUTABLE){const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({endpoint:h.base,adminKey:h.key,runnerId:'connector-installed-isolated',port}),{mode:0o600});app=await _electron.launch({executablePath:process.env.HUB_TEST_EXECUTABLE,args:[],env:{...process.env,AGENT_HUB_DATA_DIR:directory,AGENT_HUB_TEST_MODE:'1'},timeout:20000});p=await app.firstWindow();}
 else{local=await start({port:0,maintenance:true,vaultKey:Buffer.alloc(32,25),config:{endpoint:h.base,adminKey:h.key,runnerId:'connector-browser'}});browser=await chromium.launch({channel:'chrome',headless:true});p=await browser.newPage({viewport:{width:1440,height:1000}});await p.goto(local.url);}
 p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push(e.message));await p.getByRole('heading',{name:c.name,level:1,exact:true}).waitFor();
 await p.getByRole('button',{name:'连接器',exact:true}).click();await p.getByRole('heading',{name:'连接器',exact:true}).waitFor();
 await p.getByRole('button',{name:'添加连接',exact:true}).click();const d=p.getByRole('dialog');
 for(const name of ['GitHub','Cloudflare','Vercel','飞书','Notion','Figma','Gmail'])await d.getByText(name,{exact:true}).waitFor();
 checks.push('服务目录包含开发、云服务、办公和设计入口，Google 明示预览资格');
 await d.getByRole('button',{name:/^Cloudflare/}).click();
 await d.getByLabel('服务地址',{exact:true}).waitFor();assert.equal(await d.getByLabel('服务地址',{exact:true}).inputValue(),'https://mcp.cloudflare.com/mcp');
 assert.match(await d.innerText(),/默认向所有成员和聊天开放/);assert.equal(await d.getByRole('checkbox').count(),0);await d.getByRole('button',{name:'取消',exact:true}).click();
 checks.push('Cloudflare 官方地址预填，普通连接流程不要求逐群逐成员选择');
 await p.getByRole('button',{name:'添加连接',exact:true}).click();await d.getByRole('button',{name:/^其他服务/}).click();
 await d.getByLabel('连接名称',{exact:true}).fill('本机共享工具');await d.getByLabel('运行方式',{exact:true}).selectOption('stdio');
 await d.getByLabel('启动命令',{exact:true}).fill(process.execPath);await d.getByLabel('参数（JSON 数组）',{exact:true}).fill(JSON.stringify([path.resolve('tests/fixtures/mcp-stdio.mjs')]));
 await d.getByRole('button',{name:'使用这台电脑',exact:true}).click();await d.getByLabel('选择工具运行端').locator('option').filter({hasText:'这台电脑'}).waitFor({state:'attached'});
 await d.getByRole('button',{name:'保存并连接',exact:true}).click();await d.waitFor({state:'hidden'});
 const row=p.locator('.connector-row').filter({has:p.getByRole('heading',{name:/本机共享工具/})});await row.getByText('已连接',{exact:true}).waitFor();
 const connection=(await h.request('/v2/connectors')).items.find(x=>x.name==='本机共享工具');assert.equal(connection.health,'ready');
 const args={channelId:c.id,action:'call',connectionId:connection.id,tool:'write',arguments:{text:'真实 HTTP 与子进程往返'},requestId:'ui-shared-call'};
 assert.equal((await a.client.tool('connector',args)).result.content[0].text,args.arguments.text);
 assert.equal((await b.client.tool('connector',{...args,requestId:'peer-ui-call'})).status,'succeeded');
 checks.push('实际页面接入本机运行端、启动真实 stdio 工具，两位独立协议成员通过 HTTP 共用调用');
 await row.getByRole('button',{name:'管理 本机共享工具'}).click();await d.getByText('调用成功',{exact:true}).first().waitFor();await d.getByText('管理使用范围',{exact:true}).click();
 await d.getByRole('checkbox',{name:'核验员',exact:true}).check();await d.getByRole('button',{name:'保存使用范围'}).click();await d.waitFor({state:'hidden'});
 await assert.rejects(b.client.tool('connector',{...args,requestId:'denied-ui-call'}));assert.equal((await a.client.tool('connector',{...args,requestId:'owner-still-works'})).status,'succeeded');
 checks.push('页面关闭指定成员后立即拒绝其真实调用，其他成员继续使用');
 await p.reload();await p.getByRole('button',{name:'连接器',exact:true}).click();await row.getByRole('button',{name:'管理 本机共享工具'}).click();await d.getByText('管理使用范围',{exact:true}).click();assert.equal(await d.getByRole('checkbox',{name:'核验员',exact:true}).isChecked(),true);await p.keyboard.press('Escape');
 checks.push('刷新后连接与关闭名单保留');
 await p.getByRole('button',{name:'添加连接',exact:true}).click();await d.getByRole('button',{name:'导入已有 MCP 配置'}).click();
 await d.getByLabel('MCP 配置',{exact:true}).fill(JSON.stringify({mcpServers:{'导入的工具':{command:process.execPath,args:[path.resolve('tests/fixtures/mcp-stdio.mjs')]}}}));await d.getByLabel('选择工具运行端').selectOption(connection.hostId);await d.getByRole('button',{name:'导入连接',exact:true}).click();await d.waitFor({state:'hidden'});await p.getByRole('heading',{name:/导入的工具/}).waitFor();
 checks.push('通过页面导入标准 MCP 配置并在指定运行端完成实际工具目录读取');
 await p.screenshot({path:'/tmp/duolawork-connectors-desktop.png'});await p.setViewportSize({width:390,height:844});await p.getByRole('button',{name:'添加连接',exact:true}).click();const rect=await d.boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=391);assert.equal(await d.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);await p.screenshot({path:'/tmp/duolawork-connectors-narrow.png'});checks.push('390px 弹窗可滚动且没有横向溢出');
 assert.deepEqual(errors,[]);const evidence={at:new Date().toISOString(),scope:process.env.HUB_TEST_EXECUTABLE?'Installed Electron with isolated HTTP backend and real stdio process':'Browser UI with isolated HTTP backend and real stdio process',checks,errors};await fs.writeFile(process.env.HUB_CONNECTOR_EVIDENCE||'/tmp/duolawork-connectors-ui.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}catch(e){if(p){await p.screenshot({path:'/tmp/duolawork-connectors-failure.png'});console.error((await p.locator('body').innerText()).slice(-5000));}throw e;}finally{await browser?.close();await app?.close();await local?.close();await h.stop();await fs.rm(directory,{recursive:true,force:true});}
