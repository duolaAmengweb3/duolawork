import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './collaboration-helper.mjs';
import {conversationCommand} from '../cloud/collaboration/conversation.mjs';
import {callTool} from '../cloud/collaboration/api.mjs';
import {registerExecutionBindings} from '../cloud/collaboration/execution-bindings.mjs';

test('native context advances only after a reply, keeps all user corrections and changed/trigger text, and restores exact originals',async t=>{
 const f=await fixture(t);let n=0;const actor={memberId:'grok'};f.identity.members.find(m=>m.id==='grok').platformId='codex';
 const command=(type,args={},who={owner:true})=>conversationCommand(f.repo,f.identity,who,{type,requestId:'nc-'+(++n),...args});
 const g=await command('channel.create',{name:'context',memberIds:['grok','check']});
 const bind=id=>registerExecutionBindings(f.repo,f.identity,actor,{requestId:'bind-'+(++n),bindings:[{channelId:g.id,sessionId:id}]});await bind('native-A');
 const request=await command('channel.post',{channelId:g.id,body:'预算100元，不能改模型或登录。',mentions:['grok']});
 const peer=await command('channel.post',{channelId:g.id,replyTo:request.id,body:'证据和分歧：'+('完整引用内容。'.repeat(1000)),mentions:['grok']},{memberId:'check'});
 const receive=(id='native-A',contextMode='incremental')=>callTool(f.repo,f.identity,actor,'receive_messages',{requestId:'receive-'+(++n),channelId:g.id,expectedSessionId:id,contextMode},{});
 const reply=c=>command('channel.post',{channelId:g.id,turnId:c.turnId,body:'已核对该轮原文。'},actor);
 const first=await receive();assert.equal(first.input.history.mode,'full');assert.ok(first.input.messages.some(m=>m.id===peer.id));
 assert.equal((await f.repo.list('native_context_checkpoint')).length,0,'network delivery is not acknowledgement');await reply(first);
 assert.equal((await f.repo.list('native_context_checkpoint')).length,1);
 await command('channel.post',{channelId:g.id,body:'更正：预算80元，其他条件不变。',mentions:['grok']});
 const second=await receive();assert.equal(second.input.history.mode,'incremental');assert.ok(!second.input.messages.some(m=>m.id===peer.id));assert.ok(second.input.history.previouslyProvided.some(m=>m.id===peer.id));
 assert.ok(second.input.messages.some(m=>m.body.includes('预算100元')));assert.ok(second.input.messages.some(m=>m.body.includes('预算80元')));
 const restored=await callTool(f.repo,f.identity,actor,'read_channel',{channelId:g.id},{});assert.equal(restored.messages.find(m=>m.id===peer.id).body,peer.body);
 assert.ok(JSON.stringify(second.input).length<JSON.stringify(first.input).length,'unchanged evidence is referenced, never summarised by another model');await reply(second);
 await f.repo.transact('edit-evidence',{},async tx=>{const m=await tx.get('channel_message',peer.id);tx.put('channel_message',{...m,version:(m.version||1)+1,body:'纠正证据：必须保留独立异议。'});});
 await command('channel.post',{channelId:g.id,body:'核对新版本。',mentions:['grok']});const changed=await receive();assert.ok(changed.input.messages.some(m=>m.body==='纠正证据：必须保留独立异议。'));await reply(changed);
 await bind('native-B');await command('channel.post',{channelId:g.id,body:'交给新对话。',mentions:['grok']});const fresh=await receive('native-B');assert.equal(fresh.input.history.mode,'full');assert.ok(fresh.input.messages.some(m=>m.id===peer.id));await reply(fresh);
 await command('channel.post',{channelId:g.id,body:'上下文压缩后重新读取。',mentions:['grok']});const reset=await receive('native-B','full');assert.equal(reset.input.history.mode,'full');assert.ok(reset.input.messages.some(m=>m.id===peer.id));
});
