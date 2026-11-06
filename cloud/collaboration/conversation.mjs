import {executionResource} from './execution-bindings.mjs';
import {DELIVERY_TOOLS,automationHold,deliveryReviewCommand,deliveryReviewMaintenance,deliveryIssueDetail,reconcileDeliveryIssue,deliveryReviewSource} from './delivery-review.mjs';
import {recordMemoryEvent,queueMemoryIndex} from './memory-context.mjs';
import {workspaceGrant,requireManager} from './delegation.mjs';
import {MATERIAL_TOOLS,materialCommand} from './materials.mjs';
import {editMessage} from './chat-experience.mjs';
import {COORDINATION_TOOLS,trackCoordination,relatedCoordination,registerFeedback,objectFeedback,coordinationCommand,transferCoordination} from './coordination.mjs';
import {FOLDER_TOOLS,folderCommand,allFolders,allPlacements,placeMaterial} from './material-folders.mjs';
import { SPACE_TOOLS, referenceSchema, spaceCommand, validateRefs, publicMemory, readSpaceObject } from './workspace-objects.mjs';
import { fail, id, required, digest } from "./repository.mjs";
import { messageRecipients, namedMentions, hasAllMention, hasOwnerMention } from '../../shared/chat-routing.mjs';
import { MEETING_TOOLS, handleMeeting, meetingPost, meetingDetail, meetingTurnContext, meetingMaintenance, meetingTurnAllowed, publicMeeting } from './meetings.mjs';

// Communication is independent of the legacy run/step orchestration. A turn is
// only an acknowledged inbox delivery, never a task, document or prescribed role.
const BASIC_CHANNEL_TOOLS = [
  [
    "read_channel",
    "读取自己所在群的消息、成员、负责人和共享工具。before 为消息序号，向前分页。",
    { channelId: "string", before: "number" },
    ["channelId"],
  ],
  [
    "post_message",
    "以自己的真实身份在群中发言。mentions 使用群内成员 ID，@人类用 owner（仅提醒用户，不派发 Agent）；需要全员回应时设 mentionAll=true；普通发言不广播；回复负责人发起的协作请求时，结果会返回当前负责人。用户普通消息默认交给负责人，但所有群成员仍可交流。turnId 表示已处理的通知；普通回复不创建任务。",
    {
      requestId: "string",
      channelId: "string",
      body: "string",
      mentions: "array",
      mentionAll: "boolean",
      replyTo: "string",
      turnId: "string",
      refs: referenceSchema,
    },
    ["requestId", "channelId", "body"],
  ],
  [
    "stay_silent",
    "已读本次通知但无实质补充，记录原因并结束通知；不往群里刷屏。",
    { requestId: "string", turnId: "string", reason: "string" },
    ["requestId", "turnId", "reason"],
  ],
  [
    "create_doc",
    "按需建立共享文档，不要求每次对话都创建。",
    {
      requestId: "string",
      channelId: "string",
      title: "string",
      body: "string",
      folderId: "string",
    },
    ["requestId","channelId","title","body"],
  ],
  ["read_doc", "读取共享文档全文、版本和修改者。", { documentId: "string" }],
  [
    "edit_doc",
    "修改共享文档。必须先 read_doc 并携带 expectedVersion，冲突时重新读取；不覆盖别人的新修改。",
    {
      requestId: "string",
      documentId: "string",
      expectedVersion: "number",
      body: "string",
      reason: "string",
    },
  ],
  [
    "suggest_edit",
    "向共享文档提出具体修改建议，用户采纳前不覆盖原稿。",
    {
      requestId: "string",
      documentId: "string",
      body: "string",
      reason: "string",
    },
  ],
  [
    "ask_user",
    "需要用户决定时提出问题和选项。用户回答作为群消息唤醒提问者，不阻止其他成员交流。",
    {
      requestId: "string",
      channelId: "string",
      question: "string",
      options: "array",
    },
  ],
  [
    "deliver",
    "主动把共享文档交付给用户；记录具体版本，不等于独立验证事实。",
    { requestId: "string", documentId: "string", summary: "string" },
  ],
  [
    "remember",
    "记录本群的背景、要求、决定或经验。附来源 refs；成员提出的内容待核实，用户保存立即生效。",
    {
      requestId: "string",
      channelId: "string",
      title: "string",
      body: "string",
      category: "string",
      authority:"string",conditions:"string",memoryScope:"string",sourceMessageId:"string",sourceQuote:"string",
      refs: referenceSchema,
    },
    ["requestId", "channelId", "title", "body"],
  ],
  [
    "meeting",
    "可选会议工具：open 创建讨论记录，close 记录结论。不自动分配角色或限制发言。",
    {
      requestId: "string",
      channelId: "string",
      action: "string",
      title: "string",
      meetingId: "string",
      summary: "string",
    },
    ["requestId", "channelId", "action"],
  ],
  [
    "board_task",
    "Todo：create/update/accept。指派会真实通知成员；执行成员用 accept 接手，doing/blocked/done 跟进进度。blocked 填 blocker，完成填写 result 和资料 refs。meetingIds 关联本群会议。只在需要跟进时使用。",
    {
      requestId: "string",
      channelId: "string",
      action: "string",
      title: "string",
      taskId: "string",
      assigneeId: "string",
      status: "string",
      body: "string", progress: "string", blocker: "string", result: "string",
      dueDate: "string", expectedVersion: "number", sourceMessageId: "string",
      meetingIds: "array", refs: referenceSchema,
    },
    ["requestId", "channelId", "action"],
  ],
].map(([name, description, properties, keys]) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(properties).map(([k, t]) => [
        k,
        typeof t === "object" ? t : t === "array"
          ? { type: t, items: { type: "string" }, maxItems: 30 }
          : t === "number"
            ? { type: "integer", minimum: 0 }
            : { type: t },
      ]),
    ),
    required: keys || Object.keys(properties),
    additionalProperties: false,
  },
}));

export const CHANNEL_TOOLS = [...BASIC_CHANNEL_TOOLS.filter(t => t.name !== 'meeting'), ...MEETING_TOOLS, ...SPACE_TOOLS, ...FOLDER_TOOLS, ...COORDINATION_TOOLS, ...MATERIAL_TOOLS, ...DELIVERY_TOOLS];
const activeMember = (identity, memberId) =>
  identity.members.find(
    (m) =>
      m.id === memberId &&
      m.status !== "disabled" &&
      identity.accounts.some(
        (a) => a.id === m.accountId && a.status !== "disabled",
      ),
  );
