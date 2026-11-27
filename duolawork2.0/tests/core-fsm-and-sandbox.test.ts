import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { DuolaWorkApp } from '../src/server/app.js';
import { SandboxForbiddenError } from '../src/server/auth-sandbox.js';
import { resolveLocalCliBinary } from '../src/server/db.js';
import { fromCodexWireToolName, toCodexWireToolName } from '../src/server/drivers/codex-driver.js';
import { type TurnStreamEvent, sanitizeToolSummary } from '../src/server/drivers/types.js';
import {
  DEFAULT_HANDOFF_BUDGET_BYTES,
  resolveHandoffBudgetBytes
} from '../src/server/handoff.js';
import { DEFAULT_WORKBENCH_PROTOCOL_VERSION } from '../src/server/threads.js';
import { isExcludedClaudeVps } from '../src/shared/types.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createTestApp(): { app: DuolaWorkApp; cleanup: () => Promise<void> } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-test-'));
  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDir, 'test.sqlite'),
    worktreesRoot: path.join(tmpDir, 'worktrees'),
    autoImportAgentHub: false
  });

  app.db.upsertMember({
    id: 'mem_gemini',
    name: 'Gemini2VPS',
    platformId: 'antigravity',
    driverKind: 'mock',
    location: 'remote-bridge',
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

  app.db.upsertMember({
    id: 'mem_grok',
    name: 'grok1',
    platformId: 'grok-bot',
    driverKind: 'mock',
    location: 'webhook',
    capabilities: {
      supportsIsolatedSessions: false,
      supportsSessionResume: false,
      supportsCancel: false,
      maxConcurrentRuns: 1
    },
    status: 'ready',
    statusMessage: 'ready',
    config: {}
  });

  return {
    app,
    cleanup: async () => {
      await app.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

test('DW2-02 & DW2-10: non-destructive read-only Agent Hub import excludes ClaudeVPS, keeps T3-style local Coding Agents uncoupled, and never touches ~/.config/agent-hub', async () => {
  const fakeHubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-fakehub-'));
  const cfgFile = path.join(fakeHubDir, 'config.json');
  const ncFile = path.join(fakeHubDir, 'native-coding.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ endpoint: 'https://hub.manyaitool.com', adminKey: 'secret_k' }));
  fs.writeFileSync(
    ncFile,
    JSON.stringify({
      member_codex_1: { engine: 'codex', sessions: { default: 'external_ide_sess_999' } },
      member_bf4fdac30b4542c8988bb6725f47ec0b: { engine: 'claude-code' }
    })
  );
  const beforeCfg = fs.readFileSync(cfgFile, 'utf8');
  const beforeNc = fs.readFileSync(ncFile, 'utf8');

  const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-imp-'));
  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDbDir, 'v2.sqlite'),
    autoImportAgentHub: true,
    agentHubDir: fakeHubDir
  });

  try {
    const members = app.db.listMembers();
    const codex = members.find((m) => m.id === 'member_codex_1');
    assert.ok(codex && codex.driverKind === 'codex-app-server' && codex.location === 'local', 'Existing Codex ID preserved locally');
    assert.ok(members.some((m) => m.id === 'member_ccdf940ba6d3426da01b9f65048909e2'), 'Gemini2VPS preserved');
    assert.ok(!members.some((m) => isExcludedClaudeVps(m)), 'ClaudeVPS strictly excluded');
    const cursorRows = app.db.sqlite.prepare(`SELECT COUNT(*) AS cnt FROM v2_handoff_cursors`).get() as { cnt: number };
    assert.equal(cursorRows.cnt, 0, 'External native-coding sessions must NOT be pre-bound or synced');
    assert.equal(fs.readFileSync(cfgFile, 'utf8'), beforeCfg, 'config.json untouched byte-for-byte');
    assert.equal(fs.readFileSync(ncFile, 'utf8'), beforeNc, 'native-coding.json untouched byte-for-byte');
  } finally {
    await app.close();
    fs.rmSync(fakeHubDir, { recursive: true, force: true });
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
  }
});

test('DW2-03 & DW2-09: exclusive single-owner dispatch (mentions never wake bystanders) + three-tier usage + idle 0 wakeups', async () => {
  const { app, cleanup } = createTestApp();
  try {
    const thread = app.threads.createThread({
      title: '排他寻址测试',
      activeOwnerMemberId: 'mem_gemini'
    });

    // Idle check: 0 dispatches before any user action
    assert.equal(app.registry.listAttempts().length, 0);

    // Mentioning @Codex and @grok1 in plain text MUST NOT wake them!
    const out = await app.threads.sendUserMessage({
      threadId: thread.id,
      body: '一会儿我再找 @Codex 和 @grok1 帮忙，现在你先给个大纲'
    });

    const attempts = app.registry.listAttempts({ threadId: thread.id });
    assert.equal(attempts.length, 1, 'Strictly 1 dispatch for 1 message');
    assert.equal(attempts[0].memberId, 'mem_gemini');
    assert.equal(attempts[0].usage.workbenchDispatches, 1);
    assert.equal(attempts[0].usage.nativeTurns, 1);
    assert.equal(out.agentMessage.usage?.workbenchDispatches, 1);
    assert.equal(app.registry.listAttempts({ memberId: 'mem_codex' }).length, 0);
    assert.equal(app.registry.listAttempts({ memberId: 'mem_grok' }).length, 0);
  } finally {
    await cleanup();
  }
});

test('DW2-04 & Audit Pitfall #2: 12 KiB bounded handoff on long history + cursor does NOT advance when target is offline', async () => {
  const { app, cleanup } = createTestApp();
  try {
    const thread = app.threads.createThread({
      title: '超长历史交接测试',
      activeOwnerMemberId: 'mem_gemini'
    });

    // Generate 60 turns (~45 KiB of history) with Gemini
    for (let i = 1; i <= 60; i++) {
      await app.threads.sendUserMessage({
        threadId: thread.id,
        body: `第 ${i} 轮讨论细节：` + '架构设计与性能边界说明文字'.repeat(25)
      });
    }

    // Switch to Codex, simulate Codex temporarily offline on first try!
    app.threads.switchOwner(thread.id, 'mem_codex');
    app.registry.mockDriver.handlers.set('mem_codex', async () => {
      throw new Error('CODEX_TEMP_OFFLINE');
    });

    await assert.rejects(() =>
      app.threads.sendUserMessage({
        threadId: thread.id,
        body: '按最新一轮方案落地实现'
      })
    );

    // Cursor for Codex MUST still be 0 because delivery failed!
    const cursorAfterFail = app.handoff.getCursor(thread.id, 'mem_codex');
    assert.equal(cursorAfterFail?.lastSeenSeq ?? 0, 0, 'Failed delivery must not advance lastSeenSeq');

    // Now Codex comes back online; capture exact prompt & verify <= 12 KiB handoff + omission pointer!
    let capturedPrompt = '';
    app.registry.mockDriver.handlers.set('mem_codex', async (inp) => {
      capturedPrompt = inp.prompt;
      return { text: 'Codex 已收到增量并完成落地' };
    });

    const recovered = await app.threads.sendUserMessage({
      threadId: thread.id,
      body: '重试：按最新方案落地实现'
    });

    assert.ok(
      recovered.handoffBytes <= DEFAULT_HANDOFF_BUDGET_BYTES,
      `Handoff bytes (${recovered.handoffBytes}) must be <= ${DEFAULT_HANDOFF_BUDGET_BYTES}`
    );
    assert.match(capturedPrompt, /\[早期历史折叠\]/, 'Older turns folded with range pointer');
    assert.match(capturedPrompt, /thread_read_history/, 'On-demand history tool hinted');

    const cursorAfterOk = app.handoff.getCursor(thread.id, 'mem_codex');
    assert.ok((cursorAfterOk?.lastSeenSeq ?? 0) > 120, 'Cursor advances after confirmed delivery');
  } finally {
    await cleanup();
  }
});

test('Audit Priority #4 & DW2-07: owner switch mid-turn + human artifact edit + parallel step CAS single delivery + stale turn conflict_branch', async () => {
  const { app, cleanup } = createTestApp();
  try {
    const thread = app.threads.createThread({
      title: '并发归属与乐观锁测试',
      activeOwnerMemberId: 'mem_gemini',
      initialDocTitle: '总体方案.md',
      initialDocContent: 'v1 初始草稿'
    });
    const artId = thread.boundArtifactId!;

    // 1. Gemini creates a 2-step parallel task where Gemini is Lead, Grok & Codex are parallel Workers
    app.registry.mockDriver.handlers.set('mem_grok', async () => ({
      text: 'Grok 素材搜集完毕'
    }));
    app.registry.mockDriver.handlers.set('mem_codex', async () => ({
      text: 'Codex 数据脚本完毕'
    }));
    app.registry.mockDriver.handlers.set('mem_gemini', async (inp) => {
      if (inp.scopeKey.startsWith('task_lead:')) {
        return { text: '{"verdict":"accept","comments":"负责人 Gemini2VPS 核验通过"}' };
      }
      return { text: '普通回复' };
    });

    // Start a slow chat turn on Gemini (pinned at artifact v1)
    let releaseSlowGeminiTurn!: () => void;
    const slowGate = new Promise<void>((r) => {
      releaseSlowGeminiTurn = r;
    });
    app.registry.mockDriver.handlers.set('mem_gemini', async (inp) => {
      if (inp.scopeKey.startsWith('task_lead:')) {
        return { text: '{"verdict":"accept","comments":"Gemini2VPS 独立统筹会话核验通过"}' };
      }
      await slowGate;
      // Gemini's slow turn tries to overwrite artifact using `<duolawork_artifact>` based on stale v1!
      return {
        text: 'Gemini 迟到的旧回合回复\n<duolawork_artifact title="总体方案.md">Gemini 旧回合试图写入的过期内容</duolawork_artifact>'
      };
    });

    const slowGeminiPromise = app.threads.sendUserMessage({
      threadId: thread.id,
      body: 'Gemini 帮我起草一版旧方案'
    });

    // Wait briefly for Gemini's turn to dispatch & pin v1
    await new Promise((r) => setTimeout(r, 30));

    // 2. While Gemini's chat turn is still in-flight, user switches conversation owner to Codex AND manually edits artifact to v2!
    app.threads.switchOwner(thread.id, 'mem_codex');
    const humanEdit = app.artifacts.writeArtifact({
      artifactId: artId,
      expectedBaseVersion: 1,
      content: 'v2 人类亲自修改的正式定稿（绝不允许被旧回合覆盖！）',
      writerKind: 'user',
      writerId: 'owner'
    });
    assert.equal(humanEdit.conflict, false);
    assert.equal(humanEdit.artifact.headVersion, 2);

    // 3. Create & run the parallel 2-step task (Lead = mem_gemini, even though thread owner is now mem_codex!)
    const { task, initialRun } = app.tasks.createOrUpdateTask({
      sourceThreadId: thread.id,
      title: '双人并行采集与脚本任务',
      leadMemberId: 'mem_gemini',
      spec: {
        goal: '并行完成素材与脚本',
        steps: [
          {
            stepOrder: 1,
            title: '步骤1 素材',
            assigneeMemberId: 'mem_grok',
            brief: '抓素材',
            acceptanceCriteria: '完整'
          },
          {
            stepOrder: 2,
            title: '步骤2 脚本',
            assigneeMemberId: 'mem_codex',
            brief: '写脚本',
            acceptanceCriteria: '可运行'
          }
        ]
      }
    });

    const finishedRun = await app.tasks.driveRun(initialRun!.id);
    assert.equal(finishedRun.status, 'completed');
    assert.equal(finishedRun.deliveryStage, 'delivered');

    // Verify reviews were performed by `mem_gemini` (the Task Lead), NOT `mem_codex`!
    for (const s of app.tasks.listSteps(finishedRun.id)) {
      const revs = app.tasks.listReviews(s.id);
      assert.equal(revs[0].leadMemberId, 'mem_gemini');
    }

    // Verify strictly ONE `delivered` task card was posted to the source thread!
    const deliveredCards = app.threads
      .listMessages(thread.id)
      .filter((m) => m.taskCard?.taskId === task.id && m.taskCard?.kind === 'delivered');
    assert.equal(deliveredCards.length, 1, 'Concurrent step completion must emit strictly 1 delivery card');

    // 4. Finally release Gemini's stale chat turn!
    releaseSlowGeminiTurn();
    const slowRes = await slowGeminiPromise;
    assert.equal(slowRes.agentMessage.authorId, 'mem_gemini', 'Late reply stays on Gemini message card');
    assert.equal(app.threads.getThread(thread.id)!.activeOwnerMemberId, 'mem_codex', 'Thread owner remains Codex');

    // Verify human's v2 main head was NOT overwritten; Gemini's stale write was saved as conflict_branch!
    const finalArt = app.artifacts.getArtifact(artId)!;
    assert.equal(finalArt.headVersion, 2);
    assert.equal(finalArt.content, 'v2 人类亲自修改的正式定稿（绝不允许被旧回合覆盖！）');
    const allVers = app.artifacts.listVersions(artId);
    const conflictVer = allVers.find((v) => v.branchKind === 'conflict_branch');
    assert.ok(conflictVer, 'Stale turn draft preserved non-destructively in conflict_branch');
    assert.equal(conflictVer!.basedOnVersion, 1);
  } finally {
    await cleanup();
  }
});

test('Audit Pitfall #3: waiting_user task clarification routes back to Task Lead and parallel Git worktrees merge & pass integration test', async () => {
  const { app, cleanup } = createTestApp();
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-gitrepo-'));
  try {
    // Initialize a real temporary git repo
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Demo Repo\n');
    execFileSync('git', ['add', '-A'], { cwd: repoDir });
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-m', 'init'],
      { cwd: repoDir }
    );

    const thread = app.threads.createThread({
      title: '代码多 Worktree 与待确认恢复测试',
      activeOwnerMemberId: 'mem_codex',
      workspacePath: repoDir
    });

    let step1Calls = 0;
    app.registry.mockDriver.handlers.set('mem_codex', async (inp) => {
      if (inp.scopeKey.endsWith(':1')) {
        step1Calls += 1;
        if (step1Calls === 1) {
          return { text: '<duolawork_blocked>请确认模块 A 导出常量值用 42 还是 100？</duolawork_blocked>' };
        }
        fs.writeFileSync(path.join(inp.cwd, 'modA.js'), 'export const A = 42;\n');
        return { text: '已按用户确认写入 modA.js (A=42)' };
      }
      if (inp.scopeKey.endsWith(':2')) {
        fs.writeFileSync(path.join(inp.cwd, 'modB.js'), 'export const B = 58;\n');
        return { text: '已写入 modB.js (B=58)' };
      }
      return { text: 'ok' };
    });

    app.registry.mockDriver.handlers.set('mem_gemini', async () => ({
      text: '{"verdict":"accept","comments":"代码与单测核验通过"}'
    }));

    const { initialRun } = app.tasks.createOrUpdateTask({
      sourceThreadId: thread.id,
      title: '双模块并行开发',
      leadMemberId: 'mem_gemini',
      spec: {
        goal: '并行编写 modA 与 modB 并合并验证 A+B===100',
        workspaceRepoPath: repoDir,
        integrationTestCommand: `node --input-type=module -e "import {A} from './modA.js'; import {B} from './modB.js'; if (A+B!==100) process.exit(1); console.log('SUM_OK_100');"`,
        steps: [
          {
            stepOrder: 1,
            title: '实现 modA',
            assigneeMemberId: 'mem_codex',
            brief: '创建 modA.js',
            acceptanceCriteria: '导出 A',
            useWorktree: true
          },
          {
            stepOrder: 2,
            title: '实现 modB',
            assigneeMemberId: 'mem_codex',
            brief: '创建 modB.js',
            acceptanceCriteria: '导出 B',
            useWorktree: true
          }
        ]
      }
    });

    const pausedRun = await app.tasks.driveRun(initialRun!.id);
    assert.equal(pausedRun.status, 'waiting_user');
    assert.match(pausedRun.waitingQuestion || '', /42/);

    // User answers directly on the waiting task card -> resumes and merges both worktrees + passes integration test!
    const completedRun = await app.tasks.resumeWaitingRunWithUserReply({
      runId: pausedRun.id,
      userReply: '确认使用 A = 42'
    });
    assert.equal(completedRun.status, 'completed');
    assert.ok(completedRun.integrationWorktreePath);
    assert.ok(fs.existsSync(path.join(completedRun.integrationWorktreePath!, 'modA.js')));
    assert.ok(fs.existsSync(path.join(completedRun.integrationWorktreePath!, 'modB.js')));
    const finalDoc = app.artifacts.getArtifact(completedRun.finalArtifactId!)!;
    assert.match(finalDoc.content, /SUM_OK_100/);

    await app.worktrees.cleanupRunWorktrees(repoDir, completedRun.id);
  } finally {
    await cleanup();
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('Audit Priority #3 & DW2-06: Scoped Execution Sandbox enforces 403 on cross-task access, Lead tools, DuolaBase writes & secret reveal, and works when DuolaBase is disabled', async () => {
  const { app, cleanup } = createTestApp();
  try {
    const t1 = app.threads.createThread({
      title: '对话1',
      activeOwnerMemberId: 'mem_gemini',
      initialDocTitle: '对话1文稿.md'
    });
    const t2 = app.threads.createThread({
      title: '对话2',
      activeOwnerMemberId: 'mem_codex',
      initialDocTitle: '对话2文稿.md'
    });

    const workerClaims = app.sandbox.issueScopedToken({
      principalKind: 'task_worker',
      memberId: 'mem_codex',
      attemptId: 'att_sandbox_1',
      threadId: t1.id,
      taskId: 'task_1',
      runId: 'run_1',
      stepId: 'step_1',
      allowedArtifactIds: [t1.boundArtifactId!],
      toolPolicy: 'duolabase_readonly'
    });

    // 1. Worker forbidden from Lead actions & main-thread chat history & cross-thread artifacts!
    await assert.rejects(
      () => app.executeScopedAgentTool(workerClaims, 'task_create_or_update', { title: '越权建单' }),
      (e: unknown) => e instanceof SandboxForbiddenError && e.statusCode === 403
    );
    await assert.rejects(
      () => app.executeScopedAgentTool(workerClaims, 'thread_read_history', { fromSeq: 1, toSeq: 10 }),
      (e: unknown) => e instanceof SandboxForbiddenError && e.statusCode === 403
    );
    await assert.rejects(
      () => app.executeScopedAgentTool(workerClaims, 'artifact_read', { artifactId: t2.boundArtifactId! }),
      (e: unknown) => e instanceof SandboxForbiddenError && e.statusCode === 403
    );

    // 2. Worker CAN read its own authorized artifact & read-only DuolaBase tools, but 403 on write/reveal!
    const ownArt = await app.executeScopedAgentTool(workerClaims, 'artifact_read', {
      artifactId: t1.boundArtifactId!
    });
    assert.ok(ownArt);

    const roRes = await app.executeScopedAgentTool(workerClaims, 'duolabase:connector_call', {
      connectorId: 'conn_bf4138661cb443f4bdd5',
      toolName: 'feishu_doc_read',
      arguments: { document_id: 'doc_1' }
    });
    assert.deepEqual(roRes, { proxied: true, mcpTool: 'connector_call' });

    await assert.rejects(
      () =>
        app.executeScopedAgentTool(workerClaims, 'duolabase:connector_call', {
          connectorId: 'conn_bf4138661cb443f4bdd5',
          toolName: 'feishu_message_send'
        }),
      (e: unknown) => e instanceof SandboxForbiddenError && e.code === 'external_write_forbidden'
    );
    await assert.rejects(
      () => app.executeScopedAgentTool(workerClaims, 'duolabase:vault_reveal', { credentialId: 'c1' }),
      (e: unknown) => e instanceof SandboxForbiddenError && e.code === 'secret_reveal_or_mutation_forbidden'
    );

    // 3. Turn DuolaBase global switch OFF: external tools return 403, main conversation still works 100%!
    app.db.setSetting('duolabase', { enabled: false, endpoint: 'https://duolabase.manyaitool.com/mcp' });
    await assert.rejects(
      () => app.executeScopedAgentTool(workerClaims, 'duolabase:system_info', {}),
      (e: unknown) => e instanceof SandboxForbiddenError && e.code === 'external_connectors_disabled'
    );

    const chatWhenOff = await app.threads.sendUserMessage({
      threadId: t1.id,
      body: '连接器关闭后主对话依然正常交流'
    });
    assert.equal(chatWhenOff.agentMessage.turnStatus, 'completed');
  } finally {
    await cleanup();
  }
});

test('Live dispatches remain owned while waiting for a slot and opening their session', async () => {
  const { app, cleanup } = createTestApp();
  const member = app.db.getMember('mem_grok')!;
  const thread = app.threads.createThread({ title: '排队测试', activeOwnerMemberId: member.id });
  let enteredResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  let releaseResolve!: () => void;
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const ensure = app.registry.mockDriver.ensureSession.bind(app.registry.mockDriver);
  app.registry.mockDriver.ensureSession = async (input) => {
    enteredResolve();
    await release;
    return ensure(input);
  };
  const turns = ['first', 'queued'].map((key) => app.registry.dispatchTurn({
    idempotencyKey: key, targetKind: 'task_step', targetId: key, threadId: thread.id,
    member, scopeKey: key, cwd: os.tmpdir(), prompt: key
  }));
  try {
    await entered;
    const reconciled = await app.registry.reconcileInFlightAttempts();
    assert.deepEqual(reconciled.map((r) => r.outcome), []);
    assert.equal(app.registry.hasPendingReconcileAttempts(), false);
    for (const key of ['first', 'queued']) {
      assert.equal(app.registry.getAttemptByIdempotencyKey(key)?.status, 'prepared');
    }
    releaseResolve();
    for (const turn of await Promise.all(turns)) assert.equal(turn.attempt.status, 'succeeded');
  } finally {
    releaseResolve();
    await Promise.allSettled(turns);
    await cleanup();
  }
});

test('Audit Priority #1 & #2 & DW2-08: fixed-window Bot concurrency=1 serialization, webhook auth, cron slot dedup, and old-run timeout immediate slot release with single delivery', async () => {
  const { app, cleanup } = createTestApp();
  try {
    const thread = app.threads.createThread({
      title: '定时防重与超时名额释放测试',
      activeOwnerMemberId: 'mem_gemini'
    });

    // 1. Verify fixed-window Bot (`mem_grok`, maxConcurrentRuns=1) serializes two concurrent dispatches!
    let activeGrokCount = 0;
    let maxObservedGrokConcurrency = 0;
    app.registry.mockDriver.handlers.set('mem_grok', async (inp) => {
      activeGrokCount += 1;
      maxObservedGrokConcurrency = Math.max(maxObservedGrokConcurrency, activeGrokCount);
      await new Promise((r) => setTimeout(r, 40));
      activeGrokCount -= 1;
      return { text: `Grok 完成 ${inp.scopeKey}` };
    });

    const grokMember = app.db.getMember('mem_grok')!;
    await Promise.all([
      app.registry.dispatchTurn({
        idempotencyKey: 'grok_concurrent_a',
        targetKind: 'task_step',
        targetId: 's_a',
        threadId: thread.id,
        member: grokMember,
        scopeKey: 'scope_a',
        cwd: os.tmpdir(),
        prompt: '任务A'
      }),
      app.registry.dispatchTurn({
        idempotencyKey: 'grok_concurrent_b',
        targetKind: 'task_step',
        targetId: 's_b',
        threadId: thread.id,
        member: grokMember,
        scopeKey: 'scope_b',
        cwd: os.tmpdir(),
        prompt: '任务B'
      })
    ]);
    assert.equal(maxObservedGrokConcurrency, 1, 'Fixed-window Bot must strictly serialize concurrent runs');

    // 2. Real HTTP Webhook server + callback token security: valid accepted, duplicate idempotent 200, forged 403!
    const { url: appUrl } = await app.listen(0, '127.0.0.1');
    const httpMod = await import('node:http');
    const mockBotServer = httpMod.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ queued: true }));

      // Asynchronously test forged callback (403), valid callback (200), and duplicate callback (200)!
      setTimeout(async () => {
        const forgedRes = await fetch(`${appUrl}/api/v2/webhooks/callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            attemptId: payload.attemptId,
            callbackToken: 'forged_bad_token',
            text: 'hack'
          })
        });
        assert.equal(forgedRes.status, 403);

        const validRes = await fetch(`${appUrl}/api/v2/webhooks/callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            attemptId: payload.attemptId,
            callbackToken: payload.callbackToken,
            text: 'Webhook 合法回执正文'
          })
        });
        assert.equal(validRes.status, 200);

        const dupRes = await fetch(`${appUrl}/api/v2/webhooks/callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            attemptId: payload.attemptId,
            callbackToken: payload.callbackToken,
            text: 'Webhook 合法回执正文'
          })
        });
        assert.equal(dupRes.status, 200);
        const dupJson = await dupRes.json();
        assert.equal(dupJson.status, 'duplicate_noop');
      }, 15);
    });

    await new Promise<void>((r) => mockBotServer.listen(0, '127.0.0.1', () => r()));
    const botPort = (mockBotServer.address() as { port: number }).port;

    const whMember = app.db.upsertMember({
      id: 'mem_wh_real',
      name: 'WebhookBot',
      platformId: 'grok-bot',
      driverKind: 'webhook-bot',
      location: 'webhook',
      capabilities: {
        supportsIsolatedSessions: false,
        supportsSessionResume: false,
        supportsCancel: false,
        maxConcurrentRuns: 1
      },
      status: 'ready',
      statusMessage: 'ready',
      config: {
        webhookUrl: `http://127.0.0.1:${botPort}/trigger`
      }
    });

    try {
      const whRes = await app.registry.dispatchTurn({
        idempotencyKey: 'wh_test_1',
        targetKind: 'task_step',
        targetId: 's_wh',
        threadId: thread.id,
        member: whMember,
        scopeKey: 'wh_scope_1',
        cwd: os.tmpdir(),
        prompt: '抓热点'
      });
      assert.equal(whRes.result.text, 'Webhook 合法回执正文');
    } finally {
      await new Promise<void>((r) => mockBotServer.close(() => r()));
    }

    // 3. Scheduled Task: Run #1 hangs & times out on `mem_grok` (maxConcurrentRuns=1!),
    //    immediately frees slot so `mem_grok` completes Run #2 on time, and Run #1's late arrival is `late_ignored`!
    let resolveHungRun1!: (val: { text: string }) => void;
    let grokCallNum = 0;
    app.registry.mockDriver.handlers.set('mem_grok', async () => {
      grokCallNum += 1;
      if (grokCallNum === 1) {
        return new Promise<{ text: string }>((r) => {
          resolveHungRun1 = r;
        });
      }
      return { text: '第 2 期早报正常采集完毕' };
    });
    app.registry.mockDriver.handlers.set('mem_gemini', async () => ({
      text: '{"verdict":"accept","comments":"早报验收通过"}'
    }));

    const { task: cronTask } = app.tasks.createOrUpdateTask({
      sourceThreadId: thread.id,
      title: '定时早报跨期隔离测试',
      kind: 'scheduled',
      cronExpr: '0 8 * * *',
      timezone: 'Asia/Shanghai',
      leadMemberId: 'mem_gemini',
      spec: {
        goal: '准点产出早报',
        stepTimeoutMs: 80, // 80ms fast timeout for deterministic test
        steps: [
          {
            stepOrder: 1,
            title: '采集动态',
            assigneeMemberId: 'mem_grok',
            brief: '采集',
            acceptanceCriteria: '准确'
          }
        ]
      }
    });

    const day1At8 = new Date('2026-11-25T00:00:10.000Z'); // 08:00 Asia/Shanghai
    const firstTickRuns = await app.scheduler.tick(day1At8, { awaitRuns: true });
    assert.equal(firstTickRuns.length, 1);
    // Duplicate tick in the exact same minute MUST be deduplicated (0 extra runs!)
    const dupTickRuns = await app.scheduler.tick(new Date('2026-11-25T00:00:45.000Z'), { awaitRuns: true });
    assert.equal(dupTickRuns.length, 0, 'Duplicate cron trigger in same slot must be deduplicated');

    const run1AfterTimeout = app.tasks.getRun(firstTickRuns[0].id)!;
    assert.equal(run1AfterTimeout.status, 'timed_out', 'Run #1 marked timed_out');

    // Day 2 at 08:00 Asia/Shanghai -> SAME single-slot `mem_grok` MUST NOT be blocked by hung Run #1!
    const day2At8 = new Date('2026-11-26T00:00:05.000Z');
    const secondTickRuns = await app.scheduler.tick(day2At8, { awaitRuns: true });
    assert.equal(secondTickRuns.length, 1);
    const run2 = app.tasks.getRun(secondTickRuns[0].id)!;
    assert.equal(run2.status, 'completed', 'Same member completed Run #2 without blocking');

    // Now Run #1's hung external call finally returns late -> marked `late_ignored`, ZERO extra delivery cards!
    resolveHungRun1({ text: '迟到的第 1 期半成品' });
    await new Promise((r) => setTimeout(r, 30));

    const run1Attempts = app.registry.listAttempts({ runId: run1AfterTimeout.id });
    assert.equal(run1Attempts[0].status, 'late_ignored', 'Late receipt after timeout archived as late_ignored');

    const cronDeliveryCards = app.threads
      .listMessages(thread.id)
      .filter((m) => m.taskCard?.taskId === cronTask.id && m.taskCard?.kind === 'delivered');
    assert.equal(cronDeliveryCards.length, 1, 'Strictly 1 delivery card (only Run #2)');
  } finally {
    await cleanup();
  }
});

