import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
const root = path.dirname(fileURLToPath(import.meta.url)),
  out = path.join(root, "evidence/v1");
await fs.mkdir(out, { recursive: true });
const html = await fs.readFile(path.join(root, "index.html"));
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html;charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  executablePath:
    process.env.UI_CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const key = "agent-hub-v1-ui-review-20261030",
  checks = [],
  errors = [],
  external = [],
  layout = [];
let context, p;
async function fresh() {
  await context?.close();
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  p = await context.newPage();
  p.setDefaultTimeout(6000);
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("request", (r) => {
    if (/^https?:/.test(r.url()) && !r.url().startsWith(url))
      external.push(r.url());
  });
  await p.goto(url);
  await p.locator(".project-hit").first().waitFor();
}
const state = () => p.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
const current = (s) => s.projects.find((x) => x.id === s.projectId);
const nav = (label) =>
  p
    .locator(".global-rail")
    .getByRole("button", { name: label, exact: true })
    .click();
const shot = (name) => p.screenshot({ path: path.join(out, name + ".png") });
async function review() {
  await p
    .getByRole("button", { name: "审阅智能戒指机会研究成果", exact: true })
    .click();
  await p.getByRole("textbox", { name: "成果正文" }).waitFor();
}
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log("PASS " + name);
}
try {
  await fresh();
  await check(
    "Five navigation entries and explicit demo boundary",
    async () => {
      for (const label of ["项目", "成果", "待我决定", "知识库", "成员"])
        assert.equal(
          await p
            .locator(".global-rail")
            .getByRole("button", { name: label, exact: true })
            .count(),
          1,
        );
      assert.match(
        await p.locator(".preview-bar").innerText(),
        /未连接真实 Agent/,
      );
      await shot("01-project");
    },
  );
  await check(
    "A1 pending counts exclude rule confirmation in every location",
    async () => {
      assert.equal(
        await p.locator(".v1-header-pending").innerText(),
        "1 项待决定",
      );
      assert.match(
        await p.locator(".delivery-card footer").innerText(),
        /1 项待决定/,
      );
      assert.match(
        await p.locator(".v1-record-line").innerText(),
        /待你决定 1/,
      );
      assert.match(await p.locator(".sidebar-foot").innerText(), /1 条待确认/);
      await nav("待我决定");
      assert.equal(await p.locator(".decision-card").count(), 1);
      assert.doesNotMatch(
        await p.locator(".decision-list").innerText(),
        /改进提案|批准试行/,
      );
      await nav("项目");
    },
  );
  await review();
  await check(
    "B1 self-check opens criteria, reviewer and paragraph evidence",
    async () => {
      await p.getByRole("button", { name: /^合格标准 3\/3 符合/ }).click();
      const t = await p.locator(".v1-check-list").innerText();
      assert.match(t, /检查者：Dot/);
      assert.match(t, /对应段落/);
      await shot("02-self-check");
      await p.getByRole("button", { name: /^合格标准 3\/3 符合/ }).click();
    },
  );
  await check(
    "B2 independent count always explicit and multiple citations parenthesized",
    async () => {
      const t = await p.locator(".v1-record-line").innerText();
      assert.match(t, /独立互证 0（多处引用 3）/);
      await p.locator(".v1-record-line").click();
      assert.match(
        await p.locator(".v1-check-list").innerText(),
        /未确认来源相互独立/,
      );
      await p.locator(".v1-record-line").click();
      await shot("03-final-result");
    },
  );
  await check(
    "Inline choice replaces in place, is undoable and retains context",
    async () => {
      const card = p.locator(".decision-inline");
      const reader = p.locator(".document-scroll");
      await card.scrollIntoViewIfNeeded();
      const initial = await card.boundingBox();
      await card
        .getByRole("button", { name: "采纳此方案", exact: true })
        .first()
        .click();
      assert.match(await card.innerText(), /已按你的选择/);
      assert.match(
        await p.locator(".v1-check-trigger").innerText(),
        /自查基于版本 1/,
      );
      assert.doesNotMatch(
        await p.locator(".v1-review-record").innerText(),
        /待重新自查/,
      );
      await p.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      const selected = await card.boundingBox();
      assert(
        Math.abs(selected.y - initial.y) <= 2,
        `reading position moved: ${initial.y} -> ${selected.y}`,
      );
      await card.getByRole("button", { name: "撤回", exact: true }).click();
      assert.equal(
        await card
          .getByRole("button", { name: "采纳此方案", exact: true })
          .count(),
        2,
      );
      await card
        .getByRole("button", { name: "采纳此方案", exact: true })
        .last()
        .click();
      await p.getByRole("button", { name: "返回群聊", exact: true }).click();
      assert.equal(
        await p.locator(".v1-header-pending").innerText(),
        "0 项待决定",
      );
      assert.equal(
        await p
          .locator(".delivery-card footer")
          .getByRole("button", { name: /项待决定/ })
          .count(),
        0,
      );
      assert.doesNotMatch(
        await p.locator(".v1-record-line").innerText(),
        /待你决定/,
      );
      assert.match(await p.locator(".sidebar-foot").innerText(), /1 条待确认/);
      await nav("待我决定");
      assert.match(
        await p.locator(".decision-list").innerText(),
        /暂时没有需要你决定的事/,
      );
      await nav("项目");
      await review();
    },
  );
  await check(
    "Human edits preserve historical self-check without assigning unattended work",
    async () => {
      await p
        .getByRole("textbox", { name: "成果正文" })
        .fill("人工修订：保留我的删除和判断。");
      await p.getByRole("button", { name: /自查基于版本/ }).waitFor();
      await p.reload();
      await p.getByRole("textbox", { name: "成果正文" }).waitFor();
      assert.match(
        await p.getByRole("textbox", { name: "成果正文" }).innerText(),
        /保留我的删除/,
      );
      assert.match(
        await p.locator(".v1-check-trigger").innerText(),
        /自查基于版本 1 · 之后有你的修改/,
      );
    },
  );
  await check(
    "A2 recheck is explicit, revision-bound and never overwrites later human edits",
    async () => {
      const before = current(await state()).docs[0];
      assert.equal(before.recheckRequest, undefined);
      const trigger = p.getByRole("button", {
        name: "让 Dot 按标准再查一次",
        exact: true,
      });
      await trigger.click();
      assert.equal(
        await p
          .getByRole("button", { name: "已提交复查演示", exact: true })
          .isDisabled(),
        true,
      );
      const pending = current(await state()).docs[0].recheckRequest;
      assert.equal(pending.baseRevision, before.revision);
      assert.equal(pending.html, before.html);
      assert.equal(pending.author, "dots");
      await p
        .getByRole("textbox", { name: "成果正文" })
        .fill("复查期间人工修订，不允许被旧结果覆盖。");
      await p
        .getByRole("button", { name: "演示复查返回", exact: true })
        .click();
      const after = current(await state()).docs[0];
      assert.match(after.html, /不允许被旧结果覆盖/);
      assert.equal(after.selfCheckRevision, before.revision);
      assert(after.revision > after.selfCheckRevision);
      assert.match(
        await p.locator(".v1-check-trigger").innerText(),
        /之后有你的修改/,
      );
      await p
        .getByRole("button", { name: "让 Dot 按标准再查一次", exact: true })
        .click();
      await p
        .getByRole("button", { name: "演示复查返回", exact: true })
        .click();
      assert.match(
        await p.locator(".v1-check-trigger").innerText(),
        /合格标准/,
      );
      assert.match(
        await p.getByRole("textbox", { name: "成果正文" }).innerText(),
        /不允许被旧结果覆盖/,
      );
      await p.reload();
      await p.getByRole("textbox", { name: "成果正文" }).waitFor();
      assert.match(
        await p.locator(".v1-check-trigger").innerText(),
        /合格标准/,
      );
      await shot("13-user-edit-recheck");
      await p
        .getByRole("textbox", { name: "成果正文" })
        .fill("人工修订：保留我的删除和判断。");
    },
  );
  await check(
    "Revision carries full draft and candidate cannot silently overwrite newer edits",
    async () => {
      await p.getByRole("button", { name: "让 Dot 改", exact: true }).click();
      await p
        .getByLabel("修改要求", { exact: true })
        .fill("缩短开头，保留已有判断");
      await p
        .getByRole("button", { name: "提交修改要求", exact: true })
        .click();
      const d = current(await state()).docs[0];
      assert.match(d.requests.at(-1).html, /人工修订/);
      assert(d.requests.at(-1).baseRevision >= 2);
      await p
        .getByRole("textbox", { name: "成果正文" })
        .fill("返工期间我又改了一次，不应被覆盖。");
      await p
        .getByRole("button", { name: "演示候选版本返回", exact: true })
        .click();
      assert.match(
        await p.getByRole("textbox", { name: "成果正文" }).innerText(),
        /返工期间/,
      );
      await p
        .getByRole("button", { name: "比较候选版本", exact: true })
        .click();
      assert.equal(
        await p
          .getByRole("button", { name: "应用此版本", exact: true })
          .isDisabled(),
        true,
      );
      await shot("04-revision-conflict");
      await p.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    },
  );
  await fresh();
  await check(
    "Comparison is independent answers, each with its own self-check",
    async () => {
      await p.locator(".project-hit").nth(1).click();
      await p
        .getByRole("button", {
          name: "审阅两份方案，并排看看成果",
          exact: true,
        })
        .click();
      assert.equal(await p.locator(".v1-compare-columns>article").count(), 2);
      assert.equal(
        await p.locator(".v1-comparison .v1-check-trigger").count(),
        2,
      );
    },
  );
  await check(
    "Adoption keeps verbatim text and provenance, prevents duplicate insertion",
    async () => {
      const section = p.locator(".v1-compare-section").first(),
        text = await section.locator("p").innerText();
      await section
        .getByRole("button", { name: "采用这段", exact: true })
        .click();
      const draft = await p
        .getByRole("textbox", { name: "我的工作稿" })
        .innerText();
      assert(draft.includes(text));
      assert.match(draft, /\[Grok · 产品切入点\]/);
      assert.equal(
        await section
          .getByRole("button", { name: /已加入工作稿/ })
          .isDisabled(),
        true,
      );
      await p.reload();
      await p.getByRole("textbox", { name: "我的工作稿" }).waitFor();
      assert.match(
        await p.getByRole("textbox", { name: "我的工作稿" }).innerText(),
        /先做已有 SDK/,
      );
      assert.equal(
        await p
          .getByRole("button", { name: "保存工作稿", exact: true })
          .count(),
        0,
      );
      await shot("05-independent-comparison");
    },
  );
  await check(
    "Comparison saving failure remains honest and draft stays in memory",
    async () => {
      await p.evaluate(() => {
        window.__previewSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function () {
          throw new DOMException("quota", "QuotaExceededError");
        };
      });
      await p
        .getByRole("textbox", { name: "我的工作稿" })
        .fill("存储失败时，这段内容仍应留在内存。");
      await p.getByRole("alert").waitFor();
      assert.match(
        await p.locator(".v1-working-draft header").innerText(),
        /未保存/,
      );
      assert.match(
        await p.getByRole("textbox", { name: "我的工作稿" }).innerText(),
        /仍应留在内存/,
      );
      await p.evaluate(() => {
        Storage.prototype.setItem = window.__previewSet;
      });
      await p.reload();
      await p.locator(".v1-comparison").waitFor();
    },
  );
  await nav("成果");
  await check(
    "Global artifacts support search, review and version-specific reuse",
    async () => {
      await shot("06-results");
      await p.getByLabel("搜索当前页面").fill("智能戒指");
      assert((await p.locator(".v1-result-row").count()) > 0);
      await p
        .locator(".v1-result-row")
        .first()
        .getByRole("button", { name: /用于新任务/ })
        .click();
      assert.match(await p.getByLabel("项目目标").inputValue(), /基于/);
      const source = await p.getByRole("dialog").innerText();
      assert.match(source, /版本/);
      await p.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    },
  );
  await nav("知识库");
  await check(
    "Rules are compact, can confirm scoped proposal, inspect receipt and revoke",
    async () => {
      const row = p.locator(".v1-rule-row.pending").first();
      await row.getByRole("combobox").selectOption("本项目");
      await row
        .getByRole("button", { name: "以后都这样", exact: true })
        .click();
      assert.equal(
        (await state()).projects
          .find((p) => p.id === "daily")
          .rules.find((r) => r.id === "rule-2").status,
        "active",
      );
      await p
        .locator(".v1-rule-row")
        .first()
        .getByRole("button", { name: "查看使用记录", exact: true })
        .click();
      assert.match(await p.getByRole("dialog").innerText(), /仅证明派发时携带/);
      await p.getByRole("button", { name: "关闭弹窗", exact: true }).click();
      await shot("07-knowledge");
      assert.equal(
        await p.getByRole("button", { name: /用于新任务/ }).count(),
        0,
      );
      await p
        .locator(".v1-rule-row")
        .first()
        .getByRole("button", { name: "撤回", exact: true })
        .click();
      assert.equal(
        (await state()).projects.find((p) => p.id === "daily").rules[0].status,
        "revoked",
      );
    },
  );
  await nav("成员");
  await check(
    "Grok four-step wizard requires delivery and reply; never takes credentials",
    async () => {
      await p
        .locator(".member-card")
        .first()
        .getByRole("button", { name: "查看接入步骤", exact: true })
        .click();
      const d = p.getByRole("dialog");
      assert.match(await d.innerText(), /不收集配对码或密钥/);
      assert.match(await d.locator(".wizard-steps").innerText(), /接收任务/);
      for (let i = 0; i < 3; i++)
        await d.getByRole("button", { name: "下一步", exact: true }).click();
      assert.equal(
        await d
          .getByRole("button", { name: "完成演示", exact: true })
          .isDisabled(),
        true,
      );
      await d
        .getByRole("button", { name: "演示通知已送达", exact: true })
        .click();
      await d
        .getByRole("button", { name: "演示 Agent 已回复", exact: true })
        .click();
      await shot("08-grok-connect");
      await d.getByRole("button", { name: "完成演示", exact: true }).click();
      assert.equal((await state()).members[0].previewConnection, "ready");
    },
  );
  await check(
    "Dot three-step wizard distinguishes subscription from reply",
    async () => {
      await p
        .locator(".member-card")
        .nth(1)
        .getByRole("button", { name: "查看接入步骤", exact: true })
        .click();
      const d = p.getByRole("dialog");
      assert.equal(await d.locator(".wizard-steps span").count(), 3);
      await d.getByRole("button", { name: "下一步", exact: true }).click();
      await d.getByRole("button", { name: "下一步", exact: true }).click();
      assert.equal(
        await d
          .getByRole("button", { name: "演示通知已送达", exact: true })
          .isDisabled(),
        true,
      );
      await d
        .getByRole("button", { name: "演示事件订阅成功", exact: true })
        .click();
      await d
        .getByRole("button", { name: "演示通知已送达", exact: true })
        .click();
      await d
        .getByRole("button", { name: "演示 Agent 已回复", exact: true })
        .click();
      await shot("09-dot-connect");
      await d.getByRole("button", { name: "完成演示", exact: true }).click();
    },
  );
  await fresh();
  await check(
    "Arrangement defaults to final delivery; compare hides mode and lead",
    async () => {
      await p.getByRole("button", { name: "新建项目", exact: true }).click();
      await p.getByLabel("项目目标").fill("调研支持二开的智能戒指");
      await p.getByRole("button", { name: "下一步", exact: true }).click();
      assert.equal(
        await p.getByLabel("一份最终结果", { exact: true }).isChecked(),
        true,
      );
      await shot("10-arrangement");
      await p.getByLabel("各自提交，并排对比", { exact: true }).check();
      assert.equal(await p.locator(".three-modes").count(), 0);
      assert.equal(await p.getByLabel("汇总成员", { exact: true }).count(), 0);
      assert.match(await p.locator(".v1-output-preview").innerText(), /各一份/);
      await p.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    },
  );
  await check(
    "Explicit requirements become editable removable criteria without being re-added",
    async () => {
      await p.getByRole("button", { name: "新建项目", exact: true }).click();
      await p
        .getByLabel("项目目标")
        .fill(
          "研究一个新方向。必须附实测数据；需要列出来源；要保留不确定项。不需要联网。不要编造结果。",
        );
      await p.getByRole("button", { name: "下一步", exact: true }).click();
      const list = p.locator(".v1-criterion-row input");
      assert(
        (await list.evaluateAll((els) => els.map((el) => el.value))).includes(
          "必须附实测数据",
        ),
      );
      assert(
        (await list.evaluateAll((els) => els.map((el) => el.value))).includes(
          "需要列出来源",
        ),
      );
      assert(
        (await list.evaluateAll((els) => els.map((el) => el.value))).includes(
          "要保留不确定项",
        ),
      );
      assert(
        (await list.evaluateAll((els) => els.map((el) => el.value))).includes(
          "不需要联网",
        ),
      );
      assert(
        (await list.evaluateAll((els) => els.map((el) => el.value))).includes(
          "不要编造结果",
        ),
      );
      await p.getByRole("button", { name: "删除标准 3", exact: true }).click();
      assert(
        !(await list.evaluateAll((els) => els.map((el) => el.value))).includes(
          "必须附实测数据",
        ),
      );
      await p.getByRole("button", { name: "上一步", exact: true }).click();
      await p.getByRole("button", { name: "下一步", exact: true }).click();
      assert(
        !(await list.evaluateAll((els) => els.map((el) => el.value))).includes(
          "必须附实测数据",
        ),
      );
      await p.getByRole("button", { name: "添加标准", exact: true }).click();
      await list.last().fill("附可运行的验证步骤");
      assert(
        (await list.evaluateAll((els) => els.map((el) => el.value))).includes(
          "附可运行的验证步骤",
        ),
      );
      await shot("14-editable-criteria");
      await p
        .getByRole("button", { name: "下一步：定节奏", exact: true })
        .click();
      await p.getByRole("button", { name: "开始", exact: true }).click();
      const stored = current(await state()).criteria;
      assert(Array.isArray(stored));
      assert(stored.includes("附可运行的验证步骤"));
      await fresh();
    },
  );
  await check(
    "Generic goals avoid hard-coded hardware criteria and can start solo",
    async () => {
      await p.getByRole("button", { name: "新建项目", exact: true }).click();
      await p.getByLabel("项目目标").fill("整理给我的三条备注");
      await p.getByRole("button", { name: "下一步", exact: true }).click();
      assert.doesNotMatch(
        (
          await p
            .locator(".v1-criterion-row input")
            .evaluateAll((els) => els.map((el) => el.value))
        ).join("\n"),
        /二开/,
      );
      await p.getByRole("button", { name: /^一位直接完成/ }).click();
      await p
        .getByRole("button", { name: "下一步：定节奏", exact: true })
        .click();
      await p.getByRole("button", { name: "开始", exact: true }).click();
      assert.equal(current(await state()).members.length, 1);
      assert.equal(
        current(await state()).lead,
        current(await state()).members[0],
      );
      await p
        .locator(".v1-scenario")
        .getByRole("button", { name: "演示下一步", exact: true })
        .click();
      await p
        .locator(".v1-scenario")
        .getByRole("button", { name: "演示下一步", exact: true })
        .click();
      assert.equal(current(await state()).status, "review");
    },
  );
  await fresh();
  await check(
    "Member failure exposes three actions and partial deliverable is preserved",
    async () => {
      await p.getByLabel("演示场景").selectOption("failure");
      await p
        .locator(".v1-scenario")
        .getByRole("button", { name: "开始演示", exact: true })
        .click();
      await p
        .locator(".v1-scenario")
        .getByRole("button", { name: "演示下一步", exact: true })
        .click();
      assert.equal(await p.locator(".v1-failure button").count(), 3);
      await shot("11-member-failure");
      await p
        .getByRole("button", {
          name: "用已有结果成稿（标明缺口）",
          exact: true,
        })
        .click();
      await p
        .locator(".v1-scenario")
        .getByRole("button", { name: "演示下一步", exact: true })
        .click();
      assert.equal(current(await state()).docs.at(-1).partial, true);
      assert.match(
        await p.locator(".delivery-card").last().innerText(),
        /部分交付/,
      );
    },
  );
  await fresh();
  await check(
    "Unmet criteria remain explicit rather than false completion",
    async () => {
      await p.locator(".project-hit").nth(2).click();
      await p
        .getByRole("button", { name: "审阅未达标与缺口示例成果", exact: true })
        .click();
      await p.getByRole("button", { name: /部分达标 · 1 项未达标/ }).click();
      assert.match(
        await p.locator(".v1-check-list").innerText(),
        /仍缺实际硬件测试结果/,
      );
      await shot("12-partial-criteria");
    },
  );
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
  ]) {
    await fresh();
    await p.setViewportSize(size);
    await check(
      "Compact project header, borderless handoff and readable text " +
        size.width,
      async () => {
        const metrics = await p.evaluate(() => {
          const header = document.querySelector(".workspace-header"),
            handoff = document.querySelector(".handoff");
          const rows = [
            ...document.querySelectorAll(
              ".v1-record-line,.delivery-card .button,.handoff summary strong,.rail-item",
            ),
          ];
          const tiny = [...document.querySelectorAll("body *")]
            .filter(
              (el) =>
                el.getClientRects().length &&
                [...el.childNodes].some(
                  (n) => n.nodeType === 3 && n.textContent.trim(),
                ) &&
                parseFloat(getComputedStyle(el).fontSize) < 12,
            )
            .map((el) => el.className);
          return {
            height: header.offsetHeight,
            border: getComputedStyle(handoff).borderTopWidth,
            handoffHeight: handoff.querySelector("summary").offsetHeight,
            primary: rows.map((el) =>
              parseFloat(getComputedStyle(el).fontSize),
            ),
            tiny,
            horizontal: document.documentElement.scrollWidth > innerWidth,
          };
        });
        assert.equal(metrics.height, 56);
        assert.equal(metrics.border, "0px");
        assert(metrics.handoffHeight <= 36);
        assert(metrics.primary.every((x) => x >= 14));
        assert.deepEqual(metrics.tiny, []);
        assert.equal(metrics.horizontal, false);
        assert.equal(await p.locator(".goal-line,.phase-summary").count(), 0);
        await shot("project-" + size.width);
        await p.getByRole("button", { name: "工作安排", exact: true }).click();
        await p.getByRole("button", { name: "下一步", exact: true }).click();
        const aligned = await p
          .locator(".mode-option")
          .first()
          .evaluate((el) => {
            const dot = el.querySelector(".radio-dot").getBoundingClientRect(),
              text = el.querySelector("strong").getBoundingClientRect();
            return dot.x < text.x && getComputedStyle(el).textAlign === "left";
          });
        assert(aligned);
        await p.getByRole("button", { name: "关闭弹窗", exact: true }).click();
      },
    );
    await review();
    await check("Readable review layout " + size.width, async () => {
      const m = await p.evaluate(() => ({
        width: innerWidth,
        pageWidth: document.documentElement.scrollWidth,
        reading: document.querySelector(".document-scroll").clientHeight,
        panel: document.querySelector(".document-workspace").clientHeight,
      }));
      assert.equal(m.width, m.pageWidth);
      assert(m.reading / m.panel >= 0.65);
      layout.push(m);
      const card = p.locator(".decision-inline");
      await card
        .getByRole("button", { name: "采纳此方案", exact: true })
        .first()
        .scrollIntoViewIfNeeded();
      const before = await card.boundingBox();
      await card
        .getByRole("button", { name: "采纳此方案", exact: true })
        .first()
        .click();
      await p.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      assert(
        Math.abs((await card.boundingBox()).y - before.y) <= 2,
        "Decision adoption moved the reading position",
      );
      await card.getByRole("button", { name: "撤回", exact: true }).click();
      await shot("review-" + size.width);
    });
  }
  await check("No JavaScript errors or external Agent requests", async () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  });
  await fs.writeFile(
    path.join(out, "checks.json"),
    JSON.stringify(
      {
        checks,
        errors,
        external,
        layout,
        htmlSha256: createHash("sha256").update(html).digest("hex"),
        boundary:
          "Isolated UI prototype only; no real account or Agent verified",
      },
      null,
      2,
    ) + "\n",
  );
  console.log("TOTAL " + checks.length + " checks passed");
} catch (e) {
  console.error(e);
  await p?.screenshot({ path: path.join(out, "failure.png") });
  process.exitCode = 1;
} finally {
  await context?.close();
  await browser.close();
  await new Promise((r) => server.close(r));
}
