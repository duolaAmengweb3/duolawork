import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isExcludedClaudeVps,
  type DispatchAttemptRecord,
  type MemberRecord,
  type ProviderUsageMetrics
} from '../../shared/types.js';
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

export interface HubConfigFile {
  endpoint: string;
  adminKey: string;
}

export function resolveAgentHubBridgeCredentials(
  explicitConfigPath?: string | null
): HubConfigFile | null {
  const tryReadConfigFile = (filePath: string): HubConfigFile | null => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return null;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      const endpoint = String(raw.endpoint || '').trim().replace(/\/+$/, '');
      const adminKey = String(raw.adminKey || '').trim();
      if (!endpoint || !adminKey) return null;
      return { endpoint, adminKey };
    } catch {
      return null;
    }
  };

  if (typeof explicitConfigPath === 'string' && explicitConfigPath.trim()) {
    const fromExplicit = tryReadConfigFile(explicitConfigPath.trim());
    if (fromExplicit) return fromExplicit;
  }

  const envUrl = String(process.env.AGENT_HUB_BRIDGE_URL || '').trim().replace(/\/+$/, '');
  const envKey = String(process.env.AGENT_HUB_BRIDGE_KEY || '').trim();
  if (envUrl && envKey) {
    return { endpoint: envUrl, adminKey: envKey };
  }

  const envCfgPath = String(process.env.DUOLAWORK_AGENT_HUB_CONFIG || '').trim();
  if (envCfgPath) {
    const fromEnvFile = tryReadConfigFile(envCfgPath);
    if (fromEnvFile) return fromEnvFile;
  }

  const homeDefault = path.join(os.homedir(), '.config', 'agent-hub', 'config.json');
  return tryReadConfigFile(homeDefault);
}

export function evaluateHubChannelMemberHealth(
  conn: Record<string, any> | null | undefined,
  remoteMember: Record<string, any> | null | undefined,
  localConn: { status?: string; message?: string; browserPaused?: boolean } | null | undefined,
  fallbackTransport = 'connector'
): { status: MemberRecord['status']; message: string } {
  const transport = String(conn?.transport || remoteMember?.mode || fallbackTransport);

  if (conn?.needsAuthorization === true) {
    return {
      status: 'auth_required',
      message: `需要重新完成平台授权 (${transport})`
    };
  }

  // Cloud-to-cloud push webhooks (grok-webhook):
  // Never keep a persistent SSE subscription (`subscriptionActive` is always false by design)
  // and do not depend on legacy browser-mode `browserPaused` flags once verified on webhook.
  if (transport === 'grok-webhook') {
    if (conn?.status === 'verified') {
      return { status: 'ready', message: `已连接 (${transport})` };
    }
    if (conn?.status === 'configured') {
      return { status: 'auth_required', message: `已配置 (${transport})，待完成首轮连接验证` };
    }
    return { status: 'offline', message: `Webhook 连接暂未就绪 (${transport})` };
  }

  // Cloud-to-cloud event push (dots-events, e.g. Dot):
  // `authSeenAt` only updates when invoked on demand, not via idle heartbeats.
  if (transport === 'dots-events') {
    if (conn?.status === 'verified' && conn?.subscriptionActive !== false) {
      return { status: 'ready', message: `已连接 (${transport})` };
    }
    if (conn?.status === 'configured') {
      return { status: 'auth_required', message: `已配置 (${transport})，待完成首轮连接验证` };
    }
    return { status: 'offline', message: `事件订阅未激活 (${transport})` };
  }

  // Polling / local browser connectors (muse-poll, browser):
  if (
    localConn &&
    (localConn.browserPaused === true || String(localConn.message || '').includes('已关闭'))
  ) {
    return {
      status: 'offline',
      message: `专用浏览器未开启 (${transport})`
    };
  }

  if (conn?.status === 'verified') {
    const seenIso = String(
      conn.authSeenAt || conn.toolSeenAt || remoteMember?.lastSeenAt || ''
    ).trim();
    const seenMs = seenIso ? Date.parse(seenIso) : Number.NaN;
    if (conn.subscriptionActive === true || (Number.isFinite(seenMs) && Date.now() - seenMs <= 24 * 3600_000)) {
      return {
        status: 'ready',
        message: localConn?.status === 'ready' ? `专用浏览器已连接 (${transport})` : `已连接 (${transport})`
      };
    }
    return {
      status: 'offline',
      message: `本机/轮询接收端暂未运行 (${transport})`
    };
  }

  if (conn?.status === 'configured') {
    return { status: 'auth_required', message: `已配置 (${transport})，待完成首轮连接验证` };
  }
  if (remoteMember?.status === 'ready' || localConn?.status === 'ready') {
    return {
      status: 'ready',
      message: localConn?.status === 'ready' ? `专用浏览器已连接 (${transport})` : `已连接 (${transport})`
    };
  }
  return { status: 'offline', message: `远端成员暂未在线 (${transport})` };
}