const unique = (values) => [...new Set(values)];
const owner = (actor,repo) => requireManager(repo,actor);
const scoped = async (channel, actor,repo) => {
  if (!actor.owner && !channel.memberIds.includes(actor.memberId) && !await workspaceGrant(repo,actor))
    fail("forbidden", "你不在这个群内", 403);
};
const messageText = (value) => required(value, "消息", 24000);
// Text-only native receivers can still address an existing group peer. This is
// ordinary message addressing, with the same membership authorization. Never
// resolve global names, ambiguous names, quoted examples or code as recipients.
function textMentions(body, channel, identity) {
  return [...namedMentions(body, channel.memberIds.map(mid => activeMember(identity, mid)).filter(Boolean)),...(hasOwnerMention(body)?['owner']:[])];
}

const listIds = (values, label = "成员") => {
  if (
    !Array.isArray(values) ||
    values.length > 30 ||
    values.some((v) => typeof v !== "string")
  )
    fail("invalid_input", `${label}列表无效`);
  return unique(values);
};

export async function channelAccess(repo, channelId, actor) {
  const channel = await repo.get("channel", channelId);
  await scoped(channel, actor,repo);
  return channel;
}
async function channelMessage(tx, channel, actor, body, extra = {}) {
  channel.messageSequence = (channel.messageSequence || 0) + 1;
  const message = tx.put("channel_message", {
    id: id("chat"),
    scopeId: channel.id,
    parentId: channel.id,
    number: channel.messageSequence,
    body,
    authorId: actor.owner ? "owner" : actor.memberId,
    createdAt: tx.now,
    type: "message",
    ...extra,
  });
  if(!extra.hidden){channel.lastMessage = body.slice(0, 160);channel.lastMessageAt = tx.now;}
  tx.put("channel", channel);
  if(actor.owner&&!extra.hidden)await recordMemoryEvent(tx,channel,message,'message');
  return message;
}
async function enqueue(tx, identity, channel, message, memberId) {
  const m = activeMember(identity, memberId),
    connection = await tx.get("connection", memberId, false);
  if (!m) return;
  const turnId = `turn_${message.id}_${memberId}`;
  const deferred = !!message.holdReason && !message.deliveryReview;
  const available = !m.paused && connection?.status === "verified";
  // Native source setup and per-chat context selection are separate. Preserve
  // the first message while that context proves its round trip; only a verified
  // member can see/claim it, and no webhook is sent during verification.
  const nativePending = !m.paused && connection?.status === 'configured' && connection.transport === 'muse-poll' && ['codex','antigravity','gemini-cli','deepseek-harness','claude-code'].includes(m.platformId);
  const turn = tx.put("channel_turn", {
    id: turnId,
    scopeId: channel.id,
    parentId: memberId,
    memberId,
    messageId: message.id,
    ...(message.deliveryReview?{deliveryReview:message.deliveryReview}:{}),
    ...(message.holdReason?{holdReason:message.holdReason}:{}),
    ...(message.coordinationRootId?{coordinationRootId:message.coordinationRootId,coordinationFeedback:!!message.coordinationFeedback,coordinatorVersion:channel.coordinatorVersion||1}:{}),
    wakeSource: message.authorId === "owner" ? "user" : "agent",
    number: message.number,
    rootId: message.rootId || message.id,
    hops: message.hops || 0,
    status: deferred ? "limited" : available || nativePending ? "ready" : "unavailable",
    createdAt: tx.now,
    ...(message.meetingId && !message.meetingChat ? { meetingId: message.meetingId, meetingRound: message.meetingRound, meetingVersion: message.meetingVersion, meetingStage: message.meetingStage,meetingPurpose:message.meetingPurpose,ownerMessageId:message.ownerMessageId } : {}),
    reason: deferred
      ? "暂缓重复自动通知，交由负责人核对；原消息与其他工作保留"
      : available
        ? null
        : "成员的自动接入尚未就绪，消息已保留",
  });
  if (available && !deferred) await outbox(tx, channel, turn, connection);
}
async function outbox(tx, channel, turn, c) {
  const cursor = await tx.get(
    "channel_cursor",
    `${channel.id}:${turn.memberId}`,
    false,
  );
  const dueAt = new Date(
    Math.max(
      Date.parse(tx.now),
      Date.parse(cursor?.lastWakeAt || tx.now) +
        (!turn.meetingId && turn.wakeSource !== "user" && cursor?.lastWakeAt
          ? channel.wakeIntervalSeconds * 1000
          : 0),
    ),
  ).toISOString();
  tx.put("outbox", {
    id: `notice_${turn.id}`,
    scopeId: channel.id,
    parentId: channel.id,
    stepId: turn.id,
    memberId: turn.memberId,
    generation: 1,
    conversation: true,
    ...(turn.deliveryReview ? { deliveryReview: turn.deliveryReview } : {}),
    ...(turn.meetingId ? { meetingId: turn.meetingId, meetingRound: turn.meetingRound, meetingVersion: turn.meetingVersion,meetingPurpose:turn.meetingPurpose } : {}),
    configVersion: c.configVersion,
    transport: c.transport,
    status: c.transport === "muse-poll" ? "awaiting_poll" : "pending",
    attempts: 0,
    createdAt: tx.now,
    dueAt,
  });
}
async function finishTurn(tx, actor, turnId, status, reason) {
  if (!turnId) return;
  const turn = await tx.get("channel_turn", turnId);
  if (turn.memberId !== actor.memberId)
    fail("forbidden", "不能处理其他成员的通知", 403);
  if (["done", "silent", "merged", "removed"].includes(turn.status)) return;
  if (turn.status !== "active")
    fail("not_claimed", "请先领取通知，再回应或静默", 409);
  tx.put("channel_turn", { ...turn, status, reason, completedAt: tx.now });
  for(const issueId of unique([turn.deliveryIssueId,...(turn.deliveryIssueIds||[])].filter(Boolean)))await reconcileDeliveryIssue(tx,issueId);
  const r = await tx.get("resource", turn.resourceKey, false);
  if (r?.turnId === turn.id)
    tx.put("resource", { ...r, status: "idle", turnId: null });
}

