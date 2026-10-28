import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {BrowserManager} from '../local/browser.mjs';
import {LoginMonitor} from '../local/login-status.mjs';

const probes=[];
const server=http.createServer((req,res)=>{if(req.url.startsWith('/probe')){probes.push({url:req.url,cookie:req.headers.cookie});res.end('ok');return;}res.setHeader('Content-Type','text/html');res.end('<title>Hub manual login isolated fixture</title><p>Isolated login handoff fixture; no real Google account.</p><script>fetch("/probe?webdriver="+navigator.webdriver)</script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}`,dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-human-login-')),root=path.join(dir,'profiles'),account={id:'account_manualfixture',entryUrl:url,platformId:'muse'};
const manager=new BrowserManager({root,testMode:true}),recovered=new BrowserManager({root,testMode:true});
try{
 await manager.open(account,{visible:false});
 const first=manager.active.get(account.id);await first.context.addCookies([{name:'fixture-session',value:'preserved',url}]);await first.context.pages()[0].evaluate(()=>localStorage.setItem('fixture-marker','kept'));
 probes.length=0;await manager.openManual(account);
 const manual=manager.manual.entries.get(account.id),command=execFileSync('/bin/ps',['-p',String(manual.pid),'-o','command='],{encoding:'utf8'});
 assert.ok(command.includes('--user-data-dir='+path.join(root,account.id)));assert.doesNotMatch(command,/--remote-debugging|--headless|--enable-automation|disable-blink|user-agent/);
 for(let i=0;i<100&&!probes.some(p=>p.url.includes('webdriver=false'));i++)await new Promise(r=>setTimeout(r,100));
 assert.ok(probes.some(p=>p.url.includes('webdriver=false')&&p.cookie?.includes('fixture-session=preserved')),'ordinary manual Chrome must preserve session and report its real uncontrolled state');
 assert.equal(manager.active.has(account.id),false);await assert.rejects(manager.ensureBackground(account),/纯手动登录/);await assert.rejects(manager.open(account),/纯手动登录/);
 const monitor=new LoginMonitor({file:path.join(dir,'login-status.json')});assert.equal((await monitor.check(account,manager)).status,'manual_login');
 // Chrome update/relaunch leaves stale owner PID but the exact profile lock remains authoritative.
 const originalManualPid=manual.pid;manual.pid=99999999;
 assert.equal(manager.manual.status()[account.id].running,true,'same-profile Chrome must survive stale recorded PID');
 assert.equal(manual.pid,originalManualPid);
 const ownerFile=path.join(root,account.id,'hub-owner.json'),owner=JSON.parse(await fs.readFile(ownerFile,'utf8'));owner.pid=99999999;await fs.writeFile(ownerFile,JSON.stringify(owner));
 await recovered.recover([account]);assert.equal(recovered.manual.status()[account.id].running,true);assert.equal(recovered.manual.entries.get(account.id).pid,manual.pid);assert.equal(recovered.active.size,0,'app update must not attach CDP to a human login');
 await recovered.manual.close(account.id,{finish:true});await recovered.ensureBackground(account);
 const entry=recovered.active.get(account.id);assert.equal((await entry.context.cookies()).find(c=>c.name==='fixture-session')?.value,'preserved');
 assert.equal(await entry.workPage.evaluate(()=>localStorage.getItem('fixture-marker')),'kept');
 const report={at:new Date().toISOString(),checks:['manual Chrome has no CDP/headless/automation/concealment flags','real fixture page observes webdriver=false and original session cookie','same account profile and browser product preserved','manual login is not reported as authenticated','automatic restore and dispatch browser blocked during login','update recovers same manual process without connecting CDP','stale owner PID resolves only the same profile/executable/proxy before return','explicit return restores background browser with original session and local storage'],realGoogleLoginTested:false,realCommercialAgentTested:false};await fs.writeFile('evidence/manual-login.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await recovered.closeAll();await manager.closeAll();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
