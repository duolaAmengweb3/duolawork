import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand} from '../cloud/collaboration/conversation.mjs';
import {responseMetrics} from '../cloud/collaboration/response-metrics.mjs';
test('response stages remain scoped, retain incomplete samples and never fabricate model usage',async t=>{
 const f=await fixture(t),channel=await conversationCommand(f.repo,f.identity,{owner:true},{requestId:'metrics-channel',type:'channel.create',name:'Metrics',memberIds:['grok','check']});
 await f.repo.transact('metrics-samples',{},tx=>{
  tx.put('channel_turn',{id:'t1',scopeId:channel.id,parentId:'grok',memberId:'grok',status:'done',createdAt:'2026-11-07T00:00:00Z',claimedAt:'2026-11-07T00:00:02Z',completedAt:'2026-11-07T00:00:05Z'});
  tx.put('channel_turn',{id:'t2',scopeId:channel.id,parentId:'check',memberId:'check',status:'ready',createdAt:'2026-11-07T00:00:00Z'});
  tx.put('context_metrics',{id:'t1',scopeId:channel.id,parentId:'grok',prepareMs:4});
 });
 const owner=await responseMetrics(f.repo,{owner:true},{channelId:channel.id});assert.equal(owner.samples.length,2);
 const done=owner.samples.find(x=>x.turnId==='t1');assert.equal(done.saveToClaimMs,2000);assert.equal(done.claimToReceiptMs,3000);assert.equal(done.context.prepareMs,4);assert.equal(done.modelTokens,null);assert.equal(done.firstUsefulReplyMs,null);
 assert.equal(owner.samples.find(x=>x.turnId==='t2').totalMs,null);
 assert.equal((await responseMetrics(f.repo,{memberId:'check'},{channelId:channel.id})).samples.length,1);
 await assert.rejects(responseMetrics(f.repo,{memberId:'write'},{channelId:channel.id}),e=>e.code==='forbidden');
});