// A notification timeout is not a consumed message. Late native receivers may
// claim unstarted work; an expired execution always requires explicit recovery.
export const receivableTurn = turn => turn.status === 'ready' ||
  (turn.status === 'stalled' && !turn.claimedAt && !turn.lease);

// Runtime observations do not acknowledge delivery or fabricate an Agent reply.
export async function conversationRuntime(repo,actor,args){
  const turn=await repo.get('channel_turn',required(args.turnId,'通知'));
  if(!actor.memberId||turn.memberId!==actor.memberId)fail('forbidden','只能核对自己的通知',403);
  const publicState=t=>({turnId:t.id,status:t.status,completedAt:t.completedAt||null,reason:t.reason||null});
  if(args.action==='read')return publicState(turn);
  if(!['running','ended','unreachable'].includes(args.state))fail('invalid_state','运行观察状态无效');
  return repo.transact(args.requestId,{...args,actor},async tx=>{
    const current=await tx.get('channel_turn',turn.id);
    if(current.status!=='active')return publicState(current);
    if(args.state==='running')return publicState(tx.put('channel_turn',{...current,nativeObservedAt:tx.now,expiresAt:new Date(Date.parse(tx.now)+30*60000).toISOString()}));
    const reason=args.state==='ended'?'原对话已结束，但这条消息尚未回传；请在原环境检查。':'暂时无法确认原运行端状态，消息和原工作保留；未自动重做。';
    const next=tx.put('channel_turn',{...current,status:'stalled',reason,nativeObservedAt:tx.now,interruptedAt:tx.now});
    const resource=await tx.get('resource',current.resourceKey,false);
    if(resource?.turnId===current.id)tx.put('resource',{...resource,status:'idle',turnId:null});
    return publicState(next);
  });
}
async function pendingConversationTurns(tx, options) {
  return (await Promise.all(['ready', 'stalled'].map(status =>
    tx.list('channel_turn', { ...options, status })))).flat().filter(receivableTurn);
}
export async function conversationWork(repo, identity, memberId) {
  const connection=await repo.get("connection", memberId, false);if(connection?.status!=="verified")return [];
  const turns = (
    await Promise.all(
      ["ready", "active", "stalled"].map((status) =>
        repo.list("channel_turn", { parent: memberId, status, limit: 500 }),
      ),
    )
  ).flat();
  const result = [];
  for (const turn of turns) {
    if (turn.status !== 'active' && !receivableTurn(turn)) continue;
    const channel = await repo.get("channel", turn.scopeId, false);
    if (!channel?.memberIds.includes(memberId) || channel.status !== "active")
      continue;
    result.push({
      stepId: turn.id,
      turnId: turn.id,
      runId: channel.id,
      channelId: channel.id,
      projectId: channel.id,
      title: channel.name,
      status: receivableTurn(turn) ? "ready" : "claimed",
      kind: "conversation",
      messageId: turn.messageId,
      instruction:
        "这是群聊新消息，不是正式任务。领取后读取上下文，自主决定回复、@、用工具或静默。",
    });
  }
  return result.sort((a, b) => a.stepId.localeCompare(b.stepId));
}
export async function claimConversation(
  repo,
  identity,
  actor,
  args,
  now = new Date().toISOString(),
) {
  return repo.transact(
    args.requestId,
    { ...args, actor },
    async (tx) => {
      let turn, channel;
      if (args.receiveNext) {
        const member = activeMember(identity, actor.memberId),
          connection = await tx.get("connection", actor.memberId);
        if (!member || member.paused || connection.status !== "verified")
          fail("unavailable", "成员当前不可接收消息", 409);
        if (args.channelId) {
          const selected = await tx.get("channel", args.channelId);
          await scoped(selected, actor,tx);
          if (selected.status !== "active")
            return { status: "empty", reason: "channel_inactive" };
        }
        const resource = await tx.get("resource", connection.resourceKey, false);
        if (resource?.status === "busy") return { status: "busy" };
        const pending = (await pendingConversationTurns(tx, {
          parent: actor.memberId,
          ...(args.channelId ? { scope: args.channelId } : {}),
          limit: 500,
        })).sort((a, b) => Number(b.meetingPurpose==='user_update')-Number(a.meetingPurpose==='user_update')||a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        for (const candidate of pending) {
          const group = await tx.get("channel", candidate.scopeId, false);
          if (group?.status !== "active" || !group.memberIds.includes(actor.memberId)) continue;
          const occupied=await tx.get('resource',await executionResource(tx,connection,group.id),false);if(occupied?.status==='busy')continue;
          if (!await meetingTurnAllowed(tx, candidate)) { tx.put('channel_turn', { ...candidate, status: 'removed', reason: '会议阶段已经变化或结束' }); continue; }
          turn = candidate;
          channel = group;
          break;
        }
        if (!turn) return { status: "empty" };
      } else {
        turn = await tx.get("channel_turn", args.stepId || args.turnId);
        channel = await tx.get("channel", turn.scopeId);
      }
      await scoped(channel, actor,tx);
      if (turn.memberId !== actor.memberId)
        fail("forbidden", "通知不属于此成员", 403);
      if (!receivableTurn(turn))
        fail("turn_unavailable", "通知已处理或尚不可领取", 409);
      if (!await meetingTurnAllowed(tx, turn)) fail('meeting_changed', '会议阶段已变化或结束，原消息保留', 409);
      const member = activeMember(identity, actor.memberId),
        c = await tx.get("connection", actor.memberId);
      if (
        !member ||
        member.paused ||
        c.status !== "verified" ||
        channel.status !== "active"
      )
        fail("unavailable", "成员或群当前不可执行", 409);
      const resourceKey=await executionResource(tx,c,channel.id);
      if(args.expectedSessionId&&resourceKey!=='native-session:'+actor.memberId+':'+await digest(required(args.expectedSessionId,'原工作会话',200)))fail('session_changed','这个聊天已更换工作会话，消息保留给当前绑定的会话',409);
      const legacyResource=await tx.get("resource",c.resourceKey,false);
      if(resourceKey!==c.resourceKey&&legacyResource?.status==='busy')fail('resource_busy','旧版接收的工作正在结束，消息已保留',409);
      const resource = await tx.get("resource", resourceKey, false);
      if (resource?.status === "busy")
        fail("resource_busy", "原 Agent 正在处理另一条通知，稍后再读", 409);
      tx.guardLegacyIdle(member.accountId);
      const pending = (await pendingConversationTurns(tx, {
        scope: channel.id,
        parent: actor.memberId,
      })).filter(t => (t.deliveryReview || null) === (turn.deliveryReview || null) && (t.meetingId || null) === (turn.meetingId || null) && (!turn.meetingId || (t.meetingVersion === turn.meetingVersion && t.meetingRound === turn.meetingRound && t.meetingStage === turn.meetingStage&&t.meetingPurpose===turn.meetingPurpose)));
      const lease = id("lease");
      for (const other of pending)
        if (other.id !== turn.id)
          tx.put("channel_turn", {
            ...other,
            status: "merged",
            mergedInto: turn.id,
          });
      for (const t of pending) {
        const n = await tx.get("outbox", `notice_${t.id}`, false);
        if (n) tx.put("outbox", { ...n, status: "claimed" });
      }
      tx.put("channel_turn", {
        ...turn,
        status: "active",
        lease,
        resourceKey,
        claimedAt: tx.now,
        reason: null,
        ...(turn.meetingId?{claimedOwnerMessageId:(await tx.get('channel_meeting',turn.meetingId)).lastOwnerMessageId}:{}),
        expiresAt: new Date(Date.parse(tx.now) + 30 * 60000).toISOString(),
        mergedMessageIds: pending.map((t) => t.messageId),
        deliveryIssueIds: unique(pending.flatMap(t=>[t.deliveryIssueId,...(t.deliveryIssueIds||[])]).filter(Boolean)),
      });
      tx.put("resource", {
        ...resource,
        id: resourceKey,
        status: "busy",
        turnId: turn.id,
        memberId: actor.memberId,
      });
      const cursorId = `${channel.id}:${actor.memberId}`,
        cursor = await tx.get("channel_cursor", cursorId, false);
      tx.put("channel_cursor", {
        ...cursor,
        id: cursorId,
        scopeId: channel.id,
        parentId: actor.memberId,
        lastWakeAt: tx.now,
        readThrough: Math.max(...pending.map((t) => t.number)),
      });
      return {
        ...(args.receiveNext ? { status: "claimed" } : {}),
        attemptId: turn.id,
        turnId: turn.id,
        lease,
        channelId: channel.id,
        input: {
          kind: "conversation",
          ...(turn.deliveryReview?{deliveryReview:await deliveryIssueDetail(tx,channel,await tx.get('channel_delivery_issue',turn.deliveryReview))}:{}),
          ...(turn.meetingId ? { meetingId: turn.meetingId, meetingRound: turn.meetingRound, meetingVersion: turn.meetingVersion } : {}),
          channelId: channel.id,
          coordinatorId: channel.coordinatorId,
          ...(actor.memberId===channel.coordinatorId?{coordinatorInstruction:'你是用户指定的负责人。先理解本次目标和交付范围，核对本次所有 triggerMessageIds 与用户连续补充；有影响行动的歧义才追问。按需要组织成员核查，独立判断证据，避免互相点头。相关成员结果、文档和 Todo 反馈会送回你；请继续处理或向用户交付，不止说收到。能在已授权范围内推进就推进，确需用户决定时说清具体问题。讨论框架不等于授权全面写作；用户要求完成则不能只给计划。管好资料/Todo/会议/共享记忆，按需要用工具，不强制建任务。对正在协调的需求用 coordinate(read/update/close) 跟进，读取最新版本后再处理；回复消息只结束本次通知，不代表整件事完成。不要从无人反对、stay_silent 或一条回执推断验收通过。',coordination:await tx.list('channel_coordination',{scope:channel.id,limit:100})}:{}),
          members: channel.memberIds.map((memberId) => ({
            id: memberId,
            name: activeMember(identity, memberId)?.name || memberId,
          })),
          triggerMessageIds: pending.map((t) => t.messageId),
          triggerMessages: await Promise.all(pending.map(t=>tx.get("channel_message",t.messageId))),
          instruction:
            "群里有新消息。先调用 read_channel(channelId) 查看真实上下文。@用户 使用 mentions 中填 owner 或正文 @用户；不触发任何代理执行。明确交给你的工作需要回应结果或具体阻碍，不能只记静默。你是独立成员，可直接回复、@群内其他成员、追问、提出异议、共同写文档，或 stay_silent；用户指定的负责人可协调但不是唯一发言人。无新信息不要互相点头刷屏。post_message/stay_silent 带 turnId 结束本次通知。不要把普通聊天写成正式成果。若平台暂时只提供旧工具，submit_work 的正文会原样发到群里，不创建任务或成果；旧回传通道也能用“@本群唯一备注名”明确通知对方，引用和代码不通知。创建或修改文档等新能力需要刷新工具列表后调用，不能虚报已使用。不要声称未实际读取的资料或其他成员已回复。",
        },
      };
    },
    now,
  );
}

export async function readChannel(repo, identity, actor, args) {
  const channel = await channelAccess(repo, args.channelId, actor),
    before = args.before ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(before) || before < 0)
    fail("invalid_cursor", "消息分页序号无效");
  const messages = await repo.db
    .prepare(
      "SELECT body FROM hub_v2_records WHERE workspace_id=? AND kind='channel_message' AND scope_id=? AND COALESCE(json_extract(body,'$.hidden'),0)=0 AND CAST(json_extract(body,'$.number') AS INTEGER)<? ORDER BY CAST(json_extract(body,'$.number') AS INTEGER) DESC LIMIT 51",
    )
    .bind(repo.workspaceId, channel.id, before)
    .all();
  const rows = messages.results.map((r) => JSON.parse(r.body));
  // Older replies may point at a hidden recovery notification. Show the actual
  // source message, not internal instructions labeled as a meeting record.
  await Promise.all(rows.filter(m=>m.replyTo&&m.replySnapshot?.authorId==='system').map(async m=>{
    const parent=await repo.get('channel_message',m.replyTo,false),source=await deliveryReviewSource(repo,parent);
    if(source&&source.id!==parent?.id){m.replyTo=source.id;m.replySnapshot={body:source.body.slice(0,400),version:source.version||1,authorId:source.authorId};}
  }));
  const [documents, decisions, knowledge, meetings, tasks, suggestions, turns] =
    await Promise.all(
      [
        "channel_doc",
        "channel_question",
        "channel_memory",
        "channel_meeting",
        "channel_task",
        "channel_suggestion",
        "channel_turn",
      ].map((kind) =>
        repo.list(kind, { scope: channel.id, order: "recent", limit: kind==='channel_meeting'?101:100 }),
      ),
    );
  return {
    channel,
    members: channel.memberIds.map((memberId) => ({
      id: memberId,
      name: activeMember(identity, memberId)?.name || "已停用成员",
      isCoordinator: channel.coordinatorId === memberId,
    })),
    messages: rows.slice(0, 50).reverse(),
    before: rows.length > 50 ? rows[49].number : null,
    documents:documents.filter(d=>d.status!=="deleted"),
    files: (await repo.list("shared_file", {scope:channel.id,limit:100,order:"recent"})).filter(f=>f.status!=="deleted").map(({objectKey,...f})=>f),
    handoffs: await repo.list("shared_handoff", {scope:channel.id,limit:100,order:"recent"}),
    decisions,
    folders: await allFolders(repo,channel.id),
    placements: await allPlacements(repo,channel.id),
    links: (await repo.list("channel_link", {scope:channel.id,limit:100,order:"recent"})).filter(x=>x.status!=="deleted"),
    knowledge: knowledge.filter(k=>k.status!=="deleted"&&(actor.owner||k.status==="approved")).map(publicMemory),
    meetings: meetings.slice(0,100).map(m => publicMeeting(m, actor)).filter(Boolean),
    meetingsCursor:actor.owner&&meetings.length>100?btoa(JSON.stringify({updatedAt:meetings[99].updatedAt,id:meetings[99].id})):null,
    tasks,
    suggestions,
    notifications: actor.owner
      ? (
          await repo.list("outbox", {
            scope: channel.id,
            order: "recent",
            limit: 100,
          })
        ).map(
          ({
            id,
            stepId,
            memberId,
            status,
            reason,
            httpStatus,
            createdAt,
            completedAt,
            dueAt,
            sendingAt,
            attempts,
            platformRespondedAt,
            dispatchElapsedMs,
            attemptFinishedAt,
            coalescedInto,
            unclaimedRetry,
          }) => ({
            id,
            stepId,
            memberId,
            status,
            reason,
            httpStatus,
            createdAt,
            completedAt,
            dueAt,
            sendingAt,
            attempts,
            platformRespondedAt,
            dispatchElapsedMs,
            attemptFinishedAt,
            coalescedInto,
            unclaimedRetry,
          }),
        )
      : [],
    coordination: await repo.list('channel_coordination',{scope:channel.id,order:'recent',limit:100}),
    deliveryIssues: await repo.list('channel_delivery_issue',{scope:channel.id,order:'recent',limit:100}),
    activity: actor.owner
      ? turns.map(({ lease, resourceKey, ...t }) => t)
      : turns
          .filter((t) => t.memberId === actor.memberId)
          .map(({ lease, resourceKey, ...t }) => t),
  };
}

