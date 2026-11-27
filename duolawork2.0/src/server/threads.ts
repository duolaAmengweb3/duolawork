import { chatTimeoutMessage } from '../shared/turn-timeout.js';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArtifactStore } from './artifacts.js';
import type { AuthSandbox } from './auth-sandbox.js';
import type { DuolaWorkDatabase } from './db.js';
import { CHAT_MAX_MS, type DriverRegistry } from './drivers/registry.js';
import {
  sanitizeToolSummary,
  redactSecrets,
  SPACE_AND_DUOLABASE_TOOLS,
  type DynamicToolDefinition,
  type TurnImageAttachment
} from './drivers/types.js';
import {
  computeMessageRevision,
  isMessageDeliverable,
  type BuiltHandoffPacket,
  type HandoffEngine
} from './handoff.js';
import type { SpaceStore } from './space.js';
import {
  isExcludedClaudeVps,
  resolveEffectiveDriverKind,
  type ClarificationCardData,
  type ClarificationQuestionItem,
  type HandoffNoticeMeta,
  type ScopedTurnClaims,
  type ThreadMessageRecord,
  type ThreadRecord,
  type ThreeTierUsage,
  type TurnActivity,
  type TurnPhase,
  type ToolTraceItem
} from '../shared/types.js';

export const DEFAULT_WORKBENCH_PROTOCOL_VERSION = 'dw2-proto-2026-11-27-v5';

export type ServerEventListener = (event: {
  type: string;
  threadId?: string;
  taskId?: string;
  runId?: string;
  payload?: unknown;
}) => void;

export interface StructuredActionHandler {
  executeTool: (
    claims: ScopedTurnClaims,
    toolName: string,
    args: Record<string, unknown>
  ) => Promise<unknown>;
  createOrUpdateTaskSync?: (
    claims: ScopedTurnClaims,
    args: Record<string, unknown>
  ) => { task: { id: string } };
  getActiveTasksSummaryForThread: (threadId: string) => string[];
  getSpaceMaterialsSummaryForThread?: (
    threadId: string,
    options?: { includeLocalPaths?: boolean }
  ) => string;
}

const previousRecipientSql = `(
  SELECT u.target_member_id FROM v2_thread_messages u
  WHERE u.thread_id = m.thread_id AND u.seq < m.seq AND u.author_kind = 'user'
  ORDER BY u.seq DESC LIMIT 1
)`;

function pendingOwnerSwitch(messages: ThreadMessageRecord[], targetMemberId: string) {
  const latest = messages.findLast((m) => m.authorKind === 'switch_notice');
  return latest?.handoffMeta?.status === 'pending' && latest.handoffMeta.toMemberId === targetMemberId
    ? latest
    : null;
}

export class ThreadEngine {
  private readonly listeners = new Set<ServerEventListener>();
  private readonly liveTurns = new Map<string, { activity: TurnActivity; tools: ToolTraceItem[] }>();
  private activityRevision = 0;
  public space?: SpaceStore;
  private readonly inflightClientRequests = new Map<
    string,
    Promise<{
      userMessage: ThreadMessageRecord;
      agentMessage: ThreadMessageRecord;
      handoffBytes: number;
    }>
  >();
  public actionHandler?: StructuredActionHandler;

  constructor(
    private readonly db: DuolaWorkDatabase,
    private readonly artifacts: ArtifactStore,
    private readonly handoff: HandoffEngine,
    private readonly sandbox: AuthSandbox,
    private readonly registry: DriverRegistry
  ) {}

  public subscribe(fn: ServerEventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  public getProtocolVersion(): string {
    return this.db.getSetting<string>(
      'workbench.protocol_version',
      DEFAULT_WORKBENCH_PROTOCOL_VERSION
    );
  }

  public bumpProtocolVersion(reason?: string): {
    version: string;
    updatedAt: string;
    memberCount: number;
  } {
    const version = `dw2-proto-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const updatedAt = new Date().toISOString();
    this.db.setSetting('workbench.protocol_version', version);
    this.db.setSetting('workbench.protocol_meta', {
      version,
      reason: reason?.trim() || 'manual_all_member_sync',
      updatedAt
    });
    this.emit({
      type: 'members.protocol_updated',
      payload: { version, updatedAt }
    });
    return {
      version,
      updatedAt,
      memberCount: this.db.listMembers().length
    };
  }

  public emit(event: Parameters<ServerEventListener>[0]): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // ignore listener failure
      }
    }
  }

  public createThread(input: {
    id?: string;
    title: string;
    activeOwnerMemberId: string;
    projectId?: string;
    workspacePath?: string | null;
    initialDocTitle?: string;
    initialDocContent?: string;
  }): ThreadRecord {
    const member = this.db.getMember(input.activeOwnerMemberId);
    if (!member) {
      throw new Error(`未找到指定成员: ${input.activeOwnerMemberId}`);
    }
    if (isExcludedClaudeVps(member)) {
      throw new Error('按保护规则禁止在对话中绑定排除的 VPS Claude 实例');
    }

    const threadId = input.id ?? 'thr_' + randomUUID().slice(0, 12);
    const now = new Date().toISOString();

    return this.db.inTransaction(() => {
      this.db.sqlite
        .prepare(
          `INSERT INTO v2_threads (
            id, project_id, workspace_path, title, active_owner_member_id,
            bound_artifact_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, 'active', ?, ?)`
        )
        .run(
          threadId,
          input.projectId ?? 'default',
          input.workspacePath ?? null,
          input.title.trim() || '新对话',
          member.id,
          now,
          now
        );

      if (input.initialDocTitle !== undefined || input.initialDocContent !== undefined) {
        const art = this.artifacts.createArtifact({
          sourceThreadId: threadId,
          title: input.initialDocTitle ?? `${input.title.trim() || '新对话'}-文稿.md`,
          content:
            input.initialDocContent ??
            `# ${input.title.trim() || '新对话'}\n\n`,
          writerKind: 'user',
          writerId: 'owner'
        });

