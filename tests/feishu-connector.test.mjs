import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {callFeishu,feishuArgs,feishuIdentity} from '../local/feishu-cli.mjs';
import {FeishuConnector} from '../local/feishu-connector.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
async function setup(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'feishu-isolated-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const command=path.join(root,'lark-cli'),state=path.join(root,'state.json');await fs.copyFile(new URL('./fixtures/feishu-cli.mjs',import.meta.url),command);await fs.chmod(command,0o700);await fs.writeFile(state,'{}');
 // Each child receives an isolated fake CLI store, never the user's CLI tokens.
 const old=process.env.FEISHU_TEST_STATE;process.env.FEISHU_TEST_STATE=state;t.after(()=>{if(old===undefined)delete process.env.FEISHU_TEST_STATE;else process.env.FEISHU_TEST_STATE=old;});
 const binding={command,profile:'one',appId:'app-one',openId:'user-one',cwd:root};return {root,state,binding};
}
test('Feishu pins the original identity and passes text literally without a shell or credential output',async t=>{
 const f=await setup(t),text='$(touch /tmp/not-allowed) `echo secret` 中文\n--as=bot';
 const result=await callFeishu(f.binding,'feishu_call',{path:['docs','+update'],options:{doc:'test',command:'str_replace',content:text,pattern:'old','doc-format':'markdown'}});
 assert.equal(result.isError,false);const data=JSON.parse(result.content[0].text);assert.equal(data.ok,true);assert.equal(data.data.data.text,text);assert.equal(data.data.data.profile,'one');assert.equal(data.data.data.access_token,'[凭证已隐藏]');
 const calls=(await fs.readFile(f.state+'.calls','utf8')).trim().split('\n').map(JSON.parse);assert.ok(calls.every(a=>a[0]==='--profile'&&a[1]==='one'));assert.ok(calls[1].includes('--as'));assert.ok(calls[1].includes('user'));assert.ok(!calls[1].includes('--yes'));
 await fs.writeFile(f.state,JSON.stringify({changed:true}));await assert.rejects(feishuIdentity(f.binding),/账号已退出或改变/);await assert.rejects(callFeishu(f.binding,'feishu_call',{path:['docs','+fetch']}),/账号已退出或改变/);
});
test('Feishu forbids account overrides and host file escapes, preserves native scope and confirmation failures',async t=>{
 const f=await setup(t);
 assert.ok(feishuArgs({path:['drive','files','get'],options:{'file-token':'doc-token','file-type':'docx'}}).includes('--file-token=doc-token'));
 for(const path of [['auth','login'],['api','get'],['docs','+fetch','--profile'],['profile','set'],['schema'],['event','consume'],['apps','+git-credential-list'],['apps','+init'],['apps','+plugin-install']])assert.throws(()=>feishuArgs({path}));
 for(const options of [{as:'bot'},{profile:'two'},{yes:true},{content:'@/etc/passwd'},{data:'@../account.json'},{content:'<source path="@./account.json"/>'},{content:'<img href="&#64;./account.json"/>'},{content:'![x](@../x)'},{output:'/tmp/leak'},{'app-secret':'secret'}])assert.throws(()=>feishuArgs({path:['docs','+fetch'],options}));
 const missing=await callFeishu(f.binding,'feishu_call',{path:['docs','+fetch'],options:{doc:'missing-scope'}});assert.equal(missing.isError,true);assert.match(missing.content[0].text,/missing_scope/);assert.match(missing.content[0].text,/search:docs:read/);assert.ok(!missing.content[0].text.includes('internal auth instructions'));
 const gate=await callFeishu(f.binding,'feishu_call',{path:['docs','+update'],options:{command:'gate'}});assert.equal(gate.isError,true);assert.equal(JSON.parse(gate.content[0].text).exitCode,10);
 assert.equal((await callFeishu(f.binding,'feishu_call',{path:['docs','+fetch'],options:{doc:'working'}})).isError,false,'one scope error does not invalidate other granted capabilities');
});
test('Feishu one-click connector chooses real users, deduplicates and keeps credentials in the native CLI',async t=>{
 const f=await setup(t);let items=[],saves=0;const host={connect:async()=>({hostId:'host-one'})};
 const manager=new FeishuConnector({endpoint:'https://isolated.test',adminKey:'fake-admin'},f.root,host,{find:async()=>f.binding.command,request:async(url,init={})=>{if(!init.body)return {items};if(init.body.action==='check')return {connection:items[0]};saves++;const c={id:'shared-'+saves,hostId:'host-one',version:1,status:'connected',health:'ready',name:init.body.name};items.push(c);return {connection:c};}});
 const status=await manager.status();assert.equal(status.accounts.length,2);assert.equal(JSON.stringify(status).includes('user-one'),false);
 assert.equal((await manager.connect()).chooseAccount,true);
 const a=await Promise.all([manager.connect('one'),manager.connect('one')]);assert.equal(a[0].connection.id,a[1].connection.id);assert.equal(saves,1);
 await manager.connect('one');assert.equal(saves,1);const second=await manager.connect('two');assert.notEqual(second.connection.id,a[0].connection.id);
 const dirs=await fs.readdir(manager.root);for(const dir of dirs){const file=path.join(manager.root,dir,'account.json'),record=JSON.parse(await fs.readFile(file));assert.deepEqual(Object.keys(record).sort(),['appId','command','cwd','openId','profile']);assert.equal((await fs.stat(file)).mode&0o777,0o600);}
});
test('packaged Feishu adapter serves MCP through a real subprocess with isolated account storage',async t=>{
 const f=await setup(t),descriptor=path.join(f.root,'binding.json');await fs.writeFile(descriptor,JSON.stringify(f.binding));
 const client=new Client({name:'isolated consumer',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[new URL('../local/feishu-mcp-bundle.cjs',import.meta.url).pathname,descriptor],env:{...process.env},stderr:'pipe'});transport.stderr?.resume();t.after(()=>client.close());await client.connect(transport);
 const tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name),['feishu_help','feishu_schema','feishu_call']);
 const result=await client.callTool({name:'feishu_call',arguments:{path:['docs','+fetch'],options:{doc:'isolated'}}});assert.equal(result.isError,false);assert.equal(JSON.parse(result.content[0].text).data.data.profile,'one');
 await fs.writeFile(f.state,JSON.stringify({logout:true}));const failed=await client.callTool({name:'feishu_call',arguments:{path:['docs','+fetch']}});assert.equal(failed.isError,true);assert.match(failed.content[0].text,/账号已退出或改变/);assert.equal(failed.structuredContent.duolawork.code,'authorization_required');
});
