import { fail, id, required, digest } from './repository.mjs';
import {recordMemoryEvent} from './memory-context.mjs';

export const MEETING_MODES = {
  crosscheck: { name: '赛马互证', stages: ['独立判断', '交叉核验'] },
  redblue: { name: '红蓝攻防', stages: ['提出方案', '质疑检查', '回应修订'] },
  ideas: { name: '创意共创', stages: ['独立提出想法', '组合与筛选'] },
  decision: { name: '决策评审', stages: ['独立评议', '补证与取舍'] },
  retrospective: { name: '复盘改进', stages: ['事实与原因', '核验与改进'] },
};
const string = { type: 'string' };
export const MEETING_TOOLS = [{
  name: 'meeting',
  description: '真实会议工具。prepare筹备；say与负责人沟通；plan由负责人提出可修改的目标和交付；start按用户已确认安排开会；read读取本场；opinion提交本阶段独立意见；review登记具体核验；agenda调整议题；advance推进；finish由负责人写给用户可直接阅读的完整结果，answers写具体发现而非完成状态；stop停止。不要用普通群消息泄漏未公开意见。',
  inputSchema: { type: 'object', additionalProperties: false,
    properties: {
      requestId: string, channelId: string, meetingId: string, action: string,
      body: string, title: string, summary: string, goal: string, deliverable: string,
      coordinatorId: string, mode: { type: 'string', enum: Object.keys(MEETING_MODES) },
      memberIds: { type: 'array', items: string, maxItems: 30 },
      durationSeconds: { type: 'integer', minimum: 60, maximum: 7200 },
      expectedVersion: { type: 'integer' }, round: { type: 'integer' },
      sourceVersion: { type: 'integer' }, ownerMessageId: string, confirmationQuote: {type:'string',description:'负责人理解用户已明确同意按当前安排开始时，逐字引用最新用户筹备消息；与ownerMessageId一起记录确认来源，不得引用成员意见或旧消息。'},
      closure: { type: 'string', enum: ['coordinator', 'deadline'] },
      agenda: { type: 'array', maxItems: 20, items: { type: 'object', properties: { id: string, title: string, expected: string, status: string, replaces: { type: 'array', items: string } }, required: ['title'] } },
      answers: { type: 'array', maxItems: 20, items: { type: 'object', properties: { agendaId: string, body: string, status: {type:'string',description:'supported=有本场依据的结论；partial=部分回答；unresolved=尚未解决；disputed=仍有分歧。done/resolved/confirmed兼容为supported，同样必须附本场evidenceIds。'}, evidenceIds: { type: 'array', items: string }, dissent: string }, required: ['agendaId', 'body'] } },
      sources: { type: 'array', items: string, maxItems: 30 },
      claim: string, method: string, finding: string, opinionId: string, changeReason: string,
      before: { type: 'integer' }, cursor:string,
    }, required: ['requestId', 'channelId', 'action'],
  },
}];
const active = m => ['running', 'closing'].includes(m.status);
const host = (m, actor) => { if (!actor.owner && actor.memberId !== m.coordinatorId) fail('forbidden', '只有用户或本场负责人可以组织或收尾', 403); };
const access = (channel, actor) => { if (!actor.owner && !channel.memberIds.includes(actor.memberId)) fail('forbidden', '你不在这个群内', 403); };
const list = value => [...new Set(value || [])];
const answerStatus = value => {
  if (['supported','confirmed','done','resolved','completed'].includes(value)) return 'supported';
  if (['partial','disputed','unresolved'].includes(value)) return value;
  return 'unresolved';
};
const liveMember = (identity, mid) => identity.members.find(m => m.id === mid && m.status !== 'disabled' && !m.paused && identity.accounts.some(a => a.id === m.accountId && a.status !== 'disabled'));
const stamp = (tx, m, changes = {}) => tx.put('channel_meeting', { ...m, ...changes });
const due = (m, now) => active(m) && Date.parse(now) >= Date.parse(m.deadlineAt);
const phaseDue = (m, now) => m.status === 'running' && Date.parse(now) >= Date.parse(m.phaseDeadlineAt);
const setPhaseDeadline = (m, now) => new Date(Math.min(Date.parse(m.closingAt), Date.parse(now) + Math.max(1000, (Date.parse(m.closingAt) - Date.parse(now)) / Math.max(1, MEETING_MODES[m.mode].stages.length - m.round)))).toISOString();
const expectedMembers = m => m.phaseMembers || (m.mode === 'redblue' ? (m.round === 1 ? m.memberIds.filter(x => x !== m.coordinatorId) : [m.coordinatorId]) : m.memberIds);
export function publicMeeting(m, actor = { owner: true }) {
  if (m.status === 'preparing' && !actor.owner && actor.memberId !== m.coordinatorId && actor.memberId !== m.createdBy) return null;
  return m;
}
const ownerStart = body => /^(就这样开(?:吧)?|就这么开(?:吧)?|按这个开(?:吧)?|按这个开始(?:吧)?|开始|开始吧|开始会议|开始开会|开会吧|就这样开始(?:吧)?)[。！!\s]*$/u.test(body.trim());
const ownerStop = body => /^(停止本场会议|结束这场会议|停止会议|结束会议|这场会议先停|立刻停止本场会议|停止全部调用)[。！!\s]*$/u.test(body.trim());

