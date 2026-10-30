import test from "node:test";
import assert from "node:assert/strict";
import { fixture, items, completeNext } from "./collaboration-helper.mjs";
import { command, workForMember } from "../cloud/collaboration/engine.mjs";
import { nextDaily } from "../shared/recipes.mjs";

test("真实存储：配方三步接力、前序成果、原稿与工作稿、反馈及重载", async (t) => {
  const f = await fixture(t),
    run = await f.send("run.start", { projectId: f.project.id });
  await completeNext(f, run.id, 5);
  const step = (await workForMember(f.repo, f.identity, "check"))[0];
  const claim = await f.send(
    "step.claim",
    { stepId: step.stepId },
    { memberId: "check" },
  );
  assert.equal(claim.input.predecessorDocumentIds.length, 5);
  await f.send(
    "step.submit",
    { attemptId: claim.attemptId, lease: claim.lease, items: items(3) },
    { memberId: "check" },
  );
  const submitted = await completeNext(f, run.id, 3);
  assert.equal((await f.repo.get("run", run.id)).status, "completed");
  const doc = await f.repo.get("document", submitted.documentIds[0]);
  const edited = await f.send("document.edit", {
    documentId: doc.id,
    revision: doc.revision,
    body: "这是用户修改的完整工作稿",
  });
  assert.notEqual(edited.originalVersionId, edited.workingVersionId);
  assert.match(
    (await f.repo.get("document_version", edited.originalVersionId)).body,
    /完整的研究/,
  );
  await f.send("feedback.set", { documentId: doc.id, value: "adopted" });
  await f.send("feedback.set", { documentId: doc.id, value: "discarded" });
  assert.equal(
    (await f.repo.list("feedback", { scope: f.project.id })).length,
    1,
  );
  await assert.rejects(
    f.send("document.edit", {
      documentId: doc.id,
      revision: doc.revision,
      body: "旧窗口覆盖",
    }),
    { code: "revision_conflict" },
  );
});
test("并发领取只有一个成功；重复创建幂等，不同内容同 key 拒绝", async (t) => {
  const f = await fixture(t),
    input = {
      type: "run.start",
      projectId: f.project.id,
      requestId: "same-start",
    };
  const runs = await Promise.all([
    command(f.repo, f.identity, { owner: true }, input),
    command(f.repo, f.identity, { owner: true }, input),
  ]);
  assert.equal(runs[0].id, runs[1].id);
  const step = (await workForMember(f.repo, f.identity, "grok"))[0];
  const claims = await Promise.allSettled([
    f.send("step.claim", { stepId: step.stepId }, { memberId: "grok" }),
    f.send("step.claim", { stepId: step.stepId }, { memberId: "grok" }),
  ]);
  assert.equal(claims.filter((x) => x.status === "fulfilled").length, 1);
  await assert.rejects(
    command(
      f.repo,
      f.identity,
      { owner: true },
      { ...input, type: "run.control", runId: runs[0].id, control: "cancel" },
    ),
    { code: "idempotency_conflict" },
  );
});
test("重复交付不重复推进，少交付和确认关卡阻断接力", async (t) => {
  const f = await fixture(t);
  await f.send("project.update", {
    projectId: f.project.id,
    revision: f.project.revision,
    approvals: ["discover"],
  });
  const run = await f.send("run.start", { projectId: f.project.id }),
    step = (await workForMember(f.repo, f.identity, "grok"))[0];
  const c = await f.send(
    "step.claim",
    { stepId: step.stepId },
    { memberId: "grok" },
  );
  const request = {
    type: "step.submit",
    requestId: "exact-submit",
    attemptId: c.attemptId,
    lease: c.lease,
    items: items(5),
  };
  const a = await command(f.repo, f.identity, { memberId: "grok" }, request);
  const b = await command(f.repo, f.identity, { memberId: "grok" }, request);
  assert.deepEqual(a, b);
  assert.equal(a.status, "needs_approval");
  assert.equal((await workForMember(f.repo, f.identity, "check")).length, 0);
  await f.send("step.approve", { stepId: step.stepId });
  assert.equal((await workForMember(f.repo, f.identity, "check")).length, 1);
  await completeNext(f, run.id, 1);
  assert.equal((await f.repo.get("run", run.id)).status, "needs_review");
  assert.equal((await workForMember(f.repo, f.identity, "write")).length, 0);
});
test("任务超时保留占用，旧 lease 与跨成员提交不被接受", async (t) => {
  const f = await fixture(t);
  await f.send("run.start", { projectId: f.project.id });
  const step = (await workForMember(f.repo, f.identity, "grok"))[0],
    c = await f.send(
      "step.claim",
      { stepId: step.stepId },
      { memberId: "grok" },
    );
  await assert.rejects(
    f.send(
      "step.submit",
      { attemptId: c.attemptId, lease: c.lease, items: items(5) },
      { memberId: "write" },
    ),
    { code: "forbidden" },
  );
  await f.send(
    "attempt.expire",
    { attemptId: c.attemptId },
    { system: true },
    new Date(Date.parse(c.expiresAt) + 1000).toISOString(),
  );
  assert.equal((await f.repo.get("resource", "grok")).status, "busy");
  await assert.rejects(
    f.send("step.retry", { stepId: step.stepId, reason: "再做一次" }),
    { code: "remote_unknown" },
  );
  await f.send("step.retry", {
    stepId: step.stepId,
    reason: "已核对远端停止",
    confirmRemoteStopped: true,
  });
  await assert.rejects(
    f.send(
      "step.submit",
      { attemptId: c.attemptId, lease: c.lease, items: items(5) },
      { memberId: "grok" },
    ),
    { code: "stale_attempt" },
  );
});
test("运行中补充进入原运行，不取消领取；跨项目同账号不并发", async (t) => {
  const f = await fixture(t),
    run = await f.send("run.start", { projectId: f.project.id });
  const first = (await workForMember(f.repo, f.identity, "grok"))[0];
  await f.send("step.claim", { stepId: first.stepId }, { memberId: "grok" });
  const msg = await f.send("message.send", {
    projectId: f.project.id,
    memberId: "write",
    body: "结尾加一句具体建议",
  });
  assert.equal(msg.runId, run.id);
  assert.equal((await f.repo.list("step", { parent: run.id })).length, 4);
  const p2 = await f.send("project.create", {
    name: "另一项目",
    topic: "新产品",
    recipeId: "daily-x-content",
    slots: f.project.slots,
  });
  await f.send("run.start", { projectId: p2.id });
  const another = (await workForMember(f.repo, f.identity, "grok")).find(
    (x) => x.projectId === p2.id,
  );
  await assert.rejects(
    f.send("step.claim", { stepId: another.stepId }, { memberId: "grok" }),
    { code: "resource_busy" },
  );
});
test("规则批准才注入；撤回不改已经执行的快照；日程按上海与DST计算", async (t) => {
  const f = await fixture(t);
  const k = await f.send("knowledge.write", {
    projectId: f.project.id,
    title: "文风",
    body: "不用表情符号",
    approved: false,
  });
  const run = await f.send("run.start", { projectId: f.project.id });
  assert(!run.knowledge.some((x) => x.id === k.id));
  const approved = await f.send("knowledge.review", {
    knowledgeId: k.id,
    revision: k.revision,
    status: "approved",
  });
  assert(
    !(await f.repo.get("run", run.id)).knowledge.some((x) => x.id === k.id),
  );
  await f.send("knowledge.review", {
    knowledgeId: k.id,
    revision: approved.revision,
    status: "revoked",
  });
  assert.equal(
    nextDaily("2026-10-28T15:00:00Z", "Asia/Shanghai", 8, 0),
    "2026-10-29T00:00:00.000Z",
  );
  assert.equal(
    nextDaily("2026-11-01T05:31:00Z", "America/New_York", 1, 30),
    "2026-11-02T06:30:00.000Z",
  );
});
test("定时重复触发一次；项目未完成时明确跳过、不叠加运行", async (t) => {
  const f = await fixture(t),
    schedule = await f.send(
      "schedule.set",
      {
        projectId: f.project.id,
        enabled: true,
        hour: 8,
        minute: 0,
        timeZone: "Asia/Shanghai",
      },
      { owner: true },
      "2026-10-28T01:00:00Z",
    );
  const fire = () =>
    f.send(
      "schedule.fire",
      { projectId: f.project.id, expectedAt: schedule.nextAt },
      { system: true },
      schedule.nextAt,
    );
  const result = await Promise.all([fire(), fire()]);
  assert.equal(result.filter((x) => x.skipped).length, 1);
  const next = await f.repo.get("schedule", f.project.id);
  const skipped = await f.send(
    "schedule.fire",
    { projectId: f.project.id, expectedAt: next.nextAt },
    { system: true },
    next.nextAt,
  );
  assert.equal(skipped.skipped, true);
});
test("真实验证完成之前不允许业务运行；hello不是完成，nonce错误不变ready", async (t) => {
  const f = await fixture(t);
  await f.repo.transact("unverify", {}, async (tx) => {
    const c = await tx.get("connection", "grok");
    tx.put("connection", { ...c, status: "configured" });
    return {};
  });
  await assert.rejects(f.send("run.start", { projectId: f.project.id }), {
    code: "connection_unverified",
  });
  const probe = await f.send("connection.probe", { memberId: "grok" }),
    work = (await workForMember(f.repo, f.identity, "grok")).find(
      (x) => x.runId === probe.runId,
    );
  const c = await f.send(
    "step.claim",
    { stepId: work.stepId },
    { memberId: "grok" },
  );
  assert.equal((await f.repo.get("connection", "grok")).status, "configured");
  const nonce = (await f.repo.get("run", probe.runId)).probeNonce;
  await f.send(
    "step.submit",
    {
      attemptId: c.attemptId,
      lease: c.lease,
      items: [{ title: "连接验证", body: nonce }],
    },
    { memberId: "grok" },
  );
  assert.equal((await f.repo.get("connection", "grok")).status, "verified");
});
test("返工携带完整人工稿；期间再次编辑不被迟到结果覆盖", async (t) => {
  const f = await fixture(t),
    run = await f.send("run.start", { projectId: f.project.id });
  await completeNext(f, run.id, 5);
  await completeNext(f, run.id, 3);
  const out = await completeNext(f, run.id, 3);
  let d = await f.repo.get("document", out.documentIds[0]);
  d = await f.send("document.edit", {
    documentId: d.id,
    revision: d.revision,
    body: "用户手改的内容，改稿必须完整传递给原成员。",
  });
  const revision = await f.send("document.revise", {
    documentId: d.id,
    revision: d.revision,
    instruction: "写得更具体",
  });
  const work = (await workForMember(f.repo, f.identity, "write")).find(
      (x) => x.runId === revision.id,
    ),
    c = await f.send(
      "step.claim",
      { stepId: work.stepId },
      { memberId: "write" },
    );
  assert.match(c.input.workingDocument.body, /用户手改/);
  const latest = await f.send("document.edit", {
    documentId: d.id,
    revision: d.revision,
    body: "用户又改了一次，请保留此版本。",
  });
  const result = await f.send(
    "step.submit",
    { attemptId: c.attemptId, lease: c.lease, items: items(1) },
    { memberId: "write" },
  );
  assert.equal(result.status, "needs_review");
  assert.equal(
    (await f.repo.get("document", d.id)).workingVersionId,
    latest.workingVersionId,
  );
});

