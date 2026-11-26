import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { DuolaWorkApp } from '../src/server/app.js';
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
    const quoteBtn = page.locator('aside.collaboration-space button:has-text("引用")').first();
    if ((await quoteBtn.count()) > 0) {
      await quoteBtn.click();
    } else {
      await page.click('button[aria-label="收起协作空间"]');
    }
    if ((await page.locator('aside.collaboration-space').count()) > 0) {
      await page.click('button[aria-label="收起协作空间"]');
    }
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