async function release(tx, actor, cmd, helpers, channel) {
  let turn = cmd.turnId ? await tx.get('channel_turn', cmd.turnId, false) : null;
  if (!turn && actor.memberId) turn = (await tx.list('channel_turn', { scope: channel.id, parent: actor.memberId, status: 'active' })).find(t => t.meetingId === cmd.meetingId);
  if (turn && turn.meetingId === cmd.meetingId) {
    await helpers.finishTurn(tx, actor, turn.id, 'done');
    return {tool:'claim_work',stepId:'inbox:after:'+turn.id,afterTurnId:turn.id,channelId:channel.id,maxWaitSeconds:45,
      instruction:'本次已经交付。结束原生运行前，可立即用新requestId调用claim_work(stepId=此处inbox:after编号)，在同一次原生运行接住下一阶段或用户追问，最多等45秒；empty/busy即结束，不循环空跑、不重新领取旧通知。'};
  }
}
async function wake(tx, identity, channel, m, targets, body, helpers, { preparation = false, closing = false } = {}) {
  if (!preparation && (due(m, tx.now) || m.status === 'ended')) return [];
  const recipients = [];
  for (const mid of list(targets)) {
    const c = await tx.get('connection', mid, false);
    if (!liveMember(identity, mid) || c?.status !== 'verified') continue;
    if (!preparation && m.wakeCount >= m.maxWakeups - (closing ? 0 : 1)) break;
    recipients.push(mid);
    if (!preparation) m.wakeCount++;
  }
  if (!recipients.length) return [];
  const message = await helpers.channelMessage(tx, channel, { memberId: m.coordinatorId }, body, {
    type: 'meeting_signal', hidden: true, meetingId: m.id, meetingRound: m.round,
    meetingVersion: m.version, audienceIds: recipients, hops: 0,
    meetingStage: m.status, ownerMessageId:m.lastOwnerMessageId||null, meetingPurpose:preparation?'preparation':closing?'summary':'discussion',
  });
  for (const mid of recipients) await helpers.enqueue(tx, identity, channel, message, mid);
  stamp(tx, m);
  return recipients;
}
async function event(tx, channel, m, body, helpers, type = 'meeting_update') {
  return helpers.channelMessage(tx, channel, { memberId: m.coordinatorId }, body, { type, authorId:'system',meetingId: m.id, meetingVersion: m.version, hops: 0 });
}
async function cancelPending(tx, m, reason) {
  const turns = (await tx.list('channel_turn', { scope: m.scopeId })).filter(t => t.meetingId === m.id);
  for (const t of turns) {
    if(t.meetingPurpose==='user_update'&&!['本场会议已结束，不再自动派发','筹备已取消'].includes(reason))continue;
    if (['ready', 'limited', 'stalled', 'unavailable'].includes(t.status)) tx.put('channel_turn', { ...t, status: 'removed', reason });
    const notice = await tx.get('outbox', `notice_${t.id}`, false);
    if (notice && ['pending', 'retry', 'waiting_subscription', 'awaiting_poll', 'coalesced'].includes(notice.status)) tx.put('outbox', { ...notice, status: 'canceled', reason });
  }
}
async function end(tx, channel, m, helpers, reason, summary) {
  if (m.status === 'ended') return m;
  await cancelPending(tx, m, '本场会议已结束，不再自动派发');
  m.status = 'ended'; m.endedAt = tx.now; m.endReason = reason;
  if (summary !== undefined) m.summary = summary;
  m.summaryStatus = m.summary ? 'provided' : 'missing';
  const existing = await tx.get('meeting_result', m.id, false);
  if (!existing) tx.put('meeting_result', { id: m.id, scopeId: m.scopeId, parentId: m.id,
    agenda: m.agenda, answers: m.answers || [], summary: m.summary || '', sourceVersion: m.version,
    status: m.summary ? 'provided' : 'missing', createdAt: tx.now });
  stamp(tx, m);
  if(m.summary)await recordMemoryEvent(tx,channel,m,'meeting');
  await event(tx, channel, m, `会议结束：${m.title}\n${m.summary || '讨论记录已保存，负责人纪要尚未完成。'}\n结束原因：${{ deadline: '达到时限', stopped: '用户停止', completed: '负责人已交付', budget: '达到自动调用预算' }[reason] || reason}`, helpers, 'meeting_end');
  return m;
}
async function close(tx, identity, channel, m, helpers, reason = 'summary') {
  if (m.status !== 'running') return m;
  await cancelPending(tx, m, '已进入收尾，不再追加本轮讨论');
  m.status = 'closing'; m.phase = '负责人整理结果'; m.closingReason = reason;
  stamp(tx, m);
  await event(tx, channel, m, '正在收尾：负责人将按议题整理结论、依据和未解决问题。', helpers);
  const sent = await wake(tx, identity, channel, m, [m.coordinatorId], '请读取本场会议，按议题交付结果并结束。只请求一次总结；不能省略分歧或把缺席成员算作已回复。', helpers, { closing: true });
  if (!sent.length) return end(tx, channel, m, helpers, reason === 'budget' ? 'budget' : '负责人暂不可用');
  return m;
}
async function publish(tx, channel, m, opinions, helpers) {
  for (const o of opinions) {
    if (o.publishedAt) continue;
    o.publishedAt = tx.now; tx.put('meeting_opinion', o);
    await helpers.channelMessage(tx, channel, { memberId: o.authorId }, o.body, {
      type: 'meeting_opinion', meetingId: m.id, meetingRound: o.round,
      opinionId: o.id, sourceVersion: o.sourceVersion, sources: o.sources, hops: 0,
    });
  }
}
async function advance(tx, identity, channel, m, helpers, force = false) {
  if (m.status !== 'running') return m;
  if (due(m, tx.now)) return end(tx, channel, m, helpers, 'deadline');
  const opinions = (await tx.list('meeting_opinion', { parent: m.id })).filter(o => o.round === m.round && o.sourceVersion === m.version);
  const expected = expectedMembers(m);
  const complete = expected.every(mid => opinions.some(o => o.authorId === mid));
  if (!force && !complete && !phaseDue(m, tx.now)) return m;
  await publish(tx, channel, m, opinions, helpers);
  m.coverage = [...(m.coverage || []), { round: m.round, expected, submitted: opinions.map(o => o.authorId), at: tx.now }];
  if (m.round + 1 >= MEETING_MODES[m.mode].stages.length || Date.parse(tx.now) >= Date.parse(m.closingAt)) return close(tx, identity, channel, m, helpers);
  await cancelPending(tx, m, '已进入下一环节');
  m.round++; m.phase = MEETING_MODES[m.mode].stages[m.round];
  m.phaseDeadlineAt = setPhaseDeadline(m, tx.now);
  stamp(tx, m);
  await event(tx, channel, m, `进入${m.phase}。${complete ? '' : '上一环节部分成员未提交，已保留实际参与记录。'}`, helpers);
  const sent = await wake(tx, identity, channel, m, expectedMembers(m), '请阅读已公开意见，围绕关键事实、反例或可执行约束核验；使用 meeting(action="review") 保存实际检查，随后提交本阶段意见。改变原判断时填写原因，不强迫达成一致。', helpers);
  if (!sent.length) return close(tx, identity, channel, m, helpers, 'budget');
  return m;
}