        this.db.sqlite
          .prepare(`UPDATE v2_threads SET bound_artifact_id = ? WHERE id = ?`)
          .run(art.id, threadId);
      }

      const created = this.getThread(threadId)!;
      this.emit({ type: 'thread.created', threadId, payload: created });
      return created;
    });
  }

  public getThread(id: string): ThreadRecord | null {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM v2_threads WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapThreadRow(row) : null;
  }

  public listThreads(): ThreadRecord[] {
    const rows = this.db.sqlite
      .prepare(
        `SELECT * FROM v2_threads
         WHERE status = 'active'
         ORDER BY (pinned_at IS NOT NULL) DESC, pinned_at DESC, updated_at DESC`
      )
      .all() as Record<string, unknown>[];
    return rows.map(mapThreadRow);
  }

  public listMessages(threadId: string, range?: { fromSeq?: number; toSeq?: number }): ThreadMessageRecord[] {
    const clauses = ['thread_id = ?'];
    const args: (string | number)[] = [threadId];
    if (range?.fromSeq !== undefined) {
      clauses.push('seq >= ?');
      args.push(range.fromSeq);
    }
    if (range?.toSeq !== undefined) {
      clauses.push('seq <= ?');
      args.push(range.toSeq);
    }
    const rows = this.db.sqlite
      .prepare(
        `SELECT m.*, CASE WHEN m.turn_status IN ('canceled','failed') THEN
           (SELECT u.paired_message_id FROM v2_thread_messages u WHERE u.thread_id=m.thread_id AND u.client_request_id='continue:'||m.id) END AS continued_by,
           CASE WHEN m.author_kind = 'switch_notice' AND m.handoff_meta_json IS NOT NULL THEN ${previousRecipientSql} END AS previous_recipient
         FROM v2_thread_messages m WHERE ${clauses.join(' AND ')} ORDER BY seq ASC`
      )
      .all(...args) as Record<string, unknown>[];
    return rows.flatMap((row) => {
      const msg = mapMessageRow(row);
      if (row.continued_by) msg.continuedByMessageId = String(row.continued_by);
      const live = msg.turnStatus === 'running' && this.liveTurns.get(msg.id);
      if (live) {
        msg.activity = live.activity;
        msg.toolTrace = [...live.tools];
      }
      // Older collapsed switches recorded the last selected member, even when they received no turn.
      if (msg.handoffMeta && typeof row.previous_recipient === 'string') {
        if (msg.handoffMeta.toMemberId === row.previous_recipient) return [];
        msg.handoffMeta.fromMemberId = row.previous_recipient;
      }
      return [msg];
    });
  }

  public appendSystemMessage(input: {
    threadId: string;
    authorKind: 'system_task_card' | 'switch_notice' | 'agent';
    authorId: string;
    body: string;
    artifactRefs?: string[];
    taskCard?: ThreadMessageRecord['taskCard'];
    handoffMeta?: HandoffNoticeMeta | null;
  }): ThreadMessageRecord {
    const msg = this.db.inTransaction(() => {
      const nextSeq = this.nextMessageSeq(input.threadId);
      const id = 'msg_' + randomUUID().slice(0, 12);
      const now = new Date().toISOString();
      this.db.sqlite
        .prepare(
          `INSERT INTO v2_thread_messages (
            id, thread_id, seq, author_kind, author_id, target_member_id, attempt_id,
            body, artifact_refs_json, task_card_json, handoff_meta_json, turn_status, usage_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'completed', NULL, ?, ?)`
        )
        .run(
          id,
          input.threadId,
          nextSeq,
          input.authorKind,
          input.authorId,
          input.body,
          JSON.stringify(input.artifactRefs ?? []),
          input.taskCard ? JSON.stringify(input.taskCard) : null,
          input.handoffMeta ? JSON.stringify(input.handoffMeta) : null,
          now,
          now
        );
      this.db.sqlite
        .prepare(`UPDATE v2_threads SET updated_at = ? WHERE id = ?`)
        .run(now, input.threadId);
      return this.getMessage(id)!;
    });
    this.emit({ type: 'thread.message', threadId: input.threadId, payload: msg });
    return msg;
  }

  /**
   * Switches the active conversational owner without disturbing any in-flight turn of the previous owner.
   * Zero model calls occur on switch.
   */
  public switchOwner(threadId: string, nextOwnerMemberId: string): ThreadRecord {
    const thread = this.getThread(threadId);
    if (!thread) throw new Error(`对话不存在: ${threadId}`);
    const nextMember = this.db.getMember(nextOwnerMemberId);
    if (!nextMember) throw new Error(`成员不存在: ${nextOwnerMemberId}`);
    if (isExcludedClaudeVps(nextMember)) {
      throw new Error('禁止切换至被排除的 VPS Claude 实例');
    }
    if (thread.activeOwnerMemberId === nextOwnerMemberId) {
      return thread;
    }

    const previousOwnerId = thread.activeOwnerMemberId;
    const now = new Date().toISOString();
    this.db.sqlite
      .prepare(`UPDATE v2_threads SET active_owner_member_id = ?, updated_at = ? WHERE id = ?`)
      .run(nextOwnerMemberId, now, threadId);

    const latest = this.db.sqlite
      .prepare(
        `SELECT id, author_kind, handoff_meta_json, ${previousRecipientSql} AS previous_recipient
         FROM v2_thread_messages m WHERE thread_id = ?
         ORDER BY seq DESC LIMIT 1`
      )
      .get(threadId) as
      | { id: string; author_kind: string; handoff_meta_json: string | null; previous_recipient: string | null }
      | undefined;

    let existingMeta: HandoffNoticeMeta | null = null;
    if (latest?.handoff_meta_json) {
      try {
        existingMeta = JSON.parse(latest.handoff_meta_json) as HandoffNoticeMeta;
      } catch {
        existingMeta = null;
      }
    }

    const originalOwnerId = latest?.previous_recipient ?? existingMeta?.fromMemberId ?? previousOwnerId;
    if (latest?.author_kind === 'switch_notice' && existingMeta?.status === 'pending' &&
        originalOwnerId === nextOwnerMemberId) {
      // No turn was sent to an intermediate owner. Withdraw the outstanding handoff.
      this.db.sqlite.prepare('DELETE FROM v2_thread_messages WHERE id = ?').run(latest.id);
    } else if (latest?.author_kind === 'switch_notice' && existingMeta?.status !== 'delivered') {
      const pendingMeta: HandoffNoticeMeta = {
        status: 'pending',
        fromMemberId: originalOwnerId,
        toMemberId: nextOwnerMemberId,
        reason: 'member_switch'
      };
      this.db.sqlite
        .prepare(
          `UPDATE v2_thread_messages SET body = ?, handoff_meta_json = ?, updated_at = ? WHERE id = ?`
        )
        .run(`已切换至 ${nextMember.name}`, JSON.stringify(pendingMeta), now, latest.id);
      const updatedNotice = this.getMessage(latest.id);
      if (updatedNotice) {
        this.emit({ type: 'thread.message_updated', threadId, payload: updatedNotice });
      }
    } else {
      this.appendSystemMessage({
        threadId,
        authorKind: 'switch_notice',
        authorId: 'system',
        body: `已切换至 ${nextMember.name}`,
        handoffMeta: {
          status: 'pending',
          fromMemberId: previousOwnerId,
          toMemberId: nextOwnerMemberId,
          reason: 'member_switch'
        }
      });
    }

    const updated = this.getThread(threadId)!;
    this.emit({ type: 'thread.owner_switched', threadId, payload: updated });
    return updated;
  }

  /**
   * Updates editable thread metadata such as title, bound workspace folder, or status.
   */
  public updateThread(
    threadId: string,
    patch: {
      title?: string;
      workspacePath?: string | null;
      workspaceNodeId?: string | null;
      status?: 'active' | 'archived';
      pinned?: boolean;
    }
  ): ThreadRecord {
    const existing = this.getThread(threadId);
    if (!existing) throw new Error(`对话不存在: ${threadId}`);

    const nextTitle =
      typeof patch.title === 'string' && patch.title.trim()
        ? patch.title.trim().slice(0, 80)
        : existing.title;
    const nextWorkspace =
      patch.workspacePath === undefined
        ? existing.workspacePath
        : patch.workspacePath
          ? String(patch.workspacePath).trim() || null
          : null;
    const nextWorkspaceNodeId =
      patch.workspaceNodeId === undefined
        ? existing.workspaceNodeId ?? null
        : patch.workspaceNodeId
          ? String(patch.workspaceNodeId).trim() || null
          : null;
    const nextStatus =
      patch.status === 'active' || patch.status === 'archived' ? patch.status : existing.status;
    const now = new Date().toISOString();
    const nextPinnedAt =
      patch.pinned === undefined
        ? existing.pinnedAt
        : patch.pinned
          ? existing.pinnedAt ?? now
          : null;

    this.db.sqlite
      .prepare(
        `UPDATE v2_threads
         SET title = ?, workspace_path = ?, workspace_node_id = ?, status = ?, pinned_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(nextTitle, nextWorkspace, nextWorkspaceNodeId, nextStatus, nextPinnedAt, now, threadId);

    const updated = this.getThread(threadId)!;
    this.emit({ type: 'thread.updated', threadId, payload: updated });
    return updated;
  }

  /**
   * Requests cooperative cancellation of the latest in-flight dispatch attempt on a thread.
   */
  public async abortActiveTurn(threadId: string): Promise<{
    aborted: boolean;
    message: ThreadMessageRecord | null;
  }> {
    const attemptRow = this.db.sqlite
      .prepare(
        `SELECT * FROM v2_dispatch_attempts
         WHERE thread_id = ? AND status IN ('prepared', 'dispatched', 'running', 'reconciling')
         ORDER BY dispatched_at DESC LIMIT 1`
      )
      .get(threadId) as Record<string, unknown> | undefined;

    const now = new Date().toISOString();
    let aborted = false;

    const activeMsgRow = this.db.sqlite
      .prepare(
        `SELECT id FROM v2_thread_messages
         WHERE thread_id = ? AND author_kind = 'agent' AND turn_status IN ('queued', 'running')
         ORDER BY seq DESC LIMIT 1`
      )
      .get(threadId) as { id: string } | undefined;

    if (activeMsgRow) {
      this.db.sqlite
        .prepare(
          `UPDATE v2_thread_messages
           SET turn_status = 'canceled',
               body = CASE WHEN trim(body) = '' THEN '已停止本轮生成' ELSE body END,
               updated_at = ?
           WHERE id = ? AND turn_status IN ('queued', 'running')`
        )
        .run(now, activeMsgRow.id);
    }

    if (attemptRow) {
      const attemptId = String(attemptRow.id);
      const attempt = this.registry.getAttempt(attemptId);
      const member = attempt ? this.db.getMember(attempt.memberId) : null;
      this.db.sqlite
        .prepare(
          `UPDATE v2_dispatch_attempts
           SET status = 'failed', slot_held = 0, error_message = '已由用户停止', settled_at = ?
           WHERE id = ? AND status IN ('prepared', 'dispatched', 'running', 'reconciling')`
        )
        .run(now, attemptId);
      this.db.sqlite
        .prepare(
          `UPDATE v2_thread_messages
           SET turn_status = 'canceled',
               body = CASE WHEN trim(body) = '' THEN '已停止本轮生成' ELSE body END,
               updated_at = ?
           WHERE attempt_id = ? AND turn_status IN ('queued', 'running')`
        )
        .run(now, attemptId);
      this.registry.cancelDispatchedAttempt(attemptId, 'ATTEMPT_CANCELED');
      if (attempt && member && (attempt.status === 'dispatched' || attempt.status === 'running' || attempt.status === 'reconciling')) {
        try {
          aborted = await this.registry.getDriver(member.driverKind).abortTurn(member, attempt);
        } catch {
          aborted = false;
        }
      } else if (attempt) {
        aborted = true;
      }
      if (attempt) {
        this.registry.releaseMemberSlot(attempt.memberId, attempt.id);
      }
    }

    const msgRow = this.db.sqlite
      .prepare(
        `SELECT id FROM v2_thread_messages
         WHERE thread_id = ? AND author_kind = 'agent' AND turn_status IN ('queued', 'running', 'canceled')
         ORDER BY seq DESC LIMIT 1`
      )
      .get(threadId) as { id: string } | undefined;

    if (msgRow) {
      this.db.sqlite
        .prepare(
          `UPDATE v2_thread_messages
           SET turn_status = 'canceled',
               body = CASE WHEN trim(body) = '' THEN '已停止本轮生成' ELSE body END,
               updated_at = ?
           WHERE id = ? AND turn_status IN ('running', 'canceled')`
        )
        .run(now, msgRow.id);
      const msg = this.getMessage(msgRow.id);
      if (msg) {
        this.emit({ type: 'thread.message_updated', threadId, payload: msg });
      }
      return { aborted: aborted || Boolean(attemptRow), message: msg };
    }

    return { aborted, message: null };
  }

  public async continueInterruptedTurn(threadId: string, messageId: string) {
    const source = this.getMessage(messageId);
    if (!source || source.threadId !== threadId || source.authorKind !== 'agent') throw new Error('找不到这条执行记录');
    const key = 'continue:' + messageId;
    const existing = () => this.db.sqlite.prepare(
      'SELECT paired_message_id FROM v2_thread_messages WHERE thread_id=? AND client_request_id=?'
    ).get(threadId, key);
    if (existing()) return { status: 'continued' };
    if (source.turnStatus === 'completed') return { status: 'completed' };
    if (!['failed', 'canceled'].includes(source.turnStatus)) return { status: 'waiting' };

    const superseded = () => Boolean(this.db.sqlite.prepare("SELECT 1 FROM v2_thread_messages WHERE thread_id=? AND seq>? AND author_kind IN ('user','agent') LIMIT 1").get(threadId, source.seq));
    if (superseded()) return { status: 'superseded' };
    const attempt = source.attemptId && this.registry.getAttempt(source.attemptId);
    const executor = this.db.getMember(source.authorId);
    if (attempt && executor && ['remote-node', 'webhook-bot', 'remote-bridge'].includes(executor.driverKind)) {
      const receipt = await this.registry.getDriver(executor.driverKind).reconcileAttempt(executor, attempt);
      if (receipt.state === 'completed' && receipt.text?.trim()) {
        this.db.inTransaction(() => {
          // The user explicitly requested this stopped result. Passive replay still respects Stop.
          if (source.turnStatus === 'canceled') this.db.sqlite.prepare(
            `UPDATE v2_thread_messages SET turn_status='failed' WHERE id=? AND attempt_id=? AND turn_status='canceled'`
          ).run(messageId, attempt.id);
          this.registry.recoverLateThreadReply(attempt, receipt);
          this.syncReconciledThreadTurns();
        });
      }
      if (receipt.state === 'still_running') {
        if (!receipt.errorMessage) return { status: source.turnStatus === 'canceled' ? 'stopping' : 'waiting' };
        if (this.getThread(threadId)?.activeOwnerMemberId === source.authorId) return { status: 'unreachable' };
      }
    }
    // A completion or a second click may have arrived while we were checking the original request.
    if (existing()) return { status: 'continued' };
    if (this.getMessage(messageId)?.turnStatus === 'completed') return { status: 'completed' };
    if (this.db.sqlite.prepare(`SELECT 1 FROM v2_thread_messages WHERE thread_id=? AND turn_status IN ('queued','running')`).get(threadId)) {
      return { status: 'busy' };
    }

    if (superseded()) return { status: 'superseded' };
    // Follow earlier continuation requests to retain the user's original goal and image references.
    let preceding = source;
    let requestText = '';
    let returnMember: string | undefined;
    for (;;) {
      const request = this.db.sqlite.prepare(
        `SELECT body,client_request_id,author_kind,target_member_id FROM v2_thread_messages
         WHERE thread_id=? AND (paired_message_id=? OR (paired_message_id IS NULL AND author_kind='user' AND seq<?))
         ORDER BY (paired_message_id IS NOT NULL) DESC, seq DESC LIMIT 1`
      ).get(threadId, preceding.id, preceding.seq) as { body: string; client_request_id: string | null; author_kind: string; target_member_id: string } | undefined;
      if (!request) break;
      requestText = request.body;
      if (request.author_kind === 'task_receipt') returnMember = request.target_member_id;
      const previous = request.client_request_id?.startsWith('continue:') && this.getMessage(request.client_request_id.slice(9));
      if (!previous || previous.threadId !== threadId || previous.seq >= preceding.seq) break;
      preceding = previous;
    }
    const ownerId = returnMember ?? this.getThread(threadId)?.activeOwnerMemberId;
    const owner = ownerId && this.db.getMember(ownerId);
    if (!owner || !['ready','busy'].includes(owner.status)) return { status: 'unavailable' };
    const operations = (source.toolTrace ?? []).slice(-12).map(t => [t.name, t.summary].filter(Boolean).join(' ')).join('、');
    const context = [
      '用户要求继续这个中断的任务。原始请求：' + requestText,
      '上一轮留下的记录：' + (source.body || '没有最终回复'),
      operations && '近期工具记录（仅表示调用过）：' + operations,
      '先核对已有文件和外部操作回执，再继续剩余工作。已完成的步骤跳过。发文、发送、支付等操作若结果不明，先查证；无法确认时告知用户，切勿重复提交。'
    ].filter(Boolean).join('\n');
    const execution = this.executeSendUserMessage({ threadId, body: '从上次中断处继续', receiptMemberId: returnMember, continuationContext: context }, key);
    if (!existing()) await execution;
    else void execution.catch(() => {}); // The normal message lifecycle persists and emits its result.
    return { status: 'continued' };
  }

  /**
   * Sends a user message EXCLUSIVELY to `thread.activeOwnerMemberId`.
   * - Mentions like `@Grok` or `@Codex` in `body` are treated strictly as plain text (0 bystander wakeups).
   * - Captures `pinnedBaseArtifactVersion` at dispatch time so if the user switches owners and edits the doc
   *   while this turn is running, a late artifact write from this turn lands safely in `conflict_branch`!
   * - Advances `handoff.last_seen_seq` ONLY after confirmed turn delivery.
   */
  public async sendUserMessage(input: {
    threadId: string;
    body: string;
    idempotencyKey?: string;
    timeoutMs?: number;
    continuationContext?: string;
    clarifyReply?: { messageId: string; summary: string };
  }): Promise<{
    userMessage: ThreadMessageRecord;
    agentMessage: ThreadMessageRecord;
    handoffBytes: number;
  }> {
    const cleanClientKey =
      typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim()
        ? input.idempotencyKey.trim()
        : null;

    if (cleanClientKey?.startsWith('task-return:')) throw new Error('无效的消息请求标识');
    if (!cleanClientKey) {
      return this.executeSendUserMessage(input, null);
    }

    const inflightKey = `${input.threadId}:${cleanClientKey}`;
    const existingPromise = this.inflightClientRequests.get(inflightKey);
    if (existingPromise) {
      return existingPromise;
    }

    const runPromise = this.executeSendUserMessage(input, cleanClientKey).finally(() => {
      if (this.inflightClientRequests.get(inflightKey) === runPromise) {
        this.inflightClientRequests.delete(inflightKey);
      }
    });
    this.inflightClientRequests.set(inflightKey, runPromise);
    return runPromise;
  }

  // A delivery wakes the delegator without changing the user's selected conversation owner.
  public receiveTaskResult(threadId: string, memberId: string, runId: string, context: string) {
    return this.executeSendUserMessage({ threadId, receiptMemberId: memberId,
      body: context, isTaskReceipt: true }, 'task-return:' + runId);
  }

  private async executeSendUserMessage(
    input: {
      threadId: string;
      body: string;
      receiptMemberId?: string;
      isTaskReceipt?: boolean;
      idempotencyKey?: string;
      timeoutMs?: number;
      continuationContext?: string;
      clarifyReply?: { messageId: string; summary: string };
    },
    cleanClientKey: string | null
  ): Promise<{
    userMessage: ThreadMessageRecord;
    agentMessage: ThreadMessageRecord;
    handoffBytes: number;
  }> {
    const thread = this.getThread(input.threadId);
    if (!thread) throw new Error(`对话不存在: ${input.threadId}`);
    const targetMember = this.db.getMember(input.receiptMemberId ?? thread.activeOwnerMemberId);
    if (!targetMember) throw new Error(`负责人不存在: ${thread.activeOwnerMemberId}`);

    const cleanBody = input.body.trim();
    if (!cleanBody) throw new Error('消息内容不能为空');

    let reusedUserMsg: ThreadMessageRecord | null = null;
    let reusedAgentMsg: ThreadMessageRecord | null = null;
    let retryAttemptKeySuffix = '';

    if (cleanClientKey) {
      const existingRow = this.db.sqlite
        .prepare(
          `SELECT id, paired_message_id FROM v2_thread_messages
           WHERE thread_id = ? AND client_request_id = ? LIMIT 1`
        )
        .get(thread.id, cleanClientKey) as { id: string; paired_message_id: string | null } | undefined;

      if (existingRow) {
        const preAgent = existingRow.paired_message_id
          ? this.getMessage(existingRow.paired_message_id)
          : null;
        if (preAgent?.turnStatus === 'running') {
          this.syncReconciledThreadTurns();
        }
        const curUser = this.getMessage(existingRow.id);
        let curAgent = existingRow.paired_message_id
          ? this.getMessage(existingRow.paired_message_id)
          : null;
        if (
          curUser &&
          curAgent &&
          (curAgent.turnStatus === 'completed' || curAgent.turnStatus === 'canceled' || curAgent.turnStatus === 'running' ||
            (curAgent.turnStatus === 'failed' && curAgent.attemptId &&
              ['timed_out', 'late_ignored'].includes(this.registry.getAttempt(curAgent.attemptId)?.status ?? '')))
        ) {
          if (curAgent.turnStatus === 'completed') {
            const flagRow = this.db.sqlite
              .prepare(`SELECT inline_actions_applied FROM v2_thread_messages WHERE id = ?`)
              .get(curAgent.id) as { inline_actions_applied: number } | undefined;
            if (flagRow && Number(flagRow.inline_actions_applied) === 0 && curAgent.attemptId) {
              const att = this.registry.getAttempt(curAgent.attemptId);
              if (att && att.responseText !== null) {
                const retryClaims = this.sandbox.issueScopedToken({
                  principalKind: 'thread_owner',
                  memberId: curAgent.authorId,
                  attemptId: att.id,
                  threadId: thread.id,
                  allowedArtifactIds: att.baseArtifactId ? [att.baseArtifactId] : [],
                  toolPolicy: 'duolabase_full'
                });
                try {
                  const updatedBody = await this.applyInlineArtifactAndActions(
                    att.responseText,
                    retryClaims,
                    att.baseArtifactId,
                    att.baseArtifactVersion,
                    curAgent.id
                  );
                  this.db.sqlite
                    .prepare(`UPDATE v2_thread_messages SET body = ?, updated_at = ? WHERE id = ?`)
                    .run(updatedBody, new Date().toISOString(), curAgent.id);
                  curAgent = this.getMessage(curAgent.id);
                } finally {
                  this.sandbox.revokeToken(retryClaims.token);
                }
              }
            }
          }
          if (curAgent) {
            return {
              userMessage: curUser,
              agentMessage: curAgent,
              handoffBytes: curAgent.handoffMeta?.handoffBytes ?? 0
            };
          }
        }
        if (curUser && curAgent) {
          const now = new Date().toISOString();
          this.db.sqlite
            .prepare(
              `UPDATE v2_thread_messages
               SET body = '', turn_status = 'running', author_id = ?, target_member_id = ?, updated_at = ?
               WHERE id = ?`
            )
            .run(targetMember.id, targetMember.id, now, curAgent.id);
          reusedUserMsg = curUser;
          reusedAgentMsg = this.getMessage(curAgent.id)!;
          retryAttemptKeySuffix = `:retry:${Date.now()}`;
        }
      }
    }

    const allExistingMessages = this.listMessages(thread.id);
    const priorMessages = reusedUserMsg
      ? allExistingMessages.filter((m) => m.seq < reusedUserMsg!.seq)
      : allExistingMessages;
    const boundArtifact = thread.boundArtifactId
      ? this.artifacts.getArtifact(thread.boundArtifactId)
      : null;
    const pinnedArtifactId = boundArtifact?.id ?? null;
    const pinnedArtifactVersion = boundArtifact?.headVersion ?? null;

    const { userMsg, placeholderAgentMsg, autoRenamed } =
      reusedUserMsg && reusedAgentMsg
        ? { userMsg: reusedUserMsg, placeholderAgentMsg: reusedAgentMsg, autoRenamed: false }
        : this.db.inTransaction(() => {
            const uSeq = this.nextMessageSeq(thread.id);
            const aSeq = uSeq + 1;
            const now = new Date().toISOString();
            const uId = 'msg_' + randomUUID().slice(0, 12);
            const aId = 'msg_' + randomUUID().slice(0, 12);

            this.db.sqlite
              .prepare(
                `INSERT INTO v2_thread_messages (
                  id, thread_id, seq, author_kind, author_id, target_member_id, attempt_id,
                  body, artifact_refs_json, task_card_json, turn_status, usage_json,
                  client_request_id, paired_message_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, '[]', NULL, 'completed', NULL, ?, ?, ?, ?)`
              )
              .run(uId, thread.id, uSeq, input.isTaskReceipt ? 'task_receipt' : 'user', input.isTaskReceipt ? 'system' : 'owner', targetMember.id, cleanBody, cleanClientKey, aId, now, now);

            this.db.sqlite
              .prepare(
                `INSERT INTO v2_thread_messages (
                  id, thread_id, seq, author_kind, author_id, target_member_id, attempt_id,
                  body, artifact_refs_json, task_card_json, turn_status, usage_json, created_at, updated_at
                ) VALUES (?, ?, ?, 'agent', ?, ?, NULL, '', '[]', NULL, 'running', NULL, ?, ?)`
              )
              .run(aId, thread.id, aSeq, targetMember.id, targetMember.id, now, now);

            const isDefaultTitle = /^新(?:工作)?对话(?:\s+\d+)?$/.test(thread.title);
            const autoTitle = isDefaultTitle && !input.receiptMemberId ? cleanBody.replace(/\s+/g, ' ').slice(0, 22) : '';
            if (autoTitle) {
              this.db.sqlite
                .prepare(`UPDATE v2_threads SET title = ?, updated_at = ? WHERE id = ?`)
                .run(autoTitle, now, thread.id);
            } else {
              this.db.sqlite
                .prepare(`UPDATE v2_threads SET updated_at = ? WHERE id = ?`)
                .run(now, thread.id);
            }

            return {
              userMsg: this.getMessage(uId)!,
              placeholderAgentMsg: this.getMessage(aId)!,
              autoRenamed: Boolean(autoTitle)
            };
          });

    let clarifiedUpdatedMsg: ThreadMessageRecord | null = null;
    if (input.clarifyReply?.messageId) {
      const targetClarifyMsg = this.getMessage(input.clarifyReply.messageId);
      if (
        targetClarifyMsg &&
        targetClarifyMsg.threadId === thread.id &&
        targetClarifyMsg.clarificationCard &&
        !targetClarifyMsg.clarificationCard.answered
      ) {
        const nowAns = new Date().toISOString();
        const settledCard: ClarificationCardData = {
          ...targetClarifyMsg.clarificationCard,
          answered: true,
          answeredSummary: input.clarifyReply.summary || cleanBody.slice(0, 120),
          answeredAt: nowAns
        };
        this.db.sqlite
          .prepare(
            `UPDATE v2_thread_messages SET clarification_card_json = ?, updated_at = ? WHERE id = ?`
          )
          .run(JSON.stringify(settledCard), nowAns, targetClarifyMsg.id);
        clarifiedUpdatedMsg = this.getMessage(targetClarifyMsg.id);
      }
    }

    if (clarifiedUpdatedMsg) {
      this.emit({ type: 'thread.message_updated', threadId: thread.id, payload: clarifiedUpdatedMsg });
    }
    if (autoRenamed) {
      const updatedThread = this.getThread(thread.id);
      if (updatedThread) {
        this.emit({ type: 'thread.updated', threadId: thread.id, payload: updatedThread });
      }
    }
    if (!reusedUserMsg) {
      this.emit({ type: 'thread.message', threadId: thread.id, payload: userMsg });
      this.emit({ type: 'thread.message', threadId: thread.id, payload: placeholderAgentMsg });
    } else {
      this.emit({ type: 'thread.message_updated', threadId: thread.id, payload: placeholderAgentMsg });
    }

    const activeTasksSummary =
      this.actionHandler?.getActiveTasksSummaryForThread(thread.id) ?? [];

    const allMembers = this.db.listMembers();
    const memberNameById = new Map(allMembers.map((m) => [m.id, m.name]));
    const memberNamesSummary = allMembers
      .slice(0, 14)
      .map(
        (m) =>
          `${m.name}(${m.id}${m.status === 'ready' || m.status === 'busy' ? '' : `,状态:${m.status}`})`
      )
      .join('、');
    const effectiveDriverKind = resolveEffectiveDriverKind(targetMember);
    const canReadHistoryTool =
      effectiveDriverKind === 'codex-app-server' || effectiveDriverKind === 'mock';

    const pendingSwitchNotice = pendingOwnerSwitch(priorMessages, targetMember.id);

    const protocolVersion = this.getProtocolVersion();
    const cursor = this.handoff.getCursor(thread.id, targetMember.id);
    const existingBridgeMeta = cursor?.bridgeMeta ?? null;
    const needsProtocolSync = !cursor || cursor.contextEpoch !== protocolVersion;

    const buildPacket = (forceFullContext: boolean): BuiltHandoffPacket =>
      this.handoff.buildPromptWithBoundedHandoff({
        threadId: thread.id,
        targetMemberId: targetMember.id,
        fromMemberId: pendingSwitchNotice?.handoffMeta?.fromMemberId ?? null,
        currentUserSeq: userMsg.seq,
        currentUserBody: input.continuationContext || cleanBody,
        priorMessages,
        boundArtifact,
        activeTasksSummary,
        memberNameById,
        canReadHistoryTool,
        tokenBudgetMember: targetMember,
        forceFullContext
      });

    const hasNativeSpaceTools =
      effectiveDriverKind === 'codex-app-server' ||
      effectiveDriverKind === 'acp-stdio' ||
      effectiveDriverKind === 'claude-cli' ||
      effectiveDriverKind === 'mock';

    const protocolBrief = needsProtocolSync
      ? [
          `<duolawork_v2_protocol version="${protocolVersion}">`,
          `你当前接入的是新版 DuolaWork 2.0 工作台（非旧版 1.9.6 群聊）：`,
          `- 当前对话ID：${thread.id}；当前对接成员：${targetMember.name}(${targetMember.id})；团队成员：${memberNamesSummary || targetMember.name}`,
          `- 对话机制：每次消息仅由当前指定负责人单线响应；切人时历史通过 <context_handoff> 自动交接，未同步的更早历史如实说明看不到。`,
          `- 协作空间资料与文件夹（支持任意格式文件 + 文件夹管理）：右侧「资料」里的文件夹与文档/文件/链接会自动附带摘要。${
            hasNativeSpaceTools
              ? '你已直接挂载协作空间工具（含 duolawork-space MCP / 动态工具）：space_list_materials（列出目录与资料）、space_read_material（读取内容）、space_create_folder（创建单层或嵌套文件夹如 "调研/2026-11"）、space_save_file（保存任意格式文件如 .csv/.json/.html/.py/.png/.pdf/.xlsx/.zip，支持传文本 content、二进制 dataBase64，或直接传你本机生成的绝对路径 localPath 自动上传）、space_save_document（创建/更新 Markdown 文档并放入目录）、space_save_link（保存链接）、space_move_item（移动目录或重命名）。'
              : '支持通过内联标签向右侧协作空间创建文件夹与写入任意格式文件。'
          }同时所有成员均可使用通用内联标签作为兜底：<duolawork_folder path="目录/子目录" />、<duolawork_file name="文件名.csv" folder="可选目录" encoding="utf8|base64">文件内容</duolawork_file>、<duolawork_artifact title="标题.md" folder="可选目录">Markdown正文</duolawork_artifact>、<duolawork_link title="标题" url="https://..." folder="可选目录">备注</duolawork_link>。`,
          `- 对话图片展示：前端支持在对话中直接渲染图片并提供「保存到资料区」与「保存到本地」按钮。如果你找到了网图，请直接输出标准 Markdown 图片 \`![图片说明](https://图片URL)\`；如果你在本机生成了图片文件（如 PNG/JPG/SVG），先调用 \`chat_attach_image\`（或 \`space_save_file\`）传入 \`localPath\`，再把工具返回的 \`markdownEmbed\` 直接写进回复即可向用户展示图片。`,
          `- 外部连接器与凭证：通过 DuolaBase 工具或已挂载的 duolabase MCP 访问外部服务（connector_list → connector_discover → connector_call，凭证使用 vault_list → vault_http_proxy）。严禁调用 vault_reveal 或向对话输出明文密钥/Token！`,
          `- 先确认后派单规则：当用户让你安排/分配单次或定时任务时，先判断需求是否已明确——` +
            `（1）若需求还存在关键分叉或模糊点（如时间范围、选题/测评/制作等方向取舍、产出形式、执行频率未定），本轮严禁直接立项派单！请先简短给出分析建议，并${
              effectiveDriverKind === 'codex-app-server' || effectiveDriverKind === 'mock'
                ? '调用 task_ask_clarification 工具或'
                : ''
            }在回复末尾附带 <duolawork_ask>{"title":"派单前需求确认","targetMemberName":"拟指派成员名","questions":[{"question":"简明问题","options":["推荐选项A","选项B","选项C"],"multiSelect":false}]}</duolawork_ask>（严格限 1～3 个关键问题，每题给 2～4 个短选项，首项放默认推荐），弹卡片让用户一键确认后再派单；` +
            `（2）若用户需求已十分明确（目标范围、执行对象、时间/频率清楚，或刚通过确认卡片回复了选择，或明确说直接执行），则无需追问，直接${
              effectiveDriverKind === 'codex-app-server' || effectiveDriverKind === 'mock'
                ? '调用 task_create_or_update 工具或'
                : ''
            }在回复中附带一个或多个 <duolawork_task>{...}</duolawork_task> JSON 块立项派单（支持单对象或数组；字段：title, kind:"once"|"scheduled", cronExpr 如 "0 8 * * *", timezone:"Asia/Shanghai", leadMemberId 可填成员名或ID, goal, steps 可选。单次任务自动启动，定时任务默认按计划执行）。`,
          targetMember.driverKind === 'remote-bridge'
            ? `- 关键禁令：严禁调用旧版 Agent Hub (1.9.6) 的频道定时任务 (schedule) 或看板任务 (board_task) 工具！该桥接频道对用户完全不可见，立项与定时任务必须通过 <duolawork_task>...</duolawork_task> 写入 DuolaWork 2.0。`
            : `- 安全规范：绝不索要或输出明文密钥，外部服务通过 DuolaBase 连接器与 Vault HTTP 代理按授权访问。`,
          `</duolawork_v2_protocol>`
        ].join('\n')
      : '';

    const spaceMaterialsSummary =
      this.actionHandler?.getSpaceMaterialsSummaryForThread?.(thread.id, {
        includeLocalPaths: targetMember.location === 'local' || targetMember.location === 'local-node'
      }) ?? '';

    const compactBridgeGuard =
      targetMember.driverKind === 'remote-bridge'
        ? `\n重要环境提醒：你在 DuolaWork 2.0 桥接会话中，严禁调用旧版 Hub 的 schedule / board_task 工具（用户完全看不到）！需求尚有模糊点时先用 <duolawork_ask>...</duolawork_ask> 提 1～3 个问题确认；需求已明确或用户已确认时，在回复中输出一个或多个 <duolawork_task>{"title":"任务名称","kind":"once"|"scheduled","cronExpr":"0 8 * * *","timezone":"Asia/Shanghai","leadMemberId":"${targetMember.name}","goal":"完整执行要求"}</duolawork_task>（支持数组；可用成员：${memberNamesSummary || targetMember.name}）。`
        : '';

    const driverActionHint =
      effectiveDriverKind === 'remote-bridge' ||
      effectiveDriverKind === 'acp-stdio' ||
      effectiveDriverKind === 'claude-cli'
        ? `[结构化指令说明：① 派单前确认（若需求存在模糊/分叉，或用户点名的执行成员显示状态:offline/auth_required 不可用时，必须先确认，切勿直接派单）：附带 <duolawork_ask>{"title":"派单前需求确认","targetMemberName":"拟指派成员名","questions":[{"question":"问题（共1~3题；若原指派人offline，第1题请提供改派给在线成员如Gemini2VPS/Codex/Gemini (本机)的选项）","options":["推荐项A","选项B","选项C"],"multiSelect":false}]}</duolawork_ask>；② 正式创建任务（仅在需求已明确且指派成员状态正常，或用户已确认后使用）：附带一个或多个 <duolawork_task>{"title":"任务名称","kind":"once"|"scheduled","cronExpr":"0 8 * * *","timezone":"Asia/Shanghai","leadMemberId":"${targetMember.name}","goal":"执行说明"}</duolawork_task>（支持 JSON 数组，steps 可省略，当前团队成员及状态：${memberNamesSummary || targetMember.name}）；③ 写入右侧协作空间（支持任意格式文件与文件夹）：${
            hasNativeSpaceTools
              ? '向外部连接器上传图片或文件时，先用 space_save_file(localPath) 保存，再用 space_upload_to_connector 传文件 ID，让工作台传输原始字节。优先直接调用已挂载的 space_create_folder / space_save_file(支持content/dataBase64/localPath) / space_save_document / space_save_link / space_move_item 工具，也'
              : ''
          }可附带 <duolawork_folder path="目录/子目录" />、<duolawork_file name="任意文件.csv" folder="可选目录" encoding="utf8|base64">内容</duolawork_file>、<duolawork_artifact title="标题.md" folder="可选目录">正文</duolawork_artifact>、<duolawork_link title="标题" url="https://..." folder="可选目录">备注</duolawork_link>。普通回答直接输出自然语言，切勿输出内部调试词。${compactBridgeGuard}]`
        : '';

    const formatPromptForDriver = (packet: BuiltHandoffPacket): string => {
      const parts: string[] = [];
      if (protocolBrief) parts.push(protocolBrief);
      if (spaceMaterialsSummary) parts.push(`[协作空间资料]\n${spaceMaterialsSummary}`);
      parts.push(packet.fullPrompt);
      if (driverActionHint) parts.push(driverActionHint);
      return parts.join('\n\n');
    };

    const initialPacket = buildPacket(false);
    let activePacket: BuiltHandoffPacket = initialPacket;
    let fullFallbackPacket: BuiltHandoffPacket | null = null;
    let didSessionResetInEnsure = false;

    const attemptId = 'att_' + randomUUID().slice(0, 12);
    this.db.sqlite
      .prepare(`UPDATE v2_thread_messages SET attempt_id = ? WHERE id = ?`)
      .run(attemptId, placeholderAgentMsg.id);

    const claims = this.sandbox.issueScopedToken({
      principalKind: 'thread_owner',
      memberId: targetMember.id,
      attemptId,
      threadId: thread.id,
      allowedArtifactIds: pinnedArtifactId ? [pinnedArtifactId] : [],
      ttlMs: Math.max(30 * 60_000, input.timeoutMs ?? CHAT_MAX_MS) + 60_000,
      toolPolicy: 'duolabase_full'
    });

    const cwd =
      thread.workspacePath ||
      path.join(os.tmpdir(), 'duolawork-v2-workspaces', thread.id);

    const dynamicTools = this.buildThreadOwnerTools();
    const promptForDriver = formatPromptForDriver(initialPacket);

    // Extract any user-attached chat/space images referenced in this message for multimodal delivery
    const turnImages: TurnImageAttachment[] = [];
    if (this.space) {
      const seenImgKeys = new Set<string>();
      const imgRefRegex = /!\[[^\]]*\]\((\/api\/v2\/(?:chat-images|space\/files)\/([^)?#\s]+))\)/g;
      let im: RegExpExecArray | null;
      while ((im = imgRefRegex.exec(input.continuationContext || cleanBody)) !== null && turnImages.length < 6) {
        const fullUrl = im[1];
        const rawId = decodeURIComponent(im[2]);
        if (seenImgKeys.has(fullUrl)) continue;
        seenImgKeys.add(fullUrl);
        try {
          if (fullUrl.startsWith('/api/v2/chat-images/')) {
            const found = this.space.getChatImageWithPath(rawId);
            if (found && found.image.threadId === thread.id && found.image.sizeBytes <= 10 * 1024 * 1024) {
              turnImages.push({
                id: found.image.id,
                name: found.image.name,
                mimeType: found.image.mimeType,
                dataBase64: fs.readFileSync(found.absPath).toString('base64'),
                localPath: found.absPath
              });
            }
          } else if (fullUrl.startsWith('/api/v2/space/files/')) {
            const found = this.space.getFileWithPath(rawId);
            if (
              found &&
              found.file.threadId === thread.id &&
              found.file.mimeType.startsWith('image/') &&
              found.file.sizeBytes <= 10 * 1024 * 1024
            ) {
              turnImages.push({
                id: found.file.id,
                name: found.file.name,
                mimeType: found.file.mimeType,
                dataBase64: fs.readFileSync(found.absPath).toString('base64'),
                localPath: found.absPath
              });
            }
          }
        } catch {
          // ignore unreadable image attachment
        }
      }
    }

    const toolTrace: ToolTraceItem[] = [];
    const toolIndexes = new Map<string, number>();
    const live = { activity: { phase: 'processing', revision: ++this.activityRevision } as TurnActivity, tools: toolTrace };
    this.liveTurns.set(placeholderAgentMsg.id, live);
    const setActivity = (phase: TurnPhase) => {
      if (live.activity.phase === phase || this.liveTurns.get(placeholderAgentMsg.id) !== live) return;
      live.activity = { phase, revision: ++this.activityRevision };
      this.emit({
        type: 'thread.activity', threadId: thread.id,
        payload: { messageId: placeholderAgentMsg.id, activity: live.activity }
      });
    };
    let toolClarificationCard: ClarificationCardData | null = null;
    try {
      const beforeDispatchMsg = this.getMessage(placeholderAgentMsg.id);
      if (beforeDispatchMsg?.turnStatus === 'canceled') {
        return {
          userMessage: userMsg,
          agentMessage: beforeDispatchMsg,
          handoffBytes: 0
        };
      }

      const dispatchIdempotencyKey = cleanClientKey
        ? `${cleanClientKey}${retryAttemptKeySuffix}`
        : `thread_msg:${userMsg.id}`;
      const { attempt, result } = await this.registry.dispatchTurn({
        attemptId,
        idempotencyKey: dispatchIdempotencyKey,
        targetKind: 'thread_message',
        targetId: placeholderAgentMsg.id,
        threadId: thread.id,
        member: targetMember,
        scopeKey: `thread:${thread.id}:${targetMember.id}`,
        cwd,
        existingNativeSessionId: cursor?.nativeSessionId ?? null,
        existingBridgeMeta,
        baseArtifactId: pinnedArtifactId,
        baseArtifactVersion: pinnedArtifactVersion,
        prompt: promptForDriver,
        handoffBytes: initialPacket.handoffBytes,
        toolPolicy: claims.toolPolicy,
        resolvePrompt: ({ forceFullContext, sessionWasReset }) => {
          didSessionResetInEnsure = sessionWasReset;
          activePacket = forceFullContext ? buildPacket(true) : initialPacket;
          fullFallbackPacket = forceFullContext ? activePacket : buildPacket(true);
          return {
            prompt: formatPromptForDriver(activePacket),
            fallbackFullPrompt: formatPromptForDriver(fullFallbackPacket),
            handoffBytes: activePacket.handoffBytes,
            fallbackHandoffBytes: fullFallbackPacket.handoffBytes
          };
        },
        timeoutMs: input.timeoutMs,
        dynamicTools,
        ...(turnImages.length > 0 ? { images: turnImages } : {}),
        onToolCall: async (toolName, args) => {
          if (!this.actionHandler) throw new Error('Action handler not bound');
          if (toolName === 'task_ask_clarification') {
            await this.actionHandler.executeTool(claims, toolName, args);
            const parsedCard = normalizeClarificationCard(args);
            if (!parsedCard) {
              throw new Error('确认卡片至少需要包含 1～3 个有效问题 (questions)');
            }
            toolClarificationCard = parsedCard;
            return {
              ok: true,
              status: 'clarification_card_queued',
              note: '已生成派单前需求确认卡片，请勿在本回合调用 task_create_or_update，等待用户确认后再立项。'
            };
          }
          if (toolName === 'task_create_or_update' && toolClarificationCard) {
            return {
              skipped: true,
              reason: '当前回合已发起派单前需求确认卡片，请等待用户确认后再创建任务'
            };
          }
          // Pin baseArtifactVersion if agent calls artifact_write without explicit expectedBaseVersion
          if (toolName === 'artifact_write' && args.expectedBaseVersion === undefined && pinnedArtifactVersion !== null) {
            args = { ...args, expectedBaseVersion: pinnedArtifactVersion };
          }
          return this.actionHandler.executeTool(claims, toolName, args);
        },
        onEvent: (ev) => {
          if (ev.kind === 'waiting_for_receipt') {
            this.markWaitingForReceipt(placeholderAgentMsg.id);
          } else if (ev.kind === 'activity' && ev.phase) {
            // A reasoning block can finish after a tool or text stream has already started.
            if (ev.phase !== 'processing' || ['thinking', 'queued', 'reconnecting'].includes(live.activity.phase)) setActivity(ev.phase);
          } else if (ev.kind === 'delta' && ev.text) {
            setActivity('writing');
            this.emit({
              type: 'thread.delta',
              threadId: thread.id,
              payload: { messageId: placeholderAgentMsg.id, text: ev.text }
            });
          } else if (ev.kind === 'tool' && ev.toolName) {
            const sumKind = ev.toolName === '执行命令' || ev.toolName === 'Bash' ? 'command' : 'tool';
            const cleanSummary = ev.toolSummary ? sanitizeToolSummary(sumKind, ev.toolSummary) : undefined;
            const item: ToolTraceItem = {
              ...(ev.toolId ? { id: ev.toolId } : {}),
              name: redactSecrets(ev.toolName, 240),
              ...(cleanSummary ? { summary: cleanSummary } : {}),
              status: ev.toolStatus ?? 'running'
            };
            const existingIdx = item.id ? toolIndexes.get(item.id) : undefined;
            if (existingIdx !== undefined) {
              toolTrace[existingIdx] = { ...toolTrace[existingIdx], ...item };
            } else {
              if (item.id) toolIndexes.set(item.id, toolTrace.length);
              toolTrace.push(item);
            }
            if (item.status === 'running') setActivity('executing');
            else if (live.activity.phase === 'executing' && !toolTrace.some(t => t.status === 'running')) setActivity('processing');
            this.emit({
              type: 'thread.tool',
              threadId: thread.id,
              payload: toolTrace.length <= 20
                ? { messageId: placeholderAgentMsg.id, toolTrace: [...toolTrace] }
                : { messageId: placeholderAgentMsg.id, index: existingIdx ?? toolTrace.length - 1,
                    item: toolTrace[existingIdx ?? toolTrace.length - 1] }
            });
          }
        }
      });

      const effectivePacket =
        result.sessionReset && fullFallbackPacket ? fullFallbackPacket : activePacket;

      const settledToolTrace = toolTrace.map((t) =>
        t.status === 'running' ? { ...t, status: 'done' as const } : t
      );

      const postDispatchMsg = this.getMessage(placeholderAgentMsg.id);
      if (postDispatchMsg?.turnStatus === 'canceled') {
        return {
          userMessage: userMsg,
          agentMessage: postDispatchMsg,
          handoffBytes: effectivePacket.handoffBytes
        };
      }

      const cleanedBody = await this.applyInlineArtifactAndActions(
        result.text,
        claims,
        pinnedArtifactId,
        pinnedArtifactVersion,
        placeholderAgentMsg.id,
        toolClarificationCard
      );

      const now = new Date().toISOString();
      this.db.sqlite
        .prepare(
          `UPDATE v2_thread_messages
           SET body = ?, turn_status = 'completed', usage_json = ?, tool_trace_json = ?, updated_at = ?
           WHERE id = ? AND turn_status != 'canceled'`
        )
        .run(
          cleanedBody,
          JSON.stringify(attempt.usage),
          settledToolTrace.length > 0 ? JSON.stringify(settledToolTrace) : null,
          now,
          placeholderAgentMsg.id
        );

      let finalMsg = this.getMessage(placeholderAgentMsg.id)!;
      if (finalMsg.turnStatus !== 'canceled') {
        const deliveredRevisionsPatch: Record<string, string> = {
          ...effectivePacket.coveredMessageRevisions,
          [userMsg.id]: computeMessageRevision(userMsg),
          [finalMsg.id]: computeMessageRevision(finalMsg)
        };
        // Advance handoff cursor ONLY after confirmed delivery (and persist bridgeMeta + deliveredRevisions + protocolEpoch to SQLite)!
        this.handoff.confirmHandoffDelivered(
          thread.id,
          targetMember.id,
          placeholderAgentMsg.seq,
          result.nativeSessionId,
          result.bridgeMeta ?? existingBridgeMeta,
          deliveredRevisionsPatch,
          protocolVersion
        );

        const deliveredReason: HandoffNoticeMeta['reason'] =
          didSessionResetInEnsure || result.sessionReset
            ? 'session_reset'
            : effectivePacket.lateArrivalSeqs.length > 0
              ? 'late_arrival'
              : effectivePacket.meta.reason;

        const deliveredMeta: HandoffNoticeMeta = {
          ...effectivePacket.meta,
          status: 'delivered',
          reason: pendingSwitchNotice ? 'member_switch' : deliveredReason,
          deliveredAt: now
        };

        if (pendingSwitchNotice) {
          this.db.sqlite
            .prepare(`UPDATE v2_thread_messages SET handoff_meta_json = ?, updated_at = ?
                      WHERE id = ? AND json_extract(handoff_meta_json, '$.status') = 'pending'`)
            .run(JSON.stringify(deliveredMeta), now, pendingSwitchNotice.id);
          const updatedNotice = this.getMessage(pendingSwitchNotice.id);
          if (updatedNotice) {
            this.emit({ type: 'thread.message_updated', threadId: thread.id, payload: updatedNotice });
          }
        } else if (
          effectivePacket.handoffRequired &&
          (didSessionResetInEnsure ||
            result.sessionReset ||
            effectivePacket.lateArrivalSeqs.length > 0 ||
            (effectivePacket.strategy === 'full_thread_summary' && effectivePacket.includedCount > 0))
        ) {
          this.db.sqlite
            .prepare(`UPDATE v2_thread_messages SET handoff_meta_json = ? WHERE id = ?`)
            .run(JSON.stringify(deliveredMeta), placeholderAgentMsg.id);
          finalMsg = this.getMessage(placeholderAgentMsg.id)!;
        }

        this.emit({ type: 'thread.message_updated', threadId: thread.id, payload: finalMsg });
      }

      return {
        userMessage: userMsg,
        agentMessage: finalMsg,
        handoffBytes: effectivePacket.handoffBytes
      };
    } catch (err) {
      const now = new Date().toISOString();
      const errText = (err as Error).message || '请求未完成';
      const currentMsg = this.getMessage(placeholderAgentMsg.id);
      if (this.registry.getAttempt(attemptId)?.status === 'reconciling' && currentMsg?.turnStatus === 'running') {
        this.db.sqlite.prepare(`UPDATE v2_thread_messages SET body=?, tool_trace_json=?, updated_at=? WHERE id=? AND turn_status='running'`)
          .run('正在恢复执行连接', JSON.stringify(toolTrace), now, currentMsg.id);
        const recovering = this.getMessage(currentMsg.id)!;
        this.emit({ type: 'thread.message_updated', threadId: thread.id, payload: recovering });
        return { userMessage: userMsg, agentMessage: recovering, handoffBytes: activePacket.handoffBytes };
      }
      if (currentMsg?.turnStatus === 'completed') {
        return { userMessage: userMsg, agentMessage: currentMsg, handoffBytes: activePacket.handoffBytes };
      }
      if (
        currentMsg?.turnStatus === 'canceled' ||
        /ATTEMPT_CANCELED|已由用户停止|已停止本轮生成|任务已取消|回合已取消/i.test(errText)
      ) {
        const canceledTrace = toolTrace.map((t) =>
          t.status === 'running' ? { ...t, status: 'error' as const } : t
        );
        this.db.sqlite
          .prepare(
            `UPDATE v2_thread_messages
             SET turn_status = 'canceled',
                 body = CASE WHEN trim(body) = '' THEN '已停止本轮生成' ELSE body END,
                 tool_trace_json = COALESCE(?, tool_trace_json),
                 updated_at = ?
             WHERE id = ?`
          )
          .run(
            canceledTrace.length > 0 ? JSON.stringify(canceledTrace) : null,
            now,
            placeholderAgentMsg.id
          );
        const canceledMsg = this.getMessage(placeholderAgentMsg.id)!;
        this.emit({ type: 'thread.message_updated', threadId: thread.id, payload: canceledMsg });
        return {
          userMessage: userMsg,
          agentMessage: canceledMsg,
          handoffBytes: activePacket.handoffBytes
        };
      }
      const failedTrace = toolTrace.map((t) =>
        t.status === 'running' ? { ...t, status: 'error' as const } : t
      );
      this.db.sqlite
        .prepare(
          `UPDATE v2_thread_messages
           SET body = ?, turn_status = 'failed', tool_trace_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          errText === 'ATTEMPT_TIMED_OUT'
            ? chatTimeoutMessage(this.registry.getAttempt(attemptId)?.errorMessage)
            : `暂时未能收到回复：${errText}`,
          failedTrace.length > 0 ? JSON.stringify(failedTrace) : null,
          now,
          placeholderAgentMsg.id
        );
      const failedMsg = this.getMessage(placeholderAgentMsg.id)!;
      this.emit({ type: 'thread.message_updated', threadId: thread.id, payload: failedMsg });
      if (err && typeof err === 'object') {
        (err as Record<string, unknown>).persistedUserMessageId = userMsg.id;
      }
      throw err;
    } finally {
      if (this.liveTurns.get(placeholderAgentMsg.id) === live) this.liveTurns.delete(placeholderAgentMsg.id);
      this.sandbox.revokeToken(claims.token);
    }
  }

  public markWaitingForReceipt(messageId: string): void {
    const changed = this.db.sqlite.prepare(
      `UPDATE v2_thread_messages SET body = '执行结束，等待回执', updated_at = ?
       WHERE id = ? AND turn_status = 'running' AND body = ''`
    ).run(new Date().toISOString(), messageId);
    if (changed.changes) {
      const message = this.getMessage(messageId)!;
      this.emit({ type: 'thread.message_updated', threadId: message.threadId, payload: message });
    }
  }

  /**
   * Synchronizes any reconciled attempts back into their pinned `v2_thread_messages` rows
   * and advances the member's handoff cursor (including `bridge_meta_json` & settled revisions)
   * without re-running the model!
   */
  public syncReconciledThreadTurns(): ThreadMessageRecord[] {
    const rows = this.db.sqlite
      .prepare(
        `SELECT m.id AS msg_id, m.thread_id, m.seq, m.author_id, m.turn_status, m.inline_actions_applied,
                a.id AS att_id, a.response_text, a.native_session_id, a.usage_json,
                a.bridge_meta_json, a.dispatched_at,
                a.base_artifact_id, a.base_artifact_version
         FROM v2_thread_messages m
         JOIN v2_dispatch_attempts a ON m.attempt_id = a.id
         WHERE (
           m.turn_status IN ('running', 'failed')
           OR (
             m.author_kind = 'agent'
             AND m.turn_status = 'completed'
             AND m.inline_actions_applied = 0
             AND (
               a.response_text LIKE '%<duolawork_artifact%'
               OR a.response_text LIKE '%<duolawork_task%'
               OR a.response_text LIKE '%<duolawork_folder%'
               OR a.response_text LIKE '%<duolawork_file%'
               OR a.response_text LIKE '%<duolawork_link%'
             )
           )
         )
           AND a.status = 'succeeded'
           AND a.response_text IS NOT NULL`
      )
      .all() as Record<string, unknown>[];

    const updated: ThreadMessageRecord[] = [];
    for (const r of rows) {
      const msgId = String(r.msg_id);
      const threadId = String(r.thread_id);
      const memberId = String(r.author_id);
      const seqNum = Number(r.seq);
      const dispatchedAt = r.dispatched_at ? String(r.dispatched_at) : '';
      const rawText = String(r.response_text);
      const pinnedArtId = r.base_artifact_id ? String(r.base_artifact_id) : null;
      const pinnedArtVer =
        r.base_artifact_version !== null && r.base_artifact_version !== undefined
          ? Number(r.base_artifact_version)
          : null;

      const recClaims = this.sandbox.issueScopedToken({
        principalKind: 'thread_owner',
        memberId,
        attemptId: String(r.att_id),
        threadId,
        allowedArtifactIds: pinnedArtId ? [pinnedArtId] : [],
        toolPolicy: 'duolabase_full'
      });

      let cleanText: string;
      try {
        cleanText = this.applyInlineArtifactAndActionsSync(
          rawText,
          recClaims,
          pinnedArtId,
          pinnedArtVer,
          msgId
        );
      } finally {
        this.sandbox.revokeToken(recClaims.token);
      }

      let parsedBridgeMeta: Record<string, unknown> | null | undefined = undefined;
      if (typeof r.bridge_meta_json === 'string' && r.bridge_meta_json) {
        try {
          parsedBridgeMeta = JSON.parse(r.bridge_meta_json) as Record<string, unknown>;
        } catch {
          parsedBridgeMeta = undefined;
        }
      }

      const now = new Date().toISOString();
      this.db.sqlite
        .prepare(
          `UPDATE v2_thread_messages
           SET body = ?, turn_status = 'completed', usage_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(cleanText, String(r.usage_json), now, msgId);

      const reconciledMsg = this.getMessage(msgId)!;
      if ((this.handoff.getCursor(threadId, memberId)?.lastSeenSeq ?? 0) > seqNum) {
        // A newer turn already established the native session and its handoff cursor.
        this.emit({ type: 'thread.message_updated', threadId, payload: reconciledMsg });
        updated.push(reconciledMsg);
        continue;
      }
      const threadMsgs = this.listMessages(threadId, { toSeq: seqNum });
      const deliveredRevisionsPatch: Record<string, string> = {};
      for (const tm of threadMsgs) {
        if (!isMessageDeliverable(tm)) continue;
        if (tm.id === msgId || !dispatchedAt || tm.updatedAt <= dispatchedAt) {
          deliveredRevisionsPatch[tm.id] = computeMessageRevision(tm);
        }
      }

      this.handoff.confirmHandoffDelivered(
        threadId,
        memberId,
        seqNum,
        r.native_session_id ? String(r.native_session_id) : null,
        parsedBridgeMeta,
        deliveredRevisionsPatch,
        this.getProtocolVersion()
      );
      const pendingNotice = pendingOwnerSwitch(threadMsgs, memberId);
      if (pendingNotice?.handoffMeta) {
        const settledMeta: HandoffNoticeMeta = {
          ...pendingNotice.handoffMeta,
          status: 'delivered',
          strategy: pendingNotice.handoffMeta.strategy ?? 'delta_since_target_last_seen',
          reason: 'member_switch',
          deliveredAt: now
        };
        this.db.sqlite
          .prepare(`UPDATE v2_thread_messages SET handoff_meta_json = ?, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify(settledMeta), now, pendingNotice.id);
        const updatedNotice = this.getMessage(pendingNotice.id);
        if (updatedNotice) {
          this.emit({ type: 'thread.message_updated', threadId, payload: updatedNotice });
        }
      }
      this.emit({ type: 'thread.message_updated', threadId, payload: reconciledMsg });
      updated.push(reconciledMsg);
    }

    // Also settle any thread messages still marked `running` whose linked attempt failed / timed out.
    const failedRows = this.db.sqlite
      .prepare(
        `SELECT m.id AS msg_id, m.thread_id, m.body, a.status AS att_status, a.error_message
         FROM v2_thread_messages m
         JOIN v2_dispatch_attempts a ON m.attempt_id = a.id
         WHERE m.turn_status = 'running'
           AND a.status IN ('failed', 'timed_out', 'late_ignored')`
      )
      .all() as Array<{
        msg_id: string;
        thread_id: string;
        body: string;
        att_status: string;
        error_message: string | null;
      }>;

    for (const r of failedRows) {
      const now = new Date().toISOString();
      const reason =
        r.error_message?.trim() ||
        (r.att_status === 'timed_out' ? '执行超时，请重试' : '应用重启或远端中断，未能收到回复，请重试');
      const fallbackBody = ['timed_out', 'late_ignored'].includes(r.att_status)
        ? chatTimeoutMessage(r.error_message)
        : (r.body === '正在恢复执行连接' || r.body === '执行结束，等待回执' ? '' : String(r.body || '').trim()) || `暂时未能收到回复：${reason}`;
      this.db.sqlite
        .prepare(
          `UPDATE v2_thread_messages
           SET body = ?, turn_status = 'failed', updated_at = ?
           WHERE id = ? AND turn_status = 'running'`
        )
        .run(fallbackBody, now, r.msg_id);
      const settled = this.getMessage(r.msg_id);
      if (settled) {
        this.emit({ type: 'thread.message_updated', threadId: r.thread_id, payload: settled });
        updated.push(settled);
      }
    }

    // Settle orphan `running` messages with missing attempt rows (e.g. crashed before dispatch).
    const orphanCutoff = new Date(Date.now() - 30_000).toISOString();
    const orphanRows = this.db.sqlite
      .prepare(
        `SELECT m.id AS msg_id, m.thread_id, m.body
         FROM v2_thread_messages m
         LEFT JOIN v2_dispatch_attempts a ON m.attempt_id = a.id
         WHERE m.turn_status = 'running'
           AND m.author_kind = 'agent'
           AND a.id IS NULL
           AND m.created_at < ?`
      )
      .all(orphanCutoff) as Array<{ msg_id: string; thread_id: string; body: string }>;

    for (const r of orphanRows) {
      const now = new Date().toISOString();
      const fallbackBody = String(r.body || '').trim()
        ? String(r.body)
        : '暂时未能收到回复：应用重启导致本轮执行中断，请重新发送';
      this.db.sqlite
        .prepare(
          `UPDATE v2_thread_messages
           SET body = ?, turn_status = 'failed', updated_at = ?
           WHERE id = ? AND turn_status = 'running'`
        )
        .run(fallbackBody, now, r.msg_id);
      const settled = this.getMessage(r.msg_id);
      if (settled) {
        this.emit({ type: 'thread.message_updated', threadId: r.thread_id, payload: settled });
        updated.push(settled);
      }
    }

    return updated;
  }

  /**
   * Read-only preview of what context handoff packet would be sent right now for `memberId`.
   */
  public previewPendingHandoff(
    threadId: string,
    memberId?: string
  ): {
    meta: HandoffNoticeMeta;
    cursor: { lastSeenSeq: number; hasNativeSession: boolean };
  } {
    const thread = this.getThread(threadId);
    if (!thread) throw new Error(`对话不存在: ${threadId}`);
    const targetMemberId = memberId || thread.activeOwnerMemberId;
    const targetMember = this.db.getMember(targetMemberId);
    if (!targetMember) throw new Error(`成员不存在: ${targetMemberId}`);

    const priorMessages = this.listMessages(threadId);
    const boundArtifact = thread.boundArtifactId
      ? this.artifacts.getArtifact(thread.boundArtifactId)
      : null;
    const activeTasksSummary =
      this.actionHandler?.getActiveTasksSummaryForThread(thread.id) ?? [];
    const memberNameById = new Map(this.db.listMembers().map((m) => [m.id, m.name]));
    const effectiveDriverKind = resolveEffectiveDriverKind(targetMember);
    const canReadHistoryTool =
      effectiveDriverKind === 'codex-app-server' || effectiveDriverKind === 'mock';

    const pendingFrom = pendingOwnerSwitch(priorMessages, targetMemberId)?.handoffMeta?.fromMemberId ?? null;

    const nextSeq = (priorMessages[priorMessages.length - 1]?.seq ?? 0) + 1;
    const packet = this.handoff.buildPromptWithBoundedHandoff({
      threadId,
      targetMemberId,
      fromMemberId: pendingFrom,
      currentUserSeq: nextSeq,
      currentUserBody: '(下一条消息)',
      priorMessages,
      boundArtifact,
      activeTasksSummary,
      memberNameById,
      canReadHistoryTool,
      tokenBudgetMember: targetMember
    });
    const cursor = this.handoff.getCursor(threadId, targetMemberId);
    return {
      meta: {
        ...packet.meta,
        status: 'pending',
        fromMemberId: pendingFrom
      },
      cursor: {
        lastSeenSeq: cursor?.lastSeenSeq ?? 0,
        hasNativeSession: Boolean(cursor?.nativeSessionId)
      }
    };
  }

  private getActionReceipt(actionKey: string): string | null {
    const row = this.db.sqlite
      .prepare(`SELECT result_id FROM v2_inline_action_receipts WHERE action_key = ?`)
      .get(actionKey) as { result_id: string } | undefined;
    return row ? String(row.result_id) : null;
  }

  private saveActionReceipt(
    actionKey: string,
    messageId: string,
    actionKind: string,
    resultId: string
  ): void {
    this.db.sqlite
      .prepare(
        `INSERT OR IGNORE INTO v2_inline_action_receipts (
          action_key, message_id, action_kind, result_id, created_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(actionKey, messageId, actionKind, resultId, new Date().toISOString());
  }

  private processInlineArtifactsWithReceipts(
    rawText: string,
    claims: ScopedTurnClaims,
    pinnedArtifactId: string | null,
    pinnedArtifactVersion: number | null,
    keyOwner: string
  ): { cleaned: string; hadUnhandledError: boolean } {
    let currentArtifactId = pinnedArtifactId;
    let currentBaseVer = pinnedArtifactVersion;
    let spaceChanged = false;
    const unsavedDocuments: string[] = [];
    let blockIndex = 0;
    let folderIndex = 0;
    let fileIndex = 0;
    let linkIndex = 0;
    let hadUnhandledError = false;

    let cleaned = rawText;

    // 1. Inline <duolawork_folder path="a/b" /> or <duolawork_folder>a/b</duolawork_folder>
    cleaned = stripInlineFolderBlocks(cleaned, (folderPath) => {
      const idx = folderIndex++;
      const actionKey = `inline_folder:${keyOwner}:${idx}`;
      if (this.getActionReceipt(actionKey)) return;
      if (!this.space || !folderPath) return;
      try {
        const created = this.space.ensureFolderPath(claims.threadId, folderPath);
        this.saveActionReceipt(actionKey, keyOwner, 'folder_create', created.id);
        spaceChanged = true;
      } catch {
        hadUnhandledError = true;
      }
    });

    // 2. Inline <duolawork_artifact title="..." folder="...">Markdown</duolawork_artifact>
    cleaned = stripInlineArtifactBlock(cleaned, (title, content, folderPath) => {
      const idx = blockIndex++;
      const actionKey = `inline_artifact:${keyOwner}:${idx}`;
      const existingReceiptId = this.getActionReceipt(actionKey);
      if (existingReceiptId) {
        currentArtifactId = existingReceiptId;
        currentBaseVer = this.artifacts.getArtifact(existingReceiptId)?.headVersion ?? currentBaseVer;
        return;
      }

      try {
        this.db.inTransaction(() => {
          if (this.space && (folderPath || title)) {
            const existingBound = currentArtifactId ? this.artifacts.getArtifact(currentArtifactId) : null;
            const matchesBound =
              Boolean(existingBound) &&
              !folderPath &&
              (!title || existingBound!.title.toLowerCase() === title.toLowerCase());
            if (matchesBound && currentArtifactId && currentBaseVer !== null) {
              const written = this.artifacts.writeArtifact({
                artifactId: currentArtifactId,
                expectedBaseVersion: currentBaseVer,
                title: title || undefined,
                content,
                writerKind: 'agent',
                writerId: claims.memberId,
                attemptId: claims.attemptId
              });
              currentBaseVer = written.artifact.headVersion;
              this.saveActionReceipt(actionKey, keyOwner, 'artifact_write', currentArtifactId);
              spaceChanged = true;
              return;
            }
            const saved = this.space.saveOrUpdateDocumentForAgent({
              threadId: claims.threadId,
              title: title || existingBound?.title || '对话文稿.md',
              content,
              folderPath: folderPath || undefined,
              writerId: claims.memberId,
              attemptId: claims.attemptId
            });
            currentArtifactId = saved.artifact.id;
            currentBaseVer = saved.artifact.headVersion;
            this.saveActionReceipt(
              actionKey,
              keyOwner,
              saved.created ? 'artifact_create' : 'artifact_write',
              saved.artifact.id
            );
            spaceChanged = true;
            return;
          }

          if (!currentArtifactId) {
            const curThread = this.getThread(claims.threadId);
            if (curThread?.boundArtifactId) {
              const bound = this.artifacts.getArtifact(curThread.boundArtifactId);
              if (bound) {
                currentArtifactId = bound.id;
                currentBaseVer = bound.headVersion;
              }
            }
          }

          if (currentArtifactId && currentBaseVer !== null) {
            const written = this.artifacts.writeArtifact({
              artifactId: currentArtifactId,
              expectedBaseVersion: currentBaseVer,
              title: title || undefined,
              content,
              writerKind: 'agent',
              writerId: claims.memberId,
              attemptId: claims.attemptId
            });
            currentBaseVer = written.artifact.headVersion;
            this.saveActionReceipt(actionKey, keyOwner, 'artifact_write', currentArtifactId);
            spaceChanged = true;
          } else {
            const created = this.artifacts.createArtifact({
              sourceThreadId: claims.threadId,
              title: title || '对话文稿.md',
              content,
              writerKind: 'agent',
              writerId: claims.memberId,
              attemptId: claims.attemptId
            });
            currentArtifactId = created.id;
            currentBaseVer = created.headVersion;
            this.db.sqlite
              .prepare(`UPDATE v2_threads SET bound_artifact_id = COALESCE(bound_artifact_id, ?) WHERE id = ?`)
              .run(created.id, claims.threadId);
            this.saveActionReceipt(actionKey, keyOwner, 'artifact_create', created.id);
            spaceChanged = true;
          }
        });
      } catch (error) {
        unsavedDocuments.push('文档「' + (title || '对话文稿') + '」未能保存：' + (error as Error).message + '\n\n' + content);
      }
    });

    // 3. Inline <duolawork_file name="..." folder="..." mime="..." encoding="utf8|base64">...</duolawork_file>
    cleaned = stripInlineFileBlocks(cleaned, (spec) => {
      const idx = fileIndex++;
      const actionKey = `inline_file:${keyOwner}:${idx}`;
      if (this.getActionReceipt(actionKey)) return;
      if (!this.space || !spec.name) return;
      try {
        const isBase64 = (spec.encoding || '').toLowerCase() === 'base64';
        const saved = this.space.saveOrUpdateFileForAgent({
          threadId: claims.threadId,
          name: spec.name,
          content: isBase64 ? undefined : spec.body,
          dataBase64: isBase64 ? spec.body : undefined,
          mimeType: spec.mimeType,
          folderPath: spec.folderPath,
          uploaderId: claims.memberId,
          replaceExisting: true
        });
        this.saveActionReceipt(actionKey, keyOwner, 'file_save', saved.file.id);
        spaceChanged = true;
      } catch {
        hadUnhandledError = true;
      }
    });

    // 4. Inline <duolawork_link title="..." url="..." folder="...">note</duolawork_link>
    cleaned = stripInlineLinkBlocks(cleaned, (spec) => {
      const idx = linkIndex++;
      const actionKey = `inline_link:${keyOwner}:${idx}`;
      if (this.getActionReceipt(actionKey)) return;
      if (!this.space || !spec.url) return;
      try {
        const folderId = this.space.resolveTargetFolderId(claims.threadId, {
          folderPath: spec.folderPath
        });
        const link = this.space.createLink({
          threadId: claims.threadId,
          title: spec.title || spec.url,
          url: spec.url,
          note: spec.note,
          folderId
        });
        this.saveActionReceipt(actionKey, keyOwner, 'link_save', link.id);
        spaceChanged = true;
      } catch {
        hadUnhandledError = true;
      }
    });

    if (spaceChanged) {
      this.emit({ type: 'thread.space_updated', threadId: claims.threadId });
    }
    return { cleaned: [cleaned,...unsavedDocuments].filter(Boolean).join('\n\n'), hadUnhandledError };
  }

  private applyInlineArtifactAndActionsSync(
    rawText: string,
    claims: ScopedTurnClaims,
    pinnedArtifactId: string | null,
    pinnedArtifactVersion: number | null,
    agentMessageId?: string,
    presetClarificationCard?: ClarificationCardData | null
  ): string {
    const keyOwner = agentMessageId || `attempt:${claims.attemptId}`;
    const artRes = this.processInlineArtifactsWithReceipts(
      rawText,
      claims,
      pinnedArtifactId,
      pinnedArtifactVersion,
      keyOwner
    );
    let cleaned = artRes.cleaned;
    let hadTransientFailure = artRes.hadUnhandledError;

    const clarifyRes = this.extractInlineClarificationSync(cleaned);
    cleaned = clarifyRes.cleaned;
    const activeClarifyCard = presetClarificationCard ?? clarifyRes.card;
    if (activeClarifyCard) {
      // Mutual exclusion: never create/dispatch tasks in the same turn as a pre-dispatch clarification card!
      const strippedTasks = this.extractInlineTasksSync(cleaned);
      cleaned = strippedTasks.cleaned;
      if (agentMessageId) {
        this.db.sqlite
          .prepare(
            `UPDATE v2_thread_messages
             SET clarification_card_json = COALESCE(clarification_card_json, ?), inline_actions_applied = 1
             WHERE id = ?`
          )
          .run(JSON.stringify(activeClarifyCard), agentMessageId);
      }
      return cleaned.trim() || '在正式派发任务前，请先确认以下细节：';
    }

    const extracted = this.extractInlineTasksSync(cleaned);
    cleaned = extracted.cleaned;
    const errors = [...extracted.errors];
    let createdCount = 0;

    if (extracted.items.length > 0 && this.actionHandler) {
      for (let i = 0; i < extracted.items.length; i++) {
        const entry = extracted.items[i];
        const actionKey = `inline_task:${keyOwner}:${i}`;
        const existingTaskId = this.getActionReceipt(actionKey);
        if (existingTaskId) {
          createdCount += 1;
          continue;
        }
        const deterministicTaskId =
          typeof entry.taskId === 'string' && entry.taskId.trim()
            ? entry.taskId.trim()
            : 'task_' + createHash('sha256').update(actionKey).digest('hex').slice(0, 10);

        try {
          if (this.actionHandler.createOrUpdateTaskSync) {
            this.db.inTransaction(() => {
              const created = this.actionHandler!.createOrUpdateTaskSync!(claims, {
                ...entry,
                taskId: deterministicTaskId
              });
              this.saveActionReceipt(actionKey, keyOwner, 'task_create', created.task.id);
            });
            createdCount += 1;
          } else {
            hadTransientFailure = true;
            void this.actionHandler
              .executeTool(claims, 'task_create_or_update', { ...entry, taskId: deterministicTaskId })
              .then((out: any) => {
                this.saveActionReceipt(
                  actionKey,
                  keyOwner,
                  'task_create',
                  String(out?.task?.id || deterministicTaskId)
                );
              })
              .catch(() => {});
          }
        } catch (err) {
          const statusCode = (err as { statusCode?: number })?.statusCode;
          if (statusCode === 400 || statusCode === 403) {
            errors.push((err as Error).message || '任务参数校验失败');
          } else {
            hadTransientFailure = true;
            errors.push((err as Error).message || '创建任务暂时失败');
          }
        }
      }
    }

    if (agentMessageId && !hadTransientFailure) {
      this.db.sqlite
        .prepare(`UPDATE v2_thread_messages SET inline_actions_applied = 1 WHERE id = ?`)
        .run(agentMessageId);
    }

    if (errors.length > 0) {
      cleaned = `${cleaned ? `${cleaned}\n\n` : ''}> ⚠️ 自动创建任务失败：${errors.join('；')}`;
    }
    if (cleaned.trim()) return cleaned.trim();
    if (createdCount > 0) return `已创建 ${createdCount} 项协作任务。`;
    return rawText.trim();
  }

  private async applyInlineArtifactAndActions(
    rawText: string,
    claims: ScopedTurnClaims,
    pinnedArtifactId: string | null,
    pinnedArtifactVersion: number | null,
    agentMessageId?: string,
    presetClarificationCard?: ClarificationCardData | null
  ): Promise<string> {
    const keyOwner = agentMessageId || `attempt:${claims.attemptId}`;
    const artRes = this.processInlineArtifactsWithReceipts(
      rawText,
      claims,
      pinnedArtifactId,
      pinnedArtifactVersion,
      keyOwner
    );
    let cleaned = artRes.cleaned;
    let hadTransientFailure = artRes.hadUnhandledError;

    const clarifyRes = this.extractInlineClarificationSync(cleaned);
    cleaned = clarifyRes.cleaned;
    const activeClarifyCard = presetClarificationCard ?? clarifyRes.card;
    if (activeClarifyCard) {
      // Mutual exclusion: never create/dispatch tasks in the same turn as a pre-dispatch clarification card!
      const strippedTasks = this.extractInlineTasksSync(cleaned);
      cleaned = strippedTasks.cleaned;
      if (agentMessageId) {
        this.db.sqlite
          .prepare(
            `UPDATE v2_thread_messages
             SET clarification_card_json = COALESCE(clarification_card_json, ?), inline_actions_applied = 1
             WHERE id = ?`
          )
          .run(JSON.stringify(activeClarifyCard), agentMessageId);
      }
      return cleaned.trim() || '在正式派发任务前，请先确认以下细节：';
    }

    const extracted = this.extractInlineTasksSync(cleaned);
    cleaned = extracted.cleaned;
    const errors = [...extracted.errors];
    let createdCount = 0;

    if (extracted.items.length > 0 && this.actionHandler) {
      for (let i = 0; i < extracted.items.length; i++) {
        const entry = extracted.items[i];
        const actionKey = `inline_task:${keyOwner}:${i}`;
        const existingTaskId = this.getActionReceipt(actionKey);
        if (existingTaskId) {
          createdCount += 1;
          continue;
        }
        const deterministicTaskId =
          typeof entry.taskId === 'string' && entry.taskId.trim()
            ? entry.taskId.trim()
            : 'task_' + createHash('sha256').update(actionKey).digest('hex').slice(0, 10);

        try {
          if (this.actionHandler.createOrUpdateTaskSync) {
            this.db.inTransaction(() => {
              const created = this.actionHandler!.createOrUpdateTaskSync!(claims, {
                ...entry,
                taskId: deterministicTaskId
              });
              this.saveActionReceipt(actionKey, keyOwner, 'task_create', created.task.id);
            });
          } else {
            const out = (await this.actionHandler.executeTool(claims, 'task_create_or_update', {
              ...entry,
              taskId: deterministicTaskId
            })) as { task?: { id?: string } } | undefined;
            this.saveActionReceipt(
              actionKey,
              keyOwner,
              'task_create',
              String(out?.task?.id || deterministicTaskId)
            );
          }
          createdCount += 1;
        } catch (err) {
          const statusCode = (err as { statusCode?: number })?.statusCode;
          if (statusCode === 400 || statusCode === 403) {
            errors.push((err as Error).message || '任务参数校验失败');
          } else {
            hadTransientFailure = true;
            errors.push((err as Error).message || '创建任务暂时失败');
          }
        }
      }
    }

    if (agentMessageId && !hadTransientFailure) {
      this.db.sqlite
        .prepare(`UPDATE v2_thread_messages SET inline_actions_applied = 1 WHERE id = ?`)
        .run(agentMessageId);
    }

    if (errors.length > 0) {
      cleaned = `${cleaned ? `${cleaned}\n\n` : ''}> ⚠️ 自动创建任务失败：${errors.join('；')}`;
    }

    if (cleaned.trim()) return cleaned.trim();
    if (createdCount > 0) return `已创建 ${createdCount} 项协作任务。`;
    return rawText.trim();
  }

  private extractInlineClarificationSync(text: string): {
    cleaned: string;
    card: ClarificationCardData | null;
  } {
    const { matches, cleaned } = actionBlocks(text, /<duolawork_ask>([\s\S]*?)<\/duolawork_ask>/gi);
    if (matches.length === 0) {
      return { cleaned: text, card: null };
    }
    let card: ClarificationCardData | null = null;
    for (const match of matches) {
      if (card) continue;
      const rawPayload = match[1]
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      try {
        const parsed = JSON.parse(rawPayload) as unknown;
        card = normalizeClarificationCard(parsed);
      } catch {
        // ignore malformed ask block rather than polluting chat with raw JSON
      }
    }
    return { cleaned, card };
  }

  private extractInlineTasksSync(text: string): {
    cleaned: string;
    items: Array<Record<string, unknown>>;
    errors: string[];
  } {
    const { matches, cleaned } = actionBlocks(text, /<duolawork_task>([\s\S]*?)<\/duolawork_task>/gi);
    if (matches.length === 0) {
      return { cleaned: text, items: [], errors: [] };
    }
    const items: Array<Record<string, unknown>> = [];
    const errors: string[] = [];

    for (const match of matches) {
      const rawPayload = match[1]
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      try {
        const parsed = JSON.parse(rawPayload) as unknown;
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of arr) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push('任务指令须为 JSON 对象');
            continue;
          }
          items.push(entry as Record<string, unknown>);
        }
      } catch (err) {
        errors.push(`任务指令 JSON 格式有误 (${(err as Error).message})`);
      }
    }
    return { cleaned, items, errors };
  }

  private async applyInlineTaskBlocks(
    text: string,
    claims: ScopedTurnClaims
  ): Promise<{ cleaned: string; createdCount: number; errors: string[] }> {
    const { matches, cleaned } = actionBlocks(text, /<duolawork_task>([\s\S]*?)<\/duolawork_task>/gi);
    if (matches.length === 0 || !this.actionHandler) {
      return { cleaned: text, createdCount: 0, errors: [] };
    }
    let createdCount = 0;
    const errors: string[] = [];

    for (const match of matches) {
      const rawPayload = match[1]
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      try {
        const parsed = JSON.parse(rawPayload) as unknown;
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of arr) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push('任务指令须为 JSON 对象');
            continue;
          }
          await this.actionHandler.executeTool(
            claims,
            'task_create_or_update',
            entry as Record<string, unknown>
          );
          createdCount += 1;
        }
      } catch (err) {
        errors.push((err as Error).message || 'JSON 解析或校验失败');
      }
    }
    return { cleaned, createdCount, errors };
  }

  private buildThreadOwnerTools(): DynamicToolDefinition[] {
    return [
      {
        name: 'artifact_read',
        description: '读取当前对话关联的右侧文稿内容与最新版本号。',
        inputSchema: {
          type: 'object',
          properties: { artifactId: { type: 'string' } },
          required: ['artifactId'],
          additionalProperties: false
        }
      },
      {
        name: 'artifact_write',
        description: '使用乐观锁更新当前对话关联的右侧文稿。旧版本写入会自动存为冲突分支而不覆盖新稿。',
        inputSchema: {
          type: 'object',
          properties: {
            artifactId: { type: 'string' },
            expectedBaseVersion: { type: 'integer' },
            title: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['artifactId', 'content'],
          additionalProperties: false
        }
      },
      {
        name: 'thread_read_history',
        description: '按序号范围分页补读早期折叠的对话历史原文。',
        inputSchema: {
          type: 'object',
          properties: {
            fromSeq: { type: 'integer' },
            toSeq: { type: 'integer' }
          },
          required: ['fromSeq', 'toSeq'],
          additionalProperties: false
        }
      },
      {
        name: 'task_ask_clarification',
        description:
          '当用户请求安排/分配任务但需求范围、侧重方向、产出形式或频率存在模糊点时，先弹出 1～3 个问题的确认卡片让用户选择确认，切勿在同一回合直接调用 task_create_or_update。若需求已十分明确或用户刚确认完，则无需调用此工具。',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            targetMemberName: { type: 'string' },
            summary: { type: 'string' },
            questions: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: {
                type: 'object',
                properties: {
                  question: { type: 'string' },
                  options: { type: 'array', items: { type: 'string' } },
                  multiSelect: { type: 'boolean' }
                },
                required: ['question', 'options']
              }
            }
          },
          required: ['questions']
        }
      },
      {
        name: 'task_create_or_update',
        description: '在需求已明确或用户确认后，在当前对话立项创建单次任务或定时任务，可指派一个或多个步骤给指定执行成员；省略 steps 时默认由负责人独立执行。',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            kind: { type: 'string', enum: ['once', 'scheduled'] },
            cronExpr: { type: 'string' },
            timezone: { type: 'string' },
            leadMemberId: { type: 'string' },
            goal: { type: 'string' },
            acceptanceCriteria: { type: 'string' },
            startImmediately: { type: 'boolean' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  stepOrder: { type: 'integer' },
                  title: { type: 'string' },
                  assigneeMemberId: { type: 'string' },
                  dependsOnOrders: { type: 'array', items: { type: 'integer' } },
                  brief: { type: 'string' },
                  acceptanceCriteria: { type: 'string' }
                },
                required: ['stepOrder', 'title', 'assigneeMemberId', 'brief', 'acceptanceCriteria']
              }
            }
          },
          required: ['title', 'goal']
        }
      },
      ...SPACE_AND_DUOLABASE_TOOLS,
      {
        name: 'duolabase:memory_recall',
        description: '检索 DuolaBase 团队与项目记忆中的关键经验与约束。',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            project: { type: 'string' }
          },
          required: ['query']
        }
      },
      {
        name: 'duolabase:experience_suggest',
        description: '按关键词召回 DuolaBase 中可复用的历史排错与协作经验卡片。',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            project: { type: 'string' }
          },
          required: ['query']
        }
      }
    ];
  }

  public getMessage(id: string): ThreadMessageRecord | null {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM v2_thread_messages WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapMessageRow(row) : null;
  }

  private nextMessageSeq(threadId: string): number {
    const row = this.db.sqlite
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM v2_thread_messages WHERE thread_id = ?`)
      .get(threadId) as { max_seq: number };
    return Number(row.max_seq) + 1;
  }
}

function actionBlocks(text: string, pattern: RegExp) {
  let fence = '';
  const masked = text.split('\n').map(line => {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence || delimiter) {
      if (!fence) fence = delimiter![1];
      else if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = '';
      return line.replace(/</g, '\x00');
    }
    return line.replace(/(`+)(.+?)\1/g, span => span.replace(/</g, '\x00'));
  }).join('\n');
  const matches = Array.from(masked.matchAll(new RegExp(pattern.source, pattern.flags + 'd')));
  const pieces: string[] = [];
  let offset = 0;
  for (const match of matches) {
    pieces.push(text.slice(offset, match.index));
    offset = match.index + match[0].length;
    match.indices!.forEach((range, i) => { if (range) match[i] = text.slice(...range); });
  }
  pieces.push(text.slice(offset));
  return { matches, cleaned: pieces.join('').trim() };
}

