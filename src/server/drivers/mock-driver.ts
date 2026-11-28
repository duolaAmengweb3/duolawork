import { randomUUID } from 'node:crypto';
import type { DispatchAttemptRecord, MemberRecord } from '../../shared/types.js';
import {
  emptyUnobservableUsage,
  type AgentDriver,
  type EnsuredSession,
  type ReconcileResult,
  type SessionBindingInput,
  type TurnDispatchInput,
  type TurnExecutionResult,
  type TurnStreamEvent
} from './types.js';

export type MockTurnHandler = (
  input: TurnDispatchInput,
  onEvent?: (ev: TurnStreamEvent) => void
) => Promise<Partial<TurnExecutionResult> & { text: string }>;

/**
 * Deterministic MockDriver STRICTLY for unit & fault-injection tests
 * (never used or claimed as live acceptance).
 */
export class MockDriver implements AgentDriver {
  public readonly kind = 'mock' as const;
  public readonly handlers = new Map<string, MockTurnHandler>();
  public readonly recordedPrompts: Array<{ memberId: string; scopeKey: string; prompt: string; attemptId: string }> = [];
  public readonly reconciledResults = new Map<string, ReconcileResult>();

  public async checkHealth(): Promise<{ status: MemberRecord['status']; message: string }> {
    return { status: 'ready', message: 'Mock test driver ready' };
  }

  public async ensureSession(input: SessionBindingInput): Promise<EnsuredSession> {
    if (input.existingNativeSessionId && input.member.capabilities.supportsSessionResume) {
      return { nativeSessionId: input.existingNativeSessionId, resumed: true };
    }
    return {
      nativeSessionId: input.member.capabilities.supportsIsolatedSessions
        ? `mock_sess_${randomUUID().slice(0, 8)}`
        : `mock_fixed_${input.member.id}`,
      resumed: false
    };
  }

  public async runTurn(
    input: TurnDispatchInput,
    onEvent?: (ev: TurnStreamEvent) => void
  ): Promise<TurnExecutionResult> {
    this.recordedPrompts.push({
      memberId: input.member.id,
      scopeKey: input.scopeKey,
      prompt: input.prompt,
      attemptId: input.attemptId
    });
    onEvent?.({ kind: 'started' });

    const handler = this.handlers.get(input.member.id) ?? this.handlers.get('*');
    if (handler) {
      const out = await handler(input, onEvent);
      return {
        text: out.text,
        nativeSessionId: out.nativeSessionId ?? input.nativeSessionId,
        nativeTurnId: out.nativeTurnId ?? `mock_turn_${randomUUID().slice(0, 8)}`,
        bridgeMeta: out.bridgeMeta ?? input.bridgeMeta ?? null,
        ...(out.sessionReset ? { sessionReset: true } : {}),
        providerUsage: out.providerUsage ?? {
          observable: true,
          modelRequests: 1,
          inputTokens: Math.ceil(input.prompt.length / 4),
          cachedInputTokens: 0,
          uncachedInputTokens: Math.ceil(input.prompt.length / 4),
          outputTokens: Math.ceil(out.text.length / 4),
          totalTokens: Math.ceil((input.prompt.length + out.text.length) / 4)
        }
      };
    }

    return {
      text: `[MockReply:${input.member.name}] 已处理 (${input.scopeKey})`,
      nativeSessionId: input.nativeSessionId,
      nativeTurnId: `mock_turn_${randomUUID().slice(0, 8)}`,
      providerUsage: emptyUnobservableUsage()
    };
  }

  public async reconcileAttempt(
    _member: MemberRecord,
    attempt: DispatchAttemptRecord
  ): Promise<ReconcileResult> {
    return this.reconciledResults.get(attempt.id) ?? { state: 'not_found' };
  }

  public async abortTurn(): Promise<boolean> {
    return true;
  }
}
