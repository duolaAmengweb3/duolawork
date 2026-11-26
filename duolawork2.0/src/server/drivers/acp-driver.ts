import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DispatchAttemptRecord, MemberRecord, ProviderUsageMetrics } from '../../shared/types.js';
import { JsonRpcStdioClient } from './jsonrpc-stdio.js';
import { resolveLocalProxyEnv } from './codex-driver.js';
import {
  emptyUnobservableUsage,
  redactSecrets,
  sanitizeToolSummary,
  type AgentDriver,
  type EnsuredSession,
  type McpHttpServerConfig,
  type ReconcileResult,
  type SessionBindingInput,
  type TurnDispatchInput,
  type TurnExecutionResult,
  type TurnStreamEvent
} from './types.js';

function buildAcpMcpServers(list?: McpHttpServerConfig[]) {
  if (!list || list.length === 0) return [];
  return list.map((s) => ({
    type: 'http',
    name: s.name,
    url: s.url,
    headers: Object.entries(s.headers ?? {}).map(([name, value]) => ({ name, value }))
  }));
}

async function callSessionWithMcpFallback(
  rpc: JsonRpcStdioClient,
  method: 'session/resume' | 'session/new',
  params: { sessionId?: string; cwd: string },
  mcpServers: ReturnType<typeof buildAcpMcpServers>,
  timeoutMs = 30_000
): Promise<any> {
  try {
    return await rpc.call(method, { ...params, mcpServers }, timeoutMs);
  } catch (err) {
    if (mcpServers.length === 0) throw err;
    return await rpc.call(method, { ...params, mcpServers: [] }, timeoutMs);
  }
}

export class AcpStdioDriver implements AgentDriver {
  public readonly kind = 'acp-stdio' as const;
  private readonly activeClients = new Map<string, { rpc: JsonRpcStdioClient; sessionId: string }>();

  private resolveBinary(member: MemberRecord): string {
    const configured = typeof member.config.command === 'string' ? member.config.command : '';
    if (configured && fs.existsSync(configured)) return configured;
    return path.join(os.homedir(), '.local', 'bin', 'agy');
  }

  private async openInitializedAcp(
    member: MemberRecord,
    cwd: string
  ): Promise<{ rpc: JsonRpcStdioClient; capabilities: Record<string, any> }> {
    const bin = this.resolveBinary(member);
    if (!fs.existsSync(bin)) {
      throw new Error(`未找到本机 ACP 运行端可执行文件: ${bin}`);
    }
    const effectiveCwd =
      typeof member.config.defaultCwd === 'string' && member.config.defaultCwd.trim()
        ? member.config.defaultCwd.trim()
        : cwd;
    const args =
      Array.isArray(member.config.args) && member.config.args.length > 0
        ? member.config.args.map(String)
        : ['acp', '--dangerously-skip-permissions'];
    fs.mkdirSync(effectiveCwd, { recursive: true });
    const rpc = new JsonRpcStdioClient({
      command: bin,
      args,
      cwd: effectiveCwd,
      env: resolveLocalProxyEnv()
    });
    try {
      const capabilities = await rpc.call(
        'initialize',
        {
          protocolVersion: 1,
          clientInfo: { name: 'duolawork-v2', version: '2.0.0' },
          clientCapabilities: {}
        },
        20_000
      );
      return { rpc, capabilities: capabilities ?? {} };
    } catch (err) {
      await rpc.stop();
      throw err;
    }
  }

  public async checkHealth(member: MemberRecord): Promise<{ status: MemberRecord['status']; message: string }> {
    const bin = this.resolveBinary(member);
    if (!fs.existsSync(bin)) {
      return { status: 'offline', message: '未找到本机 agy 可执行文件' };
    }
    let rpc: JsonRpcStdioClient | null = null;
    try {
      const opened = await this.openInitializedAcp(member, os.tmpdir());
      rpc = opened.rpc;
      const agentName = String(opened.capabilities?.agentInfo?.name || 'ACP');
      const supportsResume = Boolean(
        opened.capabilities?.agentCapabilities?.loadSession ?? true
      );
      return {
        status: 'ready',
        message: `${agentName} ACP 已就绪 (会话恢复=${supportsResume ? '支持' : '快照回退'})`
      };
    } catch (err) {
      return { status: 'offline', message: redactSecrets((err as Error).message) };
    } finally {
      await rpc?.stop();
    }
  }

  public async ensureSession(input: SessionBindingInput): Promise<EnsuredSession> {
    const { rpc, capabilities } = await this.openInitializedAcp(input.member, input.cwd);
    const mcpServers = buildAcpMcpServers(input.mcpServers);
    try {
      const canResume = capabilities?.agentCapabilities?.loadSession !== false;
      if (input.existingNativeSessionId && canResume) {
        try {
          const data = await callSessionWithMcpFallback(
            rpc,
            'session/resume',
            { sessionId: input.existingNativeSessionId, cwd: input.cwd },
            mcpServers
          );
          const id = String(data?.sessionId || input.existingNativeSessionId);
          return { nativeSessionId: id, resumed: true };
        } catch {
          // Fall back to new session if old session id cannot resume
        }
      }
      const created = await callSessionWithMcpFallback(
        rpc,
        'session/new',
        { cwd: input.cwd },
        mcpServers
      );
      const id = String(created?.sessionId || '');
      if (!id) throw new Error('ACP session/new 未返回 sessionId');
      return { nativeSessionId: id, resumed: false };
    } finally {
      await rpc.stop();
    }
  }

