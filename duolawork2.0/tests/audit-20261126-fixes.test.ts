import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { DuolaWorkApp } from '../src/server/app.js';
import { evaluateHubChannelMemberHealth } from '../src/server/drivers/remote-bridge-driver.js';
import { resolveHandoffBudgetBytes } from '../src/server/handoff.js';
import { parseLeadReviewJson } from '../src/server/tasks-fsm.js';
import { isLocalCodingMember, resolveEffectiveDriverKind } from '../src/shared/types.js';

function createIsolatedApp(opts?: {
  tmpDir?: string;
  staticWebDir?: string;
  auth?: { required?: boolean; adminPasswordPlain?: string };
}) {
  const tmpDir = opts?.tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-audit-fix-'));
  const dbPath = path.join(tmpDir, 'audit.sqlite');
  const app = new DuolaWorkApp({
    dbPath,
    filesDir: path.join(tmpDir, 'files'),
    worktreesRoot: path.join(tmpDir, 'worktrees'),
    staticWebDir: opts?.staticWebDir,
    autoImportAgentHub: false,
    auth: opts?.auth
  });

  for (const [id, name] of [
    ['mem_a', '负责人A'],
    ['mem_b', '执行人B'],
    ['mem_c', '新负责人C']
  ] as const) {
    app.db.upsertMember({
      id,
      name,
      platformId: 'custom',
      driverKind: 'mock',
      location: 'local',
      capabilities: {
        supportsIsolatedSessions: true,
        supportsSessionResume: true,
        supportsCancel: true,
        maxConcurrentRuns: 2
      },
      status: 'ready',
      statusMessage: '测试就绪',
      config: {}
    });
  }

  return {
    app,
    tmpDir,
    dbPath,
    cleanup: async () => {
      await app.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

test('Audit-H1: Rejection phrases and ambiguous lead text never become accept, and empty solo deliverables never mark completed', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    // 1. Unit check on parseLeadReviewJson
    const r1 = parseLeadReviewJson('未通过。数据缺失，不能交付。');
    assert.equal(r1.verdict, 'changes_requested');

    const r2 = parseLeadReviewJson('先放到这里，语义不明无JSON');
    assert.equal(r2.verdict, 'ask_user');

    const r3 = parseLeadReviewJson('```json\n{"verdict":"accept","comments":"数据完整，核验通过"}\n```');
    assert.equal(r3.verdict, 'accept');

    const thread = app.threads.createThread({
      title: '验收严密性测试',
      activeOwnerMemberId: 'mem_a'
    });

    // 2. Worker submits draft, Lead replies plain text "未通过。数据缺失，不能交付。" -> must NOT complete!
    let workerRound = 0;
    app.registry.mockDriver.handlers.set('mem_b', async () => {
      workerRound += 1;
      return { text: `第 ${workerRound} 版草稿：缺少核心数据` };
    });
    app.registry.mockDriver.handlers.set('mem_a', async () => ({
      text: '未通过。数据缺失，不能交付。'
    }));

    const { task: rejectTask, initialRun: rejectRun } = app.tasks.createOrUpdateTask({
      sourceThreadId: thread.id,
      title: '拒绝文本拦截验证',
      leadMemberId: 'mem_a',
      spec: {
        goal: '验证负责人自然语言拒绝不会被当成通过',
        maxReviewRounds: 2,
        steps: [
          {
            stepOrder: 1,
            title: '采集数据',
            assigneeMemberId: 'mem_b',
            brief: '提交数据',
            acceptanceCriteria: '数据齐全'
          }
        ]
      }
    });

    const settledRejectRun = await app.tasks.driveRun(rejectRun!.id);
    assert.equal(settledRejectRun.status, 'waiting_user', 'Repeated rejection must pause in waiting_user, NEVER completed');
    const stepReviews = app.tasks.listReviews(app.tasks.listSteps(settledRejectRun.id)[0].id);
    assert.ok(stepReviews.every((r) => r.verdict === 'changes_requested'));
    const deliveredCards1 = app.threads
      .listMessages(thread.id)
      .filter((m) => m.taskCard?.taskId === rejectTask.id && m.taskCard?.kind === 'delivered');
    assert.equal(deliveredCards1.length, 0, 'Zero delivered cards allowed on rejected run');

    // 3. Single-person (solo) task submitting empty string "" -> must NOT complete!
    app.registry.mockDriver.handlers.set('mem_a', async () => ({
      text: '   \n  '
    }));
    const { task: emptySoloTask, initialRun: emptySoloRun } = app.tasks.createOrUpdateTask({
      sourceThreadId: thread.id,
      title: '单人空提交拦截验证',
      leadMemberId: 'mem_a',
      spec: {
        goal: '验证空字符串不会生成完成卡',
        maxReviewRounds: 2,
        steps: []
      }
    });
    const settledEmptySolo = await app.tasks.driveRun(emptySoloRun!.id);
    assert.equal(settledEmptySolo.status, 'waiting_user', 'Empty solo deliverable must NOT become completed');
    const deliveredCards2 = app.threads
      .listMessages(thread.id)
      .filter((m) => m.taskCard?.taskId === emptySoloTask.id && m.taskCard?.kind === 'delivered');
    assert.equal(deliveredCards2.length, 0, 'Empty solo deliverable must emit 0 delivered cards');
  } finally {
    await cleanup();
  }
});

test('Audit-H2: Duplicate sendUserMessage requests (sequential retry & concurrent) produce strictly 1 user bubble, 1 schedule, and 1 task card', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const thread = app.threads.createThread({
      title: '幂等去重测试',
      activeOwnerMemberId: 'mem_a'
    });

    let driverExecutions = 0;
    app.registry.mockDriver.handlers.set('mem_a', async () => {
      driverExecutions += 1;
      await new Promise((r) => setTimeout(r, 25));
      return {
        text:
          '已为你配置每日晚报计划。\n' +
          '<duolawork_task>{"title":"每日晚报去重核验","kind":"scheduled","cronExpr":"0 20 * * *","timezone":"Asia/Shanghai","leadMemberId":"mem_a","goal":"生成晚报","startImmediately":false}</duolawork_task>'
      };
    });

    const reqKey = 'msgreq:test-dup-schedule-001';
    // Concurrent duplicate submission + sequential retry after completion
    const [first, concurrentDup] = await Promise.all([
      app.threads.sendUserMessage({
        threadId: thread.id,
        body: '帮我创建一个每天 20:00 的每日晚报计划',
        idempotencyKey: reqKey
      }),
      app.threads.sendUserMessage({
        threadId: thread.id,
        body: '帮我创建一个每天 20:00 的每日晚报计划',
        idempotencyKey: reqKey
      })
    ]);

    const sequentialRetry = await app.threads.sendUserMessage({
      threadId: thread.id,
      body: '帮我创建一个每天 20:00 的每日晚报计划',
      idempotencyKey: reqKey
    });

    assert.equal(driverExecutions, 1, 'Underlying driver must execute strictly once');
    assert.equal(first.userMessage.id, concurrentDup.userMessage.id);
    assert.equal(first.userMessage.id, sequentialRetry.userMessage.id);
    assert.equal(first.agentMessage.id, sequentialRetry.agentMessage.id);

    const allMsgs = app.threads.listMessages(thread.id);
    const userBubbles = allMsgs.filter((m) => m.authorKind === 'user');
    const taskCards = allMsgs.filter((m) => m.authorKind === 'system_task_card');
    const allTasks = app.tasks.listTasks({ sourceThreadId: thread.id });

    assert.equal(userBubbles.length, 1, 'Strictly 1 user bubble');
    assert.equal(allTasks.length, 1, 'Strictly 1 scheduled task created');
    assert.equal(taskCards.length, 1, 'Strictly 1 task card created');
  } finally {
    await cleanup();
  }
});

