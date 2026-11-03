import { fail, id, required } from "./repository.mjs";
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
    "以自己的真实身份在群中发言。mentions 使用群内成员 ID，只有明确需要对方行动时才 @。turnId 表示已处理的通知；普通回复不创建任务。",
    {
      requestId: "string",
      channelId: "string",
      body: "string",
      mentions: "array",
      replyTo: "string",
      turnId: "string",
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
    },
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
    "提出团队经验，用户批准后才进入群知识。",
    {
      requestId: "string",
      channelId: "string",
      title: "string",
      body: "string",
    },
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
    "可选看板工具：create 或 update 事项，可指定群内执行成员；只记录约定，不另起强制工作流。",
    {
      requestId: "string",
      channelId: "string",
      action: "string",
      title: "string",
      taskId: "string",
      assigneeId: "string",
      status: "string",
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
        t === "array"
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

export const CHANNEL_TOOLS = [...BASIC_CHANNEL_TOOLS.filter(t => t.name !== 'meeting'), ...MEETING_TOOLS];
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
const owner = (actor) => {
  if (!actor.owner) fail("forbidden", "只有用户可以修改群设置", 403);
};
const scoped = (channel, actor) => {
  if (!actor.owner && !channel.memberIds.includes(actor.memberId))
    fail("forbidden", "你不在这个群内", 403);
};
const messageText = (value) => required(value, "消息", 24000);
// Text-only native receivers can still address an existing group peer. This is
// ordinary message addressing, with the same membership authorization. Never
// resolve global names, ambiguous names, quoted examples or code as recipients.
function textMentions(body, channel, identity) {
  const plain = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("> "))
    .join("\n");
  const names = new Map();
  for (const mid of channel.memberIds) {
    const name = activeMember(identity, mid)?.name;
    if (name) names.set(name, [...(names.get(name) || []), mid]);
  }
  return [...names]
    .filter(
      ([name, ids]) =>
        ids.length === 1 &&
        new RegExp(
          `(^|[\\s])@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s，。,:：?？!！;；])`,
          "u",
        ).test(plain),
    )
    .map(([, ids]) => ids[0]);
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
  scoped(channel, actor);
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
  return message;
}
async function enqueue(tx, identity, channel, message, memberId) {
  const m = activeMember(identity, memberId),
    connection = await tx.get("connection", memberId, false);
  if (!m) return;
  const turnId = `turn_${message.id}_${memberId}`;
  const deferred = message.hops > channel.maxHops;
  const available = !m.paused && connection?.status === "verified";
  const turn = tx.put("channel_turn", {
    id: turnId,
    scopeId: channel.id,
    parentId: memberId,
    memberId,
    messageId: message.id,
    wakeSource: message.authorId === "owner" ? "user" : "agent",
    number: message.number,
    rootId: message.rootId || message.id,
    hops: message.hops || 0,
    status: deferred ? "limited" : available ? "ready" : "unavailable",
    createdAt: tx.now,
    ...(message.meetingId ? { meetingId: message.meetingId, meetingRound: message.meetingRound, meetingVersion: message.meetingVersion, meetingStage: message.meetingStage,meetingPurpose:message.meetingPurpose,ownerMessageId:message.ownerMessageId } : {}),
    reason: deferred
      ? "达到本群连续唤醒上限，消息已保留，可继续讨论"
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
  const r = await tx.get("resource", turn.resourceKey, false);
  if (r?.turnId === turn.id)
    tx.put("resource", { ...r, status: "idle", turnId: null });
}

export async function conversationWork(repo, identity, memberId) {
  const turns = (
    await Promise.all(
      ["ready", "active"].map((status) =>
        repo.list("channel_turn", { parent: memberId, status, limit: 500 }),
      ),
    )
  ).flat();
  const result = [];
  for (const turn of turns) {
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
      status: turn.status === "ready" ? "ready" : "claimed",
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
          scoped(selected, actor);
          if (selected.status !== "active")
            return { status: "empty", reason: "channel_inactive" };
        }
        const resource = await tx.get("resource", connection.resourceKey, false);
        if (resource?.status === "busy") return { status: "busy" };
        const pending = (await tx.list("channel_turn", {
          parent: actor.memberId,
          status: "ready",
          ...(args.channelId ? { scope: args.channelId } : {}),
          limit: 500,
        })).sort((a, b) => Number(b.meetingPurpose==='user_update')-Number(a.meetingPurpose==='user_update')||a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        for (const candidate of pending) {
          const group = await tx.get("channel", candidate.scopeId, false);
          if (group?.status !== "active" || !group.memberIds.includes(actor.memberId)) continue;
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
      scoped(channel, actor);
      if (turn.memberId !== actor.memberId)
        fail("forbidden", "通知不属于此成员", 403);
      if (turn.status !== "ready")
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
      const resource = await tx.get("resource", c.resourceKey, false);
      if (resource?.status === "busy")
        fail("resource_busy", "原 Agent 正在处理另一条通知，稍后再读", 409);
      tx.guardLegacyIdle(member.accountId);
      const pending = (await tx.list("channel_turn", {
        scope: channel.id,
        parent: actor.memberId,
        status: "ready",
      })).filter(t => (t.meetingId || null) === (turn.meetingId || null) && (!turn.meetingId || (t.meetingVersion === turn.meetingVersion && t.meetingRound === turn.meetingRound && t.meetingStage === turn.meetingStage&&t.meetingPurpose===turn.meetingPurpose)));
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
        resourceKey: c.resourceKey,
        claimedAt: tx.now,
        ...(turn.meetingId?{claimedOwnerMessageId:(await tx.get('channel_meeting',turn.meetingId)).lastOwnerMessageId}:{}),
        expiresAt: new Date(Date.parse(tx.now) + 30 * 60000).toISOString(),
        mergedMessageIds: pending.map((t) => t.messageId),
      });
      tx.put("resource", {
        ...resource,
        id: c.resourceKey,
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
          ...(turn.meetingId ? { meetingId: turn.meetingId, meetingRound: turn.meetingRound, meetingVersion: turn.meetingVersion } : {}),
          channelId: channel.id,
          coordinatorId: channel.coordinatorId,
          members: channel.memberIds.map((memberId) => ({
            id: memberId,
            name: activeMember(identity, memberId)?.name || memberId,
          })),
          triggerMessageIds: pending.map((t) => t.messageId),
          instruction:
            "群里有新消息。先调用 read_channel(channelId) 查看真实上下文。你是独立成员，可直接回复、@群内其他成员、追问、提出异议、共同写文档，或 stay_silent；用户指定的负责人可协调但不是唯一发言人。无新信息不要互相点头刷屏。post_message/stay_silent 带 turnId 结束本次通知。不要把普通聊天写成正式成果。若平台暂时只提供旧工具，submit_work 的正文会原样发到群里，不创建任务或成果；旧回传通道也能用“@本群唯一备注名”明确通知对方，引用和代码不通知。创建或修改文档等新能力需要刷新工具列表后调用，不能虚报已使用。不要声称未实际读取的资料或其他成员已回复。",
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
    documents,
    decisions,
    knowledge: actor.owner
      ? knowledge
      : knowledge.filter((k) => k.status === "approved"),
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
          }),
        )
      : [],
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
        owner(actor);
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
      scoped(channel, actor);
      if (type === 'channel.meeting') return handleMeeting(tx, identity, actor, cmd, channel, meetingHelpers);
      if (type === "channel.update") {
        owner(actor);
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
        tx.put("channel", channel);
        return channel;
      }
      if (type === "channel.post") {
        const body = messageText(cmd.body);
        // Legacy housekeeping states must never require the human to unlock chat.
        // An Agent cannot reactivate a stopped channel on its own.
        if (channel.status !== "active") {
          if (!actor.owner)
            fail("channel_paused", "此会话暂不接收 Agent 回复", 409);
          channel.status = "active";
          tx.put("channel", channel);
        }
        const meeting = await meetingPost(tx, identity, actor, { ...cmd, body }, channel, meetingHelpers);
        if (meeting?.handled) return meeting.result;
        const mentions = listIds(
          cmd.mentions === undefined
            ? textMentions(body, channel, identity)
            : cmd.mentions,
          "提及",
        );
        if (mentions.some((mid) => !channel.memberIds.includes(mid)))
          fail("invalid_mention", "只能 @ 本群成员");
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
        if (actor.memberId && !parent)
          fail(
            "context_required",
            "Agent 发言必须关联群内消息或已领取通知",
            409,
          );
        const message = await channelMessage(tx, channel, actor, body, {
          ...(meeting?.meetingId ? { meetingId: meeting.meetingId, sourceVersion: meeting.sourceVersion } : {}),
          mentions,
          mentionsFromText: cmd.mentions === undefined && mentions.length > 0,
          replyTo: parent?.id || null,
          rootId: actor.owner ? null : parent?.rootId || parent?.id,
          hops: actor.owner ? 0 : (turn?.hops ?? parent?.hops ?? 0) + 1,
        });
        const targets = actor.owner
          ? mentions.length
            ? mentions
            : channel.memberIds
          : mentions.filter((mid) => mid !== actor.memberId);
        for (const mid of targets)
          await enqueue(tx, identity, channel, message, mid);
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
        owner(actor);
        for (const turn of (
          await Promise.all(
            ["limited", "unavailable", "stalled"].map((status) =>
              tx.list("channel_turn", { scope: channel.id, status }),
            ),
          )
        ).flat()) {
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
        owner(actor);
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
      if (type === "channel.remember")
        return tx.put("channel_memory", {
          id: id("memory"),
          scopeId: channel.id,
          parentId: channel.id,
          title: required(cmd.title, "知识标题", 160),
          body: required(cmd.body, "知识正文", 12000),
          authorId: actor.memberId || "owner",
          status: "pending",
          createdAt: tx.now,
        });
      if (type === "channel.memory.review") {
        owner(actor);
        const memory = await tx.get("channel_memory", cmd.memoryId);
        if (memory.scopeId !== channel.id)
          fail("forbidden", "知识不属于此群", 403);
        if (!["approved", "rejected"].includes(cmd.status))
          fail("invalid_status", "请选择记住或不用");
        return tx.put("channel_memory", { ...memory, status: cmd.status });
      }
      if (type === "channel.suggestion.review") {
        owner(actor);
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
      if (type === "channel.task") {
        let task =
          cmd.action === "create"
            ? {
                id: id("board"),
                scopeId: channel.id,
                parentId: channel.id,
                status: "todo",
                createdAt: tx.now,
                authorId: actor.memberId || "owner",
              }
            : await tx.get("channel_task", cmd.taskId);
        if (
          !["create", "update"].includes(cmd.action) ||
          task.scopeId !== channel.id
        )
          fail("invalid_task", "事项操作无效");
        if (cmd.title !== undefined)
          task.title = required(cmd.title, "事项", 1000);
        if (!task.title) fail("invalid_input", "请填写事项");
        if (cmd.assigneeId !== undefined) {
          if (cmd.assigneeId && !channel.memberIds.includes(cmd.assigneeId))
            fail("invalid_member", "执行成员须在本群内");
          task.assigneeId = cmd.assigneeId || null;
        }
        if (cmd.status !== undefined) {
          if (!["todo", "doing", "done"].includes(cmd.status))
            fail("invalid_status", "事项状态无效");
          task.status = cmd.status;
        }
        return tx.put("channel_task", task);
      }
      fail("unknown_command", "未知沟通工具", 404);
    },
    now,
  );
}

const toolCommands = {
  post_message: "channel.post",
  stay_silent: "channel.silent",
  create_doc: "channel.doc.create",
  edit_doc: "channel.doc.edit",
  suggest_edit: "channel.doc.suggest",
  ask_user: "channel.ask",
  deliver: "channel.doc.deliver",
  remember: "channel.remember",
  meeting: "channel.meeting",
  board_task: "channel.task",
};
export async function conversationTool(repo, identity, actor, name, args) {
  if (name === "read_channel") return readChannel(repo, identity, actor, args);
  if (name === 'meeting' && args.action === 'read') return meetingDetail(repo, identity, actor, args);
  if (name === "read_doc") {
    const doc = await repo.get("channel_doc", args.documentId);
    await channelAccess(repo, doc.scopeId, actor);
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
}

export const meetingHelpers = { channelMessage, enqueue, finishTurn };
