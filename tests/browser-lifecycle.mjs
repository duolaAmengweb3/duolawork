import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {BrowserManager} from '../local/browser.mjs';
import {BackgroundPage} from '../local/background-page.mjs';

const server=http.createServer((req,res)=>{
 if(req.url==='/fail'){req.socket.destroy();return;}
 res.setHeader('Content-Type','text/html');res.end('<title>Isolated browser lifecycle fixture</title><textarea></textarea>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-lifecycle-gate-'));
const manager=new BrowserManager({root:path.join(dir,'profiles'),testMode:true});
const processes=()=>execFileSync('/bin/ps',['-ax','-o','pid=,command='],{encoding:'utf8'}).split('\n').filter(line=>/^\s*\d+\s+\/Applications\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome /.test(line)&&line.includes('--user-data-dir='+dir+path.sep));
let holder;
try{
 for(const background of [false,true]){
  const account={id:background?'account_failedbackground':'account_failedheadless',entryUrl:url+'/fail'};
  await assert.rejects(manager.open(account,{visible:false,background}));
  assert.equal(processes().length,0,'failed startup must wait for Chrome to exit');
  assert.equal(manager.active.size,0);
  await fs.access(path.join(manager.root,account.id,'hub-profile.json'));
  await manager.open({...account,entryUrl:url},{visible:false});
  await manager.close(account.id);
 }

 // Quit while a launch is awaiting filesystem/browser discovery, before it
 // has entered the active map. No delayed browser may appear after quit.
 for(const scope of ['account','all']){
 let entered,release;
 const enteredPromise=new Promise(resolve=>{entered=resolve;});
 const releasePromise=new Promise(resolve=>{release=resolve;});
 const findChrome=manager.findChrome.bind(manager);
 manager.findChrome=async()=>{entered();await releasePromise;return findChrome();};
 const pendingAccount={id:'account_quitduringstart'+scope,entryUrl:url};
 const pending=manager.open(pendingAccount,{visible:false});
 const rejected=assert.rejects(pending,/退出/);
 await enteredPromise;
 let closed=false;
 const closing=(scope==='all'?manager.closeAll():manager.close(pendingAccount.id)).then(result=>{if(scope==='account')assert.equal(result.closed,true,'completed close must return a successful receipt');closed=true;});
 await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal(closed,false,'quit must wait for an in-flight startup');
 await assert.rejects(manager.open(scope==='all'?{id:'account_lateduringquit',entryUrl:url}:pendingAccount,{visible:false}),/退出/);
 release();await Promise.all([closing,rejected]);manager.findChrome=findChrome;
 assert.equal(processes().length,0);
 }

 // CDP disconnection is not Chrome exit. A background target keeps the real
 // process alive, reproducing the orphan case without any production account.
 const account={id:'account_disconnected',entryUrl:url};
 for(let round=0;round<3;round++){
  await manager.ensureBackground(account);
  const entry=manager.active.get(account.id),value='test-only-'+round;
  await entry.context.addCookies([{name:'lifecycle-session',value,url}]);
  holder=await BackgroundPage.create(entry.endpoint,'about:blank');
  await entry.browser.close();
  for(let i=0;i<30&&!manager.disconnected.has(entry.child.pid);i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert(manager.disconnected.has(entry.child.pid),'live disconnected browser remains tracked');
  assert.equal(processes().length,1);
  await manager.closeAll();holder.close();holder=null;
  assert.equal(processes().length,0);
  await manager.open(account,{visible:false});
  assert.equal((await manager.active.get(account.id).context.cookies()).find(cookie=>cookie.name==='lifecycle-session')?.value,value,'cleanup preserves the same login profile');
  await manager.closeAll();
 }
 assert.equal(processes().length,0);
 const report={at:new Date().toISOString(),disconnectedSessionCycles:3,checks:['failed headless and windowless startup leave no Chrome process','failed startup preserves the profile and permits a clean retry','account close and app quit both wait for pending startup and block late opens','disconnected CDP browser is reaped on quit','session cookie survives cleanup and reopen in the same profile','all isolated Chrome processes exit'],realCommercialAgentTested:false};
 await fs.writeFile('evidence/browser-lifecycle.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{
 holder?.close();await manager.closeAll();
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 if(processes().length)throw new Error('Isolated Chrome still running; retained test directory for inspection');
 await fs.rm(dir,{recursive:true,force:true});
}
