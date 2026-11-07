import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {nativeSession,AntigravitySidecar,AntigravityNative} from '../local/antigravity-sidecar.mjs';
import {sidecarConfig} from '../local/antigravity-host.mjs';
const id='ec7e7e51-e0cf-492e-8413-f9e64828540d';
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-agy-sidecar-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const stateFile=path.join(dir,'state.json'),grantFile=path.join(dir,'grant.json');await fs.writeFile(stateFile,JSON.stringify({controlToken:'private-own-control-token-fixture-12345678',bindings:[],deliveries:{}}),{mode:0o600});await fs.writeFile(grantFile,'{}',{mode:0o600});
 let busy=false,hasWork=false,sendFailure=false;const sends=[],tools=[];
 const native={summaries:async()=>({[id]:{summary:'Original GUI session',workspaces:[{workspaceFolderAbsoluteUri:'file://'+dir}],status:busy?'CASCADE_RUN_STATUS_RUNNING':'CASCADE_RUN_STATUS_IDLE'}}),send:async(session,prompt)=>{sends.push({session,prompt});if(sendFailure)throw Error('timeout');}};
 const client={inbox:async()=>({work:hasWork?[{stepId:'turn_one',channelId:'channel_one',status:'ready'}]:[]}),credentials:async()=>({memberId:'member_one'}),tools:async()=>[{name:'post_message'}],api:async()=>({hasWork}),tool:async(name,args)=>{tools.push({name,args});return name==='list_work'?{work:[{stepId:'turn_one',channelId:'channel_one',status:'ready'}]}:{written:true};}};
 const sidecar=await new AntigravitySidecar({stateFile,native,clientFactory:()=>client,pollMs:3600000}).start();t.after(()=>sidecar.stop());await sidecar.bind({sessionId:id,workspace:dir,grantFile});
 return{dir,stateFile,grantFile,sidecar,native,client,sends,tools,setBusy:v=>busy=v,setWork:v=>hasWork=v,setFailure:v=>sendFailure=v};
}
test('native metadata supplies the original workspace and treats unknown execution state as busy',()=>{
 const s=nativeSession(id,{summary:'title',workspaces:[{workspaceFolderAbsoluteUri:'file:///tmp/my%20project'}],status:'CASCADE_RUN_STATUS_IDLE'});assert.equal(s.workspace,'/tmp/my project');assert.equal(s.running,false);assert.equal(nativeSession(id,{}).running,true);
});
test('official Sidecar config preserves all unrelated native settings and explicit disabling',()=>{
 const old={plugins:{user:true},userSettings:{model:'unchanged'},sidecars:{other:{enabled:true}}};const next=sidecarConfig(JSON.stringify(old));assert.deepEqual(next.plugins,old.plugins);assert.deepEqual(next.userSettings,old.userSettings);assert.deepEqual(next.sidecars.other,old.sidecars.other);assert.equal(next.sidecars['duola-agent-hub'].enabled,true);assert.throws(()=>sidecarConfig('{"sidecars":{"duola-agent-hub":{"enabled":false}}}'),/停用/);
});
test('no Hub work does not start a model or read native conversation content',async t=>{
 const f=await fixture(t);await f.sidecar.poll();assert.equal(f.sends.length,0);assert.equal(f.tools.length,0);
});
test('an executing original conversation finishes first; the queued Hub message is sent once to the exact same conversation',async t=>{
 const f=await fixture(t);f.setWork(true);f.setBusy(true);await f.sidecar.poll();assert.equal(f.sends.length,0);assert.equal(f.sidecar.bindings.get(id).waitingForNative,true);assert.deepEqual(f.sidecar.state.deliveries,{});
 f.setBusy(false);await f.sidecar.poll();await f.sidecar.poll();assert.equal(f.sends.length,1);assert.equal(f.sends[0].session,id);assert.ok(f.sends[0].prompt.includes('turn_one'));assert.ok(!f.sends[0].prompt.includes('private-own-control'));assert.equal(f.sidecar.state.deliveries['member_one:turn_one'].status,'sent');
});
test('an ambiguous native send is never silently replayed, including after a Sidecar restart',async t=>{
 const f=await fixture(t);f.setWork(true);f.setFailure(true);await f.sidecar.poll();await f.sidecar.poll();assert.equal(f.sends.length,1);assert.equal(f.sidecar.state.deliveries['member_one:turn_one'].status,'uncertain');await f.sidecar.stop();
 const next=await new AntigravitySidecar({stateFile:f.stateFile,native:f.native,clientFactory:()=>f.client,pollMs:3600000}).start();t.after(()=>next.stop());await next.poll();assert.equal(f.sends.length,1);assert.equal(next.bindings.get(id).sessionId,id);
});
test('disconnect removes only Hub access and never stops the original native Agent',async t=>{
 const f=await fixture(t);f.setWork(true);await f.sidecar.unbind(id);await f.sidecar.poll();assert.equal(f.sends.length,0);assert.equal((await f.sidecar.sessions()).items[0].id,id);assert.equal(f.sidecar.state.bindings.length,0);
 const state=JSON.parse(await fs.readFile(f.stateFile));const r=await fetch(state.controlUrl+'/tool',{method:'POST',headers:{Authorization:'Bearer '+state.controlToken,'Content-Type':'application/json'},body:JSON.stringify({sessionId:id,operation:'call',name:'post_message'})});assert.equal(r.status,400);
});
test('concurrent native binds cannot give one original conversation two Hub identities',async t=>{
 const f=await fixture(t);f.sidecar.clientFactory=()=>({...f.client,credentials:async()=>({memberId:'member_two'})});await assert.rejects(f.sidecar.bind({sessionId:id,workspace:f.dir,grantFile:f.grantFile}),/另一项连接/);assert.equal(f.sidecar.bindings.get(id).memberId,'member_one');
});
test('the combined native claim command still performs the real member list and claim and cannot claim another message',async t=>{
 const f=await fixture(t),state=JSON.parse(await fs.readFile(f.stateFile));
 const call=async name=>fetch(state.controlUrl+'/tool',{method:'POST',headers:{Authorization:'Bearer '+state.controlToken,'Content-Type':'application/json'},body:JSON.stringify({sessionId:id,operation:'claim_step',name})});
 assert.equal((await call('wrong_step')).status,400);assert.equal(f.tools.filter(t=>t.name==='claim_work').length,0);
 assert.equal((await call('turn_one')).status,200);const claim=f.tools.find(t=>t.name==='claim_work');assert.equal(claim.args.stepId,'turn_one');assert.ok(claim.args.requestId.length>20);
});
test('native agentapi uses the inherited official binary and keeps native secrets out of arguments',async()=>{
 let call;const n=new AntigravityNative({env:{ANTIGRAVITY_AGENTAPI_EXE:'/official/language_server',ANTIGRAVITY_CSRF_TOKEN:'secret-native-value'},exec:async(...args)=>call=args});await n.send(id,'test');assert.deepEqual(call[1],['agentapi','send-message',id,'test']);assert.ok(!JSON.stringify(call.slice(0,2)).includes('secret-native-value'));
});