export async function handleMeeting(tx, identity, actor, cmd, channel, helpers) {
  access(channel, actor);
  let m = cmd.meetingId ? await tx.get('channel_meeting', cmd.meetingId) : null;
  if (m && m.scopeId !== channel.id) fail('forbidden', '会议不属于本群', 403);
  if (m && !actor.owner && !m.memberIds?.includes(actor.memberId) && actor.memberId !== m.createdBy) fail('forbidden', '你不在本场会议中', 403);
  const action = cmd.action;
  if (['prepare', 'open'].includes(action)) {
    const coordinatorId = cmd.coordinatorId || channel.coordinatorId;
    if (!coordinatorId || !channel.memberIds.includes(coordinatorId)) fail('coordinator_required', '请为本场选择一位负责人，群设置不会改变');
    const c = await tx.get('connection', coordinatorId, false);
    if (!liveMember(identity, coordinatorId) || c?.status !== 'verified') fail('coordinator_unavailable', '负责人暂不可用，可选择本场组织者；原登录保留', 409);
    const memberIds = list(cmd.memberIds || channel.memberIds);
    if (!memberIds.length || !memberIds.includes(coordinatorId) || memberIds.some(mid => !channel.memberIds.includes(mid))) fail('invalid_member', '参会者及负责人应来自当前群');
    if (!actor.owner && !cmd.ownerMessageId) fail('owner_request_required', '代用户筹备请关联真实用户请求');
    if (cmd.ownerMessageId) { const origin = await tx.get('channel_message', cmd.ownerMessageId); if (origin.scopeId !== channel.id || origin.authorId !== 'owner') fail('forbidden', '必须关联本群真实用户消息', 403); }
    m = stamp(tx, { id: id('meeting'), scopeId: channel.id, parentId: channel.id,
      status: 'preparing', createdAt: tx.now, createdBy: actor.memberId || 'owner',
      coordinatorId, memberIds, title: cmd.title?.trim() || '会议筹备', goal: '', deliverable: '', agenda: [],
      version: 0, round: 0, wakeCount: 0, durationSeconds: 600, closure: 'coordinator',
      phase: '与负责人明确目标和交付', ownerMessageId: cmd.ownerMessageId || null,
    });
    if (cmd.body || cmd.ownerMessageId) {
      const body = actor.owner?(cmd.body || (await tx.get('channel_message', cmd.ownerMessageId)).body):(await tx.get('channel_message',cmd.ownerMessageId)).body;
      await preparationPost(tx, identity, actor.owner ? actor : { owner: true }, { ...cmd, meetingId: m.id, body }, channel, m, helpers);
    }
    return m;
  }
  if (!m) fail('meeting_required', '请指定本场会议');
  if (m.version === undefined) {
    if (action === 'close') return tx.put('channel_meeting',{...m,status:'closed',summary:required(cmd.summary,'会议结论',12000),endMessage:channel.messageSequence,closedBy:actor.memberId||'owner',closedAt:tx.now});
    fail('legacy_meeting', '这份旧讨论记录可回看；请另开新会议使用筹备与讨论能力', 409);
  }
  if (due(m, tx.now)) { await end(tx, channel, m, helpers, 'deadline'); if (!['stop', 'finish', 'opinion', 'review'].includes(action)) return m; }
  if (action === 'say') return preparationPost(tx, identity, actor, cmd, channel, m, helpers);
  if(action==='request_revision'){
    if(!actor.owner)fail('forbidden','只有用户可要求会后重新解释结果',403);
    if(m.status!=='ended')fail('meeting_active','会议尚未结束，请直接在群里补充要求');
    if(m.revisionStatus==='requested'&&m.revisionExpiresAt>tx.now)return m;
    const source=await helpers.channelMessage(tx,channel,actor,cmd.body||'这份结果我看不懂，请由负责人结合原始要求和讨论重新解释清楚。写出具体结论、理由和实际例子，不用术语列表或双方一致代替结果。',{meetingId:m.id,type:'message',hops:0});
    m.revisionRequestId=source.id;m.revisionStatus='requested';m.revisionExpiresAt=new Date(Date.parse(tx.now)+600000).toISOString();stamp(tx,m);
    const signal=await helpers.channelMessage(tx,channel,actor,'用户要求你重新解释已结束会议的交付。请保留会议原状态，读取原始需求、完整讨论和现有结果，通过meeting(action="revise_result",ownerMessageId=本次用户消息ID,summary,answers,sourceVersion,requestId)发布通俗、完整的修订正文；不重开会议、不召集其他成员。',{hidden:true,type:'meeting_signal',meetingId:m.id,meetingRound:m.round,meetingVersion:m.version,meetingStage:'ended',meetingPurpose:'result_revision',ownerMessageId:source.id,hops:0});
    await helpers.enqueue(tx,identity,channel,signal,m.coordinatorId);return m;
  }
  if (action === 'plan') {
    host(m, actor); if (m.status !== 'preparing') fail('meeting_started', '正式会议已经开始，请调整议题而不是重建筹备');
    if (!MEETING_MODES[cmd.mode]) fail('invalid_mode', '请选择可执行的组织方法');
    const duration = cmd.durationSeconds ?? m.durationSeconds;
    if(cmd.closure&&!['coordinator','deadline'].includes(cmd.closure))fail('invalid_closure','收尾方式无效');
    if (!Number.isInteger(duration) || duration < 60 || duration > 7200) fail('invalid_duration', '会议时长应为1分钟至2小时');
    const members = list(cmd.memberIds || m.memberIds);
    if (!members.includes(m.coordinatorId) || members.some(mid => !channel.memberIds.includes(mid))) fail('invalid_member', '参会成员不属于当前群');
    const agenda = cleanAgenda(cmd.agenda || [], m.agenda);
    if (!agenda.length) fail('agenda_required', '请把需要讨论的问题列出来');
    const claimed=(await tx.list('channel_turn',{scope:channel.id,parent:m.coordinatorId,status:'active'})).find(t=>t.meetingId===m.id);
    const basedOnOwnerMessageId=cmd.ownerMessageId||claimed?.claimedOwnerMessageId;
    if(!actor.owner&&m.lastOwnerMessageId&&basedOnOwnerMessageId!==m.lastOwnerMessageId)fail('new_owner_input','用户有新补充，请重读本场并按最新用户消息整理安排',409);
    const next = stamp(tx, m, { title: required(cmd.title, '会议议题', 200), goal: required(cmd.goal, '本场目标', 4000),
      deliverable: required(cmd.deliverable, '拟交付结果', 4000), agenda, mode: cmd.mode,
      closure: cmd.closure || 'coordinator', durationSeconds: duration, memberIds: members,
      organization: required(cmd.body, '用人话说明组织安排', 4000), version: m.version + 1, plannedAt: tx.now,plannedBy:actor.memberId||'owner',basedOnOwnerMessageId:m.lastOwnerMessageId });
    tx.put('meeting_plan_version', { ...next, id: id('meeting_plan'), parentId: m.id, createdAt: tx.now });
    await release(tx, actor, cmd, helpers, channel);
    return next;
  }
  if (action === 'start') {
    let semanticConfirmation=false;
    if(!actor.owner){
      host(m,actor);
      if(cmd.confirmationQuote&&cmd.ownerMessageId===m.lastOwnerMessageId){
        const confirmation=await tx.get('meeting_preparation',cmd.ownerMessageId);
        semanticConfirmation=confirmation.authorId==='owner'&&confirmation.parentId===m.id&&confirmation.body===cmd.confirmationQuote&&confirmation.createdAt>=m.plannedAt&&m.basedOnOwnerMessageId!==confirmation.id;
        if(semanticConfirmation)m.startConfirmation={messageId:confirmation.id,quote:confirmation.body,interpretedBy:actor.memberId,planVersion:m.version};
      }
      if(!semanticConfirmation&&(!m.startAuthorizedVersion||m.startAuthorizedVersion!==m.version))fail('start_not_confirmed','请先与用户确认本场安排；明确同意后引用最新用户原话作为确认来源，或由用户点击开始');
    }
    if (m.status !== 'preparing') { if (active(m)) return m; fail('meeting_ended', '会议已结束，请保留原记录后另开'); }
    if (!m.version || !m.goal || !m.deliverable) fail('plan_required', '负责人尚未提交本场目标、交付和组织安排，请继续沟通');
    if(!semanticConfirmation&&m.basedOnOwnerMessageId!==m.lastOwnerMessageId&&!ownerStart((await tx.get('meeting_preparation',m.lastOwnerMessageId)).body))fail('new_owner_input','负责人正在处理你的新补充，请等最新安排形成后再开始',409);
    if (cmd.expectedVersion !== undefined && cmd.expectedVersion !== m.version) fail('version_conflict', '筹备安排已变化，请查看最新安排后开始', 409);
    const available = [];
    for (const mid of m.memberIds) if (liveMember(identity, mid) && (await tx.get('connection', mid, false))?.status === 'verified') available.push(mid);
    if (!available.includes(m.coordinatorId)) fail('coordinator_unavailable', '负责人暂不可用，筹备记录保留', 409);
    if (available.length < 2) fail('participants_required', '多人会议至少需要两位已连接成员，现有筹备记录保留');
    m.unavailableMembers = m.memberIds.filter(mid => !available.includes(mid)); m.memberIds = available;
    m.status = 'running'; m.startedAt = tx.now; m.startedBy = actor.memberId || 'owner';
    m.startAuthorization = cmd.ownerMessageId || m.lastOwnerMessageId || 'owner-button';
    m.deadlineAt = new Date(Date.parse(tx.now) + m.durationSeconds * 1000).toISOString();
    m.closingAt = new Date(Date.parse(m.deadlineAt) - Math.min(120, m.durationSeconds * .2) * 1000).toISOString();
    m.maxWakeups = 3 * available.length + 2; m.phase = MEETING_MODES[m.mode].stages[0];
    m.phaseDeadlineAt = setPhaseDeadline(m, tx.now); stamp(tx, m);
    await event(tx, channel, m, `开始会议：${m.title}\n目标：${m.goal}\n交付：${m.deliverable}\n安排：${m.organization}\n总时长${Math.round(m.durationSeconds / 60)}分钟（含收尾）。`, helpers, 'meeting_start');
    await wake(tx, identity, channel, m, expectedMembers(m), '请读取本场会议，按当前议题独立形成意见。首轮意见先通过meeting(action="opinion")单独提交；公开前不要把意见写入公共群消息、共享文档或附件。', helpers);
    await release(tx, actor, cmd, helpers, channel); return m;
  }
  if (action === 'stop') {
    if (!actor.owner) host(m, actor);
    await release(tx, actor, cmd, helpers, channel);
    if (m.status === 'preparing') { m.status = 'ended'; m.endedAt = tx.now; m.endReason = '筹备取消'; await cancelPending(tx, m, '筹备已取消'); return stamp(tx, m); }
    return end(tx, channel, m, helpers, 'stopped');
  }
  if(action==='coordinator'||action==='extend'){
    if(!actor.owner)fail('forbidden','本场负责人和追加投入由用户决定',403);
    if(!active(m))fail('meeting_ended','本场已结束，原记录保留');
    await cancelPending(tx,m,'用户调整了本场安排');
    if(action==='coordinator'){
      const mid=cmd.coordinatorId;
      if(!m.memberIds.includes(mid)||!liveMember(identity,mid)||(await tx.get('connection',mid,false))?.status!=='verified')fail('invalid_member','请选择本场已连接成员接续');
      if(mid===m.coordinatorId)return m;
      m.formerCoordinators=list([...(m.formerCoordinators||[]),m.coordinatorId]);m.coordinatorId=mid;
      m.maxWakeups=Math.max(m.maxWakeups,m.wakeCount+2);
    }else{
      const extra=cmd.durationSeconds??300;
      if(!Number.isInteger(extra)||extra<60||extra>3600)fail('invalid_duration','每次可追加1至60分钟');
      m.durationSeconds+=extra;m.deadlineAt=new Date(Date.parse(m.deadlineAt)+extra*1000).toISOString();
      m.closingAt=new Date(Date.parse(m.deadlineAt)-Math.min(120,m.durationSeconds*.2)*1000).toISOString();
      m.maxWakeups+=3*m.memberIds.length+2;
    }
    m.version++;m.phaseDeadlineAt=setPhaseDeadline(m,tx.now);stamp(tx,m);
    tx.put('meeting_plan_version',{...m,id:id('meeting_plan'),parentId:m.id,createdAt:tx.now,reason:action==='coordinator'?'用户更换本场负责人':'用户延长本场'});
    await event(tx,channel,m,action==='coordinator'?'本场负责人已更换，原议题、讨论和群负责人保留；接续本场记录。':`用户延长了本场会议，最新截止时间为${m.deadlineAt}；原投入和讨论保留。`,helpers);
    await wake(tx,identity,channel,m,[m.coordinatorId],'用户调整了本场安排，请读取最新版本并接续。原有意见保留，不要从头重跑；可在剩余时间内安排investigate定向补查，或完成最新议题总结。',helpers,{closing:m.status==='closing'});
    return m;
  }
  if (action === 'agenda') {
    host(m, actor); if (!active(m)) fail('meeting_ended', '本场已经结束');
    if (cmd.expectedVersion !== m.version) fail('version_conflict', '议题已更新，请重读', 409);
    await cancelPending(tx,m,'用户要求或议题已有新版本');
    m.agenda = cleanAgenda(cmd.agenda || [], m.agenda); m.version++;
    if (cmd.goal !== undefined) m.goal = required(cmd.goal, '目标', 4000);
    if (cmd.deliverable !== undefined) m.deliverable = required(cmd.deliverable, '交付', 4000);
    m.ackOwnerMessageId=m.latestOwnerDirectiveId||null;
    stamp(tx, m); tx.put('meeting_plan_version', { ...m, id: id('meeting_plan'), parentId: m.id, createdAt: tx.now });
    await event(tx, channel, m, '议题安排已更新，后续讨论采用最新要求；旧意见和来源版本保留。', helpers);
    if(m.status==='running')await wake(tx,identity,channel,m,expectedMembers(m),'用户要求或议题已经更新，请按最新目标核查仍需处理的问题，旧版本回应不得冒充新要求已完成。',helpers);
    await release(tx,actor,cmd,helpers,channel);return m;
  }
  if(action==='investigate'){
    host(m,actor);if(!active(m))fail('meeting_ended','本场已结束');
    if(Date.parse(tx.now)>=Date.parse(m.closingAt))fail('closing_window','已经进入预留收尾时间，请整理已有结果');
    const targets=list(cmd.memberIds||m.memberIds);if(!targets.length||targets.some(mid=>!m.memberIds.includes(mid)))fail('invalid_member','补查只能使用本场已有参与者');
    const focus=required(cmd.body,'具体补查问题与上轮缺口',4000);
    await cancelPending(tx,m,'按负责人安排定向补查');
    m.status='running';m.round++;m.phase='定向补查';m.phaseMembers=targets;m.investigation=focus;m.phaseDeadlineAt=setPhaseDeadline(m,tx.now);stamp(tx,m);
    await event(tx,channel,m,`定向补查：${focus}`,helpers);
    await wake(tx,identity,channel,m,targets,'请根据本场investigation核验具体缺口，提交review和opinion；没有新证据可说明未找到，不凑轮数。',helpers);
    await release(tx,actor,cmd,helpers,channel);return m;
  }
  if (action === 'opinion') {
    if (!actor.memberId || !m.memberIds.includes(actor.memberId)) fail('member_required', '意见必须由参会成员自身提交', 403);
    const body = required(cmd.body, '完整意见', 24000);
    const priorKey=`${m.id}:${cmd.sourceVersion}:${cmd.round}:${actor.memberId}`,priorOpinion=await tx.get('meeting_opinion',priorKey,false);
    if(priorOpinion?.body===body){await release(tx,actor,cmd,helpers,channel);return {submitted:true,alreadySubmitted:true,opinionId:priorOpinion.id};}
    if (cmd.round !== m.round || cmd.sourceVersion !== m.version || m.status !== 'running') {
      const late = tx.put('meeting_opinion', { id: id('opinion'), scopeId: channel.id, parentId: m.id, body, authorId: actor.memberId, round: cmd.round ?? -1,
        sourceVersion: cmd.sourceVersion ?? -1, status: 'late', sources: cleanSources(cmd.sources), createdAt: tx.now, ...(m.status === 'ended' ? { publishedAt: tx.now } : {}) });
      await release(tx, actor, cmd, helpers, channel); return { recorded: true, late: true, opinionId: late.id };
    }
    if (!expectedMembers(m).includes(actor.memberId)) fail('wrong_stage', '当前阶段由其他成员先形成意见，请等待公开后回应', 409);
    const key = `${m.id}:${m.version}:${m.round}:${actor.memberId}`;
    const old = await tx.get('meeting_opinion', key, false);
    if (old && !cmd.changeReason) fail('change_reason_required', '修订已提交意见请说明新证据或修改原因');
    if (old) tx.put('meeting_opinion_history', { ...old, id: id('opinion_history'), parentId: m.id });
    tx.put('meeting_opinion', { id: key, scopeId: channel.id, parentId: m.id, authorId: actor.memberId, body, round: m.round,
      sourceVersion: m.version, sources: cleanSources(cmd.sources), changeReason: cmd.changeReason || null, status: 'submitted', createdAt: tx.now });
    const continuation=await release(tx, actor, cmd, helpers, channel);
    await advance(tx, identity, channel, m, helpers);
    return { submitted: true, meetingId: m.id, round: m.round, status: m.status,continuation };
  }
  if (action === 'review') {
    if (!actor.memberId) fail('member_required', '请由实际核验成员记录');
    const row = tx.put('meeting_review', { id: id('review'), scopeId: channel.id, parentId: m.id, authorId: actor.memberId,
      claim: required(cmd.claim, '具体待核验主张', 4000), method: required(cmd.method, '实际核验方法', 4000), finding: required(cmd.finding, '核验发现', 8000),
      opinionId: cmd.opinionId || null, sources: cleanSources(cmd.sources), sourceVersion: cmd.sourceVersion ?? m.version,
      round: m.round, status: active(m) ? 'recorded' : 'late', createdAt: tx.now });
    return { recorded: true, reviewId: row.id, note: '保存记录不等于系统已经独立证明事实正确' };
  }
  if (action === 'advance') { host(m, actor); return advance(tx, identity, channel, m, helpers); }
  if (action === 'finish' || action === 'close'||action==='revise_result') {
    const revising=action==='revise_result';
    if(revising&&(m.status!=='ended'||m.revisionStatus!=='requested'||cmd.ownerMessageId!==m.revisionRequestId||m.revisionExpiresAt<=tx.now))fail('revision_not_requested','需先由用户明确请求修订，原结果和会议状态保留',409);
    if(!actor.owner&&actor.memberId!==m.coordinatorId&&(m.formerCoordinators||[]).includes(actor.memberId)){
      const row=tx.put('meeting_result',{id:id('former_result'),scopeId:channel.id,parentId:m.id,summary:required(cmd.summary,'原负责人迟到总结',24000),answers:cmd.answers||[],authorId:actor.memberId,sourceVersion:cmd.sourceVersion??-1,status:'late',createdAt:tx.now});
      await release(tx,actor,cmd,helpers,channel);return {late:true,resultId:row.id,currentResultUnchanged:true};
    }
    host(m, actor);
    // Authenticated live claims already bind the agenda version. Reuse that
    // binding when an older native client omits redundant wire parameters;
    // never infer freshness merely from the current meeting or an expired turn.
    if(!actor.owner&&(action==='finish'||revising)&&(cmd.sourceVersion===undefined||cmd.round===undefined)){
      const claimed=(await tx.list('channel_turn',{scope:channel.id,parent:actor.memberId,status:'active'})).find(t=>t.meetingId===m.id&&t.expiresAt>tx.now);
      if(claimed)cmd={...cmd,sourceVersion:cmd.sourceVersion??claimed.meetingVersion,round:cmd.round??claimed.meetingRound};
      else if(cmd.sourceVersion===undefined)fail('version_required',`请保留完整总结和议题答案，补 sourceVersion=${m.version} 后重新提交；未结束本场，也不需要重写或压缩正文`,409);
    }
    const summary = required(cmd.summary, '基于实际讨论的总结', 24000);
    if(action==='finish'&&m.status!=='ended'&&(cmd.sourceVersion!==m.version||(cmd.round!==undefined&&cmd.round!==m.round))){
      const late=tx.put('meeting_result',{id:id('late_result'),scopeId:channel.id,parentId:m.id,summary,answers:cmd.answers||[],sourceVersion:cmd.sourceVersion??-1,round:cmd.round??-1,status:'late',createdAt:tx.now});
      await release(tx,actor,cmd,helpers,channel);return {late:true,resultId:late.id,currentResultUnchanged:true};
    }
    if(action==='finish'&&m.latestOwnerDirectiveId&&m.ackOwnerMessageId!==m.latestOwnerDirectiveId&&cmd.ownerMessageId!==m.latestOwnerDirectiveId)fail('new_owner_input','用户有新要求，请先读取并处理，再按最新上下文收尾',409);
    const submittedAnswers = cmd.answers || [];
    if(!Array.isArray(submittedAnswers)||submittedAnswers.length>20||submittedAnswers.some(a=>!a||typeof a!=='object'))fail('invalid_answers','议题回应列表无效');
    const answers=submittedAnswers.map(a=>({...a,status:answerStatus(a.status)}));
    const currentAgenda = m.agenda.filter(a => a.status !== 'canceled');
    if ((action === 'finish'||revising) && currentAgenda.some(a => !answers.some(x => x.agendaId === a.id && typeof x.body === 'string' && x.body.trim()))) fail('answers_required', '请逐项回应议题，未解决也要说明缺口');
    for (const answer of answers) {
      if (!m.agenda.some(a => a.id === answer.agendaId)) fail('invalid_agenda', '回答不属于本场议题'); required(answer.body, '议题回应', 12000);
      if(answer.status==='supported'&&!answer.evidenceIds?.length)fail('evidence_required','明确支持的结论需要关联本场真实意见或核验记录');
      for(const key of answer.evidenceIds||[]){
        const source=await tx.get('meeting_review',key,false)||await tx.get('meeting_opinion',key,false)||await tx.get('channel_doc',key,false)||await tx.get('channel_doc_version',key,false)||await tx.get('meeting_preparation',key,false);
        const meetingSource=source&&['meeting_review','meeting_opinion','meeting_preparation'].includes(source.kind);
        if(!source||source.scopeId!==channel.id||(meetingSource&&source.parentId!==m.id))fail('invalid_evidence','引用记录不属于本场会议或本群共享资料；请保留答案正文，仅修正引用编号');
      }
    }
    const allOpinions=await tx.list('meeting_opinion',{parent:m.id}), allReviews=await tx.list('meeting_review',{parent:m.id});
    const quality={actualParticipants:list(allOpinions.map(o=>o.authorId)),initialSubmissions:list(allOpinions.filter(o=>o.round===0&&o.sourceVersion===m.version).map(o=>o.authorId)),reviewCount:allReviews.filter(r=>r.sourceVersion===m.version).length,unresolved:answers.filter(a=>!['supported','confirmed'].includes(a.status)).map(a=>a.agendaId),note:'登记核验记录不等于系统已经独立证明事实；保留原文和证据供回看'};
    const latest = await tx.get('meeting_result', m.id, false);
    if(revising){
      if(cmd.sourceVersion!==m.version)fail('version_conflict','请按原会议当前版本解释，保留完整正文后修正来源版本',409);
      if(latest)tx.put('meeting_result',{...latest,id:id('prior_result'),status:'superseded',supersededAt:tx.now});
      tx.put('meeting_result',{id:m.id,scopeId:channel.id,parentId:m.id,summary,answers,quality,authorId:actor.memberId||'owner',sourceVersion:m.version,status:'provided',createdAt:tx.now,revisionOf:latest?.id||null});
      m.summary=summary;m.answers=answers;m.quality=quality;m.revisionStatus='completed';m.summaryRevisedAt=tx.now;stamp(tx,m);
      await recordMemoryEvent(tx,channel,m,'meeting');
      const continuation=await release(tx,actor,cmd,helpers,channel);
      await event(tx,channel,m,'负责人已按你的要求重新解释结果，原版和讨论记录均已保留。',helpers,'meeting_result_update');
      return {...m,continuation};
    }
    const result = tx.put('meeting_result', { id: m.status === 'ended' ? id('late_result') : m.id, scopeId: channel.id, parentId: m.id,
      summary, answers, quality,authorId:actor.memberId||'owner',sourceVersion: cmd.sourceVersion ?? m.version, status: m.status === 'ended' ? 'late' : 'provided', createdAt: tx.now });
    await release(tx, actor, cmd, helpers, channel);
    if (m.status === 'ended') return { late: true, resultId: result.id, originalResultPreserved: !!latest };
    if (action !== 'close' && cmd.sourceVersion !== m.version) fail('version_conflict', '请按最新议题版本整理，旧结论不能冒充新要求完成', 409);
    m.answers = answers;m.quality=quality;
    if(m.closure==='deadline'&&m.status!=='ended'&&!due(m,tx.now)){
      m.status='closing';m.phase='结果已整理，等待约定结束';m.summary=summary;m.summaryStatus='provided';
      await cancelPending(tx,m,'结果已整理，等待约定结束');stamp(tx,m);
      await event(tx,channel,m,'负责人已整理结果，将按约定时间结束；你仍可补充要求或提前喊停。',helpers);
      return m;
    }
    return end(tx, channel, m, helpers, 'completed', summary);
  }
  fail('invalid_action', '会议操作无效');
}
function cleanSources(sources = []) {
  if (!Array.isArray(sources) || sources.length > 30 || sources.some(s => typeof s !== 'string' || s.length > 2000)) fail('invalid_sources', '来源列表无效');
  return sources;
}
function cleanAgenda(items, previous) {
  if (!Array.isArray(items) || items.length > 20) fail('invalid_agenda', '议题最多20项');
  const clean = items.map(a => {
    if(!a||typeof a!=='object')fail('invalid_agenda','议题条目无效');
    if (a.id && !previous.some(old => old.id === a.id)) fail('invalid_agenda', '议题编号不属于本场');
    return { id: a.id || id('agenda'), title: required(a.title, '议题', 400), expected: a.expected || '', status: a.status === 'canceled' ? 'canceled' : 'open', replaces: a.replaces || [] };
  });
  if (new Set(clean.map(a => a.id)).size !== clean.length) fail('invalid_agenda', '议题编号重复');
  return [...clean, ...previous.filter(a => !clean.some(x => x.id === a.id)).map(a => ({ ...a, status: 'canceled' }))];
}
async function preparationPost(tx, identity, actor, cmd, channel, m, helpers) {
  host(m, actor); if (m.status !== 'preparing') fail('meeting_started', '本场筹备已结束');
  const body = required(cmd.body, '消息', 12000);
  const replyId=actor.owner?id('preparation'):'preparation_reply_'+await digest(`${m.id}:${actor.memberId}:${m.lastOwnerMessageId}:${body}`);
  const prior=actor.owner?null:await tx.get('meeting_preparation',replyId,false);
  if(prior){await release(tx,actor,{...cmd,meetingId:m.id},helpers,channel);return {...prior,meetingId:m.id,alreadyReceived:true};}
  const message = tx.put('meeting_preparation', { id: replyId, scopeId: channel.id, parentId: m.id, authorId: actor.owner ? 'owner' : actor.memberId, body,inReplyTo:m.lastOwnerMessageId||null,createdAt: tx.now });
  await helpers.channelMessage(tx,channel,actor,body,{id:message.id,meetingId:m.id,type:'message',replyTo:actor.owner?null:m.lastOwnerMessageId,refs:cmd.refs||[],hops:0});
  if (actor.owner) {
    m.lastOwnerMessageId = message.id;
    if (ownerStop(body)) { m.status = 'ended'; m.endReason = '筹备取消'; m.endedAt = tx.now; await cancelPending(tx, m, '筹备已取消'); }
    else {
      if (ownerStart(body)) m.startAuthorizedVersion = m.version;
      await wake(tx, identity, channel, m, [m.coordinatorId], '用户在筹备对话中提出新要求。请与用户必要地多轮明确本场目标和交付，不为了讨论而讨论；每次只问最影响结果的一两项缺失信息。成员、时长和组织方法已有默认或由你安排，不让用户再分工或选择专业模式；交付形式由你提出建议，不抛一张问卷给用户。信息充分时调用meeting(action="plan")保存真实安排，并用人话回应。用户明确开始后可调用start；口语确认可传ownerMessageId和confirmationQuote逐字引用最新用户同意原话，不需要固定口令；不确定是否同意时简短确认，不提前通知全体。', helpers, { preparation: true });
    }
    stamp(tx, m);
  } else await release(tx, actor, { ...cmd, meetingId: m.id }, helpers, channel);
  return { ...message, meetingId: m.id };
}

