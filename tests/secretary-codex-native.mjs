import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startHarness } from './v1-harness.mjs';
import { CodingManager } from '../local/coding-manager.mjs';
import { ChatSessions } from '../local/chat-sessions.mjs';

if (!process.argv.includes('--run-native-acceptance')) throw Error('Requires --run-native-acceptance');
const h = await startHarness();
const manager = new CodingManager({ dataDir: path.join(h.directory, 'local'), config: { endpoint: h.base, adminKey: h.key }, interval: 1000 });
const sessions = new ChatSessions({ coding: manager, dsh: {}, ag: {} });
const evidence = { at: new Date().toISOString(), isolatedHub: true, realNativeCodex: true,
  newDedicatedNativeTestConversation: true, existingUserConversationsTouched: false,
  productionSecretaryChanged: false, claudeTouched: false, checks: [] };
const q = value => "'" + value.replaceAll("'", "'\\''") + "'";
function stage(name) {
  const entry = { name, at: new Date().toISOString() };
  (evidence.stages ||= []).push(entry);
  console.log(JSON.stringify({ stage: entry }));
}
async function wait(fn, label) {
  for (let i = 0; i < 240; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw Error(label + ' timed out');
}
async function records(kind) {
  const rows = await h.db.prepare('SELECT body FROM hub_v2_records WHERE workspace_id=? AND kind=?').bind('v1-test', kind).all();
  return rows.results.map(row => JSON.parse(row.body));
}
try {
  await h.request('/admin/action', { type: 'platform.create', payload: { id: 'codex', name: 'Codex' } });
  const account = (await h.request('/admin/action', { type: 'account.create', payload: { platformId: 'codex', label: '隔离秘书验收' } })).result;
  const member = (await h.request('/admin/action', { type: 'member.create', payload: { accountId: account.id, name: '验收秘书', mode: 'connector' } })).result;
  const peerA = await h.member('codex', '验收甲'), peerB = await h.member('codex', '验收乙');
  const channel = await h.command('channel.create', { name: '秘书代办验收', memberIds: [member.id], direct: true });
  const sourceA = await h.command('channel.create', { name: '预算沟通', memberIds: [peerA.id], direct: true });
  const sourceB = await h.command('channel.create', { name: '交付安排', memberIds: [peerA.id, peerB.id] });
  const factA = '预算标记-' + randomUUID().slice(0, 8), factB = '交付标记-' + randomUUID().slice(0, 8);
  await h.command('channel.post', { channelId: sourceA.id, body: '本次预算约定：' + factA });
  await h.command('channel.post', { channelId: sourceB.id, body: '本次交付约定：' + factB, mentions: [peerB.id] });
  const originalBody = '需要完整保留的正文\n' + randomUUID();
  const document = await h.command('channel.doc.create', { channelId: channel.id, title: '恢复验证资料', body: originalBody });
  assert.ok(!sourceA.memberIds.includes(member.id) && !sourceB.memberIds.includes(member.id));
  await h.request('/v2/management', { requestId: randomUUID(), expectedVersion: 0, memberId: member.id });
  stage('Isolated fixtures and owner secretary designation ready');
  await sessions.connect({ memberId: member.id });
  await manager.jobs.get(member.id);
  stage('Native account connection ready');
  sessions.start(); await manager.start();
  const project = path.join(h.directory, 'secretary-test-project');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'notes.txt'), 'Existing project must remain unchanged.\n');
  await manager.workingHost.read(async rpc => {
    const { thread } = await rpc.call('thread/start', { cwd: project, approvalPolicy: 'never', sandbox: 'danger-full-access', serviceName: 'hub-secretary-native-acceptance' });
    evidence.nativeThreadId = thread.id;
    stage('Dedicated native thread ready');
    const turn = async text => {
      let finish, fail;
      const ended = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      const timer = setTimeout(() => fail(Error('Native pairing turn timed out')), 180000);
      rpc.onNotification = (method, p) => {
        if (method === 'turn/completed' && p.threadId === thread.id) {
          clearTimeout(timer);
          p.turn.status === 'completed' ? finish() : fail(Error('Native pairing turn failed'));
        }
      };
      try { await rpc.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] }); await ended; }
      finally { clearTimeout(timer); }
    };
    const link = await sessions.createLink({ memberId: member.id, channelId: channel.id });
    const input = JSON.parse(link.skill.match(/传入：(\{.+?\})。/)[1]);
    const file = path.join(h.directory, 'link-input.json');
    await fs.writeFile(file, JSON.stringify(input), { mode: 0o600 });
    await turn('这是新建的专用隔离验收会话。请用自己的终端工具运行以下命令一次，成功后结束本轮。不读取登录资料、其他原生会话，不改项目，不输出配对码：\n' + [process.execPath, path.resolve('connectors/runtime/session-link.mjs')].map(q).join(' ') + ' < ' + q(file));
    await fs.rm(file);
    await wait(async () => { const result = await h.request('/v2/session-links?id=' + link.id); if (result.status === 'failed') throw Error(result.message); return result.status === 'completed'; }, 'Original session binding');
    assert.equal(manager.records[member.id].chatBindings[channel.id].sessionId, thread.id);
    stage('Native session linked and round trip verified');
    await wait(() => !manager.busy, 'Native idle');
    const groupName = '交付跟进-' + randomUUID().slice(0, 8);
    const prompt = `请帮我从「预算沟通」和「交付安排」两处聊天找出预算与交付约定，拉验收甲和验收乙建「${groupName}」群、由验收乙负责，把两处约定写进群说明，同时把当前聊天的「恢复验证资料」移入回收站再恢复确认正文没变，最后在这里告诉我结果。`;
    evidence.request = prompt;
    const started = Date.now();
    evidence.requestSentAt = new Date(started).toISOString();
    evidence.setupBeforeRequestMs = started - Date.parse(evidence.at);
    stage('Sending the single natural-language delegation');
    await h.command('channel.post', { channelId: channel.id, body: prompt });
    const reply = await wait(async () => {
      const result = await h.request('/v2/channel?id=' + channel.id);
      return result.messages.find(message => message.authorId === member.id && message.body.includes(groupName));
    }, 'Secretary natural-language delivery');
    await wait(() => !manager.busy, 'Native completion');
    evidence.elapsedMs = Date.now() - started;
    stage('Native delivery received');
    const overview = await h.request('/v2/management');
    const group = overview.channels.find(item => item.name === groupName);
    assert.ok(group, 'Secretary must create the requested group');
    assert.deepEqual(new Set(group.memberIds), new Set([peerA.id, peerB.id]));
    assert.equal(group.coordinatorId, peerB.id);
    assert.ok(group.description.includes(factA) && group.description.includes(factB), 'Facts must come from both separate chats');
    assert.equal(group.createdBy, member.id);
    assert.ok(overview.history.some(event => event.action === 'create_group' && event.actorId === member.id && event.channelId === group.id));
    const restored = (await records('channel_doc')).find(item => item.id === document.id);
    const trash = (await records('material_trash')).find(item => item.objectId === document.id);
    assert.equal(restored.body, originalBody); assert.equal(restored.version, 3); assert.equal(restored.status, document.status);
    assert.equal(trash.status, 'restored'); assert.equal(trash.deletedBy, member.id); assert.equal(trash.restoredBy, member.id);
    assert.equal(await fs.readFile(path.join(project, 'notes.txt'), 'utf8'), 'Existing project must remain unchanged.\n');
    evidence.reply = reply.body;
    evidence.group = { id: group.id, coordinatorId: group.coordinatorId, memberIds: group.memberIds, description: group.description, createdBy: group.createdBy };
    evidence.material = { documentId: document.id, version: restored.version, exactBodyPreserved: true, status: trash.status, deletedBy: trash.deletedBy, restoredBy: trash.restoredBy };
    evidence.checks.push('One ordinary Hub sentence wakes the real original Codex conversation', 'Secretary reads a separate DM and group it did not belong to, then creates a group with the requested members, coordinator and both source facts', 'Actual member identity recorded in the management audit; owner did not perform the delegated actions', 'Same native agent deletes and restores a fixture document, retaining ID and exact body with version 1 -> 2 -> 3', 'Original test-project file remains unchanged');
  });
  await h.request('/v2/management', { requestId: randomUUID(), expectedVersion: 1, memberId: null });
  evidence.finishedAt = new Date().toISOString(); evidence.passed = true;
  console.log(JSON.stringify({ passed: true, elapsedMs: evidence.elapsedMs, checks: evidence.checks }));
} catch (error) {
  evidence.failure = error.stack; console.error(error.message); process.exitCode = 1;
} finally {
  await sessions.stop(); await manager.stop(); await h.stop();
  await fs.writeFile('evidence/secretary-codex-native.json', JSON.stringify(evidence, null, 2) + '\n');
}
