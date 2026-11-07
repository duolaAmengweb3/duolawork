import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
test('receiver killed after fsync and before ACK restarts from same durable envelope without duplicate native execution',{timeout:15000},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-crash-'));let child;
 try{
  await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({controlToken:crypto.randomUUID(),bindings:[]}),{mode:0o600});await fs.writeFile(path.join(dir,'grant.json'),'{}',{mode:0o600});
  const start=mode=>fork(new URL('./fixtures/receiver-crash.mjs',import.meta.url),[dir,mode],{stdio:['ignore','ignore','pipe','ipc']});
  child=start('crash');assert.equal((await once(child,'message'))[0].durable,true);const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  assert.equal(await fs.readFile(path.join(dir,'acks.jsonl'),'utf8').catch(e=>e.code==='ENOENT'?'':Promise.reject(e)),'');
  assert.equal(await fs.readFile(path.join(dir,'prompts'),'utf8').catch(e=>e.code==='ENOENT'?'':Promise.reject(e)),'');
  const disk=JSON.parse(await fs.readFile(path.join(dir,'state.json')));assert.equal(disk.bindings[0].received['crash-work'].message.body,'keep the exact full requirement');
  child=start('recover');const done=once(child,'exit');assert.equal((await once(child,'message'))[0].done,true);await done;
  assert.deepEqual((await fs.readFile(path.join(dir,'acks.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s).phase),['received','accepted']);
  child=start('recover');const again=once(child,'exit');await once(child,'message');await again;assert.equal(await fs.readFile(path.join(dir,'prompts'),'utf8'),'one\n');
 }finally{if(child&&child.exitCode===null)child.kill();await fs.rm(dir,{recursive:true,force:true});}
});