  public async runTurn(
    input: TurnDispatchInput,
    onEvent?: (ev: TurnStreamEvent) => void
  ): Promise<TurnExecutionResult> {
    const { rpc } = await this.openInitializedAcp(input.member, input.cwd);
    const mcpServers = buildAcpMcpServers(input.mcpServers);
    const timeoutMs = input.timeoutMs ?? 10 * 60_000;
    let sessionId = input.nativeSessionId;
    let sessionReset = false;
    let text = '';

    rpc.onRequest = async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } });

    try {
      try {
        await callSessionWithMcpFallback(rpc, 'session/resume', { sessionId, cwd: input.cwd }, mcpServers);
      } catch {
        const fresh = await callSessionWithMcpFallback(rpc, 'session/new', { cwd: input.cwd }, mcpServers);
        sessionId = String(fresh?.sessionId || sessionId);
        sessionReset = true;
      }

      this.activeClients.set(input.attemptId, { rpc, sessionId });

      const onNotif = (method: string, params: Record<string, any>) => {
        if (method !== 'session/update' || params.sessionId !== sessionId) return;
        const upd = params.update;
        if (upd?.sessionUpdate === 'agent_message_chunk' && upd.content?.type === 'text') {
          const chunk = String(upd.content.text || '');
          text += chunk;
          onEvent?.({ kind: 'delta', text: chunk });
        } else if (upd?.sessionUpdate === 'tool_call' || upd?.sessionUpdate === 'tool_call_update') {
          const toolStatus: 'running' | 'done' | 'error' =
            upd.status === 'failed' ? 'error' : upd.status === 'completed' ? 'done' : 'running';
          const summary =
            upd.rawInput?.command !== undefined
              ? sanitizeToolSummary('command', upd.rawInput.command)
              : upd.rawInput?.file_path !== undefined || upd.rawInput?.path !== undefined
                ? sanitizeToolSummary('file', upd.rawInput.file_path ?? upd.rawInput.path)
                : sanitizeToolSummary('search', upd.rawInput?.query);
          onEvent?.({
            kind: 'tool',
            toolId: upd.toolCallId ? String(upd.toolCallId) : undefined,
            toolName: String(upd.title || upd.kind || 'tool'),
            toolSummary: summary,
            toolStatus
          });
        }
      };
      rpc.on('notification', onNotif);

      onEvent?.({ kind: 'started' });
      const effectivePrompt =
        sessionReset && input.fallbackFullPrompt ? input.fallbackFullPrompt : input.prompt;
      const res = await rpc.call(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text: effectivePrompt }]
        },
        timeoutMs
      );
      rpc.off('notification', onNotif);

      if (res?.stopReason === 'cancelled') {
        throw new Error('ACP 会话请求已取消');
      }

      const usage = parseAcpUsage(res?.usage);
      return {
        text: text.trim(),
        nativeSessionId: sessionId,
        nativeTurnId: res?.turnId ? String(res.turnId) : null,
        ...(sessionReset ? { sessionReset: true } : {}),
        providerUsage: usage
      };
    } finally {
      this.activeClients.delete(input.attemptId);
      await rpc.stop();
    }
  }

  public async reconcileAttempt(): Promise<ReconcileResult> {
    return { state: 'not_found' };
  }

  public async abortTurn(_member: MemberRecord, attempt: DispatchAttemptRecord): Promise<boolean> {
    const active = this.activeClients.get(attempt.id);
    if (!active) return false;
    try {
      active.rpc.sendRaw({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: active.sessionId }
      });
      await active.rpc.stop();
      return true;
    } catch {
      return false;
    }
  }
}

function parseAcpUsage(raw: any): ProviderUsageMetrics {
  if (!raw || typeof raw !== 'object') return emptyUnobservableUsage();
  const input = typeof raw.inputTokens === 'number' ? raw.inputTokens : null;
  const output = typeof raw.outputTokens === 'number' ? raw.outputTokens : null;
  const cached = typeof raw.cachedInputTokens === 'number' ? raw.cachedInputTokens : null;
  if (input === null && output === null) return emptyUnobservableUsage();
  return {
    observable: true,
    modelRequests: typeof raw.modelRequests === 'number' ? raw.modelRequests : null,
    inputTokens: input,
    cachedInputTokens: cached,
    uncachedInputTokens: input !== null && cached !== null ? Math.max(0, input - cached) : input,
    outputTokens: output,
    totalTokens: typeof raw.totalTokens === 'number' ? raw.totalTokens : (input ?? 0) + (output ?? 0)
  };
}
