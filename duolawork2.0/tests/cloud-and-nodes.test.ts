import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DuolaWorkApp, hashPassword } from '../src/server/app.js';
import { decryptSettingSecret, encryptSettingSecret } from '../src/server/duolabase-client.js';
import { MockDriver } from '../src/server/drivers/mock-driver.js';
import { DuolaWorkNodeRunner } from '../src/node-runner/index.js';
import { EXCLUDED_CLAUDE_VPS_MEMBER_ID } from '../src/shared/types.js';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('CLOUD-01: Cloud Auth Gate (401, scrypt login, brute-force 429, CSRF 403, magic code & session revoke)', async () => {
  const tmpDir = createTempDir('dw2-cloud-auth-');
  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDir, 'cloud.sqlite'),
    filesDir: path.join(tmpDir, 'files'),
    lockFilePath: path.join(tmpDir, 'server.lock'),
    autoImportAgentHub: false,
    auth: {
      required: true,
      adminPasswordHash: hashPassword('StrongPass#2026!'),
      apiBearerToken: 'api_test_token_999'
    }
  });

  try {
    const { url } = await app.listen(0, '127.0.0.1');

    // 1. Health is public, protected APIs reject 401
    const health = await fetch(`${url}/api/v2/health`).then((r) => r.json());
    assert.equal(health.status, 'ok');
    assert.equal(health.authRequired, true);

    const unauthRes = await fetch(`${url}/api/v2/bootstrap`);
    assert.equal(unauthRes.status, 401);

    // 2. Bearer API token works for automation
    const bearerRes = await fetch(`${url}/api/v2/bootstrap`, {
      headers: { Authorization: 'Bearer api_test_token_999' }
    });
    assert.equal(bearerRes.status, 200);

    // 3. Wrong password 5 times triggers 429 rate-limit lockout
    for (let i = 0; i < 5; i++) {
      const bad = await fetch(`${url}/api/v2/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
        body: JSON.stringify({ password: 'wrong' })
      });
      assert.equal(bad.status, 401);
    }
    const locked = await fetch(`${url}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({ password: 'StrongPass#2026!' })
    });
    assert.equal(locked.status, 429);

    // 4. Valid login from clean IP sets HttpOnly Cookie
    const loginRes = await fetch(`${url}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.10' },
      body: JSON.stringify({ password: 'StrongPass#2026!', deviceName: 'Mac Chrome' })
    });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get('set-cookie') || '';
    assert.match(setCookie, /dw2_session=/);
    assert.match(setCookie, /HttpOnly/i);
    const cookiePair = setCookie.split(';')[0];

    // 5. Cookie accesses protected APIs and blocks cross-origin CSRF POST
    const okBoot = await fetch(`${url}/api/v2/bootstrap`, { headers: { Cookie: cookiePair } });
    assert.equal(okBoot.status, 200);

    const csrfRes = await fetch(`${url}/api/v2/auth/magic-code`, {
      method: 'POST',
      headers: {
        Cookie: cookiePair,
        Origin: 'https://evil.example.com',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });
    assert.equal(csrfRes.status, 403);

    // 6. Generate 6-digit Magic Login Code and redeem on a second device ("iPhone")
    const codeRes = await fetch(`${url}/api/v2/auth/magic-code`, {
      method: 'POST',
      headers: { Cookie: cookiePair, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'iPhone Safari' })
    });
    assert.equal(codeRes.status, 201);
    const { code } = await codeRes.json();
    assert.match(String(code), /^\d{6}$/);

    const phoneLogin = await fetch(`${url}/api/v2/auth/magic-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    assert.equal(phoneLogin.status, 200);
    const phoneCookie = (phoneLogin.headers.get('set-cookie') || '').split(';')[0];
    const phoneData = await phoneLogin.json();

    // Reusing consumed code fails 401
    const replayCode = await fetch(`${url}/api/v2/auth/magic-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    assert.equal(replayCode.status, 401);

    // 7. Revoking iPhone session immediately invalidates its Cookie
    const sessList = await fetch(`${url}/api/v2/auth/sessions`, { headers: { Cookie: cookiePair } }).then((r) => r.json());
    assert.equal(sessList.sessions.length, 2);

    await fetch(`${url}/api/v2/auth/sessions/${encodeURIComponent(phoneData.session.id)}`, {
      method: 'DELETE',
      headers: { Cookie: cookiePair }
    });
    const phoneAfterRevoke = await fetch(`${url}/api/v2/bootstrap`, { headers: { Cookie: phoneCookie } });
    assert.equal(phoneAfterRevoke.status, 401);
  } finally {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLOUD-02 & CLOUD-03: Multipart binary file upload, encrypted DuolaBase secret & SSE Last-Event-ID replay', async () => {
  const tmpDir = createTempDir('dw2-cloud-files-');
  const prevMaster = process.env.DUOLAWORK_MASTER_KEY;
  process.env.DUOLAWORK_MASTER_KEY = 'test-master-key-32bytes-secret!';

  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDir, 'cloud.sqlite'),
    filesDir: path.join(tmpDir, 'cloud-files'),
    autoImportAgentHub: false
  });
  app.db.upsertMember({
    id: 'mem_m1',
    name: 'MockMember',
    platformId: 'mock',
    driverKind: 'mock',
    location: 'local',
    capabilities: { supportsIsolatedSessions: true, supportsSessionResume: true, supportsCancel: true, maxConcurrentRuns: 2 },
    status: 'ready',
    statusMessage: 'ready',
    config: {}
  });

  try {
    // 1. Master-key AES-256-GCM encryption round-trip for DuolaBase settings token
    const cipher = encryptSettingSecret('db_live_secret_token_xyz');
    assert.ok(cipher.startsWith('enc:v1:'));
    assert.equal(cipher.includes('db_live_secret_token_xyz'), false);
    assert.equal(decryptSettingSecret(cipher), 'db_live_secret_token_xyz');

    const { url } = await app.listen(0, '127.0.0.1');
    const thread = app.threads.createThread({ title: '云存储测试', activeOwnerMemberId: 'mem_m1' });

    // 2. Multipart binary upload -> download roundtrip
    const form = new FormData();
    form.append('file', new Blob(['云端二进制测试内容_42'], { type: 'text/plain' }), 'cloud-doc.txt');
    const upRes = await fetch(`${url}/api/v2/threads/${encodeURIComponent(thread.id)}/space/files/upload`, {
      method: 'POST',
      body: form
    });
    assert.equal(upRes.status, 201);
    const upData = await upRes.json();
    assert.equal(upData.file.name, 'cloud-doc.txt');

    const dlRes = await fetch(`${url}/api/v2/space/files/${encodeURIComponent(upData.file.id)}`);
    assert.equal(dlRes.status, 200);
    assert.equal(await dlRes.text(), '云端二进制测试内容_42');

    // 3. Emit 2 events, then connect SSE with `lastEventId=1` and verify buffered catch-up + X-Accel-Buffering: no
    app.threads.emit({ type: 'thread.custom_ping', threadId: thread.id, payload: { step: 1 } });
    app.threads.emit({ type: 'thread.custom_ping', threadId: thread.id, payload: { step: 2 } });

    const ac = new AbortController();
    const sseRes = await fetch(`${url}/api/v2/events?lastEventId=1`, { signal: ac.signal });
    assert.equal(sseRes.headers.get('x-accel-buffering'), 'no');
    const reader = sseRes.body!.getReader();
    let collected = '';
    for (let i = 0; i < 4; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      collected += Buffer.from(value).toString('utf8');
      if (collected.includes('"step":2')) break;
    }
    ac.abort();
    assert.match(collected, /"type":"connected"/);
    assert.match(collected, /"step":2/);
  } finally {
    if (prevMaster === undefined) delete process.env.DUOLAWORK_MASTER_KEY;
    else process.env.DUOLAWORK_MASTER_KEY = prevMaster;
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLOUD-04: Universal Execution NodeHub + outbound DuolaWorkNodeRunner (streaming, cloud sandbox 403, fs allowlist, offline guard, outbox replay & croner)', async () => {
  const tmpDir = createTempDir('dw2-cloud-node-');
  const workspaceDir = path.join(tmpDir, 'allowed-repo');
  const secretDir = path.join(tmpDir, 'forbidden-dir');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(secretDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'hello.ts'), 'export const ok = true;\n');

  const mcpCalls: string[] = [];
  let interruptDuringTool: (() => Promise<void>) | null = null;
  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDir, 'cloud.sqlite'),
    filesDir: path.join(tmpDir, 'files'),
    autoImportAgentHub: false,
    externalMcpCaller: async (toolName) => {
      mcpCalls.push(toolName);
      if (interruptDuringTool) await interruptDuringTool();
      return { items: [{ id: 'conn_1', name: 'Gmail' }] };
    }
  });

  const nodeMockDriver = new MockDriver();
  let runner: DuolaWorkNodeRunner | null = null;

  try {
    const { url } = await app.listen(0, '127.0.0.1');

    // 1. Pair a new Cloud/Local Execution Node via 6-digit pair code
    const pairCodeRes = await fetch(`${url}/api/v2/nodes/pair-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'TestNode-Alpha', kind: 'cloud' })
    });
    assert.equal(pairCodeRes.status, 201);
    const { code } = await pairCodeRes.json();

    const pairRes = await fetch(`${url}/api/v2/nodes/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name: 'TestNode-Alpha', kind: 'cloud', platform: 'linux' })
    });
    assert.equal(pairRes.status, 201);
    const { node, nodeToken } = await pairRes.json();
    assert.ok(nodeToken.startsWith('dwn_'));

    // 2. Start outbound NodeRunner hosting a real member + verifying excluded ClaudeVPS is ignored
    const outboxPath = path.join(tmpDir, 'node-outbox.json');
    runner = new DuolaWorkNodeRunner({
      serverUrl: url,
      nodeToken,
      name: 'TestNode-Alpha',
      kind: 'cloud',
      allowWorkspaceBrowse: true,
      allowedWorkspaceRoots: [workspaceDir],
      outboxPath,
      mockDriver: nodeMockDriver,
      members: [
        { id: 'member_waiting_for_auth', name: 'Awaiting login', platformId: 'fixture', localDriverKind: 'mock', status: 'ready' },
        {
          id: 'mem_remote_node_agent',
          name: 'RemotePersonalAgent',
          platformId: 'antigravity',
          localDriverKind: 'mock'
        },
        {
          id: EXCLUDED_CLAUDE_VPS_MEMBER_ID,
          name: 'ClaudeVPS',
          platformId: 'claude-code',
          localDriverKind: 'mock'
        }
      ]
    });
    await runner.start();

    // Wait briefly for node.hello DB registration
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(app.nodeHub.isNodeOnline(node.id), true);
    const registered = app.db.getMember('mem_remote_node_agent');
    assert.ok(registered);
    assert.equal(registered.driverKind, 'remote-node');
    assert.equal(registered.nodeId, node.id);
    assert.equal(app.db.getMember(EXCLUDED_CLAUDE_VPS_MEMBER_ID), null, 'ClaudeVPS must NEVER be registered');

    // 3. End-to-end turn over WebSocket: streaming delta + cloud sandbox tool call + 403 on vault_reveal!
    let vaultRevealBlocked = false;
    nodeMockDriver.handlers.set('mem_remote_node_agent', async (inp) => {
      const conns = await inp.onToolCall?.('duolabase:connector_list', {});
      assert.ok(conns);
      try {
        await inp.onToolCall?.('duolabase:vault_reveal', { credentialId: 'v1' });
      } catch (err) {
        if (String((err as Error).message).includes('明文密钥') || String((err as Error).message).includes('禁止')) {
          vaultRevealBlocked = true;
        }
      }
      return { text: '来自跨机 Execution Node 的稳定回复！' };
    });

    const thread = app.threads.createThread({
      title: '跨机节点实测',
      activeOwnerMemberId: 'mem_remote_node_agent'
    });
    const turnOut = await app.threads.sendUserMessage({
      threadId: thread.id,
      body: '帮我查连接器并汇报'
    });
    assert.equal(turnOut.agentMessage.turnStatus, 'completed');
    assert.equal(turnOut.agentMessage.body, '来自跨机 Execution Node 的稳定回复！');
    assert.equal(vaultRevealBlocked, true, 'Cloud sandbox MUST block vault_reveal from remote node');
    assert.ok(mcpCalls.includes('connector_list'));

    // Sever the actual runner socket after accepting a tool call but before delivering its result.
    const startingCalls = mcpCalls.length;
    const priorDispatches = nodeMockDriver.recordedPrompts.length;
    const disconnect = () => (runner as unknown as { ws: { terminate(): void } }).ws.terminate();
    interruptDuringTool = async () => {
      interruptDuringTool = null;
      disconnect();
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(app.nodeHub.isNodeOnline(node.id), false);
      const interrupted = app.threads.listMessages(thread.id).at(-1)!;
      assert.equal(interrupted.turnStatus, 'running');
      assert.equal(interrupted.activity?.phase, 'reconnecting');
    };
    nodeMockDriver.handlers.set('mem_remote_node_agent', async input => {
      const original = await input.onToolCall!('duolabase:connector_list', {});
      assert.ok(original);
      // A second outage occurs before a different tool is submitted.
      disconnect();
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.ok(await input.onToolCall!('duolabase:connector_list', {}));
      return { text: '断线后两次工具回执都已收到' };
    });
    const resumed = await app.threads.sendUserMessage({ threadId: thread.id, body: '断线续执行', timeoutMs: 12_000 });
    assert.equal(resumed.agentMessage.body, '断线后两次工具回执都已收到');
    assert.equal(nodeMockDriver.recordedPrompts.length - priorDispatches, 1);
    assert.equal(mcpCalls.length - startingCalls, 2);

    // 4. Remote workspace browse allowlist check + thread workspace-files node proxy
    const allowedLs = await fetch(
      `${url}/api/v2/nodes/${encodeURIComponent(node.id)}/fs?path=${encodeURIComponent(workspaceDir)}`
    ).then((r) => r.json());
    assert.equal(allowedLs.entries.some((e: any) => e.name === 'hello.ts'), true);

    await fetch(`${url}/api/v2/threads/${encodeURIComponent(thread.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: workspaceDir, workspaceNodeId: node.id })
    });
    const proxiedThreadWs = await fetch(
      `${url}/api/v2/threads/${encodeURIComponent(thread.id)}/workspace-files`
    ).then((r) => r.json());
    assert.equal(proxiedThreadWs.unconfigured, false);
    assert.equal(proxiedThreadWs.entries.some((e: any) => e.name === 'hello.ts'), true);

    const blockedLs = await fetch(
      `${url}/api/v2/nodes/${encodeURIComponent(node.id)}/fs?path=${encodeURIComponent(secretDir)}`
    );
    assert.equal(blockedLs.status, 500);

    // 5. Croner scheduled task triggers remote-node member cleanly
    const sched = app.tasks.createOrUpdateTask({
      sourceThreadId: thread.id,
      title: '云端 24x7 定时测试',
      kind: 'scheduled',
      cronExpr: '0 8 * * *',
      timezone: 'Asia/Shanghai',
      leadMemberId: 'mem_remote_node_agent',
      startImmediately: false,
      spec: { goal: '产出云端早报', steps: [] }
    });
    app.db.sqlite.prepare(`UPDATE v2_tasks SET created_at = '2026-11-24T00:00:00.000Z' WHERE id = ?`).run(sched.task.id);
    const runs = await app.scheduler.tick(new Date('2026-11-26T00:00:00.000Z'), { awaitRuns: true });
    assert.equal(runs.length, 1);
    const settledRun = app.tasks.getRun(runs[0].id)!;
    assert.equal(settledRun.status, 'completed');

    app.db.upsertMember({ ...app.db.getMember('member_waiting_for_auth')!, status: 'auth_required', statusMessage: '需要重新登录' });
    // 6. Offline node guard + Outbox reconnect replay (zero lost reply, zero duplicate LLM call!)
    runner.stop();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(app.nodeHub.isNodeOnline(node.id), false);

    await assert.rejects(
      () => app.threads.sendUserMessage({ threadId: thread.id, body: '离线消息测试' }),
      /NODE_OFFLINE/
    );

    // Simulate an attempt that completed on the Node while disconnected (stored in outbox.json)
    const replayAttId = 'att_replay_node_1';
    const replayMsgId = 'msg_replay_node_1';
    const nowIso = new Date().toISOString();
    app.db.sqlite
      .prepare(
        `INSERT INTO v2_dispatch_attempts (
          id, target_kind, target_id, thread_id, member_id, idempotency_key, scope_key,
          status, slot_held, prompt_digest, prompt_bytes, handoff_bytes, usage_json, dispatched_at
        ) VALUES (?, 'thread_message', ?, ?, 'mem_remote_node_agent', 'idk_replay_1', 'sc_1', 'reconciling', 0, 'd', 10, 0, ?, ?)`
      )
      .run(
        replayAttId,
        replayMsgId,
        thread.id,
        JSON.stringify({ workbenchDispatches: 1, nativeTurns: 0, providerUsage: { observable: false, modelRequests: null, inputTokens: null, cachedInputTokens: null, uncachedInputTokens: null, outputTokens: null, totalTokens: null } }),
        nowIso
      );
    app.db.sqlite
      .prepare(
        `INSERT INTO v2_thread_messages (id, thread_id, seq, author_kind, author_id, target_member_id, attempt_id, body, artifact_refs_json, turn_status, created_at, updated_at)
         VALUES (?, ?, 99, 'agent', 'mem_remote_node_agent', 'mem_remote_node_agent', ?, '', '[]', 'running', ?, ?)`
      )
      .run(replayMsgId, thread.id, replayAttId, nowIso, nowIso);

    fs.writeFileSync(
      outboxPath,
      JSON.stringify([
        {
          attemptId: replayAttId,
          ok: true,
          text: '断线重连后由本地 Outbox 自动补交的完整答复',
          nativeSessionId: 'ns_replayed',
          createdAt: Date.now()
        }
      ])
    );

    // Reconnect runner -> automatically replays outbox -> settles DB & receives turn.ack!
    runner = new DuolaWorkNodeRunner({
      serverUrl: url,
      nodeToken,
      name: 'TestNode-Alpha',
      kind: 'cloud',
      outboxPath,
      mockDriver: nodeMockDriver,
      members: [
        { id: 'member_waiting_for_auth', name: 'Awaiting login', platformId: 'fixture', localDriverKind: 'mock', status: 'ready' },
        {
          id: 'mem_remote_node_agent',
          name: 'RemotePersonalAgent',
          platformId: 'antigravity',
          localDriverKind: 'mock'
        }
      ]
    });
    await runner.start();
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(app.db.getMember('member_waiting_for_auth')?.status, 'auth_required');
    assert.equal(app.db.getMember('member_waiting_for_auth')?.statusMessage, '需要重新登录');
    const recoveredMsg = app.threads.getMessage(replayMsgId)!;
    assert.equal(recoveredMsg.turnStatus, 'completed');
    assert.equal(recoveredMsg.body, '断线重连后由本地 Outbox 自动补交的完整答复');
  } finally {
    runner?.stop();
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