test('Audit-H3: Process restart reconciles running task steps (both failed-on-crash and completed-during-restart without redo)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-audit-restart-'));
  let app1: DuolaWorkApp | null = null;
  let app2: DuolaWorkApp | null = null;

  try {
    // --- Part 1: Crash mid-step where worker did NOT finish -> step & run advance to `failed` ---
    const firstBoot = createIsolatedApp({ tmpDir });
    const dbPath = firstBoot.dbPath;
    app1 = firstBoot.app;
    const thread = app1.threads.createThread({
      title: '任务重启恢复对话',
      activeOwnerMemberId: 'mem_a'
    });

    let stepStartedResolve!: () => void;
    const stepStarted = new Promise<void>((r) => {
      stepStartedResolve = r;
    });
    app1.registry.mockDriver.handlers.set('mem_b', async () => {
      stepStartedResolve();
      await new Promise(() => {}); // simulate abrupt process termination mid-step
      return { text: 'unreachable' };
    });

    const { initialRun: crashedRun } = app1.tasks.createOrUpdateTask({
      sourceThreadId: thread.id,
      title: '重启中断任务',
      leadMemberId: 'mem_a',
      spec: {
        goal: '测试进程重启后不卡 running',
        steps: [
          {
            stepOrder: 1,
            title: '长耗时步骤',
            assigneeMemberId: 'mem_b',
            brief: '执行中重启',
            acceptanceCriteria: '完成'
          }
        ]
      }
    });

    void app1.tasks.driveRun(crashedRun!.id).catch(() => {});
    await stepStarted;

    // Simulate hard process exit where SQLite still has attempt='running', step='running', run='running'
    const crashedStepId = app1.tasks.listSteps(crashedRun!.id)[0].id;
    const crashedAtt = app1.registry.listAttempts({ runId: crashedRun!.id })[0];
    assert.equal(app1.tasks.getRun(crashedRun!.id)?.status, 'running');
    await app1.close();
    app1 = null;

    // Force DB row to reflect ungraceful SIGKILL state (`attempt = 'running'`, `step = 'running'`, `run = 'running'`)
    const boot2 = new DuolaWorkApp({
      dbPath,
      filesDir: path.join(tmpDir, 'files'),
      worktreesRoot: path.join(tmpDir, 'worktrees'),
      autoImportAgentHub: false
    });
    app2 = boot2;
    app2.db.sqlite
      .prepare(`UPDATE v2_dispatch_attempts SET status = 'running', settled_at = NULL, error_message = NULL WHERE id = ?`)
      .run(crashedAtt.id);
    app2.db.sqlite
      .prepare(`UPDATE v2_task_steps SET status = 'running' WHERE id = ?`)
      .run(crashedStepId);
    app2.db.sqlite
      .prepare(`UPDATE v2_task_runs SET status = 'running' WHERE id = ?`)
      .run(crashedRun!.id);

    const { url } = await app2.listen(0, '127.0.0.1');
    // Trigger reconcile (same path as 8s background reconcile)
    const recRes = await fetch(`${url}/api/v2/reconcile`, { method: 'POST' });
    assert.equal(recRes.status, 200);

    assert.equal(app2.registry.getAttempt(crashedAtt.id)?.status, 'failed');
    assert.equal(app2.tasks.getStep(crashedStepId)?.status, 'failed');
    assert.equal(app2.tasks.getRun(crashedRun!.id)?.status, 'failed', 'Run must advance out of running to failed');

    // --- Part 2: Worker finished on remote node while server restarted -> recovers without re-running worker! ---
    let workerCallsOnBoot2 = 0;
    app2.registry.mockDriver.handlers.set('mem_b', async () => {
      workerCallsOnBoot2 += 1;
      return { text: '不该被重新调用' };
    });
    app2.registry.mockDriver.handlers.set('mem_a', async () => ({
      text: '{"verdict":"accept","comments":"重启后对账恢复验收通过"}'
    }));

    const { initialRun: recoverRun } = app2.tasks.createOrUpdateTask({
      sourceThreadId: thread.id,
      title: '重启对账无重做恢复任务',
      leadMemberId: 'mem_a',
      startImmediately: false,
      spec: {
        goal: '验证远端已完成回执在对账后直接推进验收而无需重跑执行人',
        steps: [
          {
            stepOrder: 1,
            title: '远端节点步骤',
            assigneeMemberId: 'mem_b',
            brief: '执行任务',
            acceptanceCriteria: '完整输出'
          }
        ]
      }
    });
    void recoverRun;
    const { run: r2 } = app2.tasks.instantiateRun({
      taskId: app2.tasks.listTasks({ sourceThreadId: thread.id }).find((t) => t.title === '重启对账无重做恢复任务')!.id,
      plannedSlotAt: 'manual:recover-1',
      triggerType: 'manual'
    });
    const step2 = app2.tasks.listSteps(r2.id)[0];
    const syntheticAttId = 'att_recover_node_done';
    app2.db.sqlite
      .prepare(
        `INSERT INTO v2_dispatch_attempts (
          id, target_kind, target_id, thread_id, task_id, run_id, step_id,
          member_id, idempotency_key, scope_key, native_session_id, native_turn_id,
          bridge_meta_json, status, slot_held, base_artifact_id, base_artifact_version,
          prompt_digest, prompt_bytes, handoff_bytes, response_text, usage_json,
          error_message, dispatched_at, settled_at
        ) VALUES (?, 'task_step', ?, ?, ?, ?, ?, 'mem_b', 'step_exec_rec_1', ?, 'sess_rec', 'turn_rec', NULL, 'reconciling', 0, NULL, NULL, 'dig', 100, 0, NULL, '{"workbenchDispatches":1,"nativeTurns":0,"providerUsage":{"observable":false,"modelRequests":null,"inputTokens":null,"cachedInputTokens":null,"uncachedInputTokens":null,"outputTokens":null,"totalTokens":null}}', NULL, ?, NULL)`
      )
      .run(syntheticAttId, step2.id, thread.id, r2.taskId, r2.id, step2.id, step2.isolatedSessionKey, new Date().toISOString());
    app2.db.sqlite.prepare(`UPDATE v2_task_steps SET status = 'running' WHERE id = ?`).run(step2.id);
    app2.registry.mockDriver.reconciledResults.set(syntheticAttId, {
      state: 'completed',
      text: '远端节点在控制面重启期间产出的完整正式报告内容',
      nativeSessionId: 'sess_rec',
      nativeTurnId: 'turn_rec'
    });

    await fetch(`${url}/api/v2/reconcile`, { method: 'POST' });

    assert.equal(workerCallsOnBoot2, 0, 'Worker must NOT be re-executed when reconcile recovers completed output');
    assert.equal(app2.tasks.getRun(r2.id)?.status, 'completed', 'Recovered step must advance through lead review to completed');
  } finally {
    if (app1) await app1.close();
    if (app2) await app2.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Audit-H4: Updating task template/lead only affects new runs; existing runs keep snapshot lead & per-run isolated lead review session', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const thread = app.threads.createThread({
      title: '跨期快照隔离测试',
      activeOwnerMemberId: 'mem_a'
    });

    app.registry.mockDriver.handlers.set('mem_b', async (inp) => ({
      text: `执行成果 (${inp.scopeKey})`
    }));

    const leadASessions: string[] = [];
    let leadCReviews = 0;

    app.registry.mockDriver.handlers.set('mem_a', async (inp) => {
      if (inp.scopeKey.startsWith('task_lead:')) {
        leadASessions.push(inp.nativeSessionId);
        return { text: '{"verdict":"accept","comments":"原负责人A按v1快照验收通过"}' };
      }
      return { text: 'ok' };
    });
    app.registry.mockDriver.handlers.set('mem_c', async (inp) => {
      if (inp.scopeKey.startsWith('task_lead:')) {
        leadCReviews += 1;
        return { text: '{"verdict":"accept","comments":"新负责人C按v2模板验收通过"}' };
      }
      return { text: 'ok' };
    });

    // 1. Create v1 scheduled task with Lead = mem_a
    const { task: v1Task } = app.tasks.createOrUpdateTask({
      sourceThreadId: thread.id,
      title: '双期模板变更核验',
      kind: 'scheduled',
      cronExpr: '0 8 * * *',
      leadMemberId: 'mem_a',
      startImmediately: false,
      spec: {
        goal: 'v1 目标',
        steps: [
          {
            stepOrder: 1,
            title: 'v1 步骤',
            assigneeMemberId: 'mem_b',
            brief: 'v1 内容',
            acceptanceCriteria: 'v1 验收规则'
          }
        ]
      }
    });

    // Instantiate Period 1 BEFORE template edit
    const { run: runPeriod1 } = app.tasks.instantiateRun({
      taskId: v1Task.id,
      plannedSlotAt: 'slot:2026-11-26T08:00',
      triggerType: 'cron'
    });

    // 2. Update template to v2 with Lead = mem_c BEFORE driving Period 1!
    const { task: v2Task } = app.tasks.createOrUpdateTask({
      taskId: v1Task.id,
      sourceThreadId: thread.id,
      title: '双期模板变更核验',
      kind: 'scheduled',
      cronExpr: '0 8 * * *',
      leadMemberId: 'mem_c',
      spec: {
        goal: 'v2 新目标',
        steps: [
          {
            stepOrder: 1,
            title: 'v2 新步骤',
            assigneeMemberId: 'mem_b',
            brief: 'v2 内容',
            acceptanceCriteria: 'v2 验收规则'
          }
        ]
      }
    });
    assert.equal(v2Task.templateVersion, 2);
    assert.equal(v2Task.leadMemberId, 'mem_c');

    // 3. Drive Period 1 -> MUST be reviewed by mem_a (NOT mem_c!)
    const doneP1 = await app.tasks.driveRun(runPeriod1.id);
    assert.equal(doneP1.status, 'completed');
    assert.equal(doneP1.templateVersion, 1);
    const p1Reviews = app.tasks.listReviews(app.tasks.listSteps(doneP1.id)[0].id);
    assert.equal(p1Reviews[0].leadMemberId, 'mem_a', 'Period 1 must use its snapshot lead mem_a');
    assert.equal(leadCReviews, 0, 'New lead mem_c must not review Period 1');

    // 4. Instantiate & drive Period 2 -> uses mem_c!
    const { run: runPeriod2 } = app.tasks.instantiateRun({
      taskId: v1Task.id,
      plannedSlotAt: 'slot:2026-11-27T08:00',
      triggerType: 'cron'
    });
    const doneP2 = await app.tasks.driveRun(runPeriod2.id);
    assert.equal(doneP2.status, 'completed');
    assert.equal(doneP2.templateVersion, 2);
    const p2Reviews = app.tasks.listReviews(app.tasks.listSteps(doneP2.id)[0].id);
    assert.equal(p2Reviews[0].leadMemberId, 'mem_c', 'Period 2 uses updated lead mem_c');
    assert.equal(leadCReviews, 1);

    // 5. Switch back to mem_a for Period 3 and verify mem_a gets a brand new native session distinct from Period 1!
    app.tasks.createOrUpdateTask({
      taskId: v1Task.id,
      sourceThreadId: thread.id,
      title: '双期模板变更核验',
      kind: 'scheduled',
      cronExpr: '0 8 * * *',
      leadMemberId: 'mem_a',
      spec: {
        goal: 'v3 目标',
        steps: [
          {
            stepOrder: 1,
            title: 'v3 不同步骤',
            assigneeMemberId: 'mem_b',
            brief: 'v3 内容',
            acceptanceCriteria: 'v3 规则'
          }
        ]
      }
    });
    const { run: runPeriod3 } = app.tasks.instantiateRun({
      taskId: v1Task.id,
      plannedSlotAt: 'slot:2026-11-28T08:00',
      triggerType: 'cron'
    });
    await app.tasks.driveRun(runPeriod3.id);
    assert.equal(leadASessions.length, 2);
    assert.notEqual(leadASessions[0], leadASessions[1], 'Different periods must NOT share lead native review session');
  } finally {
    await cleanup();
  }
});

