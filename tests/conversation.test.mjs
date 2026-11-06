import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./collaboration-helper.mjs";
import {
  conversationCommand as command,
  readChannel,
  claimConversation,
  conversationTool,
  conversationWork,
} from "../cloud/collaboration/conversation.mjs";
import { callTool, TOOLS } from "../cloud/collaboration/api.mjs";
import {
  dispatchOne,
  maintenance,
} from "../cloud/collaboration/dispatcher.mjs";
const user = { owner: true },
  agent = (memberId) => ({ memberId });
async function setup(t) {
  const f = await fixture(t);
  let n = 0;
  const send = (type, args = {}, actor = user) =>
    command(f.repo, f.identity, actor, {
      type,
      requestId: `chat-request-${++n}`,
      ...args,
    });
  const c = await send("channel.create", {
    name: "交流空间",
    memberIds: ["grok", "check"],
    coordinatorId: "grok",
  });
  return { ...f, c, send };
}
test("ordinary chat creates no runs, tasks or documents; only actual group members are notified", async (t) => {
  const f = await setup(t),
    before = (await f.repo.list("run")).length;
  const m = await f.send("channel.post", {
    channelId: f.c.id,
    body: "都在线吗？",
  });
  assert.equal((await f.repo.list("run")).length, before);
  assert.equal((await f.repo.list("channel_task")).length, 0);
  assert.equal((await f.repo.list("channel_doc")).length, 0);
  assert.deepEqual(
    (await f.repo.list("channel_turn")).map((t) => t.memberId).sort(),
    ["grok"],
  );
  const work = await conversationWork(f.repo, f.identity, "grok");
  const claim = await claimConversation(f.repo, f.identity, agent("grok"), {
    requestId: "claim",
    stepId: work[0].stepId,
  });
  const reply = await f.send(
    "channel.post",
    { channelId: f.c.id, body: "我在，可以直接沟通。", turnId: claim.turnId },
    agent("grok"),
  );
  assert.equal(reply.authorId, "grok");
  assert.equal(reply.replyTo, m.id);
  assert.equal((await f.repo.list("channel_doc")).length, 0);
  assert.equal((await f.repo.get("channel_turn", claim.turnId)).status, "done");
  const channel = await readChannel(f.repo, f.identity, user, {
    channelId: f.c.id,
  });
  assert.deepEqual(
    channel.members.map((m) => m.id),
    ["grok", "check"],
  );
});
test("human messages continue the same legacy paused or archived chat without an unlock step", async (t) => {
  const f = await setup(t);
  const original = await f.send("channel.post", { channelId: f.c.id, body: "原有聊天" });
  for (const status of ["paused", "archived"]) {
    await f.send("channel.update", { channelId: f.c.id, status });
    await assert.rejects(
      () => f.send("channel.post", { channelId: f.c.id, body: "Agent 不得自行恢复" }, agent("check")),
      e => e.code === "channel_paused",
    );
    assert.equal((await f.repo.get("channel", f.c.id)).status, status);
    await f.send("channel.post", { channelId: f.c.id, body: "继续说话：" + status });
    const view = await readChannel(f.repo, f.identity, user, { channelId: f.c.id });
    assert.equal(view.channel.status, "active");
    assert.equal(view.messages[0].id, original.id);
    assert.equal(view.messages.at(-1).body, "继续说话：" + status);
    assert.ok((await conversationWork(f.repo, f.identity, "grok")).some(w => w.channelId === f.c.id));
  }
  assert.equal((await f.repo.list("channel")).length, 1);
});
test("opening a prior direct chat preserves its history even with a legacy archived state", async (t) => {
  const f = await setup(t);
  const dm = await f.send("channel.create", { name: "Grok", direct: true, memberIds: ["grok"] });
  const before = await f.send("channel.post", { channelId: dm.id, body: "之前的单聊" });
  await f.send("channel.update", { channelId: dm.id, status: "archived" });
  const reopened = await f.send("channel.create", { name: "Grok", direct: true, memberIds: ["grok"] });
  assert.equal(reopened.id, dm.id);
  await f.send("channel.post", { channelId: reopened.id, body: "继续原来的单聊" });
  const view = await readChannel(f.repo, f.identity, user, { channelId: dm.id });
  assert.equal(view.messages[0].id, before.id);
  assert.equal(view.messages.length, 2);
});
test("coordinator is user-selected and replaceable without changing members or communication", async (t) => {
  const f = await setup(t);
  await f.send("channel.post", { channelId: f.c.id, body: "原消息" });
  const updated = await f.send("channel.update", {
    channelId: f.c.id,
    coordinatorId: "check",
  });
  assert.equal(updated.coordinatorId, "check");
  assert.deepEqual(updated.memberIds, ["grok", "check"]);
  assert.equal((await f.repo.list("channel_message")).length, 1);
  await assert.rejects(
    () =>
      f.send(
        "channel.update",
        { channelId: f.c.id, coordinatorId: "grok" },
        agent("check"),
      ),
    (e) => e.code === "forbidden",
  );
  await f.send("channel.update", { channelId: f.c.id, memberIds: ["grok"] });
  assert.equal((await f.repo.get("channel", f.c.id)).coordinatorId, null);
  assert.equal(f.identity.members.length, 3);
  assert.equal((await f.repo.get("connection", "check")).status, "verified");
});
test("agents can directly @ each other both directions, preserve messages arriving while busy, and remain silent", async (t) => {
  const f = await setup(t);
  await f.send("channel.post", {
    channelId: f.c.id,
    body: "一起想一个办法",
    mentions: ["grok"],
  });
  const a = (await conversationWork(f.repo, f.identity, "grok"))[0];
  const claim = await claimConversation(f.repo, f.identity, agent("grok"), {
    requestId: "g1",
    stepId: a.stepId,
  });
  await f.send("channel.post", {
    channelId: f.c.id,
    body: "补充：预算100元",
    mentions: ["grok"],
  });
  await f.send(
    "channel.post",
    {
      channelId: f.c.id,
      turnId: claim.turnId,
      body: "你觉得这个预算够吗？",
      mentions: ["check"],
    },
    agent("grok"),
  );
  assert.equal((await conversationWork(f.repo, f.identity, "grok")).length, 1);
  const b = (await conversationWork(f.repo, f.identity, "check"))[0];
  const cb = await claimConversation(f.repo, f.identity, agent("check"), {
    requestId: "c1",
    stepId: b.stepId,
  });
  await f.send(
    "channel.post",
    {
      channelId: f.c.id,
      turnId: cb.turnId,
      body: "不够，需要缩小范围。",
      mentions: ["grok"],
    },
    agent("check"),
  );
  const pending = await conversationWork(f.repo, f.identity, "grok");
  assert.equal(pending.length, 2);
  const ca = await claimConversation(f.repo, f.identity, agent("grok"), {
    requestId: "g2",
    stepId: pending[0].stepId,
  });
  assert.equal((await conversationWork(f.repo, f.identity, "grok")).length, 1);
  const count = (await f.repo.list("channel_message")).length;
  await f.send(
    "channel.silent",
    { turnId: ca.turnId, reason: "已读，暂无补充" },
    agent("grok"),
  );
  assert.equal((await f.repo.list("channel_message")).length, count);
  assert.equal((await f.repo.get("resource", "grok")).status, "idle");
});
test("scoped authorization, idempotency and immutable sender reject cross-group spoofing", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    () =>
      readChannel(f.repo, f.identity, agent("write"), { channelId: f.c.id }),
    (e) => e.code === "forbidden",
  );
  await assert.rejects(
    () =>
      f.send("channel.post", {
        channelId: f.c.id,
        body: "hi",
        mentions: ["write"],
      }),
    (e) => e.code === "invalid_mention",
  );
  const cmd = {
    type: "channel.post",
    requestId: "same",
    channelId: f.c.id,
    body: "hi",
  };
  const a = await command(f.repo, f.identity, user, cmd),
    b = await command(f.repo, f.identity, user, cmd);
  assert.equal(a.id, b.id);
  await assert.rejects(
    () => command(f.repo, f.identity, user, { ...cmd, body: "changed" }),
    (e) => e.code === "idempotency_conflict",
  );
  await assert.rejects(
    () =>
      f.send(
        "channel.post",
        { channelId: f.c.id, body: "spoof" },
        agent("check"),
      ),
    (e) => e.code === "context_required",
  );
});
test("shared tools use conflict-safe versions, user decisions and approved memory; no forced workflow", async (t) => {
  const f = await setup(t),
    c = f.c.id;
  const doc = await f.send(
    "channel.doc.create",
    { channelId: c, title: "共同稿", body: "第一版" },
    agent("grok"),
  );
  const v2 = await f.send(
    "channel.doc.edit",
    {
      documentId: doc.id,
      expectedVersion: 1,
      body: "修订稿",
      reason: "补充证据",
    },
    agent("check"),
  );
  await assert.rejects(
    () =>
      f.send(
        "channel.doc.edit",
        {
          documentId: doc.id,
          expectedVersion: 1,
          body: "覆盖",
          reason: "旧稿",
        },
        agent("grok"),
      ),
    (e) => e.code === "version_conflict",
  );
  await f.send(
    "channel.doc.deliver",
    { documentId: doc.id, summary: "共同修订稿已准备好" },
    agent("grok"),
  );
  assert.equal((await f.repo.list("channel_delivery"))[0].version, 2);
  const q = await f.send(
    "channel.ask",
    { channelId: c, question: "预算选哪个？", options: ["100元", "200元"] },
    agent("check"),
  );
  await f.send("channel.answer", {
    channelId: c,
    questionId: q.id,
    answer: "100元",
  });
  assert.equal(
    (await f.repo.list("channel_turn")).find((t) => t.memberId === "check")
      .status,
    "ready",
  );
  const memory = await f.send(
    "channel.remember",
    { channelId: c, title: "写法", body: "简洁直接" },
    agent("check"),
  );
  assert.equal(
    (await readChannel(f.repo, f.identity, agent("grok"), { channelId: c }))
      .knowledge.length,
    0,
  );
  await f.send("channel.memory.review", {
    channelId: c,
    memoryId: memory.id,
    status: "approved",
  });
  assert.equal(
    (await readChannel(f.repo, f.identity, agent("grok"), { channelId: c }))
      .knowledge.length,
    1,
  );
  const mt = await f.send("channel.meeting", {
    channelId: c,
    action: "open",
    title: "讨论",
  });
  await f.send("channel.meeting", {
    channelId: c,
    action: "close",
    meetingId: mt.id,
    summary: "先确认预算",
  });
  const task = await f.send("channel.task", {
    channelId: c,
    action: "create",
    title: "查报价",
    assigneeId: "check",
  });
  await f.send("channel.task", {
    channelId: c,
    action: "update",
    taskId: task.id,
    status: "done",
  });
  assert.equal((await f.repo.get("channel_task", task.id)).status, "done");
});
test("native legacy envelope keeps ordinary replies as chat, with actual scoped context", async (t) => {
  const f = await setup(t);
  await f.send("channel.post", {
    channelId: f.c.id,
    body: "都在线吗？",
    mentions: ["grok"],
  });
  const a = agent("grok"),
    work = (
      await callTool(f.repo, f.identity, a, "list_work", {}, {})
    ).work.find((w) => w.kind === "conversation");
  const claim = await callTool(
    f.repo,
    f.identity,
    a,
    "claim_work",
    { requestId: "native-claim", stepId: work.stepId },
    {},
  );
  assert.equal(claim.input.messages[0].body, "都在线吗？");
  assert.equal(
    claim.input.members.some((m) => m.id === "write"),
    false,
  );
  await callTool(
    f.repo,
    f.identity,
    a,
    "submit_work",
    {
      requestId: "native-reply",
      attemptId: claim.attemptId,
      lease: claim.lease,
      items: [{ title: "在线", body: "我在。" }],
    },
    {},
  );
  assert.equal(
    (await f.repo.list("channel_message")).at(-1)?.kind,
    "channel_message",
  );
  assert.equal((await f.repo.list("channel_doc")).length, 0);
});
test("explicit @ handoffs and @all survive a long discussion; old held work is not silently restarted", async (t) => {
  const f = await setup(t);
  await f.send("channel.update", { channelId: f.c.id, maxHops: 1 });
  let p = await f.send("channel.post", {
    channelId: f.c.id,
    body: "开始",
    mentions: ["grok"],
  });
  for (const [n, mid, target] of [
    [1, "grok", "check"],
    [2, "check", "grok"],
    [3, "grok", "check"],
  ]) {
    const w = (await conversationWork(f.repo, f.identity, mid)).find(
        (w) => w.status === "ready",
      ),
      c = await claimConversation(f.repo, f.identity, agent(mid), {
        requestId: "loop" + n,
        stepId: w.stepId,
      });
    p = await f.send(
      "channel.post",
      {
        channelId: f.c.id,
        turnId: c.turnId,
        body: "继续" + n,
        mentions: [target],
      },
      agent(mid),
    );
  }
  assert.equal((await f.repo.list('channel_turn',{status:'limited'})).length,0);
  const late=(await conversationWork(f.repo,f.identity,'check')).find(w=>w.messageId===p.id);
  assert.ok(late,'explicit review remains receivable beyond the former hop cap');
  const claim=await claimConversation(f.repo,f.identity,agent('check'),{requestId:'late-all',stepId:late.stepId});
  const all=await f.send('channel.post',{channelId:f.c.id,turnId:claim.turnId,body:'请全员核对',mentionAll:true},agent('check'));
  const allTurn=(await f.repo.list('channel_turn')).find(t=>t.messageId===all.id);
  assert.equal(allTurn.status,'ready');assert.ok(allTurn.hops>1);
  // Migration never replays historical requests merely because the policy changed.
  await f.repo.transact('old-limited-fixture',{},async tx=>tx.put('channel_turn',{...allTurn,status:'limited'}));
  const limited=await f.repo.get('channel_turn',allTurn.id);
  const next = await f.send("channel.post", { channelId: f.c.id, body: "我继续问一句", mentions: ["grok"] });
  const nextTurn = (await f.repo.list("channel_turn", { status: "ready" })).find(turn => turn.messageId === next.id);
  assert.ok(nextTurn, "普通新消息直接产生可处理通知，无需点击继续或调整跳数");
  assert.equal(nextTurn.hops, 0);
  assert.equal((await f.repo.get("channel_turn", limited.id)).status, "limited", "不会重新执行此前被拦下的连续通知");
  await f.send("channel.continue", { channelId: f.c.id });
  assert.equal((await f.repo.get("channel_turn", limited.id)).status, "ready");
});
test("conversation dispatcher coalesces wakes and does not load legacy steps or mark a run stalled", async (t) => {
  const f = await setup(t);
  await f.repo.transact("transport-test", {}, async (tx) =>
    tx.put("connection", {
      ...(await tx.get("connection", "grok")),
      transport: "unsupported-test",
    }),
  );
  await f.send("channel.post", {
    channelId: f.c.id,
    body: "一",
    mentions: ["grok"],
  });
  await f.send("channel.post", {
    channelId: f.c.id,
    body: "二",
    mentions: ["grok"],
  });
  const rows = await f.repo.list("outbox", { scope: f.c.id });
  const result = await dispatchOne(
    f.repo,
    f.identity,
    rows[0].id,
    { ADMIN_KEY: "test" },
    () => {
      throw Error("poll should not fetch");
    },
  );
  assert.equal(result.status, "needs_review");
  assert.equal((await f.repo.get("outbox", rows[1].id)).status, "coalesced");
  await maintenance(
    f.repo,
    f.identity,
    { ADMIN_KEY: "test" },
    () => {},
    new Date(Date.now() + 70 * 60000).toISOString(),
  );
  assert.ok(
    (await f.repo.list("channel_turn")).some((t) => t.status === "stalled"),
  );
  assert.equal((await f.repo.list("run")).length, 0);
});
test("replyTo without turnId acknowledges the active delivery and releases the Agent", async (t) => {
  const f = await setup(t),
    msg = await f.send("channel.post", {
      channelId: f.c.id,
      body: "请回复",
      mentions: ["grok"],
    });
  const work = (await conversationWork(f.repo, f.identity, "grok"))[0];
  const claim = await claimConversation(f.repo, f.identity, agent("grok"), {
    requestId: "ack-claim",
    stepId: work.stepId,
  });
  await f.send(
    "channel.post",
    { channelId: f.c.id, body: "已回复", replyTo: msg.id },
    agent("grok"),
  );
  assert.equal((await f.repo.get("channel_turn", claim.turnId)).status, "done");
  assert.equal((await f.repo.get("resource", "grok")).status, "idle");
});
test("message history is paged without dropping the earlier context or creating legacy runs", async (t) => {
  const f = await setup(t);
  await f.send("channel.update", { channelId: f.c.id, memberIds: [] });
  for (let i = 1; i <= 55; i++)
    await f.send("channel.post", { channelId: f.c.id, body: "消息" + i });
  const last = await readChannel(f.repo, f.identity, user, {
    channelId: f.c.id,
  });
  assert.equal(last.messages.length, 50);
  assert.equal(last.messages[0].body, "消息6");
  const first = await readChannel(f.repo, f.identity, user, {
    channelId: f.c.id,
    before: last.before,
  });
  assert.equal(first.messages.length, 5);
  assert.equal(first.messages[0].body, "消息1");
  assert.equal(first.before, null);
});
test("text-only native replies address only unique group peers, without treating code or quotes as pings", async (t) => {
  const f = await setup(t);
  f.identity.members.find((m) => m.id === "grok").name = "Grok";
  f.identity.members.find((m) => m.id === "check").name = "Dot";
  f.identity.members.find((m) => m.id === "write").name = "Outside";
  const userMsg = await f.send("channel.post", {
    channelId: f.c.id,
    body: "讨论",
    mentions: ["grok"],
  });
  let w = (await conversationWork(f.repo, f.identity, "grok"))[0];
  await claimConversation(f.repo, f.identity, agent("grok"), {
    requestId: "text-claim",
    stepId: w.stepId,
  });
  const m = await f.send(
    "channel.post",
    {
      channelId: f.c.id,
      body: "@Dot 你来挑一个问题。\n`@Outside`\n> @Grok 只是引用",
      replyTo: userMsg.id,
    },
    agent("grok"),
  );
  assert.deepEqual(m.mentions, ["check"]);
  assert.equal(m.mentionsFromText, true);
  assert.equal((await conversationWork(f.repo, f.identity, "check")).length, 1);
  const noPing = await f.send(
    "channel.post",
    {
      channelId: f.c.id,
      body: "@Dot 这是引用，不通知",
      mentions: [],
      replyTo: m.id,
    },
    agent("grok"),
  );
  assert.deepEqual(noPing.mentions, []);
});
test("asking the user yields the native account and the answer immediately becomes claimable", async (t) => {
  const f = await setup(t);
  await f.send("channel.post", {
    channelId: f.c.id,
    body: "请先问我",
    mentions: ["check"],
  });
  const work = (await conversationWork(f.repo, f.identity, "check"))[0];
  const claim = await claimConversation(f.repo, f.identity, agent("check"), {
    requestId: "ask-claim",
    stepId: work.stepId,
  });
  const q = await f.send(
    "channel.ask",
    { channelId: f.c.id, question: "选哪个？", options: ["A", "B"] },
    agent("check"),
  );
  assert.equal((await f.repo.get("resource", "check")).status, "idle");
  assert.equal((await f.repo.get("channel_turn", claim.turnId)).status, "done");
  await f.send("channel.answer", {
    channelId: f.c.id,
    questionId: q.id,
    answer: "B",
  });
  const next = (await conversationWork(f.repo, f.identity, "check"))[0];
  assert.equal(next.status, "ready");
  await claimConversation(f.repo, f.identity, agent("check"), {
    requestId: "answer-claim",
    stepId: next.stepId,
  });
});
test("changing the coordinator during a live response preserves its lease and the former coordinator can continue speaking", async (t) => {
  const f = await setup(t);
  await f.send("channel.post", {
    channelId: f.c.id,
    body: "正在讨论",
    mentions: ["grok"],
  });
  const work = (await conversationWork(f.repo, f.identity, "grok"))[0];
  const c = await claimConversation(f.repo, f.identity, agent("grok"), {
    requestId: "coordinator-live",
    stepId: work.stepId,
  });
  await f.send("channel.update", { channelId: f.c.id, coordinatorId: "check" });
  assert.equal((await f.repo.get("channel_turn", c.turnId)).status, "active");
  assert.equal((await f.repo.get("resource", "grok")).status, "busy");
  await f.send(
    "channel.post",
    {
      channelId: f.c.id,
      turnId: c.turnId,
      body: "负责人换了，我仍可以继续交流。",
    },
    agent("grok"),
  );
  assert.equal((await f.repo.get("channel_turn", c.turnId)).status, "done");
});
test("editing a delivered document keeps the fixed delivery version and marks new changes as a draft", async (t) => {
  const f = await setup(t);
  const d = await f.send("channel.doc.create", {
    channelId: f.c.id,
    title: "共同稿",
    body: "原交付",
  });
  const delivery = await f.send(
    "channel.doc.deliver",
    { documentId: d.id, summary: "交付第一版" },
    agent("check"),
  );
  await f.send("channel.doc.edit", {
    documentId: d.id,
    expectedVersion: 1,
    body: "尚未交付的新修改",
    reason: "新增意见",
  });
  const latest = await f.repo.get("channel_doc", d.id);
  assert.equal(latest.status, "draft");
  assert.equal(latest.deliveredVersion, 1);
  assert.equal(latest.version, 2);
  assert.equal((await f.repo.get("channel_delivery", delivery.id)).version, 1);
});
test("explicit document delivery completes the active notification so the next question is not blocked", async (t) => {
  const f = await setup(t);
  await f.send("channel.post", {
    channelId: f.c.id,
    body: "请交付文档",
    mentions: ["check"],
  });
  const w = (await conversationWork(f.repo, f.identity, "check"))[0];
  const c = await claimConversation(f.repo, f.identity, agent("check"), {
    requestId: "deliver-active",
    stepId: w.stepId,
  });
  const d = await f.send(
    "channel.doc.create",
    { channelId: f.c.id, title: "真实成果", body: "完整正文" },
    agent("check"),
  );
  await f.send(
    "channel.doc.deliver",
    { documentId: d.id, summary: "已交付" },
    agent("check"),
  );
  assert.equal((await f.repo.get("channel_turn", c.turnId)).status, "done");
  assert.equal((await f.repo.get("resource", "check")).status, "idle");
});

