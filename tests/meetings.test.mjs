import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './collaboration-helper.mjs';
import { conversationCommand, claimConversation, readChannel, conversationMaintenance } from '../cloud/collaboration/conversation.mjs';
import { meetingDetail, MEETING_MODES } from '../cloud/collaboration/meetings.mjs';
import { withConversationContext } from '../cloud/collaboration/inbox.mjs';
import { dispatchOne } from '../cloud/collaboration/dispatcher.mjs';
const owner={owner:true}, actor=memberId=>({memberId});
async function setup(t,mode='crosscheck') {
 const f=await fixture(t);let n=0;const now='2026-11-03T05:00:00.000Z';
 const send=(type,args={},who=owner,at=now)=>conversationCommand(f.repo,f.identity,who,{type,requestId:`meeting-test-${++n}`,...args},at);
 const channel=await send('channel.create',{name:'会议验收',memberIds:['grok','check'],coordinatorId:'grok'});
 const prepare=await send('channel.meeting',{channelId:channel.id,action:'prepare',body:'我想做点AI产品，但还没有想清楚。'});
 const meet=(action,args={},who=owner,at=now)=>send('channel.meeting',{channelId:channel.id,meetingId:prepare.id,action,...args},who,at);
 const claim=async mid=>claimConversation(f.repo,f.identity,actor(mid),{requestId:`claim-${++n}`,receiveNext:true,channelId:channel.id},now);
 const plan=async()=>{const c=await claim('grok');const p=await meet('plan',{title:'产品机会',goal:'澄清用户价值',deliverable:'候选方向与验证办法',mode,body:'先分别判断，再核查关键依据。',agenda:[{title:'需求是否成立'}]},actor('grok'));return p;};
 return {...f,send,meet,claim,plan,channel,prepare,now};
}
test('原生完成状态统一且不能绕过依据检查；结构化金额原样保存',async t=>{
 for(const status of ['supported','done','resolved','confirmed','completed']){
  const f=await setup(t);await f.plan();let m=await f.meet('start');
  const body='A=$30/10席，2×A=$60；B=$20/5席，3×B=$60，均超过$50。';
  await f.meet('opinion',{body,round:0,sourceVersion:1},actor('grok'));
  const opinion=(await f.repo.list('meeting_opinion',{parent:m.id}))[0];
  assert.equal(opinion.body,body);
  const answer={agendaId:m.agenda[0].id,body,status};
  await assert.rejects(f.meet('finish',{sourceVersion:1,summary:body,answers:[answer]},actor('grok')),e=>e.code==='evidence_required');
  m=await f.meet('finish',{sourceVersion:1,summary:body,answers:[{...answer,evidenceIds:[opinion.id]}]},actor('grok'));
  assert.equal(m.answers[0].status,'supported');assert.deepEqual(m.quality.unresolved,[]);assert.equal(m.summary,body);
 }
});
test('选择到时结束时，提前整理结果不会擅自散会或继续空转',async t=>{
 const f=await setup(t);let p=await f.plan();
 await f.meet('plan',{...p,title:p.title,body:p.organization,closure:'deadline',ownerMessageId:p.lastOwnerMessageId},actor('grok'));
 let m=await f.meet('start');
 m=await f.meet('finish',{sourceVersion:2,summary:'现有线索不足，保留问题等用户补充',answers:m.agenda.map(a=>({agendaId:a.id,body:'仍需访谈',status:'unresolved'}))},actor('grok'));
 assert.equal(m.status,'closing');assert.equal(m.summaryStatus,'provided');assert.equal(m.endedAt,undefined);
 const wakes=m.wakeCount;
 await conversationMaintenance(f.repo,f.identity,'2026-11-03T05:09:00.000Z');
 assert.equal((await f.repo.get('channel_meeting',m.id)).wakeCount,wakes);
 await conversationMaintenance(f.repo,f.identity,'2026-11-03T05:10:01.000Z');
 m=await f.repo.get('channel_meeting',m.id);
 assert.equal(m.status,'ended');assert.equal(m.endReason,'deadline');assert.equal(m.summary,'现有线索不足，保留问题等用户补充');
});
test('多轮筹备只有负责人收到，真实安排产生后再开始，原群及登录不变',async t=>{
 const f=await setup(t);
 assert.equal(f.prepare.status,'preparing');assert.equal(f.prepare.durationSeconds,600);
 assert.deepEqual((await f.repo.list('channel_turn')).map(t=>t.memberId),['grok']);
 const c=await f.claim('grok'),context=await withConversationContext(f.repo,f.identity,actor('grok'),c);
 assert(context.input.meeting.records.some(r=>r.body?.includes('还没有想清楚')));
 assert.equal((await readChannel(f.repo,f.identity,actor('check'),{channelId:f.channel.id})).messages.length,0);
 await f.meet('say',{body:'你更想先明确服务谁，还是比较几个方向？'},actor('grok'));
 await f.meet('say',{body:'先明确服务谁'});
 await f.plan();
 const m=await f.meet('start',{expectedVersion:1});
 assert.equal(m.status,'running');assert.equal(m.deadlineAt,'2026-11-03T05:10:00.000Z');assert.equal(m.closingAt,'2026-11-03T05:08:00.000Z');
 const same=await f.meet('start');assert.equal(same.id,m.id);
 assert.equal((await f.repo.list('channel_message')).filter(m=>m.type==='meeting_start').length,1);
 assert.equal((await f.repo.get('channel',f.channel.id)).coordinatorId,'grok');
 assert.equal((await f.repo.get('connection','grok')).status,'verified');
});
test('已认证领取补足冗余版本参数，完整正文与同群资料引用不被压缩或误拒',async t=>{
 const f=await setup(t);await f.plan();const m=await f.meet('start');await f.claim('grok');
 const doc=await f.send('channel.doc.create',{channelId:f.channel.id,title:'原始材料',body:'第一条实际发现：新消息触发对应成员，而非每次用户打开页面。'},actor('grok'));
 const body='## 这次讨论的结论\n可以参考的是让新消息自动到达负责处理的成员。\n\n例如资料更新后直接通知研究成员，而不是让用户反复提醒。这是建议，还没有验证提升。';
 const result=await f.meet('finish',{summary:body,answers:[{agendaId:m.agenda[0].id,body,status:'supported',evidenceIds:[doc.versionId]}]},actor('grok'));
 assert.equal(result.summary,body);assert.equal(result.status,'ended');assert.equal((await f.repo.get('meeting_result',m.id)).sourceVersion,1);
});
test('用户会后要求解释时仅唤醒负责人，原文留版本，不重开会议或把迟到稿当修订',async t=>{
 const f=await setup(t);await f.plan();let m=await f.meet('start');
 m=await f.meet('finish',{sourceVersion:1,summary:'原有缩略结果',answers:m.agenda.map(a=>({agendaId:a.id,body:'尚待说明'}))},actor('grok'));
 await assert.rejects(f.meet('revise_result',{ownerMessageId:'fake',summary:'擅自覆盖'},actor('grok')),e=>e.code==='revision_not_requested');
 await assert.rejects(f.meet('request_revision',{},actor('check')),e=>e.code==='forbidden');
 const revised=await f.meet('request_revision',{body:'请解释具体发现和理由，不要只列术语。'});
 const claim=await f.claim('grok');assert.equal(claim.input.meetingId,m.id);
 const context=await withConversationContext(f.repo,f.identity,actor('grok'),claim);assert.match(context.input.meeting.instruction,/界面不会替你改写/);
 assert.equal(context.input.meeting.meeting.summary,'原有缩略结果');
 assert(context.input.meeting.records.filter(r=>r.kind==='meeting_result').every(r=>r.summary===undefined),'接单上下文不重复传输结果正文');
 assert(context.input.meetings.every(r=>r.summary===undefined),'其他会议仅提供可读取目录，不塞入全部历史结果');
 assert((await meetingDetail(f.repo,f.identity,owner,{meetingId:m.id})).records.some(r=>r.kind==='meeting_result'&&r.summary==='原有缩略结果'),'按需读取保留原文');
 const result=await f.meet('revise_result',{ownerMessageId:revised.revisionRequestId,summary:'完整的解释正文：让新资料主动到达相关成员，减少用户反复提醒。',answers:m.agenda.map(a=>({agendaId:a.id,body:'事件触发相关成员；效果仍待实际使用验证',status:'partial'}))},actor('grok'));
 assert.equal(result.status,'ended');assert.equal(result.endedAt,m.endedAt);assert.equal(result.wakeCount,m.wakeCount);assert.equal(result.revisionStatus,'completed');
 assert((await f.repo.list('meeting_result',{parent:m.id})).some(r=>r.status==='superseded'&&r.summary==='原有缩略结果'));
 await f.meet('finish',{sourceVersion:1,summary:'迟到的旧稿',answers:m.agenda.map(a=>({agendaId:a.id,body:'旧回应'}))},actor('grok'));
 assert.match((await f.repo.get('meeting_result',m.id)).summary,/完整的解释正文/);
});
for(const mode of Object.keys(MEETING_MODES))test(`${mode}：独立提交、公开互核和逐项总结完整闭环`,async t=>{
 const f=await setup(t,mode);await f.plan();let m=await f.meet('start');
 for(let round=0;round<MEETING_MODES[mode].stages.length;round++){
  const members=mode==='redblue'?(round===1?['check']:['grok']):['grok','check'];
  for(const mid of members){
   const c=await f.claim(mid);assert(c.turnId);
   if(round>0)await f.meet('review',{claim:'是否存在付费需求',method:'对照原始访谈与价格页',finding:'资料有付费例子，但样本不足',sources:['https://example.com/interview'],sourceVersion:1},actor(mid));
   await f.meet('opinion',{round,sourceVersion:1,body:`${mid} 第${round}轮：有依据的意见及未解决问题`,sources:['https://example.com/interview']},actor(mid));
   if(round===0&&members.length===2&&mid==='grok'){
    const d=await meetingDetail(f.repo,f.identity,actor('check'),{meetingId:m.id});assert(!JSON.stringify(d.records).includes('grok 第0轮'));
    assert(!(await readChannel(f.repo,f.identity,actor('check'),{channelId:f.channel.id})).messages.some(x=>x.body.includes('grok 第0轮')));
   }
  }
 }
 m=await f.repo.get('channel_meeting',m.id);assert.equal(m.status,'closing');
 await f.claim('grok');
 await f.meet('finish',{sourceVersion:1,summary:'存在需求线索，仍需补足样本。',answers:m.agenda.map(a=>({agendaId:a.id,body:'有初步证据，不能据此断言市场已验证',status:'partial',dissent:'样本代表性待查'}))},actor('grok'));
 const d=await meetingDetail(f.repo,f.identity,owner,{meetingId:m.id});assert.equal(d.meeting.status,'ended');assert.equal(d.meeting.summaryStatus,'provided');assert(d.records.some(r=>r.kind==='meeting_result'));assert(d.records.some(r=>r.kind==='meeting_review'));
 assert.equal((await f.repo.list('channel_message')).filter(x=>x.type==='meeting_end').length,1);
});
test('负责人失联仍自动收尾到期归档；停止后新派发和迟到覆盖均被阻止',async t=>{
 const f=await setup(t);await f.plan();const m=await f.meet('start');
 await conversationMaintenance(f.repo,f.identity,'2026-11-03T05:08:01.000Z');
 assert.equal((await f.repo.get('channel_meeting',m.id)).status,'closing');
 await conversationMaintenance(f.repo,f.identity,'2026-11-03T05:10:01.000Z');
 assert.equal((await f.repo.get('channel_meeting',m.id)).status,'ended');
 assert.equal((await f.repo.get('channel_meeting',m.id)).summaryStatus,'missing');
 const notices=await f.repo.list('outbox');assert(!notices.some(n=>['pending','awaiting_poll','retry'].includes(n.status)));
 await f.meet('finish',{sourceVersion:1,summary:'迟到总结',answers:m.agenda.map(a=>({agendaId:a.id,body:'迟到回答'}))},actor('grok'),'2026-11-03T05:11:00.000Z');
 assert.equal((await f.repo.get('meeting_result',m.id)).summary,'');
});
test('议题更新保留版本，旧回复标为迟到；跨群越权、未确认开会和伪造意见被拒',async t=>{
 const f=await setup(t);await f.plan();
 await assert.rejects(f.meet('start',{},actor('grok')),e=>e.code==='start_not_confirmed');
 let m=await f.meet('start');const old=await f.claim('check');
 await f.meet('agenda',{expectedVersion:1,agenda:[{...m.agenda[0],title:'先研究教育需求'}],goal:'教育需求'},actor('grok'));
 const late=await f.meet('opinion',{sourceVersion:1,round:0,body:'旧方向的观点'},actor('check'));assert(late.late);
 assert(!(await meetingDetail(f.repo,f.identity,actor('grok'),{meetingId:m.id})).records.some(r=>r.body==='旧方向的观点'));
 await assert.rejects(f.meet('opinion',{sourceVersion:2,round:0,body:'用户冒充Agent'}),e=>e.code==='member_required');
 await f.meet('stop');
 const view=await readChannel(f.repo,f.identity,owner,{channelId:f.channel.id});assert(view.messages.some(r=>r.type==='meeting_end'));
 const before=(await f.repo.list('channel_meeting')).length;
 await f.send('channel.post',{channelId:f.channel.id,body:'文章引用：“结束会议”。'});assert.equal((await f.repo.list('channel_meeting')).length,before);
});