test('DW2-11: Frontend & prototype have 0 native <select>/<details>/<datalist>, 0 defensive jargon, and JS gzip < 180 KB', () => {
  const webDir = path.join(projectRoot, 'src/web');
  const webFiles = fs
    .readdirSync(webDir)
    .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
    .map((f) => [f, fs.readFileSync(path.join(webDir, f), 'utf8')] as const);
  const protoHtml = fs.readFileSync(path.join(projectRoot, 'prototype-v2.html'), 'utf8');

  for (const [name, src] of [...webFiles, ['prototype-v2.html', protoHtml] as const]) {
    assert.ok(!/<select[\s>]/i.test(src), `${name} must contain 0 <select>`);
    assert.ok(!/<details[\s>]/i.test(src), `${name} must contain 0 <details>`);
    assert.ok(!/<datalist[\s>]/i.test(src), `${name} must contain 0 <datalist>`);
    for (const banned of ['仅唤醒 1 人', '线性单主线', '静置空耗', '防堵死', '不含主对话闲聊']) {
      assert.ok(!src.includes(banned), `${name} must not contain engineering jargon: ${banned}`);
    }
  }

  // Check built web bundle size if dist/web/assets exists
  const assetsDir = path.join(projectRoot, 'dist/web/assets');
  if (fs.existsSync(assetsDir)) {
    const jsFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
    assert.ok(jsFiles.length > 0, 'Vite JS bundle exists');
    let totalGzipBytes = 0;
    for (const f of jsFiles) {
      const raw = fs.readFileSync(path.join(assetsDir, f));
      totalGzipBytes += zlib.gzipSync(raw).length;
    }
    assert.ok(
      totalGzipBytes < 180 * 1024,
      `JS bundle gzip (${totalGzipBytes} B) must be < 180 KiB`
    );
  }
});

