import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'connector-update-'));process.env.AGENT_HUB_DATA_DIR=directory;
const {startNodeHarness}=await import('./node-server-harness.mjs'),{McpHostManager}=await import('../local/mcp-host-manager.mjs'),{start}=await import('../local/server.mjs');
const h=await startNodeHarness(),config={endpoint:h.base,adminKey:h.key,runnerId:'host-update'},manager=new McpHostManager(config,directory);let local;
try{
 const member=await h.member('isolated shared tool consumer'),channel=await h.command('channel.create',{name:'isolated update',memberIds:[member.id],coordinatorId:member.id});
 const {hostId}=await manager.connect(),file=path.join(directory,'shared-tool-host.json'),original=await fs.readFile(file);await manager.stop();
 const host=await h.repo.get('service_host',hostId);await h.repo.transact(crypto.randomUUID(),{},tx=>tx.put('service_host',{...host,lastSeen:'2020-01-01T00:00:00Z'}));
 local=await start({port:0,maintenance:true,vaultKey:Buffer.alloc(32,41),config});
 assert.equal((await h.request('/v2/connectors?action=hosts')).items[0].online,false,'maintenance does not prematurely start shared tools');
 const resume=await fetch(local.url+'/api/local/finish-update',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(resume.status,200);
 assert.equal((await h.request('/v2/connectors?action=hosts')).items[0].online,true,'finish-update restores the saved tool host automatically');
 const c=(await h.request('/v2/connectors',{action:'save',requestId:crypto.randomUUID(),name:'update fixture',provider:'custom',transport:'stdio',hostId,command:process.execPath,args:[new URL('./fixtures/mcp-stdio.mjs',import.meta.url).pathname],authType:'none'})).connection;assert.equal(c.health,'ready');
 const result=await member.client.tool('connector',{action:'call',channelId:channel.id,connectionId:c.id,tool:'write',arguments:{text:'continued after update'},requestId:crypto.randomUUID()});assert.equal(result.status,'succeeded');assert.equal(result.result.content[0].text,'continued after update');
 await fetch(local.url+'/api/local/finish-update',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal((await h.request('/v2/connectors?action=hosts')).items.length,1);assert.deepEqual(await fs.readFile(file),original);
 await local.close();local=null;local=await start({port:0,maintenance:false,vaultKey:Buffer.alloc(32,41),config});assert.equal((await h.request('/v2/connectors?action=hosts')).items[0].online,true);
 console.log(JSON.stringify({scope:'isolated real HTTP, SQLite and stdio, no native account',checks:['update restores existing host automatically','shared tool call succeeds after update','repeat finish does not create or rotate hosts','ordinary restart reconnects with unchanged host credentials']}));
}finally{await local?.close();await manager.stop();await h.stop();await fs.rm(directory,{recursive:true,force:true});}
