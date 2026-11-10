// Visible packaged UI acceptance, isolated from all production data.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {startHarness} from '../tests/v1-harness.mjs';
if(!process.argv.includes('--serve-isolated'))throw Error('Requires --serve-isolated');
const h=await startHarness(),dir=path.join(h.directory,'local');process.env.AGENT_HUB_DATA_DIR=dir;
const {privateJson}=await import('../local/storage.mjs'),{start}=await import('../local/server.mjs');
await h.request('/admin/action',{type:'settings.update',payload:{automation:false}});
await h.request('/admin/action',{type:'platform.create',payload:{id:'claude-code',name:'Claude Code'}});
const fixture=await h.member('claude-code','Claude 远端测试');
await h.command('channel.create',{name:'远端协作测试',memberIds:[fixture.id]});
const stamp={sessionId:'fixture-original',instanceId:'fixture-instance',runtimeId:'isolated-fixture',title:'网站项目 · 原会话',workspace:'/srv/example'};
const heartbeat=async()=>h.request('/v2/self/native-sessions',stamp,fixture.token);
await heartbeat();const heartbeatTimer=setInterval(()=>heartbeat().catch(()=>{}),25000);
const config={endpoint:h.base,adminKey:h.key,runnerId:'chat-session-ui-acceptance',port:0};let local=await start({port:0,config,vaultKey:Buffer.alloc(32,16)});config.port=Number(new URL(local.url).port);const url=local.url;await local.close();await privateJson(path.join(dir,'config.json'),config);
let desktop,restarts=0;const app=path.resolve('release/Agent Hub.app');const launch=()=>spawn(path.join(app,'Contents/MacOS/Electron'),[],{env:{...process.env,AGENT_HUB_TEST_MODE:'1',AGENT_HUB_TEST_VISIBLE:'1'},stdio:'ignore'});desktop=launch();
let closing=false;const token=randomBytes(32).toString('hex'),descriptor='/tmp/hub-claude-ui.json';
const stopDesktop=async()=>{if(desktop&&desktop.exitCode===null&&desktop.signalCode===null){const exit=new Promise(r=>desktop.once('exit',r));desktop.kill('SIGTERM');await exit;}};
async function finish(){if(closing)return;closing=true;const workspace=await h.request('/v2/workspace'),channels=[];for(const c of (await h.request('/v2/channels')).items)channels.push(await h.request('/v2/channel?id='+c.id));const status=await fetch(url+'/api/local/status').then(r=>r.json()),coding=await fetch(url+'/api/local/coding/status').then(r=>r.json());await fs.writeFile('evidence/claude-remote-ui.json',JSON.stringify({at:new Date().toISOString(),packaged:true,realCommercialClaudeTested:false,isolatedHub:true,desktopRestarts:restarts,clientView:status.clientView,build:status.build,members:workspace.members,connections:workspace.connections,coding,channels},null,2)+'\n');clearInterval(heartbeatTimer);await stopDesktop();await h.stop();await fs.rm(descriptor,{force:true});}
const control=http.createServer(async(req,res)=>{if(req.method!=='POST'||req.url!=='/finish'||req.headers.origin||req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end();return;}try{await finish();res.writeHead(200,{'Connection':'close'});res.end('finished');control.close(()=>process.exit(0));}catch(e){res.writeHead(500);res.end(e.message);}});await new Promise(r=>control.listen(0,'127.0.0.1',r));
await privateJson(descriptor,{pid:process.pid,app,url,dataDir:dir,controlUrl:'http://127.0.0.1:'+control.address().port,controlToken:token});console.log(JSON.stringify({ready:true,url,descriptor,app}));
process.on('SIGUSR2',async()=>{if(closing)return;let s;try{s=await fetch(url+'/api/local/coding/status').then(r=>r.json());}catch(e){if(desktop?.exitCode===null&&desktop?.signalCode===null){console.log('Existing test app not responding; restart deferred');return;}s={members:[]};}if(s.members.some(r=>r.status==='working')){console.log('Still working; restart deferred');return;}await stopDesktop();desktop=launch();restarts++;console.log('Packaged acceptance app restarted with the same test data');});
