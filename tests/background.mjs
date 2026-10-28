import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {BrowserManager} from '../local/browser.mjs';
import {BackgroundPage} from '../local/background-page.mjs';

const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<textarea></textarea><div id="out"></div><script>document.querySelector("textarea").addEventListener("keydown",e=>{if(e.key==="Enter"){document.querySelector("#out").textContent=e.target.value;e.target.value="";}});</script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-background-gate-')),url=`http://127.0.0.1:${server.address().port}`,root=path.join(dir,'profiles'),account={id:'account_backgroundgate',entryUrl:url};
let current=new BrowserManager({root,testMode:true}),holder,next;
try{
 await current.ensureBackground(account);
 let entry=current.active.get(account.id),page=entry.workPage;
 assert.equal(entry.context.pages().length,0,'background work must not create a visible page');
 assert.doesNotMatch(await page.evaluate(()=>navigator.userAgent),/HeadlessChrome/);
 assert.equal(await page.evaluate(()=>navigator.webdriver),true,'original remote-debugging-port=0 flag is retained, not spoofed');
 await assert.rejects(page.send('Browser.getWindowForTarget',{targetId:page.targetId}),/window not found/);
 await page.locator('textarea:visible').fill('real keyboard delivery');await page.locator('textarea:visible').press('Enter');
 assert.equal(await page.evaluate(()=>document.querySelector('#out').textContent),'real keyboard delivery');
 // Two persistent account sessions must coexist even at execution limit 1.
 const other={id:'account_secondlogin',entryUrl:url};await current.ensureBackground(other);
 assert.equal(current.list().length,2,'an idle logged-in session cannot block another account login');
 assert.notEqual(current.active.get(other.id).child.pid,entry.child.pid);
 assert.equal(current.active.get(other.id).context.pages().length,0);await current.close(other.id);
 await entry.context.addCookies([{name:'background-session',value:'test-only',url}]);
 await page.evaluate(()=>localStorage.setItem('background-marker','test-only-value'));
 // Keep a target owned by the updater until the successor has its own one.
 const pid=entry.child.pid;holder=await BackgroundPage.create(entry.endpoint,'about:blank');
 await entry.browser.close();entry.workPage.close();
 next=new BrowserManager({root,testMode:true});await next.recover([account]);await next.ensureBackground(account);
 holder.close();holder=null;entry=next.active.get(account.id);page=entry.workPage;
 assert.equal(entry.child.pid,pid,'windowless update retains the same Chrome PID');
 assert.equal((await entry.context.cookies()).find(c=>c.name==='background-session')?.value,'test-only');
 assert.equal(await page.evaluate(()=>localStorage.getItem('background-marker')),'test-only-value');
 assert.equal(entry.context.pages().length,0);
 // A graceful app quit and restart uses the exact same registered profile.
 await next.closeAll();await next.ensureBackground(account);entry=next.active.get(account.id);page=entry.workPage;
 assert.equal((await entry.context.cookies()).find(c=>c.name==='background-session')?.value,'test-only');
 assert.equal(await page.evaluate(()=>localStorage.getItem('background-marker')),'test-only-value');
 assert.equal(entry.context.pages().length,0);
 await entry.context.clearCookies({name:'background-session'});await next.closeAll();await next.ensureBackground(account);
 assert.equal((await next.active.get(account.id).context.cookies()).find(c=>c.name==='background-session'),undefined,'explicit logout is not resurrected');
 const report={at:new Date().toISOString(),checks:['windowless headed Chrome keeps the Chrome user agent and does not patch webdriver','hidden page has no native window','two independent persistent login sessions coexist at execution limit 1','real keyboard input and Enter deliver into the rendered page','update retains the same Chrome PID without a visible page','session cookie and localStorage survive windowless update and app restart','explicit logout remains logged out'],realCommercialAgentTested:false};
 await fs.writeFile('evidence/background.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{holder?.close();await next?.closeAll();await current.closeAll();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
