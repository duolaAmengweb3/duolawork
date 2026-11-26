import type { ExecutionNodeHub } from '../node-hub.js';
import {
  isExcludedClaudeVps,
  type DispatchAttemptRecord,
  type MemberRecord
} from '../../shared/types.js';
import type {
  AgentDriver,
  EnsuredSession,
  ReconcileResult,
  SessionBindingInput,
  TurnDispatchInput,
  TurnExecutionResult,
  TurnStreamEvent
} from './types.js';

/**
 * Universal Execution Node Driver:
 * Routes turns to ANY paired remote or local Execution Node (Linux VPS, Mac, Windows)
 * over the node's outbound WebSocket connection managed by `ExecutionNodeHub`.
 * Never assumes the Agent lives on the same host as the DuolaWork Cloud Control Plane.
 */
export class RemoteNodeDriver implements AgentDriver {
  public readonly kind = 'remote-node' as const;
  private nodeHub: ExecutionNodeHub | null = null;

  public bindNodeHub(hub: ExecutionNodeHub): void {
    this.nodeHub = hub;
  }

  private resolveNodeId(member: MemberRecord): string {
    const nodeId = member.nodeId || (typeof member.config.nodeId === 'string' ? member.config.nodeId : '');
    if (!nodeId) {
      throw new Error(`NODE_OFFLINE: 成员「${member.name}」尚未绑定在线执行节点`);
    }
    return nodeId;
  }

  public async checkHealth(member: MemberRecord): Promise<{ status: MemberRecord['status']; message: string }> {
    if (isExcludedClaudeVps(member)) {
      return { status: 'offline', message: '按所有者规则排除 VPS 订阅 Claude 实例' };
    }
    if (!this.nodeHub) {
      return { status: 'offline', message: '节点中心尚未初始化' };
    }
    const nodeId = member.nodeId || (typeof member.config.nodeId === 'string' ? member.config.nodeId : '');
    if (!nodeId) {
      return { status: 'offline', message: '尚未绑定执行节点' };
    }
    const node = this.nodeHub.getNode(nodeId);
    if (!node) {
      return { status: 'offline', message: '关联执行节点已不存在' };
    }
    if (!this.nodeHub.isNodeOnline(nodeId)) {
      return { status: 'offline', message: `执行节点「${node.name}」当前离线` };
    }
    return this.nodeHub.checkMemberHealth(nodeId, member);
  }

  public async ensureSession(input: SessionBindingInput): Promise<EnsuredSession> {
    if (isExcludedClaudeVps(input.member)) {
      throw new Error('禁止连接被排除的 VPS Claude Code 实例');
    }
    if (!this.nodeHub) throw new Error('节点中心尚未初始化');
    const nodeId = this.resolveNodeId(input.member);
    return this.nodeHub.ensureSession(nodeId, input);
  }

  public async runTurn(
    input: TurnDispatchInput,
    onEvent?: (ev: TurnStreamEvent) => void
  ): Promise<TurnExecutionResult> {
    if (isExcludedClaudeVps(input.member)) {
      throw new Error('禁止连接被排除的 VPS Claude Code 实例');
    }
    if (!this.nodeHub) throw new Error('节点中心尚未初始化');
    const nodeId = this.resolveNodeId(input.member);
    return this.nodeHub.runTurn(nodeId, input, onEvent);
  }

  public async reconcileAttempt(
    member: MemberRecord,
    attempt: DispatchAttemptRecord
  ): Promise<ReconcileResult> {
    if (!this.nodeHub) return { state: 'still_running' };
    const nodeId = member.nodeId || (typeof member.config.nodeId === 'string' ? member.config.nodeId : '');
    if (!nodeId) return { state: 'not_found', errorMessage: '成员未绑定执行节点' };
    return this.nodeHub.reconcileAttempt(nodeId, attempt.id);
  }

  public async abortTurn(member: MemberRecord, attempt: DispatchAttemptRecord): Promise<boolean> {
    if (!this.nodeHub) return false;
    const nodeId = member.nodeId || (typeof member.config.nodeId === 'string' ? member.config.nodeId : '');
    if (!nodeId) return false;
    return this.nodeHub.abortTurn(nodeId, attempt.id);
  }
}
