import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {_electron} from 'playwright-core';
import {startHarness} from './v1-harness.mjs';
import {CodingManager} from '../local/coding-manager.mjs';
const h=await startHarness();let app;
const evidence={at:new Date().toISOString(),isolated:true,nativeAgentSimulated:true,realElectron:true,checks:[]};
try{
 await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
 await h.request('/admin/action',{type:'platform.create',payload:{id:'codex',name:'Codex'}});
 const member=await h.member('codex','Codex'),c=await h.command('channel.create',{name:'消息进度验收',memberIds:[member.id],coordinatorId:member.id});
 await h.command('channel.post',{channelId:c.id,body:'检查这次修改，并告诉我结果。'});
 const work=(await member.call('list_work')).work.find(w=>w.channelId===c.id);
 const claim=await member.call('claim_work',{requestId:randomUUID(),stepId:work.stepId});
 await member.call('report_progress',{requestId:randomUUID(),attemptId:claim.turnId,lease:claim.lease,message:'正在核对代码和测试结果'});
 const dir=path.join(h.directory,'desktop');await fs.mkdir(dir);
 const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 await fs.writeFile(path.join(dir,'config.json'),JSON.stringify({endpoint:h.base,adminKey:h.key,runnerId:'message-processing-test',port}));
 app=await _electron.launch({executablePath:path.resolve('release/Agent Hub.app/Contents/MacOS/Electron'),args:[],env:{...process.env,AGENT_HUB_DATA_DIR:dir,AGENT_HUB_TEST_MODE:'1'},timeout:20000});
 const p=await app.firstWindow();await p.getByRole('heading',{name:'消息进度验收',exact:true}).waitFor();
 await p.locator('.pending-member').filter({hasText:'处理中 · 正在核对代码和测试结果'}).waitFor();
 await p.locator('.pending-member').click();await p.getByRole('heading',{name:'消息进度',exact:true}).waitFor();
 assert.equal(await p.getByText('正在回复',{exact:true}).count(),0);
 await p.screenshot({path:'evidence/m10-processing.png'});
 evidence.checks.push('Packaged Mac UI shows processing and actual report_progress in chat and message details');
 // Simulated native metadata, real connector state logic and authenticated HTTP.
 // No production process is stopped to manufacture a failure.
 const manager=new CodingManager({config:{},dataDir:path.join(h.directory,'receiver')});await fs.mkdir(manager.dataDir);
 manager.workingHost={executionState:async()=>({state:'idle'})};
 const client={api:(route,options)=>h.request(route,options?.body,member.token)};
 const record={memberId:member.id,engine:'codex',enabled:true,status:'working',inFlight:{stepId:claim.turnId,key:c.id},chatBindings:{[c.id]:{sessionId:'isolated-native-thread'}}};
 manager.records[member.id]=record;
 const started=Date.now();await manager.observeOriginal(record,client,started);await manager.save();
 await new Promise(r=>setTimeout(r,61000));await manager.observeOriginal(record,client);await manager.save();
 const state=JSON.parse(await fs.readFile(manager.file,'utf8'))[member.id];
 assert.equal(state.inFlight,null);assert.equal(state.status,'needs_review');
 evidence.elapsedToStalledMs=Date.now()-started;
 await p.locator('.delivery-state').filter({hasText:'尚未收到回复'}).waitFor({timeout:20000});
 await p.locator('.delivery-entry details summary').first().click();
 await p.getByText('原对话已结束，但这条消息尚未回传；请在原环境检查。',{exact:true}).waitFor();
 assert.equal(await p.locator('.pending-member').count(),0);
 await p.screenshot({path:'evidence/m10-stalled.png'});
 evidence.checks.push('After 61 real seconds of observed idle without receipt, cloud becomes stalled and pending indicator clears', 'Real isolated native-coding.json records inFlight=null and needs_review, not a fake completed reply');
 const local=await(await fetch(`http://127.0.0.1:${port}/api/local/status`)).json();evidence.build=local.build;evidence.desktopBuild=local.clientView.buildId;assert.equal(local.build.id,local.clientView.buildId);
 evidence.passed=true;console.log(JSON.stringify(evidence));
}catch(e){evidence.failure=e.stack;throw e;}
finally{await app?.close();await h.stop();await fs.writeFile('evidence/message-processing-desktop.json',JSON.stringify(evidence,null,2)+'\n');}