test('coordinator receives related replies without another mention; quiet unrelated chat does not wake it',async t=>{
 const f=await setup(t);
 const userMessage=await f.send('channel.post',{channelId:f.c.id,body:'讨论框架，给我汇总'});
 const c=await claimConversation(f.repo,f.identity,agent('grok'),{requestId:'coord-claim',stepId:`turn_${userMessage.id}_grok`});
 const request=await f.send('channel.post',{channelId:f.c.id,body:'请核对来源边界',turnId:c.turnId,mentions:['check']},agent('grok'));
 const worker=await claimConversation(f.repo,f.identity,agent('check'),{requestId:'worker-claim',stepId:`turn_${request.id}_check`});
 const result=await f.send('channel.post',{channelId:f.c.id,body:'这里有一个未证实的假设，需要删掉',turnId:worker.turnId,mentions:[]},agent('check'));
 assert.ok((await f.repo.list('channel_turn')).some(x=>x.messageId===result.id&&x.memberId==='grok'&&x.status==='ready'));
 const record=(await f.repo.list('channel_coordination'))[0];assert.equal(record.sourceMessageId,userMessage.id);
 const noRelation=await f.send('channel.post',{channelId:f.c.id,body:'另一个独立问题',mentions:['check']});
 const unrelated=await f.send('channel.post',{channelId:f.c.id,replyTo:noRelation.id,body:'独立回答',mentions:[]},agent('check'));
 assert.equal((await f.repo.list('channel_turn')).some(x=>x.messageId===unrelated.id&&x.memberId==='grok'),false);
 const reply=await claimConversation(f.repo,f.identity,agent('grok'),{requestId:'coord-result',stepId:`turn_${result.id}_grok`});
 assert.match(reply.input.coordinatorInstruction,/讨论框架不等于/);
 await f.send('channel.post',{channelId:f.c.id,turnId:reply.turnId,body:'框架已修订，仍需确认受众',mentions:[]},agent('grok'));
 assert.notEqual((await f.repo.get('channel_coordination',record.id)).status,'completed','delivery receipt is not work completion');
 await assert.rejects(()=>f.send('channel.coordination',{channelId:f.c.id,sourceMessageId:userMessage.id,action:'close',expectedVersion:1,summary:'完成'},agent('grok')),e=>e.code==='version_conflict');
 const current=await f.repo.get('channel_coordination',record.id);
 await f.send('channel.coordination',{channelId:f.c.id,sourceMessageId:userMessage.id,action:'close',expectedVersion:current.version,summary:'交付已修订框架，未擅自开始整篇'},agent('grok'));
 assert.equal((await f.repo.get('channel_coordination',record.id)).status,'completed');
});

test('replacement coordinator receives pending feedback once without reassigning original worker',async t=>{
 const f=await setup(t);const original=await f.send('channel.post',{channelId:f.c.id,body:'组织讨论'});
 const request=await f.send('channel.post',{channelId:f.c.id,replyTo:original.id,body:'请检查',mentions:['check']},agent('grok'));
 const result=await f.send('channel.post',{channelId:f.c.id,replyTo:request.id,body:'发现问题',mentions:[]},agent('check'));
 await f.send('channel.update',{channelId:f.c.id,coordinatorId:'check'});
 const feedback=(await f.repo.list('channel_turn')).filter(x=>x.coordinationFeedback&&x.status==='ready');
 assert.deepEqual(feedback.map(x=>x.memberId),['check']);
 assert.equal((await f.repo.list('channel_coordination'))[0].coordinatorId,'check');
 assert.ok((await f.repo.list('channel_message')).find(m=>m.id===result.id),'preserve returned work');
});
