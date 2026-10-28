import fs from'node:fs/promises';import path from'node:path';import{fileURLToPath}from'node:url';import{execFileSync,spawn}from'node:child_process';import{createHash}from'node:crypto';
import{dataDir,readConfig}from'../local/storage.mjs';
import{BrowserManager}from'../local/browser.mjs';
import{BackgroundPage}from'../local/background-page.mjs';
import{cloudClient}from'../local/transport.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),expected=JSON.parse(await fs.readFile(path.join(root,'shared/build-info.json'),'utf8')),bundle=path.join(root,'release/Agent Hub.app'),exe=path.join(bundle,'Contents/MacOS/Electron'),config=await readConfig(),base=`http://127.0.0.1:${config.port||8766}`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(p){const r=await fetch(base+p,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('Activation check returned HTTP '+r.status);return r.json();}
const durable=s=>({accounts:s.accounts,members:s.members,tasks:s.tasks,profile:s.profile,routines:s.routines,notes:s.notes,settings:s.settings,artifacts:s.artifacts});
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function localDigest(){const h=createHash('sha256');async function walk(dir){for(const e of(await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const f=path.join(dir,e.name);if(e.isDirectory())await walk(f);else if(e.isFile()){h.update(path.relative(dataDir,f));h.update(await fs.readFile(f));}}}await walk(dataDir);return h.digest('hex');}
let before;try{before=await get('/api/state');}catch(e){if(e.cause?.code!=='ECONNREFUSED')throw e;before=await cloudClient(config).state();}
if(before&&before.tasks.some(t=>t.steps.some(s=>s.status==='running')))throw new Error('当前有任务在执行，未强行重启。');
// Hold a blank hidden frame across the app's exit. This matters when the
// user's last account window is closed: Chrome otherwise unloads that context.
const updater=new BrowserManager({proxy:()=>config.browserProxyUrl||''}),holds=[];
try{
await updater.recover(before?.accounts||[]);
for(const entry of updater.active.values())holds.push(await BackgroundPage.create(entry.endpoint,'about:blank'));
const handoff=[...new Map([...(before?.local?.browsers||[]),...updater.list()].map(b=>[b.accountId,b])).values()];
async function persistentDigest(){if(!handoff.length)return localDigest();const h=createHash('sha256');for(const name of ['config.json','vault.enc','vault.key','vault-key.oscrypt','browser-profiles.json','agent-connections.json']){h.update(name);try{h.update(await fs.readFile(path.join(dataDir,name)));}catch(e){if(e.code!=='ENOENT')throw e;h.update('absent');}}return h.digest('hex');}
async function post(p,body={},retry=0){const r=await fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(['/api/local/finish-update','/api/local/restore-sessions'].includes(p)?60000:15000)});if(r.status===409&&p==='/api/local/prepare-update'&&retry<12){await sleep(500);return post(p,body,retry+1);}if(!r.ok)throw new Error('更新交接失败 HTTP '+r.status);return r.json();}
const localBefore=await persistentDigest(),cloudBefore=before?digest(durable(before)):null;
let oldPid=null,prepared=false;
try{const ids=execFileSync('/usr/sbin/lsof',['-t','-iTCP:'+(config.port||8766),'-sTCP:LISTEN'],{encoding:'utf8'}).trim().split(/\s+/).filter(Boolean);if(ids.length!==1)throw new Error('Local port has unexpected listeners');oldPid=Number(ids[0]);const cmd=execFileSync('/bin/ps',['-p',String(oldPid),'-o','command='],{encoding:'utf8'}).trim();if(cmd!==exe)throw new Error('本机端口属于其他程序，未关闭任何进程。');if(handoff.length){const result=await post('/api/local/prepare-update');if(!result.prepared||!(before?.local?.browsers||[]).every(b=>result.browsers.some(n=>n.accountId===b.accountId&&n.pid===b.pid)))throw new Error('原账号窗口未准备好交接，未重启。');prepared=true;}process.kill(oldPid,'SIGTERM');for(let i=0;i<300;i++){try{process.kill(oldPid,0);}catch{oldPid=null;break;}await sleep(100);}if(oldPid)throw new Error('原客户端没有完成退出，未强制终止。');}catch(e){if(prepared&&oldPid)await post('/api/local/cancel-update').catch(()=>{});if(!String(e.message).includes('lsof'))throw e;}
await fs.mkdir(path.join(root,'.local'),{recursive:true});const log=await fs.open(path.join(root,'.local/activation.log'),'a',0o600);const env={...process.env,AGENT_HUB_ACTIVATING:'1',AGENT_HUB_LAUNCH_EVIDENCE:path.join(root,'.local/activated-client.png')};delete env.AGENT_HUB_TEST_MODE;delete env.AGENT_HUB_DATA_DIR;delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(exe,[],{cwd:root,env,detached:true,stdio:['ignore',log.fd,log.fd]});child.unref();await log.close();
let status;for(let i=0;i<180;i++){try{status=await get('/api/local/status');if(status.build?.id===expected.id&&status.clientView?.ready&&status.clientView?.buildId===expected.id&&status.online&&handoff.every(b=>status.browsers.some(n=>n.accountId===b.accountId&&n.pid===b.pid)))break;}catch{}await sleep(200);}
if(status?.build?.id!==expected.id||status?.clientView?.buildId!==expected.id||!status.clientView.ready||!status.online)throw new Error('新客户端还未通过实际启用检查，不能报告更新完成；详情保留在 .local/activation.log。');
if(handoff.length)await post('/api/local/restore-sessions');
const after=await get('/api/state');if(!handoff.every(b=>status.browsers.some(n=>n.accountId===b.accountId&&n.pid===b.pid)))throw new Error('原账号浏览器未被接管，不自动创建或重新登录。');for(const b of handoff){if(before.local?.loginStatuses?.[b.accountId]?.status==='authenticated'){const proof=await post('/api/account/login-check',{accountId:b.accountId});if(proof.status!=='authenticated')throw new Error('更新后登录尚未确认，不自动重新登录。');}}const localAfter=await persistentDigest();if(localAfter!==localBefore)throw new Error('持久资料校验不一致，未标记为交付完成。');if(cloudBefore&&digest(durable(after))!==cloudBefore)throw new Error('工作区任务或配置发生变化，未标记为交付完成。');
await post('/api/local/finish-update');
const report={at:new Date().toISOString(),url:base,buildId:expected.id,processId:status.processId,desktopBuildId:status.clientView.buildId,backendAndDesktopMatch:true,cloudOnline:status.online,protectedLocalDataUnchanged:handoff.length?null:true,protectedLocalMetadataUnchanged:true,ownedBrowsersPreserved:handoff.length,profileVerification:handoff.length?'原浏览器进程与账号目录相同；已登录账号只读复核':'关闭浏览器时核对完整资料字节',workspaceDataUnchanged:!!cloudBefore,realCommercialAgentTested:false};await fs.writeFile(path.join(root,'evidence/activation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));

}finally{for(const page of holds)page.close();for(const entry of updater.active.values()){entry.workPage?.close();await entry.browser.close().catch(()=>{});}}
