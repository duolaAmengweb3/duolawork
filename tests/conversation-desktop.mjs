import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { _electron } from "playwright-core";
import { startHarness } from "./v1-harness.mjs";
const h = await startHarness();
let app;
const dir = path.join(h.directory, "desktop-data");
try {
  await h.request("/admin/action", {
    type: "settings.update",
    payload: { automation: false },
  });
  const m = await h.member("grok-bot", "桌面测试成员");
  const c = await h.command("channel.create", {
    name: "重开保留对话",
    memberIds: [m.id],
    coordinatorId: m.id,
  });
  await h.command("channel.post", {
    channelId: c.id,
    body: "普通群消息，保留原文。",
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
      runnerId: "conversation-desktop",
      port,
    }),
  );
  const launch = () =>
    _electron.launch({
      executablePath:
        process.env.HUB_TEST_EXECUTABLE ||
        path.resolve(
          "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        ),
      args: process.env.HUB_TEST_EXECUTABLE ? [] : ["."],
      env: {
        ...process.env,
        AGENT_HUB_DATA_DIR: dir,
        AGENT_HUB_TEST_MODE: "1",
      },
      timeout: 20000,
    });
  app = await launch();
  let p = await app.firstWindow();
  await p.getByRole('textbox', { name: '群消息', exact: true }).waitFor();
  await p.evaluate(() => {
    const copy = document.createElement('button');
    copy.textContent = 'COPY-PERMISSION-REGRESSION';
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText('HUB-OWN-WORKBENCH-COPY'); copy.dataset.result = 'copied'; }
      catch { copy.dataset.result = 'denied'; }
    };
    document.body.append(copy);
  });
  await p.getByRole('button', { name: 'COPY-PERMISSION-REGRESSION' }).click();
  await p.waitForFunction(() => document.querySelector('[data-result]')?.dataset.result === 'copied');
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'HUB-OWN-WORKBENCH-COPY');
  assert.equal(await p.evaluate(async () => {
    try { await navigator.clipboard.readText(); return 'unexpected-read'; }
    catch { return 'denied'; }
  }), 'denied', 'the renderer must not gain clipboard reading');
  await p.evaluate(() => {
    const frame = document.createElement('iframe'); frame.src = '/'; frame.id = 'clipboard-subframe';
    document.body.append(frame);
  });
  await p.locator('#clipboard-subframe').contentFrame().locator('body').waitFor();
  assert.equal(await p.locator('#clipboard-subframe').contentFrame().locator('body').evaluate(async () => {
    try { await navigator.clipboard.writeText('SUBFRAME-MUST-NOT-COPY'); return 'unexpected-write'; }
    catch { return 'denied'; }
  }), 'denied', 'an embedded document must not overwrite the clipboard');
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'HUB-OWN-WORKBENCH-COPY');
  await p.evaluate(() => { document.querySelector('#clipboard-subframe')?.remove(); document.querySelector('[data-result]')?.remove(); });
  await p
    .getByRole("textbox", { name: "群消息", exact: true })
    .fill("未发出的草稿 CONVERSATION-RESTART");
  await p.waitForFunction(() =>
    localStorage.getItem("hub-communication")?.includes("CONVERSATION-RESTART"),
  );
  const url = p.url();
  await app.close();
  app = null;
  await assert.rejects(
    fetch(new URL("/api/local/status", url)),
    /fetch failed/,
  );
  app = await launch();
  p = await app.firstWindow();
  await p.getByRole("textbox", { name: "群消息", exact: true }).waitFor();
  assert.match(
    await p.getByRole("textbox", { name: "群消息", exact: true }).inputValue(),
    /CONVERSATION-RESTART/,
  );
  await p
    .getByRole("main")
    .getByText("普通群消息，保留原文。", { exact: true })
    .waitFor();
  const status = await (
    await fetch(new URL("/api/local/status", p.url()))
  ).json();
  assert.equal(status.clientView.ready, true);
  assert.equal(
    status.clientView.buildId,
    await p.locator("[data-build-id]").getAttribute("data-build-id"),
  );
  const snap = await h.request("/v2/channel?id=" + c.id);
  assert.equal(snap.messages.length, 1);
  assert.equal(snap.channel.coordinatorId, m.id);
  const report = {
    at: new Date().toISOString(),
    packaged: !!process.env.HUB_TEST_EXECUTABLE,
    isolated: true,
    checks: [
      "真实 Electron 完整退出及重开",
      "本地工作台复制可用，剪贴板读取及内嵌页面写入仍被拒绝",
      "群选择、用户指定负责人、普通消息保留",
      "未发送草稿保留",
      "重开未重复发消息或创建任务",
    ],
    commercialAgentTest: false,
  };
  await fs.writeFile(
    "evidence/conversation-desktop.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app?.close();
  await h.stop();
}