export async function meetingPost(tx, identity, actor, cmd, channel, helpers) {
  let turn = cmd.turnId ? await tx.get('channel_turn', cmd.turnId, false) : null;
  if (!turn && actor.memberId) turn = (await tx.list('channel_turn', { scope: channel.id, parent: actor.memberId, status: 'active' }))[0];
  let meetingId = cmd.meetingId || turn?.meetingId;
  if (!meetingId && cmd.replyTo) meetingId = (await tx.get('channel_message', cmd.replyTo, false))?.meetingId;
  if (!meetingId) return null;
  const m = await tx.get('channel_meeting', meetingId);
  if (m.scopeId !== channel.id) fail('forbidden', '会议不属于本群', 403);
  if (m.status === 'preparing') return { handled: true, result: await preparationPost(tx, identity, actor, { ...cmd, meetingId }, channel, m, helpers) };
  if (actor.owner && ownerStop(cmd.body)) return { handled: true, result: await end(tx, channel, m, helpers, 'stopped') };
  if(actor.owner&&active(m)){
    const message=await helpers.channelMessage(tx,channel,actor,required(cmd.body,'消息',24000),{meetingId:m.id,type:'message',meetingVersion:m.version,hops:0});
    m.latestOwnerDirectiveId=message.id;stamp(tx,m);
    const c=await tx.get('connection',m.coordinatorId,false);
    if(c?.status==='verified'){
      const signal=await helpers.channelMessage(tx,channel,actor,'用户在本场会议中补充或决定了新要求，请优先读取最新原文并回应；必要时用agenda更新议题、目标或交付。',{hidden:true,type:'meeting_signal',meetingId:m.id,meetingRound:m.round,meetingVersion:m.version,meetingStage:m.status,meetingPurpose:'user_update',ownerMessageId:message.id,hops:0});
      await helpers.enqueue(tx,identity,channel,signal,m.coordinatorId);
    }
    return {handled:true,result:message};
  }
  if(actor.memberId&&turn?.meetingPurpose==='user_update'){
    const response=await helpers.channelMessage(tx,channel,actor,required(cmd.body,'回应',24000),{meetingId:m.id,sourceVersion:turn.meetingVersion,replyTo:turn.ownerMessageId,hops:0});
    if(turn.ownerMessageId===m.latestOwnerDirectiveId){m.ackOwnerMessageId=turn.ownerMessageId;stamp(tx,m);}
    await release(tx,actor,{...cmd,meetingId:m.id},helpers,channel);return {handled:true,result:response};
  }
  if (actor.memberId && m.status === 'running') {
    const result = await handleMeeting(tx, identity, actor, { ...cmd, meetingId, action: 'opinion', round: turn?.meetingRound??m.round, sourceVersion: turn?.meetingVersion??m.version }, channel, helpers);
    return { handled: true, result };
  }
  return { handled: false, meetingId, sourceVersion: turn?.meetingVersion ?? m.version };
}

