// Real original desktop Agent + isolated actual Worker/D1. Never production groups.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {startHarness} from '../tests/v1-harness.mjs';
if(!process.argv.includes('--serve-isolated'))throw Error('Requires --serve-isolated');
const h=await startHarness(),dir=path.join(h.directory,'local');process.env.AGENT_HUB_DATA_DIR=dir;
const {privateJson}=await import('../local/storage.mjs');
const {AntigravityDesktopHost}=await import('../local/antigravity-host.mjs');
const {start}=await import('../local/server.mjs');
const host=new AntigravityDesktopHost(path.join(os.homedir(),'.config/agent-hub'));await host.start();
process.env.AGENT_HUB_TEST_ANTIGRAVITY_BRIDGE_ROOT=host.root;
const config={endpoint:h.base,adminKey:h.key,runnerId:'isolated-original-antigravity',port:0};
let local=await start({port:0,config,vaultKey:Buffer.alloc(32,34),antigravityHost:host}),desktop,restarts=0;
config.port=Number(new URL(local.url).port);await privateJson(path.join(dir,'config.json'),config);
const packaged=process.argv.includes('--packaged');
const launch=()=>spawn(path.resolve('release/Agent Hub.app/Contents/MacOS/Electron'),[],{env:{...process.env,AGENT_HUB_TEST_MODE:'1',AGENT_HUB_TEST_VISIBLE:'1'},stdio:'ignore'});
if(packaged){await local.close();desktop=launch();}
const descriptor='/tmp/hub-antigravity-product.json',token=randomBytes(32).toString('hex');let closing=false;
async function finish(){
 if(closing)return;closing=true;
 const records=JSON.parse(await fs.readFile(path.join(dir,'antigravity-desktop-members.json'),'utf8').catch(()=> '{}'));
 const workspace=await h.request('/v2/workspace'),channels=[];for(const c of (await h.request('/v2/channels')).items)channels.push(await h.request('/v2/channel?id='+c.id));
 const status=await fetch(local.url+'/api/local/status').then(r=>r.json());
 const evidence={at:new Date().toISOString(),officialOriginalDesktop:true,realModel:true,version:(await host.status()).version,packaged,desktopRestarts:restarts,clientView:status.clientView,members:workspace.members,connections:workspace.connections,bindings:Object.values(records).map(({memberId,sessionId,cwd,verified,status,enabled})=>({memberId,sessionId,cwd,verified,status,enabled})),channels,toolReceipts:(await host.call('/health')).bindings,productionHubChanged:false,providerLoginRead:false,claudeTouched:false};
 const file=packaged?'evidence/antigravity-product-installed.json':'evidence/antigravity-product.json';await fs.writeFile(file,JSON.stringify(evidence,null,2)+'\n');
 if(desktop){if(desktop.exitCode===null&&desktop.signalCode===null){const exited=new Promise(r=>desktop.once('exit',r));desktop.kill('SIGTERM');await exited;}}else await local.close();
 for(const r of Object.values(records))if(r.sessionId)await host.call('/unbind',{sessionId:r.sessionId});await h.stop();await fs.rm(descriptor,{force:true});evidence.temporaryBindingsRemoved=true;evidence.isolatedHubStopped=true;await fs.writeFile(file,JSON.stringify(evidence,null,2)+'\n');
}
const control=http.createServer(async(req,res)=>{if(req.method!=='POST'||req.url!=='/finish'||req.headers.origin||req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end();return;}try{await finish();res.writeHead(200,{'Connection':'close'});res.end('finished');control.close(()=>process.exit(0));}catch(e){res.writeHead(500);res.end(e.message);}});await new Promise(r=>control.listen(0,'127.0.0.1',r));
await privateJson(descriptor,{pid:process.pid,url:local.url,dataDir:dir,controlUrl:'http://127.0.0.1:'+control.address().port,controlToken:token});console.log(JSON.stringify({ready:true,url:local.url,descriptor}));
process.on('SIGUSR2',async()=>{if(closing)return;if(desktop){const exited=new Promise(r=>desktop.once('exit',r));desktop.kill('SIGTERM');await exited;desktop=launch();}else{await local.close();local=await start({port:config.port,config,vaultKey:Buffer.alloc(32,34),antigravityHost:host});}restarts++;console.log('Original-session Hub restarted with the same test data');});
