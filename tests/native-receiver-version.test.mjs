import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture} from './collaboration-helper.mjs';
import {remoteSessions} from '../cloud/collaboration/native-sessions.mjs';
import {sha256 as currentRevision} from '../cloud/collaboration/claude-download.mjs';
import {MonitorBridge} from '../connectors/claude/monitor.mjs';
import {privateJson} from '../local/storage.mjs';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

async function setup(t){
 const f=await fixture(t);f.identity.members[0].platformId='claude-code';
 const beat=(extra={})=>remoteSessions(f.repo,f.identity,{memberId:'grok'},{sessionId:'original',instanceId:'process-one',runtimeId:'original-runtime',title:'Original',workspace:'/srv/original',...extra},true);
 const read=()=>remoteSessions(f.repo,f.identity,{owner:true},{memberId:'grok'});
 return {...f,beat,read};
}

test('native session reports the running receiver revision separately from the published package',async t=>{
 const f=await setup(t);await f.beat({receiverRevision:currentRevision});
 const r=await f.read();assert.equal(r.items[0].receiverRevision,currentRevision);assert.equal(r.items[0].updateAvailable,false);
 assert.equal(r.record.targetRevision,currentRevision);assert.equal(r.record.receiverRevision,currentRevision);assert.equal(r.record.updateAvailable,false);assert.equal(r.record.revisionKnown,true);
});

test('legacy and restarted receivers cannot inherit proof that another process loaded the new code',async t=>{
 const f=await setup(t);await f.beat();let r=await f.read();assert.equal(r.items[0].receiverRevision,null);assert.equal(r.record.revisionKnown,false);
 await f.beat({receiverRevision:currentRevision});await f.beat();r=await f.read();assert.equal(r.items[0].receiverRevision,currentRevision);
 await f.beat({status:'offline'});await f.beat({instanceId:'replacement-without-version'});r=await f.read();assert.equal(r.items[0].receiverRevision,null);assert.equal(r.record.revisionKnown,false);assert.equal(r.record.revisionState,'unknown');assert.equal(r.record.updateAvailable,false);
});

test('mixed active native versions remain visible; offline old receivers do not make healthy sessions obsolete',async t=>{
 const f=await setup(t);await f.beat({receiverRevision:currentRevision});
 await f.beat({sessionId:'second',instanceId:'second-process',receiverRevision:'0'.repeat(64)});
 let r=await f.read();assert.equal(r.record.receiverRevision,null);assert.equal(r.record.updateAvailable,true);assert.equal(r.record.revisionKnown,true);assert.equal(r.items.find(s=>s.id==='second').updateAvailable,true);
 await f.beat({sessionId:'second',instanceId:'second-process',status:'offline'});r=await f.read();assert.equal(r.record.receiverRevision,currentRevision);assert.equal(r.record.updateAvailable,false);
});

test('invalid native revision is rejected without changing the previous heartbeat',async t=>{
 const f=await setup(t);await f.beat({receiverRevision:currentRevision});const prior=await f.repo.get('native-source','grok');
 await assert.rejects(f.beat({receiverRevision:'not-a-code-hash'}),e=>e.code==='invalid_revision');assert.deepEqual(await f.repo.get('native-source','grok'),prior);
});

test('monitor heartbeat uses its startup version instead of rereading a replaced installation',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hub-receiver-version-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 await privateJson(path.join(directory,'monitor-sessions.json'),{runtimeId:'runtime',sessionIds:['native']});
 const beats=[],client={inbox:async()=>({work:[]}),api:async(url,options)=>{
  if(url==='/v2/self/native-sessions'&&options?.method==='POST'){beats.push(options.body);return{};}
  if(url==='/v2/self/status')return{complete:true};
  if(url==='/v2/self/native-sessions')return{bindings:{},commands:[]};
  if(url==='/v2/self/session-links')return{items:[]};
  if(url==='/v2/self/inbox')return{work:[]};
  if(url.startsWith('/v2/self/work-state'))return{work:[]};
  throw Error('Unexpected '+url);
 }};
 const loaded='1'.repeat(64),monitor=new MonitorBridge({connectionDir:directory,receiverRevision:loaded,client,launcher:async()=>null,identity:async()=>({sessionId:'native',instanceId:'process',workspace:directory,title:'Original'}),output:()=>{}});
 await privateJson(path.join(directory,'connection.json'),{runtimeRevision:'2'.repeat(64)});
 await monitor.tick();assert.equal(beats[0].receiverRevision,loaded);await monitor.close();
});

test('native monitor refuses a registration hash that differs from its startup bundle before opening a connection',async()=>{
 const entry=fileURLToPath(new URL('../connectors/claude/cli.mjs',import.meta.url));
 await assert.rejects(promisify(execFile)(process.execPath,[entry,'monitor',path.join(os.tmpdir(),'not-a-real-hub-config'),'--runtime-revision','0'.repeat(64)],{env:{...process.env,AGENT_HUB_CONNECTOR_IMPORT:'0'},timeout:10000}),error=>error.code===1&&/启动版本与插件登记不同/.test(error.stderr)&&!error.stderr.includes('ENOENT'));
});
