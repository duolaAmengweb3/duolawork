import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DuolaWorkApp } from '../src/server/app.js';
import { MockDriver } from '../src/server/drivers/mock-driver.js';
import { DuolaWorkNodeRunner } from '../src/node-runner/index.js';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('SPACE-AGENT-01: Scoped agent space tools create nested folders, save arbitrary files (UTF-8/base64/localPath), update docs, move items, and enforce thread isolation', async () => {
  const tmpDir = createTempDir('dw2-space-agent-');
  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDir, 'space.sqlite'),
    filesDir: path.join(tmpDir, 'files'),
    lockFilePath: path.join(tmpDir, 'server.lock'),
    autoImportAgentHub: false
  });

  const localBinPath = path.join(tmpDir, 'generated-chart.png');
  fs.writeFileSync(localBinPath, Buffer.from(TINY_PNG_BASE64, 'base64'));

  try {
    app.db.upsertMember({
      id: 'mem_agent_space',
      name: 'MockSpaceAgent',
      platformId: 'mock',
      driverKind: 'mock',
      location: 'local',
      capabilities: {
        supportsIsolatedSessions: true,
        supportsSessionResume: true,
        supportsCancel: true,
        maxConcurrentRuns: 2
      },
      status: 'ready',
      statusMessage: '就绪',
      config: {}
    });

    const threadA = app.threads.createThread({ title: '空间测试 A', workspacePath:tmpDir, activeOwnerMemberId: 'mem_agent_space' });
    const threadB = app.threads.createThread({ title: '空间测试 B', activeOwnerMemberId: 'mem_agent_space' });
    const foreignDoc = app.space.createDocument({ threadId: threadB.id, title: '机密.md', content: 'Secret' });

    app.registry.mockDriver.handlers.set('mem_agent_space', async (input) => {
      assert.ok(input.onToolCall, 'mock turn should expose onToolCall');
      // 1. Create nested folder path (idempotent)
      const f1 = (await input.onToolCall!('space_create_folder', {
        path: '调研素材/2026-11/图表'
      })) as any;
      assert.equal(f1.ok, true);
      assert.equal(f1.path, '调研素材/2026-11/图表');

      const f1Again = (await input.onToolCall!('space_create_folder', {
        path: '调研素材/2026-11/图表'
      })) as any;
      assert.equal(f1Again.folder.id, f1.folder.id, 'idempotent nested folder creation');

      // 2. Save UTF-8 CSV file into nested folder
      const csvRes = (await input.onToolCall!('space_save_file', {
        name: 'metrics.csv',
        content: 'date,views\n2026-11-27,1280\n',
        folderPath: '调研素材/2026-11'
      })) as any;
      assert.equal(csvRes.ok, true);
      assert.match(csvRes.mimeType, /^text\/csv/);
      assert.equal(csvRes.folderPath, '调研素材/2026-11');

      // 3. Save binary PNG file via localPath into Charts folder
      const pngRes = (await input.onToolCall!('space_save_file', {
        name: 'trend.png',
        localPath: localBinPath,
        folderPath: '调研素材/2026-11/图表'
      })) as any;
      assert.equal(pngRes.ok, true);
      assert.equal(pngRes.mimeType, 'image/png');
      assert.equal(pngRes.sizeBytes, Buffer.from(TINY_PNG_BASE64, 'base64').length);

      // 4. Save Markdown doc inside folder, then update it in place
      const docV1 = (await input.onToolCall!('space_save_document', {
        title: '周报.md',
        content: '# 第一版',
        folderPath: '调研素材'
      })) as any;
      assert.equal(docV1.created, true);
      assert.equal(docV1.version, 1);

      const docV2 = (await input.onToolCall!('space_save_document', {
        title: '周报.md',
        content: '# 第二版更新',
        folderPath: '调研素材'
      })) as any;
      await input.onToolCall!('space_read_material', {kind:'document', id:docV2.id});
      const human = app.artifacts.writeArtifact({artifactId:docV2.id, expectedBaseVersion:docV2.version, content:'人工编辑', writerKind:'user', writerId:'owner'});
      await assert.rejects(input.onToolCall!('space_save_document', {documentId:docV2.id, title:'周报.md',content:'旧稿'}), /文档已更新/);
      assert.equal(app.artifacts.getArtifact(docV2.id)?.headVersion,human.artifact.headVersion);
      assert.equal(docV2.created, false);
      assert.equal(docV2.id, docV1.id);
      assert.equal(docV2.version, 2);

      // 5. Save link & move CSV to Charts folder
      const lnk = (await input.onToolCall!('space_save_link', {
        title: '参考站点',
        url: 'https://example.com/report',
        note: '原始来源',
        folderPath: '调研素材'
      })) as any;
      assert.equal(lnk.ok, true);

      const moved = (await input.onToolCall!('space_move_item', {
        kind: 'file',
        id: csvRes.id,
        folderPath: '调研素材/2026-11/图表'
      })) as any;
      assert.equal(moved.folderPath, '调研素材/2026-11/图表');

      // 6. Cross-thread move MUST be rejected
      await assert.rejects(
        () => input.onToolCall!('space_move_item', { kind: 'document', id: foreignDoc.id, folderPath: '偷取' }),
        /不存在或不属于当前对话/
      );

      // 7. List materials returns folders with paths and items with folderPath
      const listed = (await input.onToolCall!('space_list_materials', {})) as any;
      assert.equal(listed.folders.length, 3);
      assert.ok(listed.items.some((it: any) => it.title === 'trend.png' && it.folderPath === '调研素材/2026-11/图表'));
      assert.ok(listed.items.some((it: any) => it.title === 'metrics.csv' && it.folderPath === '调研素材/2026-11/图表'));

      return { text: '已全部归档完成' };
    });

    const out = await app.threads.sendUserMessage({
      threadId: threadA.id,
      body: '帮我整理素材并存到对应文件夹'
    });
    assert.equal(out.agentMessage.turnStatus, 'completed');

    const spaceA = app.space.listSpace(threadA.id);
    assert.equal(spaceA.folders.length, 3);
    assert.equal(spaceA.items.length, 4);
    const pngItem = spaceA.items.find((i) => i.title === 'trend.png');
    assert.ok(pngItem && pngItem.previewKind === 'image');
    const diskFile = app.space.getFileWithPath(pngItem.id);
    assert.ok(diskFile && fs.readFileSync(diskFile.absPath).equals(Buffer.from(TINY_PNG_BASE64, 'base64')));
  } finally {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SPACE-AGENT-02: Universal inline tags (<duolawork_folder>, <duolawork_file>, <duolawork_artifact folder>, <duolawork_link>) work for all drivers idempotently', async () => {
  const tmpDir = createTempDir('dw2-space-inline-');
  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDir, 'inline.sqlite'),
    filesDir: path.join(tmpDir, 'files'),
    lockFilePath: path.join(tmpDir, 'server.lock'),
    autoImportAgentHub: false
  });

  try {
    app.db.upsertMember({
      id: 'mem_inline',
      name: 'InlineAgent',
      platformId: 'mock',
      driverKind: 'mock',
      location: 'local',
      capabilities: {
        supportsIsolatedSessions: true,
        supportsSessionResume: true,
        supportsCancel: true,
        maxConcurrentRuns: 2
      },
      status: 'ready',
      statusMessage: '就绪',
      config: {}
    });

    const thread = app.threads.createThread({ title: '内联标签测试', activeOwnerMemberId: 'mem_inline' });

    app.registry.mockDriver.handlers.set('mem_inline', async () => ({
      text: [
        '已完成归档，所有资料已保存到对应文件夹。',
        '<duolawork_folder path="交付包/空目录" />',
        '<duolawork_file name="summary.json" folder="交付包/数据" mime="application/json">{"ok":true,"rows":42}</duolawork_file>',
        `<duolawork_file name="pixel.png" folder="交付包/图片" encoding="base64">${TINY_PNG_BASE64}</duolawork_file>`,
        '<duolawork_artifact title="执行总结.md" folder="交付包">## 总结\n全部完成</duolawork_artifact>',
        '<duolawork_link title="文档站" url="https://work.manyaitool.com" folder="交付包">工作台入口</duolawork_link>'
      ].join('\n')
    }));

    const out = await app.threads.sendUserMessage({
      threadId: thread.id,
      body: '生成交付包'
    });
    assert.equal(out.agentMessage.body, '已完成归档，所有资料已保存到对应文件夹。');

    const space = app.space.listSpace(thread.id);
    assert.ok(space.folders.some((f) => app.space.getFolderPath(thread.id, f.id) === '交付包/空目录'));
    assert.ok(space.folders.some((f) => app.space.getFolderPath(thread.id, f.id) === '交付包/数据'));
    assert.ok(space.folders.some((f) => app.space.getFolderPath(thread.id, f.id) === '交付包/图片'));

    const jsonFile = space.items.find((i) => i.title === 'summary.json');
    assert.ok(jsonFile && jsonFile.kind === 'file');
    const jsonDisk = app.space.getFileWithPath(jsonFile.id);
    assert.equal(fs.readFileSync(jsonDisk!.absPath, 'utf8'), '{"ok":true,"rows":42}');

    const pngFile = space.items.find((i) => i.title === 'pixel.png');
    assert.ok(pngFile && pngFile.previewKind === 'image');

    const docItem = space.items.find((i) => i.title === '执行总结.md');
    assert.ok(docItem && app.space.getFolderPath(thread.id, docItem.folderId) === '交付包');

    const example = ['~~~~markdown','<duolawork_file name="example.txt">demo</duolawork_file>', '~~~~'].join('\n');
    app.registry.mockDriver.handlers.set('mem_inline', async () => ({text:example}));
    const documented = await app.threads.sendUserMessage({threadId: thread.id, body:'给出文档示例'});
    assert.equal(documented.agentMessage.body, example);
    assert.ok(!app.space.listSpace(thread.id).items.some(it => it.title === 'example.txt'));
    const linkItem = space.items.find((i) => i.title === '文档站');
    assert.ok(linkItem && linkItem.url === 'https://work.manyaitool.com');
  } finally {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SPACE-AGENT-03: Remote ExecutionNodeRunner hydrates localPath and transfers binary/text files to Cloud Space', async () => {
  const tmpDir = createTempDir('dw2-space-node-');
  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDir, 'cloud.sqlite'),
    filesDir: path.join(tmpDir, 'files'),
    lockFilePath: path.join(tmpDir, 'server.lock'),
    autoImportAgentHub: false
  });

  const remoteFilePath = path.join(tmpDir, 'vps-output.csv');
  fs.writeFileSync(remoteFilePath, 'symbol,score\nSOL,98\n', 'utf8');

  let runner: DuolaWorkNodeRunner | null = null;
  try {
    const { url } = await app.listen(0, '127.0.0.1');
    const pairCodeRes = await fetch(`${url}/api/v2/nodes/pair-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'VPS-Test-Node', kind: 'cloud' })
    }).then((r) => r.json() as Promise<{ code: string }>);

    const paired = await fetch(`${url}/api/v2/nodes/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: pairCodeRes.code,
        name: 'VPS-Test-Node',
        kind: 'cloud',
        platform: 'linux'
      })
    }).then((r) => r.json() as Promise<{ nodeToken: string }>);

    const uploads: string[] = [];
    app.setExternalMcpCaller(async (tool, payload) => {
      assert.equal(tool, 'connector_call');
      assert.equal(payload.toolName, 'upload');
      const params = payload.arguments as { base64: string; filename: string };
      assert.equal(params.filename, 'vps-output.csv');
      assert.deepEqual(Buffer.from(params.base64, 'base64'), fs.readFileSync(remoteFilePath));
      uploads.push(String(payload.requestId));
      return { status: 'succeeded', id: 'file-receipt' };
    });
    const nodeMock = new MockDriver();
    nodeMock.handlers.set('mem_remote_space', async (input) => {
      const folderOut = (await input.onToolCall!('space_create_folder', {
        path: '远端产物/日报'
      })) as any;
      assert.equal(folderOut.ok, true);

      const fileOut = (await input.onToolCall!('space_save_file', {
        name: 'vps-output.csv',
        localPath: remoteFilePath,
        folderPath: '远端产物/日报'
      })) as any;
      assert.equal(fileOut.ok, true);
      assert.equal(fileOut.folderPath, '远端产物/日报');

      const args = { connectorId:'test-connector', toolName:'upload', fileId:fileOut.id, base64Field:'base64', arguments:{ filename:'vps-output.csv' } };
      for (let i=0; i<2; i++) {
        assert.deepEqual(await input.onToolCall!('space_upload_to_connector', args), {status:'succeeded', id:'file-receipt'});
      }
      assert.equal(uploads.length, 2);
      assert.equal(uploads[0], uploads[1]);
      await assert.rejects(input.onToolCall!('space_upload_to_connector', { ...args, fileId:'missing' }), /可用文件/);
      return { text: '远端节点文件已上传到协作空间' };
    });

    runner = new DuolaWorkNodeRunner({
      serverUrl: url,
      nodeToken: paired.nodeToken,
      name: 'VPS-Test-Node',
      kind: 'cloud',
      outboxPath: path.join(tmpDir, 'outbox.json'),
      mockDriver: nodeMock,
      members: [
        {
          id: 'mem_remote_space',
          name: 'RemoteSpaceBot',
          platformId: 'gemini',
          localDriverKind: 'mock',
          status: 'ready'
        }
      ]
    });
    await runner.start();

    const thread = app.threads.createThread({
      title: '远端节点写空间测试', workspacePath:tmpDir,
      activeOwnerMemberId: 'mem_remote_space'
    });
    const out = await app.threads.sendUserMessage({
      threadId: thread.id,
      body: '把远端文件存到协作空间'
    });
    assert.equal(out.agentMessage.turnStatus, 'completed');

    const space = app.space.listSpace(thread.id);
    const savedCsv = space.items.find((i) => i.title === 'vps-output.csv');
    assert.ok(savedCsv, 'remote CSV file should be saved to cloud space');
    assert.equal(app.space.getFolderPath(thread.id, savedCsv.folderId), '远端产物/日报');
    const disk = app.space.getFileWithPath(savedCsv.id);
    assert.equal(fs.readFileSync(disk!.absPath, 'utf8'), 'symbol,score\nSOL,98\n');
  } finally {
    runner?.stop();
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SPACE-UI-04: Two-section Collaboration Space UI sorts top section by updatedAt DESC (saved or edited) and drills into/back out of nested folders in bottom manager', async () => {
  const { chromium } = await import('playwright');
  const tmpDir = createTempDir('dw2-space-ui-');
  const staticWebDir = path.resolve(process.cwd(), 'dist', 'web');
  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDir, 'ui.sqlite'),
    filesDir: path.join(tmpDir, 'files'),
    lockFilePath: path.join(tmpDir, 'server.lock'),
    staticWebDir,
    autoImportAgentHub: false
  });

  const chromeCandidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ];
  const executablePath = chromeCandidates.find((p) => fs.existsSync(p));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    app.db.upsertMember({
      id: 'mem_ui_space',
      name: 'Gemini2VPS',
      platformId: 'gemini',
      driverKind: 'mock',
      location: 'local',
      capabilities: {
        supportsIsolatedSessions: true,
        supportsSessionResume: true,
        supportsCancel: true,
        maxConcurrentRuns: 2
      },
      status: 'ready',
      statusMessage: '就绪',
      config: {}
    });

    const thread = app.threads.createThread({
      title: '资料区双分区验证',
      activeOwnerMemberId: 'mem_ui_space'
    });
    const fParent = app.space.ensureFolderPath(thread.id, '研究归档');
    const fChild = app.space.ensureFolderPath(thread.id, '研究归档/图表');

    const olderDoc = app.space.createDocument({
      threadId: thread.id,
      title: '较早文档.md',
      content: '# 较早版本',
      folderId: fChild.id
    });
    // Backdate olderDoc so newerCsv clearly starts ahead of it
    app.db.sqlite
      .prepare(`UPDATE v2_artifacts SET created_at = '2026-11-26T08:00:00.000Z', updated_at = '2026-11-26T08:00:00.000Z' WHERE id = ?`)
      .run(olderDoc.id);

    app.space.saveOrUpdateFileForAgent({
      threadId: thread.id,
      name: 'latest-data.csv',
      content: 'a,b\n1,2\n',
      folderId: fParent.id
    });

    const { url } = await app.listen(0, '127.0.0.1');
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.getByTestId('space-recent-section').waitFor();

    // 1. Top chronological section: latest-data.csv MUST appear before 较早文档.md
    const initialOrder = await page
      .getByTestId('space-recent-section')
      .locator('.material-row')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-item-id')));
    assert.equal(initialOrder.length, 2);
    assert.notEqual(initialOrder[0], olderDoc.id, 'newer CSV should be first initially');

    // 2. Bottom Document Manager: drill into 研究归档 -> 图表 -> verify 较早文档.md -> back -> root
    const manager = page.getByTestId('space-manager-section');
    await manager.locator('.material-folder-open', { hasText: '研究归档' }).click();
    await page.getByTestId('space-folder-nav').waitFor();
    await manager.locator('.material-item-title', { hasText: 'latest-data.csv' }).waitFor();
    await manager.locator('.material-folder-open', { hasText: '图表' }).click();
    await manager.locator('.material-item-title', { hasText: '较早文档.md' }).waitFor();

    // Edit 较早文档.md -> save -> return to list -> verify 较早文档.md jumps to #1 in Top Chronological Section!
    await manager.locator('.material-item-title', { hasText: '较早文档.md' }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('textarea[aria-label="文稿编辑器"]').fill('# 刚刚编辑后的最新版本');
    await page.getByRole('button', { name: '保存修改' }).click();
    await page.waitForSelector('.space-detail-heading small:has-text("文档 · v2")');
    await page.getByRole('button', { name: '返回列表' }).click();

    const updatedOrder = await page
      .getByTestId('space-recent-section')
      .locator('.material-row')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-item-id')));
    assert.equal(updatedOrder[0], olderDoc.id, 'newly edited nested document MUST jump to #1 in chronological recent section');

    // Navigate back up one level (图表 -> 研究归档) and then back to 根目录
    await page.getByRole('button', { name: '返回上一级文件夹' }).click();
    await manager.locator('.material-folder-open', { hasText: '图表' }).waitFor();
    await page.getByRole('button', { name: '根目录' }).click();
    await manager.locator('.material-folder-open', { hasText: '研究归档' }).waitFor();
    assert.equal(await page.getByTestId('space-folder-nav').count(), 0);
  } finally {
    await browser.close();
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SPACE-IMG-05: Bidirectional chat images (user send -> agent multimodal receipt -> agent chat_attach_image -> UI Save to Space & Download Local + SSRF guard)', async () => {
  const { chromium } = await import('playwright');
  const tmpDir = createTempDir('dw2-chat-img-');
  const staticWebDir = path.resolve(process.cwd(), 'dist', 'web');
  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDir, 'img.sqlite'),
    filesDir: path.join(tmpDir, 'files'),
    lockFilePath: path.join(tmpDir, 'server.lock'),
    staticWebDir,
    autoImportAgentHub: false
  });

  const userPngPath = path.join(tmpDir, 'user-shot.png');
  const agentPngPath = path.join(tmpDir, 'agent-chart.png');
  const pngBytes = Buffer.from(TINY_PNG_BASE64, 'base64');
  fs.writeFileSync(userPngPath, pngBytes);
  fs.writeFileSync(agentPngPath, pngBytes);

  const chromeCandidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ];
  const executablePath = chromeCandidates.find((p) => fs.existsSync(p));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

  try {
    app.db.upsertMember({
      id: 'mem_img_agent',
      name: 'Gemini2VPS',
      platformId: 'gemini',
      driverKind: 'mock',
      location: 'local',
      capabilities: {
        supportsIsolatedSessions: true,
        supportsSessionResume: true,
        supportsCancel: true,
        maxConcurrentRuns: 2
      },
      status: 'ready',
      statusMessage: '就绪',
      config: {}
    });

    const thread = app.threads.createThread({
      title: '对话图片双向测试', workspacePath:tmpDir,
      activeOwnerMemberId: 'mem_img_agent'
    });

    let agentSawImageCount = 0;
    let agentAttachedUrl = '';
    app.registry.mockDriver.handlers.set('mem_img_agent', async (input) => {
      agentSawImageCount = input.images?.length ?? 0;
      const attached = (await input.onToolCall!('chat_attach_image', {
        name: 'agent-chart.png',
        localPath: agentPngPath,
        alt: '分析结果图表'
      })) as any;
      assert.equal(attached.ok, true);
      agentAttachedUrl = attached.url;
      return {
        text: `已收到你发的图片，这是我生成的图表：\n\n${attached.markdownEmbed}`
      };
    });

    const { url } = await app.listen(0, '127.0.0.1');

    // SSRF guard: private loopback URL must be rejected
    const ssrfRes = await fetch(`${url}/api/v2/threads/${encodeURIComponent(thread.id)}/space/import-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: 'http://127.0.0.1:8780/secret.png' })
    });
    assert.ok(ssrfRes.status >= 400, 'private IP image import must be rejected');

    const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
    await page.goto(url, { waitUntil: 'networkidle' });

    // 1. User picks an image in the chat composer, sees thumbnail preview, and sends with text
    await page.locator('input[type="file"][accept="image/*"]').setInputFiles(userPngPath);
    await page.getByTestId('composer-image-strip').waitFor();
    await page.locator('.chat-composer textarea').fill('帮我看看这张图并画张新图');
    await page.getByRole('button', { name: '发送消息' }).click();

    // 2. Wait for both user image card and agent generated image card to render
    await page.locator('[data-testid="chat-image-card"] img[alt="分析结果图表"]').waitFor({ timeout: 10_000 });
    assert.equal(agentSawImageCount, 1, 'Agent must receive multimodal image attachment');
    const cardCount = await page.getByTestId('chat-image-card').count();
    assert.equal(cardCount, 2, 'Both user-sent and agent-generated images must render as image cards');

    // 3. Click "保存到资料区" on the Agent's generated image card -> verify it lands in Space
    const agentCard = page.getByTestId('chat-image-card').nth(1);
    await agentCard.getByRole('button', { name: /查看大图/ }).click();
    const preview = page.getByRole('dialog', { name: '大图预览' });
    await preview.waitFor();
    assert.ok(await preview.locator('img').evaluate(async img => {
      if (!(img instanceof HTMLImageElement)) return false;
      await img.decode();
      return img.naturalWidth > 0;
    }));
    await preview.getByRole('button', { name: '关闭大图预览' }).click();
    await agentCard.getByRole('button', { name: '保存到资料区' }).click();
    await agentCard.getByRole('button', { name: '已存入资料区' }).waitFor({ timeout: 5000 });

    const space = app.space.listSpace(thread.id);
    assert.ok(space.items.some((i) => i.kind === 'file' && i.previewKind === 'image'));

    // 4. Verify "保存到本地" download endpoint returns attachment header + exact PNG bytes
    const dlRes = await fetch(`${url}${agentAttachedUrl}?download=1`);
    assert.equal(dlRes.status, 200);
    assert.match(dlRes.headers.get('content-disposition') || '', /attachment/i);
    assert.ok(Buffer.from(await dlRes.arrayBuffer()).equals(pngBytes));
  } finally {
    await browser.close();
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SPACE-REF-06: Clickable file, folder, and bare URL references in chat jump straight to the target in Collaboration Space', async () => {
  const { chromium } = await import('playwright');
  const tmpDir = createTempDir('dw2-space-refs-');
  const staticWebDir = path.resolve(process.cwd(), 'dist', 'web');
  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDir, 'refs.sqlite'),
    filesDir: path.join(tmpDir, 'files'),
    lockFilePath: path.join(tmpDir, 'server.lock'),
    staticWebDir,
    autoImportAgentHub: false
  });

  const chromeCandidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ];
  const executablePath = chromeCandidates.find((p) => fs.existsSync(p));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

  try {
    app.db.upsertMember({
      id: 'mem_ref_agent',
      name: 'Gemini2VPS',
      platformId: 'gemini',
      driverKind: 'mock',
      location: 'local',
      capabilities: {
        supportsIsolatedSessions: true,
        supportsSessionResume: true,
        supportsCancel: true,
        maxConcurrentRuns: 2
      },
      status: 'ready',
      statusMessage: '就绪',
      config: {}
    });

    const thread = app.threads.createThread({
      title: '对话文件直达验证',
      activeOwnerMemberId: 'mem_ref_agent'
    });
    const fParent = app.space.ensureFolderPath(thread.id, '研究归档');
    const fChild = app.space.ensureFolderPath(thread.id, '研究归档/图表');
    const doc = app.space.createDocument({
      threadId: thread.id,
      title: '执行方案.md',
      content: '# 执行方案正文内容',
      folderId: fParent.id
    });
    const png = app.space.saveOrUpdateFileForAgent({
      threadId: thread.id,
      name: 'trend.png',
      dataBase64: TINY_PNG_BASE64,
      folderId: fChild.id
    }).file;

    app.registry.mockDriver.handlers.set('mem_ref_agent', async () => ({
      text: [
        '已整理完成，点击下面任意条目可直接打开：',
        '- 目录：**`研究归档/`**',
        '- 文档：《执行方案.md》',
        '- 配图：`研究归档/图表/trend.png`',
        '- 命令保持普通样式：`python3`',
        '- 原始网页：https://example.com/report。',
        '![本机生成的图](/Users/test/output/report.png)',
        '#  ',
        '旧回复之后的正文仍应显示'
      ].join('\n')
    }));

    await app.threads.sendUserMessage({ threadId: thread.id, body: '发一下归档清单' });
    const { url } = await app.listen(0, '127.0.0.1');

    const page = await browser.newPage({ viewport: { width: 1360, height: 840 } });
    const detailUrl = `**/api/v2/threads/${thread.id}`;
    const spaceUrl = `${detailUrl}/space`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    for (const pattern of [detailUrl, spaceUrl]) {
      await page.route(pattern, async (route) => {
        await gate;
        await route.fulfill({ status: 503, body: '{}' });
      });
    }
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    try {
      await page.getByText('正在加载对话…').waitFor();
      await page.getByText('正在加载资料…').waitFor();
      assert.equal(await page.getByText('还没有资料').count(), 0);
    } finally {
      release();
    }
    await page.getByText('对话加载失败').waitFor();
    await page.getByText('资料加载失败').waitFor();
    await page.unroute(detailUrl);
    await page.unroute(spaceUrl);
    await page.getByRole('button', { name: '重新加载资料' }).click();
    await page.getByRole('button', { name: '重新加载对话' }).click();
    await page.getByText('本机生成的图（图片地址无法在此打开）', { exact: true }).waitFor();
    await page.getByText('旧回复之后的正文仍应显示', { exact: false }).first().waitFor();

    // 1. Bare URL is a real clickable <a> without trailing Chinese punctuation
    const bareLink = page.locator('a.dw-bare-link', { hasText: 'https://example.com/report' });
    await bareLink.waitFor();
    assert.equal(await bareLink.getAttribute('href'), 'https://example.com/report');

    // 2. Plain code `python3` stays normal <code>, NOT a space ref chip
    assert.equal(await page.locator('.message-markdown code', { hasText: 'python3' }).count(), 1);

    // 3. Clicking `研究归档/图表/trend.png` opens the image directly in Space detail view
    await page.locator(`[data-space-ref-item="file:${png.id}"]`).click();
    await page.locator('.space-detail-heading h2', { hasText: 'trend.png' }).waitFor();

    // 4. Clicking 《执行方案.md》 opens the document directly in Space detail view
    await page.locator(`[data-space-ref-item="document:${doc.id}"]`).click();
    await page.locator('.space-detail-heading h2', { hasText: '执行方案.md' }).waitFor();

    // 5. Clicking **`研究归档/`** jumps straight into that folder in the bottom Document Manager
    await page.locator(`[data-space-ref-folder="${fParent.id}"]`).click();
    await page.getByTestId('space-folder-nav').waitFor();
    await page.getByTestId('space-manager-section').locator('.material-folder-open', { hasText: '图表' }).waitFor();
  } finally {
    await browser.close();
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
