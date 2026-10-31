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
    ["check", "grok"],
  );
  const work = await conversationWork(f.repo, f.identity, "check");
  const claim = await claimConversation(f.repo, f.identity, agent("check"), {
    requestId: "claim",
    stepId: work[0].stepId,
  });
  const reply = await f.send(
    "channel.post",
    { channelId: f.c.id, body: "我在，可以直接沟通。", turnId: claim.turnId },
    agent("check"),
  );
  assert.equal(reply.authorId, "check");
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
test("wake budget defers instead of discarding and explicit resume retains original messages", async (t) => {
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
  const limited = (await f.repo.list("channel_turn", { status: "limited" }))[0];
  assert.ok(limited);
  assert.equal(
    (await f.repo.get("channel_message", limited.messageId)).id,
    p.id,
  );
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
