import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseDocument} from 'yaml';
import {desktopPatch,DshDesktopHost} from '../local/dsh-desktop.mjs';
import {DshManager} from '../local/dsh-manager.mjs';

test('official Desktop patch retains user settings, comments and !!js expressions and is idempotent',()=>{
 const before='# native user comment\n- id: untouched\n  config:\n    token: user-private-fixture\n    expression: !!js x => x + 1\n';
 const options={entry:'/owned/revision/local/dsh-connector.mjs',stateFile:'/owned/control.json'},after=desktopPatch(before,options);
 assert.ok(after.includes('# native user comment'));assert.ok(after.includes('!!js'));assert.ok(after.includes('user-private-fixture'));assert.equal(desktopPatch(after,options),after);
 const next=desktopPatch(after,{...options,entry:'/owned/next/local/dsh-connector.mjs'});assert.equal((next.match(/duola-agent-hub-desktop/g)||[]).length,1);assert.ok(next.includes('/owned/next/'));
});
test('Desktop profile patch refuses invalid data and a similarly named plugin owned by another Hub',()=>{
 assert.throws(()=>desktopPatch('not: a-list',{entry:'x',stateFile:'s'}),/原文件保留/);
 const raw=desktopPatch('[]',{entry:'/other/plugin',stateFile:'/other/state'});assert.throws(()=>desktopPatch(raw,{entry:'/owned/plugin',stateFile:'/owned/state'}),/其他连接/);
});
test('Desktop discovery selects the actual original Host, not a separate Web process or guessed recent session',async()=>{
 const app='/Applications/DeepSeek Harness.app',resources=app+'/Contents/Resources',runtime=resources+'/app.asar/dsh',entry=runtime+'/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js';
 const execute=async(command)=>command==='/bin/ps'?{stdout:`11 ${app}/Contents/MacOS/DeepSeek Harness\n22 ${app}/Contents/MacOS/DeepSeek Harness --expose-internals ${entry} ${runtime} /Users/test/custom home/profiles/desktop ${resources}/runtime/primary-runtime\n33 node /unrelated/dsh web\n`}:{stdout:'0.2.1-rc.5\n'};
 const d=new DshDesktopHost('/private/fixture',{execute}),found=await d.discover();assert.equal(found.pid,22);assert.equal(found.profile,'/Users/test/custom home/profiles/desktop');assert.equal(found.running,true);
});
test('Desktop bridge does not open another instance in a background restore when the native app is closed',async()=>{
 const d=new DshDesktopHost('/private/fixture');d.discover=async()=>({installed:true,supported:true,running:false});d.open=async()=>{throw Error('must not open');};await assert.rejects(d.start({launch:false}),/桌面版已关闭/);
});
test('Desktop old plugin cannot claim the new current-conversation route is ready',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-desktop-version-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const d=new DshDesktopHost(dir);await fs.mkdir(d.root,{recursive:true});await fs.writeFile(d.stateFile,JSON.stringify({pid:123}));
 d.discover=async()=>({installed:true,supported:true,running:true,pid:123,profile:'/fixture'});d.deploy=async()=>{};d.call=async()=>({ready:true,protocolVersion:6});
 await assert.rejects(d.start({launch:false}),/重新加载/);d.call=async()=>({ready:true,protocolVersion:7});assert.equal((await d.start({launch:false})).protocolVersion,7);
});
test('new members use Desktop while pre-existing managed DSH sessions keep their exact original runtime',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-desktop-routing-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const m=new DshManager({config:{},dataDir:dir});m.records.member_old={memberId:'member_old',sessionId:'original',enabled:true};m.records.member_new={memberId:'member_new',sessionId:'desktop-original',hostKind:'desktop'};
 assert.equal(m.host.kind,'desktop');assert.equal(m.hostFor('member_old'),m.legacyHost);assert.equal(m.hostFor('member_new'),m.host);assert.equal(m.hostFor('member_fresh'),m.host);
});
test('Hub plugin deployment does not alter account storage, global permissions, or the official application bundle',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-desktop-deploy-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const profile=path.join(dir,'native/profiles/desktop');await fs.mkdir(profile,{recursive:true});
 await fs.writeFile(path.join(profile,'cordis.patch.yml'),'# owned native settings\n[]\n');await fs.writeFile(path.join(profile,'account-private.json'),'untouched-provider-secret');
 const d=new DshDesktopHost(path.join(dir,'hub'));await d.deploy(profile);assert.equal(await fs.readFile(path.join(profile,'account-private.json'),'utf8'),'untouched-provider-secret');
 const state=JSON.parse(await fs.readFile(d.stateFile,'utf8'));assert.ok(state.controlToken.length>=32);assert.equal((await fs.stat(d.stateFile)).mode&0o777,0o600);
 const raw=await fs.readFile(path.join(profile,'cordis.patch.yml'),'utf8');assert.ok(raw.includes('owned native settings'));assert.ok(!raw.includes(state.controlToken));assert.equal(parseDocument(raw).errors.length,0);
});
