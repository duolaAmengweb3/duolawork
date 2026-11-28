import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { DuolaWorkApp } from '../src/server/app.js';

test('From the composer to the native turn, model and effort belong to each member and conversation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-models-'));
  const command = path.join(dir, 'test-agent.cjs');
  fs.writeFileSync(
    command,
    `#!${process.execPath}
const { randomUUID } = require('node:crypto');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const models = ['standard','deep','fixed'].map((model,index)=>({model,displayName:model,isDefault:index===0,
  supportedReasoningEfforts: index===2 ? [] : ['low','high'].map(reasoningEffort=>({reasoningEffort})),defaultReasoningEffort:index===2?null:'low'}));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const {id,method,params}=JSON.parse(line);
  if (id==null) return;
  if (method==='model/list') return send({id,result:{data:models}});
  if (method==='thread/start'||method==='thread/resume') return send({id,result:{thread:{id:params.threadId||randomUUID()}}});
  if (method==='turn/start') {
    const {threadId,model,effort}=params,turnId=randomUUID();
    send({id,result:{turn:{id:turnId}}});
    send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',id:'final',phase:'final_answer',text:'执行端收到 '+model+' / '+effort}}});
    return send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
  }
  send({id,result:{}});
});`,
    { mode: 0o700 }
  );
  const app = new DuolaWorkApp({
    dbPath: path.join(dir, 'db'),
    filesDir: path.join(dir, 'files'),
    staticWebDir: path.resolve('dist/web'),
    autoImportAgentHub: false
  });
  for (const id of ['Alpha', 'Beta'])
    app.db.upsertMember({
      id,
      name: id,
      platformId: 'codex',
      driverKind: 'codex-app-server',
      location: 'local',
      config: { command },
      capabilities: {
        supportsIsolatedSessions: true,
        supportsSessionResume: true,
        supportsCancel: true,
        maxConcurrentRuns: 1
      },
      status: 'ready',
      statusMessage: ''
    });
  const first = app.threads.createThread({ title: '工作一', activeOwnerMemberId: 'Alpha' });
  app.threads.createThread({ title: '工作二', activeOwnerMemberId: 'Alpha' });
  const { url } = await app.listen(0, '127.0.0.1');
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(12000);
    const sidebar = (name: string) => page.locator('.channel-open-btn').filter({ hasText: name });
    const picker = page.getByRole('button', { name: '模型与推理强度' });
    const panel = page.getByRole('dialog', { name: '模型与推理强度' });
    const change = async (model: string, effort?: string) => {
      await picker.click();
      await panel.locator('input[name=inference-model][value="' + model + '"]').check();
      await page.waitForFunction(
        (value) =>
          document.querySelector<HTMLInputElement>('input[name=inference-model]:checked')?.value === value,
        model
      );
      if (effort) await panel.locator('input[name=inference-effort][value="' + effort + '"]').check();
      else assert.equal(await panel.getByRole('group', {name:'推理强度'}).count(), 0);
      await panel.getByText('应用到下次执行').click();
      await panel.waitFor({ state: 'hidden' });
    };
    await page.goto(url);
    await sidebar('工作一').click();
    await change('deep', 'high');
    await page.reload();
    await picker.filter({ hasText: 'deep · 高' }).waitFor();
    await page.locator('.chat-composer textarea').fill('返回执行端收到的选项');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.locator('.message-markdown').filter({ hasText: '执行端收到 deep / high' }).waitFor();
    assert.deepEqual(app.registry.listAttempts({ threadId: first.id })[0].inference, {
      model: 'deep',
      effort: 'high'
    });
    let releaseSwitch!: () => void;
    const delayedOwner = new Promise<void>(resolve => {releaseSwitch = resolve;});
    await page.route('**/threads/*/owner', async route => {await delayedOwner; await route.continue();}, {times:1});
    await page.locator('.chat-composer textarea').fill('先保留这段草稿');
    await page.getByTitle('由 Beta 接手当前对话', { exact: true }).click();
    try {
      await page.getByText('正在切换成员…',{exact:true}).waitFor();
      assert.equal(await picker.count(),0);
      assert.ok(await page.getByRole('button',{name:'发送消息',exact:true}).isDisabled());
    } finally {releaseSwitch();}

    await picker.filter({ hasText: /^模型$/ }).waitFor();
    await change('fixed');
    await page.getByTitle('由 Alpha 接手当前对话', { exact: true }).click();
    await picker.filter({ hasText: 'deep · 高' }).waitFor();
    await sidebar('工作二').click();
    await picker.filter({ hasText: /^模型$/ }).waitFor();
    await sidebar('工作一').click();
    const invalid = await page.request.put(url + '/api/v2/threads/' + first.id + '/members/Alpha/inference', {
      data: { model: 'deep', effort: 'unknown' }
    });
    assert.equal(invalid.status(), 400);
    assert.equal(app.registry.getPreference(first.id, 'Alpha')?.effort, 'high');
    await picker.click();
    await panel.getByRole('group', {name: '推理强度'}).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.chat-composer textarea').fill('保留输入的草稿');
    let catalogRequests = 0;
    await page.route('**/inference?catalog=*', route => {catalogRequests++;return route.abort('internetdisconnected');});
    await picker.click();
    await panel.getByRole('group',{name:'推理强度'}).waitFor();
    assert.equal(catalogRequests,0);
    assert.equal(await panel.getByRole('alert').count(),0);
    await page.keyboard.press('Escape');
    await sidebar('工作二').click();
    await page.locator('.chat-composer textarea').fill('冷启动失败也保留草稿');
    await picker.click();
    await panel.getByRole('alert').waitFor();
    assert.equal(await page.locator('.chat-composer textarea').inputValue(),'冷启动失败也保留草稿');
    await page.unroute('**/inference?catalog=*');
    await panel.getByRole('button',{name:'重试'}).click();
    await panel.getByRole('group',{name:'推理强度'}).waitFor();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 800 });
    await picker.click();
    await panel.getByRole('group', {name:'推理强度'}).waitFor();
    const bounds = await panel.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, JSON.stringify(bounds));
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden' });
  } finally {
    await browser.close();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
