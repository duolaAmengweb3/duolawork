import { digest, fail, id, required } from "./repository.mjs";
import { claimConversation, readChannel } from "./conversation.mjs";
import { meetingTurnContext } from './meetings.mjs';
export const MAX_MESSAGE_WAIT_SECONDS = 45;

export async function withConversationContext(repo, identity, actor, claim) {
  if (!claim.turnId) return claim;
  const turn = await repo.get('channel_turn', claim.turnId);
  const [context,meeting]=await Promise.all([
    readChannel(repo, identity, actor, { channelId: claim.channelId }),
    meetingTurnContext(repo, identity, actor, turn),
  ]);
  return {
    ...claim,
    input: {
      ...claim.input,
      ...(meeting ? { meeting, meetingInstruction: meeting.instruction, meetingToolFallback: meeting.toolFallback } : {}),
      channel: context.channel,
      members: context.members,
      messages: context.messages,
      earlierMessagesBefore: context.before,
      documents: context.documents,
      knowledge: context.knowledge,
      decisions: context.decisions,
      tasks: context.tasks,
      meetings: context.meetings.map(({id,title,status,coordinatorId,startedAt,endedAt,version})=>({id,title,status,coordinatorId,startedAt,endedAt,version})),
      instruction: claim.input.instruction.replace(
        "先调用 read_channel(channelId) 查看真实上下文。",
        "本结果已包含最新群消息与共享空间，无需重复 read_channel；需要更早消息时再分页。",
      ),
      continuation: {
        tool: "claim_work",
        stepId: "inbox:after:" + claim.turnId,
        afterTurnId: claim.turnId,
        channelId: claim.channelId,
        maxWaitSeconds: MAX_MESSAGE_WAIT_SECONDS,
        instruction: "正常回复或静默后，可在同一次运行调用 claim_work，stepId 使用此处的 inbox:after:<turnId>、新 requestId，等待本群后续消息一次（最多45秒）。这是接收下一条消息，不是重复领取已完成通知。返回 empty/busy 就停止，不循环空跑。",
      },
    },
  };
}

const pause = (ms, signal) => new Promise((resolve) => {
  const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener("abort", finish, { once: true });
  if (signal?.aborted) finish();
});

