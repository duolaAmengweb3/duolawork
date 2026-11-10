import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {openDatabase} from '../server/sqlite.mjs';
import {Repository,digest} from '../cloud/collaboration/repository.mjs';
import {CodingMemberClient} from '../local/coding-client.mjs';

// Isolated real Node HTTP server + FULL-synchronous SQLite. No user account,
// provider credential, native app or model is involved in protocol samples.
export async function startNodeHarness(){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-transport-'));
 const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
 const key=crypto.randomUUID(),workspaceId='isolated-transport',database=path.join(directory,'data.sqlite'),configPath=path.join(directory,'server.json');
 await fs.writeFile(configPath,JSON.stringify({adminKey:key,workspaceId,database,port,enableScheduled:false,publicOrigin:'https://transport.example.test'}),{mode:0o600});
 let child,db;const base=`http://127.0.0.1:${port}`;
 async function start(){
  child=spawn(process.execPath,['release/server/main.mjs'],{env:{...process.env,HUB_SERVER_CONFIG:configPath},stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',b=>error+=b);
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error(error);}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('isolated server start timeout')),10000);t.unref();})]);
 }
 async function stopServer(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
 async function request(route,body,token=key){const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const d=await r.json();if(!r.ok)throw Object.assign(Error(JSON.stringify(d)),{status:r.status});return d;}
 const command=(type,args={})=>request('/v2/commands',{type,requestId:crypto.randomUUID(),...args}).then(r=>r.result);
 await start();db=openDatabase(database);const repo=new Repository(db,workspaceId);
 async function member(name='Protocol fixture'){
  const account=(await request('/admin/action',{type:'account.create',payload:{platformId:'muse',label:name}})).result;
  const m=(await request('/admin/action',{type:'member.create',payload:{accountId:account.id,name,mode:'connector'}})).result;
  const {token}=await request('/admin/member-credential',{memberId:m.id});
  await repo.transact(crypto.randomUUID(),{},tx=>tx.put('connection',{id:m.id,status:'verified',transport:'muse-poll',resourceKey:account.id,capabilities:['research','writing','files'],configVersion:1}));
  const file=path.join(directory,m.id+'.json');await fs.writeFile(file,JSON.stringify({memberId:m.id,endpoint:base,access_token:token}),{mode:0o600});
  const client=new CodingMemberClient(file);
  return{...m,client,token,bind:async(channelId,sessionId)=>repo.transact(crypto.randomUUID(),{},async tx=>tx.put('execution_binding',{id:m.id+':'+channelId,parentId:m.id,scopeId:channelId,sessionKey:await digest(sessionId),status:'active'}))};
 }
 return{directory,base,key,repo,request,command,member,restart:async()=>{await stopServer();await start();},stop:async()=>{await stopServer();db.close();await fs.rm(directory,{recursive:true,force:true});}};
}
