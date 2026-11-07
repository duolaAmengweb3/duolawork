// Runs only an ephemeral server/database. Production config/database are never read.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import readline from 'node:readline';
const serverDir=process.argv[2];
const {Repository,digest}=await import(serverDir+'/memory-runtime/repository.mjs');
const {openDatabase}=await import(serverDir+'/sqlite.mjs');
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-wan-fixture-')),database=path.join(directory,'data.sqlite'),key=crypto.randomUUID(),workspaceId='isolated-wan';
const socket=net.createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
const config=path.join(directory,'server.json');await fs.writeFile(config,JSON.stringify({database,port,adminKey:key,workspaceId,publicOrigin:'https://isolated-wan.example.test',enableScheduled:false}),{mode:0o600});
let child,db;
async function start(){child=spawn(process.execPath,['--max-old-space-size=180',serverDir+'/main.mjs'],{env:{...process.env,HUB_SERVER_CONFIG:config},stdio:['ignore','pipe','pipe']});await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('fixture start failed');})]);}
async function halt(){if(child?.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
await start();db=openDatabase(database);const repo=new Repository(db,workspaceId);
process.stdout.write(JSON.stringify({port,key})+'\n');
try{for await(const line of readline.createInterface({input:process.stdin})){
 const {id,op,args}=JSON.parse(line);let result;
 try{
  if(op==='seed'){await repo.transact(crypto.randomUUID(),{},tx=>tx.put('connection',{id:args.memberId,status:'verified',transport:'muse-poll',resourceKey:args.accountId,capabilities:['research','writing','files'],configVersion:1}));result=true;}
  else if(op==='bind'){await repo.transact(crypto.randomUUID(),{},async tx=>tx.put('execution_binding',{id:args.memberId+':'+args.channelId,parentId:args.memberId,scopeId:args.channelId,sessionKey:await digest(args.sessionId),status:'active'}));result=true;}
  else if(op==='get')result=await repo.get(args.kind,args.id);
  else if(op==='restart'){await halt();await start();result=true;}
  else if(op==='stop'){process.stdout.write(JSON.stringify({id,result:true})+'\n');break;}
  else throw Error('unknown fixture operation');
  process.stdout.write(JSON.stringify({id,result})+'\n');
 }catch(e){process.stdout.write(JSON.stringify({id,error:e.message})+'\n');}
}}finally{await halt();db.close();await fs.rm(directory,{recursive:true,force:true});}
