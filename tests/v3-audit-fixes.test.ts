import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { DuolaWorkNodeRunner } from '../src/node-runner/index.js';
import { DuolaWorkApp } from '../src/server/app.js';
import { activateDiscoveredAgent, discoverLocalAgents } from '../src/server/discovery.js';

const require = createRequire(import.meta.url);
const { createBackupBundle } = (await import(
  pathToFileURL(path.resolve('deploy/scripts/backup-sqlite.mjs')).href
)) as {
  createBackupBundle: (opts: any) => Promise<any>;
};
const { restoreBackupBundle } = (await import(
  pathToFileURL(path.resolve('deploy/scripts/restore-backup.mjs')).href
)) as {
  restoreBackupBundle: (opts: any) => any;
};
const {
  gracefullyStopDuolaWorkProcesses,
  partitionPortListeners,
  transactionalAppInstall
} = (await import(
  pathToFileURL(path.resolve('scripts/activate-helpers.mjs')).href
)) as {
  gracefullyStopDuolaWorkProcesses: (opts: any) => Promise<any>;
  partitionPortListeners: (
    pids: number[],
    getCommand: (pid: number) => string,
    targetAppPath?: string,
    chromePids?: number[]
  ) => { duolaworkPids: number[]; unrelatedPids: Array<{ pid: number; command: string }> };
  transactionalAppInstall: (opts: any) => Promise<any>;
};
const { createModeSwitchController, handleWillPreventUnload } = require('../desktop/mode-switch.cjs') as {
  createModeSwitchController: (deps: any) => any;
  handleWillPreventUnload: (opts: any) => 'keep' | 'discard';
};

