import { createHash, randomUUID } from 'node:crypto';
import type { DuolaWorkDatabase } from '../db.js';
import {
  isExcludedClaudeVps,
  type DispatchAttemptRecord,
  type DriverKind,
  type MemberRecord,
  ThreeTierUsage
} from '../../shared/types.js';
import { AcpStdioDriver } from './acp-driver.js';
import { ClaudeCliDriver } from './claude-cli-driver.js';
import { CodexAppServerDriver } from './codex-driver.js';
import { MockDriver } from './mock-driver.js';
import { RemoteBridgeDriver } from './remote-bridge-driver.js';
import { RemoteNodeDriver } from './remote-node-driver.js';
import {
  emptyUnobservableUsage,
  redactSecrets,
  type AgentDriver,
  type DynamicToolDefinition,
  type EnsuredSession,
  type McpHttpServerConfig,
  type TurnExecutionResult,
  type TurnStreamEvent
} from './types.js';
import { WebhookBotDriver } from './webhook-bot-driver.js';

interface SlotWaiter {
  attemptId: string;
  grant: () => void;
  reject: (err: Error) => void;
}

/**
 * Central Driver Registry & Durable Attempt Ledger:
 * - Enforces per-member `maxConcurrentRuns` (including `maxConcurrentRuns = 1` serialization for fixed-window Bots!).
 * - Supports explicit slot release on timeout (`releaseMemberSlot`) so a hung/timed-out Run #1 IMMEDIATELY frees
 *   the member to execute Run #2, while marking any late arrival from Run #1 as `late_ignored`!
 * - Persists every dispatch attempt BEFORE invoking the underlying driver and supports crash/disconnect `reconcileInFlightAttempts`.
 */
export class DriverRegistry {
  private readonly drivers = new Map<DriverKind, AgentDriver>();
  public readonly webhookDriver: WebhookBotDriver;
  public readonly mockDriver: MockDriver;
  public readonly remoteNodeDriver: RemoteNodeDriver;

  private readonly activeSlots = new Map<string, Set<string>>();
  private readonly waitQueues = new Map<string, SlotWaiter[]>();
  private readonly liveDispatches = new Set<string>();
  private readonly activeAttemptCancels = new Map<string, (reason: string) => void>();
  public mcpServersProvider?: (toolPolicy?: string) => McpHttpServerConfig[];

  constructor(private readonly db: DuolaWorkDatabase) {
    this.webhookDriver = new WebhookBotDriver();
    this.mockDriver = new MockDriver();
    this.remoteNodeDriver = new RemoteNodeDriver();
    this.register(new CodexAppServerDriver());
    this.register(new AcpStdioDriver());
    this.register(new ClaudeCliDriver());
    this.register(this.remoteNodeDriver);
    this.register(new RemoteBridgeDriver());
    this.register(this.webhookDriver);
    this.register(this.mockDriver);
  }

  public register(driver: AgentDriver): void {
    this.drivers.set(driver.kind, driver);
  }

  public getDriver(kind: DriverKind): AgentDriver {
    const d = this.drivers.get(kind);
    if (!d) throw new Error(`未注册驱动类型: ${kind}`);
    return d;
  }