test("Three distinct emoji-only edits propose one rule; approval gates injection and feedback history persists", async (t) => {
  const f = await fixture(t);
  const run = await f.send("run.start", { projectId: f.project.id });
  assert.equal(run.deadlineAt, null);
  await completeNext(f, run.id, 5);
  await completeNext(f, run.id, 3);
  const step = (await f.repo.list("step", { parent: run.id })).find(
    (s) => s.status === "ready",
  );
  const claim = await f.send(
    "step.claim",
    { stepId: step.id },
    { memberId: "write" },
  );
  const result = await f.send(
    "step.submit",
    {
      attemptId: claim.attemptId,
      lease: claim.lease,
      items: items(3, "完整成稿包含核实后的研究结果和原始参考链接。😀"),
    },
    { memberId: "write" },
  );
  for (let i = 0; i < result.documentIds.length; i++) {
    const d = await f.repo.get("document", result.documentIds[i]),
      v = await f.repo.get("document_version", d.workingVersionId);
    await f.send("document.edit", {
      documentId: d.id,
      revision: d.revision,
      body: v.body.replace("😀", ""),
    });
    if (i < 2)
      assert.equal(
        await f.repo.get("knowledge", `emoji-rule:${f.project.id}`, false),
        null,
      );
  }
  const rule = await f.repo.get("knowledge", `emoji-rule:${f.project.id}`);
  assert.equal(rule.status, "pending");
  assert.equal(rule.versionIds.length, 6);
  await f.send("knowledge.review", {
    knowledgeId: rule.id,
    revision: rule.revision,
    status: "approved",
  });
  const next = await f.send("run.start", { projectId: f.project.id });
  assert(next.knowledge.some((k) => k.id === rule.id));
  for (const value of ["adopted", "discarded", "pending"])
    await f.send("feedback.set", { documentId: result.documentIds[0], value });
  assert.equal(
    (await f.repo.list("feedback", { scope: f.project.id })).length,
    1,
  );
  assert.equal(
    (await f.repo.list("feedback_event", { parent: result.documentIds[0] }))
      .length,
    3,
  );
});
