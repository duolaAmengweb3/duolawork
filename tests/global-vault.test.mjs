import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand} from '../cloud/collaboration/conversation.mjs';
import {vaultSettings,vaultTool,redeemVaultLease,resolveVaultConfig,assertVaultUses} from '../cloud/collaboration/vault.mjs';
import {unsealVault} from '../cloud/collaboration/vault-crypto.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';
import {runWithCredentials} from '../local/credential-client.mjs';
import {loadVaultKey} from '../server/vault-key.mjs';
import {mcpConnectorSettings,mcpConnectorTool} from '../cloud/collaboration/mcp-connectors.mjs';
import {connectorHostRequest} from '../cloud/collaboration/connector-hosts.mjs';
import {McpToolHost} from '../local/mcp-tool-host.mjs';
const owner={owner:true},a={memberId:'grok'},b={memberId:'check'},secret='fixture-vault-secret-9472-not-a-real-credential';
async function setup(t){
 const f=await fixture(t),env={VAULT_ENCRYPTION_KEY:Buffer.alloc(32,73).toString('base64'),ADMIN_KEY:'isolated-vault-admin'};let seq=0;
 const requestId=()=>`vault-test-${++seq}`,command=(type,args)=>conversationCommand(f.repo,f.identity,owner,{type,requestId:requestId(),...args});
 const channel=await command('channel.create',{name:'Vault test',memberIds:['grok','check']});
 const settings=args=>vaultSettings(f.repo,f.identity,owner,{requestId:requestId(),...args},env),tool=(args,actor=a)=>vaultTool(f.repo,f.identity,actor,{channelId:channel.id,...args},env);
 const item=await settings({action:'save',name:'API test',type:'api_key',fields:{token:secret},allowedOrigins:['https://api.example.test']});
 const dump=async()=>JSON.stringify([(await f.db.prepare('SELECT body FROM hub_v2_records').all()).results,(await f.db.prepare('SELECT result FROM hub_v2_receipts').all()).results]);
 return {...f,env,requestId,command,channel,settings,tool,item,dump};
}

test('Vault encrypts values, defaults to current/future members and groups, and rejects workspace/identity/context tampering',async t=>{
 const f=await setup(t);assert.equal((await f.tool({action:'list'})).items.length,1);assert.equal((await f.tool({action:'list'},b)).items.length,1);
 const group=await f.command('channel.create',{name:'created later',memberIds:['grok','check']});assert.equal((await f.tool({action:'list',channelId:group.id},b)).items.length,1);
 const read=await f.settings({action:'reveal',credentialId:f.item.id});assert.equal(read.fields.token,secret);assert.ok(!(await f.dump()).includes(secret));
 const row=await f.repo.get('vault_entry',f.item.id);
 for(const ctx of [{workspace:'another',id:row.id,version:row.version},{workspace:'test',id:'wrong',version:row.version},{workspace:'test',id:row.id,version:row.version+1}])await assert.rejects(()=>unsealVault(row.sealed,f.env,ctx),e=>e.code==='vault_locked');
 await assert.rejects(()=>f.tool({action:'info',credentialId:row.id},{memberId:'write'}),e=>e.status===403);
 await assert.rejects(()=>vaultSettings(f.repo,f.identity,a,{action:'reveal',credentialId:row.id},f.env),e=>e.status===403);
});

