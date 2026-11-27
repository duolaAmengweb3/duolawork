import { deliveryLabel } from '../shared/task-progress.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { StepOutcomes, parseOutcome, matchesReadback, outcomeSchema, splitSubmittedOutcome } from './task-outcomes.js';
import type { TaskOutcome } from '../shared/types.js';
import os from 'node:os';
import path from 'node:path';
import type { ArtifactStore } from './artifacts.js';
import type { AuthSandbox } from './auth-sandbox.js';
import type { DuolaWorkDatabase } from './db.js';
import type { DriverRegistry } from './drivers/registry.js';
import { SPACE_AND_DUOLABASE_TOOLS, SPACE_TOOL_NAMES, type DynamicToolDefinition } from './drivers/types.js';
import { validateCronExpr } from './scheduler.js';
import type { SpaceStore } from './space.js';
import type { ThreadEngine } from './threads.js';
import type { WorktreeManager } from './worktrees.js';
import {
  isExcludedClaudeVps,
  type MemberRecord,
  type MisfirePolicy,
  type ScopedTurnClaims,
  type StepReviewRecord,
  type StepSubmissionRecord,
  type TaskKind,
  type TaskRecord,
  type TaskRunRecord,
  type TaskSpec,
  type TaskStepRecord,
  type ToolPolicy
} from '../shared/types.js';

export class TaskEngine {
  private readonly scopeBridgeMeta = new Map<string, Record<string, unknown>>();
  private readonly scopeNativeSession = new Map<string, string>();
  private readonly activeStepRuns = new Set<string>();
  private readonly activeFinalizations = new Set<string>();
  private readonly stepFailureReasons = new Map<string, string>();
  private taskReconcileRunning = false;
  public readonly outcomes: StepOutcomes;
  private readonly checking = new Set<string>();
  public space?: SpaceStore;
  public scopedToolExecutor?: (
    claims: ScopedTurnClaims,
    toolName: string,
    args: Record<string, unknown>
  ) => Promise<unknown>;

  constructor(
    private readonly db: DuolaWorkDatabase,
    private readonly artifacts: ArtifactStore,
    private readonly sandbox: AuthSandbox,
    private readonly registry: DriverRegistry,
    private readonly threads: ThreadEngine,
    private readonly worktrees: WorktreeManager
  ) { this.outcomes = new StepOutcomes(db); }

  private resolveMember(idOrName: string): MemberRecord | null {
    const trimmed = String(idOrName || '').trim();
    if (!trimmed) return null;
    const byId = this.db.getMember(trimmed);
    if (byId) return byId;
    const lower = trimmed.toLowerCase();
    return this.db.listMembers().find((m) => m.name.trim().toLowerCase() === lower) ?? null;
  }