test('负责人已领取后用户又补充，旧计划不能冒充理解了最新要求',async t=>{
 const f=await setup(t);await f.claim('grok');
 await f.meet('say',{body:'改为先研究教育领域'});
 await assert.rejects(f.meet('plan',{title:'旧方向',goal:'旧目标',deliverable:'旧交付',mode:'crosscheck',body:'先按旧方向',agenda:[{title:'旧问题'}]},actor('grok')),e=>e.code==='new_owner_input');
 const d=await meetingDetail(f.repo,f.identity,actor('grok'),{meetingId:f.prepare.id});
 await f.meet('plan',{ownerMessageId:d.meeting.lastOwnerMessageId,title:'教育方向',goal:'教育需求',deliverable:'需求假设',mode:'crosscheck',body:'按新要求',agenda:[{title:'教育用户是谁'}]},actor('grok'));
 await f.meet('say',{body:'最后只要一个最值得验证的问题'});
 await assert.rejects(f.meet('start'),e=>e.code==='new_owner_input');
});

test('筹备的明确开始指令沿用已确认版本；文章引用不会开始或停止',async t=>{
 const f=await setup(t);await f.plan();
 await f.meet('say',{body:'就这样开'});const c=await f.claim('grok');
 const m=await f.meet('start',{},actor('grok'));assert.equal(m.status,'running');
 await f.send('channel.post',{channelId:f.channel.id,meetingId:m.id,body:'引用文章：“停止会议”。这个设计有参考价值吗？'});
 assert.equal((await f.repo.get('channel_meeting',m.id)).status,'running');
 await f.send('channel.post',{channelId:f.channel.id,meetingId:m.id,body:'结束这场会议'});
 assert.equal((await f.repo.get('channel_meeting',m.id)).status,'ended');
});