export async function meetingDetail(repo, identity, actor, args) {
  const m = await repo.get('channel_meeting', args.meetingId), channel = await repo.get('channel', m.scopeId);
  access(channel, actor); if (!publicMeeting(m, actor)) fail('forbidden', '筹备对话仅对本场组织者及用户开放', 403);
  const before = args.before ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(before) || before < 0) fail('invalid_cursor', '会议分页无效');
  let cursor = { sequence: before, id: '~' };
  if (args.cursor) { try { cursor = JSON.parse(atob(args.cursor)); } catch { fail('invalid_cursor', '会议分页无效'); } }
  if (!Number.isSafeInteger(cursor.sequence) || typeof cursor.id !== 'string') fail('invalid_cursor', '会议分页无效');
  const rows = await repo.db.prepare("SELECT sequence,id,body FROM hub_v2_records WHERE workspace_id=? AND parent_id=? AND kind IN ('meeting_opinion','meeting_opinion_history','meeting_review','meeting_result','meeting_preparation','meeting_plan_version') AND (sequence<? OR (sequence=? AND id<?)) ORDER BY sequence DESC,id DESC LIMIT 101").bind(repo.workspaceId, m.id, cursor.sequence,cursor.sequence,cursor.id).all();
  const page = rows.results.slice(0,100);
  const visible = page.map(r => JSON.parse(r.body)).filter(r => actor.owner || (r.kind === 'meeting_preparation' ? actor.memberId === m.coordinatorId||(m.status!=='preparing'&&r.authorId==='owner') : !['meeting_opinion','meeting_opinion_history'].includes(r.kind) || r.publishedAt || r.authorId === actor.memberId));
  const last=page.at(-1);
  return { meeting: m, modes: MEETING_MODES, records: visible.reverse(), nextCursor: rows.results.length>100 ? btoa(JSON.stringify({sequence:last.sequence,id:last.id})) : null };
}

