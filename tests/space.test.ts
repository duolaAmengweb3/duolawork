import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DuolaWorkApp } from '../src/server/app.js';

function createAppWithWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-space-test-'));
  const wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'README.md'), '# Demo Workspace\n');
  fs.writeFileSync(path.join(wsDir, 'sub', 'notes.txt'), 'nested note\n');

  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDir, 'space.sqlite'),
    worktreesRoot: path.join(tmpDir, 'wt'),
    autoImportAgentHub: false
  });

  app.db.upsertMember({
    id: 'mem_codex',
    name: 'Codex',
    platformId: 'codex',
    driverKind: 'mock',
    location: 'local',
    capabilities: {
      supportsIsolatedSessions: true,
      supportsSessionResume: true,
      supportsCancel: true,
      maxConcurrentRuns: 2
    },
    status: 'ready',
    statusMessage: 'ready',
    config: {}
  });

  return {
    app,
    tmpDir,
    wsDir,
    cleanup: async () => {
      await app.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

test('New threads do NOT pre-create empty markdown placeholders; Agent <duolawork_artifact> lazily creates & binds', async () => {
  const { app, cleanup } = createAppWithWorkspace();
  try {
    const emptyThread = app.threads.createThread({
      title: '普通新对话',
      activeOwnerMemberId: 'mem_codex'
    });
    assert.equal(emptyThread.boundArtifactId, null, 'Empty thread must not pre-create empty .md');
    assert.equal(app.space.listSpace(emptyThread.id).items.length, 0);

    app.registry.mockDriver.handlers.set('mem_codex', async () => ({
      text: '已生成正式交付文档。\n<duolawork_artifact title="实施方案.md"># 方案内容\n第一版</duolawork_artifact>'
    }));

    const reply = await app.threads.sendUserMessage({
      threadId: emptyThread.id,
      body: '请产出实施方案文档'
    });
    assert.equal(reply.agentMessage.turnStatus, 'completed');

    const refreshed = app.threads.getThread(emptyThread.id)!;
    assert.ok(refreshed.boundArtifactId, 'Thread binds lazily once Agent produces an artifact');
    const items = app.space.listSpace(emptyThread.id).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'document');
    assert.equal(items[0].title, '实施方案.md');
  } finally {
    await cleanup();
  }
});

test('Collaboration Space HTTP & store CRUD: folders, multi-docs, file upload/download, links, pin, trash/restore, workspace browse', async () => {
  const { app, wsDir, cleanup } = createAppWithWorkspace();
  try {
    const thread = app.threads.createThread({
      title: '完整协作空间测试',
      activeOwnerMemberId: 'mem_codex',
      workspacePath: wsDir
    });
    const { url } = await app.listen(0, '127.0.0.1');

    // 1. Create folder
    const fldRes = await fetch(`${url}/api/v2/threads/${thread.id}/space/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '调研资料' })
    });
    assert.equal(fldRes.status, 201);
    const { folder } = await fldRes.json();

    // 2. Create multiple documents inside folder
    const docRes = await fetch(`${url}/api/v2/threads/${thread.id}/space/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '产品方案.md', content: '# v1 内容', folderId: folder.id })
    });
    assert.equal(docRes.status, 201);
    const { artifact } = await docRes.json();

    // 3. Upload local file & verify download + SHA-256
    const rawBytes = Buffer.from('hello-duolawork-2.0-binary-or-text');
    const expectedHash = createHash('sha256').update(rawBytes).digest('hex');
    const fileRes = await fetch(`${url}/api/v2/threads/${thread.id}/space/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '参考样本.txt',
        mimeType: 'text/plain',
        dataBase64: rawBytes.toString('base64'),
        folderId: folder.id
      })
    });
    assert.equal(fileRes.status, 201);
    const { file } = await fileRes.json();
    assert.equal(file.sha256, expectedHash);

    const dlRes = await fetch(`${url}/api/v2/space/files/${file.id}?download=1`);
    assert.equal(dlRes.status, 200);
    assert.equal(Buffer.from(await dlRes.arrayBuffer()).toString(), rawBytes.toString());

    // 4. Add external link & pin it
    const lnkRes = await fetch(`${url}/api/v2/threads/${thread.id}/space/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '设计规范', url: 'https://example.com/spec', note: '官网参考' })
    });
    assert.equal(lnkRes.status, 201);
    const { link } = await lnkRes.json();

    await fetch(`${url}/api/v2/space/items/link/${link.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pin' })
    });

    // 5. Verify list ordering (pinned link first) & folder deletion preserves items
    const space1 = await (await fetch(`${url}/api/v2/threads/${thread.id}/space`)).json();
    assert.equal(space1.items.length, 3);
    assert.equal(space1.items[0].id, link.id);
    assert.ok(space1.items[0].pinnedAt);

    await fetch(`${url}/api/v2/space/folders/${folder.id}`, { method: 'DELETE' });
    const spaceAfterDelFld = await (await fetch(`${url}/api/v2/threads/${thread.id}/space`)).json();
    assert.equal(spaceAfterDelFld.folders.length, 0);
    assert.equal(spaceAfterDelFld.items.length, 3, 'Deleting folder must preserve inner items at parent/root');

    // 6. Soft delete document -> appears in trash -> restore back to active items
    await fetch(`${url}/api/v2/space/items/document/${artifact.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete' })
    });
    const spaceTrashView = await (await fetch(`${url}/api/v2/threads/${thread.id}/space`)).json();
    assert.equal(spaceTrashView.items.length, 2);
    assert.equal(spaceTrashView.trash.length, 1);

    await fetch(`${url}/api/v2/space/items/document/${artifact.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'restore' })
    });
    const spaceRestored = await (await fetch(`${url}/api/v2/threads/${thread.id}/space`)).json();
    assert.equal(spaceRestored.items.length, 3);
    assert.equal(spaceRestored.trash.length, 0);

    // 7. Workspace directory browsing & path traversal protection
    const wsOk = await (await fetch(`${url}/api/v2/threads/${thread.id}/workspace-files`)).json();
    assert.equal(wsOk.entries.length, 2);
    assert.equal(wsOk.entries[0].name, 'sub');
    assert.equal(wsOk.entries[1].name, 'README.md');

    const wsSub = await (await fetch(`${url}/api/v2/threads/${thread.id}/workspace-files?subpath=sub`)).json();
    assert.equal(wsSub.entries[0].relPath, 'sub/notes.txt');

    const wsTraversal = await fetch(`${url}/api/v2/threads/${thread.id}/workspace-files?subpath=../../etc`);
    assert.equal(wsTraversal.status, 400);
  } finally {
    await cleanup();
  }
});

test('Thread pinning, Material <-> Task association + version warning + sources, Member usage, and DuolaBase zero-secret proxy', async () => {
  const { app, cleanup } = createAppWithWorkspace();
  try {
    const t1 = app.threads.createThread({ title: '常规对话 1', activeOwnerMemberId: 'mem_codex' });
    const t2 = app.threads.createThread({ title: '常规对话 2', activeOwnerMemberId: 'mem_codex' });

    const { task } = app.tasks.createOrUpdateTask({
      sourceThreadId: t1.id,
      title: '竞品调研',
      kind: 'once',
      leadMemberId: 'mem_codex',
      spec: {
        goal: '输出竞品对比',
        steps: [
          {
            stepOrder: 1,
            title: '撰写初稿',
            assigneeMemberId: 'mem_codex',
            brief: '写报告',
            acceptanceCriteria: '完整'
          }
        ]
      },
      startImmediately: false
    });

    app.registry.mockDriver.handlers.set('mem_codex', async () => ({
      text: '已记录产品说明书与官网链接 https://example.com/ref-spec'
    }));
    await app.threads.sendUserMessage({ threadId: t1.id, body: '请参考官网链接产出调研报告' });

    // Configure mock DuolaBase caller and secret token in settings (never exposed to UI status!)
    const superSecretToken = 'db_tok_super_secret_do_not_leak';
    app.db.setSetting('duolabase', {
      enabled: true,
      endpoint: 'https://duolabase.manyaitool.com/mcp',
      token: superSecretToken
    });
    app.setExternalMcpCaller(async (toolName, args) => {
      if (toolName === 'system_info') return { version: '0.5.8' };
      if (toolName === 'connector_list') {
        return {
          items: [
            {
              id: 'conn_feishu',
              name: 'Feishu Workspace',
              category: 'office_social',
              transport: 'http_mcp',
              status: 'connected',
              toolCount: 8
            }
          ]
        };
      }
      if (toolName === 'vault_list') {
        return {
          items: [
            {
              id: 'cred_demo',
              name: 'Demo API Key',
              type: 'api_key',
              status: 'active',
              version: 2,
              projectTags: ['duolawork'],
              fields: [{ name: 'token', reference: 'vault://cred_demo/token' }]
            }
          ]
        };
      }
      return { ok: true, toolName, args };
    });

    const { url } = await app.listen(0, '127.0.0.1');

    // 1. Thread pinning order via PATCH /api/v2/threads/:id
    const pinRes = await fetch(`${url}/api/v2/threads/${t2.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: true })
    });
    assert.equal(pinRes.status, 200);
    const bootAfterPin = await (await fetch(`${url}/api/v2/bootstrap`)).json();
    assert.equal(bootAfterPin.threads[0].id, t2.id, 'Pinned thread must appear first in list');
    assert.equal(
      JSON.stringify(bootAfterPin.duolabase).includes(superSecretToken),
      false,
      'Bootstrap DuolaBase public status must never expose plaintext token'
    );

    // 2. Material <-> Task association, source detection, version-change detection, and unlink
    const createdDoc = await (
      await fetch(`${url}/api/v2/threads/${t1.id}/space/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '产品说明书.md', content: '# 初版 v1' })
      })
    ).json();
    const docId = createdDoc.artifact.id;

    const assocRes = await fetch(`${url}/api/v2/threads/${t1.id}/space/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'document',
        id: docId,
        taskId: task.id,
        role: 'input',
        resourceVersion: 1
      })
    });
    assert.equal(assocRes.status, 201);
    const { link } = await assocRes.json();

    const ctx1 = await (
      await fetch(`${url}/api/v2/threads/${t1.id}/space/context?kind=document&id=${docId}`)
    ).json();
    assert.equal(ctx1.tasks.length, 1);
    assert.equal(ctx1.tasks[0].role, 'input');
    assert.equal(ctx1.tasks[0].versionChanged, false);
    assert.ok(ctx1.sources.length >= 1, 'Source message mentioning 产品说明书 should appear');

    // Update doc to v2 -> context must warn versionChanged = true
    await fetch(`${url}/api/v2/artifacts/${docId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedBaseVersion: 1, content: '# 修订 v2' })
    });
    const ctx2 = await (
      await fetch(`${url}/api/v2/threads/${t1.id}/space/context?kind=document&id=${docId}`)
    ).json();
    assert.equal(ctx2.tasks[0].versionChanged, true);
    assert.equal(ctx2.tasks[0].resourceVersion, 1);
    assert.equal(ctx2.tasks[0].currentVersion, 2);

    const unlinkRes = await fetch(`${url}/api/v2/space/associations/${link.id}`, { method: 'DELETE' });
    assert.equal(unlinkRes.status, 200);
    const ctx3 = await (
      await fetch(`${url}/api/v2/threads/${t1.id}/space/context?kind=document&id=${docId}`)
    ).json();
    assert.equal(ctx3.tasks.length, 0);

    // 3. Member usage ledger + Member onboarding + ClaudeVPS guard
    const usageRes = await (await fetch(`${url}/api/v2/members/usage`)).json();
    const codexUsage = usageRes.summaries.find((s: { memberId: string }) => s.memberId === 'mem_codex');
    assert.ok(codexUsage && codexUsage.workbenchDispatches >= 1, 'Member usage tracks dispatches');

    const vpsBlocked = await fetch(`${url}/api/v2/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ClaudeVPS', platformId: 'claude-code', driverKind: 'acp-stdio' })
    });
    assert.equal(vpsBlocked.status, 403);

    const addedMem = await fetch(`${url}/api/v2/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Webhook 助手', platformId: 'feishu-bot', driverKind: 'webhook-bot' })
    });
    assert.equal(addedMem.status, 201);
    const { member } = await addedMem.json();
    const delMem = await fetch(`${url}/api/v2/members/${member.id}`, { method: 'DELETE' });
    assert.equal(delMem.status, 200);

    // 4. DuolaBase Connectors & Vault HTTP Proxy + Zero leaked tokens
    const dbStatus = await (await fetch(`${url}/api/v2/duolabase/status`)).json();
    assert.equal(dbStatus.hasToken, true);
    assert.equal(JSON.stringify(dbStatus).includes(superSecretToken), false);

    const conns = await (await fetch(`${url}/api/v2/duolabase/connectors`)).json();
    assert.equal(conns.items[0].id, 'conn_feishu');

    const vault = await (await fetch(`${url}/api/v2/duolabase/vault`)).json();
    assert.equal(vault.items[0].fields[0].reference, 'vault://cred_demo/token');
    assert.equal(JSON.stringify(vault).includes(superSecretToken), false);
  } finally {
    await cleanup();
  }
});
