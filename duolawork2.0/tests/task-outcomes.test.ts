import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { DuolaWorkApp } from '../src/server/app.js';
import type { TaskOutcome } from '../src/shared/types.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-outcomes-'));
  const config = {
    dbPath: path.join(dir, 'db.sqlite'),
    filesDir: path.join(dir, 'files'),
    staticWebDir: path.resolve('dist/web'),
    autoImportAgentHub: false
  };
  const app = new DuolaWorkApp(config);
  for (const id of ['Planner', 'Worker'])
    app.db.upsertMember({
      id,
      name: id,
      platformId: 'fixture',
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
      statusMessage: ''
    });
  const thread = app.threads.createThread({ title: '交付验收', activeOwnerMemberId: 'Planner' });
  return { app, dir, config, thread };
}

test('A missing or unrelated material cannot pass. A fresh scoped document or file can pass.', async () => {
  const { app, dir, thread } = fixture();
  try {
    app.space.createDocument({ threadId: thread.id, title: '结果.md', content: '上一期的文稿' });
    let attempts = 0;
    app.registry.mockDriver.handlers.set('Worker', async (input) => {
      attempts++;
      if (attempts === 2)
        await input.onToolCall!('space_save_document', {
          title: '结果.md',
          folderPath: '本期',
          content: '本期正文'
        });
      return { text: '已经保存' };
    });
    const { task, initialRun } = app.tasks.createOrUpdateTask({
      sourceThreadId: thread.id,
      leadMemberId: 'Worker',
      title: '本期文稿',
      spec: { outcome: { kind: 'material', materialKind: 'document', name: '结果.md', folderPath: '本期' } }
    });
    const done = await app.tasks.driveRun(initialRun!.id);
    assert.equal(done.status, 'completed');
    assert.equal(attempts, 2);
    const receipt = app.tasks.listRuns(task.id)[0].progress![0];
    assert.equal(receipt.confirmation, 'verified');
    assert.equal(app.artifacts.getArtifact(receipt.material!.id)?.content, '本期正文');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Dropped write receipt survives process restart. Only readbacks are retried; false HTTP success cannot confirm.', async () => {
  const { app, dir, config, thread } = fixture();
  let restarted: DuolaWorkApp | undefined;
  let writes = 0,
    reads = 0,
    workers = 0;
  const probe = {
    credentialId: 'fixture',
    url: 'https://example.invalid/records/17',
    field: 'record.stage',
    equals: 'approved'
  };
  const remote = async (_tool: string, args: Record<string, unknown>) => {
    if (args.method === 'POST') {
      writes++;
      throw Error('connection lost after write');
    }
    reads++;
    return { status: 200, body: JSON.stringify({ record: { stage: reads === 1 ? 'draft' : 'approved' } }) };
  };
  try {
    app.setExternalMcpCaller(remote);
    app.registry.mockDriver.handlers.set('Worker', async (input) => {
      workers++;
      const write = { credentialId: 'fixture', url: probe.url, method: 'POST', body: 'approved' };
      await assert.rejects(input.onToolCall!('duolabase:vault_http_proxy', write));
      assert.ok(
        ((await input.onToolCall!('duolabase:vault_http_proxy', { ...write, requestId: 'retry' })) as any)
          .alreadySubmitted
      );
      throw Error('connection lost');
    });
    const { task, initialRun } = app.tasks.createOrUpdateTask({
      title: '更新记录',
      sourceThreadId: thread.id,
      leadMemberId: 'Worker',
      spec: { outcome: { kind: 'external', readback: probe } }
    });
    await app.tasks.driveRun(initialRun!.id);
    assert.equal(app.tasks.listRuns(task.id)[0].progress![0].confirmation, 'checking');
    assert.equal(app.tasks.getRun(initialRun!.id)?.status, 'running');
    assert.equal(reads, 1);
    app.tasks.setPaused(task.id, true);
    assert.equal(app.tasks.getRun(initialRun!.id)?.status, 'paused');
    await app.close();
    restarted = new DuolaWorkApp(config);
    restarted.setExternalMcpCaller(remote);
    restarted.db.sqlite.prepare('UPDATE v2_step_outcomes SET next_check_at=0').run();
    await restarted.tasks.reconcileInFlightTaskRuns();
    assert.equal(reads, 1);
    restarted.tasks.setPaused(task.id, false);
    for (let i = 0; i < 30 && restarted.tasks.getRun(initialRun!.id)?.status !== 'completed'; i++)
      await new Promise((r) => setTimeout(r, 30));
    assert.equal(restarted.tasks.getRun(initialRun!.id)?.status, 'completed');
    assert.equal(restarted.tasks.listRuns(task.id)[0].progress![0].confirmation, 'verified');
    assert.deepEqual([writes, workers, reads], [1, 1, 2]);
  } finally {
    if (restarted) await restarted.close();
    else await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Browser: delegate, refresh, open the exact result, and confirm an unverifiable external change in place', async () => {
  const { app, dir, thread } = fixture();
  const errors: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let followups = 0;
  app.registry.mockDriver.handlers.set('Planner', async (inp) => {
    if (inp.prompt.includes('系统交付回执')) {
      followups++;
      return { text: '已对照要求核对交付。' };
    }
    const external = inp.prompt.includes('请处理外部记录');
    const outcome: TaskOutcome = external
      ? { kind: 'external' }
      : { kind: 'material', materialKind: 'file', name: '清单.csv', folderPath: '结果' };
    await inp.onToolCall!('task_create_or_update', {
      title: external ? '核对外部记录' : '交付清单',
      goal: external ? '核对更改' : '制作清单',
      leadMemberId: 'Worker',
      outcome
    });
    return { text: '已委派。' };
  });
  app.registry.mockDriver.handlers.set('Worker', async (inp) => {
    if (inp.prompt.includes('制作清单')) {
      await gate;
      await inp.onToolCall!('space_save_file', {
        name: '清单.csv',
        folderPath: '结果',
        content: 'item,value\na,7'
      });
      return { text: '清单已就绪。' };
    }
    return { text: '已提交外部操作，等待回执。' };
  });
  const { url } = await app.listen(0, '127.0.0.1');
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(12000);
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(url);
    await page.locator('.channel-open-btn').filter({ hasText: '交付验收' }).click();
    const send = async (text: string) => {
      await page.locator('.chat-composer textarea').fill(text);
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
    };
    await send('请制作清单');
    const card = page.locator('.chat-task-row').filter({ hasText: '交付清单' });
    await card.getByText('Planner 委派给 Worker', { exact: true }).waitFor();
    const position = () => card.evaluate((el) => Array.from(el.parentElement!.children).indexOf(el));
    const anchor = await position();
    await page.reload();
    await card.getByText('Planner 委派给 Worker', { exact: true }).waitFor();
    release();
    await card.getByText('资料已保存', { exact: true }).waitFor();
    await card.getByText('Planner 已跟进', { exact: true }).waitFor();
    assert.equal(await card.count(), 1);
    assert.equal(await position(), anchor);
    await card.getByText('资料已保存', { exact: true }).click();
    await page.locator('.space-detail-heading h2').filter({ hasText: '清单.csv' }).waitFor();
    await send('请处理外部记录');
    const second = page.locator('.chat-task-row').filter({ hasText: '核对外部记录' });
    await second.getByText('外部结果待确认', { exact: true }).waitFor();
    await page.reload();
    await second.getByRole('button', { name: '我已核实结果' }).click();
    await second.getByText('用户已确认外部结果', { exact: true }).waitFor();
    await second.getByText('Planner 已跟进', { exact: true }).waitFor();
    assert.equal(followups, 2);
    assert.deepEqual(errors, []);
  } finally {
    release();
    await browser.close();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
