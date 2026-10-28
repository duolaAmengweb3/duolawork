import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { STORAGE_KEY } from "./src/model.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({
  executablePath:
    process.env.PROTOTYPE_CHROME ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const passed = [],
  errors = [],
  requests = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
  });
  await page.goto(new URL("./index.html", import.meta.url).href);
  const body = page.getByRole("textbox", { name: "成果正文" });
  await body.waitFor();
  await page.screenshot({ path: path.join(root, "preview-group.png") });
  await page.getByRole("button", { name: "展开成果审核", exact: true }).click();
  assert(await page.locator(".document-review").isVisible());
  assert.equal(await page.locator(".conversation").count(), 0);
  assert((await page.locator(".document-review").boundingBox()).width > 1000);
  await page.screenshot({ path: path.join(root, "preview-review.png") });
  await page.getByRole("button", { name: "返回群聊", exact: true }).click();
  passed.push("群聊与宽幅审核切换");

  await body.fill("这是测试工作稿。切换和刷新后必须保留。");
  await page.getByRole("button", { name: "查看原稿", exact: true }).click();
  assert((await body.innerText()).includes("能传话，只是开始"));
  assert.equal(await body.getAttribute("contenteditable"), "false");
  await page.getByRole("button", { name: "返回工作稿", exact: true }).click();
  assert((await body.innerText()).includes("这是测试工作稿"));
  await page.getByRole("button", { name: /选题素材夹/ }).click();
  assert(await page.getByText("成果会放在这里").isVisible());
  await page.getByRole("button", { name: /每日 X 内容包.*Dot/ }).click();
  await page.reload();
  assert((await body.innerText()).includes("这是测试工作稿"));
  passed.push("编辑保留、原稿只读、跨项目隔离、刷新恢复");

  await page.getByRole("button", { name: "采用", exact: true }).click();
  assert(
    (await page
      .getByRole("button", { name: "采用", exact: true })
      .getAttribute("aria-pressed")) === "true",
  );
  await page.getByRole("button", { name: "弃用", exact: true }).click();
  const saved = () =>
    page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
  let state = await saved();
  assert.equal(state.projects[0].docs.filter((d) => d.feedback).length, 1);
  assert.equal(state.projects[0].docs[0].feedback, "discarded");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出文稿", exact: true }).click();
  const download = await downloadEvent;
  assert(download.suggestedFilename().includes("示例工作稿"));
  assert.equal((await saved()).projects[0].docs[0].feedback, "discarded");
  passed.push("反馈按稿记录，重新选择不重复计数，导出不计采用");

  await page.getByRole("button", { name: "提及成员", exact: true }).click();
  await page
    .locator(".mention-menu")
    .getByRole("button", { name: /Dots/ })
    .click();
  assert(
    (
      await page.getByRole("textbox", { name: "项目群消息" }).inputValue()
    ).includes("@Dot"),
  );
  await page
    .getByRole("textbox", { name: "项目群消息" })
    .fill("@Dot 这是项目消息验收。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  assert(
    await page
      .getByRole("region", { name: "项目群对话" })
      .getByText("@Dot 这是项目消息验收。", { exact: true })
      .isVisible(),
  );
  await page.getByRole("button", { name: /交回 Dot 修改/ }).click();
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  assert.equal((await saved()).projects[0].docs[0].revision, 1);
  await page.getByRole("button", { name: /交回 Dot 修改/ }).click();
  await page.getByRole("button", { name: /保存交回消息/ }).click();
  state = await saved();
  assert(
    state.projects[0].messages.at(-1).draftSnapshot.includes("这是测试工作稿"),
  );
  assert.equal(state.projects[0].docs[0].revision, 2);
  passed.push("@成员、发消息、取消无副作用、交回附完整工作稿与快照");

  await page.getByRole("button", { name: /查看建议/ }).click();
  await page
    .getByRole("button", { name: "批准加入本项目", exact: true })
    .click();
  await page.getByRole("tab", { name: "项目知识", exact: true }).click();
  await page.getByRole("button", { name: "撤回", exact: true }).click();
  assert.equal((await saved()).projects[0].approved, false);
  passed.push("规则批准和撤回");

  await page.getByRole("button", { name: "配方", exact: true }).click();
  await page.getByRole("button", { name: "使用配方", exact: true }).click();
  await page.getByLabel("项目群名称").fill("测试项目");
  await page.getByLabel("查证成员").selectOption("Dot");
  await page.getByLabel("写作成员").selectOption("Muse");
  await page.getByRole("button", { name: "创建项目群", exact: true }).click();
  assert(await page.getByRole("dialog").isVisible());
  await page.getByRole("button", { name: "演示连接", exact: true }).click();
  await page.getByRole("button", { name: "创建项目群", exact: true }).click();
  assert.equal((await saved()).projects.at(-1).docs.length, 0);
  await page.getByRole("button", { name: "演示接力", exact: true }).click();
  await page
    .getByRole("button", { name: "暂停演示", exact: true })
    .waitFor({ state: "hidden", timeout: 10000 });
  state = await saved();
  assert.equal(state.projects.at(-1).stage, 3);
  assert.equal(state.projects.at(-1).docs.length, 3);
  assert.equal(state.projects.at(-1).writer, "Muse");
  passed.push("配方建群、缺连接拦截、成员替换、演示完成才生成成果");

  for (const width of [1440, 1024, 800, 620]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      "Horizontal overflow at " + width,
    );
  }
  passed.push("620–1600px 无页面横向溢出");
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log(
    JSON.stringify({ passed, errors, httpRequests: requests.length }, null, 2),
  );
} finally {
  await browser.close();
}