  public createOrUpdateTask(input: {
    taskId?: string;
    requesterMemberId?: string;
    sourceThreadId: string;
    projectId?: string;
    title: string;
    kind?: TaskKind;
    cronExpr?: string | null;
    intervalSeconds?: number | null;
    timezone?: string;
    misfirePolicy?: MisfirePolicy;
    scheduleEnabled?: boolean;
    leadMemberId: string;
    toolPolicy?: ToolPolicy;
    spec: {
      outcome?: TaskOutcome;
      goal?: string;
      acceptanceCriteria?: string;
      maxReviewRounds?: number;
      stepTimeoutMs?: number;
      workspaceRepoPath?: string | null;
      integrationTestCommand?: string | null;
      steps?: Array<{
        outcome?: TaskOutcome;
        stepOrder?: number;
        title?: string;
        assigneeMemberId?: string;
        dependsOnOrders?: number[];
        brief?: string;
        acceptanceCriteria?: string;
        toolPolicy?: ToolPolicy;
        useWorktree?: boolean;
      }>;
    };
    startImmediately?: boolean;
  }): { task: TaskRecord; initialRun: TaskRunRecord | null } {
    const cleanTitle = String(input.title || '').trim();
    if (!cleanTitle) throw badRequest('任务标题不能为空');

    const thread = this.threads.getThread(input.sourceThreadId);
    if (!thread) throw badRequest(`来源对话不存在: ${input.sourceThreadId}`);

    const lead = this.resolveMember(input.leadMemberId || thread.activeOwnerMemberId);
    if (!lead) throw badRequest(`负责人不存在: ${input.leadMemberId}`);
    if (isExcludedClaudeVps(lead)) {
      throw badRequest('禁止指定被排除的 VPS Claude 实例作为负责人');
    }

    const existing = input.taskId ? this.getTask(input.taskId) : null;
    const kind: TaskKind = input.kind ?? existing?.kind ?? 'once';
    const timezone = (input.timezone ?? existing?.timezone ?? 'Asia/Shanghai').trim() || 'Asia/Shanghai';
    const cleanCron =
      input.cronExpr !== undefined
        ? input.cronExpr
          ? input.cronExpr.trim()
          : null
        : existing?.cronExpr ?? null;
    const cleanInterval =
      input.intervalSeconds !== undefined
        ? input.intervalSeconds
        : existing?.intervalSeconds ?? null;

    if (kind === 'scheduled') {
      if (cleanCron) {
        const check = validateCronExpr(cleanCron, timezone);
        if (!check.valid) {
          throw badRequest(check.error || `无效的 Cron 表达式: ${cleanCron}`);
        }
      } else if (cleanInterval !== null && cleanInterval !== undefined) {
        if (!Number.isFinite(cleanInterval) || cleanInterval <= 0) {
          throw badRequest('定时间隔秒数必须是大于 0 的数字');
        }
      } else {
        throw badRequest('定时任务必须提供有效的 Cron 表达式或间隔秒数');
      }
    }

    const rawGoal = String(input.spec?.goal || existing?.spec.goal || cleanTitle).trim() || cleanTitle;
    const rawAcceptance =
      String(input.spec?.acceptanceCriteria || existing?.spec.acceptanceCriteria || '满足各分工步骤验收条件并通过负责人终审').trim();
    const rawSteps =
      Array.isArray(input.spec?.steps) && input.spec.steps.length > 0
        ? input.spec.steps
        : existing?.spec.steps ?? [
            {
              stepOrder: 1,
              title: cleanTitle,
              assigneeMemberId: lead.id,
              dependsOnOrders: [],
              brief: rawGoal,
              acceptanceCriteria: rawAcceptance
            }
          ];

    if (input.spec?.outcome && rawSteps.length > 1) throw badRequest('多步任务请在相应步骤上指定交付结果');
    const normalizedSteps = rawSteps.map((s, idx) => {
      const targetRef = String(s.assigneeMemberId || '').trim();
      const worker = targetRef ? this.resolveMember(targetRef) : lead;
      if (!worker) throw badRequest(`步骤执行人不存在: ${s.assigneeMemberId}`);
      if (isExcludedClaudeVps(worker)) {
        throw badRequest('禁止指定被排除的 VPS Claude 实例作为执行人');
      }
      const stepTitle = String(s.title || `步骤 ${idx + 1}`).trim();
      const rawDeps = Array.isArray(s.dependsOnOrders) ? s.dependsOnOrders : [];
      const uniqueDeps: number[] = [];
      for (const d of rawDeps) {
        const ord = Number(d);
        if (!Number.isInteger(ord) || ord <= 0) {
          throw badRequest(`步骤「${stepTitle}」包含无效的前置步骤编号: ${String(d)}`);
        }
        if (!uniqueDeps.includes(ord)) {
          uniqueDeps.push(ord);
        }
      }
      return {
        stepOrder: typeof s.stepOrder === 'number' && Number.isInteger(s.stepOrder) && s.stepOrder > 0 ? s.stepOrder : idx + 1,
        title: stepTitle,
        outcome: parseOutcome(s.outcome ?? (rawSteps.length === 1 ? input.spec.outcome : undefined)),
        assigneeMemberId: worker.id,
        dependsOnOrders: uniqueDeps,
        brief: String(s.brief || stepTitle || rawGoal).trim(),
        acceptanceCriteria: String(s.acceptanceCriteria || rawAcceptance).trim(),
        toolPolicy: s.toolPolicy ?? input.toolPolicy ?? 'duolabase_full',
        useWorktree: Boolean(s.useWorktree)
      };
    });

    validateStepsDag(normalizedSteps);

    const normalizedSpec: TaskSpec = {
      goal: rawGoal,
      acceptanceCriteria: rawAcceptance,
      maxReviewRounds: input.spec?.maxReviewRounds ?? existing?.spec.maxReviewRounds ?? 3,
      stepTimeoutMs: input.spec?.stepTimeoutMs ?? existing?.spec.stepTimeoutMs ?? 900_000,
      workspaceRepoPath: input.spec?.workspaceRepoPath === undefined ? existing?.spec.workspaceRepoPath ?? thread.workspacePath ?? null : input.spec.workspaceRepoPath,
      integrationTestCommand: input.spec?.integrationTestCommand === undefined ? existing?.spec.integrationTestCommand ?? null : input.spec.integrationTestCommand,
      steps: normalizedSteps
    };

    const now = new Date().toISOString();

    if (existing) {
      const nextTemplateVer = existing.templateVersion + 1;
      this.db.sqlite
        .prepare(
          `UPDATE v2_tasks
           SET title = ?, cron_expr = ?, interval_seconds = ?, timezone = ?,
               misfire_policy = ?, schedule_enabled = ?, template_version = ?,
               lead_member_id = ?, tool_policy = ?, spec_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          cleanTitle,
          cleanCron,
          cleanInterval,
          timezone,
          input.misfirePolicy ?? existing.misfirePolicy,
          input.scheduleEnabled !== undefined ? (input.scheduleEnabled ? 1 : 0) : existing.scheduleEnabled ? 1 : 0,
          nextTemplateVer,
          lead.id,
          input.toolPolicy ?? existing.toolPolicy,
          JSON.stringify(normalizedSpec),
          now,
          existing.id
        );
      const updated = this.getTask(existing.id)!;
      this.threads.emit({ type: 'task.updated', taskId: updated.id, threadId: updated.sourceThreadId, payload: updated });
      this.threads.emit({ type: 'thread.space_updated', threadId: updated.sourceThreadId });
      return { task: updated, initialRun: null };
    }

    return this.db.inTransaction(() => {
      const taskId = input.taskId ?? 'task_' + randomUUID().slice(0, 10);
      const leadSessionKey = `task_lead:${taskId}`;

      this.db.sqlite
        .prepare(
          `INSERT INTO v2_tasks (
            id, project_id, source_thread_id, title, kind, cron_expr, interval_seconds,
            timezone, misfire_policy, schedule_enabled, template_version,
            requester_member_id, lead_member_id, lead_session_key, tool_policy, spec_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'active', ?, ?)`
        )
        .run(
          taskId,
          input.projectId ?? thread.projectId,
          input.sourceThreadId,
          cleanTitle,
          kind,
          cleanCron,
          cleanInterval,
          timezone,
          input.misfirePolicy ?? (kind === 'scheduled' ? 'catch_up_once' : 'skip_stale'),
          input.scheduleEnabled === false ? 0 : 1,
          input.requesterMemberId ?? null,
          lead.id,
          leadSessionKey,
          input.toolPolicy ?? 'duolabase_full',
          JSON.stringify(normalizedSpec),
          now,
          now
        );

      const task = this.getTask(taskId)!;

      const assigneesNames = [
        ...new Set(
          normalizedSpec.steps.map((s) => this.db.getMember(s.assigneeMemberId)?.name || s.assigneeMemberId)
        )
      ].join('、');

      const scheduleHint =
        task.kind === 'scheduled' && task.cronExpr
          ? `（定时：${task.cronExpr}，负责人：${lead.name}，执行：${assigneesNames}）`
          : `（负责人：${lead.name}，执行：${assigneesNames}）`;

      this.threads.appendSystemMessage({
        threadId: task.sourceThreadId,
        authorKind: 'system_task_card',
        authorId: lead.id,
        body: `已立项任务《${task.title}》${scheduleHint}`,
        taskCard: { taskId: task.id, kind: 'created' }
      });

      let initialRun: TaskRunRecord | null = null;
      const shouldStartImmediately =
        input.startImmediately !== undefined ? input.startImmediately : kind === 'once';
      if (shouldStartImmediately) {
        const started = this.instantiateRun({
          taskId: task.id,
          plannedSlotAt: kind === 'once' ? `once:${task.id}:1` : `immediate:${task.id}:${Date.now()}`,
          triggerType: 'immediate'
        });
        initialRun = started.run;
      }

      this.threads.emit({ type: 'task.created', taskId: task.id, threadId: task.sourceThreadId, payload: task });
      this.threads.emit({ type: 'thread.space_updated', threadId: task.sourceThreadId });
      return { task, initialRun };
    });
  }

  /**
   * Idempotently instantiates a `TaskRun` keyed by `(taskId, plannedSlotAt)`.
   * Duplicate triggers for the exact same slot return `{ created: false }` with zero duplicate work!
   */
  public instantiateRun(input: {
    taskId: string;
    plannedSlotAt: string;
    triggerType: TaskRunRecord['triggerType'];
  }): { run: TaskRunRecord; created: boolean } {
    const task = this.getTask(input.taskId);
    if (!task) throw new Error(`任务不存在: ${input.taskId}`);

    return this.db.inTransaction(() => {
      const dup = this.db.sqlite
        .prepare(`SELECT * FROM v2_task_runs WHERE task_id = ? AND planned_slot_at = ?`)
        .get(task.id, input.plannedSlotAt) as Record<string, unknown> | undefined;
      if (dup) {
        return { run: mapRunRow(dup), created: false };
      }

      const maxRow = this.db.sqlite
        .prepare(`SELECT COALESCE(MAX(run_number), 0) AS max_num FROM v2_task_runs WHERE task_id = ?`)
        .get(task.id) as { max_num: number };
      const runNumber = Number(maxRow.max_num) + 1;
      const runId = 'run_' + randomUUID().slice(0, 12);
      const now = new Date().toISOString();

      const runArtifact = this.artifacts.createArtifact({
        sourceThreadId: task.sourceThreadId,
        taskId: task.id,
        runId,
        title:
          task.kind === 'scheduled'
            ? `${task.title} (第${runNumber}期).md`
            : `${task.title}-交付稿.md`,
        content: `# ${task.title}${task.kind === 'scheduled' ? ` · 第 ${runNumber} 期` : ''}\n\n任务执行进行中…\n`,
        writerKind: 'agent',
        writerId: task.leadMemberId
      });

      const requester = task.requesterMemberId;
      const delegated = requester && (requester !== task.leadMemberId || task.spec.steps.some(step => step.assigneeMemberId !== requester));
      const runLeadSessionKey = `task_lead:${task.id}:${runId}`;

      this.db.sqlite
        .prepare(
          `INSERT INTO v2_task_runs (
            id, task_id, run_number, planned_slot_at, template_version, trigger_type,
            status, delivery_stage, waiting_question, integration_worktree_path,
            integration_branch, final_artifact_id, summary,
            return_member_id, lead_member_id, lead_session_key, tool_policy, spec_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'running', 'steps_running', NULL, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          runId,
          task.id,
          runNumber,
          input.plannedSlotAt,
          task.templateVersion,
          input.triggerType,
          runArtifact.id,
          delegated ? requester : null,
          task.leadMemberId,
          runLeadSessionKey,
          task.toolPolicy,
          JSON.stringify(task.spec),
          now,
          now
        );

      // First pass: create step IDs mapped by stepOrder
      const stepIdByOrder = new Map<number, string>();
      for (const st of task.spec.steps) {
        stepIdByOrder.set(st.stepOrder, 'step_' + randomUUID().slice(0, 12));
      }

      for (const st of task.spec.steps) {
        const stepId = stepIdByOrder.get(st.stepOrder)!;
        const depIds = st.dependsOnOrders
          .map((ord) => stepIdByOrder.get(ord))
          .filter((v): v is string => Boolean(v));

        this.db.sqlite
          .prepare(
            `INSERT INTO v2_task_steps (
              id, run_id, task_id, step_order, title, assignee_member_id,
              depends_on_step_ids_json, brief, acceptance_criteria, tool_policy,
              use_worktree, status, review_round, isolated_session_key,
              native_session_id, worktree_path, worktree_branch,
              latest_submission_version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, 0, ?, ?)`
          )
          .run(
            stepId,
            runId,
            task.id,
            st.stepOrder,
            st.title,
            st.assigneeMemberId,
            JSON.stringify(depIds),
            st.brief,
            st.acceptanceCriteria,
            st.toolPolicy ?? task.toolPolicy,
            st.useWorktree ? 1 : 0,
            `step:${runId}:${st.stepOrder}`,
            now,
            now
          );
        this.outcomes.declare(stepId, st.outcome);
      }

      const run = this.getRun(runId)!;
      if (task.kind==='scheduled') this.threads.appendSystemMessage({threadId:task.sourceThreadId,authorKind:'system_task_card',authorId:task.leadMemberId,
        body:`《${task.title}》第 ${runNumber} 期`,taskCard:{taskId:task.id,runId,kind:'started'}});
      this.threads.emit({ type: 'task.run_created', taskId: task.id, runId, payload: run });
      return { run, created: true };
    });
  }

  public resolveEffectiveTaskForRun(run: TaskRunRecord): TaskRecord | null {
    const task = this.getTask(run.taskId);
    if (!task) return null;
    return {
      ...task,
      templateVersion: run.templateVersion ?? task.templateVersion,
      leadMemberId: run.leadMemberId || task.leadMemberId,
      leadSessionKey: run.leadSessionKey || `task_lead:${task.id}:${run.id}`,
      toolPolicy: run.toolPolicy || task.toolPolicy,
      spec: run.spec ?? task.spec
    };
  }

  public requestManualRun(taskId: string, retryFromRunId?: string) {
    return this.db.inTransaction(() => {
      const task = this.getTask(taskId);
      if (!task) throw badRequest('任务不存在');
      const runs = this.listRuns(taskId);
      const existing = task.kind === 'once' ? runs[0] : runs.find(r =>
        ['running', 'paused', 'waiting_user', 'waiting_node_online'].includes(r.status));
      if (retryFromRunId && existing && this.listSteps(existing.id).some(step=>this.outcomes.get(step.id)?.spec.kind==='external')) throw badRequest('此任务含外部操作，请核对原任务，避免重复执行');
      if (retryFromRunId && task.kind === 'once' && existing?.id === retryFromRunId &&
          ['failed','timed_out'].includes(existing.status) && task.status === 'active') {
        return this.instantiateRun({taskId, plannedSlotAt: 'retry:' + existing.id, triggerType:'manual'});
      }
      if (existing) return { run: existing, created: false };
      if (task.status === 'paused') throw badRequest('任务已暂停');
      return this.instantiateRun({ taskId, plannedSlotAt: 'manual:' + randomUUID(), triggerType: 'manual' });
    });
  }

  public setPaused(taskId: string, paused: boolean): TaskRecord {
    const task = this.getTask(taskId);
    if (!task) throw badRequest('任务不存在');
    if (task.status === 'completed' || task.status === 'canceled') return task;
    const runs = this.listRuns(taskId);
    const now = new Date().toISOString();
    this.db.inTransaction(() => {
      this.db.sqlite.prepare("UPDATE v2_tasks SET status=?, schedule_enabled=?, updated_at=? WHERE id=?")
        .run(paused ? 'paused' : 'active', paused ? 0 : 1, now, taskId);
      if (!paused) this.db.sqlite.prepare("UPDATE v2_task_runs SET status='running', updated_at=? WHERE task_id=? AND status='paused'").run(now, taskId);
    });
    for (const run of runs) {
      if (paused ? run.status === 'running' : run.status === 'paused') void this.driveRun(run.id).catch(() => {});
    }
    this.threads.emit({ type: 'task.updated', taskId, threadId: task.sourceThreadId });
    this.threads.emit({ type: 'thread.space_updated', threadId: task.sourceThreadId });
    return this.getTask(taskId)!;
  }

  // Terminal runs are their own durable delivery queue. A paired thread message is the receipt.
  public dispatchPendingReturns(): void {
    const pending = this.db.sqlite.prepare(`SELECT r.id, r.return_member_id, t.requester_member_id, t.title, t.source_thread_id
      FROM v2_task_runs r JOIN v2_tasks t ON t.id=r.task_id JOIN v2_threads th ON th.id=t.source_thread_id
      JOIN v2_members m ON m.id=r.return_member_id
      WHERE r.return_member_id IS NOT NULL AND r.status IN ('completed','failed','timed_out')
        AND th.status='active' AND m.status IN ('ready','busy')
        AND NOT EXISTS (SELECT 1 FROM v2_thread_messages WHERE thread_id=th.id AND client_request_id='task-return:' || r.id)
        AND NOT EXISTS (SELECT 1 FROM v2_thread_messages WHERE thread_id=th.id AND turn_status IN ('running','queued'))
      ORDER BY r.updated_at`).all() as Array<{ id: string; return_member_id: string; requester_member_id: string | null; title: string; source_thread_id: string }>;
    const startedThreads = new Set<string>();
    for (const row of pending) {
      if (startedThreads.has(row.source_thread_id)) continue;
      startedThreads.add(row.source_thread_id);
      const run = this.getRun(row.id)!;
      const artifact = run.finalArtifactId && this.artifacts.getArtifact(run.finalArtifactId);
      const context = [
        '系统交付回执：你是这项任务的发起成员。请在原对话接手，核对交付并完成用户原先授权的剩余工作。',
        '按发起本次委派时的用户请求判断范围。已完成的操作不要重复执行或重新派单。没有剩余授权工作就向用户简短汇报。回执不授权新的发布、发送等外部操作。',
        !row.requester_member_id && '这是补送的历史交付，只核对并回复本次交付结果。不要改动、上传、发布或群发任何内容。',
        '原对话已有执行人的成果。只汇报新核对的结果或剩余工作，不复述已展示的全文。',
        '任务：' + row.title, run.spec?.goal && '原定目标：' + run.spec.goal,
        '有具体文件要求时请打开实际交付资料，核对目录和内容。发现遗漏时按原授权补齐。', '结果：' + run.summary,
        artifact && run.status === 'completed' && '交付文档 ' + artifact.id + '\n' + artifact.content.slice(0, 18000)
      ].filter(Boolean).join('\n');
      void this.threads.receiveTaskResult(row.source_thread_id, row.return_member_id, run.id, context)
        .catch(error => console.warn('Task return dispatch failed', run.id, (error as Error).name));
    }
  }

  /**
   * Drives a `TaskRun` to completion or `waiting_user` / `timed_out` deterministically.
   */
  public async driveRun(runId: string): Promise<TaskRunRecord> {
    while (true) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`运行实例不存在: ${runId}`);
      if (run.status !== 'running') {
        return run;
      }

      const steps = this.listSteps(runId);
      if (this.getTask(run.taskId)?.status === 'paused' && run.deliveryStage === 'steps_running') {
        // Allow acknowledged in-flight work and its review to land before entering the checkpoint.
        if (!steps.some(step => this.activeStepRuns.has(step.id) || step.status === 'running' || (step.status === 'submitted' && this.outcomes.get(step.id)?.state!=='checking'))) {
          this.db.sqlite.prepare("UPDATE v2_task_runs SET status='paused', updated_at=? WHERE id=? AND status='running'").run(new Date().toISOString(), run.id);
          this.threads.emit({ type: 'thread.space_updated', threadId: this.getTask(run.taskId)!.sourceThreadId });
        }
        return this.getRun(runId)!;
      }
      const acceptedIds = new Set(steps.filter((s) => s.status === 'accepted').map((s) => s.id));

      // Check if all steps are accepted -> trigger atomic single finalization!
      if (steps.length > 0 && steps.every((s) => s.status === 'accepted')) {
        await this.tryFinalizeRunOnce(runId);
        return this.getRun(runId)!;
      }

      // Find ready steps: ('pending' or 'changes_requested') whose dependencies are ALL 'accepted'
      const readySteps = steps.filter(
        (s) =>
          (s.status === 'pending' || s.status === 'changes_requested') &&
          !this.activeStepRuns.has(s.id) &&
          s.dependsOnStepIds.every((depId) => acceptedIds.has(depId))
      );

      if (readySteps.length === 0) {
        for (const step of steps.filter(s=>s.status==='submitted')) {
          const state = this.outcomes.get(step.id)?.state;
          if (state === 'manual') {
            this.pauseRunWaitingUser(run.id, this.resolveEffectiveTaskForRun(run)!, '请核对「'+step.title+'」的外部结果');
            return this.getRun(runId)!;
          }
          if (state === 'checking') await this.checkExternal(this.resolveEffectiveTaskForRun(run)!,run,step);
        }
        if (this.listSteps(runId).some((s,i)=>s.status!==steps[i].status)) continue;
        const stillBusy = steps.some((s) => s.status === 'running' || s.status === 'submitted');
        if (stillBusy) {
          return this.getRun(runId)!;
        }
        const effectiveTask = this.resolveEffectiveTaskForRun(run);
        const failedStep = steps.find((s) => s.status === 'failed');
        if (failedStep) {
          const reason = this.stepFailureReasons.get(failedStep.id) || '执行过程中发生错误';
          const summary = `步骤「${failedStep.title}」执行失败：${reason}`;
          this.markRunTerminalFailure(runId, effectiveTask, 'failed', summary);
          return this.getRun(runId)!;
        }
        const timedOut = steps.find((s) => s.status === 'timed_out');
        if (timedOut) {
          const summary = `步骤「${timedOut.title}」执行超时已中止归档，名额已释放`;
          this.markRunTerminalFailure(runId, effectiveTask, 'timed_out', summary);
          return this.getRun(runId)!;
        }
        const unreadySteps = steps.filter((s) => s.status !== 'accepted');
        if (unreadySteps.length > 0) {
          const titles = unreadySteps.map((s) => `#${s.stepOrder}「${s.title}」`).join('、');
          this.markRunTerminalFailure(
            runId,
            effectiveTask,
            'failed',
            `任务步骤前置依赖无法满足，无法继续推进（阻塞步骤：${titles}）`
          );
          return this.getRun(runId)!;
        }
        return this.getRun(runId)!;
      }

