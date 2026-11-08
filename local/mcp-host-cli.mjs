import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {McpToolHost} from './mcp-tool-host.mjs';
import {requestJson} from './transport.mjs';
const file=path.join(os.homedir(),'.config/duolawork-tool-host/config.json');
const xml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
async function installService(entry,logPath){
 if(process.platform==='linux'){
  const root=process.getuid?.()===0,dir=root?'/etc/systemd/system':path.join(os.homedir(),'.config/systemd/user');await fs.mkdir(dir,{recursive:true});
  const unit='duolawork-tool-host.service',prefix=root?[]:['--user'];
  const quoted=v=>'"'+v.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')+'"';
  await fs.writeFile(path.join(dir,unit),'[Unit]\nDescription=DuolaWork shared tool host\nAfter=network-online.target\n[Service]\nExecStart='+[process.execPath,entry,'run'].map(quoted).join(' ')+'\nEnvironment='+quoted('PATH='+path.dirname(process.execPath)+':'+(process.env.PATH||'/usr/bin:/bin'))+'\nRestart=on-failure\nRestartSec=5\n[Install]\nWantedBy='+(root?'multi-user.target':'default.target')+'\n');
  execFileSync('systemctl',[...prefix,'daemon-reload'],{stdio:'ignore'});execFileSync('systemctl',[...prefix,'enable','--now',unit],{stdio:'ignore'});execFileSync('systemctl',[...prefix,'restart',unit],{stdio:'ignore'});return true;
 }
 if(process.platform==='darwin'){
  const dir=path.join(os.homedir(),'Library/LaunchAgents'),label='com.duolawork.toolhost',plist=path.join(dir,label+'.plist');await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(plist,'<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>'+label+'</string><key>ProgramArguments</key><array>'+[process.execPath,entry,'run'].map(s=>'<string>'+xml(s)+'</string>').join('')+'</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>'+xml(path.dirname(process.execPath)+':'+(process.env.PATH||'/usr/bin:/bin'))+'</string></dict><key>StandardOutPath</key><string>'+xml(logPath)+'</string><key>StandardErrorPath</key><string>'+xml(logPath)+'</string></dict></plist>');
  try{execFileSync('launchctl',['bootout','gui/'+process.getuid(),plist],{stdio:'ignore'});}catch{}
  execFileSync('launchctl',['bootstrap','gui/'+process.getuid(),plist],{stdio:'ignore'});return true;
 }
 return false;
}
async function main(){
 if(process.argv[2]==='setup'){
  let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>10000)throw Error('接入参数过长');}
  const args=JSON.parse(input);let previous;try{previous=JSON.parse(await fs.readFile(file,'utf8'));}catch{}
  const key=previous?.hostId===args.hostId&&previous?.endpoint===args.endpoint?previous.token:'hostkey_'+crypto.randomUUID()+crypto.randomUUID();
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,JSON.stringify({endpoint:args.endpoint,hostId:args.hostId,token:key}),{mode:0o600});await fs.chmod(file,0o600);
  const paired=await requestJson(args.endpoint+'/v2/connectors/host',{method:'POST',body:{action:'pair',hostId:args.hostId,code:args.code,key,environment:{hostname:os.hostname(),platform:process.platform}}});
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  await fs.writeFile(file,JSON.stringify({endpoint:args.endpoint,...paired}),{mode:0o600});await fs.chmod(file,0o600);
  const dir=path.join(os.homedir(),'.local/share/duolawork-tool-host'),entry=path.join(dir,'host.cjs'),logPath=path.join(path.dirname(file),'host.log');await fs.mkdir(dir,{recursive:true});if(path.resolve(process.argv[1])!==entry)await fs.copyFile(process.argv[1],entry);
  const log=await fs.open(logPath,'a',0o600);let managed=false;try{managed=await installService(entry,logPath);}catch{}
  if(!managed){const child=spawn(process.execPath,[entry,'run'],{detached:true,stdio:['ignore',log.fd,log.fd]});child.unref();}await log.close();
  console.log(managed?'共享工具运行端已连接，后台运行与自动启动已设置。':'共享工具运行端已连接并在后台启动；本环境未能设置自动启动，重启机器后需运行已安装的 host.cjs run。');return;
 }
 if(process.argv[2]!=='run')throw Error('使用 setup 从标准输入接收接入参数，或 run 启动已有运行端');
 const host=new McpToolHost(JSON.parse(await fs.readFile(file,'utf8')));process.on('SIGTERM',()=>host.stop());process.on('SIGINT',()=>host.stop());await host.start();
}
main().catch(()=>{console.error('工具运行端未启动，请检查接入参数、网络及运行依赖。');process.exitCode=1;});
