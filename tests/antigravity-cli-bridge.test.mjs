import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {installCliAttachment,cliHook,AntigravityCliHost,nativeHubScope} from '../local/antigravity-cli-bridge.mjs';

test('Antigravity CLI registration preserves existing hooks, is idempotent and rejects another account sharing this native login',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-cli-hook-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'.gemini/config/hooks.json');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify({existing:{SessionStart:[{hooks:[{type:'command',command:'original-hook'}]}]}}));
 const base=path.join(dir,'member-one');await installCliAttachment(base,{home:dir,env:{}});const first=await fs.readFile(file,'utf8');assert.equal(JSON.parse(first).existing.SessionStart[0].hooks[0].command,'original-hook');
 await installCliAttachment(base,{home:dir,env:{}});assert.equal(await fs.readFile(file,'utf8'),first);
 await assert.rejects(()=>installCliAttachment(path.join(dir,'member-two'),{home:dir,env:{}}),/另一成员/);assert.equal(await fs.readFile(file,'utf8'),first);
 assert.deepEqual(await cliHook(base,{toolCall:{name:'run_command'}},{env:{DUOLAWORK_MANAGED_CLI:'1'}}),{decision:'allow'});
});

test('live original CLI inventory and queue use only private authenticated loopback bridges',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-cli-queue-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',root=path.join(dir,'native-bridges/antigravity-cli');await fs.mkdir(root,{recursive:true});let sends=0;
 const server=http.createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer test-private-control');res.setHeader('Content-Type','application/json');if(req.url==='/health')res.end(JSON.stringify({ready:true}));else if(req.url==='/sessions')res.end(JSON.stringify({items:[{id,title:'原终端项目',workspace:dir,mode:'native-existing'}]}));else{let raw='';for await(const b of req)raw+=b;const p=JSON.parse(raw);assert.equal(p.sessionId,id);sends++;res.end(JSON.stringify({sent:true}));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 await fs.writeFile(path.join(root,id+'.json'),JSON.stringify({controlUrl:'http://127.0.0.1:'+server.address().port,controlToken:'test-private-control'}),{mode:0o600});
 const host=new AntigravityCliHost(dir);assert.equal(await host.attached(id),true);assert.equal((await host.sessions()).items[0].mode,'native-existing');await host.queue({sessionId:id,workspace:dir,prompt:'本轮真实消息'});assert.equal(sends,1);
 await fs.writeFile(path.join(root,id+'.json'),JSON.stringify({controlUrl:'https://outside.invalid',controlToken:'test-private-control'}));assert.equal(await host.attached(id),false);assert.equal(sends,1);
});

test('native injected Hub messages authorize only their current turn; a later human turn keeps original permissions',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-hook-scope-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',file=path.join(dir,'brain',id,'.system_generated/logs/transcript.jsonl');await fs.mkdir(path.dirname(file),{recursive:true});
 const input={conversationId:id,transcriptPath:file},env={ANTIGRAVITY_APP_DATA_DIR:dir};
 const rows=[{source:'USER_EXPLICIT',type:'USER_INPUT',content:'my original work'},{source:'SYSTEM',type:'SYSTEM_MESSAGE',content:'[Message] sender='+id+' content=DuolaWork collaboration step_one\nreal work'},{source:'MODEL',type:'PLANNER_RESPONSE',thinking:'not used'}];
 await fs.writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');assert.equal(await nativeHubScope(input,'step_one',env),true);assert.equal(await nativeHubScope(input,'step_other',env),false);
 await fs.appendFile(file,JSON.stringify({source:'USER_EXPLICIT',type:'USER_INPUT',content:'now work for me directly'})+'\n');assert.equal(await nativeHubScope(input,'step_one',env),false);
 assert.equal(await nativeHubScope({...input,conversationId:'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'},'step_one',env),false);
});