test('Audit-M4 & M5: Reject cyclic/self/missing step dependencies at creation, and preserve 48KB budget & history tool for remote-node Coding Agents', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const thread = app.threads.createThread({
      title: 'DAG与预算测试',
      activeOwnerMemberId: 'mem_a'
    });

    // M4-a: 2-step cycle (1 <-> 2)
    assert.throws(
      () =>
        app.tasks.createOrUpdateTask({
          sourceThreadId: thread.id,
          title: '循环依赖任务',
          leadMemberId: 'mem_a',
          spec: {
            steps: [
              { stepOrder: 1, title: '步骤甲', assigneeMemberId: 'mem_b', dependsOnOrders: [2] },
              { stepOrder: 2, title: '步骤乙', assigneeMemberId: 'mem_b', dependsOnOrders: [1] }
            ]
          }
        }),
      /循环依赖.*#1「步骤甲」.*#2「步骤乙」/
    );

    // M4-b: Self-dependency (1 -> 1)
    assert.throws(
      () =>
        app.tasks.createOrUpdateTask({
          sourceThreadId: thread.id,
          title: '自依赖任务',
          leadMemberId: 'mem_a',
          spec: {
            steps: [{ stepOrder: 1, title: '自依赖步', assigneeMemberId: 'mem_b', dependsOnOrders: [1] }]
          }
        }),
      /自依赖/
    );

    // M4-c: Non-existent dependency (2 -> 99)
    assert.throws(
      () =>
        app.tasks.createOrUpdateTask({
          sourceThreadId: thread.id,
          title: '幽灵前置任务',
          leadMemberId: 'mem_a',
          spec: {
            steps: [
              { stepOrder: 1, title: '第一步', assigneeMemberId: 'mem_b', dependsOnOrders: [] },
              { stepOrder: 2, title: '第二步', assigneeMemberId: 'mem_b', dependsOnOrders: [99] }
            ]
          }
        }),
      /不存在的前置步骤编号 #99/
    );

    // M5: Remote-node Coding Agents keep 48,000 byte budget & effective driver capabilities
    const remoteCodex = app.db.upsertMember({
      id: 'mem_remote_codex',
      name: 'CodexNode',
      platformId: 'codex',
      driverKind: 'remote-node',
      location: 'local-node',
      nodeId: 'node_local_test',
      capabilities: {
        supportsIsolatedSessions: true,
        supportsSessionResume: true,
        supportsCancel: true,
        maxConcurrentRuns: 2
      },
      status: 'ready',
      statusMessage: 'ok',
      config: { localDriverKind: 'codex-app-server' }
    });
    const remoteGemini = app.db.upsertMember({
      id: 'mem_remote_gemini',
      name: 'Gemini2VPS',
      platformId: 'antigravity',
      driverKind: 'remote-node',
      location: 'cloud-node',
      nodeId: 'node_cloud_test',
      capabilities: {
        supportsIsolatedSessions: true,
        supportsSessionResume: true,
        supportsCancel: true,
        maxConcurrentRuns: 2
      },
      status: 'ready',
      statusMessage: 'ok',
      config: { localDriverKind: 'acp-stdio' }
    });

    assert.equal(resolveEffectiveDriverKind(remoteCodex), 'codex-app-server');
    assert.equal(resolveEffectiveDriverKind(remoteGemini), 'acp-stdio');
    assert.equal(resolveHandoffBudgetBytes(remoteCodex), 48_000);
    assert.equal(resolveHandoffBudgetBytes(remoteGemini), 48_000);
    assert.equal(isLocalCodingMember(remoteCodex), true);
    assert.equal(isLocalCodingMember(remoteGemini), false);

    // Verify previewPendingHandoff on remote-node Codex uses 48,000 budget and thread_read_history folding!
    for (let i = 1; i <= 18; i++) {
      app.threads.appendSystemMessage({
        threadId: thread.id,
        authorKind: 'agent',
        authorId: 'mem_a',
        body: `历史长消息段 #${i}：` + '业务上下文内容细节_'.repeat(340)
      });
    }
    const preview = app.threads.previewPendingHandoff(thread.id, 'mem_remote_codex');
    assert.equal(preview.meta.budgetBytes, 48_000);
    assert.match(preview.meta.previewText || '', /thread_read_history/, 'Remote-node Codex must retain thread_read_history folding capability');
  } finally {
    await cleanup();
  }
});

