import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { startHarness } from "./v1-harness.mjs";
const h = await startHarness(),
  checks = [];
try {
  const grok = await h.member("grok-bot", "Grok 协议测试"),
    dot = await h.member("chatgpt-agent", "Dot 协议测试");
  const members = [grok, dot];
  const p = await h.command("project.create", {
    name: "端到端协作",
    goal: "研究一个产品方向",
    arrangement: {
      mode: "parallel",
      delivery: "final",
      members: members.map((m) => m.id),
      lead: dot.id,
      criteria: ["附原始出处"],
      internalRevisions: 1,
    },
  });
  const run = await h.command("run.start", { projectId: p.id });
  let steps = (await h.request("/v2/run?id=" + run.id)).steps;
  assert.equal(steps.filter((s) => s.status === "ready").length, 2);
  const claims = [];
  for (const m of members) {
    const work = (await m.call("list_work")).work.find(
        (w) => w.runId === run.id,
      ),
      claim = await m.call("claim_work", {
        requestId: crypto.randomUUID(),
        stepId: work.stepId,
      });
    assert.deepEqual(claim.input.predecessorDocumentIds, []);
    const r = await m.call("submit_work", {
      requestId: crypto.randomUUID(),
      attemptId: claim.attemptId,
      lease: claim.lease,
      items: [
        {
          title: "独立研究",
          body: "项目能否实现取决于原始数据的授权条件，需要核对官方开发文档。",
          sources: ["https://example.com/" + m.id],
          claims: [
            {
              id: "data",
              text: "不开放原始数据会影响可行性",
              sourceUrls: ["https://example.com/" + m.id],
              important: true,
            },
          ],
        },
      ],
    });
    const d = await h.request("/v2/document?id=" + r.documentIds[0]);
    claims.push(...d.claims);
    if (m === grok) {
      const denied = await h.request(
        "/v2/mcp",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "read_document", arguments: { documentId: d.id } },
        },
        dot.token,
      );
      assert(denied.result.isError);
    }
  }
  checks.push(
    "真实 HTTP/MCP：独立阶段同时就绪，文档读取隔离，汇总前不泄露同伴成果",
  );
  const work = (await dot.call("list_work")).work.find(
      (w) => w.runId === run.id,
    ),
    claim = await dot.call("claim_work", {
      requestId: crypto.randomUUID(),
      stepId: work.stepId,
    });
  assert.equal(claim.input.predecessorDocumentIds.length, 2);
  const delivered = await dot.call("submit_work", {
    requestId: crypto.randomUUID(),
    attemptId: claim.attemptId,
    lease: claim.lease,
    items: [
      {
        title: "最终研究成果",
        body: "# 产品结论\n\n先核对官方数据开放权限，缺少原始数据时不能宣称支持自研算法。\n\n保留未确认的授权条款，下一步向厂商确认。",
        sources: ["https://example.com/docs"],
        claims: [
          {
            id: "final",
            text: "先验证授权再决定开发路线",
            sourceUrls: ["https://example.com/docs"],
          },
        ],
        dispositions: claims.map((c) => ({
          claimId: c.id,
          action: "adopt",
          reason: "决定项目可行性，保留在结论",
        })),
        selfCheck: [
          {
            criterion: 0,
            pass: true,
            reason: "正文与来源对应",
            paragraph: "产品结论",
          },
        ],
      },
    ],
  });
  const snap = await h.request("/v2/project?id=" + p.id);
  assert.equal(snap.documents.filter((d) => d.deliverable).length, 1);
  assert.equal(
    (await h.request("/v2/run?id=" + run.id)).run.status,
    "completed",
  );
  checks.push("汇总实际读取上游论断并完整交代去向，自查后仅交一份最终成果");
  let doc = await h.request("/v2/document?id=" + delivered.documentIds[0]);
  await h.command("document.edit", {
    documentId: doc.id,
    revision: doc.revision,
    body: "用户修订的完整工作稿，必须保留，之后可交回原成员修改。",
    format: "text",
  });
  doc = await h.request("/v2/document?id=" + doc.id);
  const revise = await h.command("document.revise", {
    documentId: doc.id,
    revision: doc.revision,
    instruction: "再短一些",
  });
  const current = await h.command("document.edit", {
    documentId: doc.id,
    revision: doc.revision,
    body: "返工期间又进行了人工修改，不能让候选覆盖。",
    format: "text",
  });
  const rw = (await dot.call("list_work")).work.find(
      (w) => w.runId === revise.id,
    ),
    rc = await dot.call("claim_work", {
      requestId: crypto.randomUUID(),
      stepId: rw.stepId,
    });
  assert.match(rc.input.workingDocument.body, /用户修订/);
  await dot.call("submit_work", {
    requestId: crypto.randomUUID(),
    attemptId: rc.attemptId,
    lease: rc.lease,
    items: [
      {
        title: "候选稿",
        body: "这是保留授权条件的新候选稿，需要用户比较后决定是否采用。",
        claims: [
          {
            id: "v",
            text: "保留用户判断",
            sourceUrls: ["https://example.com/docs"],
          },
        ],
        selfCheck: [
          {
            criterion: 0,
            pass: true,
            reason: "来源已保留",
            paragraph: "候选稿",
          },
        ],
      },
    ],
  });
  doc = await h.request("/v2/document?id=" + doc.id);
  assert.match(doc.working.body, /不能让候选覆盖/);
  assert(doc.candidate);
  checks.push("返工携带完整人工稿和基准版本；候选返回保持当前工作稿不变");
  await h.request("/admin/action",{type:"member.update",memberId:grok.id,payload:{paused:true}});
  const pausedDiscovery=await h.request("/v2/mcp",{jsonrpc:"2.0",id:2,method:"initialize",params:{protocolVersion:"2026-07-28"}},grok.token);
  assert(pausedDiscovery.result.serverInfo,"pause must not invalidate credentials or force OAuth login");
  await assert.rejects(grok.call("list_work"),/member_unavailable/);
  await h.request("/admin/action",{type:"member.update",memberId:grok.id,payload:{paused:false}});
  assert(Array.isArray((await grok.call("list_work")).work));
  checks.push("暂停只停止接单，不使有效凭证返回401；恢复后原凭证可继续调用，不要求重登");
  const report = {
    at: new Date().toISOString(),
    environment: "isolated workerd + D1 + real HTTP/MCP test peers",
    checks,
    realCommercialAgentTested: false,
    productionDataTouched: false,
  };
  await fs.writeFile(
    "evidence/v1-http.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await h.stop();
}
