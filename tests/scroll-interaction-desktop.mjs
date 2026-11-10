import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {_electron,chromium} from 'playwright-core';
import {startHarness} from './v1-harness.mjs';
const h=await startHarness();let app,browser,local;
const browserMode=!!process.env.HUB_SCROLL_BROWSER;
const label=(browserMode?'browser-':'')+(process.env.HUB_SCROLL_BASELINE?'before':'after');
const evidence={at:new Date().toISOString(),isolated:true,realElectron:!browserMode,realBrowser:browserMode,commercialAgentTest:false,checks:[]};
try{
 await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
 const m=await h.member('grok-bot','Grok Bot');
 const group=await h.command('channel.create',{name:'主动滚动验收',memberIds:[m.id],coordinatorId:m.id});
 await h.command('channel.create',{name:'另一段讨论',memberIds:[m.id],coordinatorId:m.id});
 const root=await h.command('channel.post',{channelId:group.id,body:'保留讨论记录，方便向上阅读。'});
 for(let i=1;i<=65;i++)await m.call('post_message',{requestId:'scroll-history-'+i,channelId:group.id,replyTo:root.id,body:`讨论记录 ${i}：这是滚动验收的隔离测试内容。\n\n用户阅读时，新消息和图片加载不应把视口拉回旧位置。`,mentions:[]});
 const dir=path.join(h.directory,'desktop');await fs.mkdir(dir);
 const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 await fs.writeFile(path.join(dir,'config.json'),JSON.stringify({endpoint:h.base,adminKey:h.key,runnerId:'scroll-interaction-test',port}));
 let p;
 if(browserMode){process.env.AGENT_HUB_DATA_DIR=dir;const {start}=await import('../local/server.mjs');local=await start({port,maintenance:true,vaultKey:Buffer.alloc(32,31),config:{endpoint:h.base,adminKey:h.key,runnerId:'scroll-browser-test'}});browser=await chromium.launch({channel:'chrome',headless:true});p=await browser.newPage({viewport:{width:1440,height:960}});await p.goto(local.url);}
 else {app=await _electron.launch({executablePath:process.env.HUB_TEST_EXECUTABLE||path.resolve('release/Agent Hub.app/Contents/MacOS/Electron'),args:[],env:{...process.env,AGENT_HUB_DATA_DIR:dir,AGENT_HUB_TEST_MODE:'1'},timeout:20000});p=await app.firstWindow();}
 p.setDefaultTimeout(15000);
 await p.locator('.channel-list button').filter({hasText:'主动滚动验收'}).click();
 await p.getByRole('heading',{name:'主动滚动验收',exact:true,level:1}).waitFor();
 const scroll=p.locator('.messages-scroll');await p.locator('.chat-message').first().waitFor();
 const status=await(await fetch(`http://127.0.0.1:${port}/api/local/status`)).json();evidence.build=status.build;evidence.renderedBuild=browserMode?await p.locator('[data-build-id]').getAttribute('data-build-id'):status.clientView.buildId;assert.equal(evidence.build.id,evidence.renderedBuild);
 await scroll.evaluate(el=>{el.scrollTop=Math.floor(el.scrollHeight/3);});await p.waitForTimeout(300);
 // Observe JS calibration writes without changing their behavior. Native wheel,
 // pointer and keyboard scrolling bypasses this JS setter.
 await scroll.evaluate(el=>{const d=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');window.calibrationWrites=[];Object.defineProperty(el,'scrollTop',{configurable:true,get(){return d.get.call(this);},set(value){window.calibrationWrites.push({at:performance.now(),from:d.get.call(this),to:value});d.set.call(this,value);}});});
 const clear=()=>p.evaluate(()=>{window.calibrationWrites=[];});
 const writes=()=>p.evaluate(()=>window.calibrationWrites);
 const grow=()=>scroll.evaluate(el=>{const m=el.querySelector('.chat-message');m.style.minHeight=(m.getBoundingClientRect().height+24)+'px';});
 const position=()=>scroll.evaluate(el=>{const top=el.getBoundingClientRect().top,m=[...el.querySelectorAll('.chat-message')].find(m=>m.getBoundingClientRect().bottom>top);return{id:m.id,offset:m.getBoundingClientRect().top-top,top:el.scrollTop};});
 const box=await scroll.boundingBox();await p.mouse.move(box.x+box.width/2,box.y+box.height/2);
 await clear();
 for(let i=0;i<10;i++){await p.mouse.wheel(0,110);await p.waitForTimeout(25);await grow();await p.waitForTimeout(35);}
 evidence.wheelWrites=await writes();await p.screenshot({path:`evidence/scroll-interaction-${label}.png`});
 assert.equal(evidence.wheelWrites.length,0,'automatic calibration must not fight wheel input and delayed content sizing');
 const wheelEnd=await position();await p.waitForTimeout(400);const settled=await position();
 assert.equal(settled.id,wheelEnd.id);assert.ok(Math.abs(settled.offset-wheelEnd.offset)<3,'release must preserve the newly chosen position');
 evidence.checks.push('Native wheel input plus ten delayed height changes causes zero automatic scrollTop writes; no rebound on release');
 const idle=await position();await grow();await p.waitForTimeout(150);const idleAfter=await position();assert.equal(idle.id,idleAfter.id);assert.ok(Math.abs(idle.offset-idleAfter.offset)<3);evidence.checks.push('After interaction ends, a later image-like resize preserves the new reading anchor');
 await clear();await p.mouse.move(box.x+12,box.y+box.height/2);await p.mouse.down();await grow();
 await m.call('post_message',{requestId:'while-dragging',channelId:group.id,replyTo:root.id,body:'拖动过程中到达的新消息。',mentions:[]});
 await scroll.getByText('拖动过程中到达的新消息。',{exact:true}).waitFor({state:'attached',timeout:9000});
 evidence.pointerWrites=await writes();assert.equal(evidence.pointerWrites.length,0,'pointer hold must cover the real background refresh, not expire after a debounce');
 await p.mouse.up();await p.waitForTimeout(300);evidence.checks.push('Held pointer and real background HTTP refresh do not force any calibration');
 await scroll.focus();await clear();await p.keyboard.press('PageDown');await p.waitForTimeout(35);await grow();await p.waitForTimeout(100);evidence.keyboardWrites=await writes();assert.equal(evidence.keyboardWrites.length,0,'keyboard scrolling owns the viewport');await p.waitForTimeout(350);evidence.checks.push('Native PageDown scrolling is protected during delayed resize');
 await clear();await scroll.evaluate(el=>el.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[new Touch({identifier:1,target:el})]})));await grow();await p.waitForTimeout(300);assert.equal((await writes()).length,0);await scroll.dispatchEvent('touchend',{touches:[]});await p.waitForTimeout(300);evidence.checks.push('Simulated touch hold remains protected until touchend');
 const beforeSwitch=await position();await p.locator('.channel-list button').filter({hasText:'另一段讨论'}).click();await p.getByRole('heading',{name:'另一段讨论',level:1,exact:true}).waitFor();await p.locator('.channel-list button').filter({hasText:'主动滚动验收'}).click();await p.getByRole('heading',{name:'主动滚动验收',level:1,exact:true}).waitFor();await p.waitForTimeout(300);const restored=await position();assert.equal(restored.id,beforeSwitch.id);assert.ok(Math.abs(restored.offset-beforeSwitch.offset)<3);evidence.checks.push('Switching away and back still restores the final user-selected reading position');
 evidence.passed=true;console.log(JSON.stringify(evidence));
}catch(e){evidence.failure=e.message;console.error(e.stack);process.exitCode=1;}
finally{await app?.close();await browser?.close();await local?.close();await h.stop();await fs.writeFile(`evidence/scroll-interaction-${label}.json`,JSON.stringify(evidence,null,2)+'\n');}