test('Audit-S1 & S2: Magic/pairing codes enforce brute-force lockout + audit log, and revoking a session immediately terminates its open SSE stream', async () => {
  const { app, cleanup } = createIsolatedApp({
    auth: { required: true, adminPasswordPlain: 'StrongPass#2026' }
  });
  try {
    const { port, url } = await app.listen(0, '127.0.0.1');

    // Login first to obtain admin session cookie
    const loginRes = await fetch(`${url}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'StrongPass#2026', deviceName: 'Mac主控端' })
    });
    assert.equal(loginRes.status, 200);
    const adminCookie = loginRes.headers.get('set-cookie')!.split(';')[0];

    // S1: Issue a 6-digit login code and brute-force 5 wrong attempts from IP 10.0.0.9 -> 6th attempt (even with right code!) gets 429!
    const codeRes = await fetch(`${url}/api/v2/auth/magic-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie, Origin: url },
      body: JSON.stringify({ deviceName: 'iPhone测试' })
    });
    const { code: validLoginCode } = (await codeRes.json()) as { code: string };

    for (let i = 0; i < 5; i++) {
      const bad = await fetch(`${url}/api/v2/auth/magic-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.9' },
        body: JSON.stringify({ code: '000000' })
      });
      assert.equal(bad.status, 401);
    }

    const lockedRes = await fetch(`${url}/api/v2/auth/magic-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.9' },
      body: JSON.stringify({ code: validLoginCode })
    });
    assert.equal(lockedRes.status, 429, '6th attempt from same IP must be blocked with 429');

    // Node pairing code brute-force from another IP also locks out after 5 failures
    const pairCodeRes = await fetch(`${url}/api/v2/nodes/pair-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie, Origin: url },
      body: JSON.stringify({ name: 'TestNode', kind: 'local' })
    });
    const { code: validPairCode } = (await pairCodeRes.json()) as { code: string };
    for (let i = 0; i < 5; i++) {
      const badPair = await fetch(`${url}/api/v2/nodes/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.88' },
        body: JSON.stringify({ code: '000000' })
      });
      assert.equal(badPair.status, 401);
    }
    const lockedPair = await fetch(`${url}/api/v2/nodes/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.88' },
      body: JSON.stringify({ code: validPairCode })
    });
    assert.equal(lockedPair.status, 429, 'Node pair code must also rate-limit brute-force');

    const auditCount = (
      app.db.sqlite.prepare(`SELECT COUNT(*) AS cnt FROM v2_auth_audit_logs`).get() as { cnt: number }
    ).cnt;
    assert.ok(auditCount >= 12, 'Auth audit log must record redemption failures and lockouts');

    // S2: Login on a second device, open SSE stream, then revoke that second session -> SSE stream must close immediately!
    const freshCodeRes = await fetch(`${url}/api/v2/auth/magic-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie, Origin: url },
      body: JSON.stringify({ deviceName: '待吊销手机' })
    });
    const { code: freshCode } = (await freshCodeRes.json()) as { code: string };
    const mobileLogin = await fetch(`${url}/api/v2/auth/magic-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.22' },
      body: JSON.stringify({ code: freshCode })
    });
    assert.equal(mobileLogin.status, 200);
    const mobileCookie = mobileLogin.headers.get('set-cookie')!.split(';')[0];
    const mobileBody = (await mobileLogin.json()) as { session: { id: string } };

    let sseFrames = '';
    let sseClosedResolver!: () => void;
    const sseClosedPromise = new Promise<void>((resolve) => {
      sseClosedResolver = resolve;
    });
    let sseConnectedResolver!: () => void;
    const sseConnectedPromise = new Promise<void>((resolve) => {
      sseConnectedResolver = resolve;
    });

    const sseReq = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/v2/events',
        method: 'GET',
        headers: { Cookie: mobileCookie }
      },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          sseFrames += chunk;
          if (sseFrames.includes('"connected"')) {
            sseConnectedResolver();
          }
        });
        res.on('end', () => sseClosedResolver());
        res.on('close', () => sseClosedResolver());
      }
    );
    sseReq.end();
    await sseConnectedPromise;

    const delSesRes = await fetch(
      `${url}/api/v2/auth/sessions/${encodeURIComponent(mobileBody.session.id)}`,
      {
        method: 'DELETE',
        headers: { Cookie: adminCookie, Origin: url }
      }
    );
    assert.equal(delSesRes.status, 200);

    await Promise.race([
      sseClosedPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Revoked session SSE stream did not close within 1s')), 1000)
      )
    ]);
    assert.match(sseFrames, /auth\.revoked/);
  } finally {
    await cleanup();
  }
});

test('Audit-M1, M2, M3 & Browser Retry (Playwright 390x844): Mobile unobstructed send, offline draft+ref preservation, idempotent retry, and SSE catch-up across server restart', async () => {
  const staticWebDir = path.resolve(process.cwd(), 'dist/web');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-audit-mobile-'));
  const dbPath = path.join(tmpDir, 'mobile.sqlite');

  let app: DuolaWorkApp | null = new DuolaWorkApp({
    dbPath,
    filesDir: path.join(tmpDir, 'files'),
    worktreesRoot: path.join(tmpDir, 'worktrees'),
    staticWebDir,
    autoImportAgentHub: false
  });

  app.db.upsertMember({
    id: 'mem_mobile_lead',
    name: 'Gemini移动助手',
    platformId: 'antigravity',
    driverKind: 'mock',
    location: 'cloud-node',
    capabilities: {
      supportsIsolatedSessions: true,
      supportsSessionResume: true,
      supportsCancel: true,
      maxConcurrentRuns: 2
    },
    status: 'ready',
    statusMessage: '在线',
    config: {}
  });

  let modelDispatchCount = 0;
  app.registry.mockDriver.handlers.set('mem_mobile_lead', async (inp) => {
    modelDispatchCount += 1;
    if (inp.prompt.includes('创建移动日报')) {
      return {
        text:
          '好的，移动日报计划已建好。\n' +
          '<duolawork_task>{"title":"移动端幂等日报","kind":"scheduled","cronExpr":"0 9 * * *","timezone":"Asia/Shanghai","leadMemberId":"mem_mobile_lead","goal":"产出日报","startImmediately":false}</duolawork_task>'
      };
    }
    return { text: `收到移动端消息 #${modelDispatchCount}` };
  });

  const thread = app.threads.createThread({
    title: '手机视口验收对话',
    activeOwnerMemberId: 'mem_mobile_lead'
  });
  const doc = app.space.createDocument({
    threadId: thread.id,
    title: '移动参考规范.md',
    content: '# 移动规范\n关键字段说明'
  });

  const listened = await app.listen(0, '127.0.0.1');
  const port = listened.port;
  const baseUrl = listened.url;

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // --- M2: On 390x844 initial open, Collaboration Space must NOT cover chat or .dw-send-btn ---
    await page.waitForSelector('.chat-composer textarea', { state: 'visible' });
    const spaceCountOnInit = await page.locator('aside.collaboration-space').count();
    assert.equal(spaceCountOnInit, 0, 'Space pane must be closed by default on 390x844 mobile');

    await page.fill('.chat-composer textarea', '手机首屏无遮挡点击发送测试');
    await page.click('.dw-send-btn'); // Real pointer hit-test (fails if covered by fixed overlay!)
    await page.waitForFunction(
      () => document.body.innerText.includes('收到移动端消息 #1'),
      undefined,
      { timeout: 5000 }
    );

    // Open Space explicitly -> select document & quote reference chip -> auto-closes Space on mobile!
    await page.click('button[aria-label="打开协作资料"]');
    await page.waitForSelector('aside.collaboration-space', { state: 'visible' });
    await page.locator('aside.collaboration-space').getByText(doc.title).first().click();
    await page.locator('aside.collaboration-space').getByRole('button', { name: '引用到对话' }).click();
    await page.locator('aside.collaboration-space').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('aside.collaboration-space').count(), 0);

    // --- M3 + H2: Simulate offline drop BEFORE server, verify draft & ref kept, then simulate "server completes, response drops" & retry with same idempotencyKey! ---
    const draftText = '请帮我创建移动日报计划';
    await page.fill('.chat-composer textarea', draftText);
    const hadRefBefore = await page.locator('.composer-references .space-reference').count();
    assert.equal(hadRefBefore, 1, 'Document reference chip quoted into composer');

    const capturedKeys: string[] = [];
    let routePhase: 'abort_before_server' | 'drop_after_server_complete' | 'normal' = 'abort_before_server';

    await page.route('**/api/v2/threads/*/messages', async (route) => {
      const postBody = JSON.parse(route.request().postData() || '{}') as {
        body?: string;
        idempotencyKey?: string;
      };
      if (postBody.idempotencyKey) {
        capturedKeys.push(postBody.idempotencyKey);
      }
      if (routePhase === 'abort_before_server') {
        await route.abort('internetdisconnected');
        return;
      }
      if (routePhase === 'drop_after_server_complete') {
        // Forward to real server so server completes & creates the schedule, then drop response to browser!
        await route.fetch();
        await route.abort('connectionreset');
        return;
      }
      await route.continue();
    });

    // Attempt 1: Offline before reaching server
    await page.click('.dw-send-btn');
    await page.waitForFunction(
      () => document.body.innerText.includes('网络异常'),
      undefined,
      { timeout: 5000 }
    );
    assert.equal(
      await page.inputValue('.chat-composer textarea'),
      draftText,
      'Unsent draft must remain in textarea on offline failure'
    );
    assert.equal(
      await page.locator('.composer-references .space-reference').count(),
      hadRefBefore,
      'Reference chips must remain intact on offline failure'
    );
    assert.equal(modelDispatchCount, 1, 'Offline request never hit model');

    // Attempt 2: Server completes & creates scheduled task, but HTTP response drops before reaching client
    routePhase = 'drop_after_server_complete';
    await page.click('.dw-send-btn');
    await page.waitForFunction(() => !document.querySelector('.dw-send-btn')?.hasAttribute('disabled') || true);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(modelDispatchCount, 2, 'Server executed the turn once');

    // Attempt 3: Network recovers, user clicks Send again -> must reuse identical idempotencyKey and NOT create duplicate bubble/task!
    routePhase = 'normal';
    await page.click('.dw-send-btn');
    await page.waitForFunction(
      () => (document.querySelector('.chat-composer textarea') as HTMLTextAreaElement)?.value === '',
      undefined,
      { timeout: 5000 }
    );

    assert.equal(capturedKeys.length, 3);
    assert.equal(capturedKeys[0], capturedKeys[1], 'Retry #1 must reuse identical client idempotencyKey');
    assert.equal(capturedKeys[1], capturedKeys[2], 'Retry #2 must reuse identical client idempotencyKey');
    assert.equal(modelDispatchCount, 2, 'Retry after server completion must NOT re-invoke model');
    const tasksAfterRetry = app.tasks.listTasks({ sourceThreadId: thread.id });
    assert.equal(tasksAfterRetry.length, 1, 'Strictly 1 scheduled task after retry');

    // --- M1: Restart server on same port (even if eventSeq resets to 0 < client Last-Event-ID), write a new message BEFORE mobile SSE reconnects, verify mobile auto-catches up without reload! ---
    app.db.setSetting('sse_event_seq', 0);
    await app.close();
    app = null;

    const appRestarted = new DuolaWorkApp({
      dbPath,
      filesDir: path.join(tmpDir, 'files'),
      worktreesRoot: path.join(tmpDir, 'worktrees'),
      staticWebDir,
      autoImportAgentHub: false
    });
    app = appRestarted;
    // Write a new message BEFORE listening so it happens while mobile client is disconnected!
    app.threads.appendSystemMessage({
      threadId: thread.id,
      authorKind: 'agent',
      authorId: 'mem_mobile_lead',
      body: '【重启期间写入的新消息】无需手动刷新即可自动追平'
    });
    await app.listen(port, '127.0.0.1');

    await page.waitForFunction(
      () => document.body.innerText.includes('【重启期间写入的新消息】无需手动刷新即可自动追平'),
      undefined,
      { timeout: 10_000 }
    );
  } finally {
    await browser.close();
    if (app) await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Audit-R2-1: Contradictory structured verdict (accept + rework comments) is downgraded to changes_requested in both JSON parser and review tool', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    // 1. Direct parseLeadReviewJson checks
    const c1 = parseLeadReviewJson(JSON.stringify({ verdict: 'accept', comments: '数据缺失，请补充后重新提交' }));
    assert.equal(c1.verdict, 'changes_requested');

    const c2 = parseLeadReviewJson(JSON.stringify({ verdict: 'accept', comments: '不能交付，缺少对比章节，需修改' }));
    assert.equal(c2.verdict, 'changes_requested');

    const ok1 = parseLeadReviewJson(JSON.stringify({ verdict: 'accept', comments: '无数据缺失，无需补充，核验通过' }));
    assert.equal(ok1.verdict, 'accept');

    // 2. End-to-end task run where Lead calls `task_review_step` tool with contradictory {verdict:'accept', comments:'数据缺失，请补充后重新提交'} on round 1
    const thread = app.threads.createThread({
      title: '矛盾裁决拦截对话',
      activeOwnerMemberId: 'mem_a'
    });

    let workerCalls = 0;
    app.registry.mockDriver.handlers.set('mem_b', async () => {
      workerCalls += 1;
      return { text: workerCalls === 1 ? '初版缺项草稿' : '已补齐全部核心数据的终稿' };
    });

    let leadCalls = 0;
    app.registry.mockDriver.handlers.set('mem_a', async (inp) => {
      leadCalls += 1;
      if (leadCalls === 1) {
        await inp.onToolCall?.('task_review_step', {
          verdict: 'accept',
          comments: '数据缺失，请补充后重新提交'
        });
        return { text: '{"verdict":"accept","comments":"数据缺失，请补充后重新提交"}' };
      }
      return { text: '{"verdict":"accept","comments":"无数据缺失，无需修改，正式通过"}' };
    });

    const { initialRun } = app.tasks.createOrUpdateTask({
      sourceThreadId: thread.id,
      title: '自相矛盾验收防护任务',
      leadMemberId: 'mem_a',
      spec: {
        goal: '验证第1轮矛盾通过会被转为返工，第2轮真正达标后才完成',
        maxReviewRounds: 3,
        steps: [
          {
            stepOrder: 1,
            title: '撰写报告',
            assigneeMemberId: 'mem_b',
            brief: '提交完整报告',
            acceptanceCriteria: '数据无缺失'
          }
        ]
      }
    });

    const finished = await app.tasks.driveRun(initialRun!.id);
    assert.equal(workerCalls, 2, 'Round 1 contradictory accept must trigger Round 2 worker rework');
    assert.equal(leadCalls, 2);
    assert.equal(finished.status, 'completed');
    const reviews = app.tasks.listReviews(app.tasks.listSteps(finished.id)[0].id);
    assert.equal(reviews.length, 2);
    assert.equal(reviews[1].verdict, 'changes_requested', 'First review recorded as changes_requested');
    assert.equal(reviews[0].verdict, 'accept', 'Second review recorded as accept');
  } finally {
    await cleanup();
  }
});