      // Execute ready steps concurrently (DriverRegistry serializes fixed-window bots with maxConcurrentRuns=1!)
      await Promise.all(readySteps.map((step) => this.executeAndReviewStep(runId, step.id)));
    }
  }

  private markRunTerminalFailure(
    runId: string,
    task: TaskRecord | null,
    status: 'failed' | 'timed_out',
    summary: string
  ): void {
    const now = new Date().toISOString();
    const res = this.db.sqlite
      .prepare(
        `UPDATE v2_task_runs
         SET status = ?, summary = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`
      )
      .run(status, summary, now, runId);

    if (Number(res.changes) !== 1 || !task) return;

    this.threads.appendSystemMessage({
      threadId: task.sourceThreadId,
      authorKind: 'system_task_card',
      authorId: task.leadMemberId,
      body: `任务《${task.title}》${status === 'timed_out' ? '执行超时' : '执行失败'}：${summary}`,
      taskCard: { taskId: task.id, runId, kind: 'failed' }
    });
    this.threads.emit({
      type: 'task.run_failed',
      taskId: task.id,
      runId,
      threadId: task.sourceThreadId,
      payload: this.getRun(runId)
    });
    this.threads.emit({
      type: 'thread.space_updated',
      threadId: task.sourceThreadId
    });
  }

  private async executeAndReviewStep(runId: string, stepId: string): Promise<void> {
    if (this.activeStepRuns.has(stepId)) return;
    this.activeStepRuns.add(stepId);

    let step: TaskStepRecord | null = null;
    let task: TaskRecord | null = null;
    let workerClaimsToken: string | null = null;

    try {
      step = this.getStep(stepId);
      const run = this.getRun(runId);
      if (!step || !run || run.status !== 'running') return;
      task = this.resolveEffectiveTaskForRun(run);
      const worker = this.db.getMember(step.assigneeMemberId);
      if (!task || !worker) {
        throw new Error(`找不到任务或步骤执行人: ${step.assigneeMemberId}`);
      }

      this.db.sqlite
        .prepare(`UPDATE v2_task_steps SET status = 'running', updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), step.id);
      this.threads.emit({ type: 'task.step_updated', taskId: task.id, runId, payload: this.getStep(step.id) });

      // Prepare optional isolated git worktree for coding steps
      let cwd = path.join(os.tmpdir(), 'duolawork-v2-steps', run.id, step.id);
      let worktreePath = step.worktreePath;
      let worktreeBranch = step.worktreeBranch;

      if (step.useWorktree && task.spec.workspaceRepoPath) {
        const wt = await this.worktrees.ensureStepWorktree({
          repoPath: task.spec.workspaceRepoPath,
          runId: run.id,
          stepId: step.id
        });
        cwd = wt.worktreePath;
        worktreePath = wt.worktreePath;
        worktreeBranch = wt.branchName;
        this.db.sqlite
          .prepare(`UPDATE v2_task_steps SET worktree_path = ?, worktree_branch = ? WHERE id = ?`)
          .run(worktreePath, worktreeBranch, step.id);
      }

      // Build clean, isolated Worker prompt
      const upstreamSummaries = this.collectAcceptedUpstreamOutputs(run.id, step.dependsOnStepIds);
      const lastReview = this.getLatestStepReview(step.id);
      const submissionNumber = step.latestSubmissionVersion + 1;

      const promptLines = [
        `你正在执行任务《${task.title}》的独立分工步骤（第 ${submissionNumber} 版提交）：`,
        `- 委派的总目标（用于理解要求，只执行分配给你的步骤）：${task.spec.goal}`,
        `- 整体验收要求：${task.spec.acceptanceCriteria}`,
        `- 步骤名称：${step.title}`,
        `- 本步要求：${step.brief}`,
        `- 验收标准：${step.acceptanceCriteria}`,
        '请按实际成果提交。交付文件请先保存到约定目录；总目标明确给出完整文本时，在 step_submit_result 的 material 结果中用 expectedText 保留原文供系统读回核对；外部操作请在 step_submit_result 的 outcome 中声明 external，可提供目标资源只读 GET 和预期字段以便系统核对。外部操作结果未知时勿再次执行。无法调用提交工具时，在正文后另起一行用 <duolawork_outcome> 包含同一份 JSON 结果要求，再以 </duolawork_outcome> 结束。',
        ...(this.outcomes.get(step.id) ? ['本步约定的交付要求：'+JSON.stringify(this.outcomes.get(step.id)!.spec)] : [])
      ];
      const linkedMaterialsDigest =
        this.space?.getTaskLinkedMaterialsDigest(task.id, task.sourceThreadId, {
          includeLocalPaths: worker.location === 'local' || worker.location === 'local-node'
        }) ?? '';
      if (linkedMaterialsDigest) {
        promptLines.push(`- 关联协作空间参考材料：\n${linkedMaterialsDigest}`);
      }
      if (upstreamSummaries.length > 0) {
        promptLines.push(`- 上游已通过步骤产物：\n${upstreamSummaries.join('\n')}`);
      }
      if (lastReview && lastReview.verdict === 'changes_requested') {
        promptLines.push(`- 负责人打回修改意见（请针对性修正后重新提交）：${lastReview.comments}`);
      }
      if (worker.driverKind === 'remote-bridge' || worker.location === 'remote-bridge') {
        promptLines.push(
          `注意：你在 DuolaWork 2.0 独立任务执行通道中，请直接输出完整最终交付正文（严禁调用旧版 Agent Hub 的 board_task 或 schedule 工具）。`
        );
      }
      promptLines.push(
        `\n完成后请直接输出本步完整交付内容（若挂载了 step_submit_result 工具也可直接调用提交；若遇到需求缺失无法继续，请输出 <duolawork_blocked>具体阻塞问题</duolawork_blocked>）。`
      );

      const attemptId = 'att_' + randomUUID().slice(0, 12);
      const workerClaims = this.sandbox.issueScopedToken({
        principalKind: 'task_worker',
        memberId: worker.id,
        attemptId,
        threadId: task.sourceThreadId,
        taskId: task.id,
        runId: run.id,
        stepId: step.id,
        allowedArtifactIds: run.finalArtifactId ? [run.finalArtifactId] : [],
        toolPolicy: step.toolPolicy
      });
      workerClaimsToken = workerClaims.token;

      let explicitSubmission = null as {
        summary: string;
        content: string;
        status: 'submitted' | 'blocked';
      } | null;
      const workerTools: DynamicToolDefinition[] = [
        {
          name: 'step_submit_result',
          description: '提交当前任务步骤的交付成果或上报阻塞问题。',
          inputSchema: {
            type: 'object',
            properties: {
              outcome: outcomeSchema,
              summary: { type: 'string' },
              content: { type: 'string' },
              status: { type: 'string', enum: ['submitted', 'blocked'] }
            },
            required: ['summary', 'content'],
            additionalProperties: false
          }
        },
        ...(step.toolPolicy !== 'none' && this.scopedToolExecutor ? SPACE_AND_DUOLABASE_TOOLS : [])
      ];

      if (this.getRun(runId)?.status === 'canceled' || this.getStep(step.id)?.status === 'canceled') {
        return;
      }

      const { result } = await this.registry.dispatchTurn({
        attemptId,
        idempotencyKey: `step_exec:${step.id}:v${submissionNumber}`,
        targetKind: 'task_step',
        targetId: step.id,
        threadId: task.sourceThreadId,
        taskId: task.id,
        runId: run.id,
        stepId: step.id,
        member: worker,
        scopeKey: step.isolatedSessionKey,
        cwd,
        existingNativeSessionId: step.nativeSessionId ?? this.scopeNativeSession.get(step.isolatedSessionKey) ?? null,
        existingBridgeMeta: this.scopeBridgeMeta.get(step.isolatedSessionKey) ?? null,
        baseArtifactId: run.finalArtifactId,
        baseArtifactVersion: run.finalArtifactId ? this.artifacts.getArtifact(run.finalArtifactId)?.headVersion ?? null : null,
        prompt: promptLines.join('\n'),
        timeoutMs: task.spec.stepTimeoutMs,
        toolPolicy: step.toolPolicy,
        dynamicTools: workerTools,
        onToolCall: async (toolName, args) => {
          if (toolName === 'step_submit_result') {
            this.sandbox.assertWorkerStepPermission(workerClaims, run.id, step!.id);
            this.outcomes.declare(step!.id,parseOutcome(args.outcome));
            explicitSubmission = {
              summary: String(args.summary || step!.title),
              content: String(args.content || ''),
              status: args.status === 'blocked' ? 'blocked' : 'submitted'
            };
            return { ok: true, recordedVersion: submissionNumber };
          }
          if (
            this.scopedToolExecutor &&
            (SPACE_TOOL_NAMES.has(toolName) || toolName.startsWith('duolabase:'))
          ) {
            return this.scopedToolExecutor(workerClaims, toolName, args);
          }
          throw new Error(`执行人未授权调用工具: ${toolName}`);
        }
      });

      // Respect mid-flight cancellation
      if (this.getRun(runId)?.status === 'canceled' || this.getStep(step.id)?.status === 'canceled') {
        return;
      }

      this.scopeNativeSession.set(step.isolatedSessionKey, result.nativeSessionId);
      if (result.bridgeMeta) {
        this.scopeBridgeMeta.set(step.isolatedSessionKey, result.bridgeMeta);
      }
      this.db.sqlite
        .prepare(`UPDATE v2_task_steps SET native_session_id = ? WHERE id = ?`)
        .run(result.nativeSessionId, step.id);

      const submitted=splitSubmittedOutcome(result.text);
      this.outcomes.declare(step.id,submitted.outcome);
      const blockedMatch = submitted.text.match(/<duolawork_blocked>([\s\S]*?)<\/duolawork_blocked>/);
      const subStatus: 'submitted' | 'blocked' =
        explicitSubmission?.status ?? (blockedMatch ? 'blocked' : 'submitted');
      const subContent =
        explicitSubmission !== null
          ? explicitSubmission.content
          : blockedMatch
            ? blockedMatch[1].trim()
            : submitted.text;
      const cleanedDeliverable = cleanDeliverableText(subContent);

      let commitSha: string | null = null;
      if (worktreePath && subStatus === 'submitted') {
        commitSha = await this.worktrees.commitStepChangesIfNeeded(
          worktreePath,
          `step(${step.stepOrder}): ${step.title} v${submissionNumber}`,
          run.id
        );
      }

      if (this.getRun(runId)?.status === 'canceled' || this.getStep(step.id)?.status === 'canceled') {
        return;
      }

      const subSummary =
        explicitSubmission?.summary?.trim() ||
        cleanedDeliverable.slice(0, 180) ||
        (commitSha ? `代码变更提交 (${commitSha.slice(0, 8)})` : '') ||
        (subStatus === 'blocked' ? subContent.slice(0, 180) : '（未提交有效正文）');

      const submission = this.recordSubmission({
        stepId: step.id,
        runId: run.id,
        version: submissionNumber,
        assigneeMemberId: worker.id,
        attemptId,
        summary: subSummary,
        content: subContent,
        commitSha,
        status: subStatus
      });

      if (subStatus === 'blocked') {
        this.pauseRunWaitingUser(run.id, task, `步骤「${step.title}」需要确认：${subContent || '缺少必要信息'}`);
        return;
      }

      if (cleanedDeliverable.length === 0 && !commitSha) {
        this.applyReviewDecision(
          task,
          run,
          this.getStep(step.id)!,
          submission,
          'changes_requested',
          '执行人提交的正文为空，未生成有效交付成果，请输出完整成果后重新提交',
          attemptId
        );
        return;
      }

      // Single-step solo task owned & executed by the same member: auto-accept cleanly when deliverable is non-empty!
      const allRunSteps = this.listSteps(run.id);
      if (allRunSteps.length === 1 && step.assigneeMemberId === task.leadMemberId) {
        this.applyReviewDecision(
          task,
          run,
          this.getStep(step.id)!,
          submission,
          'accept',
          '负责人独立执行完成，自动验收交付',
          attemptId
        );
        return;
      }

      // Automatically wake pinned `task.leadMemberId` in per-run `task.leadSessionKey` to review!
      await this.runLeadStepReview(task, run, this.getStep(step.id)!, submission);
    } catch (err) {
      const msg = (err as Error).message || '执行发生未知错误';
      const curRun = this.getRun(runId);
      const curStep = step ? this.getStep(step.id) : this.getStep(stepId);
      if (curRun?.status === 'canceled' || curStep?.status === 'canceled') {
        return;
      }
      if (curStep && task) {
        if (curRun && this.recoverUncertainExternal(task,curRun,curStep)) return;
        if (msg.includes('ATTEMPT_TIMED_OUT')) {
          this.db.sqlite
            .prepare(`UPDATE v2_task_steps SET status = 'timed_out', updated_at = ? WHERE id = ?`)
            .run(new Date().toISOString(), curStep.id);
        } else {
          this.stepFailureReasons.set(curStep.id, msg);
          this.db.sqlite
            .prepare(`UPDATE v2_task_steps SET status = 'failed', updated_at = ? WHERE id = ?`)
            .run(new Date().toISOString(), curStep.id);
        }
        this.threads.emit({
          type: 'task.step_updated',
          taskId: task.id,
          runId,
          payload: this.getStep(curStep.id)
        });
      }
    } finally {
      if (workerClaimsToken) {
        this.sandbox.revokeToken(workerClaimsToken);
      }
      this.activeStepRuns.delete(stepId);
    }
  }

  private recoverUncertainExternal(task: TaskRecord, run: TaskRunRecord, step: TaskStepRecord): boolean {
    const outcome = this.outcomes.get(step.id);
    if (outcome?.spec.kind !== 'external' || run.status !== 'running') return false;
    this.db.inTransaction(() => {
      if (!this.getLatestStepSubmission(step.id)) {
        this.recordSubmission({
          stepId: step.id,
          runId: run.id,
          version: step.latestSubmissionVersion + 1,
          assigneeMemberId: step.assigneeMemberId,
          attemptId: null,
          summary: '执行回执中断',
          content: '执行回执中断，正在核对原操作的结果。',
          commitSha: null,
          status: 'submitted'
        });
      }
      this.db.sqlite.prepare("UPDATE v2_task_steps SET status='submitted' WHERE id=?").run(step.id);
      this.db.sqlite
        .prepare("UPDATE v2_step_outcomes SET state='checking' WHERE step_id=? AND state='open'")
        .run(step.id);
    });
    this.threads.emit({
      type: 'task.step_updated',
      taskId: task.id,
      runId: run.id,
      threadId: task.sourceThreadId
    });
    return true;
  }

  private async checkExternal(task: TaskRecord, run: TaskRunRecord, step: TaskStepRecord): Promise<void> {
    const outcome = this.outcomes.get(step.id);
    if (
      outcome?.state !== 'checking' ||
      outcome.spec.kind !== 'external' ||
      outcome.next_check_at > Date.now() ||
      this.checking.has(step.id)
    )
      return;
    const sub = this.getLatestStepSubmission(step.id);
    if (!sub) return;
    this.checking.add(step.id);
    try {
      const probe = outcome.spec.readback;
      let confirmed = false;
      if (probe && this.scopedToolExecutor && step.toolPolicy !== 'none') {
        const claims = this.sandbox.issueScopedToken({
          principalKind: 'task_worker',
          memberId: step.assigneeMemberId,
          attemptId: 'verify_' + step.id,
          threadId: task.sourceThreadId,
          taskId: task.id,
          runId: run.id,
          stepId: step.id,
          allowedArtifactIds: [],
          toolPolicy: 'duolabase_readonly'
        });
        try {
          const raw = await this.scopedToolExecutor(claims, 'duolabase:vault_http_proxy', {
            credentialId: probe.credentialId,
            url: probe.url,
            method: 'GET'
          });
          confirmed = matchesReadback(raw, probe);
        } catch {
          /* The target may be offline or eventually consistent. Only repeat the read. */
        } finally {
          this.sandbox.revokeToken(claims.token);
        }
      }
      if (
        this.getRun(run.id)?.status !== 'running' ||
        this.outcomes.get(step.id)?.state !== 'checking' ||
        this.getTask(task.id)?.status === 'paused'
      )
        return;
      this.db.inTransaction(() => {
        if (confirmed) {
          this.db.sqlite.prepare("UPDATE v2_step_outcomes SET state='verified' WHERE step_id=?").run(step.id);
          this.finishExternalReview(task, run, step, sub, '已读回目标结果');
        } else if (!probe || step.toolPolicy === 'none' || outcome.checks >= 3) {
          this.db.sqlite.prepare("UPDATE v2_step_outcomes SET state='manual' WHERE step_id=?").run(step.id);
          this.pauseRunWaitingUser(
            run.id,
            task,
            '「' + step.title + '」的外部结果尚未核实。可在目标系统核对后确认，原操作不会重复提交。'
          );
        } else {
          this.db.sqlite
            .prepare('UPDATE v2_step_outcomes SET checks=checks+1,next_check_at=? WHERE step_id=?')
            .run(Date.now() + [5000, 15000, 60000][outcome.checks], step.id);
        }
      });
    } finally {
      this.checking.delete(step.id);
    }
  }

  private finishExternalReview(
    task: TaskRecord,
    run: TaskRunRecord,
    step: TaskStepRecord,
    sub: StepSubmissionRecord,
    reason: string
  ) {
    if (sub.attemptId === null && sub.summary === '执行回执中断') {
      const content = reason + '：' + step.title;
      this.db.sqlite
        .prepare('UPDATE v2_step_submissions SET summary=?,content=? WHERE id=?')
        .run(content, content, sub.id);
      sub = { ...sub, summary: content, content };
    }
    this.applyReviewDecision(task, run, step, sub, 'accept', reason, null);
  }

  public async resolveExternalCheck(runId: string, stepId: string, confirmedByUser: boolean) {
    const run = this.getRun(runId),
      step = this.getStep(stepId),
      outcome = this.outcomes.get(stepId);
    if (!run || !step || step.runId !== run.id || run.status !== 'waiting_user' || outcome?.state !== 'manual')
      throw badRequest('此步骤当前无需人工核对');
    const task = this.resolveEffectiveTaskForRun(run)!;
    const sub = this.getLatestStepSubmission(step.id);
    if (!sub || (!confirmedByUser && (outcome.spec.kind !== 'external' || !outcome.spec.readback)))
      throw badRequest('没有可自动核对的目标');
    this.db.inTransaction(() => {
      this.db.sqlite
        .prepare('UPDATE v2_step_outcomes SET state=?,checks=0,next_check_at=0 WHERE step_id=?')
        .run(confirmedByUser ? 'attested' : 'checking', step.id);
      this.db.sqlite
        .prepare("UPDATE v2_task_runs SET status='running',waiting_question=NULL WHERE id=?")
        .run(runId);
      if (confirmedByUser) this.finishExternalReview(task, run, step, sub, '用户已核实外部结果');
    });
    this.threads.emit({ type: 'task.step_updated', taskId: task.id, runId, threadId: task.sourceThreadId });
    return this.driveRun(runId);
  }

  private async runLeadStepReview(
    task: TaskRecord,
    run: TaskRunRecord,
    step: TaskStepRecord,
    submission: StepSubmissionRecord
  ): Promise<void> {
    const lead = this.db.getMember(task.leadMemberId)!;
    const attemptId = 'att_' + randomUUID().slice(0, 12);
    const leadClaims = this.sandbox.issueScopedToken({
      principalKind: 'task_lead',
      memberId: lead.id,
      attemptId,
      threadId: task.sourceThreadId,
      taskId: task.id,
      runId: run.id,
      allowedArtifactIds: run.finalArtifactId ? [run.finalArtifactId] : [],
      toolPolicy: task.toolPolicy
    });

    const reviewPrompt = [
      `你是任务《${task.title}》的负责人，请核验以下执行步骤提交（第 ${submission.version} 版）：`,
      `- 步骤：${step.title}`,
      `- 委派总目标：${task.spec.goal}。整体验收要求：${task.spec.acceptanceCriteria}`,
      `- 原定验收标准：${step.acceptanceCriteria}`,
      `- 执行人提交内容：\n${submission.content}`,
      `\n请严格只输出一段 JSON 裁决：{"verdict":"accept"|"changes_requested"|"ask_user","comments":"具体核验意见或需向用户确认的问题"}`
    ].join('\n');

    let explicitVerdict = null as {
      verdict: StepReviewRecord['verdict'];
      comments: string;
    } | null;
    const leadTools: DynamicToolDefinition[] = [
      {
        name: 'task_review_step',
        description: '对执行人提交的步骤成果给出验收通过、打回修改或请示用户的裁决。',
        inputSchema: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['accept', 'changes_requested', 'ask_user'] },
            comments: { type: 'string' }
          },
          required: ['verdict', 'comments'],
          additionalProperties: false
        }
      }
    ];

    try {
      if (this.getRun(run.id)?.status === 'canceled' || this.getStep(step.id)?.status === 'canceled') {
        return;
      }

      const { result } = await this.registry.dispatchTurn({
        attemptId,
        idempotencyKey: `lead_review:${step.id}:v${submission.version}`,
        targetKind: 'lead_review',
        targetId: submission.id,
        threadId: task.sourceThreadId,
        taskId: task.id,
        runId: run.id,
        stepId: step.id,
        member: lead,
        scopeKey: task.leadSessionKey,
        cwd: path.join(os.tmpdir(), 'duolawork-v2-leads', task.id, run.id),
        existingNativeSessionId: this.scopeNativeSession.get(task.leadSessionKey) ?? null,
        existingBridgeMeta: this.scopeBridgeMeta.get(task.leadSessionKey) ?? null,
        prompt: reviewPrompt,
        timeoutMs: task.spec.stepTimeoutMs,
        dynamicTools: leadTools,
        onToolCall: async (toolName, args) => {
          if (toolName === 'task_review_step') {
            this.sandbox.assertLeadPermission(leadClaims, task.id, run.id);
            const rawVerdict = String(args.verdict || '');
            if (rawVerdict !== 'accept' && rawVerdict !== 'changes_requested' && rawVerdict !== 'ask_user') {
              throw new Error(`无效的验收裁决类型: ${rawVerdict}`);
            }
            explicitVerdict = normalizeLeadVerdict(rawVerdict, String(args.comments || ''));
            return { ok: true };
          }
          throw new Error(`未知负责人核验工具: ${toolName}`);
        }
      });

      if (this.getRun(run.id)?.status === 'canceled' || this.getStep(step.id)?.status === 'canceled') {
        return;
      }

      this.scopeNativeSession.set(task.leadSessionKey, result.nativeSessionId);
      if (result.bridgeMeta) {
        this.scopeBridgeMeta.set(task.leadSessionKey, result.bridgeMeta);
      }

      const parsed = explicitVerdict ?? parseLeadReviewJson(result.text);
      this.applyReviewDecision(task, run, step, submission, parsed.verdict, parsed.comments, attemptId);
    } catch (err) {
      const msg = (err as Error).message || '核验失败';
      if (this.getRun(run.id)?.status === 'canceled' || this.getStep(step.id)?.status === 'canceled') {
        return;
      }
      if (msg.includes('ATTEMPT_TIMED_OUT')) {
        this.db.sqlite
          .prepare(`UPDATE v2_task_steps SET status = 'timed_out', updated_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), step.id);
      } else {
        this.stepFailureReasons.set(step.id, `负责人核验失败：${msg}`);
        this.db.sqlite
          .prepare(`UPDATE v2_task_steps SET status = 'failed', updated_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), step.id);
      }
      this.threads.emit({
        type: 'task.step_updated',
        taskId: task.id,
        runId: run.id,
        payload: this.getStep(step.id)
      });
    } finally {
      this.sandbox.revokeToken(leadClaims.token);
    }
  }

  public applyReviewDecision(
    task: TaskRecord,
    run: TaskRunRecord,
    step: TaskStepRecord,
    submission: StepSubmissionRecord,
    verdict: StepReviewRecord['verdict'],
    comments: string,
    attemptId: string | null = null
  ): StepReviewRecord | null {
    const effectiveTask = this.resolveEffectiveTaskForRun(run) ?? task;
    let effectiveVerdict = verdict;
    let effectiveComments = comments;
    const outcome=this.outcomes.get(step.id);
    if (outcome?.spec.kind==='external' && !['verified','attested'].includes(outcome.state) && verdict==='accept') {
      // Even a revision request must not repeat an external operation with an unknown result.
      this.db.sqlite.prepare("UPDATE v2_step_outcomes SET state='checking' WHERE step_id=? AND state='open'").run(step.id);
      return null;
    }
    if (outcome?.spec.kind==='external' && verdict==='changes_requested') {
      effectiveVerdict='ask_user';
      effectiveComments='外部操作已提交，负责人要求复核：'+comments;
    }
    if (effectiveVerdict==='accept' && outcome?.spec.kind==='material') {
      const receipt=this.outcomes.material(step.id,task.sourceThreadId,outcome.spec,this.space);
      if (receipt) {
        this.db.sqlite.prepare("UPDATE v2_step_outcomes SET state='verified',verified_resource_id=? WHERE step_id=?").run(receipt.id,step.id);
        effectiveComments='已核对本步保存的资料：'+receipt.name;
      } else {
        effectiveVerdict='changes_requested';
        effectiveComments='「'+outcome.spec.name+'」尚未符合交付要求。请核对名称、目录和约定的内容，重新保存后提交。';
      }
    }
    if (outcome?.spec.kind==='external' && verdict==='accept') effectiveComments=outcome.state==='attested'?'用户已核实外部结果':'已从外部系统读回目标结果';
    if (
      effectiveVerdict === 'accept' &&
      (!outcome || outcome.spec.kind === 'reply') &&
      cleanDeliverableText(submission.content).length === 0 &&
      !submission.commitSha
    ) {
      effectiveVerdict = 'ask_user';
      effectiveComments = '执行提交正文为空，无法自动登记为验收通过，请人工核验确认';
    }

    return this.db.inTransaction(() => {
      const revId = 'rev_' + randomUUID().slice(0, 12);
      const now = new Date().toISOString();
      this.db.sqlite
        .prepare(
          `INSERT INTO v2_step_reviews (
            id, step_id, run_id, submission_version, lead_member_id, attempt_id, verdict, comments, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          revId,
          step.id,
          run.id,
          submission.version,
          effectiveTask.leadMemberId,
          attemptId,
          effectiveVerdict,
          effectiveComments,
          now
        );

      if (effectiveVerdict === 'accept') {
        this.db.sqlite
          .prepare(`UPDATE v2_task_steps SET status = 'accepted', updated_at = ? WHERE id = ?`)
          .run(now, step.id);
      } else if (effectiveVerdict === 'ask_user') {
        this.db.sqlite
          .prepare(`UPDATE v2_task_steps SET status = 'blocked', updated_at = ? WHERE id = ?`)
          .run(now, step.id);
        this.pauseRunWaitingUser(run.id, effectiveTask, effectiveComments);
      } else {
        const nextRound = step.reviewRound + 1;
        if (nextRound >= effectiveTask.spec.maxReviewRounds) {
          this.db.sqlite
            .prepare(
              `UPDATE v2_task_steps SET status = 'blocked', review_round = ?, updated_at = ? WHERE id = ?`
            )
            .run(nextRound, now, step.id);
          this.pauseRunWaitingUser(
            run.id,
            effectiveTask,
            `步骤「${step.title}」连续修改 ${nextRound} 轮仍未达标，请确认下一步处理意见：${effectiveComments}`
          );
        } else {
          this.db.sqlite
            .prepare(
              `UPDATE v2_task_steps SET status = 'changes_requested', review_round = ?, updated_at = ? WHERE id = ?`
            )
            .run(nextRound, now, step.id);
        }
      }

      this.threads.emit({
        type: 'task.step_reviewed',
        taskId: effectiveTask.id,
        runId: run.id,
        payload: { step: this.getStep(step.id), verdict: effectiveVerdict, comments: effectiveComments }
      });

      const row = this.db.sqlite
        .prepare(`SELECT * FROM v2_step_reviews WHERE id = ?`)
        .get(revId) as Record<string, unknown>;
      return mapReviewRow(row);
    });
  }

  /**
   * Atomic CAS finalization: even when two parallel steps finish simultaneously,
   * ONLY the single caller transitioning `delivery_stage: 'steps_running' -> 'lead_final_review'`
   * merges worktrees, writes final summary, and posts the SINGLE delivery card back to `sourceThreadId`!
   */
  private async tryFinalizeRunOnce(runId: string): Promise<void> {
    const claimed = this.db.inTransaction(() => {
      const res = this.db.sqlite
        .prepare(
          `UPDATE v2_task_runs
           SET delivery_stage = 'lead_final_review', updated_at = ?
           WHERE id = ? AND status = 'running' AND delivery_stage = 'steps_running'`
        )
        .run(new Date().toISOString(), runId);
      return Number(res.changes) === 1;
    });

    if (!claimed) {
      return; // Another concurrent finisher already claimed finalization!
    }

    this.activeFinalizations.add(runId);
    const run = this.getRun(runId)!;
    const task = this.resolveEffectiveTaskForRun(run)!;
    const steps = this.listSteps(runId);

    try {
      const emptyStep = steps.find((s) => {
        const sub = this.getLatestStepSubmission(s.id);
        return !sub || (cleanDeliverableText(sub.content).length === 0 && !sub.commitSha);
      });
      if (emptyStep) {
        const now = new Date().toISOString();
        this.db.sqlite
          .prepare(`UPDATE v2_task_steps SET status = 'blocked', updated_at = ? WHERE id = ?`)
          .run(now, emptyStep.id);
        this.db.sqlite
          .prepare(`UPDATE v2_task_runs SET delivery_stage = 'steps_running', updated_at = ? WHERE id = ?`)
          .run(now, run.id);
        this.pauseRunWaitingUser(
          run.id,
          task,
          `步骤「${emptyStep.title}」缺少有效交付正文，请核验或补充后继续`
        );
        return;
      }
      // 1. If any coding steps used isolated git worktrees, merge them into Run integration branch & verify!
      const worktreeBranches = steps
        .filter((s) => s.useWorktree && s.worktreeBranch)
        .map((s) => s.worktreeBranch!);

      let integrationNote = '';
      if (worktreeBranches.length > 0 && task.spec.workspaceRepoPath) {
        const merged = await this.worktrees.mergeAndVerifyIntegration({
          repoPath: task.spec.workspaceRepoPath,
          runId: run.id,
          stepBranches: worktreeBranches,
          testCommand: task.spec.integrationTestCommand
        });
        this.db.sqlite
          .prepare(
            `UPDATE v2_task_runs SET integration_worktree_path = ?, integration_branch = ? WHERE id = ?`
          )
          .run(merged.integrationPath, merged.integrationBranch, run.id);
        integrationNote = `\n\n## 代码集成分支校验\n- 集成分支：\`${merged.integrationBranch}\` (\`${merged.headSha.slice(0, 8)}\`)\n- 合并步骤分支：${merged.mergedStepBranches.join(', ')}${merged.testOutput ? `\n- 集成测试输出：\`${merged.testOutput.slice(0, 300)}\`` : ''}`;
      }

      // 2. Assemble verified deliverables from all accepted steps into Run artifact
      const sectionBlocks = steps.map((s) => {
        const sub = this.getLatestStepSubmission(s.id);
        const rev = this.getLatestStepReview(s.id);
        const workerName = this.db.getMember(s.assigneeMemberId)?.name || s.assigneeMemberId;
        const cleanBody =
          cleanDeliverableText(sub?.content || '') ||
          (sub?.commitSha ? `已提交代码变更（commit: \`${sub.commitSha.slice(0, 8)}\`）` : '');
        return `## ${s.stepOrder}. ${s.title}（${workerName}）\n${cleanBody}\n\n> 验收结论：${rev?.comments || '核验通过'}`;
      });

      const leadName = this.db.getMember(task.leadMemberId)?.name || task.leadMemberId;
      const fullDeliverable =
        `# ${task.title}${task.kind === 'scheduled' ? ` · 第 ${run.runNumber} 期` : ''}\n\n` +
        `负责人：${leadName}\n\n` +
        sectionBlocks.join('\n\n---\n\n') +
        integrationNote +
        '\n';

      const progress=this.outcomes.progress(run.id);
      const outcomeLabel=deliveryLabel(progress);
      const material=progress.find(s=>s.material)?.material;
      const summaryLine =
        task.kind === 'scheduled'
          ? `《${task.title}》第 ${run.runNumber} 期：${outcomeLabel}。`
          : `任务《${task.title}》：${outcomeLabel}。`;

      const now = new Date().toISOString();
      this.db.inTransaction(() => {
        if (run.finalArtifactId) {
          const curArt = this.artifacts.getArtifact(run.finalArtifactId);
          if (curArt) {
            this.artifacts.writeArtifact({
              artifactId: curArt.id,
              expectedBaseVersion: curArt.headVersion,
              content: fullDeliverable,
              writerKind: 'agent',
              writerId: task.leadMemberId
            });
          }
        }
        this.db.sqlite
          .prepare(
            `UPDATE v2_task_runs
             SET status = 'completed', delivery_stage = 'delivered', summary = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(summaryLine, now, run.id);

        if (task.kind === 'once') {
          this.db.sqlite
            .prepare(`UPDATE v2_tasks SET status = 'completed', updated_at = ? WHERE id = ?`)
            .run(now, task.id);
        }
        // Solo/single-owner deliveries also push complete content directly as an agent message in the thread!
        if (steps.length === 1 && steps[0].assigneeMemberId === task.leadMemberId) {
          const directBody = cleanDeliverableText(this.getLatestStepSubmission(steps[0].id)?.content || '');
          if (directBody) {
            this.threads.appendSystemMessage({
              threadId: task.sourceThreadId,
              authorKind: 'agent',
              authorId: task.leadMemberId,
              body: directBody,
              artifactRefs: run.finalArtifactId ? [run.finalArtifactId] : []
            });
          }
        }

        // Post strictly ONE clean delivery card back to the origin conversation!
        this.threads.appendSystemMessage({
          threadId: task.sourceThreadId,
          authorKind: 'system_task_card',
          authorId: task.leadMemberId,
          body: summaryLine,
          artifactRefs: run.finalArtifactId ? [run.finalArtifactId] : [],
          taskCard: { taskId: task.id, runId: run.id, kind: 'delivered', outcomeLabel, material }
        });

      });
      this.threads.emit({
        type: 'task.run_delivered',
        taskId: task.id,
        runId: run.id,
        threadId: task.sourceThreadId,
        payload: this.getRun(run.id)
      });
      this.threads.emit({
        type: 'thread.space_updated',
        threadId: task.sourceThreadId
      });
      this.dispatchPendingReturns();
      this.disposeStepScopesForRun(steps, task.leadSessionKey, task.leadMemberId);
    } catch (err) {
      if (this.getRun(run.id)?.status === 'canceled') {
        return;
      }
      const msg = (err as Error).message || '最终集成交付失败';
      this.markRunTerminalFailure(run.id, task, 'failed', `交付验收阶段失败：${msg}`);
    } finally {
      this.activeFinalizations.delete(runId);
    }
  }

  private pauseRunWaitingUser(runId: string, task: TaskRecord, question: string): void {
    const now = new Date().toISOString();
    this.db.sqlite
      .prepare(
        `UPDATE v2_task_runs SET status = 'waiting_user', waiting_question = ?, updated_at = ? WHERE id = ?`
      )
      .run(question, now, runId);

    this.threads.appendSystemMessage({
      threadId: task.sourceThreadId,
      authorKind: 'system_task_card',
      authorId: task.leadMemberId,
      body: `任务《${task.title}》等待你的确认：${question}`,
      taskCard: { taskId: task.id, runId, kind: 'waiting_user' }
    });

    this.threads.emit({
      type: 'task.waiting_user',
      taskId: task.id,
      runId,
      threadId: task.sourceThreadId,
      payload: this.getRun(runId)
    });
  }

  /**
   * Routes a user's clarification on a `waiting_user` task card directly back to `task.leadMemberId`
   * and resumes the blocked step/run — even if `sourceThread.activeOwnerMemberId` was switched to someone else!
   */
  public async resumeWaitingRunWithUserReply(input: {
    runId: string;
    userReply: string;
  }): Promise<TaskRunRecord> {
    const run = this.getRun(input.runId);
    if (!run) throw new Error(`运行实例不存在: ${input.runId}`);
    if (this.listSteps(run.id).some(s=>this.outcomes.get(s.id)?.state==='manual')) throw badRequest('请先核对待确认的外部结果');
    if (run.status !== 'waiting_user') {
      throw new Error(`当前运行实例不在等待确认状态 (${run.status})`);
    }
    const task = this.resolveEffectiveTaskForRun(run)!;
    const now = new Date().toISOString();

    this.db.inTransaction(() => {
      const blockedSteps = this.listSteps(run.id).filter((s) => s.status === 'blocked');
      for (const bs of blockedSteps) {
        const updatedBrief = `${bs.brief}\n\n[用户补充确认 (${now})]: ${input.userReply.trim()}`;
        this.db.sqlite
          .prepare(
            `UPDATE v2_task_steps
             SET status = 'changes_requested', review_round = 0, brief = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(updatedBrief, now, bs.id);
      }
      this.db.sqlite
        .prepare(
          `UPDATE v2_task_runs SET status = 'running', waiting_question = NULL, updated_at = ? WHERE id = ?`
        )
        .run(now, run.id);
    });

    return this.driveRun(run.id);
  }

  private recordSubmission(input: {
    stepId: string;
    runId: string;
    version: number;
    assigneeMemberId: string;
    attemptId: string | null;
    summary: string;
    content: string;
    commitSha: string | null;
    status: 'submitted' | 'blocked';
  }): StepSubmissionRecord {
    return this.db.inTransaction(() => {
      const id = 'sub_' + randomUUID().slice(0, 12);
      const now = new Date().toISOString();
      this.db.sqlite
        .prepare(
          `INSERT INTO v2_step_submissions (
            id, step_id, run_id, version, assignee_member_id, attempt_id,
            summary, content, artifact_id, artifact_version, commit_sha, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
        )
        .run(
          id,
          input.stepId,
          input.runId,
          input.version,
          input.assigneeMemberId,
          input.attemptId,
          input.summary,
          input.content,
          input.commitSha,
          input.status,
          now
        );

      this.db.sqlite
        .prepare(
          `UPDATE v2_task_steps
           SET status = ?, latest_submission_version = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(input.status, input.version, now, input.stepId);

      const row = this.db.sqlite
        .prepare(`SELECT * FROM v2_step_submissions WHERE id = ?`)
        .get(id) as Record<string, unknown>;
      return mapSubmissionRow(row);
    });
  }

  private collectAcceptedUpstreamOutputs(runId: string, depStepIds: string[]): string[] {
    if (depStepIds.length === 0) return [];
    const out: string[] = [];
    for (const sid of depStepIds) {
      const st = this.getStep(sid);
      const sub = this.getLatestStepSubmission(sid);
      if (st && sub && st.runId === runId) {
        out.push(`  • [${st.title}]: ${sub.content.slice(0, 1500)}`);
      }
    }
    return out;
  }

  public getTask(id: string): TaskRecord | null {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM v2_tasks WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapTaskRow(row) : null;
  }

  public listTasks(filter?: { sourceThreadId?: string; kind?: TaskKind }): TaskRecord[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter?.sourceThreadId) {
      clauses.push('source_thread_id = ?');
      args.push(filter.sourceThreadId);
    }
    if (filter?.kind) {
      clauses.push('kind = ?');
      args.push(filter.kind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.sqlite
      .prepare(`SELECT * FROM v2_tasks ${where} ORDER BY updated_at DESC`)
      .all(...args) as Record<string, unknown>[];
    return rows.map(mapTaskRow);
  }

  public getRun(id: string): TaskRunRecord | null {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM v2_task_runs WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapRunRow(row) : null;
  }

  public listRuns(taskId: string, latestOnly = false): TaskRunRecord[] {
    const rows = this.db.sqlite
      .prepare(`SELECT r.*, reply.turn_status AS return_turn_status FROM v2_task_runs r
        JOIN v2_tasks t ON t.id=r.task_id
        LEFT JOIN v2_thread_messages receipt ON receipt.thread_id=t.source_thread_id AND receipt.client_request_id='task-return:'||r.id
        LEFT JOIN v2_thread_messages reply ON reply.id=receipt.paired_message_id
        WHERE r.task_id = ? ORDER BY r.run_number DESC ${latestOnly ? 'LIMIT 1' : ''}`)
      .all(taskId) as Record<string, unknown>[];
    return rows.map(row=>({...mapRunRow(row),progress:this.outcomes.progress(String(row.id))}));
  }

  public getStep(id: string): TaskStepRecord | null {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM v2_task_steps WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapStepRow(row) : null;
  }

  public listSteps(runId: string): TaskStepRecord[] {
    const rows = this.db.sqlite
      .prepare(`SELECT * FROM v2_task_steps WHERE run_id = ? ORDER BY step_order ASC`)
      .all(runId) as Record<string, unknown>[];
    return rows.map(mapStepRow);
  }

  public listSubmissions(stepId: string): StepSubmissionRecord[] {
    const rows = this.db.sqlite
      .prepare(`SELECT * FROM v2_step_submissions WHERE step_id = ? ORDER BY version DESC`)
      .all(stepId) as Record<string, unknown>[];
    return rows.map(mapSubmissionRow);
  }

  public listReviews(stepId: string): StepReviewRecord[] {
    const rows = this.db.sqlite
      .prepare(`SELECT * FROM v2_step_reviews WHERE step_id = ? ORDER BY submission_version DESC`)
      .all(stepId) as Record<string, unknown>[];
    return rows.map(mapReviewRow);
  }

  public getLatestStepSubmission(stepId: string): StepSubmissionRecord | null {
    return this.listSubmissions(stepId)[0] ?? null;
  }

  public getLatestStepReview(stepId: string): StepReviewRecord | null {
    return this.listReviews(stepId)[0] ?? null;
  }

  public getActiveTasksSummaryForThread(threadId: string): string[] {
    const tasks = this.listTasks({ sourceThreadId: threadId });
    return tasks.map((t) => {
      const latestRun = this.listRuns(t.id, true)[0];
      const leadName = this.db.getMember(t.leadMemberId)?.name || t.leadMemberId;
      return `- 任务《${t.title}》(${t.kind === 'scheduled' ? '定时' : '单次'}, 负责人:${leadName}) 状态=${latestRun?.status ?? t.status}${latestRun?.waitingQuestion ? ` 待确认:${latestRun.waitingQuestion}` : ''}`;
    });
  }

  /**
   * Manually cancels a running/waiting run, releases held member slots & marks unfinished steps canceled.
   */
  public async cancelRun(runId: string): Promise<TaskRunRecord> {
    const run = this.getRun(runId);
    if (!run) throw badRequest(`运行实例不存在: ${runId}`);
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'canceled' || run.status === 'timed_out') {
      return run;
    }

    const now = new Date().toISOString();
    this.db.inTransaction(() => {
      this.db.sqlite
        .prepare(
          `UPDATE v2_task_runs
           SET status = 'canceled', waiting_question = NULL, summary = '已手动停止本轮执行', updated_at = ?
           WHERE id = ? AND status IN ('running', 'waiting_user', 'paused')`
        )
        .run(now, runId);
      this.db.sqlite
        .prepare(
          `UPDATE v2_task_steps
           SET status = 'canceled', updated_at = ?
           WHERE run_id = ? AND status IN ('pending', 'running', 'submitted', 'changes_requested', 'blocked')`
        )
        .run(now, runId);
    });

    const activeAttempts = this.registry
      .listAttempts({ runId })
      .filter((att) => att.status === 'prepared' || att.status === 'dispatched' || att.status === 'running');

    // Phase 1 (synchronous): mark all attempts of this run failed & splice/reject all queued waiters
    // BEFORE releasing any active slot or awaiting driver network calls, so freeing Step 1's slot never wakes Step 2 of the same run.
    for (const att of activeAttempts) {
      this.db.sqlite
        .prepare(
          `UPDATE v2_dispatch_attempts
           SET status = 'failed', slot_held = 0, error_message = '任务已手动停止', settled_at = ?
           WHERE id = ? AND status IN ('prepared', 'dispatched', 'running')`
        )
        .run(now, att.id);
      this.registry.cancelDispatchedAttempt(att.id, 'ATTEMPT_CANCELED');
    }

    // Phase 2: release held concurrency slots immediately for other runs/threads
    for (const att of activeAttempts) {
      this.registry.releaseMemberSlot(att.memberId, att.id);
    }

    // Phase 3: abort only attempts that had already dispatched/started on the underlying driver
    for (const att of activeAttempts) {
      if (att.status === 'dispatched' || att.status === 'running') {
        const member = this.db.getMember(att.memberId);
        if (member) {
          await this.registry.getDriver(member.driverKind).abortTurn(member, att).catch(() => false);
        }
      }
    }

    const task = this.getTask(run.taskId);
    const updated = this.getRun(runId)!;
    if (task) {
      this.threads.emit({ type: 'task.updated', taskId: task.id, runId, threadId: task.sourceThreadId, payload: task });
      this.threads.emit({ type: 'thread.space_updated', threadId: task.sourceThreadId });
    }
    return updated;
  }

  /**
   * Deletes a task and its runs/steps while safely detaching (never destroying) generated artifacts in Space.
   */
  public async deleteTask(taskId: string): Promise<{ deleted: true; sourceThreadId: string }> {
    const task = this.getTask(taskId);
    if (!task) {
      const err = new Error(`任务不存在: ${taskId}`) as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }

    const runs = this.listRuns(taskId);
    for (const r of runs) {
      if (r.status === 'running' || r.status === 'paused' || r.status === 'waiting_user') {
        await this.cancelRun(r.id);
      }
    }

    this.db.inTransaction(() => {
      this.db.sqlite.prepare(`DELETE FROM v2_space_material_links WHERE task_id = ?`).run(taskId);
      this.db.sqlite.prepare(`UPDATE v2_artifacts SET task_id = NULL, run_id = NULL WHERE task_id = ?`).run(taskId);
      this.db.sqlite.prepare(`DELETE FROM v2_tasks WHERE id = ?`).run(taskId);
    });

    this.threads.emit({ type: 'task.deleted', taskId, threadId: task.sourceThreadId });
    this.threads.emit({ type: 'thread.space_updated', threadId: task.sourceThreadId });
    return { deleted: true, sourceThreadId: task.sourceThreadId };
  }

  public hasReconcilableRuns(): boolean {
    const runningRuns = this.db.sqlite
      .prepare(`SELECT id, delivery_stage FROM v2_task_runs WHERE status = 'running'`)
      .all() as Array<{ id: string; delivery_stage: string }>;
    for (const r of runningRuns) {
      if (r.delivery_stage === 'lead_final_review' && !this.activeFinalizations.has(r.id)) {
        return true;
      }
      const steps = this.listSteps(r.id);
      if (steps.some((s) => !this.activeStepRuns.has(s.id))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Reconciles orphaned/interrupted `v2_task_runs` and `v2_task_steps` after process restart or node reconnect,
   * recovering completed worker/lead attempts without re-execution and advancing failed/ready runs!
   */
  public async reconcileInFlightTaskRuns(): Promise<TaskRunRecord[]> {
    if (this.taskReconcileRunning) return [];
    this.taskReconcileRunning = true;
    const touched: TaskRunRecord[] = [];
    try {
      const runningRows = this.db.sqlite
        .prepare(`SELECT * FROM v2_task_runs WHERE status = 'running' ORDER BY created_at ASC`)
        .all() as Record<string, unknown>[];

      for (const row of runningRows) {
        const run = mapRunRow(row);
        const effectiveTask = this.resolveEffectiveTaskForRun(run);
        if (!effectiveTask) continue;

        if (run.deliveryStage === 'lead_final_review' && !this.activeFinalizations.has(run.id)) {
          this.db.sqlite
            .prepare(
              `UPDATE v2_task_runs SET delivery_stage = 'steps_running', updated_at = ?
               WHERE id = ? AND status = 'running' AND delivery_stage = 'lead_final_review'`
            )
            .run(new Date().toISOString(), run.id);
        }

        const steps = this.listSteps(run.id);
        for (const step of steps) {
          if (this.activeStepRuns.has(step.id)) continue;

          if (step.status === 'running') {
            const att = this.registry.getLatestAttemptForStep(step.id, 'task_step');
            if (att && ['prepared', 'dispatched', 'running', 'reconciling'].includes(att.status)) {
              continue;
            }
            if (att && att.status === 'succeeded' && att.responseText !== null) {
              const existingSub = this.listSubmissions(step.id).find((s) => s.attemptId === att.id);
              let recovered: ReturnType<typeof splitSubmittedOutcome>;
              try {
                recovered = splitSubmittedOutcome(att.responseText);
              } catch {
                if (this.recoverUncertainExternal(effectiveTask, run, step)) continue;
                this.stepFailureReasons.set(step.id, '执行端提交的交付信息格式无效');
                this.db.sqlite.prepare("UPDATE v2_task_steps SET status='failed', updated_at=? WHERE id=?").run(new Date().toISOString(), step.id);
                continue;
              }
              this.outcomes.declare(step.id,recovered.outcome);
              const blockedMatch = recovered.text.match(/<duolawork_blocked>([\s\S]*?)<\/duolawork_blocked>/);
              const subStatus: 'submitted' | 'blocked' = blockedMatch ? 'blocked' : 'submitted';
              const subContent = blockedMatch ? blockedMatch[1].trim() : recovered.text;
              const cleaned = cleanDeliverableText(subContent);

              let recoveredCommitSha: string | null = existingSub?.commitSha ?? null;
              if (
                !existingSub &&
                step.worktreePath &&
                subStatus === 'submitted' &&
                fs.existsSync(step.worktreePath)
              ) {
                try {
                  recoveredCommitSha = await this.worktrees.commitStepChangesIfNeeded(
                    step.worktreePath,
                    `step(${step.stepOrder}): ${step.title} v${step.latestSubmissionVersion + 1}`,
                    run.id
                  );
                } catch {
                  recoveredCommitSha = null;
                }
              }

              const sub =
                existingSub ??
                this.recordSubmission({
                  stepId: step.id,
                  runId: run.id,
                  version: step.latestSubmissionVersion + 1,
                  assigneeMemberId: step.assigneeMemberId,
                  attemptId: att.id,
                  summary:
                    cleaned.slice(0, 180) ||
                    (recoveredCommitSha ? `代码变更提交 (${recoveredCommitSha.slice(0, 8)})` : '（恢复提交）'),
                  content: subContent,
                  commitSha: recoveredCommitSha,
                  status: subStatus
                });

              if (sub.status === 'blocked') {
                this.pauseRunWaitingUser(run.id, effectiveTask, `步骤「${step.title}」需要确认：${sub.content}`);
              } else if (cleaned.length === 0 && !sub.commitSha) {
                this.applyReviewDecision(
                  effectiveTask,
                  run,
                  this.getStep(step.id)!,
                  sub,
                  'changes_requested',
                  '执行人提交的正文为空，未生成有效交付成果，请输出完整成果后重新提交',
                  att.id
                );
              } else if (steps.length === 1 && step.assigneeMemberId === effectiveTask.leadMemberId) {
                this.applyReviewDecision(
                  effectiveTask,
                  run,
                  this.getStep(step.id)!,
                  sub,
                  'accept',
                  '负责人独立执行完成，自动验收交付',
                  att.id
                );
              } else {
                await this.runLeadStepReview(effectiveTask, run, this.getStep(step.id)!, sub);
              }
              continue;
            }

            if (this.recoverUncertainExternal(effectiveTask,run,step)) continue;
            const now = new Date().toISOString();
            if (att?.status === 'timed_out') {
              this.db.sqlite
                .prepare(`UPDATE v2_task_steps SET status = 'timed_out', updated_at = ? WHERE id = ?`)
                .run(now, step.id);
            } else {
              const reason = att?.errorMessage || '服务重启或连接中断，步骤未能完成';
              this.stepFailureReasons.set(step.id, reason);
              this.db.sqlite
                .prepare(`UPDATE v2_task_steps SET status = 'failed', updated_at = ? WHERE id = ?`)
                .run(now, step.id);
            }
            this.threads.emit({
              type: 'task.step_updated',
              taskId: effectiveTask.id,
              runId: run.id,
              payload: this.getStep(step.id)
            });
            continue;
          }

          if (step.status === 'submitted') {
            const confirmation = this.outcomes.get(step.id)?.state;
            if (confirmation === 'checking' || confirmation === 'manual') continue;
            const latestSub = this.getLatestStepSubmission(step.id);
            if (!latestSub) {
              this.stepFailureReasons.set(step.id, '步骤提交记录缺失，无法继续验收');
              this.db.sqlite
                .prepare(`UPDATE v2_task_steps SET status = 'failed', updated_at = ? WHERE id = ?`)
                .run(new Date().toISOString(), step.id);
              continue;
            }

            const existingRev = this.listReviews(step.id).find((r) => r.submissionVersion === latestSub.version);
            if (existingRev) {
              continue;
            }

            const revAtt = this.registry.getLatestAttemptForStep(step.id, 'lead_review', latestSub.id);
            if (revAtt && ['prepared', 'dispatched', 'running', 'reconciling'].includes(revAtt.status)) {
              continue;
            }
            if (revAtt && revAtt.status === 'succeeded' && revAtt.responseText !== null) {
              const parsed = parseLeadReviewJson(revAtt.responseText);
              this.applyReviewDecision(
                effectiveTask,
                run,
                step,
                latestSub,
                parsed.verdict,
                parsed.comments,
                revAtt.id
              );
              continue;
            }
            if (revAtt && ['failed', 'timed_out', 'late_ignored'].includes(revAtt.status)) {
              const now = new Date().toISOString();
              if (revAtt.status === 'timed_out') {
                this.db.sqlite
                  .prepare(`UPDATE v2_task_steps SET status = 'timed_out', updated_at = ? WHERE id = ?`)
                  .run(now, step.id);
              } else {
                this.stepFailureReasons.set(
                  step.id,
                  `负责人核验中断：${revAtt.errorMessage || '未能获取验收结果'}`
                );
                this.db.sqlite
                  .prepare(`UPDATE v2_task_steps SET status = 'failed', updated_at = ? WHERE id = ?`)
                  .run(now, step.id);
              }
              this.threads.emit({
                type: 'task.step_updated',
                taskId: effectiveTask.id,
                runId: run.id,
                payload: this.getStep(step.id)
              });
              continue;
            }

            // Crash occurred right after worker submitted before lead review dispatched
            if (steps.length === 1 && step.assigneeMemberId === effectiveTask.leadMemberId) {
              this.applyReviewDecision(
                effectiveTask,
                run,
                step,
                latestSub,
                'accept',
                '负责人独立执行完成，自动验收交付',
                latestSub.attemptId
              );
            } else {
              await this.runLeadStepReview(effectiveTask, run, step, latestSub);
            }
          }
        }

        const refreshedRun = this.getRun(run.id);
        if (refreshedRun && refreshedRun.status === 'running') {
          const settled = await this.driveRun(run.id);
          touched.push(settled);
        } else if (refreshedRun) {
          touched.push(refreshedRun);
        }
      }
      return touched;
    } finally {
      this.taskReconcileRunning = false;
    }
  }

  private disposeStepScopesForRun(
    steps: TaskStepRecord[],
    leadSessionKey?: string,
    leadMemberId?: string
  ): void {
    for (const s of steps) {
      this.scopeNativeSession.delete(s.isolatedSessionKey);
      const meta = this.scopeBridgeMeta.get(s.isolatedSessionKey);
      if (!meta) continue;
      this.scopeBridgeMeta.delete(s.isolatedSessionKey);
      const member = this.db.getMember(s.assigneeMemberId);
      if (member) {
        const driver = this.registry.getDriver(member.driverKind);
        void driver.disposeScope?.(member, meta).catch(() => {});
      }
    }
    if (leadSessionKey) {
      this.scopeNativeSession.delete(leadSessionKey);
      const leadMeta = this.scopeBridgeMeta.get(leadSessionKey);
      if (leadMeta) {
        this.scopeBridgeMeta.delete(leadSessionKey);
        const leadMember = leadMemberId ? this.db.getMember(leadMemberId) : null;
        if (leadMember) {
          const driver = this.registry.getDriver(leadMember.driverKind);
          void driver.disposeScope?.(leadMember, leadMeta).catch(() => {});
        }
      }
    }
  }

  public async disposeAllRemoteScopes(): Promise<void> {
    for (const [scopeKey, meta] of this.scopeBridgeMeta.entries()) {
      const bridgeChannelId = meta.bridgeChannelId;
      if (!bridgeChannelId) continue;
      // Locate member from attempts for this scopeKey
      const row = this.db.sqlite
        .prepare(`SELECT member_id FROM v2_dispatch_attempts WHERE scope_key = ? LIMIT 1`)
        .get(scopeKey) as { member_id: string } | undefined;
      if (!row) continue;
      const member = this.db.getMember(row.member_id);
      if (!member) continue;
      const driver = this.registry.getDriver(member.driverKind);
      await driver.disposeScope?.(member, meta);
    }
  }
}

function cleanDeliverableText(raw: string): string {
  return String(raw || '')
    .replace(/<duolawork_artifact(?:\s+[^>]*)?>/g, '')
    .replace(/<\/duolawork_artifact>/g, '')
    .replace(/<duolawork_folder(?:\s+[^>]*)?\/>/g, '')
    .replace(/<duolawork_folder(?:\s+[^>]*)?>[\s\S]*?<\/duolawork_folder>/g, '')
    .replace(/<duolawork_file(?:\s+[^>]*)?>[\s\S]*?<\/duolawork_file>/g, '')
    .replace(/<duolawork_link(?:\s+[^>]*)?>[\s\S]*?<\/duolawork_link>/g, '')
    .trim();
}

function badRequest(message: string): Error {
  const err = new Error(message) as Error & { statusCode?: number };
  err.statusCode = 400;
  return err;
}

function validateStepsDag(
  steps: Array<{ stepOrder: number; title: string; dependsOnOrders: number[] }>
): void {
  const orderToTitle = new Map<number, string>();
  const depsByOrder = new Map<number, number[]>();

  for (const st of steps) {
    if (orderToTitle.has(st.stepOrder)) {
      throw badRequest(
        `步骤编号重复 (#${st.stepOrder}「${st.title}」与「${orderToTitle.get(st.stepOrder)}」冲突)，请调整步骤序号`
      );
    }
    orderToTitle.set(st.stepOrder, st.title);
    depsByOrder.set(st.stepOrder, st.dependsOnOrders);
  }

  for (const st of steps) {
    for (const dep of st.dependsOnOrders) {
      if (dep === st.stepOrder) {
        throw badRequest(`步骤 #${st.stepOrder}「${st.title}」存在自依赖 (#${dep})，请移除对自身的依赖`);
      }
      if (!orderToTitle.has(dep)) {
        throw badRequest(
          `步骤 #${st.stepOrder}「${st.title}」引用了不存在的前置步骤编号 #${dep}，请检查步骤编号`
        );
      }
    }
  }

  // Detect cycles via 3-color DFS and report the exact cycle chain
  const state = new Map<number, 0 | 1 | 2>();
  const pathStack: number[] = [];

  const visit = (ord: number): void => {
    state.set(ord, 1);
    pathStack.push(ord);
    for (const dep of depsByOrder.get(ord) ?? []) {
      const depState = state.get(dep) ?? 0;
      if (depState === 1) {
        const cycleStart = pathStack.indexOf(dep);
        const cycleOrders = [...pathStack.slice(cycleStart), dep];
        const desc = cycleOrders.map((n) => `#${n}「${orderToTitle.get(n) || n}」`).join(' → ');
        throw badRequest(`任务步骤存在循环依赖，无法启动：${desc}`);
      }
      if (depState === 0) {
        visit(dep);
      }
    }
    pathStack.pop();
    state.set(ord, 2);
  };

  for (const st of steps) {
    if ((state.get(st.stepOrder) ?? 0) === 0) {
      visit(st.stepOrder);
    }
  }
}

function hasContradictoryReworkInAcceptComments(comments: string): boolean {
  const cleaned = String(comments || '')
    .replace(
      /(?:并无|没有|未见|未发现|不存在|无任何|无明显|无)\s*(?:数据|内容|信息|关键|明显|核心)?(?:缺失|遗漏|错误|问题|不合格|缺漏)/g,
      ''
    )
    .replace(/(?:无需|不需要|不必|不用)\s*(?:补充|修改|返工|重做|调整|重新提交|退回)/g, '');

  return /(?:未通过|不通过|不合格|未达标|不予通过|打回|返工|退回|驳回|重做|不能交付|无法交付|拒绝交付|拒绝通过|不可交付|尚未完成|数据缺失|内容缺失|信息缺失|关键缺失|严重缺失|缺少必要|缺失较多|请补充|需要补充|需补充|待补充|请修改|需要修改|需修改|请修正|重新提交|补充后再|修改后再|完善后再)/i.test(
    cleaned
  );
}

function normalizeLeadVerdict(
  verdict: StepReviewRecord['verdict'],
  rawComments: string
): { verdict: StepReviewRecord['verdict']; comments: string } {
  const comments = String(rawComments ?? '').trim();
  if (verdict === 'changes_requested') {
    return { verdict: 'changes_requested', comments: comments || '负责人要求返工补充' };
  }
  if (verdict === 'ask_user') {
    return { verdict: 'ask_user', comments: comments || '负责人请求人工确认' };
  }
  if (hasContradictoryReworkInAcceptComments(comments)) {
    return {
      verdict: 'changes_requested',
      comments
    };
  }
  return {
    verdict: 'accept',
    comments: comments || '核验通过'
  };
}

export function parseLeadReviewJson(rawText: string): {
  verdict: StepReviewRecord['verdict'];
  comments: string;
} {
  const text = String(rawText || '').trim();
  const candidates: string[] = [];

  const fencedMatches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const m of fencedMatches) {
    if (m[1]?.trim()) candidates.push(m[1].trim());
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    candidates.push(text.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as Record<string, unknown>;
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      const rawVerdict = String(obj.verdict || '').trim().toLowerCase();
      const comments = String(obj.comments ?? '').trim();
      if (rawVerdict === 'changes_requested' || rawVerdict === 'reject' || rawVerdict === 'rejected') {
        return normalizeLeadVerdict('changes_requested', comments);
      }
      if (rawVerdict === 'ask_user') {
        return normalizeLeadVerdict('ask_user', comments);
      }
      if (rawVerdict === 'accept') {
        return normalizeLeadVerdict('accept', comments);
      }
    } catch {
      // try next candidate or fall through to strict non-accept classification
    }
  }

  if (
    hasContradictoryReworkInAcceptComments(text) ||
    /(?:changes_requested|\brejected?\b)/i.test(text)
  ) {
    return {
      verdict: 'changes_requested',
      comments: text.slice(0, 500) || '负责人判定未通过，需修改后重交'
    };
  }

  return {
    verdict: 'ask_user',
    comments: text
      ? `负责人未返回有效通过裁决，请核验确认：${text.slice(0, 460)}`
      : '负责人未返回有效核验结论，请人工确认'
  };
}

function mapTaskRow(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    sourceThreadId: String(row.source_thread_id),
    title: String(row.title),
    kind: row.kind as TaskRecord['kind'],
    cronExpr: row.cron_expr ? String(row.cron_expr) : null,
    intervalSeconds: row.interval_seconds !== null && row.interval_seconds !== undefined ? Number(row.interval_seconds) : null,
    timezone: String(row.timezone),
    misfirePolicy: row.misfire_policy as TaskRecord['misfirePolicy'],
    scheduleEnabled: Number(row.schedule_enabled) !== 0,
    templateVersion: Number(row.template_version),
    requesterMemberId: row.requester_member_id ? String(row.requester_member_id) : null,
    leadMemberId: String(row.lead_member_id),
    leadSessionKey: String(row.lead_session_key),
    toolPolicy: row.tool_policy as TaskRecord['toolPolicy'],
    spec: JSON.parse(String(row.spec_json)) as TaskSpec,
    status: row.status as TaskRecord['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapRunRow(row: Record<string, unknown>): TaskRunRecord {
  let parsedSpec: TaskSpec | null = null;
  if (typeof row.spec_json === 'string' && row.spec_json) {
    try {
      parsedSpec = JSON.parse(row.spec_json) as TaskSpec;
    } catch {
      parsedSpec = null;
    }
  }
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    runNumber: Number(row.run_number),
    plannedSlotAt: String(row.planned_slot_at),
    templateVersion: Number(row.template_version),
    returnMemberId: row.return_member_id ? String(row.return_member_id) : null,
    returnTurnStatus: (row.return_turn_status as TaskRunRecord['returnTurnStatus']) ?? null,
    triggerType: row.trigger_type as TaskRunRecord['triggerType'],
    status: row.status as TaskRunRecord['status'],
    deliveryStage: row.delivery_stage as TaskRunRecord['deliveryStage'],
    waitingQuestion: row.waiting_question ? String(row.waiting_question) : null,
    integrationWorktreePath: row.integration_worktree_path ? String(row.integration_worktree_path) : null,
    integrationBranch: row.integration_branch ? String(row.integration_branch) : null,
    finalArtifactId: row.final_artifact_id ? String(row.final_artifact_id) : null,
    summary: row.summary ? String(row.summary) : null,
    leadMemberId: row.lead_member_id ? String(row.lead_member_id) : null,
    leadSessionKey: row.lead_session_key ? String(row.lead_session_key) : null,
    toolPolicy: row.tool_policy ? (String(row.tool_policy) as ToolPolicy) : null,
    spec: parsedSpec,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapStepRow(row: Record<string, unknown>): TaskStepRecord & { isolatedSessionId?: string } {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    taskId: String(row.task_id),
    stepOrder: Number(row.step_order),
    title: String(row.title),
    assigneeMemberId: String(row.assignee_member_id),
    dependsOnStepIds: JSON.parse(String(row.depends_on_step_ids_json || '[]')) as string[],
    brief: String(row.brief),
    acceptanceCriteria: String(row.acceptance_criteria),
    toolPolicy: row.tool_policy as TaskStepRecord['toolPolicy'],
    useWorktree: Number(row.use_worktree) !== 0,
    status: row.status as TaskStepRecord['status'],
    reviewRound: Number(row.review_round),
    isolatedSessionKey: String(row.isolated_session_key),
    nativeSessionId: row.native_session_id ? String(row.native_session_id) : null,
    worktreePath: row.worktree_path ? String(row.worktree_path) : null,
    worktreeBranch: row.worktree_branch ? String(row.worktree_branch) : null,
    latestSubmissionVersion: Number(row.latest_submission_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapSubmissionRow(row: Record<string, unknown>): StepSubmissionRecord {
  return {
    id: String(row.id),
    stepId: String(row.step_id),
    runId: String(row.run_id),
    version: Number(row.version),
    assigneeMemberId: String(row.assignee_member_id),
    attemptId: row.attempt_id ? String(row.attempt_id) : null,
    summary: String(row.summary),
    content: String(row.content),
    artifactId: row.artifact_id ? String(row.artifact_id) : null,
    artifactVersion: row.artifact_version !== null && row.artifact_version !== undefined ? Number(row.artifact_version) : null,
    commitSha: row.commit_sha ? String(row.commit_sha) : null,
    status: row.status as StepSubmissionRecord['status'],
    createdAt: String(row.created_at)
  };
}

function mapReviewRow(row: Record<string, unknown>): StepReviewRecord {
  return {
    id: String(row.id),
    stepId: String(row.step_id),
    runId: String(row.run_id),
    submissionVersion: Number(row.submission_version),
    leadMemberId: String(row.lead_member_id),
    attemptId: row.attempt_id ? String(row.attempt_id) : null,
    verdict: row.verdict as StepReviewRecord['verdict'],
    comments: String(row.comments),
    createdAt: String(row.created_at)
  };
}
