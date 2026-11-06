import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './collaboration-helper.mjs';
import { conversationCommand, claimConversation, conversationWork, conversationTool } from '../cloud/collaboration/conversation.mjs';
import { pendingMemberActivity } from '../shared/chat-activity.mjs';

async function setup(t) {
  const f = await fixture(t); let seq = 0;
  const send = (type, args, actor = {owner:true}) => conversationCommand(f.repo, f.identity, actor, {type,requestId:'routing-'+(++seq),...args});
  const channel = await send('channel.create', {name:'定向沟通',memberIds:['grok','check'],coordinatorId:'grok'});
  const recipients = async m => (await f.repo.list('channel_turn')).filter(t => t.messageId === m.id).map(t => t.memberId).sort();
  return {...f,send,channel,recipients};
}

test('ordinary owner messages target the chosen coordinator, explicit mentions override it, and replacement applies immediately', async t => {
  const f = await setup(t), channelId = f.channel.id;
  assert.deepEqual(await f.recipients(await f.send('channel.post',{channelId,body:'帮我看一下'})),['grok']);
  assert.deepEqual(await f.recipients(await f.send('channel.post',{channelId,body:'只问另一个成员',mentions:['check']})),['check']);
  await f.send('channel.update',{channelId,coordinatorId:'check'});
  assert.deepEqual(await f.recipients(await f.send('channel.post',{channelId,body:'继续聊',mentions:[]})),['check']);
  assert.equal((await f.repo.list('channel_task')).length,0);
});

test('all-members is explicit, scoped, deduplicated and excludes the sending Agent', async t => {
  const f = await setup(t), channelId = f.channel.id;
  const m = await f.send('channel.post',{channelId,body:'大家看看',mentionAll:true,mentions:['grok']});
  assert.equal(m.mentionAll,true);
  assert.deepEqual(await f.recipients(m),['check','grok']);
  const w = (await conversationWork(f.repo,f.identity,'grok'))[0];
  const claim = await claimConversation(f.repo,f.identity,{memberId:'grok'},{requestId:'routing-claim',stepId:w.stepId});
  const reply = await conversationTool(f.repo,f.identity,{memberId:'grok'},'post_message',{requestId:'all-tool',channelId,body:'请大家补充',turnId:claim.turnId,mentionAll:true});
  assert.deepEqual(await f.recipients(reply),['check']);
  const quiet = await f.send('channel.post',{channelId,body:'先记下这一点',replyTo:m.id,mentions:[]},{memberId:'grok'});
  assert.deepEqual(await f.recipients(quiet),[]);
  await assert.rejects(f.send('channel.post',{channelId,body:'外人不应收到',mentions:['write'],mentionAll:true}),e=>e.code==='invalid_mention');
});

test('text alone never broadcasts; all-members requires the explicit action', async t => {
  const f = await setup(t),channelId=f.channel.id;
  assert.deepEqual(await f.recipients(await f.send('channel.post',{channelId,body:'@全员 请提出意见'})),['grok']);
  for (const body of ['`@全员` 是示例','> @全员 请注意','```\n@全员\n```','@全员名单不是提及'])
    assert.deepEqual(await f.recipients(await f.send('channel.post',{channelId,body})),['grok']);
});

test('a group without a coordinator never silently broadcasts; direct chats remain immediate', async t => {
  const f=await setup(t),channelId=f.channel.id;
  await f.send('channel.update',{channelId,coordinatorId:null});
  await assert.rejects(f.send('channel.post',{channelId,body:'普通消息'}),e=>e.code==='recipient_required');
  assert.equal((await f.repo.list('channel_message')).length,0);
  assert.deepEqual(await f.recipients(await f.send('channel.post',{channelId,body:'找你',mentions:['check']})),['check']);
  assert.deepEqual(await f.recipients(await f.send('channel.post',{channelId,body:'找大家',mentionAll:true})),['check','grok']);
  const dm=await f.send('channel.create',{name:'单聊',memberIds:['grok'],direct:true});
  assert.deepEqual(await f.recipients(await f.send('channel.post',{channelId:dm.id,body:'你好'})),['grok']);
});

test('a completed reply is not pending; a later queued message remains visible and is matched to its exact native delivery', () => {
  const done={id:'old',memberId:'codex',status:'done'},next={id:'new',memberId:'codex',status:'ready'};
  assert.deepEqual(pendingMemberActivity([done],[{stepId:'old',status:'accepted'}]),[]);
  let rows=pendingMemberActivity([done,next],[{stepId:'old',status:'accepted'}],[{memberId:'codex',pendingStepId:'other-channel',deliveryState:'sent'}]);
  assert.equal(rows[0].label,'1 条消息排队中');
  rows=pendingMemberActivity([done,next],[],[{memberId:'codex',pendingStepId:'new',deliveryState:'sent'}]);
  assert.equal(rows[0].label,'1 条消息排队中 · 已进入原会话');
  assert.deepEqual(rows[0].turnIds,['new']);
  assert.equal(pendingMemberActivity([done,{...next,status:'active',progress:'正在运行测试'}])[0].label,'处理中 · 正在运行测试');
});
