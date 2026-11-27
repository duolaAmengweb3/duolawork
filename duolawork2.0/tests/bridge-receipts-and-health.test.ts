import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DuolaWorkApp } from '../src/server/app.js';
import { RemoteBridgeDriver, evaluateHubChannelMemberHealth } from '../src/server/drivers/remote-bridge-driver.js';

test('polling, subscriptions and verified webhooks use their own delivery evidence', () => {
  const now = Date.now();
  const health = (transport: string, extra = {}) => evaluateHubChannelMemberHealth(
    { transport, status: 'verified', pollSeconds: 15, authSeenAt: new Date(now).toISOString(), ...extra },
    { status: 'ready' }, { status: 'ready' }
  );
  for (const age of [0, 10000, 44000]) {
    assert.equal(health('muse-poll', { lastPollAt: new Date(now - age).toISOString() }).status, 'ready');
  }
  for (const age of [-60000, 46000, 86400000]) {
    assert.equal(health('muse-poll', { lastPollAt: new Date(now - age).toISOString() }).status, 'offline');
  }
  assert.equal(health('muse-poll', { subscriptionActive: true }).status, 'offline');
  assert.equal(health('dots-events').status, 'offline');
  assert.equal(health('dots-events', { subscriptionActive: true }).status, 'ready');
  assert.match(health('grok-webhook').message, /按需投递/);
  assert.equal(health('grok-webhook', { needsAuthorization: true }).status, 'auth_required');
});

test('reconciliation in a shared channel attributes interleaved and paged replies to their request and author', async () => {
  const request = { id: 'A', authorId: 'owner', createdAt: new Date().toISOString() };
  const turns = [
    { id: 'turnA', memberId: 'receiver', messageId: 'A', status: 'done' },
    { id: 'turnB', memberId: 'receiver', messageId: 'B', status: 'done' }
  ];
  const foreignReply = { id: 'b', authorId: 'receiver', replyTo: 'B', usageTurnId: 'turnB', body: 'response B' };
  let page: Record<string, unknown> = {};
  let olderPage: Record<string, unknown> = {};
  const hub = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    assert.equal(url.searchParams.get('id'), 'shared');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(url.searchParams.has('before') ? olderPage : page));
  });
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-receipt-'));
  try {
    const port = (hub.address() as {port: number}).port;
    const config = path.join(dir, 'hub.json');
    fs.writeFileSync(config, JSON.stringify({endpoint: `http://127.0.0.1:${port}`, adminKey: 'fixture'}));
    const member = { id: 'receiver', config: { agentHubConfigPath: config } };
    const driver = new RemoteBridgeDriver();
    const reconcile = (id: string) => driver.reconcileAttempt(member, {
      bridgeMeta: { bridgeChannelId: 'shared', bridgeMessageId: id }
    });
    page = { activity: turns, messages: [request, foreignReply,
      { ...foreignReply, replyTo: 'A' }, { ...foreignReply, replyTo: null, authorId: 'other', usageTurnId: 'turnA' },
      { id: 'chat', authorId: 'receiver', body: 'unrelated chat' }] };
    const waiting = await reconcile('A');
    assert.equal(waiting.state, 'still_running');
    assert.equal(waiting.waitingForReceipt, true);
    assert.equal((await reconcile('B')).text, 'response B');
    for (const correlation of [{ replyTo: 'A' }, { usageTurnId: 'turnA' }]) {
      page = { activity: turns, messages: [request, foreignReply, { id: 'a', authorId: 'receiver', body: 'response A', ...correlation }] };
      assert.equal((await reconcile('A')).text, 'response A');
    }
    olderPage = page;
    page = { before: 20, messages: [foreignReply], activity: turns };
    assert.equal((await reconcile('A')).text, 'response A');
    page = { activity: [{...turns[0], status:'failed'}], messages: [request, foreignReply] };
    assert.equal((await reconcile('A')).state, 'failed');
  } finally {
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a running workbench refreshes receiver state and leaves node-owned members alone', async () => {
  const id = 'test-polling-member';
  let lastPollAt = new Date().toISOString();
  let available = true;
  const hub = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (!available) res.writeHead(503);
    res.end(JSON.stringify(req.url === '/v2/workspace' ? {
      members: [{ id, name: '接收端' }, { id: 'unregistered', name: '未导入成员' }], connections: [{ id, transport: 'muse-poll', status: 'verified', pollSeconds: 15, lastPollAt }]
    } : { items: [] }));
  });
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-refresh-'));
  const port = (hub.address() as {port: number}).port;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({endpoint: `http://127.0.0.1:${port}`, adminKey: 'fixture'}));
  const app = new DuolaWorkApp({ dbPath: path.join(dir, 'app.sqlite'), filesDir: path.join(dir, 'files'),
    worktreesRoot: path.join(dir, 'worktrees'), agentHubDir: dir, autoImportAgentHub: false, refreshRegisteredHubHealth: true });
  app.db.upsertMember({
    id, name: '接收端', driverKind: 'remote-bridge', platformId: 'muse', location: 'remote-bridge',
    status: 'offline', statusMessage: '等待同步', config: {remoteMode: 'hub-channel', hubTransport: 'muse-poll'},
    capabilities: {supportsIsolatedSessions: false, supportsSessionResume: false, supportsCancel: false, maxConcurrentRuns: 1}
  });
  try {
    const { url } = await app.listen(0, '127.0.0.1');
    await (await fetch(url + '/api/v2/bootstrap')).json();
    assert.equal(app.db.getMember(id)?.status, 'ready');
    assert.equal(app.db.getMember('unregistered'), null);
    lastPollAt = new Date(Date.now() - 60000).toISOString();
    const deadline = Date.now() + 20000;
    while (app.db.getMember(id)?.status === 'ready' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.equal(app.db.getMember(id)?.status, 'offline');
    lastPollAt = new Date().toISOString();
    await app.syncLegacyWorkspaceMembersReadOnly(true);
    assert.equal(app.db.getMember(id)?.status, 'ready');
    available = false;
    await app.syncLegacyWorkspaceMembersReadOnly(true);
    assert.match(app.db.getMember(id)!.statusMessage, /无法从 Hub 确认/);
    assert.equal(app.db.getMember(id)?.status, 'offline');
    app.db.upsertMember({ ...app.db.getMember(id)!, driverKind: 'remote-node', status: 'ready' });
    await app.syncLegacyWorkspaceMembersReadOnly(true);
    assert.equal(app.db.getMember(id)?.status, 'ready');
  } finally {
    await app.close();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
