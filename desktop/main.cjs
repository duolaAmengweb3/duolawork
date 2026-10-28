const {app,BrowserWindow,Notification,Menu,shell,safeStorage,session}=require('electron');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {randomBytes}=require('node:crypto');const {pathToFileURL}=require('node:url');
let runtime,win,quitting=false;
if(process.env.AGENT_HUB_DATA_DIR)app.setPath('userData',path.join(path.resolve(process.env.AGENT_HUB_DATA_DIR),'desktop'));
// Electron's documented test-only keychain backend. Never enable it for real app data.
if(process.env.AGENT_HUB_TEST_MODE==='1'){
 const testRoot=process.env.AGENT_HUB_DATA_DIR&&path.resolve(process.env.AGENT_HUB_DATA_DIR);
 if(!testRoot||!testRoot.startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error('桌面测试必须使用临时独立资料目录，不能访问正式连接。');
 app.commandLine.appendSwitch('use-mock-keychain');
}
if(!app.requestSingleInstanceLock()){app.quit();}else{
app.setName('Agent Hub');app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
app.whenReady().then(async()=>{
 const dir=process.env.AGENT_HUB_DATA_DIR||path.join(os.homedir(),'.config','agent-hub');await fs.mkdir(dir,{recursive:true,mode:0o700});
 let keyPromise;
 const resolveVaultKey=()=>keyPromise??=(async()=>{
  if(!safeStorage.isEncryptionAvailable())throw new Error('macOS 安全存储尚不可用，未重置连接资料。');
  const wrapped=path.join(dir,'vault-key.oscrypt');let vaultKey;
  try{vaultKey=Buffer.from(safeStorage.decryptString(await fs.readFile(wrapped)),'base64');}
  catch(e){if(e.code!=='ENOENT')throw new Error('系统钥匙串无法解锁现有密钥，没有重置登录资料。');try{vaultKey=await fs.readFile(path.join(dir,'vault.key'));}catch(missing){if(missing.code!=='ENOENT')throw missing;vaultKey=randomBytes(32);}await fs.writeFile(wrapped,safeStorage.encryptString(vaultKey.toString('base64')),{mode:0o600});}
  if(vaultKey.length!==32)throw new Error('现有密钥格式无效，未重置登录资料。');return vaultKey;
 })();
 const {start}=await import(pathToFileURL(path.join(__dirname,'../local/server.mjs')).href);runtime=await start({resolveVaultKey,maintenance:process.env.AGENT_HUB_ACTIVATING==='1',notify:(title,body)=>{if(Notification.isSupported())new Notification({title,body}).show();}});
 // This window contains only the local workbench; provider logins live in persistent full Chrome profiles.
 const uiSession=session.fromPartition('persist:agent-hub-workbench');uiSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 win=new BrowserWindow({width:1450,height:980,minWidth:850,minHeight:650,show:process.env.AGENT_HUB_TEST_MODE!=='1',title:'Agent Hub · 你的 AI 团队',backgroundColor:'#f6f6f3',webPreferences:{session:uiSession,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
 win.webContents.setWindowOpenHandler(({url})=>{if(/^https:\/\//.test(url))shell.openExternal(url);return{action:'deny'};});
 win.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==runtime.url){event.preventDefault();if(/^https:\/\//.test(url))shell.openExternal(url);}});
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Agent Hub',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'quit'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'视图',submenu:[{role:'reload'},{role:'togglefullscreen'},{role:'resetzoom'},{role:'zoomin'},{role:'zoomout'}]},{role:'windowMenu'}]));
 runtime.setClientView({kind:'desktop',ready:false});
 await win.loadURL(runtime.url);
 const renderedBuild=await win.webContents.executeJavaScript(`new Promise(resolve=>{const end=Date.now()+5000;const check=()=>{const value=document.querySelector('[data-build-id]')?.getAttribute('data-build-id');if(value||Date.now()>end)resolve(value||null);else setTimeout(check,50);};check();})`);
 runtime.setClientView({kind:'desktop',ready:!!renderedBuild,buildId:renderedBuild});
 if(process.env.AGENT_HUB_LAUNCH_EVIDENCE){const file=path.resolve(process.env.AGENT_HUB_LAUNCH_EVIDENCE);const snapshot=await win.webContents.capturePage();await fs.writeFile(file,snapshot.toPNG(),{mode:0o600});}

}).catch(error=>{if(process.env.AGENT_HUB_TEST_MODE==='1')console.error('Agent Hub test startup failed:',error.message);else require('electron').dialog.showErrorBox('Agent Hub 启动失败',error.message);app.quit();});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>app.quit());
app.on('window-all-closed',()=>app.quit());app.on('before-quit',event=>{if(runtime&&!quitting){event.preventDefault();quitting=true;runtime.close().finally(()=>app.quit());}});
}