export async function conversationCommand(
  repo,
  identity,
  actor,
  cmd,
  now = new Date().toISOString(),
) {
  const { type } = cmd;
  if (type === "channel.claim")
    return claimConversation(repo, identity, actor, cmd, now);
  return repo.transact(
    cmd.requestId,
    { ...cmd, actor },
    async (tx) => {
      if (type === "channel.create" || type === "channel.import") {
        await owner(actor,tx);
        let prior;
        if (type === "channel.import")
          prior = await tx.get("project", cmd.projectId);
        const memberIds = listIds(
          cmd.memberIds || prior?.arrangement?.members || [],
        );
        if (memberIds.some((mid) => !activeMember(identity, mid)))
          fail("invalid_member", "所选成员不可用");
        if (cmd.direct && memberIds.length !== 1)
          fail("invalid_direct", "私聊只能选择一位 Agent");
        if (cmd.direct) {
          const directChannels = (await tx.list("channel")).filter(c => c.direct && c.memberIds.length === 1 && c.memberIds[0] === memberIds[0]);
          const priorDM = directChannels.find(c => c.status !== "archived") || directChannels[0];
          if (priorDM) return priorDM;
        }
        const coordinatorId = cmd.coordinatorId ?? null;
        if (coordinatorId && !memberIds.includes(coordinatorId))
          fail("invalid_coordinator", "负责人必须在群里");
        const channelId = prior ? `channel_${prior.id}` : id("channel");
        const existing = await tx.get("channel", channelId, false);
        if (existing) return existing;
        const channel = {
          id: channelId,
          name: required(cmd.name || prior?.name, "群名称", 100),
          description:String(cmd.description||'').slice(0,600),createdBy:actor.memberId||'owner',
          memberIds,
          coordinatorId,
          status: "active",
          maxHops: 8,
          wakeIntervalSeconds: 60,
          messageSequence: 0,
          createdAt: tx.now,
          legacyProjectId: prior?.id || null,
          direct: !!cmd.direct,
        };
        tx.put("channel", channel);
        return channel;
      }
      let channelId = cmd.channelId;
      let doc;
      if (cmd.documentId) {
        doc = await tx.get("channel_doc", cmd.documentId);
        channelId = doc.scopeId;
      }
      if (type === "channel.silent") {
        const turn = await tx.get("channel_turn", cmd.turnId);
        channelId = turn.scopeId;
      }
      const channel = await tx.get("channel", channelId);
      await scoped(channel, actor,tx);
      if (['channel.folder','channel.material.move'].includes(type)) return folderCommand(tx,actor,cmd,channel);
      if (['channel.task','channel.remember','channel.memory.update','channel.memory.review','channel.link'].includes(type)) return spaceCommand(tx,identity,actor,cmd,channel,meetingHelpers);
      if (type === 'channel.meeting') return handleMeeting(tx, identity, actor, cmd, channel, meetingHelpers);
      if (type === "channel.coordination") return coordinationCommand(tx,channel,actor,cmd);
      if (type === "channel.update") {
        await owner(actor,tx);
        const oldCoordinator=channel.coordinatorId;
        channel.lastEditorId=actor.memberId||'owner';
        if(cmd.description!==undefined)channel.description=String(cmd.description).slice(0,600);
        if (cmd.name !== undefined)
          channel.name = required(cmd.name, "群名称", 100);
        if (cmd.memberIds !== undefined) {
          const ids = listIds(cmd.memberIds);
          if (channel.direct && (ids.length !== 1 || ids[0] !== channel.memberIds[0])) fail("invalid_direct", "单聊不能添加或更换成员，请另外新建群聊");
          if (ids.some((mid) => !activeMember(identity, mid)))
            fail("invalid_member", "所选成员不可用");
          const removed = channel.memberIds.filter((mid) => !ids.includes(mid));
          for (const turn of (
            await Promise.all(
              ["active", "ready", "limited", "unavailable", "stalled"].map(
                (status) =>
                  tx.list("channel_turn", { scope: channel.id, status }),
              ),
            )
          ).flat())
            if (removed.includes(turn.memberId)) {
              if (turn.status === "active")
                fail("member_busy", "此成员正在回应，请等它完成后移出", 409);
              tx.put("channel_turn", { ...turn, status: "removed" });
            }
          channel.memberIds = ids;
        }
        if (cmd.coordinatorId !== undefined)
          channel.coordinatorId = cmd.coordinatorId || null;
        if (
          channel.coordinatorId &&
          !channel.memberIds.includes(channel.coordinatorId)
        )
          channel.coordinatorId = null;
        for (const [k, min, max] of [
          ["maxHops", 1, 100],
          ["wakeIntervalSeconds", 0, 3600],
        ])
          if (cmd[k] !== undefined) {
            if (!Number.isInteger(cmd[k]) || cmd[k] < min || cmd[k] > max)
              fail("invalid_limit", "唤醒限额无效");
            channel[k] = cmd[k];
          }
        if (cmd.status !== undefined) {
          if (!["active", "paused", "archived"].includes(cmd.status))
            fail("invalid_status", "群状态无效");
          channel.status = cmd.status;
        }
        if(oldCoordinator!==channel.coordinatorId){channel.coordinatorVersion=(channel.coordinatorVersion||1)+1;await transferCoordination(tx,identity,channel,meetingHelpers);}
        tx.put("channel", channel);
        return channel;
      }
      if(type==='channel.material')return materialCommand(tx,actor,cmd,channel,{identity,helpers:meetingHelpers});
      if(type==='channel.delivery.resolve')return deliveryReviewCommand(tx,identity,channel,actor,cmd,meetingHelpers);
      if(doc?.status==='deleted')fail('resource_deleted','这份资料已移入回收站，可恢复后继续编辑',410);
      if (type === 'channel.message.edit') return editMessage(tx,identity,actor,cmd,channel,meetingHelpers);
      if (type === "channel.post") {
        const body = messageText(cmd.body);
        const refs = await validateRefs(tx, channel.id, cmd.refs||[]);
        // Legacy housekeeping states must never require the human to unlock chat.
        // An Agent cannot reactivate a stopped channel on its own.
        if (channel.status !== "active") {
          if (!actor.owner)
            fail("channel_paused", "此会话暂不接收 Agent 回复", 409);
          channel.status = "active";
          tx.put("channel", channel);
        }
        const mentions = listIds(
          !actor.owner && cmd.mentions === undefined
            ? textMentions(body, channel, identity)
            : (cmd.mentions??[]),
          "提及",
        );
        if (mentions.some((mid) => mid!=='owner' && !channel.memberIds.includes(mid)))
          fail("invalid_mention", "只能 @ 本群成员");
        if (cmd.mentionAll !== undefined && typeof cmd.mentionAll !== 'boolean')
          fail('invalid_input', '@全员选项无效');
        const mentionAll = cmd.mentionAll === true;
        // Resolve addressing before meeting routing: a meeting must not swallow @ recipients.
        const meeting = await meetingPost(tx, identity, actor, { ...cmd, body, refs, mentions, mentionAll }, channel, meetingHelpers);
        if (meeting?.handled) return meeting.result;
        const targets = messageRecipients(channel, { ...actor, mentions, mentionAll });
        if (actor.owner && channel.memberIds.length > 0 && !targets.length)
          fail('recipient_required', '请选择群负责人，或 @ 一位成员、@全员后发送');
        let parent;
        if (cmd.replyTo) {
          parent = await tx.get("channel_message", cmd.replyTo);
          if (parent.scopeId !== channel.id)
            fail("forbidden", "不能引用其他群的消息", 403);
        }
        let turn;
        if (cmd.turnId) {
          turn = await tx.get("channel_turn", cmd.turnId);
          if (turn.memberId !== actor.memberId || turn.scopeId !== channel.id)
            fail("forbidden", "通知与当前成员或群不符", 403);
          if (!parent) parent = await tx.get("channel_message", turn.messageId);
        }
        if (actor.memberId && !turn) {
          const active = await tx.list("channel_turn", {
            scope: channel.id,
            parent: actor.memberId,
            status: "active",
          });
          if (active[0]) {
            turn = active[0];
            if (!parent)
              parent = await tx.get("channel_message", turn.messageId);
          }
        }
        // A reply without explicit turnId still acknowledges this member's active
        // delivery. Omitting both references cannot reset the causal wake budget.
        parent = await deliveryReviewSource(tx,parent);
        if (actor.memberId && !parent && !await workspaceGrant(tx,actor))
          fail(
            "context_required",
            "Agent 发言必须关联群内消息或已领取通知",
            409,
          );
        const message = await channelMessage(tx, channel, actor, body, {
          ...(meeting?.meetingId ? { meetingId: meeting.meetingId, sourceVersion: meeting.sourceVersion, ...(meeting.chat ? { meetingChat: true } : {}) } : {}),
          requestId:cmd.requestId,
          mentions,
          mentionAll,
          recipientIds: targets,
          refs,
          mentionsFromText: cmd.mentions === undefined && mentions.length > 0,
          replyTo: parent?.id || null,
          ...(parent?{replySnapshot:{body:parent.body.slice(0,400),version:parent.version||1,authorId:parent.authorId}}:{}),
          rootId: actor.owner ? null : parent?.rootId || parent?.id,
          hops: actor.owner ? 0 : (turn?.hops ?? parent?.hops ?? 0) + 1,
        });
        if(targets.length){const holdReason=await automationHold(tx,channel,message);if(holdReason){message.holdReason=holdReason;tx.put('channel_message',message);}}
        await trackCoordination(tx,channel,message,parent,targets);
        const coordinated=await relatedCoordination(tx,channel,message,parent);
        if(coordinated&&channel.coordinatorId&&await registerFeedback(tx,channel,coordinated,message)){
          message.coordinationRootId=coordinated.sourceMessageId;message.coordinationFeedback=true;
          if(!targets.includes(channel.coordinatorId))targets.push(channel.coordinatorId);
          tx.put('channel_message',message);
        }
        for (const mid of targets)
          await enqueue(tx, identity, channel, {...message,coordinationFeedback:message.coordinationFeedback&&mid===channel.coordinatorId}, mid);
        await finishTurn(tx, actor, cmd.turnId || turn?.id, "done");
        return message;
      }
      if (type === "channel.silent") {
        await finishTurn(
          tx,
          actor,
          cmd.turnId,
          "silent",
          required(cmd.reason, "静默原因", 1000),
        );
        return { silent: true };
      }
      if (type === "channel.continue") {
        await owner(actor,tx);
        for (const turn of (
          await Promise.all(
            ["limited", "unavailable", "stalled"].map((status) =>
              tx.list("channel_turn", { scope: channel.id, status }),
            ),
          )
        ).flat()) {
          if (cmd.turnId && turn.id !== cmd.turnId) continue;
          if(turn.claimedAt||turn.lease)continue;
          if(!await meetingTurnAllowed(tx,turn))continue;
          const c = await tx.get("connection", turn.memberId, false),
            m = activeMember(identity, turn.memberId);
          if (
            !channel.memberIds.includes(turn.memberId) ||
            m?.paused ||
            c?.status !== "verified"
          )
            continue;
          tx.put("channel_turn", {
            ...turn,
            status: "ready",
            hops: 0,
            reason: null,
          });
          await outbox(tx, channel, turn, c);
        }
        return { resumed: true };
      }
      if (type === "channel.doc.create") {
        const documentId = id("shared_doc"),
          versionId = id("shared_version"),
          body = required(cmd.body, "文档正文", 100000);
        doc = tx.put("channel_doc", {
          id: documentId,
          scopeId: channel.id,
          parentId: channel.id,
          title: required(cmd.title, "文档标题", 160),
          body,
          version: 1,
          versionId,
          authorId: actor.memberId || "owner",
          lastEditorId: actor.memberId || "owner",
          createdAt: tx.now,
          status: "draft",
        });
        tx.put("channel_doc_version", {
          id: versionId,
          scopeId: channel.id,
          parentId: documentId,
          body,
          version: 1,
          authorId: actor.memberId || "owner",
          createdAt: tx.now,
          reason: "创建文档",
        });
        await channelMessage(tx, channel, actor, `创建文档：${doc.title}`, {
          type: "document",
          documentId: doc.id,
        });
        if(cmd.folderId)await placeMaterial(tx,channel.id,'document',doc.id,cmd.folderId,actor);
        return doc;
      }
      if (type === "channel.doc.edit") {
        if (doc.version !== cmd.expectedVersion)
          fail("version_conflict", "文档已被其他成员修改，请重读后合并", 409);
        const versionId = id("shared_version"),
          body = required(cmd.body, "文档正文", 100000),
          reason = required(cmd.reason, "修改原因", 1000);
        doc = tx.put("channel_doc", {
          ...doc,
          body,
          version: doc.version + 1,
          versionId,
          status: "draft",
          lastEditorId: actor.memberId || "owner",
        });
        tx.put("channel_doc_version", {
          id: versionId,
          scopeId: channel.id,
          parentId: doc.id,
          version: doc.version,
          body,
          reason,
          authorId: actor.memberId || "owner",
          createdAt: tx.now,
        });
        const readers=[...await tx.list('shared_read',{parent:doc.id}),...await tx.list('shared_watch',{parent:doc.id})];
        const targets=readers.map(r=>r.memberId).filter(mid=>mid!==actor.memberId&&channel.memberIds.includes(mid));
        const update=await channelMessage(tx,channel,actor,`更新文档：${doc.title} · v${doc.version}`,{type:'document',documentId:doc.id,resourceVersion:doc.version,hops:0});
        for(const mid of new Set(targets))await enqueue(tx,identity,channel,update,mid);
        await objectFeedback(tx,identity,channel,actor,{kind:'document',id:doc.id,version:doc.version},update,meetingHelpers);
        return doc;
      }
      if (type === "channel.doc.suggest")
        return tx.put("channel_suggestion", {
          id: id("suggestion"),
          scopeId: channel.id,
          parentId: doc.id,
          documentId: doc.id,
          baseVersion: doc.version,
          body: required(cmd.body, "建议稿", 100000),
          reason: required(cmd.reason, "建议原因", 1000),
          authorId: actor.memberId || "owner",
          status: "pending",
          createdAt: tx.now,
        });
      if (type === "channel.doc.deliver") {
        const delivery = tx.put("channel_delivery", {
          id: id("delivery"),
          scopeId: channel.id,
          parentId: doc.id,
          documentId: doc.id,
          versionId: doc.versionId,
          version: doc.version,
          authorId: actor.memberId || "owner",
          createdAt: tx.now,
          status: "delivered",
        });
        tx.put("channel_doc", {
          ...doc,
          status: "delivered",
          deliveredVersion: doc.version,
        });
        await channelMessage(
          tx,
          channel,
          actor,
          required(cmd.summary, "交付说明", 2000),
          {
            type: "delivery",
            documentId: doc.id,
            deliveryId: delivery.id,
            version: doc.version,
          },
        );
        if (actor.memberId)
          for (const turn of await tx.list("channel_turn", {
            scope: channel.id,
            parent: actor.memberId,
            status: "active",
          }))
            await finishTurn(tx, actor, turn.id, "done", "已交付共享文档");
        return delivery;
      }
      if (type === "channel.ask") {
        const question = tx.put("channel_question", {
          id: id("question"),
          scopeId: channel.id,
          parentId: channel.id,
          question: required(cmd.question, "问题", 4000),
          options: listIds(cmd.options, "选项").map((x) =>
            required(x, "选项", 1000),
          ),
          authorId: actor.memberId || "owner",
          status: "pending",
          createdAt: tx.now,
        });
        await channelMessage(tx, channel, actor, question.question, {
          type: "question",
          questionId: question.id,
        });
        // Asking is already a response to the current notification. Yield the
        // native account while waiting; the user's answer creates a fresh turn.
        // Otherwise the original lease would block that answer for 30 minutes.
        if (actor.memberId)
          for (const turn of await tx.list("channel_turn", {
            scope: channel.id,
            parent: actor.memberId,
            status: "active",
          }))
            await finishTurn(
              tx,
              actor,
              turn.id,
              "done",
              "已提问，等待用户回复",
            );
        return question;
      }
      if (type === "channel.answer") {
        await owner(actor,tx);
        const q = await tx.get("channel_question", cmd.questionId);
        if (q.scopeId !== channel.id || q.status !== "pending")
          fail("question_closed", "这个问题已处理或不属于本群", 409);
        const answer = required(cmd.answer, "回答", 4000);
        tx.put("channel_question", {
          ...q,
          status: "answered",
          answer,
          answeredAt: tx.now,
        });
        const message = await channelMessage(tx, channel, actor, answer, {
          type: "answer",
          questionId: q.id,
          mentions: q.authorId === "owner" ? [] : [q.authorId],
          hops: 0,
        });
        if (channel.memberIds.includes(q.authorId))
          await enqueue(tx, identity, channel, message, q.authorId);
        return message;
      }
      if (type === "channel.suggestion.review") {
        await owner(actor,tx);
        const suggestion = await tx.get("channel_suggestion", cmd.suggestionId),
          d = await tx.get("channel_doc", suggestion.documentId);
        if (
          suggestion.scopeId !== channel.id ||
          suggestion.status !== "pending"
        )
          fail("invalid_suggestion", "建议已处理或不属于本群", 409);
        if (cmd.accept) {
          if (d.version !== suggestion.baseVersion)
            fail("version_conflict", "原稿已变化，请人工合并建议", 409);
          const versionId = id("shared_version");
          tx.put("channel_doc", {
            ...d,
            body: suggestion.body,
            version: d.version + 1,
            versionId,
            status: "draft",
            lastEditorId: "owner",
          });
          tx.put("channel_doc_version", {
            id: versionId,
            scopeId: channel.id,
            parentId: d.id,
            version: d.version + 1,
            body: suggestion.body,
            reason: `采纳建议：${suggestion.reason}`,
            authorId: "owner",
            suggestedBy: suggestion.authorId,
            createdAt: tx.now,
          });
        }
        return tx.put("channel_suggestion", {
          ...suggestion,
          status: cmd.accept ? "accepted" : "rejected",
        });
      }
      if (type === "channel.meeting") {
        if (cmd.action === "open")
          return tx.put("channel_meeting", {
            id: id("meeting"),
            scopeId: channel.id,
            parentId: channel.id,
            title: required(cmd.title, "会议主题", 200),
            openedBy: actor.memberId || "owner",
            status: "open",
            startMessage: channel.messageSequence,
            createdAt: tx.now,
          });
        if (cmd.action !== "close") fail("invalid_action", "会议操作无效");
        const meeting = await tx.get("channel_meeting", cmd.meetingId);
        if (meeting.scopeId !== channel.id)
          fail("forbidden", "会议不属于本群", 403);
        return tx.put("channel_meeting", {
          ...meeting,
          status: "closed",
          summary: required(cmd.summary, "会议结论", 12000),
          endMessage: channel.messageSequence,
          closedBy: actor.memberId || "owner",
          closedAt: tx.now,
        });
      }
      fail("unknown_command", "未知沟通工具", 404);
    },
    now,
  );
}