test('a completed Hub receipt retains native turn cleanup permissions, but a human follow-up does not',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-native-finish-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',file=path.join(dir,'brain',id,'.system_generated/logs/transcript.jsonl');await fs.mkdir(path.dirname(file),{recursive:true});
 const input={conversationId:id,transcriptPath:file,toolCall:{name:'run_command',args:{CommandLine:'git status'}}},env={ANTIGRAVITY_APP_DATA_DIR:dir};
 await fs.writeFile(file,JSON.stringify({source:'SYSTEM',type:'SYSTEM_MESSAGE',content:'[Message] sender='+id+' content=DuolaWork collaboration step_done\nfinish'})+'\n');
 await fs.writeFile(path.join(dir,'native-coding.json'),JSON.stringify({member_one:{engine:'antigravity-cli',enabled:true,permissionMode:'full',inFlight:null,nativeDeliveries:{step_done:{sessionId:id,status:'sent'}}}}));
 assert.equal((await cliHook(dir,input,{env})).decision,'auto_approve');
 await fs.writeFile(path.join(dir,'native-coding.json'),JSON.stringify({member_one:{engine:'antigravity-cli',enabled:true,permissionMode:'full',executions:{[id]:{nativeDeliveries:{step_done:{sessionId:id,status:'sent'}}}}}}));
 assert.equal((await cliHook(dir,input,{env})).decision,'auto_approve','Parallel native execution retains its own authorization');
 await fs.appendFile(file,JSON.stringify({source:'USER_EXPLICIT',type:'USER_INPUT',content:'my own next task'})+'\n');assert.equal((await cliHook(dir,input,{env})).decision,'allow');
});

test('automatic reattachment skips managed sessions and approves only the exact installed bootstrap command',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-native-reattach-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',file=path.join(dir,'brain',id,'.system_generated/logs/transcript.jsonl');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'');await fs.writeFile(path.join(dir,'runtime.json'),'{}');
 const input={conversationId:id,transcriptPath:file},env={ANTIGRAVITY_APP_DATA_DIR:dir};
 await fs.writeFile(path.join(dir,'native-coding.json'),JSON.stringify({member_one:{managedNativePid:process.pid,managedNativeSessionIds:[id]}}));assert.deepEqual(await cliHook(dir,input,{env}),{});
 await fs.writeFile(path.join(dir,'native-coding.json'),JSON.stringify({member_one:{executions:{[id]:{managedNativePid:process.pid,managedNativeSessionIds:[id]}}}}));assert.deepEqual(await cliHook(dir,input,{env}),{},'A parallel managed session must not attach a second receiver');
 await fs.writeFile(path.join(dir,'native-coding.json'),'{}');const output=await cliHook(dir,input,{env});assert.equal(output.injectSteps.length,1);
 const command=output.injectSteps[0].systemMessage.systemMessage.split('原样运行一次：')[1].split('。')[0];
 assert.equal((await cliHook(dir,{...input,toolCall:{name:'run_command',args:{CommandLine:command}}},{env})).decision,'auto_approve');
 assert.equal((await cliHook(dir,{...input,toolCall:{name:'run_command',args:{CommandLine:command+'; echo extra'}}},{env})).decision,'allow');
 assert.deepEqual(await cliHook(dir,{...input,transcriptPath:path.join(dir,'desktop/brain',id,'transcript.jsonl')},{env}),{});
});