test('负责人可在剩余预算内定向补查；预算耗尽后不增加自动调用',async t=>{
 const f=await setup(t);await f.plan();let m=await f.meet('start');
 await f.meet('investigate',{body:'上轮缺少付费证据，请核对实际购买记录',memberIds:['check']},actor('grok'));
 m=await f.repo.get('channel_meeting',m.id);assert.equal(m.phase,'定向补查');assert.equal(m.round,1);
 await f.repo.transact('budget-fixture',{},async tx=>{const row=await tx.get('channel_meeting',m.id);tx.put('channel_meeting',{...row,wakeCount:row.maxWakeups-1});return{};});
 await f.meet('investigate',{body:'继续核实',memberIds:['check']},actor('grok'));
 const current=await f.repo.get('channel_meeting',m.id);assert(current.wakeCount<=current.maxWakeups);
 const count=(await f.repo.list('outbox')).length;
 await f.meet('stop');
 await conversationMaintenance(f.repo,f.identity,'2026-11-03T05:20:00.000Z');assert.equal((await f.repo.list('outbox')).length,count);
});

test('同一事务超过100条记录能完整分页，外部组员不能读取筹备或未公开意见',async t=>{
 const f=await setup(t);
 await assert.rejects(meetingDetail(f.repo,f.identity,actor('write'),{meetingId:f.prepare.id}),e=>e.code==='forbidden');
 await f.repo.transact('history-fixture',{},async tx=>{for(let i=0;i<121;i++)tx.put('meeting_preparation',{id:'history_'+String(i).padStart(4,'0'),scopeId:f.channel.id,parentId:f.prepare.id,authorId:'owner',body:'历史'+i,createdAt:tx.now});return{};});
 const first=await meetingDetail(f.repo,f.identity,owner,{meetingId:f.prepare.id});assert(first.nextCursor);assert.equal(first.records.length,100);
 const second=await meetingDetail(f.repo,f.identity,owner,{meetingId:f.prepare.id,cursor:first.nextCursor});assert.equal(new Set([...first.records,...second.records].map(r=>r.id)).size,122);
 await assert.rejects(meetingDetail(f.repo,f.identity,owner,{meetingId:f.prepare.id,cursor:'invalid'}),e=>e.code==='invalid_cursor');
});