async function startTcpRelay(targetPort: number) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((clientSocket) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    sockets.add(clientSocket);
    sockets.add(upstream);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
    const cleanup = () => {
      sockets.delete(clientSocket);
      sockets.delete(upstream);
      clientSocket.destroy();
      upstream.destroy();
    };
    clientSocket.on('error', cleanup);
    upstream.on('error', cleanup);
    clientSocket.on('close', cleanup);
    upstream.on('close', cleanup);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as net.AddressInfo;
  return {
    port: addr.port,
    closeAll: async () => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

test('AUDIT-01: new thread creation isolates target thread from delayed creation and preserves drafts on cancel or failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw3-audit1-'));
  const app = new DuolaWorkApp({
    dbPath: path.join(dir, 'v3.sqlite'),
    filesDir: path.join(dir, 'files'),
    staticWebDir: path.resolve('dist/web'),
    autoImportAgentHub: false
  });
  const member = app.db.upsertMember({
    id: 'mem_audit_codex',
    name: 'Codex',
    platformId: 'codex',
    driverKind: 'mock',
    location: 'local',
    config: {},
    capabilities: {
      supportsIsolatedSessions: true,
      supportsSessionResume: true,
      supportsCancel: true,
      maxConcurrentRuns: 2
    },
    status: 'ready',
    statusMessage: 'ready'
  });
  const oldThread = app.threads.createThread({
    title: '旧对话-不应误收消息',
    activeOwnerMemberId: member.id
  });
  app.registry.mockDriver.handlers.set(member.id, async (input) => {
    if (input.prompt.includes('新会话专属消息-蓝杉')) return { text: '回复：新会话专属消息-蓝杉' };
    if (input.prompt.includes('失败后保留草稿')) return { text: '回复：失败后保留草稿' };
    if (input.prompt.includes('旧对话基准问题')) return { text: '回复：旧对话基准问题' };
    return { text: `回复：${input.prompt}` };
  });
  await app.threads.sendUserMessage({ threadId: oldThread.id, body: '旧对话基准问题' });

  const { url } = await app.listen(0, '127.0.0.1');
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    page.setDefaultTimeout(10_000);
    const oldPostRequests: string[] = [];
    await page.route(`**/api/v2/threads/${oldThread.id}/messages`, async (route) => {
      oldPostRequests.push(route.request().url());
      await route.continue();
    });

    await page.goto(url, { waitUntil: 'networkidle' });
    await page.getByText('回复：旧对话基准问题').waitFor();

    // 1. Delay thread creation by 650ms, type immediately and hit Enter -> must queue and ONLY post to new thread B!
    let mode: 'delay' | 'hold' | 'fail' = 'delay';
    let abortHeldCreate: (() => void) | null = null;
    await page.route('**/api/v2/threads', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      if (mode === 'delay') {
        await new Promise((r) => setTimeout(r, 650));
        await route.continue();
      } else if (mode === 'hold') {
        await new Promise<void>((resolve) => {
          abortHeldCreate = resolve;
        });
        await route.abort('failed').catch(() => {});
      } else {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: '模拟创建会话失败 500' })
        });
      }
    });

    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await page.getByTestId('pending-thread-banner').waitFor();
    const textarea = page.locator('.chat-composer textarea');
    await textarea.fill('新会话专属消息-蓝杉');
    await textarea.press('Enter');

    // Old thread must NOT receive anything while pending or after resolving
    assert.equal(oldPostRequests.length, 0, 'Must never post to old thread while creating new thread');

    await page.locator('.message-markdown').filter({ hasText: '回复：新会话专属消息-蓝杉' }).waitFor();
    assert.equal(oldPostRequests.length, 0, 'Old thread must still have zero new POSTs after resolve');
    assert.equal(
      app.threads.listMessages(oldThread.id).some((m) => m.body.includes('新会话专属消息-蓝杉')),
      false,
      'Old thread DB must stay clean'
    );
    const newThreadB = app.threads.listThreads().find((t) => t.id !== oldThread.id);
    assert.ok(newThreadB, 'New thread B should exist in DB');
    assert.ok(
      app.threads.listMessages(newThreadB.id).some((m) => m.body.includes('新会话专属消息-蓝杉')),
      'Target new thread B must own the message'
    );

    // 2. Cancel during held creation -> draft preserved, nothing sent anywhere
    mode = 'hold';
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await page.getByTestId('pending-thread-banner').waitFor();
    await textarea.fill('取消后保留草稿');
    await textarea.press('Enter');
    await page.getByTestId('pending-thread-cancel').click();
    if (abortHeldCreate) (abortHeldCreate as () => void)();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await textarea.inputValue(), '取消后保留草稿');
    assert.equal(app.threads.listThreads().length, 2, 'Canceled thread create must not materialize');
    for (const t of app.threads.listThreads()) {
      assert.equal(
        app.threads.listMessages(t.id).some((m) => m.body.includes('取消后保留草稿')),
        false,
        'Canceled queued send must not dispatch to any thread'
      );
    }

    // Abandon canceled pending banner to reset for failure test
    await page.getByTestId('pending-thread-dismiss').click();

    // 3. Failure (HTTP 500) -> draft preserved, nothing sent, retry recovers cleanly
    mode = 'fail';
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await page.getByTestId('pending-thread-retry').waitFor();
    await textarea.fill('失败后保留草稿');
    // Unblock route for retry test
    mode = 'delay';
    await page.getByTestId('pending-thread-retry').click();
    await page.getByTestId('pending-thread-banner').waitFor({ state: 'detached' });
    assert.equal(await textarea.inputValue(), '失败后保留草稿', 'Draft migrates into newly retried thread');
    await textarea.press('Enter');
    await page.locator('.message-markdown').filter({ hasText: '回复：失败后保留草稿' }).waitFor();
    assert.equal(oldPostRequests.length, 0);
  } finally {
    await browser.close();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT-02: companion keepalive pauses while disconnected, distinguishes cloud vs device ACK, and renders unknown+retry on 503', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw3-audit2-'));
  const app = new DuolaWorkApp({
    dbPath: path.join(dir, 'v3.sqlite'),
    filesDir: path.join(dir, 'files'),
    staticWebDir: path.resolve('dist/web'),
    autoImportAgentHub: false
  });
  const { url, port } = await app.listen(0, '127.0.0.1');
  let relay = await startTcpRelay(port);
  let runner: DuolaWorkNodeRunner | null = null;
  const browser = await chromium.launch({ channel: 'chrome' });

  try {
    const { code } = app.nodeHub.createPairingCode({ name: 'MacMini-Test', kind: 'local' });
    const { nodeToken } = app.nodeHub.pairNode({
      code,
      name: 'MacMini-Test',
      kind: 'local',
      platform: 'darwin'
    });

    runner = new DuolaWorkNodeRunner({
      serverUrl: `http://127.0.0.1:${relay.port}`,
      nodeToken,
      name: 'MacMini-Test',
      kind: 'local',
      members: [],
      outboxPath: path.join(dir, 'outbox.json')
    });
    await runner.start();

    const launched: string[][] = [];
    const mockDeps = {
      platform: 'darwin',
      existsSync: () => true,
      isRunning: async () => false,
      launch: async (args: string[]) => {
        launched.push(args);
      }
    };

    // Enable Grok on server -> verify ACKed & launched once online
    await fetch(`${url}/api/v2/settings/companion-keepalive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grokBot: true })
    });
    const waitSynced = async (expectedRev: number) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const st = app.nodeHub.getCompanionKeepaliveStatus();
        if (st.revision === expectedRev && st.localNodes[0]?.synced) return st;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error(`Timed out waiting for node ACK revision ${expectedRev}`);
    };
    await waitSynced(1);
    const checkOnline = await runner.runCompanionKeepaliveCheck(mockDeps);
    assert.equal(checkOnline.paused, false);
    assert.deepEqual(checkOnline.launched, ['Grok Bot.app']);

    // Simulate real WebSocket network drop via relay shutdown
    await relay.closeAll();
    const waitOffline = Date.now() + 5000;
    while (
      Date.now() < waitOffline &&
      (runner.isControlPlaneConnected() || app.nodeHub.getCompanionKeepaliveStatus().localNodes[0]?.online)
    ) {
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.equal(runner.isControlPlaneConnected(), false);

    // Turn OFF Grok on server while device is disconnected (device still held true locally)
    const offRes = await fetch(`${url}/api/v2/settings/companion-keepalive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grokBot: false })
    });
    const offStatus = await offRes.json();
    assert.equal(offStatus.grokBot, false);
    assert.equal(offStatus.revision, 2);
    assert.equal(offStatus.localNodes[0].online, false);
    assert.equal(offStatus.localNodes[0].synced, false);

    // Timer check while disconnected MUST pause and NOT launch Grok!
    const countBefore = launched.length;
    const pausedCheck = await runner.runCompanionKeepaliveCheck(mockDeps);
    assert.equal(pausedCheck.paused, true);
    assert.deepEqual(pausedCheck.launched, []);
    assert.equal(launched.length, countBefore, 'Offline node must not launch companion apps');

    // Restart relay with a fresh runner bound to the same port (simulating reconnect to cloud)
    runner.stop();
    relay = await startTcpRelay(port);
    runner = new DuolaWorkNodeRunner({
      serverUrl: `http://127.0.0.1:${relay.port}`,
      nodeToken,
      name: 'MacMini-Test',
      kind: 'local',
      members: [],
      outboxPath: path.join(dir, 'outbox.json'),
      companionKeepalive: { grokBot: true } // even if local file had stale true, welcome overrides it
    });
    await runner.start();
    const syncedAfterReconnect = await waitSynced(2);
    assert.equal(syncedAfterReconnect.localNodes[0].online, true);
    assert.equal(syncedAfterReconnect.localNodes[0].synced, true);
    assert.equal(runner.getCompanionKeepalive().grokBot, false);
    const resAfterReconnect = await runner.runCompanionKeepaliveCheck(mockDeps);
    assert.equal(resAfterReconnect.paused, false);
    assert.deepEqual(resAfterReconnect.launched, []);

    // Re-enable grok=true so server state is ON, then verify 503 unknown/retry UI & POST network failure safety
    await fetch(`${url}/api/v2/settings/companion-keepalive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grokBot: true })
    });
    await waitSynced(3);

    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    let failKeepaliveGet = true;
    await page.route('**/api/v2/settings/companion-keepalive', async (route) => {
      if (route.request().method() === 'GET' && failKeepaliveGet) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Service Unavailable (503)' })
        });
        return;
      }
      await route.continue();
    });

    await page.goto(url, { waitUntil: 'networkidle' });
    await page.locator('#workbench-sidebar').getByRole('button', { name: /^成员与用量/ }).click();
    await page.getByTestId('keepalive-unknown-state').waitFor();
    assert.equal(
      await page.getByTestId('companion-keepalive-card').getByText('不自动拉起').count(),
      0,
      'Must NEVER display Keepalive Off falsely when GET fails with 503'
    );
    assert.equal(await page.getByTestId('keepalive-toggle-grok').isDisabled(), true);

    // Retry succeeds -> shows real server ON state + Cloud Saved + Device Received badges
    failKeepaliveGet = false;
    await page.getByTestId('keepalive-retry-btn').click();
    await page.getByTestId('keepalive-cloud-badge').waitFor();
    assert.equal(await page.getByTestId('keepalive-toggle-grok').getAttribute('aria-checked'), 'true');
    assert.match(await page.getByTestId('keepalive-cloud-badge').innerText(), /云端已保存/);
    assert.match(await page.getByTestId('keepalive-device-badge').innerText(), /设备已收到/);

    // Network failure on POST must NOT produce unhandled pageerror
    await page.unroute('**/api/v2/settings/companion-keepalive');
    await page.route('**/api/v2/settings/companion-keepalive', async (route) => {
      if (route.request().method() === 'POST') {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    await page.getByTestId('keepalive-toggle-grok').click();
    await page.getByRole('alert').filter({ hasText: /未保存|Network error/ }).first().waitFor();
    assert.equal(pageErrors.length, 0, `Unexpected unhandled exceptions: ${pageErrors.join('; ')}`);
  } finally {
    runner?.stop();
    await relay.closeAll().catch(() => {});
    await browser.close();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT-03: built-in backup and restore recovers SQLite docs, space CSV attachments, and chat images into an empty directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw3-audit3-'));
  const srcDb = path.join(dir, 'src', 'duolawork-v2.sqlite');
  const srcFiles = path.join(dir, 'src', 'files');
  const backupsDir = path.join(dir, 'backups');
  const restoredDb = path.join(dir, 'restored', 'duolawork-v2.sqlite');
  const restoredFiles = path.join(dir, 'restored', 'files');

  const app1 = new DuolaWorkApp({ dbPath: srcDb, filesDir: srcFiles, autoImportAgentHub: false });
  const csvBytes = Buffer.from('region,revenue\napac,128400\nemea,99420\n', 'utf8');
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82
  ]);

  let docId = '';
  let fileId = '';
  let imgId = '';
  try {
    const member = app1.db.upsertMember({
      id: 'mem_backup_test',
      name: 'BackupLead',
      platformId: 'codex',
      driverKind: 'mock',
      location: 'local',
      config: {},
      capabilities: {
        supportsIsolatedSessions: true,
        supportsSessionResume: true,
        supportsCancel: true,
        maxConcurrentRuns: 1
      },
      status: 'ready',
      statusMessage: 'ready'
    });
    const thread = app1.threads.createThread({ title: '备份恢复校验', activeOwnerMemberId: member.id });
    const art = app1.artifacts.createArtifact({
      sourceThreadId: thread.id,
      title: '发布说明.md',
      content: '# 完整恢复验证\n正文内容完整 2026',
      writerKind: 'user',
      writerId: 'owner'
    });
    docId = art.id;
    const uploadedCsv = app1.space.saveFileBuffer({
      threadId: thread.id,
      name: 'metrics.csv',
      mimeType: 'text/csv',
      buffer: csvBytes,
      uploaderId: 'owner'
    });
    fileId = uploadedCsv.id;
    const savedImg = app1.space.saveChatImageBuffer({
      threadId: thread.id,
      name: 'evidence.png',
      mimeType: 'image/png',
      buffer: pngBytes,
      uploaderId: 'owner'
    });
    imgId = savedImg.id;
  } finally {
    await app1.close();
  }

  const backupRes = await createBackupBundle({
    srcDb,
    backupDir: backupsDir,
    retainDays: 14,
    srcFilesDir: srcFiles
  });
  assert.equal(backupRes.manifest.integrityCheck, 'ok');
  assert.equal(backupRes.manifest.counts.spaceFiles, 1);
  assert.equal(backupRes.manifest.counts.chatImages, 1);

  const restoreRes = restoreBackupBundle({
    bundleDir: backupRes.bundleDir,
    targetDbPath: restoredDb,
    targetFilesDir: restoredFiles
  });
  assert.equal(restoreRes.verifiedFiles, 2);

  const app2 = new DuolaWorkApp({ dbPath: restoredDb, filesDir: restoredFiles, autoImportAgentHub: false });
  try {
    const { url } = await app2.listen(0, '127.0.0.1');
    const docRes = await fetch(`${url}/api/v2/artifacts/${encodeURIComponent(docId)}`);
    assert.equal(docRes.status, 200);
    const docJson = await docRes.json();
    assert.equal(docJson.artifact.content, '# 完整恢复验证\n正文内容完整 2026');

    const csvRes = await fetch(`${url}/api/v2/space/files/${encodeURIComponent(fileId)}`);
    assert.equal(csvRes.status, 200);
    assert.deepEqual(Buffer.from(await csvRes.arrayBuffer()), csvBytes);

    const imgRes = await fetch(`${url}/api/v2/chat-images/${encodeURIComponent(imgId)}`);
    assert.equal(imgRes.status, 200);
    assert.deepEqual(Buffer.from(await imgRes.arrayBuffer()), pngBytes);
  } finally {
    await app2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT-04: public package metadata, desktop launcher, and mac packager contain zero developer-specific paths', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.equal(pkg.main, 'desktop/main.cjs');
  assert.equal(pkg.scripts.desktop, 'node scripts/run-desktop.mjs');
  assert.equal(pkg.scripts['package:dmg'], 'node scripts/package-dmg.mjs');
  assert.ok(pkg.devDependencies.electron, 'electron must be listed in devDependencies');
  assert.equal(fs.existsSync(path.resolve('desktop/entitlements.mac.plist')), true);

  for (const rel of [
    'scripts/package-mac.mjs',
    'scripts/package-dmg.mjs',
    'scripts/activate-local.mjs',
    'scripts/run-desktop.mjs'
  ]) {
    const src = fs.readFileSync(path.resolve(rel), 'utf8');
    assert.equal(src.includes('/Users/duola'), false, `${rel} must not contain hardcoded developer path`);
  }
});

test('AUDIT-05: mode switch respects unsaved draft cancel, and local upgrade avoids SIGKILL/unrelated PIDs and rolls back on failed verification', async () => {
  // 1. Desktop mode switch cancel vs confirm
  const writes: Array<{ path: string; mode: string; url: string }> = [];
  let quits = 0;
  let relaunches = 0;
  let rebuiltMode = '';
  let runtime = { mode: 'local', cloudUrl: 'https://work.manyaitool.com', clientConfigPath: '/tmp/client.json' };
  const ctrl = createModeSwitchController({
    getCurrentRuntimeInfo: () => runtime,
    writeMode: (p: string, mode: string, url: string) => writes.push({ path: p, mode, url }),
    quitApp: () => { quits += 1; },
    relaunchApp: () => { relaunches += 1; },
    rebuildMenu: (info: any) => { rebuiltMode = info.mode; }
  });

  assert.equal(ctrl.requestModeSwitch('cloud', 'https://work.manyaitool.com'), true);
  assert.equal(quits, 1);
  assert.equal(writes.length, 0, 'Must not write client.json before windows confirm close');

  let defaultPrevented = false;
  const action = handleWillPreventUnload({
    event: { preventDefault: () => { defaultPrevented = true; } },
    showConfirmDialog: () => 0, // 继续编辑
    onCancel: () => ctrl.cancelPendingSwitch()
  });
  assert.equal(action, 'keep');
  assert.equal(defaultPrevented, false);
  assert.equal(rebuiltMode, 'local');
  assert.equal(ctrl.commitPendingSwitchBeforeQuit(), false);
  assert.equal(writes.length, 0);
  assert.equal(relaunches, 0);

  // Confirm discard -> will-quit writes & relaunches
  assert.equal(ctrl.requestModeSwitch('cloud', 'https://work.manyaitool.com'), true);
  const discardAction = handleWillPreventUnload({
    event: { preventDefault: () => { defaultPrevented = true; } },
    showConfirmDialog: () => 1, // 放弃修改
    onCancel: () => ctrl.cancelPendingSwitch()
  });
  assert.equal(discardAction, 'discard');
  assert.equal(defaultPrevented, true);
  assert.equal(ctrl.commitPendingSwitchBeforeQuit(), true);
  assert.deepEqual(writes, [{ path: '/tmp/client.json', mode: 'cloud', url: 'https://work.manyaitool.com' }]);
  assert.equal(relaunches, 1);

  // 2. Unrelated process on port 8780 must never be signaled
  const partitioned = partitionPortListeners(
    [101, 202],
    (pid) =>
      pid === 101
        ? '/Users/example/release/DuolaWork.app/Contents/MacOS/Electron'
        : 'python3 -m http.server 8780',
    '/Users/example/release/DuolaWork.app'
  );
  assert.deepEqual(partitioned.duolaworkPids, [101]);
  assert.equal(partitioned.unrelatedPids.length, 1);

  const signals: Array<{ pid: number; sig: string }> = [];
  await assert.rejects(
    gracefullyStopDuolaWorkProcesses({
      duolaworkPids: partitioned.duolaworkPids,
      unrelatedPids: partitioned.unrelatedPids,
      bootMode: 'local',
      signalPid: (pid: number, sig: string) => signals.push({ pid, sig }),
      waitExit: async () => [],
      waitPortFree: async () => true
    }),
    /拒绝终止无关进程/
  );
  assert.equal(signals.length, 0);

  // 3. Refusal to quit gracefully (unsaved draft cancel) must NOT escalate to SIGKILL
  await assert.rejects(
    gracefullyStopDuolaWorkProcesses({
      duolaworkPids: [303],
      unrelatedPids: [],
      bootMode: 'local',
      signalPid: (pid: number, sig: string) => signals.push({ pid, sig }),
      waitExit: async () => [303],
      waitPortFree: async () => false,
      gracefulTimeoutMs: 50
    }),
    /未发送 SIGKILL/
  );
  assert.deepEqual(signals, [{ pid: 303, sig: 'SIGTERM' }]);

  // 4. Transactional install rolls back on failed verification and commits on pass
  const tmpUpgrade = fs.mkdtempSync(path.join(os.tmpdir(), 'dw3-tx-'));
  try {
    const relDir = path.join(tmpUpgrade, 'release');
    const builtApp = path.join(tmpUpgrade, 'built.app');
    const targetApp = path.join(relDir, 'DuolaWork.app');
    fs.mkdirSync(relDir, { recursive: true });
    fs.mkdirSync(builtApp, { recursive: true });
    fs.mkdirSync(targetApp, { recursive: true });
    fs.writeFileSync(path.join(targetApp, 'version.txt'), 'old-2.9');
    fs.writeFileSync(path.join(builtApp, 'version.txt'), 'new-3.0');

    await assert.rejects(
      transactionalAppInstall({
        builtApp,
        targetApp,
        targetReleaseDir: relDir,
        exists: (p: string) => fs.existsSync(p),
        mkdir: (p: string) => fs.mkdirSync(p, { recursive: true }),
        copyBundle: async (s: string, d: string) => fs.cpSync(s, d, { recursive: true }),
        rename: (s: string, d: string) => fs.renameSync(s, d),
        rmTree: (p: string) => fs.rmSync(p, { recursive: true, force: true }),
        verifyInstalled: async () => {
          throw new Error('health check failed');
        }
      }),
      /已回滚至升级前版本/
    );
    assert.equal(fs.readFileSync(path.join(targetApp, 'version.txt'), 'utf8'), 'old-2.9');

    await transactionalAppInstall({
      builtApp,
      targetApp,
      targetReleaseDir: relDir,
      exists: (p: string) => fs.existsSync(p),
      mkdir: (p: string) => fs.mkdirSync(p, { recursive: true }),
      copyBundle: async (s: string, d: string) => fs.cpSync(s, d, { recursive: true }),
      rename: (s: string, d: string) => fs.renameSync(s, d),
      rmTree: (p: string) => fs.rmSync(p, { recursive: true, force: true }),
      verifyInstalled: async (p: string) => fs.readFileSync(path.join(p, 'version.txt'), 'utf8')
    });
    assert.equal(fs.readFileSync(path.join(targetApp, 'version.txt'), 'utf8'), 'new-3.0');
  } finally {
    fs.rmSync(tmpUpgrade, { recursive: true, force: true });
  }
});

function writeAcpStubScript(filePath: string, expectedArgs: string[], replyText: string) {
  const script = `#!/usr/bin/env node
const readline = require('node:readline');
const got = process.argv.slice(2);
const expected = ${JSON.stringify(expectedArgs)};
if (JSON.stringify(got) !== JSON.stringify(expected)) {
  console.error('unexpected args: ' + JSON.stringify(got));
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    console.log(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: 1, agentInfo: { name: ${JSON.stringify(path.basename(filePath))} }, agentCapabilities: { loadSession: true } }
    }));
  } else if (msg.method === 'session/new') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess_stub_1' } }));
  } else if (msg.method === 'session/resume') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params.sessionId || 'sess_stub_1' } }));
  } else if (msg.method === 'session/prompt') {
    console.log(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ${JSON.stringify(replyText)} } } }
    }));
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', turnId: 'turn_1' } }));
  }
});
`;
  fs.writeFileSync(filePath, script, { mode: 0o755 });
}

test('AUDIT-06: isolated sole agy and sole gemini ACP runtimes each discover, activate, pass health, and reply end-to-end', async () => {
  const cases = [
    {
      binName: 'agy',
      expectedArgs: ['acp', '--dangerously-skip-permissions'],
      replyText: 'AGY_SOLO_REPLY_OK',
      extraEnv: {} as Record<string, string>
    },
    {
      binName: 'gemini',
      expectedArgs: ['--acp', '--approval-mode', 'yolo'],
      replyText: 'GEMINI_SOLO_REPLY_OK',
      extraEnv: { GEMINI_API_KEY: 'test-key-isolated' }
    }
  ];

  for (const c of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dw3-audit6-${c.binName}-`));
    const homeDir = path.join(dir, 'home');
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    writeAcpStubScript(path.join(binDir, c.binName), c.expectedArgs, c.replyText);

    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin${path.delimiter}${path.dirname(process.execPath)}`;
    const app = new DuolaWorkApp({
      dbPath: path.join(dir, 'v3.sqlite'),
      filesDir: path.join(dir, 'files'),
      autoImportAgentHub: false
    });
    try {
      const disc = discoverLocalAgents({
        homeDir,
        pathEnv: binDir,
        existingMembers: app.db.listMembers(),
        cloudMode: false,
        env: c.extraEnv
      });
      const candidate = disc.candidates.find((x) => x.id === 'gemini')!;
      assert.equal(candidate.binaryName, c.binName);
      assert.equal(candidate.status, 'ready');

      const member = activateDiscoveredAgent(
        app.db,
        { candidateId: 'gemini' },
        { homeDir, pathEnv: binDir, env: c.extraEnv }
      );
      assert.deepEqual(member.config.args, c.expectedArgs);

      const health = await app.registry.getDriver(member.driverKind).checkHealth(member);
      assert.equal(health.status, 'ready', `${c.binName} health failed: ${health.message}`);

      const thread = app.threads.createThread({ title: `${c.binName} solo`, activeOwnerMemberId: member.id });
      const turn = await app.threads.sendUserMessage({ threadId: thread.id, body: 'Ping ACP runtime' });
      assert.equal(turn.agentMessage.turnStatus, 'completed');
      assert.equal(turn.agentMessage.body, c.replyText);
    } finally {
      process.env.PATH = prevPath;
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
