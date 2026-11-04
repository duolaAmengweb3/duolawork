import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readConfig, openVault, dataDir, privateJson } from './storage.mjs';
import { cloudClient, networkStatus, networkDiagnostics, requestJson } from './transport.mjs';
import { BrowserManager, normalizeBrowserProxy, checkBrowserNetwork } from './browser.mjs';
import { Runner } from './runner.mjs';
import { LoginMonitor } from './login-status.mjs';
import { AgentConnections } from './connections.mjs';
import { assertHttpUrl, maintainedPlatforms } from '../shared/platforms.mjs';
import {automaticAvailability,availableMember,workspaceStart,workspaceFollowup,workspaceExecute} from '../shared/workspace.mjs';
import BUILD from '../shared/build-info.json' with {type:'json'};
import {DocumentStore,attachDocument} from './documents.mjs';
import {grokState} from './grok.mjs';
import {proxyCollaboration} from './collaboration-proxy.mjs';
import {openProviderApp} from './provider-app.mjs';
import {CodingManager} from './coding-manager.mjs';
import {DshManager} from './dsh-manager.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
async function body(req){const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>200000)throw new Error('请求内容过大');chunks.push(part);}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw new Error('无效 JSON');}}
export async function start({port,notify,vaultKey,resolveVaultKey,maintenance=false,config:givenConfig,nativeRuntime,nativeAgentFactory,dshHost}={}){
 const config=givenConfig||await readConfig(),vault=await openVault(vaultKey,{resolveKey:resolveVaultKey,defer:!!resolveVaultKey}),cloud=cloudClient(config);
 const browsers=new BrowserManager({limit:()=>runner.snapshot?.settings.maxBrowserConcurrency||1,proxy:()=>config.browserProxyUrl||''});
 const logins=new LoginMonitor({file:path.join(dataDir,'login-status.json')});
 const connections=new AgentConnections({cloud,browsers,logins,file:path.join(dataDir,'agent-connections.json')});
 const documents=new DocumentStore(path.join(dataDir,'documents'));
 const coding=new CodingManager({config,dataDir,maintenance,runtime:nativeRuntime,agentFactory:nativeAgentFactory});await coding.load();
 const dsh=new DshManager({config,dataDir,maintenance,host:dshHost});await dsh.load();
 const availability=state=>{const ready=automaticAvailability(state,{supports:(a,m)=>connections.supports(a,m),credentials:vault.data.members,locked:vault.locked});for(const m of state.members)if(browsers.isManual(m.accountId))ready[m.id]={canDispatch:false,reason:'正在纯手动登录，任务派发已暂停'};return ready;};
 const runner=new Runner({cloud,vault,browsers,connections,config,notify,maintenance});let origin,browserNetworkCheck=null,networkChecking=false,keepBrowsersOnShutdown=false,clientView={kind:'browser',ready:false,buildId:null};
 const server=http.createServer(async(req,res)=>{try{const host=req.headers.host||'';if(origin?host!==new URL(origin).host:!host.startsWith('127.0.0.1:'))return json(res,{message:'仅限本机访问'},403);const url=new URL(req.url,origin||'http://127.0.0.1');
 if(url.pathname.startsWith('/api/')){
 if((req.headers.origin&&req.headers.origin!==origin)||['cross-site','same-site'].includes(req.headers['sec-fetch-site']))return json(res,{message:'跨站请求已拒绝'},403);
 if(req.method!=='GET'&&!req.headers['content-type']?.startsWith('application/json')&&!(url.pathname==='/api/v2/files'&&req.headers['content-type']==='application/octet-stream'))return json(res,{message:'需要 JSON 请求'},415);
 if(url.pathname==='/api/v2/catalog'&&req.method==='GET'){
  const c=await requestJson(config.endpoint+'/v2/catalog',{token:config.adminKey});
  if(!c.platforms.some(p=>p.id==='deepseek-harness'))c.platforms.push({id:'deepseek-harness',name:'DeepSeek Harness',kind:'coding',status:'local_available',registered:false});
  return json(res,c);
 }
 if(url.pathname.startsWith('/api/v2/'))return await proxyCollaboration(req,res,config);
 if(url.pathname==='/api/local/coding/status'&&req.method==='GET'){const s=coding.status();return json(res,{...s,members:[...s.members,...dsh.status()]});}
 if(url.pathname==='/api/local/dsh/status'&&req.method==='GET')return json(res,{...(await dsh.hostFor(url.searchParams.get('memberId')).status()),preparing:!!dsh.preparing,prepareError:dsh.prepareError,members:dsh.status()});
 if(url.pathname==='/api/local/dsh/configure'&&req.method==='POST'){const input=await body(req);return json(res,await dsh.hostFor(input.memberId).configure(input));}
 if(url.pathname==='/api/local/dsh/prepare'&&req.method==='POST')return json(res,await dsh.prepare(await body(req)));
 if(url.pathname==='/api/local/dsh/sessions'&&req.method==='GET')return json(res,await dsh.hostFor(url.searchParams.get('memberId')).sessions());
 if(url.pathname==='/api/local/dsh/connect'&&req.method==='POST')return json(res,await dsh.connect(await body(req)));
 if(url.pathname==='/api/local/dsh/resume'&&req.method==='POST')return json(res,await dsh.resume(await body(req)));
 if(url.pathname==='/api/local/dsh/open'&&req.method==='POST')return json(res,await dsh.hostFor((await body(req)).memberId).open());
 if(url.pathname==='/api/local/coding/discover'&&req.method==='GET')return json(res,await coding.runtime.discover());
 if(url.pathname==='/api/local/coding/connect'&&req.method==='POST')return json(res,await coding.connect(await body(req)));
 if(url.pathname==='/api/local/coding/pause'&&req.method==='POST')return json(res,await coding.pause(await body(req)));
 if(url.pathname==='/api/local/coding/resume'&&req.method==='POST')return json(res,await coding.resume(await body(req)));
 if(url.pathname==='/api/local/coding/approve'&&req.method==='POST')return json(res,coding.decide(await body(req)));
 if(url.pathname==='/api/local/coding/permissions'&&req.method==='POST')return json(res,await coding.permissions(await body(req)));
 if(url.pathname==='/api/local/open-provider'&&req.method==='POST')return json(res,await openProviderApp((await body(req)).platformId));
 if(url.pathname==='/api/state'&&req.method==='GET'){const state=await cloud.state();runner.snapshot=state;return json(res,{...state,platforms:maintainedPlatforms(state.platforms),local:{...runner.status,maintenance:runner.maintenance,build:BUILD,clientView,processId:process.pid,browsers:browsers.list(),manualLogins:browsers.manual.status(),agentConnections:connections.snapshot(),memberAvailability:availability(state),loginStatuses:await logins.snapshot(state.accounts,browsers),endpoint:config.endpoint||'',networkMode:networkStatus(),browserProxyUrl:config.browserProxyUrl||'',desktopNotifications:config.desktopNotifications===true,browserNetworkCheck,dataDir,toolCredentialsLocked:vault.locked,platformCredentials:Object.keys(vault.data.members).map(id=>({memberId:id,hasTrigger:!!vault.data.members[id].triggerUrl,hasConnector:!!vault.data.members[id].token}))}});}
 if(url.pathname==='/api/local/status')return json(res,{...runner.status,network:networkDiagnostics(),build:BUILD,clientView,processId:process.pid,browsers:browsers.list(),browserProxyUrl:config.browserProxyUrl||'',desktopNotifications:config.desktopNotifications===true,browserNetworkCheck,dataDir,endpoint:config.endpoint||''});
 if(url.pathname.startsWith('/api/workspace/')&&req.method==='POST'){
  const input=await body(req),state=await cloud.state(),ready=availability(state);let command;
  if(url.pathname==='/api/workspace/start')command=workspaceStart(state,input,ready);
  else if(url.pathname==='/api/workspace/followup'){
   command=workspaceFollowup(state,input,ready);
   if(input.documentId){const artifact=state.artifacts.find(a=>a.id===input.documentId&&a.taskId===input.taskId);if(!artifact)throw new Error('这份工作稿不属于本次工作');const original=(await cloud.artifact(artifact.id)).body,document=await documents.read(artifact,original);if(document.revision!==input.documentRevision)throw new Error('文稿版本已变化，请保存后再发送');command=attachDocument(command,document);}
  }
  else if(url.pathname==='/api/workspace/execute-plan'){
   const task=state.tasks.find(t=>t.id===input.planTaskId),last=task?.steps.at(-1);
   if(!last?.artifactId)throw new Error('尚未收到完整方案');
   const artifact=await cloud.artifact(last.artifactId);command=workspaceExecute(state,input,artifact.body,ready);
  }else return json(res,{message:'工作台操作不存在'},404);
  const result=await cloud.action(command);runner.tick().catch(()=>{});return json(res,result);
 }
 if(url.pathname==='/api/browser-network'&&req.method==='POST'){
  const {proxyUrl}=await body(req),normalized=normalizeBrowserProxy(proxyUrl);
  if(browsers.active.size||browsers.starting.size||browsers.manual.entries.size||browsers.manual.transitions.size)throw new Error('请先结束 Hub 的专用账号登录，再修改出口；登录资料会保留');
  const next={...config,browserProxyUrl:normalized};await privateJson(path.join(dataDir,'config.json'),next);Object.assign(config,next);
  if(browserNetworkCheck?.proxyUrl!==normalized)browserNetworkCheck=null;
  return json(res,{saved:true,proxyUrl:normalized});
 }
 if(url.pathname==='/api/notifications'&&req.method==='POST'){
  const {enabled}=await body(req);if(typeof enabled!=='boolean')return json(res,{message:'通知开关必须为布尔值'},400);
  const next={...config,desktopNotifications:enabled};await privateJson(path.join(dataDir,'config.json'),next);Object.assign(config,next);
  return json(res,{saved:true,enabled});
 }
 if(url.pathname==='/api/account/surface'&&req.method==='GET'){
  const state=await cloud.state(),account=state.accounts.find(a=>a.id===url.searchParams.get('accountId')&&a.status!=='disabled');
  if(account?.platformId!=='grok-bot'||browsers.isManual(account.id))return json(res,{message:'仅检查已接回工作台的 Grok 窗口'},409);
  const login=await logins.check(account,browsers);if(login.status!=='authenticated')return json(res,{login});
  const page=connections.grok.page(account),surface=await page.evaluate(grokState,connections.records[account.id]?.nonce),safeUrl=new URL(page.url());
  return json(res,{login,url:safeUrl.origin+safeUrl.pathname,...surface});
 }
 if(url.pathname==='/api/account/login-check'&&req.method==='POST'){
  const {accountId}=await body(req),state=await cloud.state(),account=state.accounts.find(a=>a.id===accountId&&a.status!=='disabled');
  if(!account)throw new Error('账号不存在');
  return json(res,await logins.check(account,browsers,{force:true}));
 }
 if(['/api/account/manual-login','/api/account/finish-login'].includes(url.pathname)&&req.method==='POST'){
  const {accountId}=await body(req),state=await cloud.state(),account=state.accounts.find(a=>a.id===accountId&&a.status!=='disabled');
  if(!account)throw new Error('账号不存在');
  if(connections.jobs.has(accountId)||state.tasks.some(t=>t.steps.some(s=>s.accountId===accountId&&s.status==='running')))return json(res,{message:'这个账号正在执行或验证任务，未切换或关闭原浏览器'},409);
  const target=account.entryUrl||maintainedPlatforms(state.platforms).find(p=>p.id===account.platformId)?.entryUrl;
  if(!target)throw new Error('没有可用的官方登录入口');
  if(url.pathname==='/api/account/manual-login'){await connections.enable(account);return json(res,await browsers.openManual(account,{url:target}));}
  if(!browsers.isManual(accountId))throw new Error('此账号不在纯手动登录状态');
  await browsers.manual.close(accountId,{finish:true});
  await browsers.ensureBackground(account,{url:target});await connections.enable(account);
  const login=await logins.check(account,browsers,{force:true});runner.tick().catch(()=>{});
  return json(res,{returned:true,login,message:login.status==='authenticated'?'已确认平台登录，正在恢复任务连接':'登录资料已保存；平台登录与任务接入仍按实际结果核验'});
 }
 if(url.pathname==='/api/account/connect'&&req.method==='POST'){
  const {accountId,renewVerification=false}=await body(req),state=await cloud.state(),account=state.accounts.find(a=>a.id===accountId&&a.status!=='disabled');
  if(!account)throw new Error('账号不存在');if(!['muse','grok-bot'].includes(account.platformId))throw new Error('此平台的自动接入尚未完成适配');
  if(renewVerification){
   if(connections.jobs.has(accountId)||state.tasks.some(t=>t.steps.some(s=>s.accountId===accountId&&s.status==='running')))return json(res,{message:'原操作尚在观察，未另发验证'},409);
   await connections.load();const old=connections.records[accountId],member=state.members.find(m=>m.accountId===accountId&&m.status!=='disabled');
   if(member&&old?.sentAt&&old.status==='needs_review'){
    const next=(await cloud.action({type:'member.challenge',memberId:member.id,payload:{renew:true,previousNonce:old.nonce}})).result;
    await connections.save(accountId,{nonce:next.nonce,sentAt:null,status:'waiting_login',previousVerifications:[...(old.previousVerifications||[]),{nonce:old.nonce,sentAt:old.sentAt,status:old.status,archivedAt:new Date().toISOString()}].slice(-20),message:'上次验证记录保留；按你的明确操作新建一次验证，不重发业务任务。'});
   }
  }
  await connections.enable(account);const record=connections.records[accountId];if(record?.status==='needs_review'&&!record.sentAt)await connections.save(accountId,{status:'waiting_login',message:'重新检查原账号页面；没有已派发任务，不会重复发送。'});await runner.tick();return json(res,{started:true,connection:connections.snapshot()[accountId]});
 }
 if(url.pathname==='/api/local/prepare-update'&&req.method==='POST'){
  const state=await cloud.state();
  const active=await requestJson(config.endpoint+'/v2/active-work',{token:config.adminKey});
  if(active.active)return json(res,{message:'Agent 仍在回应，等待本轮结束后再更新；群消息与登录资料保留'},409);
  if(coding.busy||dsh.busy||runner.jobs.size||connections.jobs.size||browsers.starting.size||state.tasks.some(t=>t.steps.some(s=>s.status==='running')))return json(res,{message:'任务、接入验证或登录窗口正在启动，暂不接管更新'},409);
  await logins.snapshot(state.accounts,browsers);
  await coding.stop();await dsh.stop();await runner.stop({keepBrowsers:true});keepBrowsersOnShutdown=true;
  return json(res,{prepared:true,browsers:browsers.list()});
 }
 if(url.pathname==='/api/local/cancel-update'&&req.method==='POST'){
  keepBrowsersOnShutdown=false;if(runner.stopped){runner.stopped=false;runner.start();}await coding.start();await dsh.start();return json(res,{resumed:true});
 }
 if(url.pathname==='/api/local/restore-sessions'&&req.method==='POST'){
  if(!runner.maintenance)return json(res,{message:'仅在更新验收期间恢复已确认会话'},409);
  await logins.load();const state=await cloud.state(),results={};
  for(const a of state.accounts.filter(a=>['muse','grok-bot'].includes(a.platformId)&&a.status!=='disabled'&&logins.records[a.id]?.status==='authenticated'&&browsers.active.has(a.id))){
   if(browsers.isManual(a.id))continue;
   await browsers.ensureBackground(a,{url:connections.records[a.id]?.conversationUrl||a.entryUrl||maintainedPlatforms(state.platforms).find(p=>p.id===a.platformId)?.entryUrl});
   for(let i=0;i<20;i++){results[a.id]=await logins.check(a,browsers,{force:true});if(['authenticated','login_required','verification_required'].includes(results[a.id].status))break;await new Promise(r=>setTimeout(r,250));}
  }
  return json(res,{loginStatuses:results});
 }
 if(url.pathname==='/api/local/finish-update'&&req.method==='POST'){
  runner.maintenance=false;await coding.start();await dsh.start();await runner.tick();return json(res,{resumed:true});
 }
 if(url.pathname==='/api/browser-network/check'&&req.method==='POST'){
  const p=await body(req);if(networkChecking)return json(res,{message:'出口检查正在进行，请稍候'},409);
  const proxyUrl=normalizeBrowserProxy(p.proxyUrl??config.browserProxyUrl??'');networkChecking=true;
  try{const result=await checkBrowserNetwork(proxyUrl);if(proxyUrl===config.browserProxyUrl)browserNetworkCheck=result;return json(res,result);}finally{networkChecking=false;}
 }
 if(url.pathname==='/api/action'&&req.method==='POST'){const a=await body(req);const allowed=['platform.create','account.create','account.update','account.remove','member.create','member.update','member.disconnect','profile.update','task.create','task.control','step.retry','step.approve','routine.create','routine.toggle','settings.update','note.write'];if(!allowed.includes(a.type))return json(res,{message:'此操作不可由界面调用'},403);if(a.type==='member.update'&&(a.payload?.tokenHash||a.payload?.status))return json(res,{message:'不能手动伪造验证状态'},403);if(a.type==='account.update'&&a.payload?.status==='connected')return json(res,{message:'账号连接需要真实验证'},403);
 if(['task.create','routine.create'].includes(a.type)){const state=await cloud.state(),ready=availability(state);for(const step of(a.type==='task.create'?a.payload?.steps:a.payload?.template?.steps)||[])availableMember(state,step.memberId,ready);}
 const data=await cloud.action(a);if(a.type==='member.disconnect'){await coding.disconnect(a.memberId);await dsh.disconnect(a.memberId);}return json(res,data);}
 if(url.pathname.startsWith('/api/artifacts/')&&req.method==='GET')return json(res,await cloud.artifact(url.pathname.split('/').at(-1)));
 if(url.pathname.startsWith('/api/documents/')&&['GET','POST'].includes(req.method)){
  const state=await cloud.state(),id=url.pathname.split('/').at(-1),artifact=state.artifacts.find(a=>a.id===id);if(!artifact)throw new Error('成果不存在');const original=(await cloud.artifact(id)).body;
  const result=req.method==='GET'?await documents.read(artifact,original):await documents.save(artifact,original,await body(req));return json(res,result);
 }
 if(url.pathname==='/api/account/open'&&req.method==='POST'){const {accountId}=await body(req),state=await cloud.state(),account=state.accounts.find(a=>a.id===accountId&&a.status!=='disabled');if(!account)throw new Error('账号不存在');const platform=maintainedPlatforms(state.platforms).find(p=>p.id===account.platformId),url=account.entryUrl||platform?.entryUrl;if(!url)throw new Error('此平台尚未提供登录入口，请查看平台接入说明');await connections.enable(account);return json(res,await browsers.open(account,{url,visible:true,navigate:false}));}
 if(url.pathname==='/api/account/close'&&req.method==='POST'){
  const {accountId}=await body(req),state=await cloud.state(),account=state.accounts.find(a=>a.id===accountId&&a.status!=='disabled');
  if(!account)throw new Error('账号不存在');
  if(connections.jobs.has(accountId)||state.tasks.some(t=>t.steps.some(s=>s.accountId===accountId&&s.status==='running')))return json(res,{message:'此账号正在执行或验证任务，待结束后再关闭专用浏览器'},409);
  await connections.pauseBrowser(account);return json(res,await browsers.close(accountId));
 }
 if(url.pathname==='/api/account/disconnect'&&req.method==='POST'){await vault.unlock();const {accountId}=await body(req);await browsers.close(accountId);const data=await cloud.action({type:'account.remove',accountId});delete vault.data.accounts[accountId];for(const id of data.result.affectedMembers)delete vault.data.members[id];await vault.save();return json(res,data);}
 if(url.pathname==='/api/member/setup'&&req.method==='POST'){await vault.unlock();const {memberId,rotate=false}=await body(req),state=await cloud.state(),member=state.members.find(m=>m.id===memberId);if(!member)throw new Error('成员不存在');if(member.status==='disabled')throw new Error('成员已断开，请先重新连接账号');let credentials=vault.data.members[memberId]||{};if(!credentials.token||rotate){const c=await cloud.credential(memberId);credentials={...credentials,...c};vault.data.members[memberId]=credentials;await vault.save();}
 const challenge=(await cloud.action({type:'member.challenge',memberId})).result;
 const instruction=challenge.verified?'此成员的真实工具读写已验证，无需重复连接。以后执行任务时，先 list_my_work，再 claim，最后 submit 完整成果。':`请使用我添加的 Agent Hub 连接器完成连接验证：\n1. 调用 hello。\n2. 调用 read_profile，确认能读到共享档案。\n3. 调用 write_note，title 精确填写 ${challenge.title}，body 精确填写 ${challenge.nonce}，mode 为 replace。\n这是连接测试，不执行任何对外操作。以后执行任务时，先 list_my_work，再 claim，最后 submit 完整成果。`;
 return json(res,{verified:!!challenge.verified,mcpUrl:credentials.mcpUrl,tokenUrl:credentials.tokenUrl,token:credentials.token,instruction,toolBaseUrl:config.endpoint+'/tools/',openApiUrl:config.endpoint+'/openapi.json',memberId});}
 if(url.pathname==='/api/member/verify'&&req.method==='POST'){const {memberId}=await body(req),state=await cloud.state(),note=state.notes.find(n=>n.title===`连接验证/${memberId}`&&n.author===memberId);const member=state.members.find(m=>m.id===memberId);if(member?.status==='ready'&&member.evidence)return json(res,{result:member,alreadyVerified:true});if(!note)throw new Error('还没有收到此成员通过原生工具发回的验证笔记。');const result=await cloud.action({type:'member.verify',memberId,payload:{evidenceId:note.id,kind:'native_roundtrip'}});await cloud.action({type:'account.update',accountId:result.result.accountId,payload:{status:'connected'}});return json(res,result);}
 if(url.pathname==='/api/member/settings'&&req.method==='POST'){await vault.unlock();const p=await body(req);const state=await cloud.state(),m=state.members.find(m=>m.id===p.memberId);if(!m)throw new Error('成员不存在');const current=vault.data.members[m.id]||{};
 if(p.triggerUrl)current.triggerUrl=assertHttpUrl(p.triggerUrl);if(p.triggerToken)current.triggerToken=String(p.triggerToken);if(p.clearTrigger){delete current.triggerUrl;delete current.triggerToken;}
 if(p.browser){const platform=state.platforms.find(x=>x.id===m.platformId);if(!platform?.custom||!platform.browserCollection)throw new Error('该平台未开放网页自动采集适配，请使用官方工具回传');p.browser.conversationUrl=assertHttpUrl(p.browser.conversationUrl);current.browser=p.browser;}
 vault.data.members[m.id]=current;await vault.save();return json(res,{saved:true});}
 if(url.pathname==='/api/export'&&req.method==='GET'){const state=await cloud.state(),artifacts=[];for(const a of state.artifacts)artifacts.push({...a,...await cloud.artifact(a.id)});return json(res,{exportedAt:new Date().toISOString(),...state,artifacts,documents:await documents.all()});}
 if(url.pathname==='/api/sync'&&req.method==='POST'){await runner.tick();return json(res,runner.status);}
 return json(res,{message:'接口不存在'},404);}
 const requested=decodeURIComponent(url.pathname);let target=path.resolve(root,'dist','.'+requested);if(!target.startsWith(path.join(root,'dist')+path.sep)&&target!==path.join(root,'dist'))return json(res,{message:'路径无效'},400);let data;try{data=await fs.readFile(target);}catch{target=path.join(root,'dist/index.html');data=await fs.readFile(target);}
 const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'}[path.extname(target)]||'application/octet-stream';
 res.writeHead(200,{'Content-Type':mime,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; frame-ancestors 'none'",'Cache-Control':'no-cache'});res.end(data);
 }catch(e){if(res.headersSent||res.destroyed||req.aborted){res.destroy();return;}json(res,{message:e.message||'操作失败',...(e.code?{error:e.code}:{}),...(e.uncertain?{uncertain:true}:{})},e.status||400);}});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port??config.port??8766,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;runner.start();if(!maintenance){await coding.start();await dsh.start();}
 return{url:origin,server,runner,browsers,coding,dsh,setClientView(value){clientView={...clientView,...value};},async close(){await coding.stop();await dsh.stop();await runner.stop({keepBrowsers:keepBrowsersOnShutdown});await new Promise(r=>{server.close(r);server.closeAllConnections();});}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const instance=await start();console.log('Agent Hub 本地工作台：'+instance.url);for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>instance.close().finally(()=>process.exit(0)));}