test('交付必须逐项回应并引用本场证据，错误引用和跨群会议均被拒绝',async t=>{
 const f=await setup(t);await f.plan();const m=await f.meet('start');
 await assert.rejects(f.meet('finish',{sourceVersion:1,summary:'已经完成',answers:[]},actor('grok')),e=>e.code==='answers_required');
 await assert.rejects(f.meet('finish',{sourceVersion:1,summary:'已有证据',answers:[{agendaId:m.agenda[0].id,body:'确认成立',status:'supported',evidenceIds:['fake-evidence']}]},actor('grok')),e=>e.code==='invalid_evidence');
 const other=await f.send('channel.create',{name:'另一群',memberIds:['grok','check']});
 await assert.rejects(f.send('channel.meeting',{channelId:other.id,meetingId:m.id,action:'stop'}),e=>e.code==='forbidden');
});

test('原生接收器换请求编号重复回传同一筹备回复，仅保存一次',async t=>{
 const f=await setup(t);const turn=await f.claim('grok');
 await f.send('channel.post',{channelId:f.channel.id,turnId:turn.turnId,body:'先澄清最重要的一个问题。'},actor('grok'));
 await f.send('channel.post',{channelId:f.channel.id,turnId:turn.turnId,body:'先澄清最重要的一个问题。'},actor('grok'));
 const rows=(await meetingDetail(f.repo,f.identity,owner,{meetingId:f.prepare.id})).records.filter(r=>r.kind==='meeting_preparation'&&r.authorId==='grok');assert.equal(rows.length,1);
});