test('Audit-R2-2: Crash/partial-failure recovery creates first thread artifact, completes remaining inline tasks without duplication, and preserves git worktree commitSha', async () => {
  const { app, tmpDir, cleanup } = createIsolatedApp();
  try {
    // --- Subcase A: Control plane restarts before processing a reply that generates the thread's FIRST artifact + 2 inline tasks ---
    const threadA = app.threads.createThread({
      title: '首份文稿恢复测试',
      activeOwnerMemberId: 'mem_a'
    });
    assert.equal(threadA.boundArtifactId, null, 'New thread starts with no bound artifact');

    const nowIso = new Date().toISOString();
    app.db.sqlite
      .prepare(
        `INSERT INTO v2_dispatch_attempts (
          id, target_kind, target_id, thread_id, member_id, idempotency_key, scope_key,
          native_session_id, native_turn_id, status, slot_held, base_artifact_id, base_artifact_version,
          prompt_digest, prompt_bytes, handoff_bytes, response_text, usage_json, dispatched_at, settled_at
        ) VALUES (
          'att_rec_first_art', 'thread_message', 'msg_rec_agent_1', ?, 'mem_a', 'idem_rec_first_art', 'thread:rec',
          'sess_1', 'turn_1', 'succeeded', 0, NULL, NULL,
          'dig', 64, 0, ?, '{"workbenchDispatches":1,"nativeTurns":1,"providerUsage":{"observable":false,"modelRequests":null,"inputTokens":null,"cachedInputTokens":null,"uncachedInputTokens":null,"outputTokens":null,"totalTokens":null}}', ?, ?
        )`
      )
      .run(
        threadA.id,
        '已整理首份方案与两项计划。\n' +
          '<duolawork_artifact title="重启恢复首稿.md"># 重启恢复首稿\n核心章节一与章节二</duolawork_artifact>\n' +
          '<duolawork_task>[{"title":"恢复早报计划","kind":"scheduled","cronExpr":"0 8 * * *","leadMemberId":"mem_a","goal":"早报","startImmediately":false},{"title":"恢复晚报计划","kind":"scheduled","cronExpr":"0 20 * * *","leadMemberId":"mem_a","goal":"晚报","startImmediately":false}]</duolawork_task>',
        nowIso,
        nowIso
      );

    app.db.sqlite
      .prepare(
        `INSERT INTO v2_thread_messages (
          id, thread_id, seq, author_kind, author_id, target_member_id, attempt_id,
          body, artifact_refs_json, turn_status, inline_actions_applied, created_at, updated_at
        ) VALUES ('msg_rec_agent_1', ?, 1, 'agent', 'mem_a', 'mem_a', 'att_rec_first_art', '', '[]', 'running', 0, ?, ?)`
      )
      .run(threadA.id, nowIso, nowIso);

    const synced1 = app.threads.syncReconciledThreadTurns();
    assert.equal(synced1.length, 1);

    const updatedThreadA = app.threads.getThread(threadA.id)!;
    assert.ok(updatedThreadA.boundArtifactId, 'First artifact must be created & bound to thread during recovery');
    const createdArt = app.artifacts.getArtifact(updatedThreadA.boundArtifactId!)!;
    assert.equal(createdArt.title, '重启恢复首稿.md');
    assert.match(createdArt.content, /核心章节一与章节二/);

    const recoveredTasksA = app.tasks.listTasks({ sourceThreadId: threadA.id });
    assert.equal(recoveredTasksA.length, 2, 'Both inline tasks recovered');

    // Re-running syncReconciledThreadTurns must be a strict no-op (0 duplicates)
    app.threads.syncReconciledThreadTurns();
    assert.equal(app.tasks.listTasks({ sourceThreadId: threadA.id }).length, 2);

    // --- Subcase B: Partial transient failure on 2nd inline task -> retry with same idempotencyKey completes 2nd task without duplicating 1st! ---
    const threadB = app.threads.createThread({
      title: '半途失败补建测试',
      activeOwnerMemberId: 'mem_a'
    });
    app.registry.mockDriver.handlers.set('mem_a', async () => ({
      text:
        '为你建立两项计划：\n' +
        '<duolawork_task>{"title":"半途测试计划一","kind":"scheduled","cronExpr":"0 9 * * *","leadMemberId":"mem_a","goal":"计划一","startImmediately":false}</duolawork_task>\n' +
        '<duolawork_task>{"title":"半途测试计划二","kind":"scheduled","cronExpr":"0 18 * * *","leadMemberId":"mem_a","goal":"计划二","startImmediately":false}</duolawork_task>'
    }));

    const origCreateSync = app.threads.actionHandler!.createOrUpdateTaskSync!;
    let createCallCounter = 0;
    let injectTransientThrowOnSecond = true;
    app.threads.actionHandler!.createOrUpdateTaskSync = (claims, args) => {
      createCallCounter += 1;
      if (injectTransientThrowOnSecond && createCallCounter === 2) {
        throw new Error('SIMULATED_MID_ACTION_DB_INTERRUPT');
      }
      return origCreateSync(claims, args);
    };

    const partialKey = 'msgreq:partial-inline-recovery-01';
    const firstTry = await app.threads.sendUserMessage({
      threadId: threadB.id,
      body: '建立早晚两项计划',
      idempotencyKey: partialKey
    });
    assert.equal(app.tasks.listTasks({ sourceThreadId: threadB.id }).length, 1, 'Only task #1 created before interrupt');
    const flagAfterInterrupt = app.db.sqlite
      .prepare(`SELECT inline_actions_applied FROM v2_thread_messages WHERE id = ?`)
      .get(firstTry.agentMessage.id) as { inline_actions_applied: number };
    assert.equal(flagAfterInterrupt.inline_actions_applied, 0, 'inline_actions_applied must stay 0 when an action failed transiently');

    // Now clear fault injection and retry with the exact same idempotencyKey!
    injectTransientThrowOnSecond = false;
    app.threads.actionHandler!.createOrUpdateTaskSync = origCreateSync;
    const retryRes = await app.threads.sendUserMessage({
      threadId: threadB.id,
      body: '建立早晚两项计划',
      idempotencyKey: partialKey
    });
    const tasksAfterRetryB = app.tasks.listTasks({ sourceThreadId: threadB.id });
    assert.equal(tasksAfterRetryB.length, 2, 'Retry must create missing task #2 without duplicating task #1');
    const flagAfterRetry = app.db.sqlite
      .prepare(`SELECT inline_actions_applied FROM v2_thread_messages WHERE id = ?`)
      .get(retryRes.agentMessage.id) as { inline_actions_applied: number };
    assert.equal(flagAfterRetry.inline_actions_applied, 1);
    assert.doesNotMatch(retryRes.agentMessage.body, /自动创建任务失败/);

    // --- Subcase C: Git worktree coding step with code edits + empty text "" recovered across restart preserves commitSha & merges! ---
    const repoDir = path.join(tmpDir, 'sample-git-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'index.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repoDir });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-m', 'init'], {
      cwd: repoDir
    });

    const { task: codeTask, initialRun: codeRun } = app.tasks.createOrUpdateTask({
      sourceThreadId: threadB.id,
      title: '代码工作区重启提交恢复',
      leadMemberId: 'mem_a',
      startImmediately: true,
      spec: {
        goal: '修改代码但返回空正文并在落库前重启',
        workspaceRepoPath: repoDir,
        steps: [
          {
            stepOrder: 1,
            title: '编写模块代码',
            assigneeMemberId: 'mem_b',
            brief: '更新 index.js',
            acceptanceCriteria: '代码可合并',
            useWorktree: true
          }
        ]
      }
    });
    void codeTask;
    const codeStep = app.tasks.listSteps(codeRun!.id)[0];
    const wtInfo = await app.worktrees.ensureStepWorktree({
      repoPath: repoDir,
      runId: codeRun!.id,
      stepId: codeStep.id
    });
    // Worker edited file in worktree, returned empty text "", and server restarted before recording submission!
    fs.writeFileSync(path.join(wtInfo.worktreePath, 'index.js'), 'module.exports = 42;\n');
    app.db.sqlite
      .prepare(`UPDATE v2_task_steps SET status = 'running', worktree_path = ?, worktree_branch = ? WHERE id = ?`)
      .run(wtInfo.worktreePath, wtInfo.branchName, codeStep.id);
    app.db.sqlite
      .prepare(
        `INSERT INTO v2_dispatch_attempts (
          id, target_kind, target_id, thread_id, task_id, run_id, step_id,
          member_id, idempotency_key, scope_key, native_session_id, native_turn_id,
          status, slot_held, prompt_digest, prompt_bytes, handoff_bytes, response_text, usage_json, dispatched_at, settled_at
        ) VALUES (
          'att_wt_recover', 'task_step', ?, ?, ?, ?, ?,
          'mem_b', 'step_wt_rec_1', ?, 'sess_wt', 'turn_wt',
          'reconciling', 0, 'dig', 64, 0, NULL,
          '{"workbenchDispatches":1,"nativeTurns":0,"providerUsage":{"observable":false,"modelRequests":null,"inputTokens":null,"cachedInputTokens":null,"uncachedInputTokens":null,"outputTokens":null,"totalTokens":null}}', ?, NULL
        )`
      )
      .run(codeStep.id, threadB.id, codeRun!.taskId, codeRun!.id, codeStep.id, codeStep.isolatedSessionKey, nowIso);

    app.registry.mockDriver.reconciledResults.set('att_wt_recover', {
      state: 'completed',
      text: '', // Empty text, ONLY code changes in worktree!
      nativeSessionId: 'sess_wt',
      nativeTurnId: 'turn_wt'
    });
    app.registry.mockDriver.handlers.set('mem_a', async () => ({
      text: '{"verdict":"accept","comments":"代码提交完整，验收通过"}'
    }));

    await app.registry.reconcileInFlightAttempts({ waitTimeoutMs: 0 });
    await app.tasks.reconcileInFlightTaskRuns();

    const recoveredSub = app.tasks.getLatestStepSubmission(codeStep.id);
    assert.ok(recoveredSub, 'Recovered submission must exist');
    assert.ok(
      recoveredSub!.commitSha && recoveredSub!.commitSha.length >= 7,
      'Recovered coding step must commit worktree changes and record non-null commitSha'
    );
    const settledCodeRun = app.tasks.getRun(codeRun!.id)!;
    assert.equal(settledCodeRun.status, 'completed', 'Code-only recovered step must merge & complete cleanly');
    assert.ok(settledCodeRun.integrationWorktreePath);
    assert.equal(
      fs.readFileSync(path.join(settledCodeRun.integrationWorktreePath!, 'index.js'), 'utf8'),
      'module.exports = 42;\n'
    );
  } finally {
    await cleanup();
  }
});