test('DW2-12: T3-style ClaudeCliDriver isolated session lifecycle & stream-json usage parsing', async () => {
  const { app, cleanup } = createTestApp();
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-claude-stub-'));
  const logFile = path.join(stubDir, 'invocations.jsonl');
  const stubBin = path.join(stubDir, 'fake-claude.mjs');

  fs.writeFileSync(
    stubBin,
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, email: 'local-dev@example.com', subscriptionType: 'pro' }));
  process.exit(0);
}
const prompt = fs.readFileSync(0, 'utf8');
const sidIdx = args.indexOf('--session-id');
const resIdx = args.indexOf('--resume');
const sid = sidIdx >= 0 ? args[sidIdx + 1] : resIdx >= 0 ? args[resIdx + 1] : '';
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, prompt, sid }) + '\\n');
const reply = resIdx >= 0 ? '续聊回复' : '首轮回复';
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } }));
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }));
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't_read', name: 'Read' } } }));
console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't_read' }] } }));
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } } }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: reply,
  session_id: sid,
  num_turns: 1,
  usage: { input_tokens: 120, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: 25 }
}));
`,
    { mode: 0o755 }
  );

  try {
    const claudeMember = app.db.upsertMember({
      id: 'member_local_claude_code',
      name: 'Claude',
      platformId: 'claude-code',
      driverKind: 'claude-cli',
      location: 'local',
      capabilities: {
        supportsIsolatedSessions: true,
        supportsSessionResume: true,
        supportsCancel: true,
        maxConcurrentRuns: 2
      },
      status: 'ready',
      statusMessage: '本机 Claude Code',
      config: { command: stubBin }
    });

    const health = await app.registry.getDriver('claude-cli').checkHealth(claudeMember);
    assert.equal(health.status, 'ready');
    assert.match(health.message, /local-dev@example\.com/);

    const t1 = app.threads.createThread({ title: 'Claude T3 独立对话 1', activeOwnerMemberId: claudeMember.id });
    const phases: string[] = [];
    const unsub = app.threads.subscribe(ev => {
      if (ev.type === 'thread.activity') phases.push((ev.payload as { activity: { phase: string } }).activity.phase);
    });
    const r1 = await app.threads.sendUserMessage({ threadId: t1.id, body: '第一问' });
    unsub();
    assert.deepEqual(phases, ['thinking', 'processing', 'executing', 'processing', 'writing']);
    assert.equal(r1.agentMessage.toolTrace?.[0].status, 'done');
    assert.equal(r1.agentMessage.body, '首轮回复');
    assert.equal(r1.agentMessage.usage?.providerUsage.observable, true);
    assert.equal(r1.agentMessage.usage?.providerUsage.inputTokens, 160);
    assert.equal(r1.agentMessage.usage?.providerUsage.cachedInputTokens, 30);
    assert.equal(r1.agentMessage.usage?.providerUsage.uncachedInputTokens, 130);
    assert.equal(r1.agentMessage.usage?.providerUsage.outputTokens, 25);
    assert.equal(r1.agentMessage.usage?.providerUsage.totalTokens, 185);

    const r2 = await app.threads.sendUserMessage({ threadId: t1.id, body: '第二问' });
    assert.equal(r2.agentMessage.body, '续聊回复');

    const t2 = app.threads.createThread({ title: 'Claude T3 独立对话 2', activeOwnerMemberId: claudeMember.id });
    await app.threads.sendUserMessage({ threadId: t2.id, body: '新会话' });

    const calls = fs
      .readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { args: string[]; sid: string });
    assert.equal(calls.length, 3);
    assert.ok(calls[0].args.includes('--session-id') && !calls[0].args.includes('--resume'), 'Turn 1 uses --session-id');
    assert.ok(calls[1].args.includes('--resume') && calls[1].sid === calls[0].sid, 'Turn 2 resumes exact Thread 1 UUID');
    assert.ok(calls[2].args.includes('--session-id') && calls[2].sid !== calls[0].sid, 'Thread 2 starts its own fresh UUID');
  } finally {
    fs.rmSync(stubDir, { recursive: true, force: true });
    await cleanup();
  }
});

test('DW2-13: Read-only /v2/workspace member sync restores all non-ClaudeVPS members while preserving Codex local driver & Gemini2VPS native-runtime', async () => {
  const http = await import('node:http');
  const mockWsMembers = [
    { id: 'member_dfaf1af46a9a44ac9d44e1cdf77675d4', name: 'grok1', platformId: 'grok-bot', mode: 'browser', status: 'ready', accountId: 'acc_g1' },
    { id: 'member_5843640cb61c4ab18c52c39bc6911deb', name: 'muse1', platformId: 'muse', mode: 'browser', status: 'unverified', accountId: 'acc_m1' },
    { id: 'member_0ff5c20718654c9db5ab3b1d0334133e', name: 'Dot', platformId: 'chatgpt-agent', mode: 'connector', status: 'unverified', accountId: 'acc_dot' },
    { id: 'member_785ba0d4e7964814bf65102b90867efd', name: 'grok2', platformId: 'grok-bot', mode: 'connector', status: 'unverified', accountId: 'acc_g2' },
    { id: 'member_5d17c9dc1b0549119c318a05230d602d', name: 'Hub 首次接入验收', platformId: 'grok-bot', mode: 'connector', status: 'unverified', accountId: 'acc_test' },
    { id: 'member_47be343430a54bff908ab5d471752701', name: 'grok3', platformId: 'grok-bot', mode: 'connector', status: 'unverified', accountId: 'acc_g3' },
    { id: 'member_26ac2c60371e4158bd6df1b0fa0db37d', name: 'Codex', platformId: 'codex', mode: 'connector', status: 'unverified', accountId: 'acc_codex' },
    { id: 'member_acbea6620d534e6682d8009db6403f1e', name: 'DeepSeek本地', platformId: 'deepseek-harness', mode: 'connector', status: 'unverified', accountId: 'acc_dsh' },
    { id: 'member_ccdf940ba6d3426da01b9f65048909e2', name: 'Gemini2VPS', platformId: 'antigravity', mode: 'connector', status: 'unverified', accountId: 'acc_gemvps' },
    { id: 'member_bf4fdac30b4542c8988bb6725f47ec0b', name: 'ClaudeVPS', platformId: 'claude-code', mode: 'connector', status: 'unverified', accountId: 'acc_clvps' },
    { id: 'member_f91c9330e8ea4ffd9ea2048db7b79d1e', name: 'grok4', platformId: 'grok-bot', mode: 'connector', status: 'unverified', accountId: 'acc_g4' },
    { id: 'member_9820211e355b4fefa031aef43048f89e', name: 'Codegeist Development Integration', platformId: 'chatgpt-agent', mode: 'connector', status: 'unverified', accountId: 'acc_cg' }
  ];
  const mockConnections = mockWsMembers.map((m) => ({
    id: m.id,
    status: m.id === 'member_9820211e355b4fefa031aef43048f89e' ? 'configured' : 'verified',
    transport: m.platformId === 'grok-bot' ? 'grok-webhook' : m.platformId === 'chatgpt-agent' ? 'dots-events' : 'muse-poll'
  }));

  const hubSrv = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (reqUrl.pathname === '/v2/workspace') {
      res.end(JSON.stringify({ members: mockWsMembers, connections: mockConnections, accounts: [] }));
      return;
    }
    res.end(JSON.stringify({ items: [] }));
  });
  await new Promise<void>((r) => hubSrv.listen(0, '127.0.0.1', () => r()));
  const hubPort = (hubSrv.address() as { port: number }).port;

  const fakeHubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-synchub-'));
  const cfgFile = path.join(fakeHubDir, 'config.json');
  const ncFile = path.join(fakeHubDir, 'native-coding.json');
  const acFile = path.join(fakeHubDir, 'agent-connections.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ endpoint: `http://127.0.0.1:${hubPort}`, adminKey: 'mock_admin' }));
  fs.writeFileSync(ncFile, JSON.stringify({ member_26ac2c60371e4158bd6df1b0fa0db37d: { engine: 'codex' } }));
  fs.writeFileSync(
    acFile,
    JSON.stringify({
      schemaVersion: 1,
      accounts: {
        acc_m1: { memberId: 'member_5843640cb61c4ab18c52c39bc6911deb', status: 'ready', enabled: true },
        acc_g1: { memberId: 'member_dfaf1af46a9a44ac9d44e1cdf77675d4', status: 'ready', enabled: true }
      }
    })
  );
  const beforeCfg = fs.readFileSync(cfgFile, 'utf8');
  const beforeNc = fs.readFileSync(ncFile, 'utf8');
  const beforeAc = fs.readFileSync(acFile, 'utf8');

  const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-syncdb-'));
  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDbDir, 'v2.sqlite'),
    autoImportAgentHub: true,
    agentHubDir: fakeHubDir
  });

  try {
    const { url } = await app.listen(0, '127.0.0.1');
    const bootstrap = (await (await fetch(`${url}/api/v2/bootstrap`)).json()) as {
      members: Array<{ id: string; name: string; driverKind: string; location: string; status: string; config: Record<string, unknown> }>;
    };
    const byId = new Map(bootstrap.members.map((m) => [m.id, m]));

    assert.equal(byId.has('member_bf4fdac30b4542c8988bb6725f47ec0b'), false, 'ClaudeVPS strictly excluded');
    for (const expectedId of [
      'member_dfaf1af46a9a44ac9d44e1cdf77675d4',
      'member_5843640cb61c4ab18c52c39bc6911deb',
      'member_0ff5c20718654c9db5ab3b1d0334133e',
      'member_785ba0d4e7964814bf65102b90867efd',
      'member_5d17c9dc1b0549119c318a05230d602d',
      'member_47be343430a54bff908ab5d471752701',
      'member_26ac2c60371e4158bd6df1b0fa0db37d',
      'member_acbea6620d534e6682d8009db6403f1e',
      'member_ccdf940ba6d3426da01b9f65048909e2',
      'member_f91c9330e8ea4ffd9ea2048db7b79d1e',
      'member_9820211e355b4fefa031aef43048f89e'
    ]) {
      assert.ok(byId.has(expectedId), `Member ${expectedId} restored from /v2/workspace`);
    }

    assert.equal(byId.get('member_26ac2c60371e4158bd6df1b0fa0db37d')?.driverKind, 'codex-app-server', 'Codex stays on local driver');
    assert.equal(byId.get('member_26ac2c60371e4158bd6df1b0fa0db37d')?.location, 'local');
    assert.equal(byId.get('member_ccdf940ba6d3426da01b9f65048909e2')?.config.remoteMode, 'native-runtime', 'Gemini2VPS stays native-runtime');
    assert.equal(byId.get('member_acbea6620d534e6682d8009db6403f1e')?.config.remoteMode, 'hub-channel', 'DeepSeek本地 uses hub-channel');
    assert.equal(byId.get('member_9820211e355b4fefa031aef43048f89e')?.status, 'auth_required', 'Configured member maps to auth_required');

    assert.equal(fs.readFileSync(cfgFile, 'utf8'), beforeCfg);
    assert.equal(fs.readFileSync(ncFile, 'utf8'), beforeNc);
    assert.equal(fs.readFileSync(acFile, 'utf8'), beforeAc);
  } finally {
    await app.close();
    await new Promise<void>((r) => hubSrv.close(() => r()));
    fs.rmSync(fakeHubDir, { recursive: true, force: true });
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
  }
});