export async function meetingTurnContext(repo, identity, actor, turn) {
  if (!turn?.meetingId) return null;
  const detail = await meetingDetail(repo, identity, actor, { meetingId: turn.meetingId });
  const m = detail.meeting;
  return { ...detail,
    records:detail.records.map(r=>r.kind==='meeting_result'?{id:r.id,kind:r.kind,status:r.status,sourceVersion:r.sourceVersion,createdAt:r.createdAt,note:r.status==='provided'?'当前正文已在meeting.summary和answers中；无需重复读取':'历史原文可用meeting(action="read")读取，未删除或改写'}:r),
    currentRound: m.round, sourceVersion: m.version,
    ...(['user_update','result_revision'].includes(turn.meetingPurpose)?{userUpdate:true,userUpdateMessageId:turn.ownerMessageId}:{}),
    instruction:turn.meetingPurpose==='result_revision'
      ? '用户看不懂原结果，请由你重新写清楚，不重开会议。summary首段直接回答用户原问题，再用小标题、自然段或列表展开具体发现、理由和例子。不先回顾任务或反复声明已修订/不重开/不开发，不用元叙述挤占首屏。不要只列术语，不用双方一致/已完成来代替答案；按最新用户要求讲清楚。界面不会替你改写内容。answers保留各议题的具体发现和依据。用meeting(action="revise_result",meetingId,channelId,ownerMessageId=本上下文userUpdateMessageId,sourceVersion,summary,answers,requestId)发布，原结果自动保留。'
      :turn.meetingPurpose==='user_update'
      ? '用户在会议中有新补充或决定。优先阅读群消息里对应owner原文；必要时调用meeting(action="agenda",expectedVersion,agenda,goal,deliverable)更新议题，再post_message回应。不要把这条用户补充当作待独立提交的普通意见；本工具上下文含userUpdateMessageId。结束总结必须处理最新要求。'
      : m.status === 'preparing'
      ? '你在与用户筹备会议。必要时每次只问最影响结果的一两项缺失信息，不发问卷、不要求用户分配成员角色或选择专业模式；已有成员、时长默认值，组织安排和交付形式由你提出建议。用户没有要求时，不自行加400字等篇幅限制或固定交付模板；以把问题讲清楚为准。用必要的多轮沟通确定目标与交付，足够明确即给出安排。调用meeting(action="plan", meetingId,channelId,ownerMessageId=本场lastOwnerMessageId,title,goal,deliverable,mode,body,agenda:[{title}],requestId)保存安排，界面会展示安排卡，聊天只简短说明新发现或待确认的问题，不重复抄一遍卡片。用户确认后才start。'
      : m.status === 'closing'
        ? '负责人请对照用户最初的问题和本场交付约定，亲自写一份用户可以直接读懂的完整正文。summary是主要交付，先回答问题，再用自然段、小标题或列表解释具体发现和理由；只在相关时写建议、待决或未知，不套固定模板，不堆API/代码名和缩略词，必要术语用日常语言解释。answers逐项填写实际内容，不用“双方一致、已覆盖、无分歧、已合并”等状态句代替答案，不让用户翻过程才能知道结论。不自行压缩成关键词提纲。提交meeting(action="finish",meetingId,channelId,round=本场currentRound,sourceVersion,ownerMessageId=最新已处理用户补充ID（如有）,summary,answers:[{agendaId,body,status,evidenceIds,dissent}],requestId)。status使用supported/partial/unresolved/disputed；supported须关联本场真实意见、核验或本群资料。若接口要求修正参数，只修参数并保留完整正文。未知说明缺口，不伪造共识。必要补查用meeting(action="investigate",body=具体缺口,memberIds=本场核验者)请求，仍受剩余时间与调用预算约束。'
        : '按当前阶段执行。共同输入是records中authorId="owner"的用户原始资料及本场目标，负责人筹备推导不提前公开；不要因读不到价格等事实就猜测。资料更多时用meeting(action="read",cursor=nextCursor)分页。先独立提交意见；后续阶段核验关键依据并用meeting(action="review",claim,method,finding,sources,requestId)登记真实检查，再调用meeting(action="opinion",meetingId,channelId,round,sourceVersion,body,sources,changeReason,requestId)。未公开初稿不写到群或文档。每轮直接回应，不空转。',
    toolFallback: '若原平台缓存了旧工具目录，可刷新目录，或使用自己原有配对凭证向同一Hub的POST /v2/tools/meeting发送相同JSON；不得请求管理凭证、改变模型或订阅。优先使用结构化工具参数；若通过脚本发送JSON，务必避免shell展开金额中的美元符号或其他原文，提交后读取确认。普通post_message/旧submit_work可回传筹备消息和阶段意见，但正式计划、核验与结束须真实调用会议工具。',
  };
}