/**
 * Cross-machine Remote Bridge Driver:
 * - Connects non-destructively to existing remote native runtimes such as `Gemini2VPS`
 *   (`member_ccdf940ba6d3426da01b9f65048909e2`) via its authenticated Hub runtime channel
 *   WITHOUT SSHing into the user's VPS or touching `ClaudeVPS`!
 * - Creates an isolated remote native session (`mode: 'new'`) per DuolaWork 2.0 scope,
 *   persists `{ bridgeChannelId, bridgeMessageId, nativeSessionId }` immediately upon dispatch,
 *   and supports full mid-flight disconnect recovery (`reconcileAttempt`) with ZERO duplicate model calls!
 */
export class RemoteBridgeDriver implements AgentDriver {
  public readonly kind = 'remote-bridge' as const;
  private readonly abortedAttempts = new Set<string>();

  private loadHubCredentials(member: MemberRecord): HubConfigFile {
    const explicitPath =
      typeof member.config.agentHubConfigPath === 'string'
        ? member.config.agentHubConfigPath
        : null;
    const creds = resolveAgentHubBridgeCredentials(explicitPath);
    if (!creds) {
      const shownPath = explicitPath || path.join(os.homedir(), '.config', 'agent-hub', 'config.json');
      throw new Error(`未找到远端桥接配置 (${shownPath} 或环境变量 AGENT_HUB_BRIDGE_URL / AGENT_HUB_BRIDGE_KEY)`);
    }
    return creds;
  }

