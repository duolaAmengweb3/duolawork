import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DispatchAttemptRecord, MemberRecord } from '../../shared/types.js';
import {
  emptyUnobservableUsage,
  redactSecrets,
  type AgentDriver,
  type EnsuredSession,
  type ReconcileResult,
  type SessionBindingInput,
  type TurnDispatchInput,
  type TurnExecutionResult,
  type TurnStreamEvent
} from './types.js';

interface PendingWebhookAttempt {
  attemptId: string;
  memberId: string;
  callbackTokenHash: string;
  settled: boolean;
  responseText?: string;
  errorMessage?: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

/**
 * WebhookBotDriver for fixed-window bots (e.g. Grok Routine / Webhook Bots):
 * - Explicitly models `supportsIsolatedSessions = false, maxConcurrentRuns = 1` (enforced by DriverRegistry queue).
 * - Wraps every prompt with an explicit stateless boundary header `[独立任务单元 attempt=<id>]` so fixed-window bots
 *   do not confuse adjacent tasks.
 * - Issues a single-use cryptographic `callbackToken` per attempt; duplicate callbacks are idempotent (200 no-op),
 *   forged tokens are rejected with 403!
 */
export class WebhookBotDriver implements AgentDriver {
  public readonly kind = 'webhook-bot' as const;
  private readonly pending = new Map<string, PendingWebhookAttempt>();
  private readonly completedCache = new Map<string, { text: string; at: string }>();
  private readonly hmacKey = randomBytes(32);

  private hashToken(token: string): string {
    return createHmac('sha256', this.hmacKey).update(token).digest('hex');
  }

  public async checkHealth(member: MemberRecord): Promise<{ status: MemberRecord['status']; message: string }> {
    const webhookUrl = typeof member.config.webhookUrl === 'string' ? member.config.webhookUrl : null;
    return {
      status: 'ready',
      message: webhookUrl
        ? 'Webhook Bot 已配置（固定窗口串行保护已开启）'
        : '固定窗口 Bot 待回调模式就绪（并发上限=1）'
    };
  }

  public async ensureSession(input: SessionBindingInput): Promise<EnsuredSession> {
    // Fixed-window bots do not fabricate fake isolated session IDs!
    return {
      nativeSessionId: `fixed-bot:${input.member.id}`,
      resumed: Boolean(input.existingNativeSessionId)
    };
  }

  public async runTurn(
    input: TurnDispatchInput,
    onEvent?: (ev: TurnStreamEvent) => void
  ): Promise<TurnExecutionResult> {
    const rawToken = 'dw2_cb_' + randomBytes(20).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const timeoutMs = input.timeoutMs ?? 120_000;

    const isolatedPrompt =
      `[独立任务单元 · 请勿引用此前无关对话 | attempt=${input.attemptId} | scope=${input.scopeKey}]\n` +
      input.prompt;

    let resolveFn!: (text: string) => void;
    let rejectFn!: (err: Error) => void;
    const waitPromise = new Promise<string>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });

    this.pending.set(input.attemptId, {
      attemptId: input.attemptId,
      memberId: input.member.id,
      callbackTokenHash: tokenHash,
      settled: false,
      resolve: resolveFn,
      reject: rejectFn
    });

    onEvent?.({
      kind: 'dispatched_meta',
      bridgeMeta: { callbackAttemptId: input.attemptId, statelessWrapped: true }
    });
    onEvent?.({ kind: 'started' });

    const timer = setTimeout(() => {
      const entry = this.pending.get(input.attemptId);
      if (entry && !entry.settled) {
        entry.settled = true;
        this.pending.delete(input.attemptId);
        rejectFn(new Error('Webhook Bot 等待回调超时'));
      }
    }, timeoutMs);

    try {
      const webhookUrl = typeof input.member.config.webhookUrl === 'string' ? input.member.config.webhookUrl : null;
      if (webhookUrl) {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            attemptId: input.attemptId,
            memberId: input.member.id,
            callbackToken: rawToken,
            prompt: isolatedPrompt
          })
        });
        if (!res.ok) {
          throw new Error(`Webhook POST failed (${res.status})`);
        }
      } else if (typeof input.member.config.localSimulator === 'function') {
        // Deterministic test hook for webhook callback verification
        const sim = input.member.config.localSimulator as (payload: {
          attemptId: string;
          callbackToken: string;
          prompt: string;
        }) => void | Promise<void>;
        void Promise.resolve(
          sim({ attemptId: input.attemptId, callbackToken: rawToken, prompt: isolatedPrompt })
        ).catch((err) => rejectFn(err as Error));
      }

      const text = await waitPromise;
      return {
        text,
        nativeSessionId: input.nativeSessionId,
        nativeTurnId: input.attemptId,
        providerUsage: emptyUnobservableUsage()
      };
    } catch (err) {
      throw new Error(redactSecrets((err as Error).message));
    } finally {
      clearTimeout(timer);
      this.pending.delete(input.attemptId);
    }
  }

  /**
   * Handles incoming POST `/api/v2/webhooks/callback`
   */
  public receiveCallback(input: {
    attemptId: string;
    callbackToken: string;
    text?: string;
    error?: string;
  }): { status: 'accepted' | 'duplicate_noop'; httpStatus: 200 } {
    if (this.completedCache.has(input.attemptId)) {
      return { status: 'duplicate_noop', httpStatus: 200 };
    }
    const entry = this.pending.get(input.attemptId);
    if (!entry) {
      const err = new Error('未知或已过期的回调 attemptId') as Error & { statusCode?: number };
      err.statusCode = 403;
      throw err;
    }

    const candidateHash = this.hashToken(input.callbackToken || '');
    const a = Buffer.from(candidateHash, 'utf8');
    const b = Buffer.from(entry.callbackTokenHash, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      const err = new Error('Webhook callbackToken 签名校验失败') as Error & { statusCode?: number };
      err.statusCode = 403;
      throw err;
    }

    entry.settled = true;
    this.pending.delete(input.attemptId);
    if (input.error) {
      entry.reject(new Error(input.error));
    } else {
      const cleanText = String(input.text ?? '').trim();
      this.completedCache.set(input.attemptId, { text: cleanText, at: new Date().toISOString() });
      entry.resolve(cleanText);
    }
    return { status: 'accepted', httpStatus: 200 };
  }

  public async reconcileAttempt(
    _member: MemberRecord,
    attempt: DispatchAttemptRecord
  ): Promise<ReconcileResult> {
    const cached = this.completedCache.get(attempt.id);
    if (cached) {
      return {
        state: 'completed',
        text: cached.text,
        nativeSessionId: attempt.nativeSessionId,
        nativeTurnId: attempt.id,
        providerUsage: emptyUnobservableUsage()
      };
    }
    if (this.pending.has(attempt.id)) {
      return { state: 'still_running' };
    }
    return { state: 'not_found' };
  }

  public async abortTurn(_member: MemberRecord, attempt: DispatchAttemptRecord): Promise<boolean> {
    const entry = this.pending.get(attempt.id);
    if (!entry) return false;
    entry.settled = true;
    this.pending.delete(attempt.id);
    entry.reject(new Error('Webhook 任务已取消'));
    return true;
  }
}