test('one desktop source routes two chat contexts without claiming another context or losing bindings on restart',async t=>{
 const f=await fixture(t),second='ed7e7e51-e0cf-492e-8413-f9e64828540e';let work=[{stepId:'b',channelId:'channel_b',status:'ready'}];
 f.native.summaries=async()=>Object.fromEntries([id,second].map(key=>[key,{summary:key,workspaces:[{workspaceFolderAbsoluteUri:'file://'+f.dir}],status:'CASCADE_RUN_STATUS_IDLE'}]));
 f.client.inbox=async()=>({work});f.client.tool=async name=>name==='list_work'?{work}:{ok:true};f.setWork(true);
 await f.sidecar.bind({sessionId:id,workspace:f.dir,grantFile:f.grantFile,channelIds:['channel_a'],verification:true});await f.sidecar.bind({sessionId:second,workspace:f.dir,grantFile:f.grantFile,channelIds:['channel_b'],verification:false});
 await f.sidecar.poll();assert.equal(f.sends.length,1);assert.equal(f.sends[0].session,second);
 const state=JSON.parse(await fs.readFile(f.stateFile));const wrong=await fetch(state.controlUrl+'/tool',{method:'POST',headers:{Authorization:'Bearer '+state.controlToken,'Content-Type':'application/json'},body:JSON.stringify({sessionId:id,operation:'claim_step',name:'b'})});assert.equal(wrong.status,400);
 work=[{stepId:'a',channelId:'channel_a',status:'ready'}];await f.sidecar.poll();assert.equal(f.sends[1].session,id);
 await f.sidecar.stop();const next=await new AntigravitySidecar({stateFile:f.stateFile,native:f.native,clientFactory:()=>f.client,pollMs:3600000}).start();t.after(()=>next.stop());assert.deepEqual(next.bindings.get(second).channelIds,['channel_b']);
});
