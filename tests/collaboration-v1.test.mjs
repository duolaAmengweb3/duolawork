import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./collaboration-helper.mjs";
import { canRead } from "../cloud/collaboration/flow.mjs";
import { callTool } from "../cloud/collaboration/api.mjs";
import { normalizeSource } from "../shared/modes.mjs";
const arrangement = (extra = {}) => ({
  mode: "parallel",
  delivery: "final",
  members: ["grok", "check"],
  lead: "check",
  criteria: ["每条结论附来源", "缺口写明"],
  internalRevisions: 1,
  ...extra,
});
test("probe retry invalidates its own old lease, keeps history and cannot release a business attempt", async t => {
  const f = await fixture(t);
  const a = await f.send("connection.probe", {memberId:"grok"});
  const step = (await f.repo.list("step", {parent:a.runId}))[0];
  const claim = await f.send("step.claim", {stepId:step.id}, {memberId:"grok"});
  const b = await f.send("connection.probe", {memberId:"grok"});
  assert.notEqual(a.runId,b.runId);
  assert.equal((await f.repo.get("run",a.runId)).status,"canceled");
  assert.equal((await f.repo.get("attempt",claim.attemptId)).status,"superseded");
  assert.equal((await f.repo.get("resource","grok")).status,"free");
  await assert.rejects(f.send("step.submit", {attemptId:claim.attemptId,lease:claim.lease,items:[]},{memberId:"grok"}));
  const current = (await f.repo.list("step", {parent:b.runId}))[0];
  assert.equal(current.status,"ready");
});
async function setup(t, a = arrangement()) {
  const f = await fixture(t);
  f.project = await f.send("project.create", {
    name: "新研究",
    goal: "研究真实方向",
    arrangement: a,
  });
  f.run = await f.send("run.start", { projectId: f.project.id });
  return f;
}
async function submit(
  f,
  s,
  { bad = false, conflicts = [], proposal, ...extra } = {},
) {
  const claim = await f.send(
    "step.claim",
    { stepId: s.id },
    { memberId: s.memberId },
  );
  const upstream = [];
  for (const p of await f.repo.list("step", { parent: f.run.id }))
    if (s.dependsOn?.includes(p.id))
      for (const id of p.documentIds)
        upstream.push(...((await f.repo.get("document", id)).claims || []));
  const result = await f.send(
    "step.submit",
    {
      attemptId: claim.attemptId,
      lease: claim.lease,
      items: [
        {
          title: "有来源的研究结论",
          body: "这是完整的研究成果，有明确依据与未确认条件，作为真实存储的测试输入，不代表商业模型回答。",
          sources: ["https://example.com/source-" + s.memberId],
          claims: [
            {
              id: "c1",
              text: "支持数据导出，授权条件仍需确认",
              sourceUrls: ["https://example.com/source-" + s.memberId],
            },
          ],
          dispositions: upstream.map((c) => ({
            claimId: c.id,
            action: "adopt",
            reason: "与目标相关，有原始依据",
          })),
          selfCheck: [0, 1].map((criterion) => ({
            criterion,
            pass: !bad,
            reason: bad ? "没有满足该标准" : "已对应正文与来源",
            paragraph: "研究结论",
          })),
          conflicts,
          proposal,
          ...extra,
        },
      ],
    },
    { memberId: s.memberId },
  );
  return result;
}
async function explorers(f) {
  for (const step of await f.repo.list("step", { parent: f.run.id }))
    if (step.phase === "explore") await submit(f, step);
  return (await f.repo.list("step", { parent: f.run.id })).find(
    (s) => s.phase === "integrate",
  );
}
test("partial delivery keeps missing member explicit, advances the final and never silently frees a running account", async t => {
  const f=await setup(t);const steps=await f.repo.list("step",{parent:f.run.id});
  const grok=steps.find(s=>s.memberId==="grok");await submit(f,grok);
  const other=steps.find(s=>s.phase==="explore" && s.memberId==="check");
  const claim=await f.send("step.claim",{stepId:other.id},{memberId:"check"});
  await assert.rejects(f.send("run.accept_partial",{runId:f.run.id}),{code:"remote_unknown"});
  assert.equal((await f.repo.get("resource","check")).attemptId,claim.attemptId);
  await f.send("run.accept_partial",{runId:f.run.id,confirmRemoteStopped:true});
  assert.equal((await f.repo.get("step",other.id)).status,"skipped");
  assert.equal((await f.repo.get("attempt",claim.attemptId)).status,"superseded");
  const final=(await f.repo.list("step",{parent:f.run.id})).find(s=>s.phase==="integrate");
  assert.equal(final.status,"ready");assert.equal(final.memberId,"grok");
  const c=await f.send("step.claim",{stepId:final.id},{memberId:"grok"});
  assert(c.input.partial);assert.equal(c.input.missingDeliveries[0].memberId,"check");
  await assert.rejects(f.send("step.submit",{attemptId:claim.attemptId,lease:claim.lease,items:[]},{memberId:"check"}));
});
test("one missing member does not stop the other independent member from delivering",async t=>{
  const f=await setup(t);const all=await f.repo.list("step",{parent:f.run.id});
  await f.repo.transact("controlled-unavailable",{},async tx=>{
    const s=await tx.get("step",all.find(s=>s.memberId==="grok").id),r=await tx.get("run",f.run.id);
    tx.put("step",{...s,status:"needs_review"});tx.put("run",{...r,status:"needs_review"});return {};
  });
  const healthy=all.find(s=>s.phase==="explore"&&s.memberId==="check");await submit(f,healthy);
  assert.equal((await f.repo.get("step",healthy.id)).status,"completed");
  assert.equal((await f.repo.get("run",f.run.id)).status,"needs_review");
  await f.send("run.accept_partial",{runId:f.run.id});
  const final=(await f.repo.list("step",{parent:f.run.id})).find(s=>s.phase==="integrate");
  assert.equal(final.memberId,"check");assert.equal(final.status,"ready");
});
test("v1: independent branches are ready together; guessing sibling document IDs cannot read content", async (t) => {
  const f = await setup(t),
    steps = await f.repo.list("step", { parent: f.run.id });
  assert.equal(steps.filter((s) => s.status === "ready").length, 2);
  const own = steps.find((s) => s.memberId === "grok");
  await submit(f, own);
  const doc = await f.repo.get(
    "document",
    (await f.repo.get("step", own.id)).documentIds[0],
  );
  assert.equal(
    await canRead(f.repo, "check", doc),
    false,
    "a future integrator cannot read the sibling during its independent phase",
  );
  const compare = await setup(t, arrangement({ delivery: "compare" }));
  const a = (await compare.repo.list("step", { parent: compare.run.id })).find(
    (s) => s.memberId === "grok",
  );
  await submit(compare, a);
  const d = await compare.repo.get(
    "document",
    (await compare.repo.get("step", a.id)).documentIds[0],
  );
  assert.equal(await canRead(compare.repo, "check", d), false);
  await assert.rejects(
    () =>
      callTool(
        compare.repo,
        compare.identity,
        { memberId: "check" },
        "read_document",
        { documentId: d.id },
        {},
      ),
    (e) => e.status === 404,
  );
});
test("v1: normal flow waits for both branches, preserves all claim dispositions and delivers one self-checked final", async (t) => {
  const f = await setup(t),
    integrate = await explorers(f);
  assert.equal(integrate.status, "ready");
  await submit(f, integrate);
  const run = await f.repo.get("run", f.run.id);
  assert.equal(run.status, "completed");
  const docs = (await f.repo.list("document", { parent: run.id })).filter(
    (d) => d.deliverable,
  );
  assert.equal(docs.length, 1);
  assert.equal(docs[0].selfCheck.length, 2);
  assert.equal(docs[0].dispositions.length, 2);
  assert.equal(docs[0].record.independent, 0);
});
test("research uncertainty is retained for integration without repeatedly researching the same gap",async t=>{
  const f=await setup(t);const first=(await f.repo.list("step",{parent:f.run.id})).find(s=>s.phase==="explore");
  const c=await f.send("step.claim",{stepId:first.id},{memberId:first.memberId});
  await f.send("step.submit",{attemptId:c.attemptId,lease:c.lease,shortfall:"授权细节未确认，留给最终稿说明",items:[{title:"独立研究",body:"官方材料确认支持事件，但没有给出长期会话的承诺，需要在最终判断中保留这个边界。",sources:["https://example.com/docs"],claims:[{id:"x",text:"没有永久会话承诺",sourceUrls:["https://example.com/docs"]}]}]},{memberId:first.memberId});
  assert.equal((await f.repo.list("step",{parent:f.run.id})).length,3);
  assert((await f.repo.get("step",first.id)).issues.length);
});
test("v1: missing disposition or unmet criterion triggers bounded internal revision then explicit partial delivery", async (t) => {
  const f = await setup(t),
    integrate = await explorers(f);
  await submit(f, integrate, { bad: true, dispositions: [] });
  let steps = await f.repo.list("step", { parent: f.run.id });
  const retry = steps.find((s) => s.internalRound === 1);
  assert(retry);
  assert.equal(retry.status, "ready");
  await submit(f, retry, { bad: true });
  assert.equal((await f.repo.get("run", f.run.id)).status, "partially_met");
  const final = (await f.repo.list("document", { parent: f.run.id })).filter(
    (d) => d.deliverable,
  );
  assert.equal(final.length, 1);
  assert(final[0].qualityIssues.length);
  assert(final[0].sourceEvidence.claims.some((c) => c.text.includes("导出")));
});
test("v1: comparison has no integration and both deliveries remain separate", async (t) => {
  const f = await setup(t, arrangement({ delivery: "compare" }));
  for (const s of await f.repo.list("step", { parent: f.run.id }))
    await submit(f, s);
  assert.equal((await f.repo.list("step", { parent: f.run.id })).length, 2);
  assert.equal(
    (await f.repo.list("document", { parent: f.run.id })).filter(
      (d) => d.deliverable,
    ).length,
    2,
  );
});
test("v1: source canonicalization strips tracking but does not merge different papers", () => {
  assert.equal(
    normalizeSource("https://arxiv.org/abs/1?utm_source=x#top"),
    "https://arxiv.org/abs/1",
  );
  assert.notEqual(
    normalizeSource("https://arxiv.org/abs/1"),
    normalizeSource("https://arxiv.org/abs/2"),
  );
});
test("v1: record-level concurrency permits simultaneous edits and range guard enforces proposed-rule cap", async (t) => {
  const f = await fixture(t);
  await Promise.all(
    Array.from({ length: 4 }, (_, worker) =>
      f.repo.transact("parallel-" + worker, { worker }, async (tx) => {
        await tx.get("project", f.project.id);
        return tx.put("message", {
          id: "parallel-" + worker,
          scopeId: f.project.id,
          body: "并行写入",
          createdAt: tx.now,
        });
      }),
    ),
  );
  assert.equal(
    (await f.repo.list("message", { scope: f.project.id })).filter((x) =>
      x.id.startsWith("parallel"),
    ).length,
    4,
  );
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, (_, n) =>
      f.send("knowledge.write", {
        projectId: f.project.id,
        title: "建议" + n,
        body: "明确的规则建议" + n,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(
    (await f.repo.list("knowledge", { scope: f.project.id, status: "pending" }))
      .length,
    3,
  );
});
test("v1: recent keyset pagination returns latest 100 and then the remaining older documents", async (t) => {
  const f = await fixture(t);
  for (let n = 0; n < 150; n++)
    await f.repo.transact(
      "doc-" + n,
      { n },
      (tx) =>
        tx.put("document", {
          id: "document-" + n,
          scopeId: f.project.id,
          createdAt: new Date(1700000000000 + n * 1000).toISOString(),
        }),
      new Date(1700000000000 + n * 1000).toISOString(),
    );
  const page = await f.repo.list("document", {
    scope: f.project.id,
    order: "recent",
    limit: 100,
  });
  assert.equal(page[0].id, "document-149");
  const last = page.at(-1);
  const next = await f.repo.list("document", {
    scope: f.project.id,
    order: "recent",
    cursor: { updatedAt: last.updatedAt, id: last.id },
    limit: 100,
  });
  assert.equal(next.length, 50);
  assert.equal(new Set([...page, ...next].map((x) => x.id)).size, 150);
});

test("v1: fact disagreement gets one neutral verification; tradeoff remains an inline owner decision", async (t) => {
  const f = await setup(t, arrangement({ internalRevisions: 0 })),
    final = await explorers(f);
  const docs = await f.repo.list("document", { parent: f.run.id });
  const claimIds = docs.flatMap((d) => d.claims.map((c) => c.id));
  await submit(f, final, {
    conflicts: [
      { id: "fact", type: "fact", description: "数据能否导出", claimIds },
      {
        id: "choice",
        type: "choice",
        description: "先研究还是先做样机",
        options: [
          { label: "先研究", text: "先核实数据开放条件" },
          { label: "先样机", text: "先购买样机验证" },
        ],
      },
    ],
  });
  let steps = await f.repo.list("step", { parent: f.run.id });
  const verify = steps.find((s) => s.phase === "verify");
  assert(verify);
  const resolve = steps.find((s) => s.phase === "resolve");
  assert(resolve.dependsOn.includes(verify.id));
  const c = await f.send(
    "step.claim",
    { stepId: verify.id },
    { memberId: verify.memberId },
  );
  assert.deepEqual(c.input.predecessorDocumentIds, []);
  assert.deepEqual(c.input.materials, []);
  assert.deepEqual(c.input.knowledge, []);
  assert.equal(c.input.topic, "定向事实核查");
  await f.send(
    "step.submit",
    {
      attemptId: c.attemptId,
      lease: c.lease,
      items: [
        {
          title: "中性补证",
          body: "原厂文档未明确原始数据导出范围，目前仍然不能确认，需要保留缺口。",
        },
      ],
    },
    { memberId: verify.memberId },
  );
  await submit(f, resolve, {
    conflicts: [
      {
        id: "fact-again",
        type: "fact",
        description: "重新描述的数据导出问题",
        claimIds,
      },
    ],
  });
  steps = await f.repo.list("step", { parent: f.run.id });
  assert.equal(
    steps.filter((s) => s.phase === "verify").length,
    1,
    "resolve must not generate another verification loop",
  );
  const decision = (await f.repo.list("decision", { parent: f.run.id }))[0];
  let doc = await f.repo.get("document", decision.documentId);
  await f.send("decision.choose", {
    decisionId: decision.id,
    revision: doc.revision,
    option: 0,
  });
  doc = await f.repo.get("document", doc.id);
  let v = await f.repo.get("document_version", doc.workingVersionId);
  assert.match(v.body, /先核实数据开放条件/);
  await f.send("decision.choose", {
    decisionId: decision.id,
    revision: doc.revision,
    undo: true,
  });
  doc = await f.repo.get("document", doc.id);
  v = await f.repo.get("document_version", doc.workingVersionId);
  assert.equal(
    v.body.match(/<hub-decision /g).length,
    1,
    "undo replaces the original inline block",
  );
  assert.equal((await f.repo.get("decision", decision.id)).status, "pending");
});
test("v1: follow-up queues, approved rules freeze at exact revision, special runs stay out of deliveries", async (t) => {
  const f = await setup(
    t,
    arrangement({
      mode: "solo",
      members: ["grok"],
      lead: "grok",
      internalRevisions: 0,
    }),
  );
  const pending = await f.send("message.send", {
    projectId: f.project.id,
    body: "继续查开发许可",
  });
  assert(pending.queued);
  await submit(f, (await f.repo.list("step", { parent: f.run.id }))[0]);
  const next = (await f.repo.list("run", { scope: f.project.id })).find(
    (r) => r.id !== f.run.id,
  );
  assert(next);
  assert.equal(next.topic, "继续查开发许可");
  f.run = next;
  await submit(f, (await f.repo.list("step", { parent: next.id }))[0]);
  const doc = (await f.repo.list("document", { parent: next.id }))[0];
  await f.send("document.edit", {
    documentId: doc.id,
    revision: doc.revision,
    body: "用户把结论改成先确认原始数据授权，不保留夸张宣传语。",
    format: "text",
  });
  const learn = await f.send("document.learn", { documentId: doc.id });
  f.run = learn;
  await submit(f, (await f.repo.list("step", { parent: learn.id }))[0], {
    proposal: {
      title: "不夸大数据开放能力",
      body: "没有原始数据证据时写明未确认，不宣称开放。",
      evidence: "用户删去了支持原始数据的说法",
    },
  });
  assert.equal(
    (await f.repo.list("document", { parent: learn.id })).some(
      (d) => d.deliverable,
    ),
    false,
  );
  let rule = (
    await f.repo.list("knowledge", { scope: f.project.id, status: "pending" })
  )[0];
  assert(rule);
  await f.send("knowledge.review", {
    knowledgeId: rule.id,
    revision: rule.revision,
    status: "approved",
  });
  rule = await f.repo.get("knowledge", rule.id);
  const fresh = await f.send("run.start", { projectId: f.project.id });
  assert.equal(fresh.knowledge[0].revision, rule.revision);
  await f.send("knowledge.review", {
    knowledgeId: rule.id,
    revision: rule.revision,
    status: "revoked",
  });
  assert.equal(
    (await f.repo.get("run", fresh.id)).knowledge[0].revision,
    rule.revision,
    "in-flight rules cannot change retroactively",
  );
});
test("v1: comparison paragraph adoption persists provenance and rejects duplicate clicks", async (t) => {
  const f = await setup(
    t,
    arrangement({ delivery: "compare", internalRevisions: 0 }),
  );
  for (const s of await f.repo.list("step", { parent: f.run.id }))
    await submit(f, s);
  const source = (await f.repo.list("document", { parent: f.run.id }))[0];
  const d = await f.send("comparison.adopt", {
    projectId: f.project.id,
    sourceDocumentId: source.id,
    sectionIndex: 0,
  });
  const again = await f.send("comparison.adopt", {
    projectId: f.project.id,
    sourceDocumentId: source.id,
    sectionIndex: 0,
  });
  assert.equal(d.id, again.id);
  assert.equal(again.adoptions.length, 1);
  assert.equal(
    (await f.repo.get("project", f.project.id)).comparisonDraftId,
    d.id,
  );
  const body = (await f.repo.get("document_version", d.workingVersionId)).body;
  assert.match(body, /完整的研究成果/);
  assert.match(body, /原文段落 1/);
});

test("v1: one-round trial rule is frozen into one goal and not silently reused", async (t) => {
  const f = await setup(
    t,
    arrangement({
      mode: "solo",
      members: ["grok"],
      lead: "grok",
      internalRevisions: 0,
    }),
  );
  await submit(f, (await f.repo.list("step", { parent: f.run.id }))[0]);
  let rule = await f.send("knowledge.write", {
    projectId: f.project.id,
    title: "短结论试验",
    body: "每段不超过三句",
  });
  await f.send("knowledge.review", {
    knowledgeId: rule.id,
    revision: rule.revision,
    status: "trial",
  });
  f.run = await f.send("run.start", { projectId: f.project.id });
  assert(f.run.knowledge.some((k) => k.id === rule.id));
  assert.equal((await f.repo.get("knowledge", rule.id)).status, "trial_used");
  await submit(f, (await f.repo.list("step", { parent: f.run.id }))[0]);
  const next = await f.send("run.start", { projectId: f.project.id });
  assert(!next.knowledge.some((k) => k.id === rule.id));
});
test("v1: four parallel writers do not invalidate continuous owner edits or lose records", async (t) => {
  const f = await setup(
    t,
    arrangement({
      mode: "solo",
      members: ["grok"],
      lead: "grok",
      internalRevisions: 0,
    }),
  );
  await submit(f, (await f.repo.list("step", { parent: f.run.id }))[0]);
  let doc = (await f.repo.list("document", { parent: f.run.id }))[0];
  await Promise.all([
    ...Array.from({ length: 4 }, (_, worker) =>
      (async () => {
        for (let n = 0; n < 10; n++)
          await f.repo.transact(
            "writer-" + worker + "-" + n,
            { worker, n },
            (tx) =>
              tx.put("message", {
                id: "writer-" + worker + "-" + n,
                scopeId: f.project.id,
                body: "并行研究写入",
                createdAt: tx.now,
              }),
          );
      })(),
    ),
    (async () => {
      for (let n = 0; n < 10; n++) {
        doc = await f.send("document.edit", {
          documentId: doc.id,
          revision: doc.revision,
          body: "人工编辑连续版本 " + n,
          format: "text",
        });
      }
    })(),
  ]);
  assert.equal(
    (await f.repo.list("message", { scope: f.project.id })).filter((m) =>
      m.id.startsWith("writer-"),
    ).length,
    40,
  );
  assert.equal(
    (await f.repo.get("document_version", doc.workingVersionId)).body,
    "人工编辑连续版本 9",
  );
});
