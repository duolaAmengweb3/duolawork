import test from 'node:test';
import assert from 'node:assert/strict';
import {presentSessions,sessionProjects} from '../local/session-presentation.mjs';
import {DshConnector} from '../local/dsh-connector.mjs';
import {DshDesktopHost} from '../local/dsh-desktop.mjs';

for(const platform of ['Codex','Gemini','DeepSeek','Claude'])test(platform+' groups conversations by project without changing native identity',()=>{
 const raw=[{id:'one',workspace:'/projects/shop',title:'购物车修复'},{id:'two',workspace:'/projects/shop',title:'支付接口'},{id:'other',workspace:'/client/shop',title:'另一客户'}];
 const result=sessionProjects(presentSessions(raw,{platform}));assert.equal(result.length,2);assert.equal(result[0].name,'shop');assert.equal(result[0].nameSource,'folder');assert.deepEqual(result[0].items.map(s=>s.id),['one','two']);assert.equal(result[1].workspace,'/client/shop');
});
test('native project title overrides folder basename; empty registered projects remain visible',()=>{
 const items=presentSessions([{id:'a',title:'原标题',workspace:'/work/abc',projectId:'p1',projectName:'用户命名的商店'}]);
 const groups=sessionProjects(items,[{id:'p1',name:'用户命名的商店',workspace:'/work/abc'},{id:'p2',name:'新产品',workspace:'/work/new'}]);
 assert.equal(groups[0].name,'用户命名的商店');assert.equal(groups[0].nameSource,'native');assert.equal(groups[1].items.length,0);assert.equal(items[0].title,'原标题');
});
test('DeepSeek uses official workspace membership and title, not guessed cwd or a Hub-generated name',async()=>{
 const connector=new DshConnector({ctx:{sessionController:{list:async()=>({items:[{sessionId:'s1',cwd:'/work/abc',projections:{values:{title:'原生对话'}}},{sessionId:'old'}]})},workspaceRegistry:{archivedSessionIds:['old'],list:()=>[{id:'p1',title:'我的产品',path:'/work/abc',sessionIds:['s1']}]}}});
 const native=await connector.sessions();assert.equal(native.items.length,1);assert.equal(native.items[0].projectName,'我的产品');
 const host=new DshDesktopHost('/unused');host.call=async()=>native;const listed=await host.sessions();
 assert.equal(listed.items[0].title,'原生对话');assert.equal(listed.items[0].projectName,'我的产品');assert.equal(listed.items[0].projectId,'p1');assert.equal(listed.projects[0].workspace,'/work/abc');
});

test('Claude metadata reads only the registered native session in its own directory and preserves identity',async()=>{
 const {refreshSessionInfo}=await import('../connectors/claude/session-info.mjs');const s={sessionId:'exact',workspace:'/vps/project',title:'未命名对话',runtimeId:'vps'};const calls=[];
 const updated=await refreshSessionInfo(s,{readInfo:async(...args)=>{calls.push(args);return{sessionId:'exact',customTitle:'用户改过的标题',summary:'旧摘要',cwd:'/unrelated'};}});
 assert.deepEqual(calls,[['exact',{dir:'/vps/project'}]]);assert.equal(updated.title,'用户改过的标题');assert.equal(updated.workspace,'/vps/project');assert.equal(updated.runtimeId,'vps');
 assert.deepEqual(await refreshSessionInfo(s,{readInfo:async()=>{throw Error('unavailable');}}),s);
});

test('official Claude SDK resolves a renamed session from isolated fixture storage without a model or login',async t=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{randomUUID}=await import('node:crypto');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hub-claude-metadata-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const workspace=path.join(root,'project'),config=path.join(root,'claude'),sessionId=randomUUID();await fs.mkdir(workspace);const folder=path.join(config,'projects',workspace.replace(/[^a-zA-Z0-9]/g,'-'));await fs.mkdir(folder,{recursive:true});
 const transcript=[{type:'user',uuid:randomUUID(),sessionId,cwd:workspace,timestamp:new Date().toISOString(),message:{role:'user',content:'fixture first prompt'}},{type:'custom-title',customTitle:'用户的真实会话名',sessionId}].map(v=>JSON.stringify(v)).join('\n')+'\n';await fs.writeFile(path.join(folder,sessionId+'.jsonl'),transcript);
 const code=`import{getSessionInfo}from'@anthropic-ai/claude-agent-sdk';const s=await getSessionInfo(${JSON.stringify(sessionId)},{dir:${JSON.stringify(workspace)}});console.log(JSON.stringify({id:s?.sessionId,title:s?.customTitle}));`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{env:{...process.env,CLAUDE_CONFIG_DIR:config}});assert.deepEqual(JSON.parse(stdout),{id:sessionId,title:'用户的真实会话名'});
});