export async function meetingMaintenance(repo, identity, helpers, now = new Date().toISOString()) {
  for (const status of ['running', 'closing']) for (const row of await repo.list('channel_meeting', { status, limit: 100 })) {
    if (!(due(row, now) || phaseDue(row, now) || (status === 'running' && row.closingAt <= now))) continue;
    await repo.transact(`meeting-clock:${row.id}:${row.version}:${row.round}:${Math.floor(Date.parse(now) / 1000)}`, {}, async tx => {
      const m = await tx.get('channel_meeting', row.id), channel = await tx.get('channel', m.scopeId);
      if (due(m, tx.now)) return end(tx, channel, m, helpers, 'deadline');
      if (m.status === 'running' && m.closingAt <= tx.now) {
        await publish(tx, channel, m, (await tx.list('meeting_opinion', { parent: m.id })).filter(o => !o.publishedAt), helpers);
        return close(tx, identity, channel, m, helpers);
      }
      return advance(tx, identity, channel, m, helpers);
    }, now);
  }
}

export async function meetingTurnAllowed(tx, turn) {
  if (!turn?.meetingId) return true;
  const m = await tx.get('channel_meeting', turn.meetingId, false);
  if(turn.meetingPurpose==='result_revision')return !!m&&m.status==='ended'&&m.revisionStatus==='requested'&&m.revisionRequestId===turn.ownerMessageId&&m.revisionExpiresAt>tx.now&&m.coordinatorId===turn.memberId;
  if (!m || m.status === 'ended' || due(m, tx.now)) return false;
  return m.status === 'preparing' || (turn.meetingVersion === m.version && turn.meetingRound === m.round && (m.status === 'closing' ? turn.meetingStage === 'closing' : turn.meetingStage === 'running'));
}

export async function chargeMeetingRetry(tx, turn, attempts) {
  if (!turn?.meetingId || !attempts) return true;
  const m=await tx.get('channel_meeting',turn.meetingId);
  if(turn.meetingPurpose==='result_revision')return attempts<3&&m.revisionStatus==='requested'&&m.revisionExpiresAt>tx.now;
  if(m.status==='preparing')return attempts<3;
  if(m.wakeCount>=m.maxWakeups-(m.status==='closing'?0:1))return false;
  m.wakeCount++;stamp(tx,m);return true;
}