test('DW2-14: T3 Portable Handoffs (First-Prompt Anchor, tool trails, capability folding), persistent bridgeMeta & switch_notice collapse', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-handoff-p2-'));
  const dbPath = path.join(tmpDir, 'portable.sqlite');

  let app = new DuolaWorkApp({ dbPath, autoImportAgentHub: false });
  try {
    const codex = app.db.upsertMember({
      id: 'mem_codex_real',
      name: 'Codex',
      platformId: 'codex',
      driverKind: 'codex-app-server',
      location: 'local',
      capabilities: { supportsIsolatedSessions: true, supportsSessionResume: true, supportsCancel: true, maxConcurrentRuns: 2 },
      status: 'ready',
      statusMessage: 'ready',
      config: {}
    });
    const grok4 = app.db.upsertMember({
      id: 'mem_grok4_bot',
      name: 'grok4',
      platformId: 'grok-bot',
      driverKind: 'remote-bridge',
      location: 'remote-bridge',
      capabilities: { supportsIsolatedSessions: false, supportsSessionResume: false, supportsCancel: false, maxConcurrentRuns: 1 },
      status: 'ready',
      statusMessage: 'ready',
      config: { remoteMode: 'hub-channel' }
    });
    const gemVps = app.db.upsertMember({
      id: 'mem_gem_vps',
      name: 'Gemini2VPS',
      platformId: 'antigravity',
      driverKind: 'remote-bridge',
      location: 'remote-bridge',
      capabilities: { supportsIsolatedSessions: true, supportsSessionResume: true, supportsCancel: false, maxConcurrentRuns: 2 },
      status: 'ready',
      statusMessage: 'ready',
      config: { remoteMode: 'native-runtime' }
    });

    // 1. Verify T3 token-cap tiers
    assert.equal(resolveHandoffBudgetBytes(codex), 16_000 * 3, 'Coding agent uses 16,000-token budget');
    assert.equal(resolveHandoffBudgetBytes(gemVps), 16_000 * 3, 'Gemini2VPS native runtime uses 16,000-token budget');
    assert.equal(resolveHandoffBudgetBytes(grok4), 4_000 * 3, 'Hub-channel bot uses compact 4,000-token budget');

    // 2. Create thread + consecutive switchOwner calls MUST collapse into 1 switch_notice
    const thread = app.threads.createThread({
      title: 'Portable Handoff 验证',
      activeOwnerMemberId: codex.id
    });
    app.threads.switchOwner(thread.id, grok4.id);
    app.threads.switchOwner(thread.id, gemVps.id);
    const msgsAfterSwitch = app.threads.listMessages(thread.id);
    const switchNotices = msgsAfterSwitch.filter((m) => m.authorKind === 'switch_notice');
    assert.equal(switchNotices.length, 1, 'Consecutive switches update in place to strictly 1 notice');
    assert.equal(switchNotices[0].handoffMeta?.fromMemberId, codex.id);
    assert.equal(switchNotices[0].handoffMeta?.toMemberId, gemVps.id);
    app.threads.switchOwner(thread.id, codex.id);
    assert.equal(app.threads.listMessages(thread.id).length, 0, 'Returning before sending cancels the pending transfer');
    assert.equal(app.threads.previewPendingHandoff(thread.id).meta.fromMemberId, null);
    app.threads.switchOwner(thread.id, grok4.id);

    // 3. Seed 40 messages (> 12 KiB) where first user goal & toolTrace exist on Codex
    const sampleMsgs = [];
    for (let i = 1; i <= 40; i++) {
      const seq = i + 1;
      const isUser = i % 2 === 1;
      sampleMsgs.push({
        id: `m_${i}`,
        threadId: thread.id,
        seq,
        authorKind: isUser ? ('user' as const) : ('agent' as const),
        authorId: isUser ? 'owner' : codex.id,
        targetMemberId: codex.id,
        attemptId: null,
        body: isUser
          ? i === 1
            ? '初始核心需求：完成 DuolaWork 上下文转移并修复截图里的 UI 瑕疵。'
            : `第 ${i} 轮用户补充需求：` + '详细规格对齐说明文本'.repeat(40)
          : `Codex 第 ${i} 轮处理报告：` + '代码分析与变更结果描述'.repeat(40),
        artifactRefs: [],
        toolTrace: !isUser
          ? [{ id: `t_${i}`, name: '执行命令', summary: `git status --round ${i}`, status: 'done' as const }]
          : undefined,
        taskCard: null,
        turnStatus: 'completed' as const,
        usage: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    const nameMap = new Map(app.db.listMembers().map((m) => [m.id, m.name]));
    const botHandoff = app.handoff.buildPromptWithBoundedHandoff({
      threadId: thread.id,
      targetMemberId: grok4.id,
      currentUserSeq: 99,
      currentUserBody: 'grok4 你来总结一下当前进展',
      priorMessages: sampleMsgs,
      boundArtifact: null,
      activeTasksSummary: [],
      memberNameById: nameMap,
      canReadHistoryTool: false,
      tokenBudgetMember: grok4
    });

    assert.ok(botHandoff.handoffBytes <= 4_000 * 3, 'Bot handoff respects compact budget');
    assert.match(botHandoff.fullPrompt, /\[初始目标锚定 \(#2\)\].*初始核心需求/, 'Pins founding goal anchor on overflow');
    assert.match(botHandoff.fullPrompt, /\[#\d+ Codex\]/, 'Uses human-readable member name instead of raw ID');
    assert.match(botHandoff.fullPrompt, /\[操作: 执行命令\(git status/, 'Includes tool outcome trail');
    assert.match(botHandoff.fullPrompt, /较早消息摘要：/, 'Provides compact digest when target lacks history tool');
    assert.equal(/thread_read_history/.test(botHandoff.fullPrompt), false, 'Does not instruct cloud bot to call missing tool');

    // 4. Persist bridgeMeta across close & restart AND collapse legacy consecutive switch_notice rows on migrate
    app.handoff.confirmHandoffDelivered(thread.id, gemVps.id, 41, 'native_sess_vps', {
      bridgeChannelId: 'ch_persist_xyz'
    });
    app.db.sqlite
      .prepare(
        `INSERT INTO v2_thread_messages (id, thread_id, seq, author_kind, author_id, body, artifact_refs_json, turn_status, created_at, updated_at)
         VALUES ('usr_sep', ?, 100, 'user', 'owner', '中间分隔消息', '[]', 'completed', ?, ?),
                ('sw_old1', ?, 101, 'switch_notice', 'system', '已切换至 grok1', '[]', 'completed', ?, ?),
                ('sw_old2', ?, 102, 'switch_notice', 'system', '已切换至 grok4', '[]', 'completed', ?, ?)`
      )
      .run(
        thread.id,
        new Date().toISOString(),
        new Date().toISOString(),
        thread.id,
        new Date().toISOString(),
        new Date().toISOString(),
        thread.id,
        new Date().toISOString(),
        new Date().toISOString()
      );
    await app.close();

    app = new DuolaWorkApp({ dbPath, autoImportAgentHub: false });
    const restoredCursor = app.handoff.getCursor(thread.id, gemVps.id);
    assert.deepEqual(restoredCursor?.bridgeMeta, { bridgeChannelId: 'ch_persist_xyz' }, 'bridgeMeta persisted across restart');

    const cleanedNotices = app.threads
      .listMessages(thread.id)
      .filter((m) => m.authorKind === 'switch_notice');
    assert.equal(cleanedNotices.length, 2, 'Old non-consecutive switch kept, consecutive legacy run collapsed to 1');
    assert.equal(cleanedNotices[1].body, '已切换至 grok4');
  } finally {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DW2-16: Audit #1 late-arriving conclusion after owner switch is caught up ONCE on next turn', async () => {
  const { app, cleanup } = createTestApp();
  try {
    const thread = app.threads.createThread({
      title: '并发迟到回复补交测试',
      activeOwnerMemberId: 'mem_gemini'
    });

    let releaseGemini!: () => void;
    const geminiGate = new Promise<void>((r) => {
      releaseGemini = r;
    });
    app.registry.mockDriver.handlers.set('mem_gemini', async () => {
      await geminiGate;
      return { text: 'Gemini迟到结论：最终定案采用 scheme_beta' };
    });

    const capturedCodexPrompts: string[] = [];
    app.registry.mockDriver.handlers.set('mem_codex', async (inp) => {
      capturedCodexPrompts.push(inp.prompt);
      return { text: `Codex 回复 #${capturedCodexPrompts.length}` };
    });

    // 1. Start slow Gemini turn (seq=1 user, seq=2 agent placeholder running)
    const slowGeminiPromise = app.threads.sendUserMessage({
      threadId: thread.id,
      body: 'Gemini 请深入调研两套备选方案'
    });
    await new Promise((r) => setTimeout(r, 25));

    // 2. Switch to Codex while Gemini is still running & complete Turn 2 on Codex
    app.threads.switchOwner(thread.id, 'mem_codex');
    await app.threads.sendUserMessage({
      threadId: thread.id,
      body: 'Codex 先搭好脚手架'
    });
    assert.ok(!capturedCodexPrompts[0].includes('Gemini迟到结论'));

    // 3. Gemini finishes Turn 1 AFTER Codex already moved last_seen_seq past seq=2!
    releaseGemini();
    await slowGeminiPromise;

    // 4. Turn 3 to Codex MUST catch up seq=2 late conclusion cleanly!
    const turn3 = await app.threads.sendUserMessage({
      threadId: thread.id,
      body: '现在根据前面分析继续收口'
    });
    assert.match(capturedCodexPrompts[1], /\[#2 Gemini2VPS\] \[迟到回复补交\] Gemini迟到结论：最终定案采用 scheme_beta/);
    assert.deepEqual(turn3.agentMessage.handoffMeta?.lateArrivalSeqs, [2]);
    assert.equal(app.threads.previewPendingHandoff(thread.id).meta.fromMemberId, null, 'A settled switch cannot become the source of a later turn');

    // 5. Turn 4 to Codex MUST NOT repeat seq=2!
    await app.threads.sendUserMessage({
      threadId: thread.id,
      body: '最后检查边界条件'
    });
    assert.equal(capturedCodexPrompts[2].includes('Gemini迟到结论'), false, 'Late arrival delivered strictly once');
  } finally {
    await cleanup();
  }
});

test('DW2-17: Audit #2 native session reset (ensureSession & mid-runTurn fallback) upgrades to full_thread_summary', async () => {
  const { app, cleanup } = createTestApp();
  try {
    const thread = app.threads.createThread({
      title: '会话重置全量兜底测试',
      activeOwnerMemberId: 'mem_codex'
    });

    app.registry.mockDriver.handlers.set('mem_codex', async () => ({
      text: '已记录初始约束 XYZ_888'
    }));
    await app.threads.sendUserMessage({
      threadId: thread.id,
      body: '初始关键约束 MUST_KEEP_TOKEN_777'
    });

    // Case A: ensureSession reports resumed=false when resuming previous native session
    const origEnsure = app.registry.mockDriver.ensureSession.bind(app.registry.mockDriver);
    let forceEnsureResetOnce = true;
    app.registry.mockDriver.ensureSession = async (inp) => {
      if (forceEnsureResetOnce) {
        forceEnsureResetOnce = false;
        return { nativeSessionId: 'mock_reset_sess_a', resumed: false };
      }
      return origEnsure(inp);
    };

    let seenAfterEnsureReset = '';
    app.registry.mockDriver.handlers.set('mem_codex', async (inp) => {
      seenAfterEnsureReset = inp.prompt;
      return { text: '全量兜底回复 A' };
    });

    const resA = await app.threads.sendUserMessage({
      threadId: thread.id,
      body: '继续'
    });
    assert.match(seenAfterEnsureReset, /strategy="full_thread_summary"/);
    assert.match(seenAfterEnsureReset, /MUST_KEEP_TOKEN_777/);
    assert.equal(resA.agentMessage.handoffMeta?.reason, 'session_reset');

    // Case B: ensureSession returned resumed=true, then runTurn fell back to fresh session using fallbackFullPrompt
    let seenFallbackPrompt = '';
    app.registry.mockDriver.handlers.set('mem_codex', async (inp) => {
      seenFallbackPrompt = inp.fallbackFullPrompt || '';
      return { text: 'mid-runTurn reset recovered', nativeSessionId: 'mock_reset_sess_b', sessionReset: true };
    });
    const resB = await app.threads.sendUserMessage({
      threadId: thread.id,
      body: '再继续'
    });
    assert.match(seenFallbackPrompt, /strategy="full_thread_summary"/);
    assert.match(seenFallbackPrompt, /MUST_KEEP_TOKEN_777/);
    assert.equal(resB.agentMessage.handoffMeta?.reason, 'session_reset');
    const attB = app.registry.getAttempt(resB.agentMessage.attemptId!)!;
    assert.equal(attB.promptBytes, Buffer.byteLength(seenFallbackPrompt, 'utf8'));
  } finally {
    await cleanup();
  }
});

test('DW2-18: Audit #3 syncReconciledThreadTurns preserves bridge_meta_json onto handoff cursor', async () => {
  const { app, cleanup } = createTestApp();
  try {
    const bot = app.db.upsertMember({
      id: 'mem_reconcile_bot',
      name: 'ReconcileBot',
      platformId: 'grok-bot',
      driverKind: 'mock',
      location: 'remote-bridge',
      capabilities: { supportsIsolatedSessions: false, supportsSessionResume: true, supportsCancel: false, maxConcurrentRuns: 1 },
      status: 'ready',
      statusMessage: 'ready',
      config: { remoteMode: 'hub-channel' }
    });
    const thread = app.threads.createThread({
      title: '对账同步 bridgeMeta 测试',
      activeOwnerMemberId: bot.id
    });

    const attId = 'att_rec_bridge_1';
    const msgId = 'msg_rec_agent_1';
    const now = new Date().toISOString();
    app.db.sqlite
      .prepare(
        `INSERT INTO v2_dispatch_attempts (
          id, target_kind, target_id, thread_id, member_id, idempotency_key, scope_key,
          native_session_id, bridge_meta_json, status, slot_held, prompt_digest, prompt_bytes, handoff_bytes, usage_json, dispatched_at
        ) VALUES (?, 'thread_message', ?, ?, ?, 'idk_rec_1', ?, 'hub-channel:ch_reconcile_777', ?, 'reconciling', 0, 'dig', 10, 0, ?, ?)`
      )
      .run(
        attId,
        msgId,
        thread.id,
        bot.id,
        `thread:${thread.id}:${bot.id}`,
        JSON.stringify({ bridgeChannelId: 'ch_reconcile_777', bridgeMessageId: 'bm_1' }),
        JSON.stringify({ workbenchDispatches: 1, nativeTurns: 0, providerUsage: { observable: false, modelRequests: null, inputTokens: null, cachedInputTokens: null, uncachedInputTokens: null, outputTokens: null, totalTokens: null } }),
        now
      );
    app.db.sqlite
      .prepare(
        `INSERT INTO v2_thread_messages (id, thread_id, seq, author_kind, author_id, target_member_id, attempt_id, body, artifact_refs_json, turn_status, created_at, updated_at)
         VALUES ('msg_rec_u1', ?, 1, 'user', 'owner', ?, NULL, '首问', '[]', 'completed', ?, ?),
                (?, ?, 2, 'agent', ?, ?, ?, '', '[]', 'running', ?, ?)`
      )
      .run(thread.id, bot.id, now, now, msgId, thread.id, bot.id, bot.id, attId, now, now);

    app.registry.mockDriver.reconciledResults.set(attId, {
      state: 'completed',
      text: '对账取回远端答复',
      nativeSessionId: 'hub-channel:ch_reconcile_777'
    });

    await app.registry.reconcileInFlightAttempts();
    const updated = app.threads.syncReconciledThreadTurns();
    assert.equal(updated.length, 1);
    const cursor = app.handoff.getCursor(thread.id, bot.id);
    assert.equal(cursor?.bridgeMeta?.bridgeChannelId, 'ch_reconcile_777', 'bridgeMeta preserved on cursor after reconcile');

    let nextTurnBridgeMeta: Record<string, unknown> | null | undefined;
    app.registry.mockDriver.handlers.set(bot.id, async (inp) => {
      nextTurnBridgeMeta = inp.bridgeMeta;
      return { text: '复用通道回复' };
    });
    await app.threads.sendUserMessage({ threadId: thread.id, body: '第二轮复用原通道' });
    assert.equal(nextTurnBridgeMeta?.bridgeChannelId, 'ch_reconcile_777');
  } finally {
    await cleanup();
  }
});

test('DW2-19 & DW2-20: Audit #4 & #5 long single message preservation + head/tail reread pointer + strict 64-task byte cap', async () => {
  const { app, cleanup } = createTestApp();
  try {
    const codex = app.db.getMember('mem_codex')!;
    const thread = app.threads.createThread({
      title: '长消息与预算硬上限测试',
      activeOwnerMemberId: codex.id
    });

    // DW2-19A: 1,450-char single message inside 12,000 B MUST NOT silently truncate at 1,200 chars!
    const body1450 = 'A'.repeat(1410) + 'TAIL_END_MARKER_1450';
    const msg1450 = {
      id: 'm_1450',
      threadId: thread.id,
      seq: 2,
      authorKind: 'user' as const,
      authorId: 'owner',
      targetMemberId: codex.id,
      attemptId: null,
      body: body1450,
      artifactRefs: [],
      taskCard: null,
      turnStatus: 'completed' as const,
      usage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const pkt1450 = app.handoff.buildPromptWithBoundedHandoff({
      threadId: thread.id,
      targetMemberId: codex.id,
      currentUserSeq: 3,
      currentUserBody: '处理',
      priorMessages: [msg1450],
      boundArtifact: null,
      activeTasksSummary: [],
      canReadHistoryTool: true,
      budgetBytes: 12_000
    });
    assert.deepEqual(pkt1450.truncatedSeqs, [], '1450-char message fits cleanly inside 12KB without truncation');
    assert.ok(pkt1450.handoffText.includes('TAIL_END_MARKER_1450'), 'End of 1450-char message preserved verbatim');

    // DW2-19B: 15,000-char single message inside 12,000 B -> keeps head & tail + emits reread pointer
    const body15k = 'HEAD_GOAL_START_' + 'B'.repeat(14950) + '_FINAL_DECISION_TAIL';
    const pkt15k = app.handoff.buildPromptWithBoundedHandoff({
      threadId: thread.id,
      targetMemberId: codex.id,
      currentUserSeq: 3,
      currentUserBody: '处理',
      priorMessages: [{ ...msg1450, id: 'm_15k', body: body15k }],
      boundArtifact: null,
      activeTasksSummary: [],
      canReadHistoryTool: true,
      budgetBytes: 12_000
    });
    assert.ok(pkt15k.handoffBytes <= 12_000, `Single-msg overflow stays <= 12000 (${pkt15k.handoffBytes})`);
    assert.deepEqual(pkt15k.truncatedSeqs, [2]);
    assert.ok(pkt15k.handoffText.includes('HEAD_GOAL_START_'));
    assert.ok(pkt15k.handoffText.includes('_FINAL_DECISION_TAIL'));
    assert.match(pkt15k.handoffText, /thread_read_history\(fromSeq=2, toSeq=2\)/);

    // DW2-20: 64 active tasks + long artifact + 0 unseen messages strictly bounded <= 12,000 B
    const art = app.artifacts.createArtifact({
      sourceThreadId: thread.id,
      title: '超长架构文档.md',
      content: '设计章节'.repeat(2000),
      writerKind: 'user',
      writerId: 'owner'
    });
    const tasks64 = Array.from(
      { length: 64 },
      (_, i) =>
        `- 任务《第${i + 1}项多维市场情报与合规链路定时巡检任务》(定时, 负责人:Codex) 状态=running 待确认:请核对数据源 #${i + 1} 是否同步启用风控校验与全量摘要导出`
    );
    const pktTasks = app.handoff.buildPromptWithBoundedHandoff({
      threadId: thread.id,
      targetMemberId: codex.id,
      currentUserSeq: 99,
      currentUserBody: '状态查询',
      priorMessages: [],
      boundArtifact: art,
      activeTasksSummary: tasks64,
      canReadHistoryTool: false,
      budgetBytes: 12_000
    });
    assert.ok(pktTasks.handoffBytes <= 12_000, `64-task header (${pktTasks.handoffBytes} B) must stay <= 12000 B`);
    assert.match(pktTasks.handoffText, /项任务已省略/);
    assert.ok(pktTasks.handoffText.endsWith('</context_handoff>'));
  } finally {
    await cleanup();
  }
});

test('DW2-21: Audit #6 tool-trace command summary redacts passwords, signed URLs & auth headers across DB, SSE & handoff', async () => {
  const { app, cleanup } = createTestApp();
  try {
    const rawCmd =
      `/bin/zsh -lc "MYSQL_PWD=DbSecret!99 curl -H 'Authorization: Basic dXNlcjpwYXNz' 'https://alice:S3cr3tPass@cdn.example.com/data/export?sig=deadbeef99&token=top_url_tok'"`;
    const cleanedCmd = sanitizeToolSummary('command', rawCmd) || '';
    assert.equal(cleanedCmd.includes('DbSecret!99'), false);
    assert.equal(cleanedCmd.includes('dXNlcjpwYXNz'), false);
    assert.equal(cleanedCmd.includes('S3cr3tPass'), false);
    assert.equal(cleanedCmd.includes('deadbeef99'), false);
    assert.equal(cleanedCmd.includes('top_url_tok'), false);
    assert.match(cleanedCmd, /^curl https:\/\/cdn\.example\.com\/data\/export$/);

    const thread = app.threads.createThread({
      title: '工具轨迹脱敏测试',
      activeOwnerMemberId: 'mem_codex'
    });
    const emittedToolPayloads: string[] = [];
    const unsub = app.threads.subscribe((ev) => {
      if (ev.type === 'thread.tool') emittedToolPayloads.push(JSON.stringify(ev.payload));
    });

    app.registry.mockDriver.handlers.set('mem_codex', async (_inp, onEvent) => {
      onEvent?.({
        kind: 'tool',
        toolId: 't_sec_1',
        toolName: '执行命令',
        toolSummary: rawCmd,
        toolStatus: 'done'
      });
      onEvent?.({
        kind: 'tool',
        toolId: 't_sec_2',
        toolName: 'mcp_call',
        toolSummary: 'api_key=sk-proj-secret12345 password=hunter_pwd',
        toolStatus: 'done'
      });
      return { text: '执行完毕' };
    });

    const res = await app.threads.sendUserMessage({ threadId: thread.id, body: '帮我查一下接口状态' });
    unsub();

    const dbRowJson = JSON.stringify(res.agentMessage.toolTrace);
    const sseCombined = emittedToolPayloads.join('\n');
    app.threads.switchOwner(thread.id, 'mem_gemini');
    const preview = app.threads.previewPendingHandoff(thread.id, 'mem_gemini');

    for (const surface of [dbRowJson, sseCombined, preview.meta.previewText || '']) {
      for (const secret of ['DbSecret!99', 'dXNlcjpwYXNz', 'S3cr3tPass', 'deadbeef99', 'top_url_tok', 'sk-proj-secret12345', 'hunter_pwd']) {
        assert.equal(surface.includes(secret), false, `Secret ${secret} must not leak`);
      }
    }
  } finally {
    await cleanup();
  }
});

test('DW2-22: resolveLocalCliBinary prefers ~/.local/bin then highest semver nvm Node version (never stale v20)', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-cli-res-'));
  try {
    const v20Bin = path.join(fakeHome, '.nvm', 'versions', 'node', 'v20.20.2', 'bin');
    const v24Bin = path.join(fakeHome, '.nvm', 'versions', 'node', 'v24.19.0', 'bin');
    const localBin = path.join(fakeHome, '.local', 'bin');
    fs.mkdirSync(v20Bin, { recursive: true });
    fs.mkdirSync(v24Bin, { recursive: true });
    fs.mkdirSync(localBin, { recursive: true });

    const binName = process.platform === 'win32' ? 'codex.cmd' : 'codex';
    const v20Exe = path.join(v20Bin, binName);
    const v24Exe = path.join(v24Bin, binName);
    const localExe = path.join(localBin, binName);
    for (const f of [v20Exe, v24Exe, localExe]) {
      fs.writeFileSync(f, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    }

    assert.equal(resolveLocalCliBinary('codex', { homeDir: fakeHome, pathEnv: '' }), localExe);
    fs.rmSync(localExe);
    assert.equal(resolveLocalCliBinary('codex', { homeDir: fakeHome, pathEnv: '' }), v24Exe);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('DW2-23: remote-bridge & local drivers receive <duolawork_task> instructions, create multiple scheduled/once tasks by member name, and surface parse errors visibly', async () => {
  const { app, cleanup } = createTestApp();
  try {
    // Register a mock driver under 'remote-bridge' to inspect the exact remote-bridge prompt without network calls
    const baseMock = app.registry.mockDriver;
    const capturedRemotePrompts: string[] = [];
    app.registry.register({
      kind: 'remote-bridge',
      checkHealth: () => baseMock.checkHealth(),
      ensureSession: (inp) => baseMock.ensureSession(inp),
      reconcileAttempt: (m, a) => baseMock.reconcileAttempt(m, a),
      abortTurn: () => baseMock.abortTurn(),
      runTurn: async (inp, onEvent) => {
        capturedRemotePrompts.push(inp.prompt);
        return baseMock.runTurn(inp, onEvent);
      }
    });

    const remoteMember = app.db.upsertMember({
      id: 'mem_gemini',
      name: 'Gemini2VPS',
      platformId: 'antigravity',
      driverKind: 'remote-bridge',
      location: 'remote-bridge',
      capabilities: {
        supportsIsolatedSessions: true,
        supportsSessionResume: true,
        supportsCancel: true,
        maxConcurrentRuns: 2
      },
      status: 'ready',
      statusMessage: 'ready',
      config: { remoteMode: 'native-runtime' }
    });

    const thread = app.threads.createThread({
      title: '内容群每日三次推送',
      activeOwnerMemberId: remoteMember.id
    });

    // Agent emits 3 daily scheduled tasks in one turn (1st standalone tag, 2nd+3rd as JSON array in fenced tag) + resolves lead by name & omits steps
    baseMock.handlers.set(remoteMember.id, async () => ({
      text: [
        '已在当前对话建立每日三次推送任务：',
        `<duolawork_task>{"title":"早报08:00","kind":"scheduled","cronExpr":"0 8 * * *","leadMemberId":"Gemini2VPS","goal":"发送08:00早报"}</duolawork_task>`,
        `<duolawork_task>\n\`\`\`json\n[{"title":"午报14:00","kind":"scheduled","cronExpr":"0 14 * * *","leadMemberId":"Gemini2VPS","goal":"发送14:00午报","startImmediately":true},{"title":"晚报20:00","kind":"scheduled","cronExpr":"0 20 * * *","leadMemberId":"Gemini2VPS","goal":"发送20:00晚报"}]\n\`\`\`\n</duolawork_task>`
      ].join('\n')
    }));

    const reply = await app.threads.sendUserMessage({
      threadId: thread.id,
      body: '帮我在这个新群建每日 08:00、14:00、20:00 三个定时推送任务'
    });

    // Verify prompt includes both onboarding protocol & anti-legacy-Hub guardrail + <duolawork_task> instructions
    assert.ok(capturedRemotePrompts.length >= 1);
    assert.match(capturedRemotePrompts[0], /<duolawork_v2_protocol/);
    assert.match(capturedRemotePrompts[0], /<duolawork_task>/);
    assert.match(capturedRemotePrompts[0], /严禁调用旧版 Agent Hub \(1\.9\.6\)/);

    const createdTasks = app.tasks.listTasks({ sourceThreadId: thread.id });
    assert.equal(createdTasks.length, 3, 'All 3 scheduled tasks created cleanly in one reply');
    const noonTask = createdTasks.find((t) => t.title === '午报14:00')!;
    assert.ok(noonTask, '14:00 task exists');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(app.tasks.listRuns(noonTask.id).length, 1, 'startImmediately=true creates initial run on scheduled task');
    assert.equal(reply.agentMessage.body.includes('<duolawork_task>'), false, 'Raw XML tags stripped from visible chat');

    // Malformed <duolawork_task> MUST surface explicit warning rather than silently vanishing or leaving raw XML!
    baseMock.handlers.set(remoteMember.id, async () => ({
      text: '好的\n<duolawork_task>{not valid json}</duolawork_task>'
    }));
    const badReply = await app.threads.sendUserMessage({
      threadId: thread.id,
      body: '再建一个错误格式的任务'
    });
    assert.match(badReply.agentMessage.body, /自动创建任务失败/);
    assert.equal(badReply.agentMessage.body.includes('<duolawork_task>'), false);
  } finally {
    await cleanup();
  }
});

test('DW2-24: invalid cron rejected 400, non-timeout step error marks run failed (never stuck running), solo task uses 1 LLM turn, cancel & delete work cleanly', async () => {
  const { app, cleanup } = createTestApp();
  const { url } = await app.listen(0, '127.0.0.1');
  try {
    const thread = app.threads.createThread({
      title: '任务健壮性测试',
      activeOwnerMemberId: 'mem_codex',
      initialDocTitle: '已有文稿.md',
      initialDocContent: '# 初始内容'
    });

    // 1. Invalid cron rejected with HTTP 400
    const badCronRes = await fetch(`${url}/api/v2/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceThreadId: thread.id,
        title: '非法周期任务',
        kind: 'scheduled',
        cronExpr: 'every day at 8am',
        leadMemberId: 'mem_codex',
        spec: { goal: 'test', steps: [] }
      })
    });
    assert.equal(badCronRes.status, 400);

    // 2. Non-timeout step error MUST mark step & run 'failed' and post 'failed' task card (never stuck 'running')
    app.registry.mockDriver.handlers.set('mem_grok', async () => {
      throw new Error('模拟远端通道 HTTP 502');
    });
    const failTaskRes = await fetch(`${url}/api/v2/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceThreadId: thread.id,
        title: '步骤报错不卡死测试',
        kind: 'once',
        leadMemberId: 'mem_codex',
        spec: {
          goal: 'test fail',
          steps: [
            {
              stepOrder: 1,
              title: '采集节点',
              assigneeMemberId: 'mem_grok',
              brief: 'run',
              acceptanceCriteria: 'ok'
            }
          ]
        }
      })
    });
    assert.equal(failTaskRes.status, 201);
    const failData = await failTaskRes.json();
    await new Promise((r) => setTimeout(r, 100));

    const settledFailRun = app.tasks.getRun(failData.initialRun.id)!;
    const settledFailSteps = app.tasks.listSteps(failData.initialRun.id);
    assert.equal(settledFailRun.status, 'failed', 'Run transitioned to failed instead of stuck running');
    assert.match(settledFailRun.summary || '', /模拟远端通道 HTTP 502/);
    assert.equal(settledFailSteps[0].status, 'failed');

    const failCards = app.threads
      .listMessages(thread.id)
      .filter((m) => m.taskCard?.taskId === failData.task.id && m.taskCard?.kind === 'failed');
    assert.equal(failCards.length, 1, 'Posted failed task card back to thread');

    const retried = app.tasks.requestManualRun(failData.task.id, settledFailRun.id);
    assert.equal(retried.created,true);
    assert.equal(app.tasks.requestManualRun(failData.task.id, settledFailRun.id).run.id, retried.run.id);
    await app.tasks.cancelRun(retried.run.id);

    // 3. Solo single-step task owned & executed by same member uses strictly 1 LLM turn (no double self-review)
    const beforePrompts = app.registry.mockDriver.recordedPrompts.length;
    app.registry.mockDriver.handlers.set('mem_codex', async () => ({
      text: '单独完成任务交付正文'
    }));
    const soloRes = await fetch(`${url}/api/v2/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceThreadId: thread.id,
        title: '单人自交付',
        kind: 'once',
        leadMemberId: 'Codex',
        spec: { goal: '产出单步成果', steps: [] }
      })
    });
    assert.equal(soloRes.status, 201);
    const soloData = await soloRes.json();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(app.tasks.getRun(soloData.initialRun.id)!.status, 'completed');
    assert.equal(
      app.registry.mockDriver.recordedPrompts.length - beforePrompts,
      1,
      'Solo self-owned step auto-accepts cleanly in 1 LLM call'
    );
    const deliveredArtifactId = app.tasks.getRun(soloData.initialRun.id)!.finalArtifactId!;
    assert.ok(app.artifacts.getArtifact(deliveredArtifactId));
    const soloThreadMsgs = app.threads.listMessages(thread.id);
    assert.ok(
      soloThreadMsgs.some((m) => m.authorKind === 'agent' && m.body.includes('单独完成任务交付正文')),
      'Solo task also posts full deliverable text directly as agent message in thread'
    );
    assert.equal(
      soloThreadMsgs.filter((m) => m.taskCard?.taskId === soloData.task.id && m.taskCard?.kind === 'delivered').length,
      1
    );

    // 4. Cancel running run + Delete task preserves generated artifacts safely
    let releaseSlow!: () => void;
    app.registry.mockDriver.handlers.set(
      'mem_codex',
      () => new Promise((resolve) => {
        releaseSlow = () => resolve({ text: 'late cancel ignored' });
      })
    );
    const slowRes = await fetch(`${url}/api/v2/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceThreadId: thread.id,
        title: '可手动停止与删除的任务',
        kind: 'once',
        leadMemberId: 'mem_codex',
        spec: { goal: 'slow run', steps: [] }
      })
    });
    const slowData = await slowRes.json();
    await new Promise((r) => setTimeout(r, 40));

    const cancelRes = await fetch(`${url}/api/v2/runs/${slowData.initialRun.id}/cancel`, {
      method: 'POST'
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(app.tasks.getRun(slowData.initialRun.id)!.status, 'canceled');
    releaseSlow?.();

    const delRes = await fetch(`${url}/api/v2/tasks/${soloData.task.id}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    assert.equal(app.tasks.getTask(soloData.task.id), null);
    const preservedArt = app.artifacts.getArtifact(deliveredArtifactId);
    assert.ok(preservedArt, 'Deleting a task preserves delivered Space document');
    assert.equal(preservedArt!.taskId, null);
  } finally {
    await cleanup();
  }
});

test('DW2-25: versioned <duolawork_v2_protocol> onboarding & /api/v2/members/sync-protocol-memory refreshes all members once per epoch', async () => {
  const { app, cleanup } = createTestApp();
  const { url } = await app.listen(0, '127.0.0.1');
  try {
    const thread = app.threads.createThread({
      title: '全员记忆同步测试',
      activeOwnerMemberId: 'mem_codex'
    });
    const prompts: string[] = [];
    app.registry.mockDriver.handlers.set('mem_codex', async (inp) => {
      prompts.push(inp.prompt);
      return { text: '收到' };
    });

    assert.equal(app.threads.getProtocolVersion(), DEFAULT_WORKBENCH_PROTOCOL_VERSION);

    // Turn 1: injects <duolawork_v2_protocol>
    await app.threads.sendUserMessage({ threadId: thread.id, body: '第一句' });
    assert.match(prompts[0], /<duolawork_v2_protocol version="/);

    // Turn 2: same epoch -> no redundant protocol re-injection
    await app.threads.sendUserMessage({ threadId: thread.id, body: '第二句' });
    assert.equal(prompts[1].includes('<duolawork_v2_protocol'), false);

    // Trigger all-member protocol memory update via HTTP
    const syncRes = await fetch(`${url}/api/v2/members/sync-protocol-memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'upgrade_test' })
    });
    assert.equal(syncRes.status, 200);
    const syncData = await syncRes.json();
    assert.notEqual(syncData.version, DEFAULT_WORKBENCH_PROTOCOL_VERSION);

    // Turn 3: new epoch triggers automatic protocol re-injection once!
    await app.threads.sendUserMessage({ threadId: thread.id, body: '第三句' });
    assert.ok(prompts[2].includes(`<duolawork_v2_protocol version="${syncData.version}"`));
  } finally {
    await cleanup();
  }
});

test('DW2-27: Codex tool name colon mapping, DuolaBase Connector & Vault HTTP proxy, Space material digests, worker tool delegation & Trash permanent purge', async () => {
  // 1. Verify Codex tool naming eliminates invalid ":" characters and round-trips cleanly
  assert.equal(toCodexWireToolName('duolabase:connector_call'), 'hub_duolabase__connector_call');
  assert.equal(toCodexWireToolName('duolabase:vault_http_proxy').includes(':'), false);
  assert.equal(fromCodexWireToolName('hub_duolabase__connector_call'), 'duolabase:connector_call');
  assert.equal(fromCodexWireToolName('hub_duolabase__vault_http_proxy'), 'duolabase:vault_http_proxy');
  assert.equal(toCodexWireToolName('space_read_material'), 'hub_space_read_material');
  assert.equal(fromCodexWireToolName('hub_space_read_material'), 'space_read_material');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-test-27-'));
  const mcpCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDir, 'test.sqlite'),
    worktreesRoot: path.join(tmpDir, 'worktrees'),
    autoImportAgentHub: false,
    externalMcpCaller: async (toolName, args) => {
      mcpCalls.push({ toolName, args });
      if (toolName === 'connector_list') return { items: [{ id: 'c_gh', name: 'GitHub' }] };
      if (toolName === 'vault_list') return { items: [{ id: 'v_api', name: 'API_TOKEN', service: 'demo' }] };
      if (toolName === 'vault_http_proxy') return { status: 200, body: 'PROXIED_OK' };
      return { ok: true, toolName };
    }
  });

  app.db.upsertMember({
    id: 'mem_codex',
    name: 'Codex',
    platformId: 'codex',
    driverKind: 'mock',
    location: 'local',
    capabilities: { supportsIsolatedSessions: true, supportsSessionResume: true, supportsCancel: true, maxConcurrentRuns: 2 },
    status: 'ready',
    statusMessage: 'ready',
    config: {}
  });
  app.db.upsertMember({
    id: 'mem_gemini',
    name: 'Gemini2VPS',
    platformId: 'antigravity',
    driverKind: 'mock',
    location: 'remote-bridge',
    capabilities: { supportsIsolatedSessions: true, supportsSessionResume: true, supportsCancel: true, maxConcurrentRuns: 2 },
    status: 'ready',
    statusMessage: 'ready',
    config: {}
  });

  try {
    const thread = app.threads.createThread({ title: '连接器与资料联通测试', activeOwnerMemberId: 'mem_codex' });
    const doc = app.space.createDocument({ threadId: thread.id, title: '方案稿.md', content: '# 初始方案正文' });
    const fileRec = app.space.saveFile({
      threadId: thread.id,
      name: 'notes.txt',
      mimeType: 'text/plain; charset=utf-8',
      dataBase64: Buffer.from('重要业务数据_XYZ').toString('base64')
    });
    const fileWithPath = app.space.getFileWithPath(fileRec.id)!;
    const lnk = app.space.createLink({
      threadId: thread.id,
      title: '规范站点',
      url: 'https://example.com/spec',
      note: '关键指标'
    });

    // 2. Thread owner claims (`duolabase_full`) can call connectors, vault proxy, & space tools — NEVER vault_reveal
    const ownerClaims = app.sandbox.issueScopedToken({
      principalKind: 'thread_owner',
      memberId: 'mem_codex',
      attemptId: 'att_owner_27',
      threadId: thread.id,
      toolPolicy: 'duolabase_full'
    });
    assert.deepEqual(await app.executeScopedAgentTool(ownerClaims, 'duolabase:connector_list', {}), {
      items: [{ id: 'c_gh', name: 'GitHub' }]
    });
    await app.executeScopedAgentTool(ownerClaims, 'duolabase:connector_discover', { connectorId: 'c_gh' });
    await app.executeScopedAgentTool(ownerClaims, 'duolabase:connector_call', {
      connectorId: 'c_gh',
      toolName: 'create_issue',
      arguments: { title: 'hi' }
    });
    await app.executeScopedAgentTool(ownerClaims, 'duolabase:vault_list', { service: 'demo' });
    const proxyRes = await app.executeScopedAgentTool(ownerClaims, 'duolabase:vault_http_proxy', {
      credentialId: 'v_api',
      url: 'https://api.example.com/data',
      method: 'POST'
    });
    assert.deepEqual(proxyRes, { status: 200, body: 'PROXIED_OK' });

    await assert.rejects(
      () => app.executeScopedAgentTool(ownerClaims, 'duolabase:vault_reveal', { credentialId: 'v_api' }),
      (e: unknown) => e instanceof SandboxForbiddenError && e.code === 'secret_reveal_or_mutation_forbidden'
    );

    const listedSpace = (await app.executeScopedAgentTool(ownerClaims, 'space_list_materials', {})) as { items: any[] };
    assert.equal(listedSpace.items.length, 3);
    const readDoc = (await app.executeScopedAgentTool(ownerClaims, 'space_read_material', {
      kind: 'document',
      id: doc.id
    })) as Record<string, unknown>;
    assert.match(String(readDoc.content), /初始方案正文/);
    const readFile = (await app.executeScopedAgentTool(ownerClaims, 'space_read_material', {
      kind: 'file',
      id: fileRec.id
    })) as Record<string, unknown>;
    assert.equal(readFile.content, '重要业务数据_XYZ');
    const readLink = (await app.executeScopedAgentTool(ownerClaims, 'space_read_material', {
      kind: 'link',
      id: lnk.id
    })) as Record<string, unknown>;
    assert.equal(readLink.url, 'https://example.com/spec');

    // 3. Readonly vault_http_proxy allows GET but blocks POST
    const roClaims = app.sandbox.issueScopedToken({
      principalKind: 'task_worker',
      memberId: 'mem_codex',
      attemptId: 'att_ro_27',
      threadId: thread.id,
      taskId: 't1',
      runId: 'r1',
      stepId: 's1',
      toolPolicy: 'duolabase_readonly'
    });
    await app.executeScopedAgentTool(roClaims, 'duolabase:vault_http_proxy', {
      credentialId: 'v_api',
      url: 'https://api.example.com/read',
      method: 'GET'
    });
    await assert.rejects(
      () =>
        app.executeScopedAgentTool(roClaims, 'duolabase:vault_http_proxy', {
          credentialId: 'v_api',
          url: 'https://api.example.com/write',
          method: 'POST'
        }),
      (e: unknown) => e instanceof SandboxForbiddenError && e.code === 'external_write_forbidden'
    );

    // 4. Thread user message automatically injects [协作空间资料] with file path + snippet + link + doc
    let capturedChatPrompt = '';
    app.registry.mockDriver.handlers.set('mem_codex', async (inp) => {
      if (inp.scopeKey.startsWith('thread:')) {
        capturedChatPrompt = inp.prompt;
      }
      return { text: '已查阅所有资料' };
    });
    await app.threads.sendUserMessage({ threadId: thread.id, body: '帮我看下资料' });
    assert.match(capturedChatPrompt, /\[协作空间资料\]/);
    assert.match(capturedChatPrompt, /方案稿\.md/);
    assert.match(capturedChatPrompt, /重要业务数据_XYZ/);
    assert.match(capturedChatPrompt, /https:\/\/example\.com\/spec/);

    // 5. Task step receives linked Space materials digest + DuolaBase/Space tools!
    let capturedStepPrompt = '';
    let workerConnectorOk = false;
    app.registry.mockDriver.handlers.set('mem_codex', async (inp) => {
      if (inp.scopeKey.startsWith('step:')) {
        capturedStepPrompt = inp.prompt;
        const c = await inp.onToolCall?.('duolabase:vault_list', {});
        workerConnectorOk = Boolean(c);
      }
      return { text: '步骤完成' };
    });
    const createdTask = app.tasks.createOrUpdateTask({
      sourceThreadId: thread.id,
      title: '读取资料与凭证测试任务',
      leadMemberId: 'mem_codex',
      spec: { goal: 'verify worker access', steps: [] }
    });
    app.space.associateMaterialWithTask({
      threadId: thread.id,
      kind: 'file',
      id: fileRec.id,
      taskId: createdTask.task.id,
      role: 'input'
    });
    await app.tasks.driveRun(createdTask.initialRun!.id);
    assert.match(capturedStepPrompt, /关联协作空间参考材料/);
    assert.match(capturedStepPrompt, /重要业务数据_XYZ/);
    assert.equal(workerConnectorOk, true);

    // 6. Soft-delete excludes from agent read; purgeItem deletes from SQLite and removes file bytes from disk!
    app.space.mutateItem({ kind: 'file', id: fileRec.id, action: 'delete' });
    await assert.rejects(
      () => app.executeScopedAgentTool(ownerClaims, 'space_read_material', { kind: 'file', id: fileRec.id }),
      /不存在或已移入回收站/
    );
    app.space.purgeItem('file', fileRec.id);
    assert.equal(fs.existsSync(fileWithPath.absPath), false, 'File removed from disk after permanent purge');
  } finally {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DW2-28: Scheduled tasks default to 900s timeout, catch_up_once across sleep (clamped to createdAt), and inject remote-bridge guardrail', async () => {
  const { app, cleanup } = createTestApp();
  try {
    const thread = app.threads.createThread({
      title: '长耗时定时与睡眠补跑测试',
      activeOwnerMemberId: 'mem_gemini'
    });

    const created = app.tasks.createOrUpdateTask({
      sourceThreadId: thread.id,
      title: 'Xhunter 晚报稳定性测试',
      kind: 'scheduled',
      cronExpr: '0 20 * * *',
      timezone: 'Asia/Shanghai',
      leadMemberId: 'mem_gemini',
      startImmediately: false,
      spec: { goal: '产出晚报', steps: [] }
    });
    assert.equal(created.task.spec.stepTimeoutMs, 900_000, 'Default stepTimeoutMs raised to 15 min');
    assert.equal(created.task.misfirePolicy, 'catch_up_once', 'Scheduled tasks default to catch_up_once');

    // Backdate createdAt to yesterday so catch_up_once detects today's missed slot after sleep
    const yesterdayIso = new Date(Date.now() - 24 * 3600_000).toISOString();
    app.db.sqlite.prepare(`UPDATE v2_tasks SET created_at = ? WHERE id = ?`).run(yesterdayIso, created.task.id);

    // Simulate Mac waking up at 08:25 Asia/Shanghai after last tick at 07:50 for a 08:00 task
    const morningTask = app.tasks.createOrUpdateTask({
      sourceThreadId: thread.id,
      title: '08:00 早报补跑校验',
      kind: 'scheduled',
      cronExpr: '0 8 * * *',
      timezone: 'Asia/Shanghai',
      leadMemberId: 'mem_gemini',
      startImmediately: false,
      spec: { goal: '产出早报', steps: [] }
    });
    app.db.sqlite.prepare(`UPDATE v2_tasks SET created_at = '2026-11-24T00:00:00.000Z' WHERE id = ?`).run(morningTask.task.id);

    const capturedWorkerPrompts: string[] = [];
    app.registry.mockDriver.handlers.set('mem_gemini', async (inp) => {
      if (inp.scopeKey.startsWith('step:')) capturedWorkerPrompts.push(inp.prompt);
      return { text: '早报正文已完成' };
    });

    const lastTick = new Date('2026-11-25T23:50:00.000Z'); // 2026-11-26 07:50 Asia/Shanghai
    const wakeNow = new Date('2026-11-26T00:25:00.000Z');  // 2026-11-26 08:25 Asia/Shanghai
    const catchUpRuns = await app.scheduler.tick(wakeNow, { lastCheckedAt: lastTick, awaitRuns: true });
    assert.equal(
      catchUpRuns.filter((r) => r.taskId === morningTask.task.id).length,
      1,
      'Missed 08:00 slot triggers strictly once on wake'
    );
    assert.match(
      capturedWorkerPrompts[0] || '',
      /严禁调用旧版 Agent Hub 的 board_task 或 schedule 工具/,
      'Remote-bridge worker receives anti-legacy-Hub guardrail'
    );

    // Subsequent tick in same hour must NOT re-trigger
    const secondWake = await app.scheduler.tick(new Date('2026-11-26T00:26:00.000Z'), {
      lastCheckedAt: wakeNow,
      awaitRuns: true
    });
    assert.equal(secondWake.filter((r) => r.taskId === morningTask.task.id).length, 0);

    // Brand-new task created AFTER 08:00 MUST NOT back-trigger 08:00 even if lastCheckedAt was 07:50!
    const createdAt810 = app.tasks.createOrUpdateTask({
      sourceThreadId: thread.id,
      title: '迟于08:00新建的任务',
      kind: 'scheduled',
      cronExpr: '0 8 * * *',
      timezone: 'Asia/Shanghai',
      leadMemberId: 'mem_gemini',
      startImmediately: false,
      spec: { goal: 'wait tomorrow', steps: [] }
    });
    app.db.sqlite
      .prepare(`UPDATE v2_tasks SET created_at = '2026-11-26T00:10:00.000Z' WHERE id = ?`)
      .run(createdAt810.task.id);
    const futureTick = await app.scheduler.tick(new Date('2026-11-26T00:27:00.000Z'), {
      lastCheckedAt: lastTick,
      awaitRuns: true
    });
    assert.equal(futureTick.filter((r) => r.taskId === createdAt810.task.id).length, 0);
  } finally {
    await cleanup();
  }
});

test('DW2-29: Interrupted turns settle cleanly on restart reconcile (not_found/failed/orphan never stay stuck running)', async () => {
  const { app, cleanup } = createTestApp();
  try {
    const codex = app.db.getMember('mem_codex')!;
    const thread = app.threads.createThread({
      title: '重启恢复防卡死测试',
      activeOwnerMemberId: codex.id
    });

    const now = new Date().toISOString();
    const oldIso = new Date(Date.now() - 60_000).toISOString();

    // Case 1: Attempt in `reconciling` whose driver returns `not_found` (e.g. local CLI lost on restart)
    app.db.sqlite
      .prepare(
        `INSERT INTO v2_dispatch_attempts (
          id, target_kind, target_id, thread_id, member_id, idempotency_key, scope_key,
          status, slot_held, prompt_digest, prompt_bytes, handoff_bytes, usage_json, dispatched_at
        ) VALUES ('att_lost_29', 'thread_message', 'msg_lost_29', ?, ?, 'idk_lost_29', ?, 'reconciling', 0, 'dig', 10, 0, ?, ?)`
      )
      .run(
        thread.id,
        codex.id,
        `thread:${thread.id}:${codex.id}`,
        JSON.stringify({ workbenchDispatches: 1, nativeTurns: 0, providerUsage: { observable: false, modelRequests: null, inputTokens: null, cachedInputTokens: null, uncachedInputTokens: null, outputTokens: null, totalTokens: null } }),
        now
      );
    app.db.sqlite
      .prepare(
        `INSERT INTO v2_thread_messages (id, thread_id, seq, author_kind, author_id, target_member_id, attempt_id, body, artifact_refs_json, turn_status, created_at, updated_at)
         VALUES ('msg_lost_u1', ?, 1, 'user', 'owner', ?, NULL, '测试消息', '[]', 'completed', ?, ?),
                ('msg_lost_29', ?, 2, 'agent', ?, ?, 'att_lost_29', '', '[]', 'running', ?, ?)`
      )
      .run(thread.id, codex.id, now, now, thread.id, codex.id, codex.id, now, now);

    // Case 2: Remote/stalled attempt returning `failed`
    app.db.sqlite
      .prepare(
        `INSERT INTO v2_dispatch_attempts (
          id, target_kind, target_id, thread_id, member_id, idempotency_key, scope_key,
          status, slot_held, prompt_digest, prompt_bytes, handoff_bytes, usage_json, dispatched_at
        ) VALUES ('att_stalled_29', 'thread_message', 'msg_stalled_29', ?, ?, 'idk_stalled_29', ?, 'reconciling', 0, 'dig', 10, 0, ?, ?)`
      )
      .run(
        thread.id,
        codex.id,
        `thread:${thread.id}:${codex.id}`,
        JSON.stringify({ workbenchDispatches: 1, nativeTurns: 0, providerUsage: { observable: false, modelRequests: null, inputTokens: null, cachedInputTokens: null, uncachedInputTokens: null, outputTokens: null, totalTokens: null } }),
        now
      );
    app.db.sqlite
      .prepare(
        `INSERT INTO v2_thread_messages (id, thread_id, seq, author_kind, author_id, target_member_id, attempt_id, body, artifact_refs_json, turn_status, created_at, updated_at)
         VALUES ('msg_stalled_29', ?, 3, 'agent', ?, ?, 'att_stalled_29', '', '[]', 'running', ?, ?)`
      )
      .run(thread.id, codex.id, codex.id, now, now);
    app.registry.mockDriver.reconciledResults.set('att_stalled_29', {
      state: 'failed',
      errorMessage: '原对话已结束，但这条消息尚未回传'
    });

    // Case 3: Orphan `running` message with no attempt row
    app.db.sqlite
      .prepare(
        `INSERT INTO v2_thread_messages (id, thread_id, seq, author_kind, author_id, target_member_id, attempt_id, body, artifact_refs_json, turn_status, created_at, updated_at)
         VALUES ('msg_orphan_29', ?, 4, 'agent', ?, ?, NULL, '', '[]', 'running', ?, ?)`
      )
      .run(thread.id, codex.id, codex.id, oldIso, oldIso);

    const rec = await app.registry.reconcileInFlightAttempts();
    assert.equal(rec.find((r) => r.attempt.id === 'att_lost_29')?.attempt.status, 'failed');
    assert.equal(rec.find((r) => r.attempt.id === 'att_stalled_29')?.attempt.status, 'failed');

    const synced = app.threads.syncReconciledThreadTurns();
    assert.equal(synced.length, 3);

    const mLost = app.threads.getMessage('msg_lost_29')!;
    const mStalled = app.threads.getMessage('msg_stalled_29')!;
    const mOrphan = app.threads.getMessage('msg_orphan_29')!;
    assert.equal(mLost.turnStatus, 'failed');
    assert.match(mLost.body, /应用重启或连接中断/);
    assert.equal(mStalled.turnStatus, 'failed');
    assert.match(mStalled.body, /原对话已结束/);
    assert.equal(mOrphan.turnStatus, 'failed');
    assert.match(mOrphan.body, /应用重启导致本轮执行中断/);
  } finally {
    await cleanup();
  }
});

test('interactive chat renews its inactivity window on real progress, bounds total time and never redispatches a timed-out request key', async (t) => {
  const { app, cleanup } = createTestApp();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  try {
    const thread = app.threads.createThread({title:'长回合', activeOwnerMemberId:'mem_codex'});
    for (const mode of ['active', 'idle', 'ceiling']) {
      let started!: () => void;
      let finish!: (value: { text: string }) => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      const result = new Promise<{ text: string }>(resolve => { finish = resolve; });
      let report!: (event: TurnStreamEvent) => void;
      let calls = 0;
      app.registry.mockDriver.handlers.set('mem_codex', async (_input, onEvent) => {
        calls++;
        report = onEvent!;
        started();
        return result;
      });
      const input = {threadId:thread.id, body:mode, idempotencyKey:'timeout-' + mode};
      const run = app.threads.sendUserMessage(input);
      await ready;
      const expected = mode === 'active' ? run : assert.rejects(run, /ATTEMPT_TIMED_OUT/);
      const advance = (minutes: number) => t.mock.timers.tick(minutes * 60_000);
      if (mode === 'active') {
        for (let n = 0; n < 31; n++) {
          advance(1);
          report({kind:'tool', toolId:'tool-' + n, toolName:'编辑文件', toolStatus:'done'});
        }
        finish({ text:'完成' });
        const settled = await run;
        assert.equal(settled.agentMessage.toolTrace?.length, 31);
        assert.equal(settled.agentMessage.turnStatus,'completed');
      } else {
        if (mode === 'idle') {
          advance(14);
          report({kind:'progress'});
          advance(14);
          assert.equal(app.threads.listMessages(thread.id).at(-1)?.turnStatus,'running');
          advance(1);
        } else {
          for (let i=0; i<12; i++) { advance(10); report({kind:'progress'}); }
        }
        await expected;
        const failed = app.threads.listMessages(thread.id).at(-1)!;
        assert.match(failed.body, mode === 'idle' ? /15 分钟未收到执行进展/ : /2 小时执行上限/);
        assert.equal((await app.threads.sendUserMessage(input)).agentMessage.id, failed.id);
        assert.equal(calls, 1);
        finish({ text: '迟到结果' });
        await new Promise<void>(resolve => setImmediate(resolve));
        const recovered = app.threads.getMessage(failed.id)!;
        assert.equal(recovered.turnStatus, 'completed');
        assert.equal(recovered.body, '迟到结果');
        assert.equal((await app.threads.sendUserMessage(input)).agentMessage.id, recovered.id);
        assert.equal(calls, 1);
      }
    }
  } finally {
    t.mock.timers.reset();
    await cleanup();
  }
});

test('remote timeout looks up the original receipt once and restores the paired message without a second dispatch', async () => {
  const { app, cleanup } = createTestApp();
  let settleNative!: () => void;
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const member = app.db.getMember('mem_gemini')!;
    app.db.upsertMember({ ...member, driverKind: 'remote-bridge' });
    const thread = app.threads.createThread({ title: '回执恢复', activeOwnerMemberId: member.id });
    const mock = app.registry.mockDriver;
    const lookups: string[] = [];
    const dispatches: string[] = [];
    let aborts = 0;
    let releaseReceipt!: () => void;
    const receiptReady = new Promise<void>(resolve => { releaseReceipt = resolve; });
    app.registry.register({
      kind: 'remote-bridge',
      checkHealth: () => mock.checkHealth(),
      ensureSession: input => mock.ensureSession(input),
      runTurn: async (input, onEvent) => {
        dispatches.push(input.attemptId);
        await new Promise<void>(resolve => { settleNative = resolve; });
        return mock.runTurn(input, onEvent);
      },
      reconcileAttempt: async (_member, attempt) => {
        lookups.push(attempt.id);
        await receiptReady;
        return { state: 'completed', text: '已取回原请求回执', nativeSessionId: 'recovered-session' };
      },
      abortTurn: async () => { aborts++; return true; }
    });
    const input = { threadId: thread.id, body: '测试', idempotencyKey: 'recover-original', timeoutMs: 20 };
    await assert.rejects(app.threads.sendUserMessage(input), /ATTEMPT_TIMED_OUT/);
    const failed = app.threads.listMessages(thread.id).at(-1)!;
    assert.deepEqual(lookups, [failed.attemptId]);
    assert.deepEqual(dispatches, lookups);
    assert.equal(failed.turnStatus, 'failed');
    releaseReceipt();
    await new Promise<void>(resolve => setImmediate(resolve));
    const replay = await app.threads.sendUserMessage(input);
    assert.equal(replay.agentMessage.id, failed.id);
    assert.equal(replay.agentMessage.body, '已取回原请求回执');
    assert.equal(replay.agentMessage.turnStatus, 'completed');
    assert.equal(aborts, 0);
    settleNative();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(app.threads.getMessage(failed.id)!.body, '已取回原请求回执');
    assert.equal(dispatches.length, 1);
  } finally {
    clearInterval(keepAlive);
    settleNative?.();
    await cleanup();
  }
});

test('delegation auto-starts, pauses at a checkpoint and returns once to the original requester after reconnect', async () => {
  const { app, cleanup } = createTestApp();
  try {
    const thread = app.threads.createThread({ title: '交付回执', activeOwnerMemberId: 'mem_gemini' });
    let calls = 0;
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const firstStep = new Promise<void>(resolve => { started = resolve; });
    app.registry.mockDriver.handlers.set('mem_codex', async input => {
      if (input.scopeKey.startsWith('task_lead:')) return { text: '{"verdict":"accept","comments":"已核对产出"}' };
      calls++;
      if (calls === 1) { started(); await hold; }
      return { text: '步骤实测交付 ' + calls };
    });
    let returned = 0;
    app.registry.mockDriver.handlers.set('mem_gemini', async input => {
      if (input.prompt.includes('系统交付回执')) {
        returned++;
        assert.match(input.prompt, /步骤实测交付 2/);
        return { text: '已收到并核对两项交付。' };
      }
      const task = { title: '协作验收', kind: 'once', leadMemberId: 'mem_codex', startImmediately: false,
        steps: [{ title: '整理', assigneeMemberId: 'mem_codex' }, { title: '核对', assigneeMemberId: 'mem_codex', dependsOnOrders: [1] }] };
      return { text: '开始委派。<duolawork_task>' + JSON.stringify(task) + '</duolawork_task>' };
    });
    await app.threads.sendUserMessage({ threadId: thread.id, body: '直接委派 Codex 整理并核对' });
    await firstStep;
    const [task] = app.tasks.listTasks({ sourceThreadId: thread.id });
    const [run] = app.tasks.listRuns(task.id);
    assert.equal(task.requesterMemberId, 'mem_gemini');
    assert.equal(app.tasks.requestManualRun(task.id).created, false);
    app.tasks.setPaused(task.id, true);
    assert.equal(app.tasks.getRun(run.id)?.status, 'running');
    app.threads.switchOwner(thread.id, 'mem_grok');
    const requester = app.db.getMember('mem_gemini')!;
    app.db.upsertMember({ ...requester, status: 'offline' });
    release();
    const until = async (check: () => boolean) => {
      for (let n=0; n<350; n++) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('未到达预期状态');
    };
    await until(() => app.tasks.getRun(run.id)?.status === 'paused');
    assert.equal(calls, 1);
    await app.tasks.reconcileInFlightTaskRuns();
    assert.equal(calls, 1);
    app.tasks.setPaused(task.id, false);
    await until(() => app.tasks.getRun(run.id)?.status === 'completed');
    assert.equal(calls, 2);
    assert.equal(returned, 0);
    assert.equal(app.tasks.requestManualRun(task.id).run.id, run.id);
    assert.equal(app.tasks.listRuns(task.id).length, 1);
    app.db.upsertMember(requester);
    app.tasks.dispatchPendingReturns();
    app.tasks.dispatchPendingReturns();
    await until(() => app.tasks.listRuns(task.id)[0].returnTurnStatus === 'completed');
    app.tasks.dispatchPendingReturns();
    assert.equal(returned, 1);
    const messages = app.threads.listMessages(thread.id);
    assert.equal(messages.filter(m => m.authorKind === 'user').length, 1);
    assert.equal(messages.filter(m => m.authorKind === 'task_receipt').length, 1);
    assert.equal(messages.at(-1)?.authorId, 'mem_gemini');
    assert.equal(app.threads.getThread(thread.id)?.activeOwnerMemberId, 'mem_grok');
  } finally { await cleanup(); }
});
