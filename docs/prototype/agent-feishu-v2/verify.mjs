import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { chromium } from "playwright-core";

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, "evidence");
await fs.mkdir(out, { recursive: true });
const index = await fs.readFile(path.join(root, "index.html"));
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(index);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.UI_CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const key = "agent-hub-2-ui-preview-v1";
const errors = [],
  external = [],
  checks = [],
  metrics = [];
async function makePage() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (!r.url().startsWith(url) && /^https?:/.test(r.url()))
      external.push(r.url());
  });
  await page.goto(url);
  await page.locator(".project-hit").first().waitFor();
  return page;
}
const state = (page) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
async function until(fn, label) {
  for (let n = 0; n < 60; n++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw Error(label);
}
async function check(label, fn) {
  await fn();
  checks.push(label);
  console.log(`PASS ${label}`);
}
const current = (s) => s.projects.find((p) => p.id === s.projectId);
const firstDoc = (s) => current(s).docs[0];
const nav = (p, label) =>
  p.locator(".global-rail").getByRole("button", { name: label, exact: true });
async function review(p) {
  await p
    .getByRole("button", { name: "审阅AI 新用例观察成果", exact: true })
    .click();
  await p.getByRole("textbox", { name: "成果正文" }).waitFor();
}
async function shot(p, name) {
  await p.screenshot({ path: path.join(out, `${name}.png`) });
}
let failure;
try {
  const p = await makePage();
  await check(
    "Initial workspace is explicitly a preview, no agent requests",
    async () => {
      assert.match(await p.locator(".preview-bar").innerText(), /示例/);
      await shot(p, "01-project");
    },
  );
  await review(p);
  await check("Review preserves readable height at desktop size", async () => {
    await p.getByRole("button", { name: "交回修改", exact: true }).click();
    const m = await p.evaluate(() => ({
      width: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      reading: document.querySelector(".document-scroll").clientHeight,
      workspace: document.querySelector(".document-workspace").clientHeight,
      paper: document.querySelector(".document-paper").clientWidth,
    }));
    metrics.push(m);
    assert.equal(m.width, m.documentWidth);
    assert(m.reading / m.workspace >= 0.65);
    await shot(p, "02-review");
  });
  await check(
    "Working draft and request survive refresh; original remains unchanged",
    async () => {
      const original = firstDoc(await state(p)).original;
      await p
        .getByRole("textbox", { name: "成果正文" })
        .fill("人工工作稿：保留这段文字与完整上下文。");
      await p
        .getByLabel("修改要求", { exact: true })
        .fill("压缩开头，保留原始出处。");
      await until(
        async () => firstDoc(await state(p)).requestDraft.includes("压缩"),
        "request persist",
      );
      await p.reload();
      await p.getByRole("textbox", { name: "成果正文" }).waitFor();
      assert.match(
        await p.getByRole("textbox", { name: "成果正文" }).innerText(),
        /人工工作稿/,
      );
      assert.equal(firstDoc(await state(p)).original, original);
      await p.getByRole("button", { name: "交回修改", exact: true }).click();
      assert.equal(
        await p.getByLabel("修改要求", { exact: true }).inputValue(),
        "压缩开头，保留原始出处。",
      );
    },
  );
  await check(
    "Per-artifact instructions stay separate on document switches",
    async () => {
      await p.locator(".doc-nav").nth(1).click();
      await p.getByRole("button", { name: "交回修改", exact: true }).click();
      assert.equal(
        await p.getByLabel("修改要求", { exact: true }).inputValue(),
        "",
      );
      await p
        .getByLabel("修改要求", { exact: true })
        .fill("第二份成果的独立要求");
      await p.locator(".doc-nav").first().click();
      await p.getByRole("button", { name: "交回修改", exact: true }).click();
      assert.equal(
        await p.getByLabel("修改要求", { exact: true }).inputValue(),
        "压缩开头，保留原始出处。",
      );
    },
  );
  await check(
    "Revision request stores full draft, version, instruction and recipient",
    async () => {
      const before = firstDoc(await state(p));
      await p
        .getByRole("button", { name: "提交修改要求", exact: true })
        .click();
      await until(
        async () => firstDoc(await state(p)).requests.length === 1,
        "request stored",
      );
      const r = firstDoc(await state(p)).requests[0];
      assert.equal(r.html, before.html);
      assert.equal(r.baseRevision, before.revision);
      assert.equal(r.member, before.requestMember);
      assert.equal(r.instruction, before.requestDraft);
      assert(await p.locator(".review-layout").isVisible());
    },
  );
  await check(
    "Candidate never overwrites later human edits; replacement needs acknowledgement",
    async () => {
      await p
        .getByRole("textbox", { name: "成果正文" })
        .fill("发送之后我又修改的工作稿，不能丢。");
      const edited = firstDoc(await state(p)).html;
      await p.getByRole("button", { name: "演示候选版本返回" }).click();
      await until(
        async () => !!firstDoc(await state(p)).candidate,
        "candidate",
      );
      assert.equal(firstDoc(await state(p)).html, edited);
      await p.getByRole("button", { name: "预览并对比" }).click();
      assert(
        await p
          .getByRole("button", { name: "应用此版本", exact: true })
          .isDisabled(),
      );
      await shot(p, "03-version-compare");
      await p.locator("dialog input[type=checkbox]").check();
      await p.getByRole("button", { name: "应用此版本", exact: true }).click();
      await until(
        async () => firstDoc(await state(p)).history.length === 1,
        "history retained",
      );
      const d = firstDoc(await state(p));
      assert.equal(d.history[0].html, edited);
      assert.equal(d.candidate, null);
    },
  );
  await check(
    "History can restore human edits without losing the replaced version",
    async () => {
      await p.locator(".version-button").click();
      await p.getByRole("button", { name: /工作稿版本/ }).click();
      await p
        .getByRole("button", { name: "恢复到工作稿", exact: true })
        .click();
      await until(
        async () => firstDoc(await state(p)).history.length === 2,
        "restore history",
      );
      assert.match(
        await p.getByRole("textbox", { name: "成果正文" }).innerText(),
        /不能丢/,
      );
    },
  );
  await check(
    "Export does not count as adoption; explicit feedback binds current version",
    async () => {
      const download = p.waitForEvent("download");
      await p.getByRole("button", { name: "导出稿件", exact: true }).click();
      await download;
      assert.equal(firstDoc(await state(p)).feedback, null);
      await p.getByRole("button", { name: "采用成果", exact: true }).click();
      await p.getByLabel("原因（选填）").fill("保留了我的实际修改");
      await p.getByRole("button", { name: "确认采用", exact: true }).click();
      await until(
        async () => firstDoc(await state(p)).feedback === "adopted",
        "feedback",
      );
      const d = firstDoc(await state(p));
      assert.equal(d.evaluatedRevision, d.revision);
      assert.equal(d.evaluatedHTML, d.html);
    },
  );
  await check(
    "Project entry returns to chat, never silently reopens review",
    async () => {
      await p.getByRole("button", { name: "返回群聊", exact: true }).click();
      await p.locator(".project-hit").nth(1).click();
      await p.locator(".project-hit").first().click();
      assert.equal((await state(p)).review, false);
      assert(await p.locator(".composer").isVisible());
    },
  );
  await check(
    "IME composing shortcut does not send; normal shortcut sends once",
    async () => {
      const textbox = p.locator(".composer [contenteditable=true]");
      await textbox.fill("输入法测试");
      const n = current(await state(p)).messages.length;
      await textbox.dispatchEvent("keydown", {
        key: "Enter",
        code: "Enter",
        metaKey: true,
        isComposing: true,
      });
      assert.equal(current(await state(p)).messages.length, n);
      await textbox.dispatchEvent("keydown", {
        key: "Enter",
        code: "Enter",
        metaKey: true,
        isComposing: false,
      });
      await until(
        async () => current(await state(p)).messages.length === n + 1,
        "shortcut send",
      );
      assert.equal(current(await state(p)).composer, "");
    },
  );
  await check(
    "Pending decisions navigate to the affected paragraph; choose and undo remain in the artifact",
    async () => {
      await nav(p, "待我决定").click();
      await shot(p, "04-decisions");
      await p
        .getByRole("button", { name: "在稿件中处理", exact: true })
        .click();
      await p.locator(".decision-inline").waitFor();
      await shot(p, "09-inline-decision");
      assert(await p.locator(".review-layout").isVisible());
      await p
        .locator(".decision-inline")
        .getByRole("button", { name: "采纳此方案", exact: true })
        .first()
        .click();
      await until(
        async () => current(await state(p)).decisions[0].status === "resolved",
        "inline decision",
      );
      assert.match(firstDoc(await state(p)).html, /data-selected=/);
      await p
        .locator(".decision-inline")
        .getByRole("button", { name: "撤回", exact: true })
        .click();
      await until(
        async () => current(await state(p)).decisions[0].status === "pending",
        "undo inline",
      );
      await p
        .locator(".decision-inline")
        .getByRole("button", { name: "两种都保留", exact: true })
        .click();
      assert.match(await p.locator(".decision-chosen").innerText(), /如果/);
      await nav(p, "待我决定").click();
      await p.getByRole("button", { name: "已处理", exact: true }).click();
      assert.match(await p.locator(".resolved-note").innerText(), /两种都保留/);
    },
  );
  await check(
    "Marginal rule suggestion is explicit, scoped and reversible without a management form",
    async () => {
      await p
        .getByRole("button", { name: "查看原文与决定", exact: true })
        .click();
      await p
        .getByRole("button", {
          name: "演示改稿建议（未调用模型）",
          exact: true,
        })
        .click();
      await shot(p, "10-learning-note");
      const n = current(await state(p)).rules.length;
      assert.equal(firstDoc(await state(p)).suggestion.status, "pending");
      assert.equal(current(await state(p)).rules.length, n);
      await p.getByRole("button", { name: "以后都这样", exact: true }).click();
      await until(
        async () => current(await state(p)).rules.length === n + 1,
        "inline rule",
      );
      assert.equal(current(await state(p)).rules.at(-1).scope, "本项目");
      await p
        .locator(".learning-note")
        .getByRole("button", { name: "撤回", exact: true })
        .click();
      await until(
        async () => firstDoc(await state(p)).suggestion.status === "pending",
        "undo rule",
      );
      await p.getByRole("button", { name: "只这次", exact: true }).click();
      await until(
        async () => firstDoc(await state(p)).suggestion.status === "dismissed",
        "dismiss rule",
      );
      assert.equal(
        await p
          .getByRole("button", {
            name: "演示改稿建议（未调用模型）",
            exact: true,
          })
          .count(),
        0,
      );
    },
  );
  await check(
    "Active rule revision is proposed separately, trial revocation restores old rule",
    async () => {
      await nav(p, "知识库").click();
      await shot(p, "05-knowledge");
      const old = current(await state(p)).rules.find(
        (r) => r.status === "active",
      );
      const card = p.locator(".rule-card").filter({ hasText: old.title });
      await card.getByRole("button", { name: "提出修订", exact: true }).click();
      await p
        .getByLabel("具体怎么做")
        .fill("新规则：每条事实保留两个原始出处。");
      await p.getByRole("button", { name: "保存待批准提案" }).click();
      await until(
        async () =>
          current(await state(p)).rules.some((r) => r.baseRuleId === old.id),
        "rule revision",
      );
      let rules = current(await state(p)).rules;
      assert.equal(rules.find((r) => r.id === old.id).body, old.body);
      assert.equal(rules.find((r) => r.id === old.id).status, "active");
      const revised = rules.find((r) => r.baseRuleId === old.id);
      await nav(p, "待我决定").click();
      await p
        .locator(".decision-card")
        .filter({ hasText: "新规则：每条事实" })
        .getByRole("button", { name: "批准试行", exact: true })
        .click();
      await until(
        async () =>
          current(await state(p)).rules.find((r) => r.id === old.id).status ===
          "superseded",
        "trial replaced",
      );
      await nav(p, "知识库").click();
      await p
        .locator(".rule-card")
        .filter({ hasText: "新规则：每条事实" })
        .getByRole("button", { name: "记录复查", exact: true })
        .click();
      await p
        .getByLabel("观察与依据")
        .fill("本轮增加了重复引用，撤回此次修改。");
      await p.getByLabel("你的结论").selectOption("revoke");
      await p.getByRole("button", { name: "保存复查", exact: true }).click();
      await until(
        async () =>
          current(await state(p)).rules.find((r) => r.id === old.id).status ===
          "active",
        "restore old rule",
      );
      rules = current(await state(p)).rules;
      assert.equal(rules.find((r) => r.id === revised.id).status, "revoked");
      assert.match(
        rules.find((r) => r.id === revised.id).evaluation,
        /重复引用/,
      );
    },
  );
  await check(
    "Two same-platform members remain independently identified",
    async () => {
      await nav(p, "成员").click();
      await p.getByRole("button", { name: "添加成员", exact: true }).click();
      await p.getByLabel("备注名称").fill("第二个 Muse");
      await p.getByLabel("平台", { exact: true }).selectOption("Muse");
      await p.getByRole("button", { name: "添加示例成员" }).click();
      await until(
        async () => (await state(p)).members.length === 5,
        "second member",
      );
      const ms = (await state(p)).members.filter((m) => m.platform === "Muse");
      assert.equal(ms.length, 2);
      assert.notEqual(ms[0].id, ms[1].id);
      await shot(p, "06-members");
    },
  );
  for (const [mode, label] of [
    ["solo", "单兵直通"],
    ["parallel", "赛马互证"],
    ["review", "红蓝对抗"],
  ]) {
    await check(
      `Three-step goal wizard: ${mode}, no upfront roles or permission form`,
      async () => {
        await nav(p, "项目").click();
        await p.getByRole("button", { name: "新建项目", exact: true }).click();
        assert.equal(await p.locator("dialog textarea").count(), 1);
        assert.equal(await p.locator("dialog select").count(), 0);
        assert.equal(await p.locator("dialog input").count(), 0);
        await p
          .getByLabel("你想让团队做成什么？")
          .fill(`研究可追溯的材料，交付实际判断：${mode}`);
        await p.getByRole("button", { name: "下一步", exact: true }).click();
        assert.equal(await p.locator(".mode-option").count(), 3);
        assert.equal(
          await p
            .locator("dialog")
            .getByRole("button", { name: /^赛马互证/ })
            .getAttribute("aria-pressed"),
          "true",
        );
        await p
          .locator("dialog")
          .getByRole("button", { name: new RegExp(`^${label}`) })
          .click();
        if (mode === "solo")
          assert.equal(
            await p.locator(".member-picker input:checked").count(),
            1,
          );
        if (mode === "parallel") await shot(p, "07-new-goal");
        await p.getByRole("button", { name: "下一步", exact: true }).click();
        if (mode === "parallel") {
          await p.getByLabel("每天定时", { exact: true }).check();
          await p.getByLabel("时间点", { exact: true }).fill("25:00");
          await p.getByRole("button", { name: "开始", exact: true }).click();
          assert.match(
            await p.locator(".form-error").innerText(),
            /时间请填写/,
          );
          await p
            .getByLabel("时间点", { exact: true })
            .fill("06:00、12:00、19:00、06:00");
        }
        await p.getByRole("button", { name: "开始", exact: true }).click();
        await p.locator("dialog").waitFor({ state: "detached" });
        const pr = current(await state(p));
        assert.equal(pr.mode, mode);
        assert.equal(pr.status, "running");
        assert(pr.criteria);
        assert.equal(pr.schedule.enabled, mode === "parallel");
        if (mode === "parallel")
          assert.deepEqual(pr.schedule.times, ["06:00", "12:00", "19:00"]);
      },
    );
  }
  await check(
    "Manual demonstration progresses to a reviewable artifact; pause blocks progression",
    async () => {
      await until(
        async () => current(await state(p)).status === "running",
        "running",
      );
      const pause = p.getByRole("button", { name: "暂停", exact: true });
      await pause.click();
      await until(
        async () => current(await state(p)).status === "paused",
        "paused",
      );
      await p
        .getByRole("button", { name: "查看运行记录", exact: true })
        .click();
      assert(
        await p
          .locator("dialog")
          .getByRole("button", { name: "重新演示", exact: true })
          .isDisabled(),
      );
      await p.getByRole("button", { name: "关闭弹窗", exact: true }).click();
      await p.getByRole("button", { name: "恢复", exact: true }).click();
      await p.getByRole("button", { name: "演示下一步", exact: true }).click();
      await p.getByRole("button", { name: "演示下一步", exact: true }).click();
      await until(
        async () => current(await state(p)).docs.length === 1,
        "demo delivery",
      );
      assert.match(current(await state(p)).docs[0].html, /未调用真实 Agent/);
    },
  );
  await check(
    "Workspace export includes current projects and members",
    async () => {
      await nav(p, "设置").click();
      await shot(p, "08-settings");
      const downloads = p.waitForEvent("download");
      await p.getByRole("button", { name: "导出工作区", exact: true }).click();
      const d = await downloads;
      const contents = JSON.parse(await fs.readFile(await d.path(), "utf8"));
      assert.equal(contents.projects.length, 6);
      assert.equal(contents.members.length, 5);
    },
  );
  await p.context().close();
  const layout = await makePage();
  await review(layout);
  await layout.getByRole("button", { name: "交回修改", exact: true }).click();
  for (const width of [1280, 900])
    await check(
      `Review and modal fit ${width}px without horizontal document overflow`,
      async () => {
        await layout.setViewportSize({ width, height: 800 });
        const m = await layout.evaluate(() => ({
          width: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          reading: document.querySelector(".document-scroll").clientHeight,
          workspace: document.querySelector(".document-workspace").clientHeight,
        }));
        metrics.push(m);
        assert.equal(m.width, m.documentWidth);
        assert(m.reading / m.workspace >= 0.65);
        await shot(layout, `review-${width}`);
        const controls = await layout
          .locator(".document-actions button")
          .evaluateAll((xs) =>
            xs.map((x) => ({
              left: x.getBoundingClientRect().left,
              right: x.getBoundingClientRect().right,
            })),
          );
        assert(controls.every((x) => x.left >= 0 && x.right <= width));
      },
    );
  await layout.context().close();
  const quota = await makePage();
  await review(quota);
  await quota.getByRole("button", { name: "交回修改", exact: true }).click();
  await check(
    "Storage failure is visible and blocks handoff without clearing unsaved input",
    async () => {
      await quota.evaluate(() => {
        Storage.prototype.setItem = function () {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        };
      });
      await quota
        .getByLabel("修改要求", { exact: true })
        .fill("存储失败时也不能丢失");
      await quota.locator(".storage-error").waitFor();
      assert(
        await quota
          .getByRole("button", { name: "提交修改要求", exact: true })
          .isDisabled(),
      );
      assert.equal(
        await quota.getByLabel("修改要求", { exact: true }).inputValue(),
        "存储失败时也不能丢失",
      );
    },
  );
  await quota.context().close();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  checks.push("No JS runtime errors or external/agent network requests");
} catch (e) {
  failure = e;
  console.error(e.stack);
} finally {
  await fs.writeFile(
    path.join(out, "checks.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        buildSha256: createHash("sha256").update(index).digest("hex"),
        scope:
          "Isolated Chrome UI preview only. No production accounts, native agents, scheduling or backend acceptance.",
        checks,
        metrics,
        errors,
        externalRequests: external,
        failure: failure?.message || null,
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
if (failure) process.exitCode = 1;