test('managed background tools retain full Hub permission only for their exact live dispatch',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-managed-background-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',file=path.join(dir,'brain',id,'.system_generated/logs/transcript.jsonl');await fs.mkdir(path.dirname(file),{recursive:true});
 const input={conversationId:id,transcriptPath:file,toolCall:{name:'run_command',args:{CommandLine:'node hub-helper.mjs call post_message'}}},env={ANTIGRAVITY_APP_DATA_DIR:dir,DUOLAWORK_MANAGED_CLI:'1'};
 const member={memberId:'member_one',engine:'antigravity-cli',enabled:true,permissionMode:'full',executions:{[id]:{inFlight:{stepId:'turn_abc',key:'channel_one'},managedNativePid:process.pid,managedNativeSessionIds:[id]}}};
 await fs.writeFile(path.join(dir,'native-coding.json'),JSON.stringify({member_one:member}));
 await fs.writeFile(file,JSON.stringify({type:'USER_INPUT',content:'<USER_REQUEST>\n你是 Agent Hub 成员 member_one，使用原工具。本轮只处理 stepId=turn_abc，channelId=channel_one。\n</USER_REQUEST>'})+'\n'+JSON.stringify({type:'SYSTEM_MESSAGE',content:'native background task completed'})+'\n');
 assert.equal((await cliHook(dir,input,{env})).decision,'auto_approve');
 assert.equal((await cliHook(dir,input,{env:{ANTIGRAVITY_APP_DATA_DIR:dir}})).decision,'allow');
 member.executions[id].inFlight.stepId='other';await fs.writeFile(path.join(dir,'native-coding.json'),JSON.stringify({member_one:member}));assert.equal((await cliHook(dir,input,{env})).decision,'allow');
 member.executions[id].inFlight.stepId='turn_abc';await fs.writeFile(path.join(dir,'native-coding.json'),JSON.stringify({member_one:member}));
 await fs.appendFile(file,JSON.stringify({type:'USER_INPUT',content:'my own work now'})+'\n');assert.equal((await cliHook(dir,input,{env})).decision,'allow');
});

test('official Stop records background and fully-idle completion for the exact managed dispatch only',async t=>{
 const {readNativeCompletion}=await import('../local/native-completion.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'duolawork-native-stop-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',file=path.join(dir,'brain',id,'.system_generated/logs/transcript.jsonl');await fs.mkdir(path.dirname(file),{recursive:true});
 const input={conversationId:id,transcriptPath:file,fullyIdle:false,terminationReason:'model_stop'},env={ANTIGRAVITY_APP_DATA_DIR:dir,DUOLAWORK_MANAGED_CLI:'1'};
 await fs.writeFile(path.join(dir,'native-coding.json'),JSON.stringify({member_one:{memberId:'member_one',engine:'antigravity-cli',enabled:true,executions:{[id]:{inFlight:{stepId:'turn_stop',key:'channel_one'},managedNativePid:process.pid,managedNativeSessionIds:[id]}}}}));
 await fs.writeFile(file,JSON.stringify({type:'USER_INPUT',content:'<USER_REQUEST>\n你是 Agent Hub 成员 member_one，使用原工具。本轮只处理 stepId=turn_stop，channelId=channel_one。\n</USER_REQUEST>'})+'\n');
 assert.deepEqual(await cliHook(dir,input,{env}),{});assert.equal((await readNativeCompletion(dir,'member_one',id,'turn_stop')).fullyIdle,false);
 assert.equal(await readNativeCompletion(dir,'member_one',id,'another-turn'),null);
 await cliHook(dir,{...input,fullyIdle:true},{env});assert.equal((await readNativeCompletion(dir,'member_one',id,'turn_stop')).fullyIdle,true);
 await fs.appendFile(file,JSON.stringify({type:'USER_INPUT',content:'my own work'})+'\n');await cliHook(dir,input,{env});assert.equal((await readNativeCompletion(dir,'member_one',id,'turn_stop')).fullyIdle,true);
});

test('original CLI execution observation distinguishes idle from unknown, permission waiting and missing sessions',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dw-original-status-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',root=path.join(dir,'native-bridges/antigravity-cli');await fs.mkdir(root,{recursive:true});
 let items=[{id,running:false,nativeStatus:'CASCADE_RUN_STATUS_IDLE'}];
 const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer fixture');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({items}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 await fs.writeFile(path.join(root,id+'.json'),JSON.stringify({controlUrl:'http://127.0.0.1:'+server.address().port,controlToken:'fixture'}));
 const host=new AntigravityCliHost(dir),state=async()=>(await host.executionState({sessionId:id})).state;
 assert.equal(await state(),'idle');items=[{id,running:true,nativeStatus:'WAITING_FOR_PERMISSION'}];assert.equal(await state(),'running');
 items=[{id,running:false}];assert.equal(await state(),'unknown');items=[];assert.equal(await state(),'unreachable');
});
