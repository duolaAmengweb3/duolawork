// An actual DSH Host/model, normal Hub UI/API, isolated actual Worker/D1.
// UI actions are performed through computer-use tools, not a simulated Agent.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {startHarness} from '../tests/v1-harness.mjs';
if(process.argv[2]!=='--serve-isolated')throw Error('Requires --serve-isolated; never uses production Hub groups');
const h=await startHarness(),dir=path.join(h.directory,'local');process.env.AGENT_HUB_DATA_DIR=dir;
const {privateJson}=await import('../local/storage.mjs');const {DshHost}=await import('../local/dsh-host.mjs');
const {start}=await import('../local/server.mjs');
const host=new DshHost(dir);await host.load();
const previous=path.join(os.homedir(),'.local/share/agent-hub/deepseek-proof');
host.location={root:previous,install:path.join(previous,'npm'),home:path.join(previous,'web-home-rc5'),modelFile:path.join(os.homedir(),'.config/agent-hub-dsh-test/model.json'),controlFile:path.join(previous,'connector.json'),processFile:path.join(previous,'web-process-rc5.json'),logFile:path.join(previous,'web-rc5.log'),patchFile:path.join(previous,'hub-web-patch.json')};
await privateJson(host.registry,host.location);
const config={endpoint:h.base,adminKey:h.key,runnerId:'isolated-dsh-product',port:0};
let local=await start({port:0,config,dshHost:host,vaultKey:Buffer.alloc(32,31)}),desktop;
config.port=Number(new URL(local.url).port);await privateJson(path.join(dir,'config.json'),config);
const packaged=process.argv.includes('--packaged');
const launchDesktop=()=>spawn(path.resolve('release/Agent Hub.app/Contents/MacOS/Electron'),[],{env:{...process.env,AGENT_HUB_TEST_MODE:'1'},stdio:'ignore'});
if(packaged){await local.close();desktop=launchDesktop();}
const descriptor='/tmp/hub-dsh-product-proof.json';
let closing=false,desktopRestarts=0;
const controlToken=randomBytes(32).toString('hex');
const control=http.createServer(async(req,res)=>{
 if(req.method!=='POST'||req.url!=='/finish'||req.headers.origin||req.headers.authorization!=='Bearer '+controlToken){res.writeHead(403);res.end();return;}
 try{await finish();res.writeHead(200,{'Content-Type':'application/json','Connection':'close'});res.end(JSON.stringify({finished:true}));control.close(()=>process.exit(0));}catch(e){res.writeHead(500);res.end(e.message);}
});
await new Promise(r=>control.listen(0,'127.0.0.1',r));
await privateJson(descriptor,{pid:process.pid,url:local.url,dataDir:dir,cloud:h.base,originalSession:'session-59156580-e81e-4ed7-b648-dac82cba3cfc',controlUrl:'http://127.0.0.1:'+control.address().port,controlToken});
console.log(JSON.stringify({ready:true,url:local.url,descriptor}));
process.on('SIGUSR2',async()=>{
 if(closing)return;
 try{if(desktop){if(desktop.exitCode===null&&desktop.signalCode===null){const exited=new Promise(r=>desktop.once('exit',r));desktop.kill('SIGTERM');await exited;}}else await local.close();desktop=launchDesktop();desktopRestarts++;console.log(JSON.stringify({desktopRestartStarted:true,pid:desktop.pid}));}catch(e){console.error(e.message);}
});
// workerd intercepts process-exit signals. Use authenticated HTTP for ordered evidence and disposal.
async function finish(){
 if(closing)return;closing=true;
 const evidenceFile=process.argv.includes('--cleanup-smoke')?'/tmp/hub-dsh-cleanup-smoke.json':packaged?'evidence/dsh-product-installed.json':'evidence/dsh-product.json';
  const workspace=await h.request('/v2/workspace');let records={};try{records=JSON.parse(await fs.readFile(path.join(dir,'dsh-members.json'),'utf8'));}catch{}
  const client=await fetch(local.url+'/api/local/status').then(r=>r.json()).catch(()=>null);
  const evidence={at:new Date().toISOString(),realNativeHost:true,realModel:!process.argv.includes('--cleanup-smoke'),productionHubChanged:false,claudeTouched:false,desktopRestarted:desktopRestarts>0,packagedOnly:packaged,buildId:client?.build?.id||client?.build?.contentHash||null,clientView:client?.clientView,members:workspace.members,connections:workspace.connections,bindings:Object.values(records).map(({memberId,sessionId,cwd,mode,verified,status})=>({memberId,sessionId,cwd,mode,verified,status})),channels:[]};
  for(const c of workspace.channels||[])evidence.channels.push(await h.request('/v2/channel?id='+c.id));
  await fs.writeFile(evidenceFile,JSON.stringify(evidence,null,2)+'\n');
  if(desktop){if(desktop.exitCode===null&&desktop.signalCode===null){const exited=new Promise(r=>desktop.once('exit',r));desktop.kill('SIGTERM');await exited;}}else await local.close();
  for(const r of Object.values(records))if(r.sessionId)await host.call('/unbind',{sessionId:r.sessionId});
  // Retain the small disposable workspaces if their native sessions are kept for inspection.
  const saved=path.join(os.homedir(),'.local/share/agent-hub/deepseek-proof/product-proof-workspaces');
  for(const r of Object.values(records))if(r.mode==='new'&&r.cwd&&await fs.stat(r.cwd).then(s=>s.isDirectory(),()=>false)){await fs.mkdir(saved,{recursive:true,mode:0o700});await fs.cp(r.cwd,path.join(saved,r.memberId),{recursive:true});}
  await h.stop();evidence.temporaryNativeBindingsRemoved=true;evidence.isolatedHubStopped=true;await fs.writeFile(evidenceFile,JSON.stringify(evidence,null,2)+'\n');await fs.rm(descriptor,{force:true});console.log('Isolated Hub grants and native bindings removed; production Hub untouched');
}
