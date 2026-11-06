import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {NativeRpc} from '../local/native-agent.mjs';
import {claimNativeAssignment} from '../local/session-routing.mjs';

test('dynamic native tools use the assigned session, preserve full-context refresh, and reject foreign work before transport',async()=>{
 const calls=[],client={tool:async(name,args)=>{calls.push({name,args});return{turnId:'claimed'};}},active={key:'channel_a',stepId:'turn_message_member'};
 await claimNativeAssignment(client,{active,sessionId:'native-a',args:{requestId:'one',stepId:active.stepId,expectedSessionId:'forged',contextMode:'full'}});
 assert.deepEqual(calls,[{name:'claim_work',args:{requestId:'one',stepId:active.stepId,channelId:'channel_a',expectedSessionId:'native-a',contextMode:'full'}}]);
 await assert.rejects(()=>claimNativeAssignment(client,{active,sessionId:'native-a',args:{stepId:active.stepId,channelId:'channel_b'}}),/其他聊天/);
 await assert.rejects(()=>claimNativeAssignment(client,{active,sessionId:'native-a',args:{stepId:'turn_other'}}),/不是本次/);
 assert.equal(calls.length,1);
});

test('real ACP MCP subprocess forwards one scoped claim with native context and rejects a foreign native identity',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'native-mcp-scope-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const calls=[];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;calls.push({url:req.url,args:JSON.parse(raw)});res.setHeader('content-type','application/json');res.end(JSON.stringify({turnId:'claimed'}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const grant=path.join(dir,'grant.json'),records=path.join(dir,'records.json');
 await fs.writeFile(grant,JSON.stringify({endpoint:'http://127.0.0.1:'+server.address().port,memberId:'fixture',access_token:'isolated-fixture'}),{mode:0o600});
 await fs.writeFile(records,JSON.stringify({fixture:{enabled:true,engine:'antigravity-cli',executions:{'native-a':{executionSessionId:'native-a',inFlight:{key:'channel_a',stepId:'turn_message_member'}}}}}),{mode:0o600});
 const rpc=new NativeRpc({command:process.execPath,args:[path.resolve('local/coding-mcp.mjs'),grant,records,'fixture','native-a'],cwd:dir,env:process.env});t.after(()=>rpc.stop());
 await rpc.call('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});
 const params={name:'claim_work',arguments:{requestId:'one',stepId:'turn_message_member',channelId:'channel_a'},_meta:{'antigravity.google/root_conversation_id':'native-a'}};
 const first=await rpc.call('tools/call',params);assert.equal(first.isError,undefined);assert.equal(calls.length,1);assert.equal(calls[0].url,'/v2/tools/claim_work');assert.equal(calls[0].args.expectedSessionId,'native-a');assert.equal(calls[0].args.contextMode,'incremental');
 const denied=await rpc.call('tools/call',{...params,_meta:{'antigravity.google/root_conversation_id':'native-b'}});assert.equal(denied.isError,true);assert.equal(calls.length,1);
});