test('one-time native grants enforce member, expiry, scopes and rotation; ledger never retains resolved values',async t=>{
 const f=await setup(t),refs={TEST_API_TOKEN:f.item.fields[0].reference};
 const prepare=()=>f.tool({action:'prepare',requestId:f.requestId(),references:refs});const first=await prepare();
 await assert.rejects(()=>redeemVaultLease(f.repo,b,{leaseId:first.leaseId},f.env),e=>e.code==='vault_lease_expired');
 assert.equal((await redeemVaultLease(f.repo,a,{leaseId:first.leaseId},f.env)).environment.TEST_API_TOKEN,secret);
 await assert.rejects(()=>redeemVaultLease(f.repo,a,{leaseId:first.leaseId},f.env),e=>e.code==='vault_lease_expired');
 const second=await prepare();const changed=await f.settings({action:'save',credentialId:f.item.id,expectedVersion:f.item.version,fields:{token:'rotated-fixture-value'}});
 await assert.rejects(()=>redeemVaultLease(f.repo,a,{leaseId:second.leaseId},f.env),e=>e.code==='vault_changed');
 const third=await prepare();await f.repo.transact(f.requestId(),{},async tx=>{const lease=await tx.get('vault_lease',third.leaseId);tx.put('vault_lease',{...lease,expiresAt:new Date(0).toISOString()});return {};});await assert.rejects(()=>redeemVaultLease(f.repo,a,{leaseId:third.leaseId},f.env),e=>e.code==='vault_lease_expired');
 await f.settings({action:'access',credentialId:changed.id,expectedVersion:changed.version,blockedMemberIds:['grok']});await assert.rejects(prepare,e=>e.code==='vault_forbidden');
 assert.ok(!(await f.dump()).includes(secret));assert.ok(!(await f.dump()).includes('rotated-fixture-value'));
});

test('status changes revoke immediately, restore preserves values, and a secretary cannot undo a user exclusion',async t=>{
 const f=await setup(t);let e=f.item;
 await f.repo.transact(f.requestId(),{},tx=>tx.put('workspace_secretary',{id:'current',memberId:'grok',status:'active'}));
 e=await f.settings({action:'access',credentialId:e.id,expectedVersion:e.version,blockedChannelIds:[f.channel.id]});await assert.rejects(()=>f.tool({action:'info',credentialId:e.id}),e=>e.code==='vault_forbidden');
 await assert.rejects(()=>f.tool({action:'manage',operation:'save',credentialId:e.id,expectedVersion:e.version,blockedChannelIds:[]}),e=>e.code==='owner_required');
 e=await f.settings({action:'disable',credentialId:e.id,expectedVersion:e.version});assert.equal((await f.settings({action:'reveal',credentialId:e.id})).fields.token,secret);
 e=await f.settings({action:'delete',credentialId:e.id,expectedVersion:e.version});assert.equal((await f.settings({action:'list',deleted:true})).items.length,1);await assert.rejects(()=>f.tool({action:'info',credentialId:e.id}),e=>e.code==='vault_unavailable');
 e=await f.settings({action:'restore',credentialId:e.id,expectedVersion:e.version});assert.equal((await f.settings({action:'reveal',credentialId:e.id})).fields.token,secret);
 e=await f.settings({action:'delete',credentialId:e.id,expectedVersion:e.version});await f.settings({action:'purge',credentialId:e.id,expectedVersion:e.version,confirm:true});assert.equal((await f.settings({action:'list'})).items.length,0);assert.ok(!(await f.dump()).includes(secret));
});

test('broker injects only at the allowed origin, conceals echoed secrets, fences revocation and never repeats a write',async t=>{
 const f=await setup(t);let calls=0,fail=false,onCall=async()=>{};
 f.env.CONNECTOR_FETCH=async(url,init)=>{assert.equal(new URL(url).origin,'https://api.example.test');assert.equal(init.headers.authorization||init.headers.Authorization,'Bearer '+secret);calls++;await onCall();if(fail)throw Error('after side effect');return Response.json({authorization:'Bearer '+secret,nested:[encodeURIComponent(secret),Buffer.from(secret).toString('base64')],ok:true});};
 const args={action:'request',credentialId:f.item.id,url:'https://api.example.test/test',method:'POST',requestId:f.requestId(),body:{test:true}};
 const results=await Promise.all([f.tool(args),f.tool(args)]);assert.equal(calls,1);const done=await f.tool({action:'result',invocationId:results[0].invocationId});assert.equal(done.status,'succeeded');assert.ok(!JSON.stringify(done).includes(secret));
 await assert.rejects(()=>f.tool({...args,requestId:f.requestId(),url:'https://evil.example.test'}),e=>e.code==='vault_destination');
 await assert.rejects(()=>f.tool({...args,requestId:f.requestId(),url:'https://127.0.0.1/private'}));
 fail=true;const lost={...args,requestId:f.requestId()};assert.equal((await f.tool(lost)).status,'unknown');assert.equal((await f.tool(lost)).status,'unknown');assert.equal(calls,2);
 fail=false;onCall=async()=>{await f.settings({action:'access',credentialId:f.item.id,expectedVersion:1,blockedMemberIds:['grok']});};const blocked=await f.tool({...args,requestId:f.requestId()});assert.equal(blocked.status,'unknown');assert.equal(blocked.result,undefined);assert.ok(!(await f.dump()).includes(secret));
});

