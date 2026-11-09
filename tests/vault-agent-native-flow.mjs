import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {startNodeHarness} from './node-server-harness.mjs';
const h=await startNodeHarness(),checks=[];
try{
 const a=await h.member('ordinary agent A'),b=await h.member('ordinary agent B'),channel=await h.command('channel.create',{name:'isolated default-open Vault',memberIds:[a.id,b.id],coordinatorId:a.id}),sessionId='isolated-native-vault-session';await a.bind(channel.id,sessionId);
 assert.equal(await h.repo.get('workspace_secretary','current',false),null);
 const tool=(await a.client.tools()).find(t=>t.name==='vault');assert.ok(tool.inputSchema.properties.action.enum.includes('save'));assert.ok(tool.inputSchema.properties.fields);assert.ok(tool.inputSchema.properties.action.enum.includes('reveal'));
 let item;const token='synthetic-vault-native-'+randomUUID();
 for(const contextMode of ['full','incremental']){
  const message=await h.command('channel.post',{channelId:channel.id,body:contextMode==='full'?'请将已提供的凭证存到 Vault，不要让我再填。':'继续使用刚才的凭证。'}),work=(await a.client.inbox()).work.find(w=>w.delivery?.message?.id===message.id);assert.ok(work);
  const claim=await a.client.tool('claim_work',{requestId:randomUUID(),stepId:work.stepId,channelId:channel.id,expectedSessionId:sessionId,contextMode});assert.match(claim.input.vaultInstruction,/不要求秘书身份或逐次授权/);assert.match(claim.input.vaultInstruction,/直接调用 vault\(action=save/);assert.ok(!claim.input.vaultInstruction.includes('密钥由用户在 Vault 录入'));
  if(!item){item=await a.client.tool('post_message',{channelId:channel.id,requestId:randomUUID(),body:'HUB_SHARED_TOOL_V1\n'+JSON.stringify({name:'vault',arguments:{action:'save',channelId:channel.id,name:'Synthetic native credential',type:'ssh',fields:{host:'server.example.test',username:'fixture-user',password:token}}})});assert.ok(item.id);assert.ok(!JSON.stringify(item).includes(token));}
  else{const expected=createHash('sha256').update(token).digest('hex');for(const member of [a,b]){const r=await member.client.tool('run_with_credentials',{requestId:randomUUID(),channelId:channel.id,command:process.execPath,args:['-e',"process.stdout.write(require('node:crypto').createHash('sha256').update(process.env.DW_TEST_PASSWORD).digest('hex'))"],cwd:h.directory,env:{DW_TEST_PASSWORD:item.fields.find(f=>f.name==='password').reference}});assert.equal(r.status,'succeeded');assert.equal(r.stdout,expected);}}
  await a.client.tool('post_message',{requestId:randomUUID(),channelId:channel.id,turnId:claim.turnId,body:'Synthetic protocol check completed.'});
 }
 checks.push('full and incremental native claims carry the current default-open policy','ordinary non-secretary member writes using old-catalog compatibility without publishing secret','two independent authenticated member runtimes use the credential in real child processes');
 item=await b.client.tool('vault',{action:'save',channelId:channel.id,requestId:randomUUID(),credentialId:item.id,expectedVersion:item.version,fields:{password:'synthetic-rotated-'+randomUUID()}});assert.equal(item.version,2);
 await h.restart();assert.equal((await a.client.tool('vault',{action:'info',channelId:channel.id,credentialId:item.id})).item.version,2);checks.push('another ordinary agent rotates the credential and it survives a real server restart');
 await h.request('/v2/vault',{action:'access',requestId:randomUUID(),credentialId:item.id,expectedVersion:item.version,blockedMemberIds:[b.id]});await assert.rejects(b.client.tool('vault',{action:'reveal',channelId:channel.id,credentialId:item.id,requestId:randomUUID()}),e=>e.status===403);await assert.rejects(b.client.tool('vault',{action:'save',channelId:channel.id,credentialId:item.id,expectedVersion:3,fields:{password:'cannot-overwrite'},requestId:randomUUID()}),e=>e.status===403);checks.push('later owner exclusions stop both reads and writes immediately');
 const dump=JSON.stringify((await h.repo.db.prepare('SELECT body FROM hub_v2_records').all()).results);assert.ok(!dump.includes(token));console.log(JSON.stringify({scope:'isolated real HTTP, SQLite, native bridge and child processes; no production model or account',checks}));
}finally{await h.stop();}