test('用户换本场负责人、延长与接续保留原群设置和版本，原负责人的迟到总结不覆盖',async t=>{
 const f=await setup(t);await f.plan();let m=await f.meet('start');
 await f.claim('grok');
 m=await f.meet('coordinator',{coordinatorId:'check'});assert.equal(m.coordinatorId,'check');assert.equal((await f.repo.get('channel',f.channel.id)).coordinatorId,'grok');
 await f.meet('finish',{sourceVersion:1,summary:'原负责人的旧结论'},actor('grok'));
 assert.equal((await f.repo.get('channel_meeting',m.id)).summary,undefined);
 m=await f.meet('extend',{durationSeconds:300});assert.equal(m.deadlineAt,'2026-11-03T05:15:00.000Z');assert(m.version>1);
 await assert.rejects(f.meet('coordinator',{coordinatorId:'grok'},actor('check')),e=>e.code==='forbidden');
});

test('用户会议插话优先送给负责人，旧阶段推进不会丢掉新要求',async t=>{
 const f=await setup(t);await f.plan();const m=await f.meet('start');
 await f.send('channel.post',{channelId:f.channel.id,meetingId:m.id,body:'先别讨论功能，改为看教育用户需求。'});
 const c=await f.claim('grok');const turn=await f.repo.get('channel_turn',c.turnId);assert.equal(turn.meetingPurpose,'user_update');
 await f.send('channel.post',{channelId:f.channel.id,turnId:c.turnId,body:'收到，我会先调整议题和目标。'},actor('grok'));
 const current=await f.repo.get('channel_meeting',m.id);assert.equal(current.latestOwnerDirectiveId,current.ackOwnerMessageId);
});
