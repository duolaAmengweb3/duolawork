import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {fixture} from '../tests/collaboration-helper.mjs';
import {conversationCommand} from '../cloud/collaboration/conversation.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';
import {registerExecutionBindings} from '../cloud/collaboration/execution-bindings.mjs';
const cleanup=[],f=await fixture({after:fn=>cleanup.push(fn)}),actor={memberId:'grok'};f.identity.members.find(m=>m.id==='grok').platformId='codex';let n=0;
const send=(type,args,who={owner:true})=>conversationCommand(f.repo,f.identity,who,{requestId:'measure-'+(++n),type,...args});
const c=await send('channel.create',{name:'isolated context measurement',memberIds:['grok','check']});
await registerExecutionBindings(f.repo,f.identity,actor,{requestId:'metric-native',bindings:[{channelId:c.id,sessionId:'isolated-native'}]});
const initial=await send('channel.post',{channelId:c.id,body:'只做方案，今天不要部署；预算800。',mentions:['grok']});
for(let i=0;i<35;i++)await send('channel.post',{channelId:c.id,replyTo:initial.id,body:'研究依据'+i+'：'+('有版本的依据与反例，不应替代用户要求。'.repeat(150)),mentions:[]},{memberId:'check'});
const measurements=[];
for(let i=0;i<12;i++){
 const mode=i%3===0?'full':'incremental',input=await send('channel.post',{channelId:c.id,body:i%3===2?'更正：预算700，其他要求不变。':'请继续当前工作。',mentions:['grok']});
 const start=performance.now(),claim=await callTool(f.repo,f.identity,actor,'receive_messages',{requestId:'metric-claim-'+i,channelId:c.id,expectedSessionId:'isolated-native',contextMode:mode},{});
 assert.ok(claim.input.messages.some(m=>m.body.includes('今天不要部署')));assert.ok(claim.input.messages.some(m=>m.id===input.id));if(i>=2)assert.ok(claim.input.messages.some(m=>m.body.includes('预算700')));
 measurements.push({iteration:i,requestedMode:mode,historyMode:claim.input.history.mode,totalClaimMs:Math.round(performance.now()-start),...claim.input.contextMetrics,ownerConstraintsRetained:true});
 await send('channel.post',{channelId:c.id,turnId:claim.turnId,body:'已读取本次全部要求。'},actor);
}
const report={at:new Date().toISOString(),environment:'isolated in-memory SQLite and actual context code; no model/network inference in these durations',measurements,nativeQualityEvidence:'tests/native-context.test.mjs plus prior native projects / multi-session artifacts; no downgrade or provider changes',modelCost:null};
await fs.writeFile('evidence/response-context-measurements.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(measurements));for(const fn of cleanup)await fn();
