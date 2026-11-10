import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand} from '../cloud/collaboration/conversation.mjs';
import {vaultSettings} from '../cloud/collaboration/vault.mjs';
import {mcpConnectorSettings,mcpConnectorTool} from '../cloud/collaboration/mcp-connectors.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';
import {renderWechatMarkdown} from '../shared/wechat-markdown.mjs';
import {beginFile,writeChunk,finishFile} from '../cloud/collaboration/shared-space.mjs';
import {diskObjects} from '../server/object-store.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
const owner={owner:true},agent={memberId:'grok'},peer={memberId:'check'};
async function setup(t){
 const f=await fixture(t),env={ADMIN_KEY:'isolated-wechat-admin',VAULT_ENCRYPTION_KEY:Buffer.alloc(32,82).toString('base64'),CONNECTOR_EGRESS_IP:'203.0.113.19'},accounts=new Map(),drafts=new Map();let tokenCalls=0,writes=0,uploads=0,failAfterWrite=false,expireNext=false;
 const command=(type,args)=>conversationCommand(f.repo,f.identity,owner,{requestId:crypto.randomUUID(),type,...args}),channel=await command('channel.create',{name:'isolated WeChat',memberIds:['grok','check'],coordinatorId:'grok'});
 env.CONNECTOR_FETCH=async(url,init={})=>{
  const u=new URL(url);assert.equal(u.origin,'https://api.weixin.qq.com');
  if(u.pathname==='/cgi-bin/stable_token'){const data=JSON.parse(init.body),account=accounts.get(data.appid);tokenCalls++;if(!account||data.secret!==account.secret)return Response.json({errcode:40125,errmsg:'bad secret'});if(data.force_refresh)account.token+='-renewed';return Response.json({access_token:account.token,expires_in:7200});}
  const a=[...accounts.entries()].find(([,a])=>a.token===u.searchParams.get('access_token'));assert.ok(a,'uses the selected account, never another account token');
  if(expireNext){expireNext=false;return Response.json({errcode:42001,errmsg:'token expired'});}
  const body=init.body instanceof FormData?null:init.body?JSON.parse(init.body):null;
  if(u.pathname==='/cgi-bin/draft/count')return Response.json({total_count:drafts.size});
  if(u.pathname==='/cgi-bin/material/get_materialcount')return Response.json({image_count:uploads});
  if(u.pathname==='/cgi-bin/freepublish/batchget')return Response.json({errcode:48001,errmsg:'api unauthorized'});
  if(u.pathname==='/cgi-bin/draft/add'){writes++;const id='draft-'+writes;drafts.set(id,{appId:a[0],news_item:body.articles});if(failAfterWrite)throw Error('response lost after write');return Response.json({media_id:id});}
  if(u.pathname==='/cgi-bin/draft/get'){assert.equal(drafts.get(body.media_id).appId,a[0]);return Response.json(drafts.get(body.media_id));}
  if(u.pathname==='/cgi-bin/draft/delete'){drafts.delete(body.media_id);return Response.json({errcode:0,errmsg:'ok'});}
  if(u.pathname==='/cgi-bin/draft/update'){drafts.get(body.media_id).news_item[body.index]=body.articles;return Response.json({errcode:0});}
  if(u.pathname.includes('add_material')||u.pathname==='/cgi-bin/media/uploadimg'){assert.ok(init.body instanceof FormData);const file=init.body.get('media');assert.equal(await file.text(),'synthetic image bytes');uploads++;return Response.json(u.pathname.includes('uploadimg')?{url:'https://mmbiz.qpic.cn/synthetic-'+uploads}:{media_id:'material-'+uploads,url:'https://mmbiz.qpic.cn/synthetic-'+uploads});}
  return Response.json({errcode:0,selectedAccount:a[0]});
 };
 const make=async(appId,name)=>{const secret='private-synthetic-'+name;accounts.set(appId,{secret,token:'token-'+name});const credential=await vaultSettings(f.repo,f.identity,owner,{action:'save',requestId:crypto.randomUUID(),name,fields:{app_id:appId,app_secret:secret}},env);const c=(await mcpConnectorSettings(f.repo,f.identity,owner,{action:'save',requestId:crypto.randomUUID(),provider:'wechat-mp',appId,name,credentialId:credential.id},env)).connection;return {c,credential};};
 const tool=(c,tool,args={},requestId=crypto.randomUUID(),actor=agent)=>mcpConnectorTool(f.repo,actor,{channelId:channel.id,connectionId:c.id,action:'call',tool,arguments:args,requestId},env),data=r=>JSON.parse(r.result.content[0].text);
 return {...f,env,accounts,channel,command,make,tool,data,get tokens(){return tokenCalls;},get writes(){return writes;},get uploads(){return uploads;},expire(){expireNext=true;},fail(){failAfterWrite=true;},dump:async()=>JSON.stringify([(await f.db.prepare('SELECT body FROM hub_v2_records').all()).results,(await f.db.prepare('SELECT result FROM hub_v2_receipts').all()).results])};
}
test('WeChat is a shared server connector with independent accounts, real permission probes and encrypted caches',async t=>{
 const f=await setup(t),a=await f.make('wx1111111111111111','one'),b=await f.make('wx2222222222222222','two');assert.equal(a.c.health,'ready');assert.equal(a.c.transport,'wechat');assert.equal(a.c.capabilities.drafts.state,'verified');assert.equal(a.c.capabilities.publishedArticles.code,48001);assert.equal(a.c.capabilities.publish.state,'not_tested');assert.equal(a.c.execution.egressIp,'203.0.113.19');assert.equal(a.c.credentials,undefined);
 const another=await f.command('channel.create',{name:'future channel',memberIds:['grok','check']});assert.equal((await mcpConnectorTool(f.repo,peer,{action:'connections',channelId:another.id},f.env)).items.length,2);
 const results=await Promise.all([f.tool(a.c,'wechat_api',{path:'/cgi-bin/menu/get'}),f.tool(b.c,'wechat_api',{path:'/cgi-bin/menu/get'},undefined,peer),f.tool(a.c,'wechat_status')]);assert.equal(f.data(results[0]).selectedAccount,'wx1111111111111111');assert.equal(f.data(results[1]).selectedAccount,'wx2222222222222222');assert.equal(f.tokens,2);
 const customer=await f.tool(a.c,'wechat_api',{path:'/customservice/kfaccount/list'});assert.equal(f.data(customer).selectedAccount,'wx1111111111111111');
 const dump=await f.dump();for(const s of ['private-synthetic-one','private-synthetic-two','token-one','token-two'])assert.ok(!dump.includes(s));
});
test('WeChat draft create/update/read and multipart image upload share idempotent receipts',async t=>{
 const f=await setup(t),{c}=await f.make('wx1111111111111111','draft');
 const image=await f.tool(c,'wechat_upload',{kind:'material',base64:btoa('synthetic image bytes'),filename:'cover.png',mime:'image/png'});assert.equal(f.data(image).media_id,'material-1');
 const args={operation:'create',articles:[{title:'中文标题',markdown:'# 测试\n\n正文 **加粗**。',thumb_media_id:'material-1'}]},key=crypto.randomUUID();const one=await f.tool(c,'wechat_draft',args,key),again=await f.tool(c,'wechat_draft',args,key);assert.deepEqual(one,again);assert.equal(f.writes,1);const media_id=f.data(one).media_id;
 let read=f.data(await f.tool(c,'wechat_draft',{operation:'get',media_id}));assert.equal(read.news_item[0].title,'中文标题');assert.match(read.news_item[0].content,/style=/);assert.match(read.news_item[0].content,/加粗/);
 await f.tool(c,'wechat_draft',{operation:'update',media_id,index:0,article:{title:'更新',markdown:'新正文',thumb_media_id:'material-1'}});read=f.data(await f.tool(c,'wechat_draft',{operation:'get',media_id}));assert.equal(read.news_item[0].title,'更新');await f.tool(c,'wechat_draft',{operation:'delete',media_id});assert.equal(f.data(await f.tool(c,'wechat_draft',{operation:'count'})).total_count,0);
});
test('ordinary agents connect from Vault without owner impersonation, and later channel/member restrictions win',async t=>{
 const f=await setup(t),appId='wx3333333333333333';f.accounts.set(appId,{secret:'synthetic-direct',token:'direct-token'});const credential=await vaultSettings(f.repo,f.identity,owner,{action:'save',requestId:crypto.randomUUID(),name:'direct',fields:{app_id:appId,app_secret:'synthetic-direct'}},f.env);
 const args={action:'connect',provider:'wechat-mp',appId,credentialId:credential.id,name:'ordinary agent account',channelId:f.channel.id,requestId:crypto.randomUUID()},c=(await callTool(f.repo,f.identity,agent,'connector',args,f.env)).connection;assert.equal(c.health,'ready');assert.equal((await callTool(f.repo,f.identity,agent,'connector',args,f.env)).connection.id,c.id);assert.equal((await f.repo.list('service_connection')).length,1);
 await mcpConnectorSettings(f.repo,f.identity,owner,{action:'access',requestId:crypto.randomUUID(),connectionId:c.id,expectedVersion:c.version,blockedMemberIds:['check']},f.env);await assert.rejects(()=>mcpConnectorTool(f.repo,peer,{action:'tools',channelId:f.channel.id,connectionId:c.id},f.env),e=>e.code==='forbidden');
 const current=await f.repo.get('service_connection',c.id);await vaultSettings(f.repo,f.identity,owner,{action:'access',requestId:crypto.randomUUID(),credentialId:credential.id,expectedVersion:credential.version,blockedMemberIds:['grok']},f.env);await assert.rejects(()=>f.tool(current,'wechat_status'),e=>e.code==='vault_forbidden');
});
test('token expiry retries only an explicit authentication rejection; uncertain writes never replay',async t=>{
 const f=await setup(t),{c}=await f.make('wx1111111111111111','expiry');f.expire();const renewed=await f.tool(c,'wechat_draft',{operation:'count'});assert.equal(renewed.status,'succeeded');assert.equal(f.tokens,2);
 f.fail();const args={operation:'create',articles:[{title:'test',content:'body',thumb_media_id:'cover'}]},id=crypto.randomUUID();assert.equal((await f.tool(c,'wechat_draft',args,id)).status,'unknown');assert.equal((await f.tool(c,'wechat_draft',args,id)).status,'unknown');assert.equal(f.writes,1);
});
test('Vault rotation invalidates the account token cache and unsupported paths cannot escape the official origin',async t=>{
 const f=await setup(t),{c,credential}=await f.make('wx1111111111111111','rotation');f.accounts.get(c.appId).secret='new-synthetic-secret';f.accounts.get(c.appId).token='new-synthetic-token';await vaultSettings(f.repo,f.identity,owner,{action:'save',requestId:crypto.randomUUID(),credentialId:credential.id,expectedVersion:credential.version,fields:{app_secret:'new-synthetic-secret'}},f.env);assert.equal((await f.tool(c,'wechat_draft',{operation:'count'})).status,'succeeded');assert.equal(f.tokens,2);
 for(const path of ['https://evil.test','//evil.test/cgi-bin/x','/cgi-bin/../token','/cgi-bin/token']){const result=await f.tool(c,'wechat_api',{path});assert.notEqual(result.status,'succeeded');}
 assert.ok(!(await f.dump()).includes('new-synthetic-secret'));assert.ok(!(await f.dump()).includes('new-synthetic-token'));
});
test('Markdown output uses inline styles and literal HTML cannot run script or unsafe URL schemes',()=>{
 const html=renderWechatMarkdown('# 中文\n\n**正文** `code`\n\n<script>bad()</script>\n\n[x](javascript:bad)');assert.match(html,/style=/);assert.match(html,/&lt;script&gt;/);assert.ok(!html.includes('href="javascript:'));assert.match(html,/<strong>正文<\/strong>/);
});
test('expired token cache is refreshed once for concurrent agents and shared-file uploads use the exact stored bytes',async t=>{
 const f=await setup(t),{c}=await f.make('wx1111111111111111','shared'),cached=await f.repo.get('service_wechat_token',c.id);await f.repo.transact(crypto.randomUUID(),{},tx=>tx.put('service_wechat_token',{...cached,expiresAt:'2020-01-01T00:00:00Z'}));
 await Promise.all(Array.from({length:6},(_,i)=>f.tool(c,'wechat_draft',{operation:'count'},undefined,i%2?peer:agent)));assert.equal(f.tokens,2);
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wechat-shared-file-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));f.env.SHARED_FILE_STORAGE='disk';f.env.SHARED_FILES=diskObjects(directory);const bytes=Buffer.from('synthetic image bytes');
 const upload=await beginFile(f.repo,agent,{requestId:crypto.randomUUID(),channelId:f.channel.id,name:'cover.png',mime:'image/png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),announce:false},f.env);await writeChunk(f.repo,agent,{uploadId:upload.id,index:0,base64:bytes.toString('base64')},f.env);const file=await finishFile(f.repo,f.identity,agent,{uploadId:upload.id},f.env);
 const result=await f.tool(c,'wechat_upload',{kind:'material',fileId:file.id},undefined,peer);assert.equal(result.status,'succeeded');assert.equal(f.uploads,1);
});