const toolCommands = {
  resolve_delivery: "channel.delivery.resolve",
  coordinate: "channel.coordination",
  manage_material: "channel.material",
  post_message: "channel.post",
  stay_silent: "channel.silent",
  create_doc: "channel.doc.create",
  manage_folder: "channel.folder",
  move_material: "channel.material.move",
  edit_doc: "channel.doc.edit",
  suggest_edit: "channel.doc.suggest",
  ask_user: "channel.ask",
  deliver: "channel.doc.deliver",
  remember: "channel.remember",
  revise_memory: "channel.memory.update",
  meeting: "channel.meeting",
  board_task: "channel.task",
};
export async function conversationTool(repo, identity, actor, name, args) {
  if (["search_memory","read_memory","read_todo","read_space_object"].includes(name)) return readSpaceObject(repo,actor,args);
  if (name === "read_channel") return readChannel(repo, identity, actor, args);
  if (name === 'meeting' && args.action === 'read') return meetingDetail(repo, identity, actor, args);
  if (name === "read_doc") {
    const doc = await repo.get("channel_doc", args.documentId);
    await channelAccess(repo, doc.scopeId, actor);
    if(doc.status==='deleted')fail('resource_deleted','这份资料已移入回收站',410);
    if(actor.memberId) await repo.transact(id('doc-read'),{documentId:doc.id,actor},tx=>tx.put('shared_read',{id:doc.id+':'+actor.memberId,parentId:doc.id,scopeId:doc.scopeId,memberId:actor.memberId,version:doc.version,createdAt:tx.now}));
    return {
      ...doc,
      versions: await repo.list("channel_doc_version", {
        parent: doc.id,
        order: "recent",
        limit: 100,
      }),
    };
  }
  return conversationCommand(repo, identity, actor, {
    ...args,
    type: toolCommands[name],
  });
}

export async function conversationMaintenance(
  repo,
  identity,
  now = new Date().toISOString(),
) {
  await meetingMaintenance(repo, identity, meetingHelpers, now);
  for (const turn of await repo.list("channel_turn", {
    status: "active",
    limit: 100,
  }))
    if (turn.expiresAt <= now)
      await repo.transact(
        `turn-expire:${turn.id}:${turn.expiresAt}`,
        {},
        async (tx) => {
          const t = await tx.get("channel_turn", turn.id);
          if (t.status !== "active" || t.expiresAt > now) return {};
          tx.put("channel_turn", {
            ...t,
            status: "stalled",
            reason: "原 Agent 长时间没有回传；消息保留，需确认后继续",
          });
          const r = await tx.get("resource", t.resourceKey, false);
          if (r?.turnId === t.id)
            tx.put("resource", { ...r, status: "idle", turnId: null });
          return {};
        },
        now,
      );
  await deliveryReviewMaintenance(repo,identity,meetingHelpers,now);
}

export const meetingHelpers = { channelMessage, enqueue, finishTurn, objectFeedback, outbox, meetingTurnAllowed };