function parseTagAttrs(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(rawAttrs)) !== null) {
    attrs[m[1].toLowerCase()] = (m[2] ?? m[3] ?? '').trim();
  }
  return attrs;
}

function stripInlineArtifactBlock(
  text: string,
  onBlock: (title: string | undefined, content: string, folderPath?: string) => void
): string {
  const regex = /<duolawork_artifact(\s+[^>]*)?>([\s\S]*?)<\/duolawork_artifact>/gi;
  const { matches, cleaned } = actionBlocks(text, regex);
  for (const match of matches) {
    const attrs = parseTagAttrs(match[1] || '');
    onBlock(
      attrs.title || undefined,
      match[2].trim(),
      attrs.folder || attrs.folderpath || attrs.dir || undefined
    );
  }
  return cleaned;
}

function stripInlineFolderBlocks(
  text: string,
  onBlock: (folderPath: string) => void
): string {
  const selfClosing = /<duolawork_folder(\s+[^>]*)\/>/gi;
  const paired = /<duolawork_folder(\s+[^>]*)?>([\s\S]*?)<\/duolawork_folder>/gi;
  const singles = actionBlocks(text, selfClosing);
  for (const match of singles.matches) {
    const attrs = parseTagAttrs(match[1] || '');
    const p = attrs.path || attrs.title || attrs.name || '';
    if (p) onBlock(p);
  }
  const { matches, cleaned } = actionBlocks(singles.cleaned, paired);
  for (const match of matches) {
    const attrs = parseTagAttrs(match[1] || '');
    const p = attrs.path || attrs.title || attrs.name || match[2].trim();
    if (p) onBlock(p);
  }
  return cleaned;
}

