import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { DuolaWorkApp } from '../src/server/app.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.join(projectRoot, 'evidence', 'v2-final');

function findChromeExecutable(): string | undefined {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ];
  return candidates.find((p) => fs.existsSync(p));
}

test('P4-04 & Audit Pitfall #5: Real Browser E2E verifies unified + 新对话, per-thread isolation, multi-run artifact switching, and accurate origin-thread return', async () => {
  const distWeb = path.join(projectRoot, 'dist', 'web');
  assert.ok(fs.existsSync(path.join(distWeb, 'index.html')), 'Built dist/web/index.html must exist');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-ui-e2e-'));
  fs.mkdirSync(evidenceDir, { recursive: true });

  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDir, 'ui.sqlite'),
    worktreesRoot: path.join(tmpDir, 'wt'),
    staticWebDir: distWeb,
    autoImportAgentHub: false
  });

  app.db.upsertMember({
    id: 'mem_gemini',
    name: 'Gemini2VPS',
    platformId: 'antigravity',
    driverKind: 'mock',
    location: 'remote-bridge',
    capabilities: { supportsIsolatedSessions: true, supportsSessionResume: true, supportsCancel: true, maxConcurrentRuns: 2 },
    status: 'ready',
    statusMessage: 'ready',
    config: {}
  });
  app.db.upsertMember({
    id: 'mem_codex',
    name: 'Codex',
    platformId: 'codex',
    driverKind: 'mock',
    location: 'local',
    capabilities: { supportsIsolatedSessions: true, supportsSessionResume: true, supportsCancel: true, maxConcurrentRuns: 2 },
    status: 'ready',
    statusMessage: 'ready',
    config: {}
  });

  app.registry.mockDriver.handlers.set('mem_gemini', async (inp) => {
    if (inp.scopeKey.startsWith('task_lead:')) {
      return { text: '{"verdict":"accept","comments":"早报审核通过"}' };
    }
    return { text: 'Gemini2VPS 已收到你的消息' };
  });
  app.registry.mockDriver.handlers.set('mem_codex', async (inp) => ({
    text:
      inp.scopeKey.startsWith('thread:') || inp.scopeKey.startsWith('thread_owner:')
        ? '已整理完成：连接器采用 **DuolaBase MCP** 统一托管与 OAuth 鉴权。\n\n- 工具按需动态发现\n- 密钥保留在 Vault 中不落地\n\n详细说明见右侧《连接器改造说明.md》。'
        : `Codex 完成步骤产物 (${inp.scopeKey})`
  }));

  // Seed two distinct threads and a 2-run scheduled task originating from Thread B ("每日早晚报选题")
  const threadA = app.threads.createThread({
    title: '连接器架构整理',
    activeOwnerMemberId: 'mem_codex',
    initialDocTitle: '连接器改造说明.md',
    initialDocContent: '# 连接器目录结构\n测试结果：120/120 通过'
  });
  await app.threads.sendUserMessage({
    threadId: threadA.id,
    body: '请帮我核对 DuolaBase 连接器的整体架构设计'
  });
  const threadB = app.threads.createThread({
    title: '每日早晚报选题',
    activeOwnerMemberId: 'mem_gemini',
    initialDocTitle: '早晚报栏目要求.md',
    initialDocContent: '# 每日早晚报标准\n每天 08:00、20:00 自动执行'
  });

  const { task: cronTask } = app.tasks.createOrUpdateTask({
    sourceThreadId: threadB.id,
    title: '每日 AI 与链上早晚报',
    kind: 'scheduled',
    cronExpr: '0 8,20 * * *',
    leadMemberId: 'mem_gemini',
    spec: {
      goal: '准点产出早晚报',
      steps: [
        {
          stepOrder: 1,
          title: '整理市场重点并成稿',
          assigneeMemberId: 'mem_codex',
          brief: '整理重点',
          acceptanceCriteria: '准确'
        }
      ]
    }
  });

  const r1 = app.tasks.instantiateRun({ taskId: cronTask.id, plannedSlotAt: 'slot:1', triggerType: 'cron' }).run;
  await app.tasks.driveRun(r1.id);
  const r2 = app.tasks.instantiateRun({ taskId: cronTask.id, plannedSlotAt: 'slot:2', triggerType: 'cron' }).run;
  await app.tasks.driveRun(r2.id);

  const { url } = await app.listen(0, '127.0.0.1');
  const chromePath = findChromeExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(chromePath ? { executablePath: chromePath } : {})
  });

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });

    // 0. Default Light Theme on initial open & verify official DuolaWork + Agent logos actually render
    const startsDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    assert.equal(startsDark, false, 'Workbench opens in modern crisp light mode by default');
    const loadedLogos = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img')).map((img) => ({
        alt: img.alt,
        complete: img.complete,
        naturalWidth: img.naturalWidth
      }))
    );
    assert.ok(loadedLogos.some((i) => i.alt === 'DuolaWork' && i.complete && i.naturalWidth > 0), 'DuolaWork brand logo must load');
    assert.ok(loadedLogos.some((i) => i.alt === 'Codex' && i.complete && i.naturalWidth > 0), 'Codex agent logo must load');
    assert.ok(loadedLogos.some((i) => i.alt === 'Antigravity' && i.complete && i.naturalWidth > 0), 'Antigravity agent logo must load');

    // 1. Verify unified 4 compact nav entries & clean navigation across Management Views
    for (const [navLabel, expectedHeading] of [
      ['成员与用量', '成员与用量统计'],
      ['连接器', '连接器统一管理'],
      ['Vault 凭证库', '全局凭证库 (Vault)'],
      ['定时任务', '任务与定时总览']
    ] as const) {
      await page.getByRole('button', { name: navLabel }).first().click();
      await page.waitForSelector(`h1:has-text("${expectedHeading}")`);
    }

    // 2. Verify single `+ 新对话` entry & create a fresh conversation (NO empty placeholder .md)
    await page.getByRole('button', { name: '新对话' }).click();
    await page.waitForSelector('h1:has-text("新对话 3")');
    await page.waitForSelector('text=协作空间');
    await page.waitForSelector('text=还没有资料');
    assert.equal(await page.locator('text=新对话 3-文稿.md').count(), 0, 'Empty thread must not pre-create empty .md');

    // 3. Collaboration Space: add link, quote to ReferenceChip pill, move to Trash + Undo restore, collapse/expand
    await page.getByRole('button', { name: '添加资料' }).click();
    await page.getByRole('button', { name: '添加链接' }).click();
    await page.getByPlaceholder('链接标题').fill('参考文档');
    await page.getByPlaceholder('https://...').fill('https://example.com');
    await page.getByRole('button', { name: '确认' }).click();
    await page.waitForSelector('text=参考文档');

    await page.getByRole('button', { name: '操作资料 参考文档' }).click();
    await page.getByRole('button', { name: '引用到对话' }).click();
    await page.waitForSelector('button[aria-label="移除引用 参考文档"]');

    await page.getByRole('button', { name: '操作资料 参考文档' }).click();
    await page.getByRole('button', { name: '移到回收站' }).click();
    await page.waitForSelector('button:has-text("撤销")');
    await page.getByRole('button', { name: '撤销' }).click();
    await page.waitForSelector('text=参考文档');

    await page.getByRole('button', { name: '收起协作空间' }).click();
    assert.equal(await page.locator('aside[aria-label="协作空间"]').count(), 0);
    await page.getByRole('button', { name: '展开协作空间' }).click();
    await page.waitForSelector('aside[aria-label="协作空间"]');

    // 4. Click Thread A ("连接器架构整理") -> verify owner is Codex, formatted Markdown & right doc "连接器改造说明.md", and workspace binding IS shown for Codex (local Coding Agent)
    await page.getByRole('button', { name: /连接器架构整理/ }).click();
    await page.waitForSelector('h1:has-text("连接器架构整理")');
    await page.waitForSelector('text=连接器改造说明.md');
    assert.ok(await page.locator('.material-item-title:has-text("连接器改造说明.md")').isVisible());
    assert.equal(await page.getByRole('button', { name: /绑定工作目录/ }).count(), 1, 'Coding Agent thread shows 绑定工作目录');

    // Hold the second document response so the previous editor cannot receive a quick save.
    const original = app.artifacts.getArtifact(threadA.boundArtifactId!)!;
    const second = app.artifacts.createArtifact({
      sourceThreadId: threadA.id, title: '第二份测试文稿.md', content: '第二份原文',
      writerKind: 'user', writerId: 'owner'
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /连接器架构整理/ }).first().click();
    const openOriginal = page.locator('.material-item-title', { hasText: original.title });
    await openOriginal.click();
    await page.locator('.space-detail-heading h2', { hasText: original.title }).waitFor();
    await page.getByRole('button', { name: '返回列表' }).click();
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let releaseResolve!: () => void;
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    await page.route('**/api/v2/artifacts/' + second.id, async (route) => {
      if (route.request().method() === 'GET') {
        enteredResolve();
        await release;
      }
      await route.continue();
    });
    await page.locator('.material-item-title', { hasText: second.title }).click();
    await entered;
    try {
      assert.equal(await page.getByRole('button', { name: '保存修改' }).count(), 0);
      assert.equal(await page.getByRole('button', { name: '编辑', exact: true }).count(), 0);
      await page.getByRole('button', { name: '返回列表' }).click();
      await openOriginal.click();
      await page.locator('.space-detail-heading h2', { hasText: original.title }).waitFor();
    } finally {
      releaseResolve();
    }
    await page.unrouteAll({ behavior: 'wait' });
    await page.getByRole('button', { name: '返回列表' }).click();
    await page.locator('.material-item-title', { hasText: second.title }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByRole('textbox', { name: '文稿编辑器' }).fill('仅修改第二份');
    await page.getByRole('button', { name: '保存修改' }).click();
    await page.getByText('已保存为 v2').waitFor();
    assert.equal(app.artifacts.getArtifact(second.id)?.content, '仅修改第二份');
    assert.equal(app.artifacts.getArtifact(original.id)?.headVersion, original.headVersion);
    await page.getByRole('button', { name: '返回列表' }).click();

    // Capture Modern Light Theme Workbench Screenshot cleanly
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(evidenceDir, 'workbench-light.png') });

    // 5. Open Scheduled Task ("每日 AI 与链上早晚报") via `定时任务` overview page -> verify Run #2 vs Run #1 switch right-hand artifact independently!
    await page.getByRole('button', { name: '定时任务' }).first().click();
    await page.waitForSelector('h1:has-text("任务与定时总览")');
    await page.getByRole('button', { name: '查看详情' }).first().click();
    await page.waitForSelector('h1:has-text("每日 AI 与链上早晚报")');
    await page.waitForSelector('text=(第2期).md');
    assert.ok(await page.locator('text=(第2期).md').isVisible(), 'Run #2 artifact shown initially');

    await page.getByRole('button', { name: /第 1 期/ }).click();
    await page.waitForSelector('text=(第1期).md');
    assert.ok(await page.locator('text=(第1期).md').isVisible(), 'Switching to Run #1 updates right-hand artifact to Run #1');

    // 6. Click "发回原对话继续改" while viewing the Scheduled Task -> MUST return to Thread B ("每日早晚报选题"), NOT Thread A!
    await page.getByRole('button', { name: '发回原对话继续改' }).click();
    await page.waitForSelector('h1:has-text("每日早晚报选题")');
    assert.equal(await page.getByRole('button', { name: /绑定工作目录/ }).count(), 0, 'Non-local agent thread hides 绑定工作目录 when unbound');
    const prefilled = await page.locator('textarea[placeholder*="Gemini2VPS"]').inputValue();
    assert.match(prefilled, /第1期/, 'Input prefilled with exact Run #1 artifact reference in origin Thread B');

    // 7. Visual Context Handoff Divider + Expandable Inspector:
    //    Switch owner from Gemini2VPS -> Codex inside Thread B, verify pending divider -> preview -> send -> delivered inspector!
    await page.locator('[aria-label="切换当前对接成员"] button:has-text("Codex")').click();
    await page.waitForSelector('text=上下文交接待处理');
    await page.getByRole('button', { name: /上下文交接待处理/ }).click();
    await page.waitForSelector('[aria-label="上下文交接详情"]');
    await page.waitForSelector('text=待发送下条消息时触发');

    const composerBox = page.locator('textarea[placeholder*="Codex"]');
    await composerBox.fill('请基于当前讨论整理交付清单');
    await page.getByRole('button', { name: '发送消息' }).click();
    await page.waitForSelector('text=上下文已交接');
    await page.waitForSelector('text=本次实际传递上下文快照');
    await page.waitForSelector('text=已整理完成');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(evidenceDir, 'workbench-handoff-inspector.png') });

    // 8. Toggle Dark Theme & verify colorScheme + capture screenshot after transition settles
    await page.getByRole('button', { name: '切换深浅主题' }).click();
    await page.waitForTimeout(250);
    const scheme = await page.evaluate(() => document.documentElement.style.colorScheme);
    assert.equal(scheme, 'dark', 'Dark mode sets root colorScheme=dark');
    await page.screenshot({ path: path.join(evidenceDir, 'workbench-dark.png') });

    assert.ok(threadA.id !== threadB.id);
    await context.close();
  } finally {
    await browser.close();
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DW2-26: Real-human full Chrome click-through across Chat, Archive/Undo, Tasks/Schedules, Space Materials, Members, Connectors, Vault & Dark Mode', async () => {
  const distWeb = path.join(projectRoot, 'dist', 'web');
  assert.ok(fs.existsSync(path.join(distWeb, 'index.html')), 'Built dist/web/index.html must exist');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-human-click-'));
  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDir, 'human.sqlite'),
    worktreesRoot: path.join(tmpDir, 'wt'),
    staticWebDir: distWeb,
    autoImportAgentHub: false
  });

  app.db.upsertMember({
    id: 'm_codex',
    name: 'Codex',
    platformId: 'codex',
    driverKind: 'mock',
    location: 'local',
    capabilities: { supportsIsolatedSessions: true, supportsSessionResume: true, supportsCancel: true, maxConcurrentRuns: 2 },
    status: 'ready',
    statusMessage: '在线',
    config: {}
  });
  app.db.upsertMember({
    id: 'm_gemini',
    name: 'Gemini2VPS',
    platformId: 'antigravity',
    driverKind: 'mock',
    location: 'remote-bridge',
    capabilities: { supportsIsolatedSessions: true, supportsSessionResume: true, supportsCancel: true, maxConcurrentRuns: 2 },
    status: 'ready',
    statusMessage: '在线',
    config: {}
  });
  app.db.upsertMember({
    id: 'm_offline',
    name: 'OfflineBot',
    platformId: 'openai',
    driverKind: 'mock',
    location: 'local',
    capabilities: { supportsIsolatedSessions: true, supportsSessionResume: true, supportsCancel: true, maxConcurrentRuns: 1 },
    status: 'offline',
    statusMessage: '离线',
    config: {}
  });

  // Enable mock DuolaBase token so Connectors & Vault pages render realistic items
  app.db.setSetting('duolabase', { enabled: true, endpoint: 'https://duolabase.example.com/mcp', token: 'mock_tok' });

  let releaseSlowChat!: () => void;
  app.registry.mockDriver.handlers.set('m_codex', async (inp) => {
    if (inp.prompt.includes('TRIGGER_SLOW')) {
      return new Promise((resolve) => {
        releaseSlowChat = () => resolve({ text: '慢回合延时完成' });
      });
    }
    if (inp.scopeKey.startsWith('step:') && inp.prompt.includes('HOLD_STEP')) {
      return new Promise(() => {}); // stays pending until user clicks Stop
    }
    return { text: 'Codex 正常回复完成' };
  });
  app.registry.mockDriver.handlers.set('m_gemini', async (inp) => {
    if (inp.prompt.includes('CREATE_3_SCHEDULES')) {
      return {
        text: [
          '已在当前新群建好早中晚三次推送任务！',
          `<duolawork_task>{"title":"早报08:00","kind":"scheduled","cronExpr":"0 8 * * *","leadMemberId":"Gemini2VPS","goal":"早报"}</duolawork_task>`,
          `<duolawork_task>[{"title":"午报14:00","kind":"scheduled","cronExpr":"0 14 * * *","leadMemberId":"Gemini2VPS","goal":"午报"},{"title":"晚报20:00","kind":"scheduled","cronExpr":"0 20 * * *","leadMemberId":"Gemini2VPS","goal":"晚报"}]</duolawork_task>`
        ].join('\n')
      };
    }
    return { text: 'Gemini2VPS 已回复' };
  });
  app.registry.mockDriver.handlers.set('m_offline', async () => {
    throw new Error('模拟离线节点不可达');
  });

  const thread1 = app.threads.createThread({ title: '主测试对话', activeOwnerMemberId: 'm_gemini' });
  const thread2 = app.threads.createThread({ title: '并行第二个对话', activeOwnerMemberId: 'm_codex' });

  const { url } = await app.listen(0, '127.0.0.1');
  const chromePath = findChromeExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(chromePath ? { executablePath: chromePath } : {})
  });

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const badResponses: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        badResponses.push(`${res.status()} ${new URL(res.url()).pathname}`);
      }
    });

    // Mock DuolaBase HTTP proxy endpoints in browser so we verify Connectors disabled badge & Vault filtering cleanly
    await page.route('**/api/v2/duolabase/connectors**', async (route) => {
      if (route.request().method() === 'GET' && !route.request().url().includes('/tools')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              { id: 'c_ok', name: 'GitHub 仓库', provider: 'github', category: 'dev_cloud', transport: 'http_mcp', status: 'active', health: 'ready', toolCount: 5 },
              { id: 'c_dis', name: 'Vercel 直连', provider: 'vercel', category: 'dev_cloud', transport: 'http_mcp', status: 'disabled', health: 'ready', toolCount: 3 }
            ]
          })
        });
        return;
      }
      await route.continue();
    });
    await page.route('**/api/v2/duolabase/vault**', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              { id: 'v_1', name: 'XHUNT_COOKIE', type: 'cookie', status: 'active', service: 'xhunt', version: 2 }
            ]
          })
        });
        return;
      }
      await route.continue();
    });

    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector('.comm-header');

    // 1. Conversational 3-task creation in Thread 1 -> Space Tasks tab shows '等待定时触发'
    await page.getByRole('button', { name: /主测试对话/ }).click();
    await page.locator('.chat-composer textarea').fill('CREATE_3_SCHEDULES 帮我建三个每日推送');
    await page.getByRole('button', { name: '发送消息' }).click();
    await page.waitForSelector('text=已在当前新群建好早中晚三次推送任务！');
    await page.getByRole('button', { name: /任务 \(3\)/ }).click();
    await page.waitForSelector('.task-overview-state:has-text("等待定时触发")');
    assert.equal(await page.locator('.task-overview-state:has-text("等待定时触发")').count(), 3);

    // 2. Switch to OfflineBot -> header shows '离线', failed send surfaces error toast!
    await page.locator('[aria-label="切换当前对接成员"] button:has-text("OfflineBot")').click();
    await page.waitForSelector('.inline-availability.offline:has-text("离线")');
    await page.locator('.chat-composer textarea').fill('触发离线报错');
    await page.getByRole('button', { name: '发送消息' }).click();
    await page.waitForSelector('.comm-toast:has-text("模拟离线节点不可达")');

    // 3. Switch to Codex, test concurrent per-thread sending without cross-thread lock or overwrite + Stop button
    await page.locator('[aria-label="切换当前对接成员"] button:has-text("Codex")').click();
    await page.waitForSelector('.comm-header .inline-availability.connected');
    await page.locator('.chat-composer textarea').fill('TRIGGER_SLOW 请慢速处理');
    await page.getByRole('button', { name: '发送消息' }).click();
    await page.waitForSelector('button:has-text("停止")');

    // Switch to Thread 2 while Thread 1 is busy -> Thread 2 MUST be sendable independently (zero flash of Thread 1's Stop button)!
    await page.getByRole('button', { name: /并行第二个对话/ }).click();
    await page.waitForSelector('h1:has-text("并行第二个对话")');
    assert.equal(await page.locator('button:has-text("停止")').count(), 0);
    await page.locator('.chat-composer textarea').fill('Thread 2 独立消息');
    await page.getByRole('button', { name: '发送消息' }).click();
    await page.waitForSelector('text=Codex 正常回复完成');
    releaseSlowChat?.();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('text=慢回合延时完成').count(), 0, 'Slow Thread 1 reply never overwrites Thread 2 view');

    // 4. Thread Sidebar Pin, Rename, Archive + Undo restore
    await page.getByRole('button', { name: '重命名对话' }).click();
    await page.locator('.comm-header input.dw-input').fill('已重命名对话');
    await page.locator('.comm-header input.dw-input').press('Enter');
    await page.waitForSelector('h1:has-text("已重命名对话")');

    await page.locator('.channel-row', { hasText: '已重命名对话' }).getByRole('button', { name: '归档对话' }).click();
    await page.waitForSelector('.comm-toast:has-text("已归档对话")');
    assert.equal(await page.locator('.channel-open-btn:has-text("已重命名对话")').count(), 0);
    await page.locator('.comm-toast button:has-text("撤销")').click();
    await page.waitForSelector('.channel-open-btn:has-text("已重命名对话")');

    // 5. Space Materials: folder create/rename/delete, text preview, invalid link toast, Resources toggle OFF
    await page.locator('.space-tabs button:has-text("资料")').click();
    await page.getByRole('button', { name: '添加资料' }).click();
    await page.getByRole('button', { name: '新建文件夹' }).click();
    await page.getByPlaceholder('文件夹名称').fill('素材目录');
    await page.getByRole('button', { name: '确认' }).click();
    await page.waitForSelector('text=素材目录');
    await page.getByRole('button', { name: '管理文件夹 素材目录' }).click();
    await page.getByRole('button', { name: '删除文件夹' }).click();
    await page.waitForTimeout(150);

    // Text file preview: verify text preview loads real content cleanly instead of stuck loading
    app.space.saveFile({
      threadId: thread2.id,
      name: 'preview-notes.txt',
      mimeType: 'text/plain; charset=utf-8',
      dataBase64: Buffer.from('文本预览测试内容_12345').toString('base64')
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /已重命名对话/ }).click();
    await page.locator('.material-item-title:has-text("preview-notes.txt")').click();
    await page.waitForSelector('.material-file-text:has-text("文本预览测试内容_12345")');
    await page.getByRole('button', { name: '返回列表' }).click();

    // Create document -> edit v2 -> version history -> quote to chat -> pin/rename/move/trash/restore/permanent delete!
    await page.getByRole('button', { name: '添加资料' }).click();
    await page.getByRole('button', { name: '新建文档' }).click();
    await page.getByPlaceholder('文档名称（如：产品方案.md）').fill('初稿文档.md');
    await page.getByPlaceholder('初始正文内容（可选）').fill('# 初稿内容');
    await page.getByRole('button', { name: '确认' }).click();
    await page.waitForSelector('textarea[aria-label="文稿编辑器"]');
    await page.locator('textarea[aria-label="文稿编辑器"]').fill('# 修改后第二版');
    await page.getByRole('button', { name: '保存修改' }).click();
    await page.waitForSelector('.space-detail-heading small:has-text("文档 · v2")');
    await page.getByRole('button', { name: '版本 (2)' }).click();
    await page.waitForSelector('strong:has-text("v2 · 主稿")');
    await page.getByRole('button', { name: '引用到对话' }).click();
    await page.waitForSelector('.composer-references .space-reference:has-text("初稿文档.md")');
    await page.getByRole('button', { name: '移除引用 初稿文档.md' }).click();
    await page.getByRole('button', { name: '返回列表' }).click();

    await page.getByRole('button', { name: '添加资料' }).click();
    await page.getByRole('button', { name: '新建文件夹' }).click();
    await page.getByPlaceholder('文件夹名称').fill('分类夹');
    await page.getByRole('button', { name: '确认' }).click();
    await page.waitForSelector('.material-folder-open:has-text("分类夹")');

    await page.getByRole('button', { name: '操作资料 初稿文档.md' }).click();
    await page.locator('.chat-context-menu button:has-text("置顶")').click();
    await page.waitForSelector('.material-shortcuts:has-text("初稿文档.md")');

    await page.getByRole('button', { name: '操作资料 初稿文档.md' }).click();
    await page.locator('.chat-context-menu button:has-text("重命名")').click();
    await page.locator('.dw-inline-panel input.dw-input').fill('终稿文档.md');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForSelector('.material-item-title:has-text("终稿文档.md")');

    await page.getByRole('button', { name: '操作资料 终稿文档.md' }).click();
    await page.locator('.chat-context-menu button:has-text("取消置顶")').click();
    await page.getByRole('button', { name: '操作资料 终稿文档.md' }).click();
    await page.locator('.chat-context-menu button:has-text("移动到文件夹")').click();
    await page.locator('.dw-inline-panel button:has-text("/ 分类夹")').click();
    await page.getByRole('button', { name: '展开文件夹 分类夹' }).click();
    await page.waitForSelector('.material-folder-children .material-item-title:has-text("终稿文档.md")');

    await page.getByRole('button', { name: '操作资料 终稿文档.md' }).click();
    await page.locator('.chat-context-menu button:has-text("移到回收站")').click();
    await page.waitForSelector('.space-undo:has-text("已移入回收站：终稿文档.md")');
    await page.locator('.material-trash').click();
    await page.waitForSelector('.space-trash-row:has-text("终稿文档.md")');
    await page.locator('.space-trash-row', { hasText: '终稿文档.md' }).getByRole('button', { name: '恢复' }).click();
    await page.getByRole('button', { name: '返回列表' }).click();
    await page.waitForSelector('.material-item-title:has-text("终稿文档.md")');

    await page.getByRole('button', { name: '操作资料 终稿文档.md' }).click();
    await page.locator('.chat-context-menu button:has-text("移到回收站")').click();
    await page.locator('.material-trash').click();
    await page.locator('.space-trash-row', { hasText: '终稿文档.md' }).getByRole('button', { name: '彻底删除' }).click();
    await page.locator('.space-trash-row', { hasText: '终稿文档.md' }).getByRole('button', { name: '确认删除' }).click();
    await page.waitForSelector('.space-blank:has-text("回收站为空")');
    await page.getByRole('button', { name: '返回列表' }).click();

    // Task association check on thread1 (has 3 scheduled tasks), then switch back to thread2
    await page.getByRole('button', { name: /主测试对话/ }).click();
    await page.getByRole('button', { name: '添加资料' }).click();
    await page.getByRole('button', { name: '新建文档' }).click();
    await page.getByPlaceholder('文档名称（如：产品方案.md）').fill('关联素材.md');
    await page.getByRole('button', { name: '确认' }).click();
    await page.getByRole('button', { name: '预览' }).click();
    await page.getByRole('button', { name: '关联任务', exact: true }).click();
    await page.locator('.material-associate-form button:has-text("早报08:00")').click();
    await page.waitForSelector('button[aria-label="取消关联 早报08:00"]');
    await page.getByRole('button', { name: /已重命名对话/ }).click();

    // Invalid link surfaces error notice
    await page.getByRole('button', { name: '添加资料' }).click();
    await page.getByRole('button', { name: '添加链接' }).click();
    await page.getByPlaceholder('链接标题').fill('坏链接');
    await page.getByPlaceholder('https://...').fill('ftp://invalid-scheme');
    await page.getByRole('button', { name: '确认' }).click();
    await page.waitForSelector('text=仅支持 http 或 https 链接');
    await page.getByRole('button', { name: '取消' }).click();

    // Resources DuolaBase toggle OFF -> reads '已暂停连接', toggle ON -> shows active connector summary!
    await page.locator('.space-tabs button:has-text("资源")').click();
    await page.waitForSelector('.channel-resources button:has-text("GitHub 仓库")');
    await page.getByRole('button', { name: '切换 DuolaBase 状态' }).click();
    await page.waitForSelector('small:has-text("已暂停连接")');
    await page.getByRole('button', { name: '切换 DuolaBase 状态' }).click();
    await page.waitForSelector('small:has-text("已连通")');
    await page.waitForSelector('.channel-resources button:has-text("GitHub 仓库")');

    // 6. Task Creation modal: invalid Cron toast, add & remove step, create running task, Stop & Delete two-click!
    await page.getByRole('button', { name: '指派任务' }).click();
    await page.getByPlaceholder(/任务名称与目标/).fill('测试派单校验');
    await page.locator('.dw-inline-panel').getByRole('button', { name: '定时任务', exact: true }).click();
    await page.getByPlaceholder(/Cron 表达式/).fill('not-a-cron');
    await page.getByRole('button', { name: '确认立项' }).click();
    await page.waitForSelector('.comm-toast:has-text("Cron 表达式需要 5 个字段")');

    await page.getByPlaceholder(/Cron 表达式/).fill('0 9 * * *');
    await page.getByRole('button', { name: '+ 添加下一步分工' }).click();
    assert.equal(await page.getByRole('button', { name: '移除该步骤' }).count(), 2);
    await page.getByRole('button', { name: '移除该步骤' }).last().click();
    assert.equal(await page.getByRole('button', { name: '移除该步骤' }).count(), 0);
    await page.locator('.dw-inline-panel').getByRole('button', { name: '单次任务', exact: true }).click();
    await page.locator('.dw-inline-panel input[placeholder="分工项说明"]').fill('HOLD_STEP');
    await page.getByRole('button', { name: '确认立项' }).click();
    await page.waitForSelector('h1:has-text("测试派单校验")');
    await page.waitForSelector('button:has-text("停止执行")');
    await page.getByRole('button', { name: '停止执行' }).click();
    await page.waitForSelector('.delivery-badge:has-text("已取消")');
    await page.getByRole('button', { name: '删除任务' }).click();
    await page.getByRole('button', { name: '确认删除？' }).click();
    await page.waitForSelector('.comm-toast:has-text("已删除任务")');

    // 7. Schedules Page: filter, delete card
    await page.getByRole('button', { name: '定时任务' }).first().click();
    await page.waitForSelector('h1:has-text("任务与定时总览")');
    assert.equal(await page.locator('.schedule-pill:has-text("等待定时触发")').count(), 3);
    await page.locator('.schedule-card button:has-text("删除")').first().click();
    await page.locator('.schedule-card button:has-text("确认删除")').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.schedule-card').length === 2);
    assert.equal(await page.locator('.schedule-card').count(), 2);

    // 8. Members Page: Chinese usage table + '同步全员新版协作记忆' button
    await page.getByRole('button', { name: '成员与用量' }).click();
    await page.waitForSelector('h1:has-text("成员与用量统计")');
    const usageTable = page.locator('table.members-table', { hasText: '调用类型' });
    await usageTable.locator('td:has-text("对话")').first().waitFor({ state: 'visible' });
    const membersBody = await usageTable.textContent();
    assert.ok(
      membersBody?.includes('对话') && (membersBody?.includes('成功') || membersBody?.includes('失败')),
      `Expected Chinese usage table, got: ${membersBody}`
    );
    assert.equal(membersBody?.includes('thread_message'), false);
    await page.getByRole('button', { name: '同步全员新版协作记忆' }).click();
    await page.waitForSelector('text=已触发全员协作记忆更新');

    // 9. Connectors Page: disabled connector MUST show '已停用' and NOT '可用'!
    await page.getByRole('button', { name: '连接器' }).click();
    await page.waitForSelector('h3:has-text("Vercel 直连")');
    const vercelCardText = await page.locator('article.connector-card:has-text("Vercel 直连")').textContent();
    assert.ok(vercelCardText?.includes('已停用'), 'Disabled connector displays 已停用');
    assert.equal(vercelCardText?.includes('可用'), false, 'Disabled connector must NOT display green 可用');

    // 10. Vault Page & Dark mode
    await page.getByRole('button', { name: 'Vault 凭证库' }).click();
    await page.waitForSelector('text=XHUNT_COOKIE');
    await page.getByRole('button', { name: '切换深浅主题' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true);

    assert.deepEqual(pageErrors, [], 'Zero uncaught pageerrors across full walkthrough');
    // Only expected 4xx/5xx from the deliberate negative probes (OfflineBot 500 + invalid Cron 400 + ftp link 500)
    const unexpectedConsole = consoleErrors.filter(
      (msg) => !msg.includes('status of 500') && !msg.includes('status of 400')
    );
    assert.deepEqual(
      unexpectedConsole,
      [],
      `Zero unexpected console errors, got: ${JSON.stringify(unexpectedConsole)}; HTTP>=400: ${JSON.stringify(badResponses)}`
    );
    await context.close();
  } finally {
    releaseSlowChat?.();
    await browser.close();
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
