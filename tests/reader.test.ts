import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { detectPreviewKind } from '../src/shared/file-format.js';
import { DuolaWorkApp } from '../src/server/app.js';

test('Reader routes Office containers to downloads and text uploads to previews', () => {
  assert.equal(detectPreviewKind('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'binary');
  assert.equal(detectPreviewKind('table.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'binary');
  for (const ext of ['go', 'rs', 'mdx', 'jsonl', 'tsv']) {
    assert.equal(detectPreviewKind('file.' + ext, 'application/octet-stream'), 'text');
  }
});

test('Reader protects edits during save, follows remote changes and restores the active tab', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-reader-'));
  const app = new DuolaWorkApp({
    dbPath: path.join(dir, 'db'),
    filesDir: path.join(dir, 'files'),
    staticWebDir: path.resolve('dist/web'),
    autoImportAgentHub: false
  });
  const member = app.db.upsertMember({
    id: 'reader-test', name: 'Reader', platformId: 'codex', driverKind: 'mock', location: 'local',
    config: {}, status: 'ready', statusMessage: '',
    capabilities: { supportsIsolatedSessions: true, supportsSessionResume: true, supportsCancel: true, maxConcurrentRuns: 1 }
  });
  const thread = app.threads.createThread({ title: 'Reader', activeOwnerMemberId: member.id });
  const docs = Array.from({length: 7}, (_, index) => app.space.createDocument({
    threadId: thread.id, title: 'Document ' + index, content: '# Page ' + index
  }));
  const {url} = await app.listen(0, '127.0.0.1');
  const browser = await chromium.launch({channel: 'chrome'});
  let release = () => {};
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    const api = '/api/v2/artifacts/' + docs[0].id;
    await page.goto(url + '/?popout=document&id=' + docs[0].id + '&threadId=' + thread.id);
    await page.getByRole('heading', {name: 'Page 0'}).waitFor();
    const script = await page.locator('script[type="module"][src]').getAttribute('src');
    assert.ok(script);
    assert.match((await page.request.get(url + script)).headers()['cache-control'], /immutable/);
    assert.equal((await page.request.get(url)).headers()['cache-control'], 'no-cache');

    const update = await page.request.post(url + api, {data: {expectedBaseVersion: 1, content: '# External'}});
    assert.ok(update.ok());
    await page.getByRole('heading', {name: 'External'}).waitFor();
    await page.getByRole('button', {name: '编辑', exact: true}).click();
    const editor = page.getByLabel('独立窗口文档编辑器');
    await editor.fill('Submitted');
    const gate = new Promise<void>(resolve => {release = resolve;});
    await page.route('**' + api, async route => {
      if (route.request().method() === 'POST') await gate;
      await route.continue();
    });
    const sent = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith(api));
    await page.getByRole('button', {name: '保存', exact: true}).click();
    await sent;
    await editor.fill('Still typing');
    release();
    await page.getByText('v3', {exact: true}).waitFor();
    assert.equal(await editor.inputValue(), 'Still typing');
    assert.equal(app.artifacts.getArtifact(docs[0].id)?.content, 'Submitted');
    const confirmation = page.waitForEvent('dialog').then(dialog => dialog.dismiss());
    await page.getByRole('button', {name: '关闭标签 Document 0'}).click();
    await confirmation;
    assert.equal(await editor.inputValue(), 'Still typing');
    await page.keyboard.press('Control+s');
    await page.getByText('v4', {exact: true}).waitFor();
    await editor.fill('Local conflict');
    const keepDraft = page.waitForEvent('dialog').then(async dialog => {
      assert.equal(dialog.type(), 'beforeunload');
      await dialog.dismiss();
    });
    await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
    await keepDraft;
    assert.equal(await editor.inputValue(), 'Local conflict');
    const remote = await page.request.post(url + api, {data: {expectedBaseVersion: 4, content: 'Other author'}});
    assert.ok(remote.ok());
    await page.getByRole('button', {name: '保存', exact: true}).click();
    await page.getByText('检测到并发修改，已另存为冲突分支 v6', {exact: true}).waitFor();
    assert.equal(app.artifacts.getArtifact(docs[0].id)?.content, 'Other author');
    for (const doc of docs.slice(1)) {
      await page.getByLabel('打开更多资料标签').click();
      await page.getByRole('menuitem').getByText(doc.title, {exact: true}).click();
      await page.getByRole('heading', {name: doc.content.slice(2), exact: true}).waitFor();
    }
    await page.getByRole('button', {name: '关闭标签 Document 0'}).click();
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.getByRole('heading', {name: 'Page 6'}).waitFor();
    assert.equal(await page.getByRole('tab').count(), 6);
    assert.equal(await page.getByRole('button', {name: '关闭标签 Document 0'}).count(), 0);
  } finally {
    release();
    await browser.close();
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