test('Audit-R3-1: Canceling attempts queued in acquireSlot or blocked in ensureSession resolves immediately without breaking maxConcurrentRuns or waking sibling canceled steps', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    // Configure a strict maxConcurrentRuns = 1 member
    app.db.upsertMember({
      id: 'mem_serial',
      name: '单槽串行成员',
      platformId: 'codex',
      driverKind: 'mock',
      location: 'local',
      capabilities: {
        supportsIsolatedSessions: true,
        supportsSessionResume: true,
        supportsCancel: true,
        maxConcurrentRuns: 1
      },
      status: 'ready',
      statusMessage: '在线',
      config: {}
    });

    // --- Subcase A: Turn 1 running, Turn 2 & Turn 3 queued in waitQueues; abort Turn 2! ---
    // Turn 2 must cancel immediately without running ensureSession/runTurn, Turn 3 MUST NOT start while Turn 1 is still active (maxActive === 1),
    // and once Turn 1 finishes, Turn 3 acquires the slot and completes cleanly!
    const t1 = app.threads.createThread({ title: '槽位占用对话1', activeOwnerMemberId: 'mem_serial' });
    const t2 = app.threads.createThread({ title: '排队取消对话2', activeOwnerMemberId: 'mem_serial' });
    const t3 = app.threads.createThread({ title: '后续排队对话3', activeOwnerMemberId: 'mem_serial' });

    let activeCount = 0;
    let maxObservedActive = 0;
    let t1StartedResolve!: () => void;
    const t1Started = new Promise<void>((r) => {
      t1StartedResolve = r;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((r) => {
      releaseT1 = r;
    });
    const executedScopes: string[] = [];

    app.registry.mockDriver.handlers.set('mem_serial', async (inp) => {
      activeCount += 1;
      if (activeCount > maxObservedActive) maxObservedActive = activeCount;
      executedScopes.push(inp.scopeKey);
      try {
        if (inp.scopeKey.includes(t1.id)) {
          t1StartedResolve();
          await t1Gate;
          return { text: '对话1正常完成' };
        }
        return { text: `后续完成:${inp.scopeKey}` };
      } finally {
        activeCount -= 1;
      }
    });

    const p1 = app.threads.sendUserMessage({ threadId: t1.id, body: '第一条占槽消息' });
    await t1Started;

    const p2 = app.threads.sendUserMessage({ threadId: t2.id, body: '第二条排队后取消' });
    const p3 = app.threads.sendUserMessage({ threadId: t3.id, body: '第三条继续排队' });
    await new Promise((r) => setTimeout(r, 25));

    // Abort Turn 2 while it is queued in acquireSlot!
    const abortRes2 = await app.threads.abortActiveTurn(t2.id);
    assert.equal(abortRes2.aborted, true);

    const res2 = await Promise.race([
      p2,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Queued Turn 2 did not settle immediately on abortActiveTurn')), 400)
      )
    ]);
    assert.equal(res2.agentMessage.turnStatus, 'canceled');

    // Give microtasks/timers a chance: Turn 3 MUST still be waiting because Turn 1 still holds the single slot!
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(maxObservedActive, 1, 'Aborting queued Turn 2 must NEVER wake Turn 3 while Turn 1 holds the slot');
    assert.deepEqual(executedScopes, [`thread:${t1.id}:mem_serial`], 'Turn 2 and Turn 3 have not entered runTurn yet');

    // Now finish Turn 1 -> Turn 3 must wake up and complete cleanly!
    releaseT1();
    const [res1, res3] = await Promise.all([p1, p3]);
    assert.equal(res1.agentMessage.turnStatus, 'completed');
    assert.equal(res3.agentMessage.turnStatus, 'completed');
    assert.equal(maxObservedActive, 1, 'Strict maxConcurrentRuns=1 preserved throughout');
    assert.equal(
      executedScopes.some((s) => s.includes(t2.id)),
      false,
      'Canceled Turn 2 never entered runTurn'
    );
    const t2Attempts = app.registry.listAttempts({ threadId: t2.id });
    assert.equal(t2Attempts.length, 1);
    assert.equal(t2Attempts[0].status, 'failed');
    assert.equal(t2Attempts[0].slotHeld, false);

    // --- Subcase B: Slow ensureSession -> abortActiveTurn cancels immediately & late ensureSession resolution never invokes runTurn ---
    const tSlow = app.threads.createThread({ title: '慢建连取消测试', activeOwnerMemberId: 'mem_serial' });
    const origEnsureSession = app.registry.mockDriver.ensureSession.bind(app.registry.mockDriver);
    let ensureEnteredResolve!: () => void;
    const ensureEntered = new Promise<void>((r) => {
      ensureEnteredResolve = r;
    });
    let releaseSlowEnsure!: () => void;
    const slowEnsureGate = new Promise<void>((r) => {
      releaseSlowEnsure = r;
    });
    let slowRunTurnCalled = false;

    app.registry.mockDriver.ensureSession = async (inp) => {
      if (inp.scopeKey.includes(tSlow.id)) {
        ensureEnteredResolve();
        await slowEnsureGate;
      }
      return origEnsureSession(inp);
    };
    app.registry.mockDriver.handlers.set('mem_serial', async (inp) => {
      if (inp.scopeKey.includes(tSlow.id)) {
        slowRunTurnCalled = true;
      }
      return { text: '正常响应' };
    });

    try {
      const pSlow = app.threads.sendUserMessage({ threadId: tSlow.id, body: '建连卡住时点击停止' });
      await ensureEntered;

      const abortSlow = await app.threads.abortActiveTurn(tSlow.id);
      assert.equal(abortSlow.aborted, true);

      const resSlow = await Promise.race([
        pSlow,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Turn blocked in ensureSession did not cancel immediately')), 400)
        )
      ]);
      assert.equal(resSlow.agentMessage.turnStatus, 'canceled');

      // Let slow ensureSession finish afterwards — runTurn must STILL never be called!
      releaseSlowEnsure();
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(slowRunTurnCalled, false, 'Late ensureSession completion must never invoke runTurn');
      const slowAtt = app.registry.listAttempts({ threadId: tSlow.id })[0];
      assert.equal(slowAtt.status, 'failed');
    } finally {
      app.registry.mockDriver.ensureSession = origEnsureSession;
    }

    // --- Subcase C: cancelRun on multi-step task where Step 1 holds slot, Step 2 is queued, and an unrelated Thread turn is queued behind Step 2 ---
    let step1StartedResolve!: () => void;
    const step1Started = new Promise<void>((r) => {
      step1StartedResolve = r;
    });
    let step2EnteredRunTurn = false;
    const abortTurnCallIds: string[] = [];
    const mockDriverAsInterface = app.registry.getDriver('mock');
    const origAbortTurn = mockDriverAsInterface.abortTurn.bind(mockDriverAsInterface);
    mockDriverAsInterface.abortTurn = async (member, att) => {
      abortTurnCallIds.push(att.id);
      return origAbortTurn(member, att);
    };

    app.registry.mockDriver.handlers.set('mem_serial', async (inp) => {
      if (inp.prompt.includes('并行步骤一')) {
        step1StartedResolve();
        await new Promise((r) => setTimeout(r, 5000));
        return { text: '步骤一不应完成' };
      }
      if (inp.prompt.includes('并行步骤二')) {
        step2EnteredRunTurn = true;
        return { text: '步骤二绝不应被唤醒执行' };
      }
      return { text: '无关对话顺利接棒槽位' };
    });

    try {
      const { initialRun } = app.tasks.createOrUpdateTask({
        sourceThreadId: t1.id,
        title: '双步串行槽位取消测试',
        leadMemberId: 'mem_a',
        spec: {
          goal: '验证取消任务时不会把槽位误传给同一任务的排队步骤二',
          steps: [
            {
              stepOrder: 1,
              title: '并行步骤一',
              assigneeMemberId: 'mem_serial',
              brief: '并行步骤一',
              acceptanceCriteria: 'ok'
            },
            {
              stepOrder: 2,
              title: '并行步骤二',
              assigneeMemberId: 'mem_serial',
              brief: '并行步骤二',
              acceptanceCriteria: 'ok'
            }
          ]
        }
      });

      const drivePromise = app.tasks.driveRun(initialRun!.id);
      await step1Started;
      await new Promise((r) => setTimeout(r, 25)); // Step 2 is now queued in waitQueues behind Step 1

      // Queue an unrelated thread message behind Step 2
      const tOther = app.threads.createThread({ title: '外部正常对话', activeOwnerMemberId: 'mem_serial' });
      const pOther = app.threads.sendUserMessage({ threadId: tOther.id, body: '等待槽位释放' });
      await new Promise((r) => setTimeout(r, 20));

      const canceledRun = await app.tasks.cancelRun(initialRun!.id);
      assert.equal(canceledRun.status, 'canceled');
      await drivePromise;

      const otherRes = await Promise.race([
        pOther,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Unrelated queued thread did not receive freed slot after cancelRun')), 600)
        )
      ]);
      assert.equal(otherRes.agentMessage.turnStatus, 'completed');
      assert.equal(otherRes.agentMessage.body, '无关对话顺利接棒槽位');
      assert.equal(step2EnteredRunTurn, false, 'Sibling Step 2 of canceled run must NEVER enter runTurn');

      const runAttempts = app.registry.listAttempts({ runId: initialRun!.id });
      assert.equal(runAttempts.length, 2);
      assert.ok(runAttempts.every((a) => a.status === 'failed' && !a.slotHeld));
      // Only Step 1 (which was actually running) should receive driver.abortTurn, never prepared Step 2!
      assert.equal(abortTurnCallIds.length, 1);
    } finally {
      mockDriverAsInterface.abortTurn = origAbortTurn;
    }
  } finally {
    await cleanup();
  }
});