  private async acquireSlot(member: MemberRecord, attemptId: string): Promise<void> {
    const maxSlots = Math.max(1, member.capabilities.maxConcurrentRuns || 1);
    let set = this.activeSlots.get(member.id);
    if (!set) {
      set = new Set();
      this.activeSlots.set(member.id, set);
    }
    if (set.size < maxSlots) {
      set.add(attemptId);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const q = this.waitQueues.get(member.id) ?? [];
      q.push({ attemptId, grant: resolve, reject });
      this.waitQueues.set(member.id, q);
    });
  }

  private abortQueuedWaiter(memberId: string, attemptId: string, reason: string): boolean {
    const q = this.waitQueues.get(memberId);
    if (!q || q.length === 0) return false;
    let removed = false;
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].attemptId === attemptId) {
        const [waiter] = q.splice(i, 1);
        removed = true;
        waiter.reject(new Error(reason));
      }
    }
    return removed;
  }

  /**
   * Releases the member's concurrency slot (called on normal completion OR immediately on step timeout/cancel!).
   * Strictly removes queued waiters first and only wakes the next waiter when `attemptId` actually held an active slot
   * and capacity is below `maxConcurrentRuns`.
   */
  public releaseMemberSlot(memberId: string, attemptId: string): void {
    try {
      this.db.sqlite
        .prepare(`UPDATE v2_dispatch_attempts SET slot_held = 0 WHERE id = ?`)
        .run(attemptId);
    } catch {
      // Ignore if DB was already closed during shutdown.
    }

    // If this attempt was still waiting in queue rather than holding an active slot, remove & reject it without touching active slots!
    this.abortQueuedWaiter(memberId, attemptId, 'ATTEMPT_CANCELED');

    const set = this.activeSlots.get(memberId);
    const wasHoldingSlot = Boolean(set && set.delete(attemptId));
    if (!wasHoldingSlot) {
      return;
    }

    const member = this.db.getMember(memberId);
    const maxSlots = Math.max(1, member?.capabilities.maxConcurrentRuns || 1);
    const q = this.waitQueues.get(memberId);
    while (q && q.length > 0 && set!.size < maxSlots) {
      const next = q.shift()!;
      set!.add(next.attemptId);
      next.grant();
    }
  }

  /**
   * Immediately settles an in-flight `dispatchTurn` race when a run/turn is manually canceled or shutting down,
   * so timers and concurrency slots never linger until full stepTimeoutMs.
   */
  public cancelDispatchedAttempt(attemptId: string, reason = 'ATTEMPT_CANCELED'): void {
    const cancel = this.activeAttemptCancels.get(attemptId);
    if (cancel) {
      this.activeAttemptCancels.delete(attemptId);
      cancel(reason);
    }
  }

  public cancelAllActiveAttempts(reason = 'SHUTDOWN'): void {
    const entries = [...this.activeAttemptCancels.entries()];
    this.activeAttemptCancels.clear();
    for (const [, cancel] of entries) {
      cancel(reason);
    }
  }

  public getAttempt(id: string): DispatchAttemptRecord | null {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM v2_dispatch_attempts WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapAttemptRow(row) : null;
  }

  public getAttemptByIdempotencyKey(key: string): DispatchAttemptRecord | null {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM v2_dispatch_attempts WHERE idempotency_key = ?`)
      .get(key) as Record<string, unknown> | undefined;
    return row ? mapAttemptRow(row) : null;
  }

  public listAttempts(filter?: {
    threadId?: string;
    runId?: string;
    stepId?: string;
    memberId?: string;
    targetKind?: DispatchAttemptRecord['targetKind'];
  }): DispatchAttemptRecord[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (filter?.threadId) {
      clauses.push('thread_id = ?');
      args.push(filter.threadId);
    }
    if (filter?.runId) {
      clauses.push('run_id = ?');
      args.push(filter.runId);
    }
    if (filter?.stepId) {
      clauses.push('step_id = ?');
      args.push(filter.stepId);
    }
    if (filter?.memberId) {
      clauses.push('member_id = ?');
      args.push(filter.memberId);
    }
    if (filter?.targetKind) {
      clauses.push('target_kind = ?');
      args.push(filter.targetKind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.sqlite
      .prepare(`SELECT * FROM v2_dispatch_attempts ${where} ORDER BY dispatched_at ASC, rowid ASC`)
      .all(...args) as Record<string, unknown>[];
    return rows.map(mapAttemptRow);
  }

  public getLatestAttemptForStep(
    stepId: string,
    targetKind: 'task_step' | 'lead_review',
    targetId?: string
  ): DispatchAttemptRecord | null {
    const row = targetId
      ? (this.db.sqlite
          .prepare(
            `SELECT * FROM v2_dispatch_attempts
             WHERE step_id = ? AND target_kind = ? AND target_id = ?
             ORDER BY dispatched_at DESC, rowid DESC LIMIT 1`
          )
          .get(stepId, targetKind, targetId) as Record<string, unknown> | undefined)
      : (this.db.sqlite
          .prepare(
            `SELECT * FROM v2_dispatch_attempts
             WHERE step_id = ? AND target_kind = ?
             ORDER BY dispatched_at DESC, rowid DESC LIMIT 1`
          )
          .get(stepId, targetKind) as Record<string, unknown> | undefined);
    return row ? mapAttemptRow(row) : null;
  }

  /**
   * Executes a single push-driven turn with idempotency, concurrency-slot guarding,
   * timeout slot release, and three-tier usage accounting.
   */
  public async dispatchTurn(input: {
    attemptId?: string;
    idempotencyKey: string;
    targetKind: DispatchAttemptRecord['targetKind'];
    targetId: string;
    threadId: string;
    taskId?: string | null;
    runId?: string | null;
    stepId?: string | null;
    member: MemberRecord;
    scopeKey: string;
    cwd: string;
    existingNativeSessionId?: string | null;
    existingBridgeMeta?: Record<string, unknown> | null;
    baseArtifactId?: string | null;
    baseArtifactVersion?: number | null;
    prompt: string;
    handoffBytes?: number;
    resolvePrompt?: (ctx: {
      forceFullContext: boolean;
      sessionWasReset: boolean;
      ensured: EnsuredSession;
    }) => {
      prompt: string;
      fallbackFullPrompt?: string;
      handoffBytes?: number;
      fallbackHandoffBytes?: number;
    };
    timeoutMs?: number;
    toolPolicy?: string;
    dynamicTools?: DynamicToolDefinition[];
    mcpServers?: McpHttpServerConfig[];
    onToolCall?: (toolName: string, args: Record<string, unknown>, attemptId: string) => Promise<unknown>;
    onEvent?: (ev: TurnStreamEvent) => void;
  }): Promise<{ attempt: DispatchAttemptRecord; result: TurnExecutionResult; deduplicated: boolean }> {
    // Hard guard against touching excluded VPS Claude Code
    if (isExcludedClaudeVps(input.member)) {
      throw new Error('按所有者保护约束，禁止唤醒或探测 VPS Claude Code 实例');
    }

    const existing = this.getAttemptByIdempotencyKey(input.idempotencyKey);
    if (existing && existing.status === 'succeeded' && existing.responseText !== null) {
      return {
        attempt: existing,
        result: {
          text: existing.responseText,
          nativeSessionId: existing.nativeSessionId || '',
          nativeTurnId: existing.nativeTurnId,
          bridgeMeta: existing.bridgeMeta,
          providerUsage: existing.usage.providerUsage
        },
        deduplicated: true
      };
    }

    const attemptId = existing?.id ?? input.attemptId ?? 'att_' + randomUUID().slice(0, 12);
    const promptBytes = Buffer.byteLength(input.prompt, 'utf8');
    const promptDigest = createHash('sha256').update(input.prompt).digest('hex');
    const initialUsage: ThreeTierUsage = {
      workbenchDispatches: 1,
      nativeTurns: 0,
      providerUsage: emptyUnobservableUsage()
    };

    if (!existing) {
      this.db.sqlite
        .prepare(
          `INSERT INTO v2_dispatch_attempts (
            id, target_kind, target_id, thread_id, task_id, run_id, step_id,
            member_id, idempotency_key, scope_key, native_session_id, native_turn_id,
            bridge_meta_json, status, slot_held, base_artifact_id, base_artifact_version,
            prompt_digest, prompt_bytes, handoff_bytes, response_text, usage_json,
            error_message, dispatched_at, settled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'prepared', 1, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL)`
        )
        .run(
          attemptId,
          input.targetKind,
          input.targetId,
          input.threadId,
          input.taskId ?? null,
          input.runId ?? null,
          input.stepId ?? null,
          input.member.id,
          input.idempotencyKey,
          input.scopeKey,
          input.existingNativeSessionId ?? null,
          input.existingBridgeMeta ? JSON.stringify(input.existingBridgeMeta) : null,
          input.baseArtifactId ?? null,
          input.baseArtifactVersion ?? null,
          promptDigest,
          promptBytes,
          input.handoffBytes ?? 0,
          JSON.stringify(initialUsage),
          new Date().toISOString()
        );
    }

    const driver = this.getDriver(input.member.driverKind);
    if (this.liveDispatches.has(attemptId)) throw new Error('该次派发仍在执行中');

    let timedOutReleased = false;
    let cancelReason: string | null = null;
    const timeoutMs = input.timeoutMs ?? 900_000;
    let timeoutHandle: NodeJS.Timeout | null = null;

    let rejectCancelRace!: (err: Error) => void;
    const cancelRace = new Promise<never>((_, reject) => {
      rejectCancelRace = reject;
    });
    // Prevent unhandled rejection if canceled before Promise.race is entered
    cancelRace.catch(() => {});

    this.liveDispatches.add(attemptId);
    this.activeAttemptCancels.set(attemptId, (reason) => {
      if (cancelReason) return;
      cancelReason = reason;
      this.abortQueuedWaiter(input.member.id, attemptId, reason);
      rejectCancelRace(new Error(reason));
    });

    try {
      const preCheck = this.getAttempt(attemptId);
      if (!preCheck || preCheck.status === 'failed' || preCheck.status === 'timed_out') {
        throw new Error('ATTEMPT_CANCELED');
      }

      await Promise.race([this.acquireSlot(input.member, attemptId), cancelRace]);
      if (cancelReason) throw new Error(cancelReason);

      const effectiveMcpServers =
        input.mcpServers ??
        (input.toolPolicy === 'none' ? [] : this.mcpServersProvider?.(input.toolPolicy)) ??
        [];
      const ensured = await Promise.race([
        driver.ensureSession({
          member: input.member,
          scopeKey: input.scopeKey,
          cwd: input.cwd,
          existingNativeSessionId: input.existingNativeSessionId,
          existingBridgeMeta: input.existingBridgeMeta,
          dynamicTools: input.dynamicTools,
          ...(effectiveMcpServers.length > 0 ? { mcpServers: effectiveMcpServers } : {})
        }),
        cancelRace
      ]);
      if (cancelReason) throw new Error(cancelReason);

      const sessionWasReset =
        Boolean(input.existingNativeSessionId) &&
        (!ensured.resumed || ensured.nativeSessionId !== input.existingNativeSessionId);
      const forceFullContext = !ensured.resumed || sessionWasReset;
      const resolvedPrompt = input.resolvePrompt?.({
        forceFullContext,
        sessionWasReset,
        ensured
      });
      const activePrompt = resolvedPrompt?.prompt ?? input.prompt;
      const fallbackFullPrompt = resolvedPrompt?.fallbackFullPrompt;
      const activeHandoffBytes = resolvedPrompt?.handoffBytes ?? input.handoffBytes ?? 0;
      const activePromptBytes = Buffer.byteLength(activePrompt, 'utf8');
      const activePromptDigest = createHash('sha256').update(activePrompt).digest('hex');

      let currentBridgeMeta: Record<string, unknown> | null =
        ensured.bridgeMeta ?? input.existingBridgeMeta ?? null;

      const dispatchUpdate = this.db.sqlite
        .prepare(
          `UPDATE v2_dispatch_attempts
           SET status = 'dispatched',
               native_session_id = ?,
               bridge_meta_json = ?,
               prompt_digest = ?,
               prompt_bytes = ?,
               handoff_bytes = ?
           WHERE id = ? AND status = 'prepared'`
        )
        .run(
          ensured.nativeSessionId,
          currentBridgeMeta ? JSON.stringify(currentBridgeMeta) : null,
          activePromptDigest,
          activePromptBytes,
          activeHandoffBytes,
          attemptId
        );
      if (Number(dispatchUpdate.changes) === 0 || cancelReason) {
        throw new Error(cancelReason || 'ATTEMPT_CANCELED');
      }

      const timeoutRace = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOutReleased = true;
          this.db.sqlite
            .prepare(
              `UPDATE v2_dispatch_attempts
               SET status = 'timed_out', slot_held = 0, error_message = ?, settled_at = ?
               WHERE id = ? AND status IN ('prepared', 'dispatched', 'running')`
            )
            .run('执行超时，已释放该成员并发执行名额', new Date().toISOString(), attemptId);
          // Immediately free the slot so the same member can execute the next Run!
          this.releaseMemberSlot(input.member.id, attemptId);
          void driver.abortTurn(input.member, this.getAttempt(attemptId)!).catch(() => {});
          reject(new Error('ATTEMPT_TIMED_OUT'));
        }, timeoutMs);
        timeoutHandle.unref?.();
      });

      const execPromise = driver.runTurn(
        {
          attemptId,
          member: input.member,
          scopeKey: input.scopeKey,
          cwd: input.cwd,
          nativeSessionId: ensured.nativeSessionId,
          bridgeMeta: currentBridgeMeta,
          prompt: activePrompt,
          fallbackFullPrompt,
          timeoutMs: timeoutMs + 5000,
          dynamicTools: input.dynamicTools,
          ...(effectiveMcpServers.length > 0 ? { mcpServers: effectiveMcpServers } : {}),
          onToolCall: input.onToolCall
            ? (name, args) => input.onToolCall!(name, args, attemptId)
            : undefined
        },
        (ev) => {
          if (ev.kind === 'started') {
            this.db.sqlite
              .prepare(`UPDATE v2_dispatch_attempts SET status = 'running' WHERE id = ? AND status = 'dispatched'`)
              .run(attemptId);
          }
          if (ev.kind === 'dispatched_meta') {
            if (ev.bridgeMeta) currentBridgeMeta = ev.bridgeMeta;
            this.db.sqlite
              .prepare(
                `UPDATE v2_dispatch_attempts
                 SET native_turn_id = COALESCE(?, native_turn_id),
                     bridge_meta_json = COALESCE(?, bridge_meta_json)
                 WHERE id = ?`
              )
              .run(
                ev.nativeTurnId ?? null,
                currentBridgeMeta ? JSON.stringify(currentBridgeMeta) : null,
                attemptId
              );
          }
          input.onEvent?.(ev);
        }
      );

      // Prevent unhandled rejection if execPromise finishes/fails after timeoutRace already rejected
      execPromise
        .then((lateRes) => {
          if (!timedOutReleased) return;
          // Late arrival after timeout: archive receipt as `late_ignored` without double delivery!
          const lateUsage: ThreeTierUsage = {
            workbenchDispatches: 1,
            nativeTurns: 1,
            providerUsage: lateRes.providerUsage
          };
          this.db.sqlite
            .prepare(
              `UPDATE v2_dispatch_attempts
               SET status = 'late_ignored',
                   slot_held = 0,
                   response_text = ?,
                   native_turn_id = COALESCE(?, native_turn_id),
                   usage_json = ?,
                   settled_at = ?
               WHERE id = ?`
            )
            .run(
              lateRes.text,
              lateRes.nativeTurnId,
              JSON.stringify(lateUsage),
              new Date().toISOString(),
              attemptId
            );
        })
        .catch(() => {});

      const res = await Promise.race([execPromise, timeoutRace, cancelRace]);
      if (cancelReason) {
        throw new Error(cancelReason);
      }

      const settledPrompt = res.sessionReset && fallbackFullPrompt ? fallbackFullPrompt : activePrompt;
      const settledHandoffBytes =
        res.sessionReset && resolvedPrompt?.fallbackHandoffBytes !== undefined
          ? resolvedPrompt.fallbackHandoffBytes
          : activeHandoffBytes;
      const settledPromptBytes = Buffer.byteLength(settledPrompt, 'utf8');
      const settledPromptDigest = createHash('sha256').update(settledPrompt).digest('hex');

      const finalUsage: ThreeTierUsage = {
        workbenchDispatches: 1,
        nativeTurns: 1,
        providerUsage: res.providerUsage
      };
      const succeedUpdate = this.db.sqlite
        .prepare(
          `UPDATE v2_dispatch_attempts
           SET status = 'succeeded',
               slot_held = 0,
               native_session_id = ?,
               native_turn_id = ?,
               bridge_meta_json = ?,
               prompt_digest = ?,
               prompt_bytes = ?,
               handoff_bytes = ?,
               response_text = ?,
               usage_json = ?,
               settled_at = ?
           WHERE id = ? AND status IN ('prepared', 'dispatched', 'running')`
        )
        .run(
          res.nativeSessionId,
          res.nativeTurnId,
          res.bridgeMeta ? JSON.stringify(res.bridgeMeta) : currentBridgeMeta ? JSON.stringify(currentBridgeMeta) : null,
          settledPromptDigest,
          settledPromptBytes,
          settledHandoffBytes,
          res.text,
          JSON.stringify(finalUsage),
          new Date().toISOString(),
          attemptId
        );
      if (Number(succeedUpdate.changes) === 0) {
        throw new Error(cancelReason || 'ATTEMPT_CANCELED');
      }

      return {
        attempt: this.getAttempt(attemptId)!,
        result: res,
        deduplicated: false
      };
    } catch (err) {
      const msg = redactSecrets((err as Error).message);
      if (!timedOutReleased) {
        const isExplicitCancel = Boolean(cancelReason) || msg === 'ATTEMPT_CANCELED';
        const isDisconnect =
          !isExplicitCancel &&
          (msg.includes('DISCONNECT') ||
            msg.includes('HTTP 5') ||
            msg.includes('fetch failed') ||
            (msg === 'SHUTDOWN' &&
              (input.member.driverKind === 'remote-bridge' || input.member.driverKind === 'remote-node')));
        try {
          this.db.sqlite
            .prepare(
              `UPDATE v2_dispatch_attempts
               SET status = ?, slot_held = 0, error_message = COALESCE(error_message, ?), settled_at = COALESCE(settled_at, ?)
               WHERE id = ? AND status IN ('prepared', 'dispatched', 'running')`
            )
            .run(
              isDisconnect ? 'reconciling' : 'failed',
              isDisconnect ? null : msg,
              isDisconnect ? null : new Date().toISOString(),
              attemptId
            );
        } catch {
          // Ignore if DB was already closed during shutdown.
        }
      }
      throw err;
    } finally {
      this.liveDispatches.delete(attemptId);
      this.activeAttemptCancels.delete(attemptId);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (!timedOutReleased) {
        this.releaseMemberSlot(input.member.id, attemptId);
      }
    }
  }

  public hasPendingReconcileAttempts(): boolean {
    const rows = this.db.sqlite
      .prepare(
        `SELECT id FROM v2_dispatch_attempts
         WHERE status IN ('prepared', 'dispatched', 'running', 'reconciling')`
      )
      .all() as Array<{ id: string }>;
    return rows.some((r) => !this.liveDispatches.has(String(r.id)));
  }

  /**
   * Reconciles any `prepared | dispatched | running | reconciling` attempts after network drop or server restart
   * BEFORE deciding whether anything needs manual attention — ZERO duplicate model re-sends!
   */
  public async reconcileInFlightAttempts(options?: {
    waitTimeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<Array<{ attempt: DispatchAttemptRecord; outcome: string }>> {
    const rows = this.db.sqlite
      .prepare(
        `SELECT * FROM v2_dispatch_attempts
         WHERE status IN ('prepared', 'dispatched', 'running', 'reconciling')
         ORDER BY dispatched_at ASC`
      )
      .all() as Record<string, unknown>[];

    const results: Array<{ attempt: DispatchAttemptRecord; outcome: string }> = [];
    const waitTimeoutMs = options?.waitTimeoutMs ?? 0;
    const pollIntervalMs = options?.pollIntervalMs ?? 2500;

    for (const row of rows) {
      const att = mapAttemptRow(row);
      if (this.liveDispatches.has(att.id)) {
        continue;
      }
      if (att.status === 'prepared') {
        this.db.sqlite
          .prepare(
            `UPDATE v2_dispatch_attempts
             SET status = 'failed', slot_held = 0, error_message = ?, settled_at = ?
             WHERE id = ? AND status = 'prepared'`
          )
          .run('服务重启导致派发准备中断，未实际执行', new Date().toISOString(), att.id);
        results.push({ attempt: this.getAttempt(att.id)!, outcome: 'reconciled_prepared_aborted' });
        continue;
      }
      const member = this.db.getMember(att.memberId);
      if (!member) {
        this.db.sqlite
          .prepare(
            `UPDATE v2_dispatch_attempts
             SET status = 'failed', slot_held = 0, error_message = ?, settled_at = ?
             WHERE id = ?`
          )
          .run('关联成员不存在，已结束本轮等待', new Date().toISOString(), att.id);
        continue;
      }
      const driver = this.getDriver(member.driverKind);

      const deadline = Date.now() + waitTimeoutMs;
      let rec = await driver.reconcileAttempt(member, att);
      while (rec.state === 'still_running' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        rec = await driver.reconcileAttempt(member, att);
      }

      if (rec.state === 'completed' && rec.text !== undefined) {
        const usage: ThreeTierUsage = {
          workbenchDispatches: att.usage.workbenchDispatches || 1,
          nativeTurns: 1,
          providerUsage: rec.providerUsage ?? att.usage.providerUsage
        };
        this.db.sqlite
          .prepare(
            `UPDATE v2_dispatch_attempts
             SET status = 'succeeded',
                 slot_held = 0,
                 native_session_id = COALESCE(?, native_session_id),
                 native_turn_id = COALESCE(?, native_turn_id),
                 response_text = ?,
                 usage_json = ?,
                 error_message = NULL,
                 settled_at = ?
             WHERE id = ?`
          )
          .run(
            rec.nativeSessionId ?? null,
            rec.nativeTurnId ?? null,
            rec.text,
            JSON.stringify(usage),
            new Date().toISOString(),
            att.id
          );
        results.push({ attempt: this.getAttempt(att.id)!, outcome: 'recovered_completed' });
      } else if (rec.state === 'failed' || rec.state === 'not_found') {
        const errMsg =
          rec.errorMessage ||
          (rec.state === 'not_found'
            ? '应用重启或连接中断，未能找回该轮执行结果，请重试'
            : '对账确认失败');
        this.db.sqlite
          .prepare(
            `UPDATE v2_dispatch_attempts
             SET status = 'failed', slot_held = 0, error_message = ?, settled_at = ?
             WHERE id = ?`
          )
          .run(errMsg, new Date().toISOString(), att.id);
        results.push({
          attempt: this.getAttempt(att.id)!,
          outcome: rec.state === 'not_found' ? 'reconciled_not_found' : 'reconciled_failed'
        });
      } else {
        const ageMs = Date.now() - Date.parse(att.dispatchedAt);
        if (Number.isFinite(ageMs) && ageMs > 30 * 60_000) {
          this.db.sqlite
            .prepare(
              `UPDATE v2_dispatch_attempts
               SET status = 'timed_out', slot_held = 0, error_message = ?, settled_at = ?
               WHERE id = ?`
            )
            .run('远端超过 30 分钟未返回结果，已自动结束等待', new Date().toISOString(), att.id);
          results.push({ attempt: this.getAttempt(att.id)!, outcome: 'reconciled_timed_out' });
        } else {
          this.db.sqlite
            .prepare(`UPDATE v2_dispatch_attempts SET status = 'reconciling', slot_held = 0 WHERE id = ?`)
            .run(att.id);
          results.push({ attempt: this.getAttempt(att.id)!, outcome: rec.waitingForReceipt ? 'waiting_for_receipt' : rec.state });
        }
      }
    }
    return results;
  }
}

function mapAttemptRow(row: Record<string, unknown>): DispatchAttemptRecord {
  return {
    id: String(row.id),
    targetKind: row.target_kind as DispatchAttemptRecord['targetKind'],
    targetId: String(row.target_id),
    threadId: String(row.thread_id),
    taskId: row.task_id ? String(row.task_id) : null,
    runId: row.run_id ? String(row.run_id) : null,
    stepId: row.step_id ? String(row.step_id) : null,
    memberId: String(row.member_id),
    idempotencyKey: String(row.idempotency_key),
    scopeKey: String(row.scope_key),
    nativeSessionId: row.native_session_id ? String(row.native_session_id) : null,
    nativeTurnId: row.native_turn_id ? String(row.native_turn_id) : null,
    bridgeMeta: row.bridge_meta_json ? (JSON.parse(String(row.bridge_meta_json)) as Record<string, unknown>) : null,
    status: row.status as DispatchAttemptRecord['status'],
    slotHeld: Number(row.slot_held) !== 0,
    baseArtifactId: row.base_artifact_id ? String(row.base_artifact_id) : null,
    baseArtifactVersion: row.base_artifact_version !== null && row.base_artifact_version !== undefined ? Number(row.base_artifact_version) : null,
    promptDigest: String(row.prompt_digest),
    promptBytes: Number(row.prompt_bytes),
    handoffBytes: Number(row.handoff_bytes),
    responseText: row.response_text !== null && row.response_text !== undefined ? String(row.response_text) : null,
    usage: JSON.parse(String(row.usage_json)) as ThreeTierUsage,
    errorMessage: row.error_message ? String(row.error_message) : null,
    dispatchedAt: String(row.dispatched_at),
    settledAt: row.settled_at ? String(row.settled_at) : null
  };
}
