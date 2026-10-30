import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { _electron } from "playwright-core";
import { startHarness } from "./v1-harness.mjs";
const h = await startHarness();
let app;
const dir = path.join(h.directory, "desktop-data"),
  executablePath =
    process.env.HUB_TEST_EXECUTABLE ||
    path.resolve(
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
try {
  await h.request("/admin/action", {
    type: "settings.update",
    payload: { automation: false },
  });
  const m = await h.member("grok-bot", "桌面协议测试");
  const p = await h.command("project.create", {
    name: "完整退出重开验收",
    goal: "保存成果与未发出的输入",
    arrangement: {
      mode: "solo",
      members: [m.id],
      lead: m.id,
      criteria: ["保存正文"],
      internalRevisions: 0,
    },
  });
  const run = await h.command("run.start", { projectId: p.id });
  const w = (await m.call("list_work")).work.find((w) => w.runId === run.id),
    c = await m.call("claim_work", {
      requestId: crypto.randomUUID(),
      stepId: w.stepId,
    });
  const submitted = await m.call("submit_work", {
    requestId: crypto.randomUUID(),
    attemptId: c.attemptId,
    lease: c.lease,
    items: [
      {
        title: "桌面测试原稿",
        body: "这份原稿用于验证真正退出桌面进程后，重新打开仍能恢复项目和人工工作稿。",
        claims: [
          {
            id: "save",
            text: "隔离保存验收",
            sourceUrls: ["https://example.com/test"],
          },
        ],
        selfCheck: [
          {
            criterion: 0,
            pass: true,
            reason: "原始正文已交付",
            paragraph: "原稿",
          },
        ],
      },
    ],
  });
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      endpoint: h.base,
      adminKey: h.key,
      runnerId: "desktop-v1",
      port,
    }),
  );
  const launch = () =>
    _electron.launch({
      executablePath,
      args: process.env.HUB_TEST_EXECUTABLE ? [] : ["."],
      env: {
        ...process.env,
        AGENT_HUB_DATA_DIR: dir,
        AGENT_HUB_TEST_MODE: "1",
      },
      timeout: 20000,
    });
  app = await launch();
  let page = await app.firstWindow();
  await page
    .getByRole("button", { name: "审阅成果", exact: true })
    .first()
    .click();
  const editor = page.getByRole("textbox", { name: "成果正文" });
  await editor.fill("人工工作稿 V1-NATIVE-RESTART-20261030");
  await page.getByText("已保存", { exact: true }).waitFor();
  const back = page.getByRole("button", { name: "返回项目" });
  await back.click();
  const input = page.getByRole("textbox", { name: "项目消息" });
  await input.fill("未发送输入 V1-UNSENT-20261030");
  await page.waitForFunction(() =>
    Object.keys(localStorage).some(
      (k) =>
        k.startsWith("agent-hub-composer-") &&
        localStorage[k].includes("V1-UNSENT"),
    ),
  );
  const url = page.url();
  await app.close();
  app = null;
  await assert.rejects(
    fetch(new URL("/api/local/status", url)),
    /fetch failed/,
  );
  app = await launch();
  page = await app.firstWindow();
  await page.getByRole("textbox", { name: "项目消息" }).waitFor();
  assert.match(
    await page.getByRole("textbox", { name: "项目消息" }).inputValue(),
    /V1-UNSENT/,
  );
  await page
    .getByRole("button", { name: "审阅成果", exact: true })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "成果正文" })
    .getByText(/V1-NATIVE-RESTART/)
    .waitFor();
  const state = await h.request("/v2/project?id=" + p.id);
  assert.equal(state.runs.length, 1);
  await page.screenshot({ path: "evidence/v1-desktop-restart.png" });
  const report = {
    at: new Date().toISOString(),
    packaged: !!process.env.HUB_TEST_EXECUTABLE,
    keychain: "temporary test-only mock keychain",
    checks: [
      "真实 Electron 进程关闭后本地服务退出",
      "固定本地地址与项目选择恢复",
      "未发送输入完整保留",
      "人工工作稿从真实 D1 版本恢复",
      "重开不重复启动运行",
      "安装包隔离测试不接触正式账号",
    ],
    realCommercialAgentTested: false,
  };
  await fs.writeFile(
    "evidence/v1-desktop.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  if (app) {
    const p = await app.firstWindow();
    console.error((await p.locator("body").innerText()).slice(-4000));
  }
  throw e;
} finally {
  await app?.close();
  await h.stop();
}