function stripInlineFileBlocks(
  text: string,
  onBlock: (spec: {
    name: string;
    body: string;
    folderPath?: string;
    mimeType?: string;
    encoding?: string;
  }) => void
): string {
  const regex = /<duolawork_file(\s+[^>]*)?>([\s\S]*?)<\/duolawork_file>/gi;
  const { matches, cleaned } = actionBlocks(text, regex);
  for (const match of matches) {
    const attrs = parseTagAttrs(match[1] || '');
    const name = attrs.name || attrs.title || attrs.filename || '';
    if (name) {
      onBlock({
        name,
        body: match[2].replace(/^\r?\n/, '').replace(/\r?\n$/, ''),
        folderPath: attrs.folder || attrs.folderpath || attrs.dir || undefined,
        mimeType: attrs.mime || attrs.mimetype || attrs.type || undefined,
        encoding: attrs.encoding || 'utf8'
      });
    }
  }
  return cleaned;
}

function stripInlineLinkBlocks(
  text: string,
  onBlock: (spec: { title?: string; url: string; note: string; folderPath?: string }) => void
): string {
  const regex = /<duolawork_link(\s+[^>]*)?>([\s\S]*?)<\/duolawork_link>/gi;
  const { matches, cleaned } = actionBlocks(text, regex);
  for (const match of matches) {
    const attrs = parseTagAttrs(match[1] || '');
    const url = attrs.url || attrs.href || '';
    if (url) {
      onBlock({
        title: attrs.title || undefined,
        url,
        note: match[2].trim(),
        folderPath: attrs.folder || attrs.folderpath || attrs.dir || undefined
      });
    }
  }
  return cleaned;
}

