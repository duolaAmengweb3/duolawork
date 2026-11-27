import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { DuolaWorkApp } from '../src/server/app.js';
import { ViewCache } from '../src/web/view-cache.js';

test('A late response cannot undo an invalidation or repopulate a revoked resource', async () => {
  const cache = new ViewCache();
  let finish!: (value: string) => void;
  const slow = () =>
    new Promise<string>((resolve) => {
      finish = resolve;
    });
  const first = cache.read('thread', slow, 1000);
  assert.equal(cache.read('thread', slow, 1000), first);
  await Promise.resolve();
  cache.invalidate('thread');
  cache.put('thread', 'edited');
  finish('previous');
  await first;
  assert.equal(cache.peek('thread'), 'edited');
  cache.invalidate('thread');
  await assert.rejects(
    cache.read(
      'thread',
      async () => {
        throw new Error('offline');
      },
      1000
    )
  );
  assert.equal(cache.peek('thread'), 'edited');
  await assert.rejects(
    cache.read(
      'thread',
      async () => {
        throw Object.assign(new Error(), { status: 403 });
      },
      1000
    )
  );
  assert.equal(cache.peek('thread'), undefined);
});

test('Revisits show the right conversation and materials, including while live changes are delayed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-revisit-'));
  const app = new DuolaWorkApp({
    dbPath: path.join(dir, 'db'),
    filesDir: path.join(dir, 'files'),
    staticWebDir: path.resolve('dist/web'),
    autoImportAgentHub: false
  });
  const member = app.db.upsertMember({
    id: 'reader',
    name: 'Reader',
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
    statusMessage: ''
  });
  const fixtures = ['甲', '乙'].map((label) => {
    const thread = app.threads.createThread({ title: '项目' + label, activeOwnerMemberId: member.id });
    app.threads.appendSystemMessage({
      threadId: thread.id,
      authorKind: 'agent',
      authorId: member.id,
      body: '对话正文' + label
    });
    const doc = app.space.createDocument({
      threadId: thread.id,
      title: '资料' + label,
      content: '已保存正文' + label
    });
    return { thread, doc };
  });
  const { url } = await app.listen(0, '127.0.0.1');
  const browser = await chromium.launch({ channel: 'chrome' });
  let release = () => {};
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 920 } });
    page.setDefaultTimeout(8000);
    const chat = page.locator('.messages-scroll');
    const recent = page.getByTestId('space-recent-section');
    const open = async (label: string) => {
      await page
        .locator('.channel-open-btn')
        .filter({ hasText: '项目' + label })
        .click();
      await chat.getByText('对话正文' + label, { exact: true }).waitFor();
      await recent.getByText('资料' + label, { exact: true }).waitFor();
    };
    await page.goto(url);
    await open('甲');
    await open('乙');
    const resource = '/api/v2/threads/' + fixtures[0].thread.id;
    const reads: string[] = [];
    page.on('request', (request) => {
      const p = new URL(request.url()).pathname;
      if (p === resource || p === resource + '/space') reads.push(p);
    });
    await open('甲');
    assert.deepEqual(reads, []);
    assert.equal(await chat.getByText('对话正文乙').count(), 0);
    await open('乙');
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**' + resource + '/space', async (route) => {
      await delayed;
      await route.continue();
    });
    app.space.createDocument({ threadId: fixtures[0].thread.id, title: '后台新增资料', content: '更新' });
    app.threads.emit({ type: 'thread.space_updated', threadId: fixtures[0].thread.id });
    await open('甲');
    assert.equal(await recent.getByText('资料乙').count(), 0);
    assert.equal(await recent.getByText('后台新增资料').count(), 0);
    release();
    await recent.getByText('后台新增资料').waitFor();
    await recent.getByText('资料甲', { exact: true }).click();
    await page.getByText('已保存正文甲', { exact: true }).waitFor();
    await page.getByRole('button', { name: '返回列表' }).click();
    const docUrl = '/api/v2/artifacts/' + fixtures[0].doc.id;
    const delayedDoc = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**' + docUrl, async (route) => {
      await delayedDoc;
      await route.continue();
    });
    let docReads = 0;
    page.on('request', (req) => {
      if (new URL(req.url()).pathname === docUrl && req.method() === 'GET') docReads++;
    });
    await recent.getByText('资料甲', { exact: true }).click();
    await page.getByText('已保存正文甲', { exact: true }).waitFor();
    assert.equal(docReads, 0);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '文稿编辑器' });
    await editor.fill('未保存的手动编辑');
    const response = page.waitForResponse(
      (r) => new URL(r.url()).pathname === docUrl && r.request().method() === 'GET'
    );
    const externalEdit = await page.request.post(url + docUrl, {
      data: { expectedBaseVersion: 1, content: '其他人提交的新版本' }
    });
    assert.ok(externalEdit.ok());
    release();
    await response;
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    assert.equal(await editor.inputValue(), '未保存的手动编辑');
  } finally {
    release();
    await browser.close();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
