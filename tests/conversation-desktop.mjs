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
