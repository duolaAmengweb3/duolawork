import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {_electron} from 'playwright-core';
import {startHarness} from './v1-harness.mjs';

// Exercise the installed executable against a temporary workspace. Never read
// production chats or change the running user's window, accounts or settings.
const h=await startHarness();let app;
const evidence={at:new Date().toISOString(),realElectron:true,isolated:true,commercialAgentTest:false,checks:[]};
try{
 await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
 const members=[];
 for(const [platformId,name] of [['grok-bot','Grok Bot'],['dots','ChatGPT Dot'],['codex','Codex'],['antigravity','Antigravity'],['deepseek-harness','DeepSeek Harness'],['claude-code','Claude Code']]){
  if(platformId!=='grok-bot')await h.request('/admin/action',{type:'platform.create',payload:{id:platformId,name}});
  const member=await h.member(platformId,name);members.push(member);
  await h.command('channel.create',{name,memberIds:[member.id],direct:true});
 }
 const a=members[0],b=members[1];
 const group=await h.command('channel.create',{name:'产品设计讨论',memberIds:[a.id,b.id],coordinatorId:a.id});
 const other=await h.command('channel.create',{name:'资料整理',memberIds:[b.id],coordinatorId:b.id});
 const root=await h.command('channel.post',{channelId:group.id,body:'整理这些界面反馈，保留讨论过程。',mentions:[a.id]});
 for(let i=1;i<=65;i++)await a.call('post_message',{requestId:'visual-history-'+i,channelId:group.id,replyTo:root.id,body:`讨论记录 ${i}：继续核对产品体验。\n\n让用户看清当前进度，并能回到刚才阅读的位置。`,mentions:[]});
 const dir=path.join(h.directory,'desktop');await fs.mkdir(dir);
 const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 await fs.writeFile(path.join(dir,'config.json'),JSON.stringify({endpoint:h.base,adminKey:h.key,runnerId:'chat-visual-test',port}));
 const executablePath=process.env.HUB_TEST_EXECUTABLE||path.resolve('release/Agent Hub.app/Contents/MacOS/Electron');
 app=await _electron.launch({executablePath,args:[],env:{...process.env,AGENT_HUB_DATA_DIR:dir,AGENT_HUB_TEST_MODE:'1'},timeout:20000});
 const p=await app.firstWindow();p.setDefaultTimeout(15000);
 const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.getByRole('button',{name:'单聊',exact:true}).click();
 await p.locator('.channel-list button').filter({hasText:'ChatGPT Dot'}).click();
 await p.getByRole('heading',{name:'ChatGPT Dot',level:1,exact:true}).waitFor();
 await p.waitForFunction(()=>{const images=[...document.querySelectorAll('.channel-list .agent-avatar img')];return images.length===6&&images.every(i=>i.complete&&i.naturalWidth>0);});
 evidence.brands=await p.locator('.channel-list .agent-avatar img').evaluateAll(items=>items.map(i=>({alt:i.alt,loaded:i.naturalWidth>0})));
 await p.screenshot({path:'evidence/m1-private-logos.png'});
 evidence.checks.push('Six native platform logos load in the installed Mac app private-chat list; no fallback initials or broken images');
 await p.getByRole('button',{name:'群聊',exact:true}).click();
 await p.locator('.channel-list button').filter({hasText:'产品设计讨论'}).click();
 await p.getByRole('heading',{name:'产品设计讨论',exact:true,level:1}).waitFor();
 const scroll=p.locator('.messages-scroll');await p.locator('.chat-message').first().waitFor();
 await scroll.evaluate(el=>{el.scrollTop=Math.floor(el.scrollHeight/3);el.dispatchEvent(new Event('scroll'));});
 await p.waitForTimeout(100);
 const position=()=>scroll.evaluate(el=>{const top=el.getBoundingClientRect().top,m=[...el.querySelectorAll('.chat-message')].find(m=>m.getBoundingClientRect().bottom>top);return{id:m.id,offset:m.getBoundingClientRect().top-top,scrollTop:el.scrollTop};});
 const before=await position();await p.screenshot({path:'evidence/m1-scroll-before.png'});
 await p.route('**/api/v2/channel?*',async route=>{await new Promise(r=>setTimeout(r,900));await route.continue();});
 await p.locator('.channel-list button').filter({hasText:'资料整理'}).click();
 await p.getByRole('heading',{name:'资料整理',exact:true,level:1}).waitFor();
 await p.locator('.channel-list button').filter({hasText:'产品设计讨论'}).click();
 await p.getByRole('heading',{name:'产品设计讨论',exact:true,level:1}).waitFor();
 await p.waitForTimeout(100);const cached=await position();
 assert.equal(cached.id,before.id);assert.ok(Math.abs(cached.offset-before.offset)<3);
 await p.waitForTimeout(1200);const refreshed=await position();
 assert.equal(refreshed.id,before.id);assert.ok(Math.abs(refreshed.offset-before.offset)<3);
 await p.screenshot({path:'evidence/m1-scroll-after.png'});
 evidence.readingPosition={before,cached,refreshed,delayedReadMs:900};
 evidence.checks.push('Switch away and back: same visible message and offset before cache refresh and after a 900ms network delay');
 const local=await(await fetch(`http://127.0.0.1:${port}/api/local/status`)).json();evidence.build=local.build;evidence.desktopBuild=local.clientView.buildId;assert.equal(local.build.id,local.clientView.buildId);
 assert.deepEqual(errors,[]);evidence.passed=true;console.log(JSON.stringify(evidence));
}catch(e){evidence.failure=e.stack;if(app){const p=await app.firstWindow();await p.screenshot({path:'evidence/m1-visual-failure.png'}).catch(()=>{});}throw e;}
finally{await app?.close();await h.stop();await fs.writeFile('evidence/chat-visual-desktop.json',JSON.stringify(evidence,null,2)+'\n');}