function mapThreadRow(row: Record<string, unknown>): ThreadRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    workspacePath: row.workspace_path ? String(row.workspace_path) : null,
    workspaceNodeId: row.workspace_node_id ? String(row.workspace_node_id) : null,
    title: String(row.title),
    activeOwnerMemberId: String(row.active_owner_member_id),
    boundArtifactId: row.bound_artifact_id ? String(row.bound_artifact_id) : null,
    status: row.status as ThreadRecord['status'],
    pinnedAt: row.pinned_at ? String(row.pinned_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function normalizeClarificationCard(raw: unknown): ClarificationCardData | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = Array.isArray(raw)
    ? ({ questions: raw } as Record<string, unknown>)
    : (raw as Record<string, unknown>);
  const rawQuestions = Array.isArray(obj.questions) ? obj.questions : [];
  const questions: ClarificationQuestionItem[] = [];

  for (const item of rawQuestions) {
    if (!item || typeof item !== 'object') continue;
    const qObj = item as Record<string, unknown>;
    const question = String(qObj.question || qObj.label || qObj.title || '').trim();
    if (!question) continue;
    const rawOpts = Array.isArray(qObj.options)
      ? qObj.options
      : Array.isArray(qObj.choices)
        ? qObj.choices
        : [];
    const options = rawOpts
      .map((o) => (typeof o === 'string' ? o.trim() : String((o as any)?.label || '').trim()))
      .filter(Boolean)
      .slice(0, 5);
    questions.push({
      id: `q${questions.length + 1}`,
      question,
      options,
      ...(qObj.multiSelect === true || qObj.is_multi_select === true ? { multiSelect: true } : {})
    });
    if (questions.length >= 3) break;
  }

  if (questions.length === 0) return null;

  const title = String(obj.title || '派单前需求确认').trim() || '派单前需求确认';
  const targetMemberName = String(obj.targetMemberName || obj.targetMember || obj.assignee || '').trim();
  const summary = String(obj.summary || '').trim();

  return {
    title,
    ...(targetMemberName ? { targetMemberName } : {}),
    ...(summary ? { summary } : {}),
    questions
  };
}