test('Audit-R4-1: Cloud AGENT_HUB_BRIDGE_URL/KEY fallback preserves remote-node members, and pre-dispatch Clarification Card (1-3 questions) blocks premature task creation until user confirms in UI', async () => {
  const staticWebDir = path.resolve(process.cwd(), 'dist/web');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-audit-r4-'));

  // 1. Start a mock remote 1.9.6 Hub server to verify AGENT_HUB_BRIDGE_URL + AGENT_HUB_BRIDGE_KEY fallback when Mac config path is missing!
  const mockHubSrv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer mock_cloud_bridge_secret') {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (u.pathname === '/v2/workspace') {
      res.end(
        JSON.stringify({
          members: [
            { id: 'member_ccdf940ba6d3426da01b9f65048909e2', name: 'Gemini2VPS', platformId: 'antigravity', status: 'ready' },
            { id: 'member_grok_bridge', name: 'grok_cloud', platformId: 'grok-bot', mode: 'connector', status: 'ready' }
          ],
          connections: [{ id: 'member_grok_bridge', transport: 'grok-webhook', status: 'verified' }],
          accounts: []
        })
      );
      return;
    }
    if (u.pathname === '/v2/commands' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const parsed = JSON.parse(raw || '{}');
        if (parsed.type === 'channel.create') {
          res.end(JSON.stringify({ result: { id: 'ch_bridge_r4' } }));
          return;
        }
        res.end(JSON.stringify({ result: { id: 'msg_bridge_r4' } }));
      });
      return;
    }
    if (u.pathname === '/v2/channel') {
      res.end(
        JSON.stringify({
          channel: { id: 'ch_bridge_r4' },
          messages: [
            { id: 'msg_bridge_r4', authorId: 'owner', body: 'prompt' },
            { id: 'msg_reply_r4', authorId: 'member_grok_bridge', replyTo: 'msg_bridge_r4', body: 'Grok 云端桥接已完成爆款推文归因与 3 个延展选题方案！' }
          ]
        })
      );
      return;
    }
    res.end(JSON.stringify({ items: [] }));
  });
  await new Promise<void>((r) => mockHubSrv.listen(0, '127.0.0.1', () => r()));
  const hubPort = (mockHubSrv.address() as { port: number }).port;

  const prevBridgeUrl = process.env.AGENT_HUB_BRIDGE_URL;
  const prevBridgeKey = process.env.AGENT_HUB_BRIDGE_KEY;
  process.env.AGENT_HUB_BRIDGE_URL = `http://127.0.0.1:${hubPort}`;
  process.env.AGENT_HUB_BRIDGE_KEY = 'mock_cloud_bridge_secret';

  const app = new DuolaWorkApp({
    dbPath: path.join(tmpDir, 'r4.sqlite'),
    filesDir: path.join(tmpDir, 'files'),
    worktreesRoot: path.join(tmpDir, 'worktrees'),
    staticWebDir,
    autoImportAgentHub: true,
    agentHubDir: path.join(tmpDir, 'nonexistent-mac-agent-hub-dir')
  });

  // Seed Gemini2VPS as a Cloud `remote-node` member + grok_cloud with a stale Mac config path `/Users/nonexistent/.config/agent-hub/config.json`
  app.db.upsertMember({
    id: 'member_ccdf940ba6d3426da01b9f65048909e2',
    name: 'Gemini2VPS',
    platformId: 'antigravity',
    driverKind: 'remote-node',
    location: 'cloud-node',
    nodeId: 'node_cloud_test',
    capabilities: { supportsIsolatedSessions: true, supportsSessionResume: true, supportsCancel: true, maxConcurrentRuns: 2 },
    status: 'ready',
    statusMessage: '在线',
    config: { localDriverKind: 'acp-stdio' }
  });
  app.db.upsertMember({
    id: 'member_grok_bridge',
    name: 'grok_cloud',
    platformId: 'grok-bot',
    driverKind: 'remote-bridge',
    location: 'remote-bridge',
    capabilities: { supportsIsolatedSessions: false, supportsSessionResume: false, supportsCancel: false, maxConcurrentRuns: 1 },
    status: 'ready',
    statusMessage: '在线',
    config: {
      agentHubConfigPath: '/Users/nonexistent_mac_user/.config/agent-hub/config.json',
      remoteMode: 'hub-channel',
      hubTransport: 'grok-webhook'
    }
  });
  app.db.upsertMember({
    id: 'mem_lead_ui',
    name: 'Gemini助手',
    platformId: 'antigravity',
    driverKind: 'mock',
    location: 'cloud-node',
    capabilities: { supportsIsolatedSessions: true, supportsSessionResume: true, supportsCancel: true, maxConcurrentRuns: 2 },
    status: 'ready',
    statusMessage: '在线',
    config: {}
  });

  app.registry.mockDriver.handlers.set('mem_lead_ui', async (inp) => {
    if (inp.prompt.includes('【已确认需求')) {
      return {
        text:
          '收到你的确认！现在立即为 **grok_cloud** 正式立项并派发执行。\n' +
          '<duolawork_task>{"title":"复盘近期爆款推文与延展选题","kind":"once","leadMemberId":"grok_cloud","goal":"按近14天范围拆解爆款原因并给出实操测评选题","startImmediately":true}</duolawork_task>'
      };
    }
    // Ambiguous initial request: Agent emits <duolawork_ask> with 4 questions (must clamp to 3) AND accidentally includes <duolawork_task> (must be suppressed!)
    return {
      text:
        '在正式派发给 grok_cloud 之前，先和你快速确认 3 个关键范围：\n' +
        '<duolawork_ask>{"title":"派单前需求确认","targetMemberName":"grok_cloud","summary":"确认推文复盘范围与落地方向后立即派发","questions":[{"question":"推文时间范围看多久？","options":["最近 7 天（推荐）","最近 14 天","最近 30 天"]},{"question":"延展产出侧重哪类？（可多选）","options":["续打选题","硬核测评","轻量工具制作","信息差套利"],"multiSelect":true},{"question":"任务执行方式？","options":["单次深度复盘（推荐）","每周定时追踪"]},{"question":"多余第4题应被自动截断","options":["A","B"]}]}</duolawork_ask>\n' +
        '<duolawork_task>{"title":"不应提前创建的抢跑任务","kind":"once","leadMemberId":"grok_cloud","goal":"抢跑"}</duolawork_task>'
    };
  });

  const thread = app.threads.createThread({
    title: '先确认后派单测试对话',
    activeOwnerMemberId: 'mem_lead_ui'
  });

  const { url } = await app.listen(0, '127.0.0.1');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  try {
    // Verify syncLegacyWorkspaceMembersReadOnly used env credentials AND preserved Gemini2VPS as `remote-node`!
    await app.syncLegacyWorkspaceMembersReadOnly();
    const geminiAfterSync = app.db.getMember('member_ccdf940ba6d3426da01b9f65048909e2')!;
    assert.equal(geminiAfterSync.driverKind, 'remote-node', 'remote-node member must NOT be overwritten by legacy workspace sync');

    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });

    // Send ambiguous task request
    await page.fill('.chat-composer textarea', '给 grok_cloud 分配个任务，看下我最近推文为什么火，还能做什么选题或测评');
    await page.click('.dw-send-btn');

    // Clarification card must appear with max 3 questions, AND 0 tasks created yet!
    await page.waitForSelector('[data-testid="clarification-card"]', { state: 'visible' });
    assert.equal(
      app.tasks.listTasks({ sourceThreadId: thread.id }).length,
      0,
      'Zero premature tasks created while waiting for user clarification'
    );
    const questionCount = await page.locator('.clarify-question-block').count();
    assert.equal(questionCount, 3, 'Questions strictly clamped to 1..3');

    // Select "最近 14 天" on Q1, toggle "硬核测评" on multi-select Q2, add a custom note, and click "确认并派发任务"!
    await page.locator('.clarify-option-btn', { hasText: '最近 14 天' }).click();
    await page.locator('.clarify-option-btn', { hasText: '硬核测评' }).click();
    await page.fill('.clarify-note-input', '优先给出可本周落地的 Top 2');
    await page.getByRole('button', { name: '确认并派发任务' }).click();

    // Card transitions to answered state, task is created, AND grok_cloud executes via AGENT_HUB_BRIDGE_URL/KEY without Mac config file error!
    await page.waitForSelector('.clarify-card.is-answered', { state: 'visible' });
    await page.waitForFunction(
      () => document.body.innerText.includes('Grok 云端桥接已完成爆款推文归因与 3 个延展选题方案'),
      undefined,
      { timeout: 8000 }
    );

    const tasksAfterConfirm = app.tasks.listTasks({ sourceThreadId: thread.id });
    assert.equal(tasksAfterConfirm.length, 1, 'Task created cleanly right after user confirmed card');
    const runs = app.tasks.listRuns(tasksAfterConfirm[0].id);
    assert.equal(runs[0].status, 'completed', 'Remote-bridge step succeeded on Cloud using env bridge credentials');
  } finally {
    if (prevBridgeUrl === undefined) delete process.env.AGENT_HUB_BRIDGE_URL;
    else process.env.AGENT_HUB_BRIDGE_URL = prevBridgeUrl;
    if (prevBridgeKey === undefined) delete process.env.AGENT_HUB_BRIDGE_KEY;
    else process.env.AGENT_HUB_BRIDGE_KEY = prevBridgeKey;
    await browser.close();
    await app.close();
    await new Promise<void>((r) => mockHubSrv.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Audit-R5-1: grok-webhook and dots-events stay ready when verified, and long tool-trace commands never overflow horizontally', async () => {
  // 1. Verify transport-aware health evaluation
  const grokHealth = evaluateHubChannelMemberHealth(
    { transport: 'grok-webhook', status: 'verified', subscriptionActive: false, needsAuthorization: false },
    { id: 'm_grok1', status: 'ready', mode: 'browser' },
    { status: 'ready', browserPaused: true, message: '专用浏览器已关闭' },
    'grok-webhook'
  );
  assert.equal(grokHealth.status, 'ready', 'Verified grok-webhook must be ready even when subscriptionActive=false and legacy browserPaused=true');

  const dotHealth = evaluateHubChannelMemberHealth(
    { transport: 'dots-events', status: 'verified', subscriptionActive: true, authSeenAt: '2026-11-02T06:01:36.889Z' },
    { id: 'm_dot', status: 'unverified', mode: 'connector' },
    null,
    'dots-events'
  );
  assert.equal(dotHealth.status, 'ready', 'Verified dots-events with active subscription must be ready regardless of idle authSeenAt');

  const museOffline = evaluateHubChannelMemberHealth(
    { transport: 'muse-poll', status: 'verified', subscriptionActive: false, authSeenAt: '2026-11-10T10:49:16.944Z' },
    { id: 'm_muse', status: 'unverified', mode: 'browser' },
    null,
    'muse-poll'
  );
  assert.equal(museOffline.status, 'offline', 'Stale muse-poll with no active poller must remain offline');

  // 2. Verify Playwright rendering of .turn-tool-trace with 10 huge 260-char python/file/grep entries has ZERO horizontal overflow
  const staticWebDir = path.resolve(process.cwd(), 'dist/web');
  if (!fs.existsSync(path.join(staticWebDir, 'index.html'))) return;

  const { app, tmpDir } = createIsolatedApp({ staticWebDir });
  app.db.upsertMember({
    id: 'mem_tool_ui',
    name: 'Gemini2VPS',
    platformId: 'antigravity',
    driverKind: 'mock',
    location: 'cloud-node',
    capabilities: {
      supportsIsolatedSessions: true,
      supportsSessionResume: true,
      supportsCancel: true,
      maxConcurrentRuns: 1
    },
    status: 'ready',
    statusMessage: '就绪',
    config: {}
  });
  const thread = app.threads.createThread({ title: '工具卡片溢出回归', activeOwnerMemberId: 'mem_tool_ui' });
  const now = new Date().toISOString();
  const hugeTools = Array.from({ length: 10 }, (_, idx) => ({
    id: `t_${idx}`,
    name:
      idx % 3 === 0
        ? `python3 -c 'import sys, json; sys.path.insert(0, "/home/claude/.config/duolawork-runtime/member_ccdf940ba6d3426da01b9f65048909e2/chats/channel_6d302b18e24841f6a449b88f86b24aae"); from scripts.xhunt_pipeline import call_xhunt_api; print(${idx})'`
        : idx % 3 === 1
          ? `File coding/member_ccdf940ba6d3426da01b9f65048909e2/chats/channel_6d302b18e24841f6a449b88f86b24aae/scripts/xhunt_pipeline_${idx}.py`
          : `"\\"hunterweb303\\" \\"2026年11月\\" OR \\"Nov 2026\\" site:x.com" on Web`,
    summary: idx % 3 === 2 ? '"hunterweb303" "2026年11月" OR "Nov 2026" site:x.com' : '',
    status: idx === 9 ? 'running' : 'done'
  }));
  app.db.sqlite
    .prepare(
      `INSERT INTO v2_thread_messages
       (id, thread_id, seq, author_kind, author_id, target_member_id, attempt_id, body, artifact_refs_json, tool_trace_json, turn_status, created_at, updated_at)
       VALUES (?, ?, ?, 'agent', ?, NULL, NULL, ?, '[]', ?, 'running', ?, ?)`
    )
    .run('msg_running_tools', thread.id, 1, 'mem_tool_ui', '正在处理…', JSON.stringify(hugeTools), now, now);

  const { url } = await app.listen(0, '127.0.0.1');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector('.turn-tool-trace.is-running', { state: 'visible' });

    // Running view caps live visible items to 3 + "展开前面已完成的 7 步…" button, and NEVER overflows container
    assert.equal(await page.locator('.turn-tool-item').count(), 3, 'Running mode shows compact latest 3 items by default');
    assert.ok(await page.locator('.turn-tool-more-btn').isVisible(), 'Expand earlier steps button shown');

    const overflowBeforeExpand = await page.evaluate(() => {
      const box = document.querySelector('.turn-tool-trace') as HTMLElement;
      const items = [...document.querySelectorAll('.turn-tool-item')] as HTMLElement[];
      return {
        boxOverflow: box.scrollWidth - box.clientWidth,
        maxItemOverflow: Math.max(0, ...items.map((el) => el.scrollWidth - el.clientWidth))
      };
    });
    assert.ok(overflowBeforeExpand.boxOverflow <= 1, `Box overflowed horizontally: ${JSON.stringify(overflowBeforeExpand)}`);
    assert.ok(overflowBeforeExpand.maxItemOverflow <= 1, `Item overflowed horizontally: ${JSON.stringify(overflowBeforeExpand)}`);

    // Expanding all 10 items stays strictly bounded vertically (scrollable) and horizontally (0 overflow)
    await page.click('.turn-tool-more-btn');
    assert.equal(await page.locator('.turn-tool-item').count(), 10, 'All 10 tool steps visible when expanded');
    const overflowAfterExpand = await page.evaluate(() => {
      const box = document.querySelector('.turn-tool-trace') as HTMLElement;
      const list = document.querySelector('.turn-tool-list') as HTMLElement;
      return {
        boxOverflow: box.scrollWidth - box.clientWidth,
        listHeight: list.getBoundingClientRect().height
      };
    });
    assert.ok(overflowAfterExpand.boxOverflow <= 1, `Expanded box overflowed horizontally: ${JSON.stringify(overflowAfterExpand)}`);
    assert.ok(overflowAfterExpand.listHeight <= 235, `Expanded list should scroll within max-height 220px, got ${overflowAfterExpand.listHeight}`);
  } finally {
    await browser.close();
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