  private async hubRequest<T = any>(
    creds: HubConfigFile,
    route: string,
    body?: Record<string, unknown>,
    timeoutMs = 15_000
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${creds.endpoint}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${creds.adminKey}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Remote bridge HTTP ${res.status}: ${redactSecrets(errBody)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private readLocalAgentConnection(member: MemberRecord): { status?: string; message?: string } | null {
    try {
      const cfgPath =
        typeof member.config.agentHubConfigPath === 'string'
          ? member.config.agentHubConfigPath
          : path.join(os.homedir(), '.config', 'agent-hub', 'config.json');
      const acPath = path.join(path.dirname(cfgPath), 'agent-connections.json');
      if (!fs.existsSync(acPath)) return null;
      const raw = JSON.parse(fs.readFileSync(acPath, 'utf8')) as {
        accounts?: Record<string, { memberId?: string; status?: string; message?: string; enabled?: boolean }>;
      };
      for (const rec of Object.values(raw.accounts ?? {})) {
        if (rec?.memberId === member.id && rec.enabled !== false) {
          return rec;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  public async checkHealth(member: MemberRecord): Promise<{ status: MemberRecord['status']; message: string }> {
    if (isExcludedClaudeVps(member)) {
      return { status: 'offline', message: '按所有者规则排除 VPS 订阅 Claude 实例' };
    }
    const remoteMode = member.config.remoteMode === 'hub-channel' ? 'hub-channel' : 'native-runtime';
    try {
      const creds = this.loadHubCredentials(member);
      if (remoteMode === 'hub-channel') {
        const ws = await this.hubRequest<any>(creds, '/v2/workspace');
        const remoteMember = Array.isArray(ws?.members)
          ? ws.members.find((m: any) => m.id === member.id)
          : null;
        const conn = Array.isArray(ws?.connections)
          ? ws.connections.find((c: any) => c.id === member.id)
          : null;
        const localConn = this.readLocalAgentConnection(member);
        return evaluateHubChannelMemberHealth(
          conn,
          remoteMember,
          localConn,
          String(member.config.hubTransport || 'connector')
        );
      }

      const data = await this.hubRequest<any>(
        creds,
        `/v2/native-runtime?memberId=${encodeURIComponent(member.id)}`
      );
      const record = data?.record ?? data?.runtime?.record;
      const freshness = data?.catalogFreshness ?? data?.runtime?.catalogFreshness;
      if (!record?.enabled || !record?.sourceReady) {
        return { status: 'offline', message: record?.message || '远端运行端未在线' };
      }
      const status: MemberRecord['status'] =
        record.status === 'working' ? 'busy' : 'ready';
      return {
        status,
        message: `远端运行端在线 (${freshness?.state || 'ok'})`
      };
    } catch (err) {
      return { status: 'offline', message: redactSecrets((err as Error).message) };
    }
  }

  public async ensureSession(input: SessionBindingInput): Promise<EnsuredSession> {
    if (isExcludedClaudeVps(input.member)) {
      throw new Error('禁止连接被排除的 VPS Claude Code 实例');
    }
    const remoteMode = input.member.config.remoteMode === 'hub-channel' ? 'hub-channel' : 'native-runtime';
    const existingChannelId =
      typeof input.existingBridgeMeta?.bridgeChannelId === 'string'
        ? input.existingBridgeMeta.bridgeChannelId
        : null;

    if (remoteMode === 'hub-channel') {
      const creds = this.loadHubCredentials(input.member);
      // Fast liveness guard: fail immediately if the legacy 1.9.6 receiver is explicitly disconnected/inactive
      const ws = await this.hubRequest<any>(creds, '/v2/workspace').catch(() => null);
      if (ws) {
        const remoteMember = Array.isArray(ws?.members)
          ? ws.members.find((m: any) => m.id === input.member.id)
          : null;
        const conn = Array.isArray(ws?.connections)
          ? ws.connections.find((c: any) => c.id === input.member.id)
          : null;
        const localConn = this.readLocalAgentConnection(input.member);
        const liveHealth = evaluateHubChannelMemberHealth(
          conn,
          remoteMember,
          localConn,
          String(input.member.config.hubTransport || 'connector')
        );
        if (liveHealth.status !== 'ready' && liveHealth.status !== 'busy') {
          throw new Error(
            `成员「${input.member.name}」当前不可用（${liveHealth.message}），请改派给在线成员（如 Gemini2VPS、Codex、Gemini 本机）或先启动对应连接器`
          );
        }
      }
      if (existingChannelId) {
        return {
          nativeSessionId: input.existingNativeSessionId || `hub-channel:${existingChannelId}`,
          resumed: true,
          bridgeMeta: { bridgeChannelId: existingChannelId, remoteMode: 'hub-channel' }
        };
      }
      // DeepSeek Harness desktop connector only polls channels explicitly bound to its local sessions
      // (such as the member's existing `direct: true` DM channel), so reuse it when present.
      if (input.member.platformId === 'deepseek-harness') {
        const listed = await this.hubRequest<any>(creds, '/v2/channels').catch(() => null);
        const items: any[] = Array.isArray(listed?.items) ? listed.items : [];
        const boundDirect = items.find(
          (c) =>
            c?.direct === true &&
            Array.isArray(c.memberIds) &&
            c.memberIds.includes(input.member.id) &&
            typeof c.id === 'string'
        );
        if (boundDirect?.id) {
          return {
            nativeSessionId: `hub-channel:${boundDirect.id}`,
            resumed: true,
            bridgeMeta: { bridgeChannelId: String(boundDirect.id), remoteMode: 'hub-channel' }
          };
        }
      }
      const channelRes = await this.hubRequest<any>(creds, '/v2/commands', {
        type: 'channel.create',
        requestId: randomUUID(),
        name: `[v2-isolated] ${input.scopeKey.slice(0, 36)} ${randomUUID().slice(0, 6)}`,
        memberIds: [input.member.id],
        coordinatorId: input.member.id
      });
      const bridgeChannelId = String(channelRes?.result?.id || '');
      if (!bridgeChannelId) {
        throw new Error('远端桥接未能创建隔离通道');
      }
      return {
        nativeSessionId: `hub-channel:${bridgeChannelId}`,
        resumed: false,
        bridgeMeta: { bridgeChannelId, remoteMode: 'hub-channel' }
      };
    }

    if (input.existingNativeSessionId && existingChannelId) {
      return {
        nativeSessionId: input.existingNativeSessionId,
        resumed: true,
        bridgeMeta: {
          bridgeChannelId: existingChannelId,
          nativeSessionId: input.existingNativeSessionId
        }
      };
    }

    const creds = this.loadHubCredentials(input.member);
    // Create an isolated disposable bridge channel dedicated strictly to this v2 scopeKey
    const channelRes = await this.hubRequest<any>(creds, '/v2/commands', {
      type: 'channel.create',
      requestId: randomUUID(),
      name: `[v2-isolated] ${input.scopeKey.slice(0, 36)} ${randomUUID().slice(0, 6)}`,
      memberIds: [input.member.id],
      coordinatorId: input.member.id
    });
    const bridgeChannelId = String(channelRes?.result?.id || '');
    if (!bridgeChannelId) {
      throw new Error('远端桥接未能创建隔离通道');
    }

    // Instruct remote runtime (e.g. Gemini2VPS Antigravity CLI) to allocate a fresh isolated native session
    const cmd = await this.hubRequest<any>(creds, '/v2/native-runtime', {
      memberId: input.member.id,
      mode: 'new',
      channelId: bridgeChannelId,
      requestId: randomUUID()
    });
    const commandId = String(cmd?.id || '');
    if (!commandId) {
      throw new Error('远端运行端未返回会话创建命令 ID');
    }

    const deadline = Date.now() + 90_000;
    let consecutiveErrors = 0;
    while (Date.now() < deadline) {
      try {
        const check = await this.hubRequest<any>(
          creds,
          `/v2/native-runtime?memberId=${encodeURIComponent(input.member.id)}&commandId=${encodeURIComponent(commandId)}`
        );
        consecutiveErrors = 0;
        if (check?.status === 'failed') {
          throw new Error(`远端创建独立会话失败: ${redactSecrets(check.message || 'unknown')}`);
        }
        if (check?.status === 'completed' && check?.binding?.sessionId) {
          const nativeSessionId = String(check.binding.sessionId);
          return {
            nativeSessionId,
            resumed: false,
            bridgeMeta: {
              bridgeChannelId,
              nativeCommandId: commandId,
              nativeSessionId
            }
          };
        }
      } catch (err) {
        if ((err as Error).message.startsWith('远端创建独立会话失败')) {
          throw err;
        }
        consecutiveErrors += 1;
        if (consecutiveErrors > 5) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('等待远端运行端分配独立原生会话超时');
  }

  public async runTurn(
    input: TurnDispatchInput,
    onEvent?: (ev: TurnStreamEvent) => void
  ): Promise<TurnExecutionResult> {
    if (isExcludedClaudeVps(input.member)) {
      throw new Error('禁止连接被排除的 VPS Claude Code 实例');
    }
    const creds = this.loadHubCredentials(input.member);
    const bridgeChannelId = String(input.bridgeMeta?.bridgeChannelId || '');
    if (!bridgeChannelId) {
      throw new Error('缺少远端隔离桥接通道标识 bridgeChannelId');
    }
    const remoteMode = input.member.config.remoteMode === 'hub-channel' ? 'hub-channel' : 'native-runtime';
    const postBody =
      remoteMode === 'hub-channel' && !input.member.capabilities.supportsIsolatedSessions
        ? `[独立任务单元 · 请勿引用此前无关对话 | attempt=${input.attemptId} | scope=${input.scopeKey}]\n${input.prompt}`
        : input.prompt;

    const postRes = await this.hubRequest<any>(creds, '/v2/commands', {
      type: 'channel.post',
      requestId: `dw2-${input.attemptId}`,
      channelId: bridgeChannelId,
      body: postBody,
      mentions: [input.member.id]
    });
    const bridgeMessageId = String(postRes?.result?.id || '');
    if (!bridgeMessageId) {
      throw new Error('远端桥接投递未返回 messageId');
    }

    const updatedBridgeMeta = {
      ...(input.bridgeMeta ?? {}),
      bridgeChannelId,
      bridgeMessageId,
      nativeSessionId: input.nativeSessionId
    };

    // Persist bridgeMessageId BEFORE waiting so mid-flight disconnect/crash can reconcile cleanly!
    onEvent?.({
      kind: 'dispatched_meta',
      bridgeMeta: updatedBridgeMeta
    });
    onEvent?.({ kind: 'started' });

    // Optional fault-injection hook for testing real mid-flight disconnect + reconcile!
    if (input.member.config.simulateDisconnectAfterDispatchOnce === true) {
      input.member.config.simulateDisconnectAfterDispatchOnce = false;
      throw new Error('SIMULATED_NETWORK_DISCONNECT_AFTER_REMOTE_DISPATCH');
    }

    const timeoutMs = input.timeoutMs ?? 900_000;
    const deadline = Date.now() + timeoutMs;
    let consecutivePollErrors = 0;

    while (Date.now() < deadline) {
      if (this.abortedAttempts.has(input.attemptId)) {
        this.abortedAttempts.delete(input.attemptId);
        throw new Error('远端等待已取消');
      }
      let rec: ReconcileResult;
      try {
        rec = await this.pollBridgeReply(creds, input.member.id, bridgeChannelId, bridgeMessageId);
        consecutivePollErrors = 0;
      } catch (err) {
        consecutivePollErrors += 1;
        if (consecutivePollErrors > 8) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (rec.state === 'completed') {
        return {
          text: rec.text || '',
          nativeSessionId: rec.nativeSessionId || input.nativeSessionId,
          nativeTurnId: rec.nativeTurnId || null,
          bridgeMeta: updatedBridgeMeta,
          providerUsage: rec.providerUsage ?? emptyUnobservableUsage()
        };
      }
      if (rec.state === 'failed') {
        throw new Error(rec.errorMessage || '远端执行失败');
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    throw new Error('等待远端运行端回复超时');
  }

  public async reconcileAttempt(
    member: MemberRecord,
    attempt: DispatchAttemptRecord
  ): Promise<ReconcileResult> {
    const bridgeChannelId = String(attempt.bridgeMeta?.bridgeChannelId || '');
    const bridgeMessageId = String(attempt.bridgeMeta?.bridgeMessageId || '');
    if (!bridgeChannelId || !bridgeMessageId) {
      return { state: 'not_found' };
    }
    try {
      const creds = this.loadHubCredentials(member);
      return await this.pollBridgeReply(creds, member.id, bridgeChannelId, bridgeMessageId);
    } catch (err) {
      return {
        state: 'still_running',
        errorMessage: redactSecrets((err as Error).message)
      };
    }
  }

  private async pollBridgeReply(
    creds: HubConfigFile,
    memberId: string,
    bridgeChannelId: string,
    bridgeMessageId: string
  ): Promise<ReconcileResult> {
    const d = await this.hubRequest<any>(
      creds,
      `/v2/channel?id=${encodeURIComponent(bridgeChannelId)}`
    );
    const messages: any[] = Array.isArray(d?.messages) ? d.messages : [];
    const bridgeMsg = messages.find((m) => m.id === bridgeMessageId);
    const activities: any[] = Array.isArray(d?.activity) ? d.activity : [];
    const matchingTurns = activities.filter((t) => t.messageId === bridgeMessageId);
    const doneTurn =
      matchingTurns.find((t) => t.status === 'done' || t.status === 'completed') ?? matchingTurns[0];

    let reply = messages.find(
      (m) => m.authorId === memberId && m.replyTo === bridgeMessageId && String(m.body || '').trim()
    );
    if (!reply && matchingTurns.some((t) => t.status === 'done' || t.status === 'completed')) {
      const candidates = messages.filter(
        (m) =>
          m.authorId === memberId &&
          String(m.body || '').trim().length > 0 &&
          (!bridgeMsg?.createdAt || String(m.createdAt || '') >= String(bridgeMsg.createdAt))
      );
      reply = candidates[candidates.length - 1];
    }

    if (reply) {
      return {
        state: 'completed',
        text: String(reply.body || '').trim(),
        nativeSessionId: doneTurn?.nativeSessionId ? String(doneTurn.nativeSessionId) : null,
        nativeTurnId: doneTurn?.id ? String(doneTurn.id) : String(reply.id),
        providerUsage: parseBridgeTokenUsage(reply.tokenUsage)
      };
    }

    const failedTurn = matchingTurns.find((t) =>
      ['failed', 'error', 'stalled', 'cancelled', 'canceled', 'aborted', 'expired', 'timed_out'].includes(
        String(t.status || '').toLowerCase()
      )
    );
    if (failedTurn) {
      return {
        state: 'failed',
        errorMessage: redactSecrets(
          String(
            failedTurn.error ||
              failedTurn.reason ||
              failedTurn.message ||
              '远端运行端执行中断或未回传结果'
          )
        )
      };
    }

    const issue = Array.isArray(d?.deliveryIssues)
      ? d.deliveryIssues.find(
          (i: any) =>
            i.messageId === bridgeMessageId &&
            (i.status === 'needs_user' ||
              i.status === 'failed' ||
              i.status === 'abandoned' ||
              i.action === 'review_incomplete')
        )
      : null;
    if (issue) {
      return {
        state: 'failed',
        errorMessage: String(issue.summary || issue.impact || '远端投递受阻或未收到结果')
      };
    }

    const stillActive = matchingTurns.some((t) =>
      ['active', 'queued', 'pending', 'running', 'claimed'].includes(String(t.status || '').toLowerCase())
    );
    if (!stillActive && bridgeMsg?.createdAt) {
      const ageMs = Date.now() - Date.parse(String(bridgeMsg.createdAt));
      if (Number.isFinite(ageMs) && ageMs > 20 * 60_000) {
        return {
          state: 'failed',
          errorMessage: '远端长时间未回传结果且已无活跃执行记录，已结束等待'
        };
      }
    }
    return {
      state: 'still_running'
    };
  }

  public async abortTurn(_member: MemberRecord, attempt: DispatchAttemptRecord): Promise<boolean> {
    this.abortedAttempts.add(attempt.id);
    return true;
  }

  public async disposeScope(
    member: MemberRecord,
    bridgeMeta?: Record<string, unknown> | null
  ): Promise<void> {
    const bridgeChannelId = String(bridgeMeta?.bridgeChannelId || '');
    if (!bridgeChannelId) return;
    try {
      const creds = this.loadHubCredentials(member);
      const d = await this.hubRequest<any>(
        creds,
        `/v2/channel?id=${encodeURIComponent(bridgeChannelId)}`
      );
      const busy = Array.isArray(d?.activity) && d.activity.some((t: any) => t.status === 'active');
      if (!busy && d?.channel?.revision !== undefined) {
        await this.hubRequest(creds, '/v2/commands', {
          type: 'channel.delete',
          requestId: randomUUID(),
          channelId: bridgeChannelId,
          expectedVersion: d.channel.revision
        });
      }
    } catch {
      // safe best-effort cleanup of disposable bridge channel
    }
  }
}

function parseBridgeTokenUsage(tu: any): ProviderUsageMetrics {
  if (!tu || typeof tu !== 'object') return emptyUnobservableUsage();
  const input = typeof tu.inputTokens === 'number' ? tu.inputTokens : typeof tu.input === 'number' ? tu.input : null;
  const cached = typeof tu.cachedInputTokens === 'number' ? tu.cachedInputTokens : typeof tu.cached === 'number' ? tu.cached : null;
  const output = typeof tu.outputTokens === 'number' ? tu.outputTokens : typeof tu.output === 'number' ? tu.output : null;
  const total = typeof tu.totalTokens === 'number' ? tu.totalTokens : typeof tu.total === 'number' ? tu.total : null;
  const reqs = typeof tu.modelRequests === 'number' ? tu.modelRequests : typeof tu.requests === 'number' ? tu.requests : null;
  if (input === null && total === null) return emptyUnobservableUsage();
  return {
    observable: true,
    modelRequests: reqs,
    inputTokens: input,
    cachedInputTokens: cached,
    uncachedInputTokens: input !== null && cached !== null ? Math.max(0, input - cached) : input,
    outputTokens: output,
    totalTokens: total ?? (input ?? 0) + (output ?? 0)
  };
}
