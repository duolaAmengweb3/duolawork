import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./collaboration-helper.mjs";
import { conversationCommand, readChannel } from "../cloud/collaboration/conversation.mjs";
import { callTool, TOOLS } from "../cloud/collaboration/api.mjs";
import { dispatchOne, maintenance } from "../cloud/collaboration/dispatcher.mjs";
import { seal } from "../cloud/collaboration/security.mjs";

const actor = { memberId: "grok" }, secret = "isolated-inbox-secret";
async function setup(t) {
  const f = await fixture(t); let sequence = 0;
  const command = (type, args = {}, who = { owner: true }) => conversationCommand(
    f.repo, f.identity, who, { type, requestId: "inbox-command-" + ++sequence, ...args });
  const group = await command("channel.create", { name: "正常沟通", memberIds: ["grok", "check"] });
  const send = body => command("channel.post", { channelId: group.id, body, mentions: ["grok"] });
  const receive = (args, options) => callTool(f.repo, f.identity, actor, "receive_messages", args, {}, options);
  const reply = (claim, body = "已回复") => command("channel.post", { channelId: group.id,
    turnId: claim.turnId, body }, actor);
  await f.repo.transact("inbox-transport", {}, async tx => {
    const c = await tx.get("connection", "grok");
    tx.put("connection", { ...c, transport: "grok-webhook", configVersion: 1,
      credentials: await seal({ url: "https://grok.com/webhook/automation/inbox-test",
        token: "whsec_" + Buffer.alloc(32, 19).toString("base64") }, secret) });
  });
  return { ...f, command, group, send, receive, reply };
}

test('平台晚到的接收器仍取得未领取消息，合并新补充；已执行超时不会自动重做', async t => {
  const f=await setup(t); const message=await f.send('迟到通知中的原要求');
  const notice=(await f.repo.list('outbox',{scope:f.group.id,status:'pending'}))[0];
  const now=Date.now();
  await dispatchOne(f.repo,f.identity,notice.id,{ADMIN_KEY:secret},async(_url,options)=>{
    const payload=JSON.parse(options.body);
    assert.equal(payload.channel_id,f.group.id);
    assert.equal(payload.receive.arguments.channelId,f.group.id);
    assert.equal(payload.receive.arguments.afterTurnId,undefined);
    return new Response('{}',{status:202});
  },new Date(now).toISOString());
  await maintenance(f.repo,f.identity,{ADMIN_KEY:secret},async()=>new Response('{}',{status:202}),new Date(now+16*60000).toISOString());
  assert.equal((await f.repo.get('channel_turn',notice.stepId)).status,'stalled');
  const work=await callTool(f.repo,f.identity,actor,'list_work',{},{});
  assert.ok(work.work.some(w=>w.stepId===notice.stepId&&w.status==='ready'));
  const extra=await f.send('这是连续补充');
  const claim=await f.receive({requestId:'late-receiver',channelId:f.group.id});
  assert.equal(claim.status,'claimed');
  assert.deepEqual(new Set(claim.input.triggerMessageIds),new Set([message.id,extra.id]));
  assert.equal((await f.repo.get('outbox',notice.id)).status,'claimed');
  assert.equal((await f.receive({requestId:'late-receiver',channelId:f.group.id})).lease,claim.lease);
  await maintenance(f.repo,f.identity,{ADMIN_KEY:secret},async()=>new Response('{}',{status:202}),new Date(now+32*60000).toISOString());
  assert.equal((await f.repo.get('channel_turn',claim.turnId)).status,'stalled');
  assert.equal((await f.receive({requestId:'must-not-restart-execution'})).status,'empty');
  assert.ok(!(await callTool(f.repo,f.identity,actor,'list_work',{},{})).work.some(w=>w.stepId===claim.turnId));
  await assert.rejects(()=>callTool(f.repo,f.identity,actor,'claim_work',{requestId:'explicit-expired-claim',stepId:claim.turnId},{}),e=>e.code==='turn_unavailable');
});

