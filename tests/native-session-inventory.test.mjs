import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {parseDocument} from 'yaml';
import {CodexWorkingHost} from '../local/codex-working-host.mjs';
import {AntigravityDesktopHost} from '../local/antigravity-host.mjs';
import {DshDesktopHost} from '../local/dsh-desktop.mjs';
import {presentSessions,sessionProjects} from '../local/session-presentation.mjs';

test('Codex inventories unloaded history, live unpersisted threads and empty projects using paginated metadata only',async()=>{
 const calls=[],h=new CodexWorkingHost();h.read=fn=>fn({call:async(method,p)=>{calls.push([method,p]);if(method==='thread/loaded/list')return{data:['live']};if(method==='thread/read')return{thread:{id:'live',source:'vscode',cwd:'/work/a'}};if(method==='thread/list')return p.cursor?{data:[{id:'old2',source:'cli',cwd:'/work/b'}]}:{data:[{id:'old',source:'vscode',cwd:'/work/a',name:'原生标题'},{id:'child',source:{subAgent:{}},cwd:'/work/a'}],nextCursor:'page2'};if(method==='project/list')return{data:[{id:'a',name:'商店',roots:[{kind:'local',path:'/work/a'}]},{id:'empty',name:'空项目',roots:[{kind:'local',path:'/work/empty'}]}]};throw Error(method);}});
 const r=await h.sessions();assert.deepEqual(r.items.map(s=>s.id),['old','old2','live']);assert.equal(r.items[0].loaded,false);assert.equal(r.items[2].loaded,true);assert.ok(calls.filter(([m])=>m==='thread/read').every(([,p])=>p.includeTurns===false));
 const groups=sessionProjects(presentSessions(r.items),r.projects);assert.equal(groups.find(g=>g.name==='商店').items.length,2);assert.equal(groups.find(g=>g.name==='空项目').items.length,0);
});

test('a native conversation remains native when linked to a Hub chat; owned proof directories are separate',()=>{
 const [native,proof]=presentSessions([{id:'a',title:'原生',workspace:'/work/shop',source:'desktop'},{id:'b',workspace:'/private/tmp/hub-codex-gui-proof-abc/project'}],{bindings:{channel_a:{sessionId:'a'}},channels:[{id:'channel_a',name:'协作'}]});
 assert.match(native.sourceLabel,/Agent 中的对话/);assert.equal(native.category,'native');assert.equal(proof.category,'verification');
});

test('original Codex approvals apply only to the exact Hub turn, never prior user work or another thread',async()=>{
 let approved=0,stopped=0,reads=0;const rpc={call:async(method,params)=>{if(method==='thread/resume'){assert.deepEqual(params,{threadId:'original',excludeTurns:true});return{};}reads++;return{data:params.turnId==='hub-turn'?[{turnId:'hub-turn',item:{type:'userMessage',content:[{type:'text',text:'Hub command claim_step unique-work'}]}}]:[{turnId:'user-turn',item:{type:'userMessage',content:[{type:'text',text:'my own current work'}]}}]};},stop:async()=>stopped++};
 const host=new CodexWorkingHost();host.open=async()=>rpc;const close=await host.watch({sessionId:'original',workMarker:'unique-work',onApproval:async()=>{approved++;return{decision:'accept'};}});
 assert.equal(await rpc.onRequest('approval',{threadId:'other',turnId:'hub-turn'}),undefined);assert.equal(reads,0);
 assert.equal(await rpc.onRequest('approval',{threadId:'original',turnId:'user-turn'}),undefined);assert.equal(approved,0);
 assert.deepEqual(await rpc.onRequest('approval',{threadId:'original',turnId:'hub-turn'}),{decision:'accept'});assert.equal(approved,1);await close();assert.equal(stopped,1);
});

test('Codex wakes an idle original queue after enqueueing without replacing the session or its model',async()=>{
 const h=new CodexWorkingHost(),calls=[];h.sessions=async()=>({items:[{id:'original',workspace:'/project',loaded:true}]});h.read=fn=>fn({call:async(method,p)=>{calls.push([method,p]);if(method==='thread/queue/add')return{queuedSubmission:{id:'q'}};if(method==='thread/queue/list')return{data:[{id:'q'}]};if(method==='thread/read')return{thread:{status:{type:'idle'}}};return{};}});
 await h.queue({sessionId:'original',workspace:'/project',prompt:'owned Hub message'});
 assert.deepEqual(calls.map(c=>c[0]),['thread/resume','thread/queue/add','thread/queue/list','thread/read','thread/queue/start']);assert.deepEqual(calls.at(-1)[1],{threadId:'original',queuedSubmissionId:'q'});assert.ok(calls.every(([,p])=>!('model'in p)&&!('cwd'in p)&&!('approvalPolicy'in p)));
});

for(const platform of ['antigravity','deepseek'])test(platform+' deploy artifact imports in isolation, including all shared-file dependencies',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-plugin-artifact-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));let entry;
 if(platform==='antigravity'){const host=new AntigravityDesktopHost(path.join(dir,'hub'),{home:dir});await host.deploy();entry=JSON.parse(await fs.readFile(path.join(dir,'.gemini/config/sidecars/duola-agent-hub/sidecar.json'))).args[0];}
 else{const profile=path.join(dir,'profile');await fs.mkdir(profile);await fs.writeFile(path.join(profile,'cordis.patch.yml'),'[]');const host=new DshDesktopHost(path.join(dir,'hub'));await host.deploy(profile);const patch=parseDocument(await fs.readFile(path.join(profile,'cordis.patch.yml'),'utf8')).toJSON();entry=patch[0].insert[0].name;}
 await promisify(execFile)(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(entry).href)});`],{cwd:dir});
});