function mapMessageRow(row: Record<string, unknown>): ThreadMessageRecord {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    seq: Number(row.seq),
    authorKind: row.author_kind as ThreadMessageRecord['authorKind'],
    authorId: String(row.author_id),
    targetMemberId: row.target_member_id ? String(row.target_member_id) : null,
    attemptId: row.attempt_id ? String(row.attempt_id) : null,
    body: String(row.body),
    artifactRefs: JSON.parse(String(row.artifact_refs_json || '[]')) as string[],
    toolTrace: row.tool_trace_json
      ? (JSON.parse(String(row.tool_trace_json)) as ToolTraceItem[])
      : undefined,
    handoffMeta: row.handoff_meta_json
      ? (JSON.parse(String(row.handoff_meta_json)) as HandoffNoticeMeta)
      : null,
    clarificationCard: row.clarification_card_json
      ? (JSON.parse(String(row.clarification_card_json)) as ClarificationCardData)
      : null,
    taskCard: row.task_card_json
      ? (JSON.parse(String(row.task_card_json)) as ThreadMessageRecord['taskCard'])
      : null,
    turnStatus: row.turn_status as ThreadMessageRecord['turnStatus'],
    usage: row.usage_json ? (JSON.parse(String(row.usage_json)) as ThreeTierUsage) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