test("一次接收直接返回群上下文，重复请求不重复领取；仍可自主交流和使用共享文档", async t => {
  const f = await setup(t), runs = (await f.repo.list("run")).length;
  await f.send("先聊一下想法"); await f.send("补充：预算100元");
  const claim = await f.receive({ requestId: "one-receive" });
  assert.equal(claim.status, "claimed");
  assert.equal(claim.input.messages.length, 2);
  assert.equal(claim.input.triggerMessageIds.length, 2);
  assert.match(claim.input.instruction, /无需重复 read_channel/);
  assert.equal((await f.receive({ requestId: "one-receive" })).lease, claim.lease);
  assert.equal((await f.receive({ requestId: "another-receive" })).status, "busy");
  const doc = await callTool(f.repo, f.identity, actor, "create_doc", {
    requestId: "inbox-doc", channelId: f.group.id, title: "讨论笔记", body: "预算100元" }, {});
  assert.ok(doc.id);
  await f.command("channel.post", { channelId: f.group.id, turnId: claim.turnId,
    body: "一起看看预算", mentions: ["check"] }, actor);
  const channel = await readChannel(f.repo, f.identity, { owner: true }, { channelId: f.group.id });
  assert.equal(channel.messages.at(-1).authorId, "grok");
  assert.equal((await f.repo.list("run")).length, runs);
  assert.equal((await f.repo.list("channel_task")).length, 0);
  assert.ok(TOOLS.some(x => x.name === "receive_messages"));
});

test("并发接收只领取一次，显式群范围与幂等请求不能被换用", async t => {
  const f = await setup(t); await f.send("讨论");
  const claims = await Promise.all(["a", "b"].map(requestId => f.receive({ requestId })));
  assert.equal(claims.filter(x => x.status === "claimed").length, 1);
  assert.equal(claims.filter(x => x.status === "busy").length, 1);
  const other = await f.command("channel.create", { name: "别人的群", memberIds: ["check"] });
  await assert.rejects(() => f.receive({ requestId: "outsider", channelId: other.id }), e => e.code === "forbidden");
  await assert.rejects(() => f.receive({ requestId: "a", channelId: f.group.id }), e => e.code === "idempotency_conflict");
});

test("缓存旧工具列表的客户端经原 claim_work 写工具使用同一接收链路，不重领真实步骤", async t => {
  const f = await setup(t); await f.send("普通发言");
  const first = await callTool(f.repo, f.identity, actor, "claim_work", { requestId: "compat-first", stepId: "inbox" }, {});
  assert.equal(first.status, "claimed"); await f.reply(first);
  await assert.rejects(() => callTool(f.repo, f.identity, actor, "claim_work", {
    requestId: "real-id-not-an-alias", stepId: first.turnId }, {}), e => e.code === "turn_unavailable");
  let now = Date.now();
  const next = await callTool(f.repo, f.identity, actor, "claim_work", {
    requestId: "compat-next", stepId: first.input.continuation.stepId }, {}, {
    clock: () => now, sleep: async ms => { now += ms; await f.send("连续追问"); },
  });
  assert.equal(next.status, "claimed"); assert.notEqual(next.turnId, first.turnId);
  assert.match(next.input.messages.at(-1).body, /连续追问/);
  await assert.rejects(() => callTool(f.repo, f.identity, { memberId: "check" }, "claim_work", {
    requestId: "compat-foreign", stepId: first.input.continuation.stepId }, {}), e => e.code === "forbidden");
});

test("回应后的短等待接住连续追问，不重新唤醒平台；空跑有截止时间", async t => {
  const f = await setup(t); await f.send("第一句");
  const first = await f.receive({ requestId: "first" }); await f.reply(first);
  let now = Date.now(), platformCalls = 0, slept = 0;
  const second = await f.receive({ requestId: "continue", afterTurnId: first.turnId, waitSeconds: 20 }, {
    clock: () => now,
    sleep: async ms => {
      now += ms; slept++;
      await f.send("马上追问第二句");
      const notice = (await f.repo.list("outbox", { scope: f.group.id, status: "pending" }))[0];
      const result = await dispatchOne(f.repo, f.identity, notice.id, { ADMIN_KEY: secret }, async () => {
        platformCalls++; return new Response("{}", { status: 202 });
      }, new Date(now).toISOString());
      assert.equal(result.skipped, true);
    },
  });
  assert.equal(slept, 1); assert.equal(platformCalls, 0);
  assert.equal(second.status, "claimed"); assert.notEqual(second.turnId, first.turnId);
  assert.match(second.input.messages.at(-1).body, /追问第二句/);
  assert.equal((await f.repo.get("channel_wait", f.group.id + ":grok")).status, "finished");
  assert.equal((await f.receive({ requestId: "continue", afterTurnId: first.turnId, waitSeconds: 20 })).lease, second.lease);
  await f.reply(second);
  const empty = await f.receive({ requestId: "timeout", afterTurnId: second.turnId, waitSeconds: 2 }, {
    clock: () => now, sleep: async ms => { now += ms; },
  });
  assert.equal(empty.status, "empty");
  const deadline = (await f.repo.get("channel_wait", f.group.id + ":grok")).expiresAt;
  await f.receive({ requestId: "no-extend", afterTurnId: second.turnId, waitSeconds: 20 }, { clock: () => now });
  assert.equal((await f.repo.get("channel_wait", f.group.id + ":grok")).expiresAt, deadline);
});

