import test from "node:test";
import assert from "node:assert/strict";
import { fixture, items } from "./collaboration-helper.mjs";
import {
  seal,
  unseal,
  platformURL,
  signedHeaders,
  readBounded,
} from "../cloud/collaboration/security.mjs";
import { configureConnection } from "../cloud/collaboration/connections.mjs";
import {
  dispatchOne,
  maintenance,
} from "../cloud/collaboration/dispatcher.mjs";
import { eventMethod, deliverEvents } from "../cloud/collaboration/events.mjs";
import { uploadFile, downloadFile } from "../cloud/collaboration/files.mjs";
import { command, workForMember } from "../cloud/collaboration/engine.mjs";
import { createHmac } from "node:crypto";

const SECRET = "test-only-not-a-real-credential";
async function webhook(t) {
  const f = await fixture(t);
  await f.repo.transact("webhook-seed", {}, async (tx) => {
    const c = await tx.get("connection", "grok");
    tx.put("connection", {
      ...c,
      transport: "grok-webhook",
      credentials: await seal(
        { url: "https://grok.com/test-routine", token: "test-routine-key" },
        SECRET,
      ),
    });
    return {};
  });
  const run = await f.send("run.start", { projectId: f.project.id });
  const row = (await f.repo.list("outbox", { parent: run.id }))[0];
  return { ...f, run, row, env: { ADMIN_KEY: SECRET } };
}
test("Grok通知200只是受理；并发派发只发送一次，不替原Agent领取", async (t) => {
  const f = await webhook(t);
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response("{}");
  };
  await Promise.all([
    dispatchOne(f.repo, f.identity, f.row.id, f.env, fetcher),
    dispatchOne(f.repo, f.identity, f.row.id, f.env, fetcher),
  ]);
  assert.equal(calls, 1);
  assert.equal((await f.repo.get("step", f.row.stepId)).status, "ready");
  assert.equal((await f.repo.list("attempt")).length, 0);
});
test("发送状态不明不会重发；进程中断保留unknown；没领取不会永远显示成功", async (t) => {
  const f = await webhook(t);
  let calls = 0;
  const fetcher = async () => {
    calls++;
    throw new Error("socket closed");
  };
  await dispatchOne(f.repo, f.identity, f.row.id, f.env, fetcher);
  await maintenance(f.repo, f.identity, f.env, fetcher);
  await maintenance(f.repo, f.identity, f.env, fetcher);
  assert.equal(calls, 1);
  assert.equal((await f.repo.get("outbox", f.row.id)).status, "unknown");
  assert.equal((await f.repo.get("step", f.row.stepId)).status, "needs_review");
  await assert.rejects(
    f.send("step.retry", { stepId: f.row.stepId, reason: "重试" }),
    { code: "remote_unknown" },
  );
});
test("429按退避重试，失败不伪装交付，真实claim胜过迟到通知回执", async (t) => {
  const f = await webhook(t);
  const now = new Date().toISOString();
  await dispatchOne(
    f.repo,
    f.identity,
    f.row.id,
    f.env,
    async () =>
      new Response("{}", { status: 429, headers: { "Retry-After": "60" } }),
    now,
  );
  const row = await f.repo.get("outbox", f.row.id);
  assert.equal(row.status, "retry");
  await dispatchOne(
    f.repo,
    f.identity,
    row.id,
    f.env,
    async () => {
      await f.send("step.claim", { stepId: row.stepId }, { memberId: "grok" });
      return new Response("{}");
    },
    row.dueAt,
  );
  assert.equal((await f.repo.get("outbox", row.id)).status, "claimed");
});
test("连接凭证加密，切通道清掉验证证据，但不修改旧账号身份", async (t) => {
  const f = await fixture(t),
    before = structuredClone(f.identity);
  const c = await configureConnection(
    f.repo,
    f.identity,
    {
      requestId: "config1",
      memberId: "grok",
      platform: "grok-bot",
      url: "https://grok.com/test",
      token: "private-test-value",
      capabilities: ["research"],
    },
    SECRET,
  );
  assert.equal(c.status, "configured");
  assert(!JSON.stringify(c).includes("private-test-value"));
  const stored = await f.repo.get("connection", "grok");
  assert(!JSON.stringify(stored).includes("private-test-value"));
  assert.equal(
    (await unseal(stored.credentials, SECRET)).token,
    "private-test-value",
  );
  assert.deepEqual(f.identity, before);
  await assert.rejects(unseal(stored.credentials, "wrong-key"), {
    code: "credential_locked",
  });
});
test("回调拒绝内网、伪造后缀、账号密码、非HTTPS；签名与标准HMAC一致", async () => {
  for (const url of [
    "http://chatgpt.com/callback",
    "https://chatgpt.com.evil.test/x",
    "https://127.0.0.1/x",
    "https://user:pass@openai.com/x",
  ])
    assert.throws(() => platformURL(url, "dots"));
  const key = Buffer.alloc(32, 5),
    secret = "whsec_" + key.toString("base64"),
    body = JSON.stringify({ type: "verification", challenge: "abc" });
  const headers = await signedHeaders(secret, "evt1", body, "sub1", 1000000);
  assert.equal(
    headers["webhook-signature"],
    "v1," +
      createHmac("sha256", key)
        .update("evt1.1000." + body)
        .digest("base64"),
  );
  await assert.rejects(readBounded(new Response("12345"), 4), {
    code: "too_large",
  });
});
test("Dots订阅验证、续期幂等、签名轮换、过滤与撤销持久化", async (t) => {
  const f = await fixture(t),
    env = { ADMIN_KEY: SECRET },
    secret = "whsec_" + Buffer.alloc(32, 2).toString("base64");
  await f.repo.transact("dots", {}, async (tx) => {
    const c = await tx.get("connection", "grok");
    tx.put("connection", { ...c, transport: "dots-events" });
    return {};
  });
  let verification = 0,
    deliveries = 0;
  const fetcher = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.type === "verification") {
      verification++;
      return Response.json({ challenge: body.challenge });
    }
    deliveries++;
    assert(options.headers["webhook-signature"]);
    return Response.json({});
  };
  const params = {
    name: "work.ready",
    arguments: { member_id: "grok" },
    delivery: {
      mode: "webhook",
      url: "https://chatgpt.com/test-callback",
      secret,
    },
    ttlMs: 3600000,
  };
  const now = "2026-10-28T10:00:00Z";
  const a = await eventMethod(
    f.repo,
    "grok",
    "events/subscribe",
    params,
    SECRET,
    fetcher,
    now,
  );
  const b = await eventMethod(
    f.repo,
    "grok",
    "events/subscribe",
    params,
    SECRET,
    fetcher,
    now,
  );
  assert.equal(a.id, b.id);
  assert.equal(verification, 1);
  await assert.rejects(
    eventMethod(
      f.repo,
      "grok",
      "events/subscribe",
      { ...params, arguments: { member_id: "write" } },
      SECRET,
      fetcher,
      now,
    ),
    { code: "forbidden" },
  );
  const row = {
    id: "outbox-test",
    memberId: "grok",
    stepId: "step-test",
    parentId: "run-test",
    generation: 1,
    createdAt: now,
  };
  await deliverEvents(f.repo, row, SECRET, fetcher, now);
  await deliverEvents(f.repo, row, SECRET, fetcher, now);
  assert.equal(deliveries, 1);
  await eventMethod(
    f.repo,
    "grok",
    "events/unsubscribe",
    params,
    SECRET,
    fetcher,
    now,
  );
  assert.equal(
    (
      await deliverEvents(
        f.repo,
        { ...row, id: "outbox-next" },
        SECRET,
        fetcher,
        now,
      )
    ).status,
    "waiting_subscription",
  );
});
test("文件真实字节往返、校验哈希、拒绝其他成员借用lease和无权限下载", async (t) => {
  const f = await fixture(t),
    bucket = {
      values: new Map(),
      async put(key, value) {
        this.values.set(key, value);
      },
      async get(key) {
        const bytes = this.values.get(key);
        return bytes ? { body: new Response(bytes).body } : null;
      },
    };
  await f.send("run.start", { projectId: f.project.id });
  const work = (await workForMember(f.repo, f.identity, "grok"))[0];
  const claim = await f.send(
    "step.claim",
    { stepId: work.stepId },
    { memberId: "grok" },
  );
  const input = {
      requestId: "file-one",
      attemptId: claim.attemptId,
      lease: claim.lease,
      name: "报告.txt",
    },
    bytes = new TextEncoder().encode("真实字节内容");
  const file = await uploadFile(
    f.repo,
    bucket,
    { memberId: "grok" },
    input,
    bytes,
  );
  const response = await downloadFile(f.repo, bucket, { owner: true }, file.id);
  assert.equal(await response.text(), "真实字节内容");
  assert.equal(file.sha256.length, 64);
  await assert.rejects(
    uploadFile(
      f.repo,
      bucket,
      { memberId: "write" },
      { ...input, requestId: "file-two" },
      bytes,
    ),
    { code: "forbidden" },
  );
  await assert.rejects(
    downloadFile(f.repo, bucket, { memberId: "unrelated" }, file.id),
    { code: "forbidden" },
  );
});
