import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatImageDelivery } from '../src/server/drivers/chat-image-delivery.js';
import { DuolaWorkApp } from '../src/server/app.js';
import { SPACE_AND_DUOLABASE_TOOLS, type TurnDispatchInput } from '../src/server/drivers/types.js';

test('Chat delivery preserves workspace exports, multiple native outputs, tool receipts and individual upload failures', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-images-'));
  const app = new DuolaWorkApp({ dbPath: path.join(cwd, 'test.sqlite'), filesDir: path.join(cwd, 'files'), autoImportAgentHub: false });
  try {
    const id = 'test-images';
    app.db.upsertMember({ id, name: 'Runner', platformId: 'mock', driverKind: 'mock', location: 'local', config: {},
      status: 'ready', statusMessage: '', capabilities: { supportsCancel: true, supportsSessionResume: true, supportsIsolatedSessions: true, maxConcurrentRuns: 1 } });
    const t = app.threads.createThread({ title: 'Test', activeOwnerMemberId: id });
    const inputs: TurnDispatchInput = { member: app.db.getMember(id)!, cwd, scopeKey: 'test', attemptId: 'a', nativeSessionId: 'n',
      prompt: '', dynamicTools: SPACE_AND_DUOLABASE_TOOLS, onToolCall: async (_tool, args) => app.space.saveChatImageBuffer({
        threadId: t.id, name: String(args.name), buffer: Buffer.from(String(args.dataBase64), 'base64'), uploaderId: id, reuseIdentical: true
      }) };
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/iNQAAAAASUVORK5CYII=', 'base64');
    const png2 = Buffer.concat([png, Buffer.from([0])]);
    fs.mkdirSync(path.join(cwd, '图表'));
    const first = path.join(cwd, '图表', '第一张.png');
    fs.writeFileSync(first, png);
    const sources = [{ id: 'a', dataBase64: png.toString('base64') }, { id: 'b', dataBase64: png2.toString('base64') }];
    const reply = await new ChatImageDelivery(inputs).finish('![最终图](图表/第一张.png)', sources);
    const urls = [...reply.matchAll(/!\[[^\]]*\]\((\/api\/v2\/chat-images\/[^)]+)\)/g)].map(x => x[1]);
    assert.equal(urls.length, 2);
    assert.equal(new Set(urls).size, 2);
    const count = () => app.db.sqlite.prepare('SELECT count(*) AS n FROM v2_chat_images WHERE thread_id=?').get(t.id)?.n;
    assert.equal(count(), 2);
    const downloadLink = await new ChatImageDelivery(inputs).finish('[查看图表](<图表/第一张.png>)');
    assert.equal(downloadLink, '![查看图表](' + urls[0] + ')');
    const replay = await new ChatImageDelivery(inputs).finish('已生成', sources);
    assert.ok(urls.every(url => replay.includes(url)));
    assert.equal(count(), 2);
    const archiveOnly = new ChatImageDelivery(inputs);
    archiveOnly.toolResult('space_save_file', {name:'已归档.png'}, {markdownEmbed:'![归档](/api/v2/space/files/file_archived)'});
    assert.equal(await archiveOnly.finish('已归档'), '已归档');
    const explicit = new ChatImageDelivery(inputs);
    explicit.toolResult('chat_attach_image', { name: '已交付.png' }, { markdownEmbed: '![完成]('+urls[0]+')' });
    assert.ok((await explicit.finish('上传完成')).includes(urls[0]));
    const missing = await new ChatImageDelivery({ ...inputs, onToolCall: async () => { throw Error('offline'); } }).finish('图片', [sources[0]]);
    assert.match(missing, /未能上传/);
    const mixed = await new ChatImageDelivery(inputs).finish('![缺失](不存在.png)\n![能打开](图表/第一张.png)');
    assert.ok(mixed.includes(urls[0]) && mixed.includes('1 个图片引用未能上传'));
    const sample = '```markdown\n![说明](图表/第一张.png)\n```\n![网站](https://example.com/chart.png)';
    assert.equal(await new ChatImageDelivery(inputs).finish(sample), sample);
  } finally { await app.close(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('Codex adapter upgrades legacy toolsets, resumes compatible sessions, and delivers native image events with text-only replies', async () => {
  const { CodexAppServerDriver } = await import('../src/server/drivers/codex-driver.js');
  const { runWithChatImages } = await import('../src/server/drivers/chat-image-delivery.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-codex-session-'));
  const bin = path.join(cwd, 'codex-fixture.cjs');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/iNQAAAAASUVORK5CYII=';
  fs.writeFileSync(bin, `#!${process.execPath}
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n');
readline.createInterface({ input:process.stdin }).on('line', line=>{
  const {id,method,params}=JSON.parse(line);
  if (id == null) return;
  if (method === 'thread/start' || method === 'thread/resume') {
    send({id,result:{thread:{id:method === 'thread/start' ? randomUUID() : params.threadId}}});
  } else if (method === 'turn/start') {
    send({id,result:{turn:{id:'test-turn'}}});
    const notify=(method, fields)=>send({method,params:{threadId:params.threadId,turnId:'test-turn',...fields}});
    notify('item/completed',{item:{type:'imageGeneration',id:'generated',status:'completed',result:'${png}'}});
    notify('item/completed',{item:{type:'agentMessage',id:'answer',phase:'final_answer',text:'已经生成。'}});
    notify('turn/completed',{turn:{id:'test-turn',status:'completed'}});
  } else send({id,result:{}});
});`, { mode: 0o700 });
  try {
    const driver = new CodexAppServerDriver();
    const member = { createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), id:'runner',name:'Codex',platformId:'codex',driverKind:'codex-app-server' as const,
      location:'local' as const, status:'ready' as const,statusMessage:'',config:{command:bin},
      capabilities:{supportsCancel:true,supportsSessionResume:true,supportsIsolatedSessions:true,maxConcurrentRuns:1} };
    const dynamicTools = SPACE_AND_DUOLABASE_TOOLS.filter(t => t.name === 'chat_attach_image');
    const base = { member, scopeKey:'test', cwd, dynamicTools };
    let previous = { nativeSessionId:'old-session', bridgeMeta:{} as Record<string,unknown> };
    for (const phase of ['upgrade', 'resume', 'changed-schema']) {
      const tools = phase === 'changed-schema' ? dynamicTools.map(t => ({...t, description:t.description + ' Updated.'})) : dynamicTools;
      const session = await driver.ensureSession({ ...base, dynamicTools:tools, existingNativeSessionId:previous.nativeSessionId,
        existingBridgeMeta:previous.bridgeMeta });
      assert.equal(session.resumed, phase === 'resume');
      assert.equal(session.nativeSessionId === previous.nativeSessionId, phase === 'resume');
      const result = await runWithChatImages(driver, { ...base, dynamicTools:tools, nativeSessionId:session.nativeSessionId,
        bridgeMeta:session.bridgeMeta, attemptId:phase, prompt:'Fixture', onToolCall:async (name,args)=>{
          assert.equal(name,'chat_attach_image');
          assert.equal(args.dataBase64,png);
          return {url:'/api/v2/chat-images/img_fixture'};
        } });
      assert.match(result.text,/!\[生成图 1\]\(\/api\/v2\/chat-images\/img_fixture\)/);
      previous = {nativeSessionId:session.nativeSessionId,bridgeMeta:session.bridgeMeta!};
    }
  } finally { fs.rmSync(cwd, {recursive:true,force:true}); }
});