test("等待实例失联后，截止时间到达就恢复投递，不丢后续消息", async t => {
  const f = await setup(t), start = Date.now();
  await f.repo.transact("crashed-wait", {}, async tx => tx.put("channel_wait", {
    id: f.group.id + ":grok", scopeId: f.group.id, parentId: "grok", status: "waiting",
    configVersion: 1, expiresAt: new Date(start + 20000).toISOString(),
  }));
  await f.send("等待期间的消息");
  const notice = (await f.repo.list("outbox", { scope: f.group.id, status: "pending" }))[0];
  let calls = 0;
  const deliver = at => dispatchOne(f.repo, f.identity, notice.id, { ADMIN_KEY: secret }, async () => {
    calls++; return new Response("{}", { status: 202 });
  }, new Date(at).toISOString());
  assert.equal((await deliver(start + 1000)).skipped, true);
  assert.equal((await deliver(start + 21000)).status, "accepted");
  assert.equal(calls, 1);
  assert.equal((await f.receive({ requestId: "recovered" })).status, "claimed");
});

test("完整45秒空闲等待有查询上限，不按每秒重复加载群消息和文档", async t => {
  const f = await setup(t); await f.send("正常聊天");
  const first = await f.receive({ requestId: "budget-first" }); await f.reply(first);
  const prepare = f.repo.db.prepare.bind(f.repo.db); let queries = 0, now = Date.now();
  f.repo.db.prepare = (...args) => { queries++; return prepare(...args); };
  const empty = await f.receive({ requestId: "budget-wait", afterTurnId: first.turnId, waitSeconds: 45 }, {
    clock: () => now, sleep: async ms => { now += ms; },
  });
  assert.equal(empty.status, "empty");
  assert.ok(queries <= 40, `bounded receiver must leave D1 budget for authentication and response; saw ${queries}`);
});

test("等待撤销或连接失效立即释放，不拿走消息；不能借他人通知开启等待", async t => {
  const f = await setup(t); await f.send("第一句");
  const first = await f.receive({ requestId: "original" }); await f.reply(first);
  const abort = new AbortController();
  await assert.rejects(() => f.receive({ requestId: "cancel-wait", afterTurnId: first.turnId, waitSeconds: 20 }, {
    signal: abort.signal, sleep: async () => abort.abort(),
  }), e => e.code === "request_aborted");
  assert.equal((await f.repo.get("channel_wait", f.group.id + ":grok")).status, "finished");
  await assert.rejects(() => callTool(f.repo, f.identity, { memberId: "check" }, "receive_messages", {
    requestId: "foreign", afterTurnId: first.turnId, waitSeconds: 20 }, {}), e => e.code === "forbidden");
  await assert.rejects(() => f.receive({ requestId: "unbounded", afterTurnId: first.turnId, waitSeconds: 46 }), e => e.code === "invalid_wait");
  await assert.rejects(() => f.receive({ requestId: "no-prior", waitSeconds: 1 }), e => e.code === "invalid_wait");
  await f.send("再发一条");
  const next = await f.receive({ requestId: "next" }); await f.reply(next);
  await assert.rejects(() => f.receive({ requestId: "revoked-wait", afterTurnId: next.turnId, waitSeconds: 20 }, {
    sleep: async () => f.repo.transact("revoke-during-wait", {}, async tx => {
      const c = await tx.get("connection", "grok"); tx.put("connection", { ...c, status: "configured" });
    }),
  }), e => e.code === "unavailable");
  assert.equal((await f.repo.get("channel_wait", f.group.id + ":grok")).status, "finished");
});

test("HTTP 回执时间是真实完成时刻；领取先于 HTTP 返回时不回退领取状态", async t => {
  const f = await setup(t); await f.send("你好");
  const notice = (await f.repo.list("outbox", { scope: f.group.id, status: "pending" }))[0];
  const before = Date.now();
  const result = await dispatchOne(f.repo, f.identity, notice.id, { ADMIN_KEY: secret }, async () => {
    await f.receive({ requestId: "racing-receive" });
    return new Response("{}", { status: 202 });
  });
  assert.equal(result.status, "claimed");
  const row = await f.repo.get("outbox", notice.id);
  assert.ok(Date.parse(row.platformRespondedAt) >= before);
  assert.equal(row.status, "claimed"); assert.ok(row.dispatchElapsedMs >= 0);
});