// A bounded, request-owned wait. No always-on model loop, global waiter, or
// subscription change. The durable deadline lets dispatch recover after a crash.
export async function receiveMessages(repo, identity, actor, args, options = {}) {
  if (!actor.memberId) fail("member_required", "需要成员身份", 403);
  const member = identity.members.find(m => m.id === actor.memberId && m.status !== "disabled" && !m.paused);
  if (!member) fail("unavailable", "成员当前不可接收消息", 409);
  required(args.requestId, "幂等请求编号", 150);
  const seconds = args.waitSeconds ?? 0;
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_MESSAGE_WAIT_SECONDS)
    fail("invalid_wait", "消息等待应为 0 到 45 秒");
  if (seconds && !args.afterTurnId)
    fail("invalid_wait", "仅在回应后短暂等待连续消息");
  const clock = options.clock || Date.now, sleep = options.sleep || pause;
  const selection = { requestId: args.requestId, receiveNext: true,
    ...(args.channelId ? { channelId: args.channelId } : {}),
    ...(args.afterTurnId ? { afterTurnId: args.afterTurnId } : {}), waitSeconds: seconds };
  let prior;
  if (args.afterTurnId) {
    prior = await repo.get("channel_turn", args.afterTurnId);
    if (prior.memberId !== actor.memberId) fail("forbidden", "通知不属于此成员", 403);
    if (!["done", "silent"].includes(prior.status)) fail("invalid_wait", "请先回应本次消息");
    if (args.channelId && args.channelId !== prior.scopeId)
      fail("forbidden", "不能借其他群的回应开启等待", 403);
    selection.channelId = prior.scopeId;
  }
  const receipt = await repo.db.prepare(
    "SELECT fingerprint,result FROM hub_v2_receipts WHERE workspace_id=? AND request_id=?",
  ).bind(repo.workspaceId, args.requestId).first();
  if (receipt) {
    if (receipt.fingerprint !== await digest(JSON.stringify({ ...selection, actor })))
      fail("idempotency_conflict", "同一请求编号不能用于不同操作", 409);
    return withConversationContext(repo, identity, actor, JSON.parse(receipt.result));
  }
  const connection = await repo.get("connection", actor.memberId);
  if (connection.status !== "verified") fail("unavailable", "成员当前不可接收消息", 409);
  let waitKey, deadline = clock();
  if (prior) {
    const group = await repo.get("channel", prior.scopeId);
    if (!group.memberIds.includes(actor.memberId)) fail("forbidden", "成员不在该群", 403);
    if (seconds) {
      waitKey = `${prior.scopeId}:${actor.memberId}`;
      const wait = await repo.transact(args.requestId + ":wait", { ...selection, actor }, async tx => {
        const previous = await tx.get("channel_wait", waitKey, false);
        if (previous?.afterTurnId === prior.id || previous?.afterNumber > prior.number)
          return { exhausted: true };
        if (previous?.status === "waiting" && previous.expiresAt > tx.now)
          fail("wait_in_progress", "同一成员已有消息等待", 409);
        const row = tx.put("channel_wait", { id: waitKey, scopeId: prior.scopeId,
          parentId: actor.memberId, status: "waiting", requestId: args.requestId,
          afterTurnId: prior.id, afterNumber: prior.number, configVersion: connection.configVersion,
          expiresAt: new Date(clock() + seconds * 1000).toISOString() });
        return { expiresAt: row.expiresAt };
      }, new Date(clock()).toISOString());
      if (wait.exhausted) { waitKey = null; deadline = clock(); }
      else deadline = Date.parse(wait.expiresAt);
    }
  }
  try {
    let checks = 0;
    while (true) {
      if (options.signal?.aborted) fail("request_aborted", "等待已停止，消息仍保留", 409);
      // One indexed snapshot per check, rather than repeatedly loading all
      // groups, messages and artifacts. Leave room for the Free D1 query budget.
      const channelId = selection.channelId || "";
      const snapshot = await repo.db.prepare(`SELECT c.body AS connection_json,
        (SELECT r.body FROM hub_v2_records r WHERE r.workspace_id=c.workspace_id AND r.kind='resource' AND r.id=json_extract(c.body,'$.resourceKey')) AS resource_json,
        (SELECT g.body FROM hub_v2_records g WHERE g.workspace_id=c.workspace_id AND g.kind='channel' AND g.id=?) AS group_json,
        EXISTS(SELECT 1 FROM hub_v2_records t JOIN hub_v2_records g ON g.workspace_id=t.workspace_id AND g.kind='channel' AND g.id=t.scope_id
          WHERE t.workspace_id=c.workspace_id AND t.kind='channel_turn' AND t.parent_id=? AND t.status='ready'
          AND (?='' OR t.scope_id=?) AND g.status='active'
          AND EXISTS(SELECT 1 FROM json_each(g.body,'$.memberIds') m WHERE m.value=t.parent_id)) AS has_ready
        FROM hub_v2_records c WHERE c.workspace_id=? AND c.kind='connection' AND c.id=?`)
        .bind(channelId, actor.memberId, channelId, channelId, repo.workspaceId, actor.memberId).first();
      if (!snapshot) fail("unavailable", "连接已移除，停止等待", 409);
      const current = JSON.parse(snapshot.connection_json);
      if (current.status !== "verified" || current.configVersion !== connection.configVersion)
        fail("unavailable", "连接已变化，停止等待", 409);
      const group = snapshot.group_json ? JSON.parse(snapshot.group_json) : null;
      if (group && !group.memberIds.includes(actor.memberId))
        fail("forbidden", "成员已离开该群，停止等待", 403);
      const resource = snapshot.resource_json ? JSON.parse(snapshot.resource_json) : null;
      if (snapshot.has_ready || (group && group.status !== "active") || resource?.status === "busy" || clock() >= deadline) {
        const claim = await claimConversation(repo, identity, actor,
          { ...selection, ...(channelId ? { channelId } : {}) }, new Date(clock()).toISOString());
        return withConversationContext(repo, identity, actor, claim);
      }
      await sleep(Math.min(Math.min(4000, ++checks * 1000), deadline - clock()), options.signal);
    }
  } finally {
    if (waitKey) await repo.transact(id("end-wait"), { waitKey, requestId: args.requestId }, async tx => {
      const wait = await tx.get("channel_wait", waitKey, false);
      if (wait?.requestId === args.requestId && wait.status === "waiting")
        tx.put("channel_wait", { ...wait, status: "finished", finishedAt: tx.now });
      return {};
    }, new Date(clock()).toISOString());
  }
}
