// Stable service launcher. Program updates wait for the receiver's active work
// to finish, then restart it with the same data directory and native login.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const base=path.dirname(fileURLToPath(import.meta.url));
let child,closing=false,restarting=false,program;
const load=()=>fs.readFile(path.join(base,'program.json'),'utf8').then(JSON.parse);
const stop=()=>{closing=true;clearInterval(timer);child?.kill('SIGTERM');};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
const timer=setInterval(async()=>{if(closing||restarting||!child)return;try{const next=await load();if(next.entry!==program.entry||next.revision!==program.revision){restarting=true;child.kill('SIGTERM');}}catch{}},5000);
try{
 while(!closing){
  program=await load();restarting=false;
  child=spawn(program.node,[program.entry,'run',program.alias],{stdio:'inherit',env:process.env});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});child=null;
  if(!restarting&&!closing){process.exitCode=code||1;break;}
 }
}finally{clearInterval(timer);}
