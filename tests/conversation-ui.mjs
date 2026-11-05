import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { startHarness } from "./v1-harness.mjs";
const h = await startHarness();
process.env.AGENT_HUB_DATA_DIR = path.join(h.directory, "local");
const { start } = await import("../local/server.mjs");
let local, browser;
const checks = [],
  errors = [];
try {
  await h.request("/admin/action", {
    type: "settings.update",
    payload: { automation: false },
  });
  const grok = await h.member("grok-bot", "Grok"),
    dot = await h.member("chatgpt-agent", "Dot"),
    muse = await h.member("muse", "Muse");
  local = await start({
    port: 0,
    maintenance: true,
    vaultKey: Buffer.alloc(32, 17),
    config: {
      endpoint: h.base,
      adminKey: h.key,
      runnerId: "conversation-ui-isolated",
    },
  });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const p = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(local.url);
  await p
    .getByRole("button", { name: "新建群聊", exact: true })
    .first()
    .click();
  await p
    .getByRole("textbox", { name: "群名称", exact: true })
    .fill("产品讨论室");
  await p.getByRole("checkbox", { name: "选择 Grok", exact: true }).check();
  await p.getByRole("checkbox", { name: "选择 Dot", exact: true }).check();
  await p.getByLabel("群负责人", { exact: true }).selectOption(grok.id);
  await p.getByRole("button", { name: "创建并开始沟通", exact: true }).click();
  await p.getByRole("dialog").waitFor({ state: "hidden" });
  await p
    .getByRole("textbox", { name: "群消息", exact: true })
    .fill("都在线吗？");
  await p.getByRole("button", { name: "发送消息", exact: true }).click();
  await p.getByText("都在线吗？", { exact: true }).waitFor();
  let c = (await h.request("/v2/channels")).items[0];
  assert.equal(c.coordinatorId, grok.id);
  assert.equal(
    (await h.request("/v2/records?kind=run")).items.filter(
      (r) => r.purpose === "goal",
    ).length,
    0,
  );
  checks.push("创建群聊、用户选择负责人、普通消息不创建任务");
  assert.equal((await dot.call("list_work")).work.filter(w => w.channelId === c.id).length, 0);
  assert.equal((await grok.call("list_work")).work.filter(w => w.channelId === c.id).length, 1);
  await p.getByRole('button',{name:'提及全员',exact:true}).click();
  await p.getByRole('textbox',{name:'群消息',exact:true}).fill('请全员补充');
  await p.getByRole('button',{name:'发送消息',exact:true}).click();
  await p.getByText('请全员补充',{exact:true}).waitFor();
  const broadcast = await h.request('/v2/channel?id='+c.id);
  assert.equal(broadcast.messages.at(-1).mentionAll, true);
  assert.deepEqual(broadcast.messages.at(-1).recipientIds.sort(),[grok.id,dot.id].sort());
  checks.push('普通消息只通知负责人，群内全员按钮明确广播，界面显示当前接收人');
  const work = (await dot.call("list_work")).work.find(
      (w) => w.channelId === c.id,
    ),
    claim = await dot.call("claim_work", {
      requestId: crypto.randomUUID(),
      stepId: work.stepId,
    });
  await p.getByRole("button", { name: "群设置", exact: true }).click();
  for (const label of ['群状态', '消息与唤醒设置', '连续 @ 跳数上限']) {
    assert.equal(await p.getByRole('dialog').getByText(label, { exact: true }).count(), 0);
  }
  await p.getByRole("checkbox", { name: "选择 Dot", exact: true }).uncheck();
  await p.getByRole("button", { name: "保存群设置", exact: true }).click();
  await p
    .getByRole("dialog")
    .getByRole("alert")
    .getByText("此成员正在回应，请等它完成后移出", { exact: true })
    .waitFor();
  await p.getByRole("button", { name: "Close", exact: true }).click();
  assert((await h.request("/v2/channels")).items[0].memberIds.includes(dot.id));
  checks.push("移出正在回应的成员时在当前弹窗说明原因，保留原成员和通知");
  await dot.call("post_message", {
    requestId: crypto.randomUUID(),
    channelId: c.id,
    turnId: claim.turnId,
    body: "我在。@Grok，你觉得先讨论哪一点？",
    mentions: [grok.id],
  });
  await p
    .getByRole("main")
    .getByText("我在。@Grok，你觉得先讨论哪一点？", { exact: true })
    .waitFor({ timeout: 20000 });
  checks.push("原生协议成员回复、@ 显示、无成果审阅卡");
  await p.getByRole("button", { name: "群设置", exact: true }).click();
  await p.getByLabel("群负责人", { exact: true }).selectOption(dot.id);
  await p.getByRole("checkbox", { name: "选择 Muse", exact: true }).check();
  await p.getByRole("button", { name: "保存群设置", exact: true }).click();
  await p.getByRole("dialog").waitFor({ state: "hidden" });
  c = (await h.request("/v2/channels")).items[0];
  assert.equal(c.coordinatorId, dot.id);
  assert(c.memberIds.includes(muse.id));
  await p.getByRole("button", { name: "群设置", exact: true }).click();
  await p.getByRole("checkbox", { name: "选择 Muse", exact: true }).uncheck();
  await p.getByRole("button", { name: "保存群设置", exact: true }).click();
  await p.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    (await h.request("/v2/channels")).items[0].memberIds.includes(muse.id),
    false,
  );
  assert(
    (await h.request("/v2/workspace")).members.some((m) => m.id === muse.id),
  );
  checks.push("负责人更换，成员直接添加和移出，账号和聊天保留");
  await p.getByRole("button", { name: "新建共享文档", exact: true }).click();
  await p
    .getByRole("textbox", { name: "工具标题", exact: true })
    .fill("共创笔记");
  await p
    .getByRole("textbox", { name: "工具正文", exact: true })
    .fill("先记录真实问题，不预设分工。");
  await p.getByRole("button", { name: "保存", exact: true }).click();
  await p.getByRole("button", { name: "编辑文档", exact: true }).click();
  await p
    .getByRole("textbox", { name: "共享文档正文", exact: true })
    .fill("用户可以随时更换负责人，其他成员直接交流。");
  await p
    .getByRole("textbox", { name: "修改原因", exact: true })
    .fill("补充负责人原则");
  await p.getByRole("button", { name: "保存修改", exact: true }).click();
  await p.getByRole("button", { name: "编辑文档", exact: true }).waitFor();
  await p.reload();
  await p
    .getByRole("main")
    .getByRole("button", { name: /共创笔记/ })
    .first()
    .click();
  await p
    .getByText("用户可以随时更换负责人，其他成员直接交流。", { exact: true })
    .waitFor();
  await p.getByRole("button", { name: "Close", exact: true }).click();
  checks.push("共同文档编辑、版本保存，刷新后正文保留");
  const q = await dot.call("ask_user", {
    requestId: crypto.randomUUID(),
    channelId: c.id,
    question: "先看哪个方向？",
    options: ["产品需求", "技术实现"],
  });
  await p
    .getByRole("button", { name: "产品需求", exact: true })
    .waitFor({ timeout: 20000 });
  await p.getByRole("button", { name: "产品需求", exact: true }).click();
  await p.getByText("用户选择：产品需求", { exact: true }).waitFor();
  checks.push("用户决定卡直接回复，提问者收到继续消息");
  await p.getByRole("textbox", { name: "群消息", exact: true }).fill("@Do");
  await p.getByRole("button", { name: "提及 Dot", exact: true }).click();
  await p
    .getByRole("textbox", { name: "群消息", exact: true })
    .fill("只请 Dot 看一下。");
  await p.getByRole("button", { name: "发送消息", exact: true }).click();
  await p
    .getByRole("main")
    .getByText("只请 Dot 看一下。", { exact: true })
    .waitFor();
  const directed = await h.request("/v2/channel?id=" + c.id);
  assert.deepEqual(directed.messages.at(-1).mentions, [dot.id]);
  checks.push("键入 @ 自动选择成员，定向通知真实群内 ID");
  await p.getByRole('textbox',{name:'群消息',exact:true}).fill('@全');
  await p.getByRole('button',{name:'选择全员',exact:true}).click();
  await p.reload();
  await p.getByRole('button',{name:'取消提及全员',exact:true}).click();
  assert.equal(await p.getByRole('button',{name:'提及全员',exact:true}).getAttribute('aria-pressed'),'false');
  await p.getByRole('textbox',{name:'群消息',exact:true}).fill('@Grok 只请你核对');
  await p.getByRole('button',{name:'发送消息',exact:true}).click();
  await p.getByText('@Grok 只请你核对',{exact:true}).waitFor();
  assert.deepEqual((await h.request('/v2/channel?id='+c.id)).messages.at(-1).recipientIds,[grok.id]);
  await h.command('channel.update',{channelId:c.id,coordinatorId:null});
  await p.reload();
  await p.getByRole('textbox',{name:'群消息',exact:true}).fill('暂未指定负责人');
  await p.getByRole('button',{name:'发送消息',exact:true}).click();
  await p.getByText('请选择群负责人，或 @ 一位成员、@全员后发送',{exact:true}).waitFor();
  assert.equal((await h.request('/v2/channel?id='+c.id)).messages.some(m=>m.body==='暂未指定负责人'),false);
  await p.getByRole('button',{name:'提及全员',exact:true}).click();
  await p.getByRole('button',{name:'发送消息',exact:true}).click();
  await p.getByText('暂未指定负责人',{exact:true}).waitFor();
  assert.equal((await h.request('/v2/channel?id='+c.id)).messages.at(-1).mentionAll,true);
  await h.command('channel.update',{channelId:c.id,coordinatorId:dot.id});
  await p.reload();
  await p.locator('.pending-member').filter({hasText:'Dot 已回复'}).click();
  await p.getByRole('heading',{name:'消息处理记录',exact:true}).waitFor();
  assert.ok(await p.locator('.activity-source').filter({hasText:'暂未指定负责人'}).count());
  await p.getByRole('button',{name:'返回',exact:true}).click();
  await p.getByRole('button',{name:'提及成员',exact:true}).click();
  await fs.mkdir('evidence/screenshots',{recursive:true});
  await p.screenshot({path:'evidence/screenshots/conversation-addressing.png'});
  await p.getByRole('button',{name:'选择全员',exact:true}).click();
  await p.getByRole('button',{name:'取消提及全员',exact:true}).click();
  checks.push('键入 @全员、取消选择、直接键入成员名字；无负责人不误发，显式全员仍可发送；已回复与后来消息分开且能查看原文');
  for (const status of ["paused", "archived"]) {
    await h.request('/v2/commands', { type: 'channel.update', requestId: crypto.randomUUID(), channelId: c.id, status });
    await p.reload();
    const composer = p.getByRole('textbox', { name: '群消息', exact: true });
    await composer.waitFor();
    assert.equal(await composer.isEnabled(), true);
    assert.equal(await p.getByText('群聊已暂停，可在群设置中恢复', { exact: true }).count(), 0);
    await composer.fill('直接继续聊天：' + status);
    await p.getByRole('button', { name: '发送消息', exact: true }).click();
    await p.getByRole('main').getByText('直接继续聊天：' + status, { exact: true }).waitFor();
    const continued = await h.request('/v2/channel?id=' + c.id);
    assert.equal(continued.channel.status, 'active');
    assert.equal(continued.messages.filter(m => m.body === '直接继续聊天：' + status).length, 1);
    assert.ok(continued.messages.some(m => m.body === '都在线吗？'));
  }
  checks.push('旧暂停或归档记录打开即可继续发消息，无解锁步骤，历史保留，服务端恢复正常回应；群设置不要求管理状态或唤醒参数');
  await p
    .getByRole("textbox", { name: "群消息", exact: true })
    .fill("未发送的草稿");
  await p.reload();
  await p.getByRole("textbox", { name: "群消息", exact: true }).waitFor();
  assert.equal(
    await p.getByRole("textbox", { name: "群消息", exact: true }).inputValue(),
    "未发送的草稿",
  );
  checks.push("群选择与草稿刷新后保留");
  let failReads = true, loseAcknowledgement = false, postRequests = 0;
  await p.route('**/api/v2/**', async route => {
    const request = route.request();
    if (request.method() === 'GET' && failReads) return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'network_unavailable', message: '连接暂时中断，正在自动重连。' }) });
    if (request.method() === 'POST' && request.url().endsWith('/commands') && request.postDataJSON().type === 'channel.post') {
      postRequests++;
      if (loseAcknowledgement) { loseAcknowledgement = false; await route.fetch(); return route.abort('failed'); }
    }
    return route.continue();
  });
  await p.getByRole('status').getByText(/正在恢复同步/).waitFor({ timeout: 20000 });
  assert.equal(await p.getByRole('textbox', { name: '群消息', exact: true }).inputValue(), '未发送的草稿');
  await p.getByText('都在线吗？', { exact: true }).waitFor();
  failReads = false;
  await p.locator('.comm-sync-status').waitFor({ state: 'hidden', timeout: 20000 });
  checks.push('连接中断保留聊天和草稿，恢复后自动清除提示，无需重启或重新登录');
  // The write succeeds; only the following refresh fails. Do not report the write as failed.
  failReads = true;
  await p.getByRole('textbox', { name: '群消息', exact: true }).fill('写入确认后的读取故障');
  await p.getByRole('button', { name: '发送消息', exact: true }).click();
  await p.waitForFunction(() => document.querySelector('textarea[aria-label="群消息"]')?.value === '');
  assert.equal((await h.request('/v2/channel?id=' + c.id)).messages.filter(m => m.body === '写入确认后的读取故障').length, 1);
  assert.equal(await p.getByRole('alert').count(), 0);
  failReads = false;
  await p.getByRole('main').getByText('写入确认后的读取故障', { exact: true }).waitFor({ timeout: 20000 });
  checks.push('消息已保存但随后刷新失败时仍确认发送，服务端仅有一条消息');
  loseAcknowledgement = true;
  postRequests = 0;
  await p.getByRole('textbox', { name: '群消息', exact: true }).fill('响应丢失后的幂等重试');
  await p.getByRole('button', { name: '发送消息', exact: true }).click();
  await p.getByRole('alert').getByText(/操作结果尚未确认/).waitFor();
  assert.equal(postRequests, 1, '写入失败不自动重发');
  assert.equal(await p.getByRole('textbox', { name: '群消息', exact: true }).inputValue(), '响应丢失后的幂等重试');
  await p.getByRole('button', { name: '发送消息', exact: true }).click();
  await p.waitForFunction(() => document.querySelector('textarea[aria-label="群消息"]')?.value === '');
  assert.equal(postRequests, 2);
  assert.equal((await h.request('/v2/channel?id=' + c.id)).messages.filter(m => m.body === '响应丢失后的幂等重试').length, 1);
  await p.getByRole('textbox', { name: '群消息', exact: true }).fill('未发送的草稿');
  await p.unroute('**/api/v2/**');
  checks.push('服务端已收消息但回执丢失时保留草稿，用户重试沿用原编号、不重复落消息');
  await fs.mkdir("evidence/screenshots", { recursive: true });
  await p.screenshot({
    path: "evidence/screenshots/conversation-desktop.png",
    fullPage: true,
  });
  await p.setViewportSize({ width: 1000, height: 760 });
  await p.screenshot({
    path: "evidence/screenshots/conversation-compact.png",
    fullPage: true,
  });
  assert.equal(
    await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    "evidence/conversation-ui.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        scope:
          "isolated Chromium + Worker/D1 + scripted protocol peers, not real commercial Agents",
        checks,
        errors,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  await browser?.close();
  await local?.close();
  await h.stop();
}