test('native child gets the secret without persisting values, duplicate commands do not rerun and global env stays unchanged',async t=>{
 const f=await setup(t),directory=await fs.mkdtemp(path.join(os.tmpdir(),'dw-vault-native-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const client={file:path.join(directory,'grant.json'),api:(route,{body})=>route==='/v2/tools/vault'?f.tool(body):redeemVaultLease(f.repo,a,body,f.env)};
 const args={requestId:'real-child',channelId:f.channel.id,command:process.execPath,args:['-e','process.stdout.write(process.env.DW_TEST_TOKEN)'],env:{DW_TEST_TOKEN:f.item.fields[0].reference},cwd:directory};
 const old=process.env.DW_TEST_TOKEN,result=await runWithCredentials(client,args);assert.equal(result.status,'succeeded');assert.equal(result.stdout,'[已隐藏]');assert.equal(process.env.DW_TEST_TOKEN,old);
 let called=false;assert.deepEqual(await runWithCredentials(client,args,{execute:async()=>{called=true;}}),result);assert.equal(called,false);
 for(const file of await fs.readdir(path.join(directory,'vault-executions')))assert.ok(!(await fs.readFile(path.join(directory,'vault-executions',file),'utf8')).includes(secret));
 await assert.rejects(()=>runWithCredentials(client,{...args,command:'different'}),/同一个请求/);
});

test('backup is password encrypted, rejects wrong passwords atomically and imports idempotently without overwriting',async t=>{
 const f=await setup(t),password='fixture backup password 2026';const backup=await f.settings({action:'export',password});assert.ok(!JSON.stringify(backup).includes(secret));
 const count=(await f.settings({action:'list'})).items.length;await assert.rejects(()=>f.settings({action:'import',bundle:backup.bundle,password:'wrong-but-long-enough'}),e=>e.code==='invalid_backup');assert.equal((await f.settings({action:'list'})).items.length,count);
 const args={action:'import',requestId:f.requestId(),bundle:backup.bundle,password};const imported=await f.settings(args),again=await f.settings(args);assert.deepEqual(imported,again);assert.notEqual(imported.items[0].id,f.item.id);assert.equal((await f.settings({action:'reveal',credentialId:imported.items[0].id})).fields.token,secret);assert.equal((await f.settings({action:'list'})).items.length,count+1);assert.ok(!(await f.dump()).includes(secret));
});

test('native retry journals are isolated per member even when grant files share a directory',async t=>{
 const f=await setup(t),directory=await fs.mkdtemp(path.join(os.tmpdir(),'dw-vault-journals-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));let count=0;
 const client=(member,file)=>({file:path.join(directory,file),api:(route,{body})=>route==='/v2/tools/vault'?f.tool(body,member):redeemVaultLease(f.repo,member,body,f.env)});
 const args={requestId:'same-user-supplied-id',channelId:f.channel.id,command:process.execPath,env:{DW_TOKEN:f.item.fields[0].reference},cwd:directory};
 for(const c of[client(a,'a.json'),client(b,'b.json')])assert.equal((await runWithCredentials(c,args,{execute:async()=>{count++;return {stdout:secret};}})).stdout,'[已隐藏]');
 assert.equal(count,2);
});

test('a lost HTTP process becomes outcome unknown rather than staying running or retrying',async t=>{
 const f=await setup(t),invocationId='vaultcall_lost';await f.repo.transact(f.requestId(),{},tx=>tx.put('vault_invocation',{id:invocationId,memberId:a.memberId,scopeId:f.channel.id,credentialId:f.item.id,credentialVersion:1,status:'running',createdAt:new Date(0).toISOString()}));
 f.env.CONNECTOR_FETCH=()=>{throw Error('must not retry');};const r=await f.tool({action:'result',invocationId});assert.equal(r.status,'unknown');assert.match(r.message,/未自动重复/);assert.equal((await f.tool({action:'result',invocationId})).status,'unknown');
});

test('rotation preserves a completed redacted HTTP result without repeating the write; revocation still hides it',async t=>{
 const f=await setup(t);let count=0;f.env.CONNECTOR_FETCH=async()=>{count++;return Response.json({id:'written-object',echo:secret});};
 const args={action:'request',credentialId:f.item.id,url:'https://api.example.test/write',method:'POST',requestId:f.requestId()};const result=await f.tool(args);
 const e=await f.settings({action:'save',credentialId:f.item.id,expectedVersion:1,fields:{token:'rotated-after-write'}});
 assert.equal((await f.tool({action:'result',invocationId:result.invocationId})).result.body.id,'written-object');assert.equal((await f.tool(args)).result.body.echo,'[已隐藏]');assert.equal(count,1);
 await f.settings({action:'access',credentialId:e.id,expectedVersion:e.version,blockedMemberIds:['grok']});await assert.rejects(()=>f.tool({action:'result',invocationId:result.invocationId}),e=>e.code==='vault_forbidden');
});

test('independent server key survives reboot, recovers its own copy and refuses missing/corrupt material over existing records',async t=>{
 const f=await setup(t),directory=await fs.mkdtemp(path.join(os.tmpdir(),'dw-vault-key-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const empty=await fixture(t),config={database:path.join(directory,'test.sqlite')};const one=await loadVaultKey(empty.db,config),two=await loadVaultKey(empty.db,config);assert.equal(one.key,two.key);assert.notEqual(one.key,f.env.ADMIN_KEY);
 const keyfile=path.join(directory,'.vault-keys/master.key');assert.equal((await fs.stat(keyfile)).mode&0o777,0o600);await fs.unlink(keyfile);assert.equal((await loadVaultKey(empty.db,config)).key,one.key);
 await fs.writeFile(keyfile,'broken');assert.equal((await loadVaultKey(empty.db,config)).state,'locked');assert.equal(await fs.readFile(keyfile,'utf8'),'broken');
 const missing={database:path.join(directory,'new-place/data.sqlite')};assert.equal((await loadVaultKey(f.db,missing)).state,'locked');
});

test('cached MCP bridge uses the same scoped Vault and cannot retrieve raw values',async t=>{
 const f=await setup(t);const r=await callTool(f.repo,f.identity,a,'post_message',{requestId:f.requestId(),channelId:f.channel.id,body:'HUB_SHARED_TOOL_V1\n'+JSON.stringify({name:'vault',arguments:{action:'info',channelId:f.channel.id,credentialId:f.item.id}})},f.env);assert.equal(r.item.id,f.item.id);assert.ok(!JSON.stringify(r).includes(secret));
});

test('MCP remote headers resolve one shared reference, rotate for the next call and never expose the secret',async t=>{
 const f=await setup(t);let expected=secret,calls=0;
 f.env.CONNECTOR_ORIGIN='https://hub.example.test';f.env.CONNECTOR_FETCH=async(url,init={})=>{
  if(init.method==='GET')return new Response(null,{status:405});const m=JSON.parse(init.body||'{}');if(m.id===undefined)return new Response(null,{status:202});
  assert.equal(new Headers(init.headers).get('Authorization'),'Bearer '+expected);
  const result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'vault MCP fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'probe',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:expected}]};if(m.method==='tools/call')calls++;
  return Response.json({jsonrpc:'2.0',id:m.id,result});
 };
 const c=(await mcpConnectorSettings(f.repo,f.identity,owner,{action:'save',requestId:f.requestId(),name:'Vault remote',transport:'http',url:'https://api.example.test/mcp',authType:'headers',headers:{'X-Keep':'preserved'},vaultBindings:[{target:'headers',name:'Authorization',value:'Bearer '+f.item.fields[0].reference}]},f.env)).connection;
 for(const actor of[a,b]){const r=await mcpConnectorTool(f.repo,actor,{action:'call',channelId:f.channel.id,connectionId:c.id,tool:'probe',requestId:f.requestId()},f.env);assert.equal(r.status,'succeeded');assert.equal(r.result.content[0].text,'[已隐藏]');}
 expected='another-rotated-fixture-secret';const changed=await f.settings({action:'save',credentialId:f.item.id,expectedVersion:1,fields:{token:expected}});
 const r=await mcpConnectorTool(f.repo,a,{action:'call',channelId:f.channel.id,connectionId:c.id,tool:'probe',requestId:f.requestId()},f.env);assert.equal(r.status,'succeeded');assert.equal(calls,3);
 await f.settings({action:'access',credentialId:f.item.id,expectedVersion:changed.version,blockedMemberIds:['grok']});await assert.rejects(()=>mcpConnectorTool(f.repo,a,{action:'call',channelId:f.channel.id,connectionId:c.id,tool:'probe',requestId:f.requestId()},f.env),e=>e.code==='vault_forbidden');assert.ok(!(await f.dump()).includes(secret));assert.ok(!(await f.dump()).includes(expected));
});

test('real stdio tools receive current env across Vault rotation, prune idle old processes and keep poll receipts free of secrets',async t=>{
 const f=await setup(t);f.env.CONNECTOR_ORIGIN='https://hub.example.test';
 const settings=args=>mcpConnectorSettings(f.repo,f.identity,owner,{requestId:f.requestId(),...args},f.env);
 const invitation=await settings({action:'host.create',name:'vault host'}),paired=await connectorHostRequest(f.repo,f.identity,{action:'pair',...invitation},null,f.env);
 const host=new McpToolHost({...paired,endpoint:'https://hub.example.test'});host.request=args=>connectorHostRequest(f.repo,f.identity,{hostId:paired.hostId,...args},paired.token,f.env);await host.tick();const task=host.start();t.after(async()=>{await host.stop();await task;});
 const c=(await settings({action:'save',name:'Vault stdio',transport:'stdio',hostId:paired.hostId,command:process.execPath,args:[new URL('./fixtures/vault-stdio.mjs',import.meta.url).pathname],env:{DW_VAULT_TOKEN:f.item.fields[0].reference}})).connection;
 const call=actor=>mcpConnectorTool(f.repo,actor,{action:'call',channelId:f.channel.id,connectionId:c.id,tool:'probe',requestId:f.requestId()},f.env);
 assert.equal((await call(a)).result.content[0].text,'[已隐藏]');assert.equal((await call(b)).result.content[0].text,'[已隐藏]');
 const nextSecret='stdio-rotated-secret-only-a-fixture';await f.settings({action:'save',credentialId:f.item.id,expectedVersion:1,fields:{token:nextSecret}});
 const rotated=await call(a);assert.equal(rotated.result.content[0].text,'[已隐藏]');assert.equal(host.sessions.size,1,'old idle environment is not retained');
 assert.ok(!(await f.dump()).includes(secret));assert.ok(!(await f.dump()).includes(nextSecret));
 const records=await f.settings({action:'activity',credentialId:f.item.id});assert.ok(records.items.some(e=>e.event==='connector_call'));
});
