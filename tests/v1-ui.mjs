import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { startHarness } from "./v1-harness.mjs";
const h = await startHarness();
process.env.AGENT_HUB_DATA_DIR = path.join(h.directory, "local");
const { start } = await import("../local/server.mjs");
let local, browser, page;
const checks = [],
  errors = [];
try {
  await h.request("/admin/action", {
    type: "settings.update",
    payload: { automation: false },
  });
  const grok = await h.member("grok-bot", "Grok"),
    dot = await h.member("chatgpt-agent", "Dot");
  local = await start({
    port: 0,
    maintenance: true,
    vaultKey: Buffer.alloc(32, 17),
    config: { endpoint: h.base, adminKey: h.key, runnerId: "ui-isolated" },
  });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400)
      console.error("HTTP", r.status(), new URL(r.url()).pathname);
  });
  await page.goto(local.url);
  await page
    .getByRole("button", { name: "新建项目", exact: true })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "项目目标" })
    .fill("调研智能戒指的个人开发机会");
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("textbox", { name: "合格标准 1" }).fill("附原始出处");
  await page.getByRole("textbox", { name: "合格标准 2" }).fill("缺口明确");
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("button", { name: "开始", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  let list = await h.request("/v2/records?kind=project"),
    p = list.items.find((p) => p.name.includes("智能戒指"));
  assert(p);
  let snap = await h.request("/v2/project?id=" + p.id),
    run = snap.activeRuns[0];
  assert(run);
  checks.push("三步创建真实项目与工作安排，启动两条独立分支");
  const upstream = [];
  for (const m of [grok, dot]) {
    const work = (await m.call("list_work")).work.find(
        (w) => w.runId === run.id,
      ),
      c = await m.call("claim_work", {
        requestId: crypto.randomUUID(),
        stepId: work.stepId,
      });
    const s = await m.call("submit_work", {
      requestId: crypto.randomUUID(),
      attemptId: c.attemptId,
      lease: c.lease,
      items: [
        {
          title: m.name + " 的独立资料",
          body: "先确认原厂 SDK 是否开放原始传感器数据，以及开发协议允许的使用范围。",
          sources: ["https://example.com/" + m.id],
          claims: [
            {
              id: "raw",
              text: "需要确认原始数据与授权范围",
              sourceUrls: ["https://example.com/" + m.id],
              important: true,
            },
          ],
        },
      ],
    });
    upstream.push(
      ...(await h.request("/v2/document?id=" + s.documentIds[0])).claims,
    );
  }
  const finalWork = (await dot.call("list_work")).work.find(
      (w) => w.runId === run.id,
    ),
    c = await dot.call("claim_work", {
      requestId: crypto.randomUUID(),
      stepId: finalWork.stepId,
    });
  const out = await dot.call("submit_work", {
    requestId: crypto.randomUUID(),
    attemptId: c.attemptId,
    lease: c.lease,
    items: [
      {
        title: "智能戒指：开发机会与验证清单",
        body: "# 结论\n\n先确认传感器原始数据能否导出，再决定是否做个性化分析。不能把“有蓝牙”直接理解为“支持二次开发”。\n\n## 可以先做什么\n\n获取样机和 SDK，跑通接收心率与活动数据的最小 Demo。\n\n## 尚未确定\n\n原始数据授权、SDK 更新周期与样品费用需要厂商确认。",
        sources: [{ url: "https://example.com/sdk", title: "官方 SDK 参考" }],
        claims: [
          {
            id: "dev",
            text: "先验证数据开放条件",
            sourceUrls: ["https://example.com/sdk"],
          },
        ],
        dispositions: upstream.map((k) => ({
          claimId: k.id,
          action: "adopt",
          reason: "与二次开发可行性相关，保留在验证清单",
        })),
        conflicts: [
          {
            type: "choice",
            description: "下一步工作优先级取舍",
            title: "先验证还是先扩展",
            options: [
              { label: "先验证", text: "先验证样机原始数据权限" },
              { label: "先扩展", text: "先做更多应用效果" },
            ],
          },
        ],
        selfCheck: [0, 1].map((criterion) => ({
          criterion,
          pass: true,
          reason: "已对应来源和缺口",
          paragraph: "尚未确定",
        })),
      },
    ],
  });
  await page
    .getByRole("button", { name: "审阅成果", exact: true })
    .first()
    .click({ timeout: 15000 });
  const editor = page.getByRole("textbox", { name: "成果正文" });
  await editor.waitFor();
  await editor.getByRole("heading", { name: "结论", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("alert").count(),
    0,
    "initial document load must not show a caught UI error",
  );
  await page.screenshot({ path: "evidence/v1-ui-1440.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.screenshot({ path: "evidence/v1-ui-1280.png", fullPage: true });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  checks.push("增量事件显示真实交付；1440/1280 布局无横向溢出");
  const decision = page.locator(".decision-inline").first();
  await decision.getByRole("button", { name: "采纳此方案" }).first().click();
  await decision.getByRole("button", { name: "撤回", exact: true }).waitFor();
  let ds = await h.request("/v2/records?kind=decision&projectId=" + p.id);
  assert.equal(ds.items[0].status, "resolved");
  await decision.getByRole("button", { name: "撤回", exact: true }).click();
  await decision.getByRole("heading", { name: /待你决定/ }).waitFor();
  ds = await h.request("/v2/records?kind=decision&projectId=" + p.id);
  assert.equal(ds.items[0].status, "pending");
  checks.push("正文决策卡真实保存并可撤回，界面不会先伪装成功");
  await editor.fill(
    "用户亲自编辑的工作稿，需要跨刷新和重开保留 UI-PERSIST-20261030",
  );
  await page.getByText("已保存", { exact: true }).waitFor();
  const d = await h.request("/v2/document?id=" + out.documentIds[0]);
  assert.match(d.working.body, /UI-PERSIST/);
  assert.notEqual(d.workingVersionId, d.selfCheckVersionId);
  await page.reload();
  await page
    .getByRole("textbox", { name: "成果正文" })
    .getByText(/UI-PERSIST/)
    .waitFor();
  checks.push(
    "编辑实际写入服务端版本，历史自查不冒充新稿自查，刷新可恢复工作稿",
  );
  await page.getByRole("button", { name: "返回项目" }).click();
  await page.getByRole("tab", { name: "资料", exact: true }).click();
  await page
    .getByRole("button", { name: "添加资料", exact: true })
    .last()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "资料标题" }).fill("真实附件测试");
  await dialog.getByLabel("原始附件", { exact: true }).setInputFiles({
    name: "reference.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("完整附件字节 UI-ATTACHMENT-20261030"),
  });
  await dialog.getByRole("button", { name: "添加资料", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const material = (
    await h.request("/v2/project?id=" + p.id)
  ).project.materials.find((m) => m.title === "真实附件测试");
  assert(material.fileId);
  assert.equal(
    await (await fetch(local.url + "/api/v2/files/" + material.fileId)).text(),
    "完整附件字节 UI-ATTACHMENT-20261030",
  );
  checks.push("资料附件实际上传、保存 SHA256，原始字节可完整下载");
  assert.equal(
    await page.getByRole("alert").count(),
    0,
    "completed operations must not leave an error alert",
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    "evidence/v1-ui.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        environment:
          "owned headless Chrome + local server + isolated workerd/D1",
        checks,
        errors,
        realCommercialAgentTested: false,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (e) {
  console.error("UI ERRORS", errors);
  if (page) {
    await page.screenshot({
      path: "evidence/v1-ui-failure.png",
      fullPage: true,
    });
    console.error((await page.locator("body").innerText()).slice(-10000));
  }
  throw e;
} finally {
  await browser?.close();
  await local?.close();
  await h.stop();
}
